import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  getJson,
  makeTmpDir,
  postJson,
  startFakeHerdr,
  startTestServer,
} from "./helpers.mjs";

const SERVER_MODULE_PATH = fileURLToPath(new URL("../lib/server.mjs", import.meta.url));

/** Grabs an ephemeral port and immediately frees it for a subprocess to bind. */
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

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

// Both tests below force a *second* "data" event to arrive on the client's
// unix socket after the response line has already been parsed: the response
// line is immediately followed (no delay) by a multi-hundred-KB filler with
// no newline of its own, which exceeds Node's internal socket read-chunk
// size and so is delivered to herdrRequest's "data" handler as one or more
// additional events. Against the pre-fix herdrRequest, the buffer still
// contains the first (already-handled) newline, so every extra chunk
// re-triggers the callback — which is exactly the /health double-response
// (ERR_HTTP_HEADERS_SENT, process crash) and push-watcher poll-multiplication
// bug this plan fixes. A short delay (setImmediate/setTimeout) before writing
// the extra bytes does NOT reproduce this reliably: Node's default
// `allowHalfOpen: false` tears the connection down as soon as the client
// calls `socket.end()`, before a delayed write/RST can land — so the extra
// bytes must arrive as part of the same unbroken write.
const FILLER_BYTES = 2 * 1024 * 1024;

test("GET /health — late TCP chunk after the response line, callback still fires once", async (t) => {
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const herdr = await startFakeHerdr(
    config.herdrSocket,
    () => ({ id: "outridr", result: { pong: true } }),
    {
      afterResponse: (socket, responseLine) => {
        socket.end(responseLine + "x".repeat(FILLER_BYTES));
      },
    },
  );
  t.after(() => herdr.close());

  const first = await getJson(`http://127.0.0.1:${port}/health`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, herdr: { pong: true }, pushTokens: 0 });

  // A double callback would have thrown ERR_HTTP_HEADERS_SENT inside the
  // socket's "data" handler and crashed the process — reaching this second
  // request at all is the regression check.
  const second = await getJson(`http://127.0.0.1:${port}/health`);
  assert.equal(second.status, 200);
});

test("GET /health — herdr RSTs partway through a multi-chunk response, callback still fires once", async (t) => {
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const herdr = await startFakeHerdr(
    config.herdrSocket,
    () => ({ id: "outridr", result: { pong: true } }),
    {
      afterResponse: (socket, responseLine) => {
        socket.write(responseLine + "x".repeat(FILLER_BYTES), () => {
          socket.destroy(new Error("boom"));
        });
      },
    },
  );
  t.after(() => herdr.close());

  const first = await getJson(`http://127.0.0.1:${port}/health`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, herdr: { pong: true }, pushTokens: 0 });

  const second = await getJson(`http://127.0.0.1:${port}/health`);
  assert.equal(second.status, 200);
});

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

test("startServer — EADDRINUSE on the second listen exits 1 with a server error message", async (t) => {
  const port = await reserveFreePort();
  const scriptDir = makeTmpDir("outridr-eaddrinuse");
  const scriptPath = join(scriptDir, "double-listen.mjs");
  const config = {
    port,
    host: "127.0.0.1",
    token: null,
    herdrSocket: join(makeTmpDir("outridr-herdr"), "herdr.sock"),
    claudeProjectsDir: makeTmpDir("outridr-projects"),
    exec: null,
    repos: null,
    push: { notifyOn: ["blocked", "done"], pollMs: 5000, enabled: false },
  };
  writeFileSync(
    scriptPath,
    [
      `import { startServer } from ${JSON.stringify(SERVER_MODULE_PATH)};`,
      `const config = ${JSON.stringify(config)};`,
      "startServer(config);",
      "setTimeout(() => startServer(config), 200);",
      "",
    ].join("\n"),
  );

  const child = spawn(process.execPath, [scriptPath]);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /outridr: server error:.*EADDRINUSE/);
});
