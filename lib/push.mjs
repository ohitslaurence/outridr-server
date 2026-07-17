/**
 * Push notifications — persisted Expo push token store, the agent-status
 * poll watcher, and the Expo push send.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

import { STATE_DIR } from "./config.mjs";
import { herdrRequest } from "./herdr.mjs";

const EXPO_PUSH_URL = new URL(process.env.OUTRIDR_EXPO_PUSH_URL ?? "https://exp.host/--/api/v2/push/send");

/** Expo caps one send request at 100 messages. */
export const EXPO_BATCH_LIMIT = 100;

// How often to poll Expo's receipts endpoint for delivery-layer failures
// (default 15 min — Expo docs say receipts typically become available after
// that). Read at module load so tests can override via env before import.
const RECEIPT_CHECK_MS = Number(process.env.OUTRIDR_RECEIPT_CHECK_MS) || 15 * 60 * 1000;

// Stop polling for a ticket's receipt after this long — Expo only retains
// receipts for a limited window, and an id that's aged out this long without
// ever appearing is not worth continuing to ask about.
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Derives the receipts endpoint from the push-send endpoint: same origin,
 * `/send` swapped for `/getReceipts` (or `/getReceipts` appended if the path
 * doesn't end in `/send`, e.g. a test fixture pointed at a bare origin).
 */
export function receiptsUrl(pushUrl) {
  const url = new URL(pushUrl.toString());
  const path = url.pathname;
  if (path.endsWith("/send")) {
    url.pathname = `${path.slice(0, -"/send".length)}/getReceipts`;
  } else if (path.endsWith("/")) {
    url.pathname = `${path}getReceipts`;
  } else {
    url.pathname = `${path}/getReceipts`;
  }
  return url;
}

const EXPO_RECEIPTS_URL = receiptsUrl(EXPO_PUSH_URL);

export function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Tickets awaiting a receipt: { ticketId, token, sentAt }. In-memory only —
// a restart drops whatever was pending, so a delivery-layer failure that
// occurs between the restart and the next successful send simply isn't
// pruned until the next send/receipt cycle. Acceptable: it's the same
// worst case as not polling receipts at all.
let pendingReceipts = [];

export class PushTokenStore {
  constructor() {
    this.path = join(STATE_DIR, "push-tokens.json");
    this.tokens = new Map();
    try {
      for (const entry of JSON.parse(readFileSync(this.path, "utf8"))) {
        this.tokens.set(entry.token, entry);
      }
    } catch {
      /* first run */
    }
  }

  add(token, device) {
    this.tokens.set(token, { token, device, registeredAt: new Date().toISOString() });
    this.#persist();
  }

  remove(token) {
    this.tokens.delete(token);
    this.#persist();
  }

  count() {
    return this.tokens.size;
  }

  all() {
    return [...this.tokens.keys()];
  }

  #persist() {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(this.path, JSON.stringify([...this.tokens.values()], null, 2));
    } catch (error) {
      console.error(`outridr: failed to persist push tokens: ${error.message}`);
    }
  }
}

/**
 * Polls agent.list and pushes when an agent transitions INTO a notify-worthy
 * status. The first successful poll only records a baseline so restarting the
 * server never replays notifications.
 */
export function startPushWatcher(config, pushTokens) {
  const lastStatus = new Map();
  let baselined = false;

  const poll = () => {
    if (pushTokens.count() === 0) {
      baselined = false;
      lastStatus.clear();
      setTimeout(poll, config.push.pollMs * 4).unref();
      return;
    }
    herdrRequest(config, "agent.list", {}, (result) => {
      const agents = result?.agents ?? [];
      if (result) {
        for (const agent of agents) {
          const previous = lastStatus.get(agent.terminal_id);
          lastStatus.set(agent.terminal_id, agent.agent_status);
          if (!baselined || previous === agent.agent_status) {
            continue;
          }
          if (config.push.notifyOn.includes(agent.agent_status)) {
            const title =
              agent.agent_status === "blocked" ? "Agent needs you" : "Agent finished";
            const body = `${agent.terminal_title_stripped || agent.name || agent.terminal_id} — ${agent.agent_status}`;
            sendExpoPush(pushTokens, title, body, {
              terminalId: agent.terminal_id,
              paneId: agent.pane_id,
              status: agent.agent_status,
            });
          }
        }
        const liveIds = new Set(agents.map((agent) => agent.terminal_id));
        for (const id of lastStatus.keys()) {
          if (!liveIds.has(id)) {
            lastStatus.delete(id);
          }
        }
        baselined = true;
      }
      setTimeout(poll, config.push.pollMs).unref();
    });
  };

  const scheduleReceiptCheck = () => {
    checkReceipts(pushTokens);
    setTimeout(scheduleReceiptCheck, RECEIPT_CHECK_MS).unref();
  };

  poll();
  scheduleReceiptCheck();
}

