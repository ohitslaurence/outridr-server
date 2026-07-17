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
import { createServer } from "node:http";
import { connect } from "node:net";

import { herdrRequest, probeHerdr } from "./herdr.mjs";
import { authorized, readBody, sendJson } from "./http-util.mjs";
import { PushTokenStore, startPushWatcher } from "./push.mjs";
import { serveSessionWindow } from "./session.mjs";

const EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_ARGS = 10;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024; // per frame, declared
const WS_MAX_MESSAGE_BYTES = 4 * 1024 * 1024; // accumulated fragments + buffer
const HOST_RESOLVE_ATTEMPTS =
  Number.parseInt(process.env.OUTRIDR_HOST_RESOLVE_ATTEMPTS ?? "", 10) || 5;
const HOST_RESOLVE_DELAY_MS =
  Number.parseInt(process.env.OUTRIDR_HOST_RESOLVE_DELAY_MS ?? "", 10) || 2000;

export function startServer(config) {
  const pushTokens = new PushTokenStore();
  const server = createServer((req, res) => handleHttp(config, pushTokens, req, res));
  server.on("upgrade", (req, socket, head) => handleUpgrade(config, req, socket, head));

  if (config.push.enabled) {
    startPushWatcher(config, pushTokens);
  }

  server.on("error", (error) => {
    console.error(`outridr: server error: ${error.message}`);
    process.exit(1);
  });
  resolveHost(config.host).then((host) => {
    server.listen(config.port, host, () => {
      console.log(`outridr listening on ${host}:${config.port} → ${config.herdrSocket}`);
      console.log(
        `  exec: ${config.exec ? config.exec.command : "disabled"} | repos: ${
          config.repos ? "enabled" : "disabled"
        } | push: ${config.push.enabled ? `${pushTokens.count()} token(s)` : "disabled"}`,
      );
    });
  });
  return server;
}

async function resolveHost(configured) {
  if (configured !== "tailscale") {
    return configured;
  }
  for (let attempt = 1; attempt <= HOST_RESOLVE_ATTEMPTS; attempt++) {
    try {
      const line = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8" })
        .split("\n")
        .map((candidate) => candidate.trim())
        .find((candidate) => /^\d+\.\d+\.\d+\.\d+$/.test(candidate));
      if (line) {
        return line;
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        console.error('outridr: tailscale binary not found; set "host" in the config to a literal address');
        process.exit(1);
      }
    }
    if (attempt < HOST_RESOLVE_ATTEMPTS) {
      console.error(`outridr: waiting for a Tailscale IPv4 (attempt ${attempt}/${HOST_RESOLVE_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, HOST_RESOLVE_DELAY_MS));
    }
  }
  console.error("outridr: no Tailscale IPv4; is tailscale up? Exiting so the service supervisor retries.");
  process.exit(1);
}

// ── HTTP routing ────────────────────────────────────────────────────────────

function handleHttp(config, pushTokens, req, res) {
  try {
    handleHttpUnsafe(config, pushTokens, req, res);
  } catch (error) {
    console.error(`outridr: request failed: ${error.message}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal error" });
    } else {
      res.destroy();
    }
  }
}

function handleHttpUnsafe(config, pushTokens, req, res) {
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

  if (req.method === "POST" && url.pathname === "/push/unregister") {
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
      pushTokens.remove(token);
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

// ── WebSocket: minimal RFC6455 server, one unix conn per request line ───────

function handleUpgrade(config, req, socket, head) {
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
  bridgeWebSocket(config, socket, head);
}

function bridgeWebSocket(config, ws, head) {
  let wsBuffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentBytes = 0;
  let wsOpen = true;
  const liveUnixSockets = new Set();

  const closeAll = (code) => {
    if (!wsOpen) {
      return;
    }
    wsOpen = false;
    try {
      ws.write(encodeFrame(0x8, typeof code === "number" ? closePayload(code) : Buffer.alloc(0)));
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

  const onData = (data) => {
    wsBuffer = Buffer.concat([wsBuffer, data]);
    if (wsBuffer.length > WS_MAX_MESSAGE_BYTES) {
      closeAll(1009);
      return;
    }
    let frame = decodeFrame(wsBuffer);
    while (frame) {
      if (frame.error === "too_large") {
        closeAll(1009);
        return;
      }
      if (frame.error === "unmasked") {
        closeAll(1002);
        return;
      }
      wsBuffer = wsBuffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        closeAll();
        return;
      } else if (frame.opcode === 0x9) {
        ws.write(encodeFrame(0xa, frame.payload));
      } else if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
        fragments.push(frame.payload);
        fragmentBytes += frame.payload.length;
        if (fragmentBytes > WS_MAX_MESSAGE_BYTES) {
          closeAll(1009);
          return;
        }
        if (frame.fin) {
          const message = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          fragmentBytes = 0;
          for (const line of message.split("\n")) {
            if (line.trim().length > 0) {
              dispatchRequestLine(line);
            }
          }
        }
      }
      frame = decodeFrame(wsBuffer);
    }
  };

  ws.on("data", onData);
  ws.on("close", closeAll);
  ws.on("error", closeAll);

  // Node delivers any bytes the client pipelined with the handshake as `head`;
  // without draining it here, a client's first frame is silently lost.
  if (head && head.length > 0) {
    onData(head);
  }
}

/** 2-byte big-endian RFC6455 close-frame status code payload. */
function closePayload(code) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return payload;
}

function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  // RFC 6455 §5.1: the server MUST fail the connection if a client frame —
  // data, continuation, or control — arrives unmasked.
  if (!masked) {
    return { error: "unmasked" };
  }
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
    // Compare as BigInt before narrowing — Number() on a huge declared length
    // loses precision, and we must reject before ever waiting on the payload.
    const length64 = buffer.readBigUInt64BE(offset);
    if (length64 > BigInt(WS_MAX_PAYLOAD_BYTES)) {
      return { error: "too_large" };
    }
    length = Number(length64);
    offset += 8;
  }
  if (length > WS_MAX_PAYLOAD_BYTES) {
    return { error: "too_large" };
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
