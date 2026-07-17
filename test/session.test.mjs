import assert from "node:assert/strict";
import { appendFileSync, statSync } from "node:fs";
import { test } from "node:test";

import { getJson, startTestServer, writeSessionFixture } from "./helpers.mjs";

const UNKNOWN_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SESSION_TAIL_BYTES = 256 * 1024;
const SESSION_CHUNK_BYTES = 512 * 1024;

function padded(seq, extra = "") {
  return { seq, extra };
}

// findSessionFile() in lib/server.mjs caches resolved paths by session id at
// module scope, which persists across test cases in this process. Each test
// gets its own id so a stale cache entry from an earlier test can't shadow
// a fixture written under a different tmp claudeProjectsDir.
let sessionIdCounter = 0;
function nextSessionId() {
  sessionIdCounter += 1;
  return `0a1b2c3d-0000-4000-8000-${sessionIdCounter.toString(16).padStart(12, "0")}`;
}

test("GET /session/<unknown id> -> 404", async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => server.close());
  const { status, body } = await getJson(`http://127.0.0.1:${port}/session/${UNKNOWN_ID}`);
  assert.equal(status, 404);
  assert.deepEqual(body, { error: "session transcript not found" });
});

test("GET /session/<id> — small file tail", async (t) => {
  const sessionId = nextSessionId();
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const filePath = writeSessionFixture(config.claudeProjectsDir, sessionId, [
    padded(1),
    padded(2),
    padded(3),
  ]);
  const size = statSync(filePath).size;

  const { status, body } = await getJson(`http://127.0.0.1:${port}/session/${sessionId}`);
  assert.equal(status, 200);
  assert.equal(body.start, 0);
  assert.equal(body.offset, size);
  assert.equal(body.size, size);
  assert.deepEqual(
    body.entries.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(body.more, false);
});

test("GET /session/<id> — forward poll picks up appended line", async (t) => {
  const sessionId = nextSessionId();
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const filePath = writeSessionFixture(config.claudeProjectsDir, sessionId, [
    padded(1),
    padded(2),
    padded(3),
  ]);
  const first = await getJson(`http://127.0.0.1:${port}/session/${sessionId}`);
  const previousOffset = first.body.offset;

  appendFileSync(filePath, `${JSON.stringify(padded(4))}\n`);
  const newSize = statSync(filePath).size;

  const { status, body } = await getJson(
    `http://127.0.0.1:${port}/session/${sessionId}?offset=${previousOffset}`,
  );
  assert.equal(status, 200);
  assert.deepEqual(
    body.entries.map((e) => e.seq),
    [4],
  );
  assert.equal(body.offset, newSize);
});

test("GET /session/<id> — torn trailing line is excluded", async (t) => {
  const sessionId = nextSessionId();
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const filePath = writeSessionFixture(
    config.claudeProjectsDir,
    sessionId,
    [padded(1), padded(2), padded(3)],
    { trailingNewline: false },
  );
  const size = statSync(filePath).size;

  const { status, body } = await getJson(`http://127.0.0.1:${port}/session/${sessionId}`);
  assert.equal(status, 200);
  assert.deepEqual(
    body.entries.map((e) => e.seq),
    [1, 2],
  );
  assert.ok(body.offset < size, "offset should stop before the torn line");
});

test("GET /session/<id> — tail alignment on a large file skips the partial first line", async (t) => {
  const sessionId = nextSessionId();
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const lineCount = 400;
  const lines = Array.from({ length: lineCount }, (_, i) => padded(i + 1, "x".repeat(700)));
  const filePath = writeSessionFixture(config.claudeProjectsDir, sessionId, lines);
  const size = statSync(filePath).size;
  assert.ok(size > SESSION_TAIL_BYTES, "fixture must exceed the tail window for this test to be meaningful");

  const { status, body } = await getJson(`http://127.0.0.1:${port}/session/${sessionId}`);
  assert.equal(status, 200);
  assert.ok(body.start > 0, "tail window should not start at byte 0 on a large file");
  assert.equal(body.offset, size);
  assert.ok(body.entries.length > 0);
  assert.ok(Number.isInteger(body.entries[0].seq), "first entry must be a complete parsed object");
});

test("GET /session/<id> — history pagination via end= returns the preceding window", async (t) => {
  const sessionId = nextSessionId();
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const lineCount = 400;
  const lines = Array.from({ length: lineCount }, (_, i) => padded(i + 1, "x".repeat(700)));
  writeSessionFixture(config.claudeProjectsDir, sessionId, lines);

  const tail = await getJson(`http://127.0.0.1:${port}/session/${sessionId}`);
  const tailFirstSeq = tail.body.entries[0].seq;

  const history = await getJson(
    `http://127.0.0.1:${port}/session/${sessionId}?end=${tail.body.start}`,
  );
  assert.equal(history.status, 200);
  assert.ok(history.body.entries.length > 0, "history window should contain entries");
  const historyLastSeq = history.body.entries.at(-1).seq;
  assert.equal(historyLastSeq, tailFirstSeq - 1);
});

test("GET /session/<id> — oversized line is skipped so offset still advances (regression: a16bc22)", async (t) => {
  const sessionId = nextSessionId();
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());

  const lineA = JSON.stringify(padded(1));
  const lineB = JSON.stringify({ seq: 2, extra: "x".repeat(SESSION_CHUNK_BYTES) });
  const lineC = JSON.stringify(padded(3));
  assert.ok(
    Buffer.byteLength(lineB, "utf8") > SESSION_CHUNK_BYTES,
    "line B must exceed the read-window size to exercise the guard",
  );
  const filePath = writeSessionFixture(config.claudeProjectsDir, sessionId, [lineA, lineB, lineC]);
  const offsetAfterA = Buffer.byteLength(`${lineA}\n`, "utf8");
  const size = statSync(filePath).size;

  const { status, body } = await getJson(
    `http://127.0.0.1:${port}/session/${sessionId}?offset=${offsetAfterA}`,
  );
  assert.equal(status, 200);
  assert.deepEqual(body.entries, []);
  assert.ok(body.offset > offsetAfterA, "offset must strictly advance past the oversized line");
  assert.ok(body.offset < size, "offset should land before end of file, at the start of line C");

  const followUp = await getJson(
    `http://127.0.0.1:${port}/session/${sessionId}?offset=${body.offset}`,
  );
  assert.equal(followUp.status, 200);
  assert.deepEqual(
    followUp.body.entries.map((e) => e.seq),
    [3],
  );
});

test("GET /session/<id> — offset beyond file size clamps and returns no entries", async (t) => {
  const sessionId = nextSessionId();
  const { server, port, config } = await startTestServer();
  t.after(() => server.close());
  const filePath = writeSessionFixture(config.claudeProjectsDir, sessionId, [padded(1), padded(2)]);
  const size = statSync(filePath).size;

  const { status, body } = await getJson(
    `http://127.0.0.1:${port}/session/${sessionId}?offset=999999999`,
  );
  assert.equal(status, 200);
  assert.deepEqual(body.entries, []);
  assert.ok(body.offset <= size, "offset must be clamped to at most the file size");
});
