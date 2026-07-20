import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  getJson,
  makeTmpDir,
  postJson,
  putJson,
  startFakeHerdr,
  startTestServer,
} from "./helpers.mjs";

const SERVER_MODULE_PATH = fileURLToPath(new URL("../lib/server.mjs", import.meta.url));
const PACKAGE_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

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
  assert.deepEqual(body, { ok: true, version: PACKAGE_VERSION, herdr: { pong: true }, pushTokens: 0 });
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
  assert.deepEqual(first.body, { ok: true, version: PACKAGE_VERSION, herdr: { pong: true }, pushTokens: 0 });

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
  assert.deepEqual(first.body, { ok: true, version: PACKAGE_VERSION, herdr: { pong: true }, pushTokens: 0 });

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

  // ?token= is scoped to the WS upgrade only (see test/websocket.test.mjs);
  // every HTTP route now accepts the Authorization header exclusively.
  const query = await getJson(`http://127.0.0.1:${port}/health?token=secret`);
  assert.equal(query.status, 401);

  const wrong = await getJson(`http://127.0.0.1:${port}/health`, {
    authorization: "Bearer nope",
  });
  assert.equal(wrong.status, 401);
});

test("request with a non-tailnet Host header — 421 misdirected request", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  // fetch() (used by the getJson/postJson helpers) refuses to send a custom
  // Host header — it always overwrites it with the actual connection
  // authority — so this needs node:http's client, which allows it.
  const { status } = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: "/health", method: "GET", headers: { host: "evil.example" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 421);
});

test("request with an all-hex domain Host header — 421 (regex-vs-isIP regression)", async (t) => {
  // dead.cafe, beef.cafe, face.cafe, etc. are registrable domains composed
  // entirely of [0-9a-f.] characters — a naive `/^[0-9a-f:.]+$/` IP-literal
  // check would wrongly accept them, letting a DNS-rebinding attacker
  // register one and point its DNS at the tailnet address. hostAllowed must
  // use node:net's isIP (real IP-literal parsing), not a character-class regex.
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const { status } = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: "/health", method: "GET", headers: { host: "dead.cafe" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 421);
});

test("POST with a >64 KiB body — 413 body too large", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const oversizedToken = `ExponentPushToken[${"x".repeat(70 * 1024)}]`;
  const { status } = await postJson(`http://127.0.0.1:${port}/push/register`, {
    token: oversizedToken,
    device: "phone",
  });
  assert.equal(status, 413);
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

test("POST /push/register — multibyte device name split mid-character across two chunks", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  // "🎉" is U+1F389, encoded as the 4 utf8 bytes F0 9F 8E 89. Split the
  // request body so that split falls between the 2nd and 3rd byte of the
  // emoji — a naive `body += chunk` (implicit per-chunk toString) decodes
  // each half independently and replaces both incomplete sequences with
  // U+FFFD, corrupting the device string.
  const device = "phone-🎉";
  const payload = Buffer.from(JSON.stringify({ token: "ExponentPushToken[abc]", device }), "utf8");
  const emojiStart = payload.indexOf(Buffer.from("🎉", "utf8"));
  const splitAt = emojiStart + 2;

  const { status, body } = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/push/register",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": payload.length },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      },
    );
    req.on("error", reject);
    req.write(payload.subarray(0, splitAt));
    setTimeout(() => {
      req.write(payload.subarray(splitAt));
      req.end();
    }, 20);
  });

  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, registered: 1 });

  const stateFile = join(process.env.OUTRIDR_STATE_DIR, "push-tokens.json");
  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  const registered = persisted.find((entry) => entry.token === "ExponentPushToken[abc]");
  assert.equal(registered.device, device, "multibyte device name must survive the mid-character split intact");
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

test("POST /exec — removed endpoint -> 404", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());
  const { status } = await postJson(`http://127.0.0.1:${port}/exec`, { args: ["a"] });
  assert.equal(status, 404);
});

test("GET /repos — disabled by default -> 404", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());
  const { status } = await getJson(`http://127.0.0.1:${port}/repos`);
  assert.equal(status, 404);
});

test("GET /repos — configured roots: scans and serves discovered repos", async (t) => {
  const root = makeTmpDir("outridr-repos");
  mkdirSync(join(root, "a", ".git"), { recursive: true });
  mkdirSync(join(root, "b", ".git"), { recursive: true });

  const { server, port } = await startTestServer({ repos: { roots: [root], depth: 2 } });
  t.after(() => server.close());

  const { status, body } = await getJson(`http://127.0.0.1:${port}/repos`);
  assert.equal(status, 200);
  assert.deepEqual(body, {
    repos: [
      { alias: "a", path: join(root, "a") },
      { alias: "b", path: join(root, "b") },
    ],
  });
});

