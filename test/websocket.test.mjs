import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { connect as netConnect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { connectRawWs, encodeMaskedFrame, startFakeHerdr, startTestServer } from "./helpers.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wsLimitRunner = join(repoRoot, "test", "ws-limit-runner.mjs");

// OUTRIDR_WS_MAX_CONNECTIONS / OUTRIDR_WS_IDLE_MS are read once, at module
// load of lib/websocket.mjs — and every other test in this file already
// shares one process whose first startTestServer() call froze the defaults
// (32 connections / 10 min idle) into that module instance. So the two tests
// below run test/ws-limit-runner.mjs in a dedicated subprocess with its own
// env, matching the "env set before the module is ever imported" discipline
// used for OUTRIDR_EXPO_PUSH_URL in test/push.test.mjs.
function runWsLimitScenario(mode, envOverrides) {
  const stdout = execFileSync(process.execPath, [wsLimitRunner, mode], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...envOverrides },
  });
  const jsonStart = stdout.indexOf("{");
  return JSON.parse(stdout.slice(jsonStart));
}

function expectedAccept(key) {
  return createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
}

function frameJson(frame) {
  return JSON.parse(frame.payload.toString("utf8").trim());
}

/**
 * Sends a hand-built upgrade request with exactly the given header lines
 * (no default Host, unlike connectRawWs) and resolves with the response
 * status line. Used only to set a single, non-duplicated Host header —
 * connectRawWs always sends its own `Host: 127.0.0.1` first, and Node's
 * HTTP parser keeps the first of two duplicate Host headers, so appending
 * a second one there wouldn't actually exercise the rejection.
 */
function rawUpgradeStatus(port, path, headerLines) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    let buffer = "";
    socket.on("connect", () => {
      socket.write([`GET ${path} HTTP/1.1`, ...headerLines, "", ""].join("\r\n"));
    });
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      const statusLine = buffer.split("\r\n")[0];
      if (statusLine.includes(" ")) {
        resolve({ statusCode: Number.parseInt(statusLine.split(" ")[1], 10), socket });
      }
    });
    socket.on("error", reject);
  });
}

test("handshake — 101 with correct Sec-WebSocket-Accept", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const client = await connectRawWs(port, "/herdr");
  t.after(() => client.close());

  assert.equal(client.statusCode, 101);
  assert.equal(client.headers["sec-websocket-accept"], expectedAccept(client.key));
});

test("auth on upgrade — rejected without token, accepted with query token", async (t) => {
  const { server, port } = await startTestServer({ token: "secret" });
  t.after(() => server.close());

  const unauthorized = await connectRawWs(port, "/herdr");
  assert.equal(unauthorized.statusCode, 401);
  await new Promise((resolve) => {
    unauthorized.socket.once("close", resolve);
    unauthorized.socket.once("end", resolve);
  });

  const authorized = await connectRawWs(port, "/herdr?token=secret");
  t.after(() => authorized.close());
  assert.equal(authorized.statusCode, 101);
});

test("tokenless server: upgrade with an Origin header — rejected 403 (browser drive-by defense)", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const client = await connectRawWs(port, "/herdr", {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(client.statusCode, 403);
  await new Promise((resolve) => {
    client.socket.once("close", resolve);
    client.socket.once("end", resolve);
  });
});

test("token server: an Origin header is allowed — the native app's WS sends one; auth is the perimeter", async (t) => {
  const { server, port } = await startTestServer({ token: "secret" });
  t.after(() => server.close());

  const client = await connectRawWs(port, "/herdr?token=secret", {
    headers: { Origin: "http://gondor:8674" },
  });
  assert.equal(client.statusCode, 101);
  client.close();
});

test("token server: a short-hostname Host is allowed — the app addresses the machine by MagicDNS name", async (t) => {
  const { server, port } = await startTestServer({ token: "secret" });
  t.after(() => server.close());

  const client = await connectRawWs(port, "/herdr?token=secret", { headers: { Host: "gondor" } });
  assert.equal(client.statusCode, 101);
  client.close();
});

test("tokenless server: upgrade with a non-tailnet Host header — 421 misdirected request", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const { statusCode, socket } = await rawUpgradeStatus(port, "/herdr", [
    "Host: evil.example",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
  ]);
  assert.equal(statusCode, 421);
  socket.destroy();
});

