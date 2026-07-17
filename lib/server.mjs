/**
 * outridr server — exposes a herdr machine to the tailnet for the outridr app.
 *
 * Core endpoints (always on):
 *   GET  /health          → {ok, herdr} liveness probe
 *   GET  /session/<id>    → tail a Claude Code session transcript (JSONL)
 *   POST /push/register   → register an Expo push token {token, device?}
 *   WS   /herdr           → NDJSON session to herdr's socket API
 *
 * Opt-in endpoints (config-driven, workflow-specific):
 *   POST /exec            → run the configured task CLI: {args: [...]}
 *   GET  /repos           → run the configured repo-listing command
 *
 * Background: when push tokens are registered, a watcher polls herdr's
 * agent.list and sends Expo pushes when an agent transitions into a
 * notify-worthy status (blocked/done by default).
 *
 * Zero dependencies. The WebSocket server is a minimal RFC6455 implementation
 * (text frames, ping/pong, close). herdr's API socket is one-request-per-
 * connection, so the WS is the long-lived session and every request line gets
 * its own unix connection; the app correlates responses by request id.
 *
 * Security model: bind to the Tailscale interface and let tailnet ACLs guard
 * access; optionally set a shared token (bearer header or ?token=).
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { join } from "node:path";

import { STATE_DIR } from "./config.mjs";

const SESSION_TAIL_BYTES = 256 * 1024;
const SESSION_CHUNK_BYTES = 512 * 1024;
const EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_ARGS = 10;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const EXPO_PUSH_HOST = "exp.host";
const EXPO_PUSH_PATH = "/--/api/v2/push/send";

export function startServer(config) {
  const pushTokens = new PushTokenStore();
  const server = createServer((req, res) => handleHttp(config, pushTokens, req, res));
  server.on("upgrade", (req, socket) => handleUpgrade(config, req, socket));

  if (config.push.enabled) {
    startPushWatcher(config, pushTokens);
  }

  const host = resolveHost(config.host);
  server.listen(config.port, host, () => {
    console.log(`outridr listening on ${host}:${config.port} → ${config.herdrSocket}`);
    console.log(
      `  exec: ${config.exec ? config.exec.command : "disabled"} | repos: ${
        config.repos ? "enabled" : "disabled"
      } | push: ${config.push.enabled ? `${pushTokens.count()} token(s)` : "disabled"}`,
    );
  });
  return server;
}

function resolveHost(configured) {
  if (configured !== "tailscale") {
    return configured;
  }
  try {
    return execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8" }).trim().split("\n")[0];
  } catch {
    console.error("outridr: `tailscale ip -4` failed; falling back to 127.0.0.1");
    return "127.0.0.1";
  }
}

function authorized(config, req, url) {
  if (!config.token) {
    return true;
  }
  if (req.headers.authorization === `Bearer ${config.token}`) {
    return true;
  }
  return url.searchParams.get("token") === config.token;
}

// ── HTTP routing ────────────────────────────────────────────────────────────

function handleHttp(config, pushTokens, req, res) {
  const url = new URL(req.url ?? "/", "http://outridr");
  if (!authorized(config, req, url)) {
    res.writeHead(401).end("unauthorized");
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    probeHerdr(config, (herdr) => {
      sendJson(res, 200, { ok: true, herdr, pushTokens: pushTokens.count() });
    });
    return;
  }

  const sessionMatch =
    req.method === "GET" ? url.pathname.match(/^\/session\/([0-9a-f-]{36})$/) : null;
  if (sessionMatch) {
    serveSessionWindow(config, sessionMatch[1], url, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/push/register") {
    readBody(req, (body) => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end("invalid json");
        return;
      }
      const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
      if (!/^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(token)) {
        res.writeHead(400).end("token must be an Expo push token");
        return;
      }
      pushTokens.add(token, typeof parsed.device === "string" ? parsed.device : "");
      sendJson(res, 200, { ok: true, registered: pushTokens.count() });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/repos" && config.repos) {
    const [command, ...args] = config.repos.command;
    execFile(command, args, { timeout: 15_000 }, (error, stdout) => {
      let repos = [];
      if (!error) {
        try {
          repos = JSON.parse(stdout).repos ?? [];
        } catch {
          /* malformed output → empty list */
        }
      }
      sendJson(res, 200, { repos });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/exec" && config.exec) {
    readBody(req, (body) => {
      let args;
      try {
        args = JSON.parse(body).args;
      } catch {
        res.writeHead(400).end("invalid json");
        return;
      }
      if (
        !Array.isArray(args) ||
        args.length === 0 ||
        args.length > MAX_EXEC_ARGS ||
        !args.every((arg) => typeof arg === "string" && arg.length < 200)
      ) {
        res.writeHead(400).end("args must be a short array of strings");
        return;
      }
      // Allowlist: this endpoint runs exactly one configured binary.
      execFile(
        config.exec.command,
        args,
        { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          sendJson(res, 200, { code, stdout, stderr });
        },
      );
    });
    return;
  }

  res.writeHead(404).end("not found");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readBody(req, callback) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 64 * 1024) {
      req.destroy();
    }
  });
  req.on("end", () => callback(body));
}

