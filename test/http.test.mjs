import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  getJson,
  makeTmpDir,
  postJson,
  startFakeHerdr,
  startTestServer,
} from "./helpers.mjs";

test("GET /health — happy path", async (t) => {
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const herdr = await startFakeHerdr(config.herdrSocket, () => ({
    id: "outridr",
    result: { pong: true },
  }));
  t.after(() => herdr.close());

  const { status, body } = await getJson(`http://127.0.0.1:${port}/health`);
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, herdr: { pong: true }, pushTokens: 0 });
});

test("GET /health — herdr down", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const { status, body } = await getJson(`http://127.0.0.1:${port}/health`);
  assert.equal(status, 200);
  assert.equal(body.herdr, null);
}, { timeout: 10_000 });

test("auth — token required when configured", async (t) => {
  const { server, port } = await startTestServer({ token: "secret" });
  t.after(() => server.close());

  const noToken = await getJson(`http://127.0.0.1:${port}/health`);
  assert.equal(noToken.status, 401);

  const bearer = await getJson(`http://127.0.0.1:${port}/health`, {
    authorization: "Bearer secret",
  });
  assert.equal(bearer.status, 200);

  const query = await getJson(`http://127.0.0.1:${port}/health?token=secret`);
  assert.equal(query.status, 200);

  const wrong = await getJson(`http://127.0.0.1:${port}/health`, {
    authorization: "Bearer nope",
  });
  assert.equal(wrong.status, 401);
});

test("POST /push/register — valid token persists and increments count", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const { status, body } = await postJson(`http://127.0.0.1:${port}/push/register`, {
    token: "ExponentPushToken[abc]",
    device: "phone",
  });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, registered: 1 });

  const stateFile = join(process.env.OUTRIDR_STATE_DIR, "push-tokens.json");
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].token, "ExponentPushToken[abc]");
});

test("POST /push/register — malformed JSON body -> 400", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());
  const { status } = await postJson(`http://127.0.0.1:${port}/push/register`, "not json");
  assert.equal(status, 400);
});

test("POST /push/register — non-Expo token -> 400", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());
  const { status } = await postJson(`http://127.0.0.1:${port}/push/register`, { token: "junk" });
  assert.equal(status, 400);
});

test("POST /exec — disabled by default -> 404", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());
  const { status } = await postJson(`http://127.0.0.1:${port}/exec`, { args: ["a"] });
  assert.equal(status, 404);
});

test("POST /exec — enabled: runs configured command with args", async (t) => {
  const scriptsDir = makeTmpDir("outridr-exec");
  const scriptPath = join(scriptsDir, "echo-args.mjs");
  writeFileSync(scriptPath, "console.log(JSON.stringify(process.argv.slice(2)))\n");

  const { server, port } = await startTestServer({ exec: { command: process.execPath } });
  t.after(() => server.close());

  const { status, body } = await postJson(`http://127.0.0.1:${port}/exec`, {
    args: [scriptPath, "a", "b"],
  });
  assert.equal(status, 200);
  assert.equal(body.code, 0);
  assert.deepEqual(JSON.parse(body.stdout), ["a", "b"]);
});

test("POST /exec — validation: empty args -> 400", async (t) => {
  const { server, port } = await startTestServer({ exec: { command: process.execPath } });
  t.after(() => server.close());
  const { status } = await postJson(`http://127.0.0.1:${port}/exec`, { args: [] });
  assert.equal(status, 400);
});

test("POST /exec — validation: too many args -> 400", async (t) => {
  const { server, port } = await startTestServer({ exec: { command: process.execPath } });
  t.after(() => server.close());
  const args = Array.from({ length: 11 }, (_, i) => `arg${i}`);
  const { status } = await postJson(`http://127.0.0.1:${port}/exec`, { args });
  assert.equal(status, 400);
});

test("POST /exec — validation: arg too long -> 400", async (t) => {
  const { server, port } = await startTestServer({ exec: { command: process.execPath } });
  t.after(() => server.close());
  const { status } = await postJson(`http://127.0.0.1:${port}/exec`, { args: ["a".repeat(200)] });
  assert.equal(status, 400);
});

test("POST /exec — validation: non-array args -> 400", async (t) => {
  const { server, port } = await startTestServer({ exec: { command: process.execPath } });
  t.after(() => server.close());
  const { status } = await postJson(`http://127.0.0.1:${port}/exec`, { args: "nope" });
  assert.equal(status, 400);
});

test("GET /repos — well-formed output", async (t) => {
  const scriptsDir = makeTmpDir("outridr-repos");
  const scriptPath = join(scriptsDir, "repos.mjs");
  writeFileSync(scriptPath, 'console.log(JSON.stringify({ repos: [{ name: "x" }] }))\n');

  const { server, port } = await startTestServer({
    repos: { command: [process.execPath, scriptPath] },
  });
  t.after(() => server.close());

  const { status, body } = await getJson(`http://127.0.0.1:${port}/repos`);
  assert.equal(status, 200);
  assert.deepEqual(body, { repos: [{ name: "x" }] });
});

test("GET /repos — garbage output -> empty repos list", async (t) => {
  const scriptsDir = makeTmpDir("outridr-repos-bad");
  const scriptPath = join(scriptsDir, "repos.mjs");
  writeFileSync(scriptPath, 'console.log("not json")\n');

  const { server, port } = await startTestServer({
    repos: { command: [process.execPath, scriptPath] },
  });
  t.after(() => server.close());

  const { status, body } = await getJson(`http://127.0.0.1:${port}/repos`);
  assert.equal(status, 200);
  assert.deepEqual(body, { repos: [] });
});

test("unknown route -> 404", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());
  const { status } = await getJson(`http://127.0.0.1:${port}/nope`);
  assert.equal(status, 404);
});
