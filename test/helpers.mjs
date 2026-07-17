import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MUST run before importing lib/server.mjs anywhere in the test process —
// STATE_DIR is captured at module-load time in lib/config.mjs.
process.env.OUTRIDR_STATE_DIR = mkdtempSync(join(tmpdir(), "outridr-state-"));

export function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function makeConfig(overrides = {}) {
  const base = {
    port: 0,
    host: "127.0.0.1",
    token: null,
    herdrSocket: join(makeTmpDir("outridr-herdr"), "herdr.sock"),
    claudeProjectsDir: makeTmpDir("outridr-projects"),
    exec: null,
    repos: null,
    push: { notifyOn: ["blocked", "done"], pollMs: 5000, enabled: false },
  };
  return {
    ...base,
    ...overrides,
    push: { ...base.push, ...(overrides.push ?? {}) },
  };
}

/**
 * Fake herdr: a unix-socket server matching the real one-request-per-
 * connection protocol. `handler(request)` returns the response object to
 * write as one JSON line, or null/undefined to close without answering.
 */
export function startFakeHerdr(socketPath, handler) {
  const server = createNetServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      const response = handler(request);
      if (response === null || response === undefined) {
        socket.end();
        return;
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

/** Boot the real server on port 0; resolves { server, port, baseUrl, config }. */
export async function startTestServer(configOverrides = {}) {
  const { startServer } = await import("../lib/server.mjs");
  const config = makeConfig(configOverrides);
  const server = startServer(config);
  await new Promise((resolve) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once("listening", resolve);
  });
  const port = server.address().port;
  return { server, port, baseUrl: `http://127.0.0.1:${port}`, config };
}

async function toResult(response) {
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON — return raw text */
  }
  return { status: response.status, body, headers: response.headers };
}

export async function getJson(url, headers = {}) {
  return toResult(await fetch(url, { headers }));
}

export async function postJson(url, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return toResult(
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

/** Creates `<projectsDir>/<subdir>/<sessionId>.jsonl` from an array of lines. */
export function writeSessionFixture(projectsDir, sessionId, lines, options = {}) {
  const { subdir = "proj-a", trailingNewline = true } = options;
  const dir = join(projectsDir, subdir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  const serializedLines = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line)));
  const content =
    serializedLines.join("\n") + (trailingNewline && serializedLines.length > 0 ? "\n" : "");
  writeFileSync(filePath, content);
  return filePath;
}

// ── Raw WebSocket client (manual RFC6455 handshake + framing) ──────────────

function encodeMaskedFrame(opcode, payload, { fin = true } = {}) {
  const mask = randomBytes(4);
  const maskedPayload = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    maskedPayload[i] = payload[i] ^ mask[i % 4];
  }
  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([firstByte, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, maskedPayload]);
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

/**
 * Connects to `path` on `port`, performs the RFC6455 handshake, and resolves
 * with a client that can send masked frames and await decoded frames from
 * the server. `headers` are appended verbatim to the upgrade request.
 */
export function connectRawWs(port, path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    const frameQueue = [];
    const frameWaiters = [];

    const client = {
      socket,
      key,
      sendFrame(opcode, payload = Buffer.alloc(0), options = {}) {
        socket.write(encodeMaskedFrame(opcode, payload, options));
      },
      sendText(text, options = {}) {
        client.sendFrame(0x1, Buffer.from(text, "utf8"), options);
      },
      nextFrame(timeoutMs = 5000) {
        return new Promise((res, rej) => {
          if (frameQueue.length > 0) {
            res(frameQueue.shift());
            return;
          }
          const timer = setTimeout(() => rej(new Error("timeout waiting for ws frame")), timeoutMs);
          frameWaiters.push((frame) => {
            clearTimeout(timer);
            res(frame);
          });
        });
      },
      close() {
        socket.destroy();
      },
    };

    socket.on("connect", () => {
      const requestHeaders = [
        `GET ${path} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ].join("\r\n");
      socket.write(requestHeaders);
    });

    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!handshakeDone) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const headerText = buffer.subarray(0, headerEnd).toString("utf8");
        buffer = buffer.subarray(headerEnd + 4);
        const [statusLine, ...rest] = headerText.split("\r\n");
        const statusCode = Number.parseInt(statusLine.split(" ")[1], 10);
        const responseHeaders = {};
        for (const line of rest) {
          const idx = line.indexOf(":");
          if (idx === -1) {
            continue;
          }
          responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
        handshakeDone = true;
        resolve({ ...client, statusCode, headers: responseHeaders });
      }
      let frame = decodeFrame(buffer);
      while (frame) {
        buffer = buffer.subarray(frame.consumed);
        if (frameWaiters.length > 0) {
          frameWaiters.shift()(frame);
        } else {
          frameQueue.push(frame);
        }
        frame = decodeFrame(buffer);
      }
    });

    socket.on("error", (error) => {
      if (!handshakeDone) {
        reject(error);
      }
    });
  });
}
