import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { connectRawWs, encodeMaskedFrame, startFakeHerdr, startTestServer } from "./helpers.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function expectedAccept(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function frameJson(frame) {
  return JSON.parse(frame.payload.toString("utf8").trim());
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