/**
 * POSTs `payload` to `url` and hands the parsed `data` field of Expo's JSON
 * envelope to `onData`. Shape of `data` (tickets array vs. receipts map) is
 * the caller's concern — this just handles the transport.
 */
function postToExpo(url, payload, onData) {
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const request = transport(
    {
      host: url.hostname,
      port: url.port || undefined,
      path: url.pathname,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    },
    (response) => {
      if (response.statusCode !== 200) {
        console.error(`outridr: expo request to ${url.pathname} returned ${response.statusCode}`);
        response.resume();
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.data;
        } catch {
          return;
        }
        onData(data);
      });
    },
  );
  request.on("error", (error) => console.error(`outridr: expo request to ${url.pathname} failed: ${error.message}`));
  request.end(payload);
}

function sendExpoPush(pushTokens, title, body, data) {
  const tokens = pushTokens.all();
  if (tokens.length === 0) {
    return;
  }
  for (const batch of chunkArray(tokens, EXPO_BATCH_LIMIT)) {
    const payload = JSON.stringify(batch.map((to) => ({ to, title, body, data, sound: "default" })));
    postToExpo(EXPO_PUSH_URL, payload, (tickets) => {
      if (!Array.isArray(tickets)) {
        return;
      }
      // Expo returns tickets in the same order as this request's messages —
      // index into `batch` (this chunk's tokens), never the full token list,
      // so a ticket maps back to the right token regardless of which batch
      // it came from.
      tickets.forEach((ticket, index) => {
        const token = batch[index];
        if (ticket?.status === "ok") {
          if (ticket.id) {
            pendingReceipts.push({ ticketId: ticket.id, token, sentAt: Date.now() });
          }
          return;
        }
        if (ticket?.status !== "error") {
          return;
        }
        console.error(`outridr: expo push error: ${ticket.details?.error ?? ticket.message}`);
        if (ticket.details?.error === "DeviceNotRegistered") {
          const device = pushTokens.tokens.get(token)?.device || "unknown device";
          pushTokens.remove(token);
          console.error(`outridr: pruned dead push token for "${device}"`);
        }
      });
    });
  }
}

/**
 * Polls Expo's receipts endpoint for tickets we're still waiting to hear
 * back on. A receipt only becomes available some time after the ticket was
 * issued, so ids with no entry in the response yet are simply re-checked
 * next cycle; any returned receipt (ok or error) stops tracking that id.
 */
function checkReceipts(pushTokens) {
  const cutoff = Date.now() - RECEIPT_MAX_AGE_MS;
  pendingReceipts = pendingReceipts.filter((entry) => entry.sentAt >= cutoff);
  if (pendingReceipts.length === 0) {
    return;
  }
  const payload = JSON.stringify({ ids: pendingReceipts.map((entry) => entry.ticketId) });
  postToExpo(EXPO_RECEIPTS_URL, payload, (receipts) => {
    if (!receipts || typeof receipts !== "object") {
      return;
    }
    pendingReceipts = pendingReceipts.filter((entry) => {
      const receipt = receipts[entry.ticketId];
      if (!receipt) {
        return true; // not ready yet — keep tracking
      }
      if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
        // Guard against acting on a token this particular store doesn't
        // hold — e.g. it was already unregistered, or (in a process running
        // more than one watcher) this isn't the owning store. Leave the id
        // tracked so whichever store does hold it can act on a later cycle.
        if (!pushTokens.tokens.has(entry.token)) {
          return true;
        }
        const device = pushTokens.tokens.get(entry.token)?.device || "unknown device";
        pushTokens.remove(entry.token);
        console.error(`outridr: pruned dead push token for "${device}" (receipt)`);
      }
      return false; // receipt arrived (ok or a different error) — stop tracking
    });
  });
}
