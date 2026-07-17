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
  poll();
}

function sendExpoPush(pushTokens, title, body, data) {
  const tokens = pushTokens.all();
  if (tokens.length === 0) {
    return;
  }
  const payload = JSON.stringify(
    tokens.map((to) => ({ to, title, body, data, sound: "default" })),
  );
  const transport = EXPO_PUSH_URL.protocol === "https:" ? httpsRequest : httpRequest;
  const request = transport(
    {
      host: EXPO_PUSH_URL.hostname,
      port: EXPO_PUSH_URL.port || undefined,
      path: EXPO_PUSH_URL.pathname,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    },
    (response) => {
      if (response.statusCode !== 200) {
        console.error(`outridr: expo push returned ${response.statusCode}`);
        response.resume();
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let tickets;
        try {
          tickets = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.data;
        } catch {
          return;
        }
        if (!Array.isArray(tickets)) {
          return;
        }
        // Expo returns tickets in the same order as the request messages, so
        // index into `tokens` to map a ticket back to the token it concerns.
        tickets.forEach((ticket, index) => {
          if (ticket?.status !== "error") {
            return;
          }
          console.error(`outridr: expo push error: ${ticket.details?.error ?? ticket.message}`);
          if (ticket.details?.error === "DeviceNotRegistered") {
            const token = tokens[index];
            const device = pushTokens.tokens.get(token)?.device || "unknown device";
            pushTokens.remove(token);
            console.error(`outridr: pruned dead push token for "${device}"`);
          }
        });
      });
    },
  );
  request.on("error", (error) => console.error(`outridr: expo push failed: ${error.message}`));
  request.end(payload);
}