test("round trip — one request line, one response frame", async (t) => {
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const herdr = await startFakeHerdr(config.herdrSocket, (request) =>
    request.id === "r1" ? { id: "r1", result: { agents: [] } } : null,
  );
  t.after(() => herdr.close());

  const client = await connectRawWs(port, "/herdr");
  t.after(() => client.close());
  assert.equal(client.statusCode, 101);

  client.sendText(JSON.stringify({ id: "r1", method: "agent.list", params: {} }));
  const frame = await client.nextFrame();
  assert.equal(frame.opcode, 0x1);
  const response = frameJson(frame);
  assert.equal(response.id, "r1");
  assert.deepEqual(response.result, { agents: [] });
});

test("herdr unreachable — synthesized error response", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const client = await connectRawWs(port, "/herdr");
  t.after(() => client.close());
  assert.equal(client.statusCode, 101);

  client.sendText(JSON.stringify({ id: "r1", method: "agent.list", params: {} }));
  const frame = await client.nextFrame();
  const response = frameJson(frame);
  assert.deepEqual(response, {
    id: "r1",
    error: { code: "outridr_error", message: "herdr socket unavailable" },
  });
});

test("ping/pong — pong echoes the ping payload", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const client = await connectRawWs(port, "/herdr");
  t.after(() => client.close());
  assert.equal(client.statusCode, 101);

  const payload = Buffer.from("keepalive");
  client.sendFrame(0x9, payload);
  const frame = await client.nextFrame();
  assert.equal(frame.opcode, 0xa);
  assert.deepEqual(frame.payload, payload);
});

test("multiple NDJSON lines in one frame — two correlated response frames", async (t) => {
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const herdr = await startFakeHerdr(config.herdrSocket, (request) => ({
    id: request.id,
    result: { echo: request.method },
  }));
  t.after(() => herdr.close());

  const client = await connectRawWs(port, "/herdr");
  t.after(() => client.close());
  assert.equal(client.statusCode, 101);

  const line1 = JSON.stringify({ id: "m1", method: "one", params: {} });
  const line2 = JSON.stringify({ id: "m2", method: "two", params: {} });
  client.sendText(`${line1}\n${line2}`);

  const first = frameJson(await client.nextFrame());
  const second = frameJson(await client.nextFrame());
  const byId = { [first.id]: first, [second.id]: second };
  assert.deepEqual(byId.m1.result, { echo: "one" });
  assert.deepEqual(byId.m2.result, { echo: "two" });
});

test("fragmented message — continuation frame is reassembled and answered", async (t) => {
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const herdr = await startFakeHerdr(config.herdrSocket, (request) =>
    request.id === "f1" ? { id: "f1", result: { ok: true } } : null,
  );
  t.after(() => herdr.close());

  const client = await connectRawWs(port, "/herdr");
  t.after(() => client.close());
  assert.equal(client.statusCode, 101);

  const message = JSON.stringify({ id: "f1", method: "ping", params: {} });
  const mid = Math.floor(message.length / 2);
  client.sendFrame(0x1, Buffer.from(message.slice(0, mid), "utf8"), { fin: false });
  client.sendFrame(0x0, Buffer.from(message.slice(mid), "utf8"), { fin: true });

  const frame = await client.nextFrame();
  const response = frameJson(frame);
  assert.deepEqual(response, { id: "f1", result: { ok: true } });
});

test("pipelined head — a frame sent in the same write as the handshake is not dropped", async (t) => {
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const herdr = await startFakeHerdr(config.herdrSocket, (request) =>
    request.id === "h1" ? { id: "h1", result: { ok: true } } : null,
  );
  t.after(() => herdr.close());

  const message = JSON.stringify({ id: "h1", method: "ping", params: {} });
  const pipelinedData = encodeMaskedFrame(0x1, Buffer.from(message, "utf8"));

  const client = await connectRawWs(port, "/herdr", { pipelinedData });
  t.after(() => client.close());
  assert.equal(client.statusCode, 101);

  const frame = await client.nextFrame();
  const response = frameJson(frame);
  assert.deepEqual(response, { id: "h1", result: { ok: true } });
});

test("oversized frame — a declared length beyond the cap closes 1009 before the payload arrives", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const client = await connectRawWs(port, "/herdr");
  t.after(() => client.close());
  assert.equal(client.statusCode, 101);

  // Hand-roll a masked frame header declaring a 2 MiB payload; the payload
  // itself is never sent, proving the server rejects on the header alone.
  const declaredLength = 2 * 1024 * 1024;
  const header = Buffer.alloc(14);
  header[0] = 0x80 | 0x1; // fin + text opcode
  header[1] = 0x80 | 127; // masked + 64-bit length marker
  header.writeBigUInt64BE(BigInt(declaredLength), 2);
  Buffer.from([0x01, 0x02, 0x03, 0x04]).copy(header, 10);
  client.socket.write(header);

  const frame = await client.nextFrame();
  assert.equal(frame.opcode, 0x8);
  assert.equal(frame.payload.readUInt16BE(0), 1009);
});