test("GET /repos/roots — unconfigured -> empty array", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());
  const { status, body } = await getJson(`http://127.0.0.1:${port}/repos/roots`);
  assert.equal(status, 200);
  assert.deepEqual(body, { roots: [] });
});

test("GET /repos/roots — configured roots: returns the expanded roots", async (t) => {
  const root = makeTmpDir("outridr-repos-roots");
  const { server, port } = await startTestServer({ repos: { roots: [root], depth: 2 } });
  t.after(() => server.close());
  const { status, body } = await getJson(`http://127.0.0.1:${port}/repos/roots`);
  assert.equal(status, 200);
  assert.deepEqual(body, { roots: [root] });
});

test("PUT /repos/roots — tokenless server -> 403, config file untouched", async (t) => {
  const seeded = JSON.stringify({ token: null, custom: "keep-me" });
  writeFileSync(process.env.OUTRIDR_CONFIG, seeded);

  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const { status, body } = await putJson(`http://127.0.0.1:${port}/repos/roots`, {
    roots: [makeTmpDir("outridr-repos-403")],
  });
  assert.equal(status, 403);
  assert.deepEqual(body, {
    error: "config-token-required",
    message:
      "Set a token in ~/.config/outridr/config.json (or OUTRIDR_TOKEN) to allow remote config changes",
  });

  assert.equal(readFileSync(process.env.OUTRIDR_CONFIG, "utf8"), seeded);
});

test("PUT /repos/roots — configured token + valid roots: writes config, invalidates cache, returns scan", async (t) => {
  writeFileSync(process.env.OUTRIDR_CONFIG, JSON.stringify({ token: "secret" }));
  const root = makeTmpDir("outridr-repos-put");
  mkdirSync(join(root, "planted", ".git"), { recursive: true });

  const { server, port } = await startTestServer({ token: "secret" });
  t.after(() => server.close());

  const { status, body } = await putJson(
    `http://127.0.0.1:${port}/repos/roots`,
    { roots: [root] },
    { authorization: "Bearer secret" },
  );
  assert.equal(status, 200);
  assert.deepEqual(body, {
    roots: [root],
    repos: [{ alias: "planted", path: join(root, "planted") }],
  });

  const fileContents = JSON.parse(readFileSync(process.env.OUTRIDR_CONFIG, "utf8"));
  assert.deepEqual(fileContents.repos.roots, [root]);

  const getResult = await getJson(`http://127.0.0.1:${port}/repos`, {
    authorization: "Bearer secret",
  });
  assert.equal(getResult.status, 200);
  assert.deepEqual(getResult.body, {
    repos: [{ alias: "planted", path: join(root, "planted") }],
  });
});

test("PUT /repos/roots — entry not an existing directory -> 400 naming it, config file untouched", async (t) => {
  const seeded = JSON.stringify({ token: "secret" });
  writeFileSync(process.env.OUTRIDR_CONFIG, seeded);

  const { server, port } = await startTestServer({ token: "secret" });
  t.after(() => server.close());

  const badPath = join(makeTmpDir("outridr-repos-missing"), "does-not-exist");
  const { status, body } = await putJson(
    `http://127.0.0.1:${port}/repos/roots`,
    { roots: [badPath] },
    { authorization: "Bearer secret" },
  );
  assert.equal(status, 400);
  assert.equal(body.error, "invalid-roots");
  assert.ok(body.message.includes(badPath), "message should name the failing entry");

  assert.equal(readFileSync(process.env.OUTRIDR_CONFIG, "utf8"), seeded);
});

test("PUT /repos/roots — preserves unrelated config keys (including token)", async (t) => {
  const root = makeTmpDir("outridr-repos-preserve");
  mkdirSync(join(root, "planted", ".git"), { recursive: true });
  writeFileSync(process.env.OUTRIDR_CONFIG, JSON.stringify({ token: "secret", custom: { keep: true } }));

  const { server, port } = await startTestServer({ token: "secret" });
  t.after(() => server.close());

  const { status } = await putJson(
    `http://127.0.0.1:${port}/repos/roots`,
    { roots: [root] },
    { authorization: "Bearer secret" },
  );
  assert.equal(status, 200);

  const fileContents = JSON.parse(readFileSync(process.env.OUTRIDR_CONFIG, "utf8"));
  assert.equal(fileContents.token, "secret");
  assert.deepEqual(fileContents.custom, { keep: true });
  assert.deepEqual(fileContents.repos.roots, [root]);
});

test("PUT /repos/roots — wrong bearer token -> 401", async (t) => {
  writeFileSync(process.env.OUTRIDR_CONFIG, JSON.stringify({ token: "secret" }));
  const { server, port } = await startTestServer({ token: "secret" });
  t.after(() => server.close());

  const { status } = await putJson(
    `http://127.0.0.1:${port}/repos/roots`,
    { roots: [makeTmpDir("outridr-repos-401")] },
    { authorization: "Bearer nope" },
  );
  assert.equal(status, 401);
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
