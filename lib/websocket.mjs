/**
 * WebSocket: minimal RFC6455 server, one unix conn per request line.
 *
 * herdr's API socket is one-request-per-connection, so the WS is the
 * long-lived session and every request line gets its own unix connection;
 * the app correlates responses by request id.
 */
import { createHash } from "node:crypto";
import { connect } from "node:net";

import { authorizedUpgrade, hostAllowed } from "./http-util.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024; // per frame, declared
const WS_MAX_MESSAGE_BYTES = 4 * 1024 * 1024; // accumulated fragments + buffer
// A message can carry thousands of one-line requests; without a cap each
// one opens a fresh unix connection, so a single 4 MB message could open
// thousands of simultaneous sockets to herdr.
const MAX_INFLIGHT_UNIX = 64;
// One tailnet peer opening many WS connections and holding them open would
// otherwise leak file descriptors without bound; cap concurrent connections
// and reap idle ones.
const WS_MAX_CONNECTIONS = Number(process.env.OUTRIDR_WS_MAX_CONNECTIONS) || 32;
const WS_IDLE_MS = Number(process.env.OUTRIDR_WS_IDLE_MS) || 10 * 60 * 1000;
let activeConnections = 0;

export function handleUpgrade(config, req, socket, head) {
  const url = new URL(req.url ?? "/", "http://outridr");
  if (url.pathname !== "/herdr" || !authorizedUpgrade(config, req, url)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  // The Host and Origin guards below are browser-drive-by / DNS-rebinding
  // defenses that only matter on a TOKENLESS server: with a token configured,
  // a hostile webpage can't authenticate (it doesn't hold the secret), so
  // auth above is the real perimeter. Enforcing them with a token set breaks
  // the native app, which connects to this machine by its short MagicDNS
  // hostname and whose WebSocket sends an Origin header. So gate on token.
  if (!config.token) {
    if (!hostAllowed(req.headers.host)) {
      socket.end("HTTP/1.1 421 Misdirected Request\r\n\r\n");
      return;
    }
    if (typeof req.headers.origin === "string") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  if (activeConnections >= WS_MAX_CONNECTIONS) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
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
  activeConnections++;

  let idleTimer;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => closeAll(1000), WS_IDLE_MS);
    idleTimer.unref();
  };

  const closeAll = (code) => {
    if (!wsOpen) {
      return;
    }
    wsOpen = false;
    activeConnections--;
    clearTimeout(idleTimer);
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

  const requestIdOf = (line) => {
    try {
      return JSON.parse(line).id ?? "";
    } catch {
      return ""; // unparseable request line
    }
  };

  const dispatchRequestLine = (line) => {
    if (liveUnixSockets.size >= MAX_INFLIGHT_UNIX) {
      sendLineToWs(
        `${JSON.stringify({
          id: requestIdOf(line),
          error: { code: "outridr_busy", message: "too many in-flight requests" },
        })}\n`,
      );
      return;
    }
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
      sendLineToWs(
        `${JSON.stringify({ id: requestIdOf(line), error: { code: "outridr_error", message: "herdr socket unavailable" } })}\n`,
      );
    });
  };

  const onData = (data) => {
    armIdleTimer();
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

  armIdleTimer();
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