test("fragment flood — accumulated fragments beyond the cap close 1009", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const client = await connectRawWs(port, "/herdr");
  t.after(() => client.close());
  assert.equal(client.statusCode, 101);

  const chunk = Buffer.alloc(64 * 1024, 0x61); // well under the per-frame cap
  const framesNeeded = Math.ceil((4 * 1024 * 1024) / chunk.length) + 2;
  client.sendFrame(0x1, chunk, { fin: false });
  for (let i = 1; i < framesNeeded; i++) {
    client.sendFrame(0x0, chunk, { fin: false });
  }

  const frame = await client.nextFrame();
  assert.equal(frame.opcode, 0x8);
  assert.equal(frame.payload.readUInt16BE(0), 1009);
});

test("large-but-legal frame — a ~100 KiB masked text frame still round-trips", async (t) => {
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const herdr = await startFakeHerdr(config.herdrSocket, (request) =>
    request.id === "big1" ? { id: "big1", result: { ok: true } } : null,
  );
  t.after(() => herdr.close());

  const client = await connectRawWs(port, "/herdr");
  t.after(() => client.close());
  assert.equal(client.statusCode, 101);

  const padding = "x".repeat(100 * 1024);
  const message = JSON.stringify({ id: "big1", method: "ping", params: {}, padding });
  client.sendText(message);

  const frame = await client.nextFrame();
  const response = frameJson(frame);
  assert.deepEqual(response, { id: "big1", result: { ok: true } });
});

test("in-flight cap — 100 one-line requests in a single message are all answered, no protocol error", async (t) => {
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const herdr = await startFakeHerdr(config.herdrSocket, (request) => ({
    id: request.id,
    result: { ok: true },
  }));
  t.after(() => herdr.close());

  const client = await connectRawWs(port, "/herdr");
  t.after(() => client.close());
  assert.equal(client.statusCode, 101);

  const ids = Array.from({ length: 100 }, (_, i) => `cap-${i}`);
  const message = ids.map((id) => JSON.stringify({ id, method: "ping", params: {} })).join("\n");
  client.sendText(message);

  const received = new Map();
  for (let i = 0; i < ids.length; i++) {
    const frame = await client.nextFrame();
    assert.notEqual(frame.opcode, 0x8, "the in-flight cap must not close the connection");
    const response = frameJson(frame);
    received.set(response.id, response);
  }
  assert.equal(received.size, ids.length, "every request line must eventually receive a response");
  const busyCount = [...received.values()].filter((r) => r.error?.code === "outridr_busy").length;
  assert.ok(busyCount > 0, "expected the in-flight cap to reject at least one of the 100 lines");
  assert.ok(
    busyCount < ids.length,
    "expected at least some lines to be answered by the fake herdr",
  );
});

test("unmasked frame — a valid but unmasked client frame closes 1002", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const client = await connectRawWs(port, "/herdr");
  t.after(() => client.close());
  assert.equal(client.statusCode, 101);

  client.sendUnmaskedFrame(
    0x1,
    Buffer.from(JSON.stringify({ id: "u1", method: "ping", params: {} }), "utf8"),
  );

  const frame = await client.nextFrame();
  assert.equal(frame.opcode, 0x8);
  assert.equal(frame.payload.readUInt16BE(0), 1002);
});

test("close — server responds with close frame and ends the TCP socket", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const client = await connectRawWs(port, "/herdr");
  assert.equal(client.statusCode, 101);

  client.sendFrame(0x8, Buffer.alloc(0));
  const frame = await client.nextFrame();
  assert.equal(frame.opcode, 0x8);

  await new Promise((resolve) => {
    client.socket.once("close", resolve);
    client.socket.once("end", resolve);
  });
});

test("connection cap — a 3rd connection beyond OUTRIDR_WS_MAX_CONNECTIONS does not reach 101", () => {
  const { thirdStatusCode } = runWsLimitScenario("cap", { OUTRIDR_WS_MAX_CONNECTIONS: "2" });
  assert.equal(thirdStatusCode, 503);
});

test("idle timeout — a silent connection is closed within OUTRIDR_WS_IDLE_MS", () => {
  const { elapsedMs } = runWsLimitScenario("idle", { OUTRIDR_WS_IDLE_MS: "200" });
  assert.ok(
    elapsedMs < 3000,
    `expected the idle timeout to fire well under 3s, took ${elapsedMs}ms`,
  );
  assert.ok(
    elapsedMs >= 150,
    `expected the idle timeout not to fire before ~200ms, took ${elapsedMs}ms`,
  );
});