// ── herdr socket helpers ────────────────────────────────────────────────────

/** One request over a fresh unix connection (herdr closes after answering). */
function herdrRequest(config, method, params, callback, timeoutMs = 5000) {
  const socket = connect(config.herdrSocket);
  let buffer = "";
  let settled = false;
  const settle = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    callback(result);
  };
  const timer = setTimeout(() => settle(null), timeoutMs);
  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ id: "outridr", method, params })}\n`);
  });
  socket.on("data", (data) => {
    if (settled) {
      return;
    }
    buffer += data.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline !== -1) {
      try {
        settle(JSON.parse(buffer.slice(0, newline)).result ?? null);
      } catch {
        settle(null);
      }
    }
  });
  socket.on("error", () => settle(null));
}

function probeHerdr(config, callback) {
  herdrRequest(config, "ping", {}, callback, 2000);
}

// ── Claude session transcripts ──────────────────────────────────────────────

const sessionPathCache = new Map();

function findSessionFile(config, sessionId) {
  const cached = sessionPathCache.get(sessionId);
  if (cached && existsSync(cached)) {
    return cached;
  }
  let projectDirs = [];
  try {
    projectDirs = readdirSync(config.claudeProjectsDir);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = join(config.claudeProjectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      sessionPathCache.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
}

/**
 * Byte-offset windows over the session JSONL, newline-aligned.
 *   (no params) → tail of SESSION_TAIL_BYTES; offset=N → forward from N
 *   end=N → the window ENDING at N (history pagination)
 * Responses carry both `start` and `offset`; torn trailing lines stay
 * unconsumed until their newline lands.
 */
function serveSessionWindow(config, sessionId, url, res) {
  const filePath = findSessionFile(config, sessionId);
  if (!filePath) {
    sendJson(res, 404, { error: "session transcript not found" });
    return;
  }
  const size = statSync(filePath).size;
  const requested = Number.parseInt(url.searchParams.get("offset") ?? "-1", 10);
  const requestedEnd = Number.parseInt(url.searchParams.get("end") ?? "-1", 10);
  let windowEnd = size;
  let start = Number.isFinite(requested) && requested >= 0 ? Math.min(requested, size) : -1;
  let skipFirstPartialLine = false;
  if (Number.isFinite(requestedEnd) && requestedEnd >= 0) {
    windowEnd = Math.min(requestedEnd, size);
    start = Math.max(0, windowEnd - SESSION_TAIL_BYTES);
    skipFirstPartialLine = start > 0;
  } else if (start < 0) {
    start = Math.max(0, size - SESSION_TAIL_BYTES);
    skipFirstPartialLine = start > 0;
  }

  const readLength = Math.min(windowEnd - start, SESSION_CHUNK_BYTES);
  const buffer = Buffer.alloc(Math.max(readLength, 0));
  if (readLength > 0) {
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buffer, 0, readLength, start);
    } finally {
      closeSync(fd);
    }
  }

  let text = buffer.toString("utf8");
  let consumed = start;
  let alignedStart = start;
  if (skipFirstPartialLine) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline === -1) {
      text = "";
      consumed = windowEnd;
      alignedStart = windowEnd;
    } else {
      const skipped = Buffer.byteLength(text.slice(0, firstNewline + 1), "utf8");
      consumed += skipped;
      alignedStart += skipped;
      text = text.slice(firstNewline + 1);
    }
  }

  const entries = [];
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);

  // Oversized-line guard: a single JSON line larger than the read window would
  // leave `consumed` stuck forever (the stream freezes at that point). If we
  // filled the chunk with no newline and there's more file beyond, skip past
  // the oversized line so the stream keeps flowing. That entry — almost always
  // a huge tool result we'd truncate anyway — is dropped.
  if (
    complete === "" &&
    !skipFirstPartialLine &&
    readLength === SESSION_CHUNK_BYTES &&
    start + readLength < windowEnd
  ) {
    consumed = nextNewlineOffset(filePath, start + readLength, windowEnd);
    alignedStart = consumed;
  } else {
    consumed += Buffer.byteLength(complete, "utf8");
    for (const line of complete.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* torn or corrupt line — skip */
      }
    }
  }

  sendJson(res, 200, {
    start: alignedStart,
    offset: consumed,
    size,
    entries,
    more: windowEnd - consumed > SESSION_CHUNK_BYTES / 2,
  });
}

/** First offset strictly after `from` that follows a newline; `limit` if none. */
function nextNewlineOffset(filePath, from, limit) {
  const fd = openSync(filePath, "r");
  const step = 64 * 1024;
  const buf = Buffer.alloc(step);
  try {
    let pos = from;
    while (pos < limit) {
      const n = readSync(fd, buf, 0, Math.min(step, limit - pos), pos);
      if (n <= 0) {
        break;
      }
      const idx = buf.subarray(0, n).indexOf(0x0a);
      if (idx !== -1) {
        return pos + idx + 1;
      }
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
  return limit;
}

// ── Push notifications ──────────────────────────────────────────────────────

class PushTokenStore {
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
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(this.path, JSON.stringify([...this.tokens.values()], null, 2));
    } catch (error) {
      console.error(`outridr: failed to persist push tokens: ${error.message}`);
    }
  }

  count() {
    return this.tokens.size;
  }

  all() {
    return [...this.tokens.keys()];
  }
}

/**
 * Polls agent.list and pushes when an agent transitions INTO a notify-worthy
 * status. The first successful poll only records a baseline so restarting the
 * server never replays notifications.
 */
function startPushWatcher(config, pushTokens) {
  const lastStatus = new Map();
  let baselined = false;

  const poll = () => {
    if (pushTokens.count() === 0) {
      baselined = false;
      lastStatus.clear();
      setTimeout(poll, config.push.pollMs * 4);
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
            sendExpoPush(pushTokens.all(), title, body, {
              terminalId: agent.terminal_id,
              paneId: agent.pane_id,
              status: agent.agent_status,
            });
          }
        }
        baselined = true;
      }
      setTimeout(poll, config.push.pollMs);
    });
  };
  poll();
}

function sendExpoPush(tokens, title, body, data) {
  if (tokens.length === 0) {
    return;
  }
  const payload = JSON.stringify(
    tokens.map((to) => ({ to, title, body, data, sound: "default" })),
  );
  const request = httpsRequest(
    {
      host: EXPO_PUSH_HOST,
      path: EXPO_PUSH_PATH,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    },
    (response) => {
      if (response.statusCode !== 200) {
        console.error(`outridr: expo push returned ${response.statusCode}`);
      }
      response.resume();
    },
  );
  request.on("error", (error) => console.error(`outridr: expo push failed: ${error.message}`));
  request.end(payload);
}

// ── WebSocket: minimal RFC6455 server, one unix conn per request line ───────

function handleUpgrade(config, req, socket) {
  const url = new URL(req.url ?? "/", "http://outridr");
  if (url.pathname !== "/herdr" || !authorized(config, req, url)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  bridgeWebSocket(config, socket);
}

function bridgeWebSocket(config, ws) {
  let wsBuffer = Buffer.alloc(0);
  let fragments = [];
  let wsOpen = true;
  const liveUnixSockets = new Set();

  const closeAll = () => {
    if (!wsOpen) {
      return;
    }
    wsOpen = false;
    try {
      ws.write(encodeFrame(0x8, Buffer.alloc(0)));
    } catch {
      /* already gone */
    }
    ws.destroy();
    for (const unix of liveUnixSockets) {
      unix.destroy();
    }
    liveUnixSockets.clear();
  };

  const sendLineToWs = (line) => {
    if (wsOpen) {
      ws.write(encodeFrame(0x1, Buffer.from(line, "utf8")));
    }
  };

  const dispatchRequestLine = (line) => {
    const unix = connect(config.herdrSocket);
    liveUnixSockets.add(unix);
    let unixBuffer = "";
    unix.on("connect", () => {
      unix.write(line.endsWith("\n") ? line : `${line}\n`);
    });
    unix.on("data", (data) => {
      unixBuffer += data.toString("utf8");
      let newline = unixBuffer.indexOf("\n");
      while (newline !== -1) {
        sendLineToWs(unixBuffer.slice(0, newline + 1));
        unixBuffer = unixBuffer.slice(newline + 1);
        newline = unixBuffer.indexOf("\n");
      }
    });
    unix.on("close", () => liveUnixSockets.delete(unix));
    unix.on("error", () => {
      liveUnixSockets.delete(unix);
      let id = "";
      try {
        id = JSON.parse(line).id ?? "";
      } catch {
        /* unparseable request line */
      }
      sendLineToWs(
        `${JSON.stringify({ id, error: { code: "outridr_error", message: "herdr socket unavailable" } })}\n`,
      );
    });
  };

  ws.on("data", (data) => {
    wsBuffer = Buffer.concat([wsBuffer, data]);
    let frame = decodeFrame(wsBuffer);
    while (frame) {
      wsBuffer = wsBuffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        closeAll();
        return;
      } else if (frame.opcode === 0x9) {
        ws.write(encodeFrame(0xa, frame.payload));
      } else if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
        fragments.push(frame.payload);
        if (frame.fin) {
          const message = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          for (const line of message.split("\n")) {
            if (line.trim().length > 0) {
              dispatchRequestLine(line);
            }
          }
        }
      }
      frame = decodeFrame(wsBuffer);
    }
  });
  ws.on("close", closeAll);
  ws.on("error", closeAll);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) {
    return null;
  }
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }
  return { fin, opcode, payload, consumed: offset + length };
}

function encodeFrame(opcode, payload) {
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
