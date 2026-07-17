import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { postJson, startFakeExpo, startFakeHerdr, startTestServer } from "./helpers.mjs";

// Env-before-import: OUTRIDR_EXPO_PUSH_URL is read at module load of
// lib/server.mjs, and startTestServer's dynamic import happens lazily on
// first call — so the fake Expo server must be up and the env var set
// before any test() body below makes its first startTestServer() call.
const fakeExpo = await startFakeExpo();
process.env.OUTRIDR_EXPO_PUSH_URL = fakeExpo.url;
after(() => fakeExpo.close());

const defaultResponder = (messages) => messages.map(() => ({ status: "ok", id: "fake-id" }));

function resetFakeExpo() {
  fakeExpo.requests.length = 0;
  fakeExpo.setResponse(defaultResponder);
}

function resetPushTokenState() {
  rmSync(join(process.env.OUTRIDR_STATE_DIR, "push-tokens.json"), { force: true });
}

async function waitFor(conditionFn, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (conditionFn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: condition not met before timeout");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPersistedTokens() {
  return JSON.parse(readFileSync(join(process.env.OUTRIDR_STATE_DIR, "push-tokens.json"), "utf8"));
}

test("POST /push/unregister — removes a token, is idempotent for unknown tokens", async (t) => {
  resetPushTokenState();
  const { server, port } = await startTestServer();
  t.after(() => server.close());

  const token = "ExponentPushToken[unregister-me]";
  const registered = await postJson(`http://127.0.0.1:${port}/push/register`, { token, device: "phone" });
  assert.equal(registered.status, 200);
  assert.deepEqual(registered.body, { ok: true, registered: 1 });

  const unregistered = await postJson(`http://127.0.0.1:${port}/push/unregister`, { token });
  assert.equal(unregistered.status, 200);
  assert.deepEqual(unregistered.body, { ok: true, registered: 0 });

  const persisted = readPersistedTokens();
  assert.equal(
    persisted.find((entry) => entry.token === token),
    undefined,
  );

  const again = await postJson(`http://127.0.0.1:${port}/push/unregister`, { token });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { ok: true, registered: 0 });
});

test("push watcher — a status transition into a notify-worthy state pushes exactly once", async (t) => {
  resetPushTokenState();
  resetFakeExpo();
  const { server, port, config } = await startTestServer({
    push: { enabled: true, pollMs: 50, notifyOn: ["blocked", "done"] },
  });
  t.after(() => server.close());

  let pollCount = 0;
  const herdr = await startFakeHerdr(config.herdrSocket, (request) => {
    if (request.method !== "agent.list") {
      return { id: request.id, result: {} };
    }
    pollCount += 1;
    const status = pollCount === 1 ? "working" : "blocked";
    return {
      id: request.id,
      result: {
        agents: [{ terminal_id: "agent-a", agent_status: status, name: "Agent A" }],
      },
    };
  });
  t.after(() => herdr.close());

  const token = "ExponentPushToken[transition]";
  const { status } = await postJson(`http://127.0.0.1:${port}/push/register`, { token, device: "phone" });
  assert.equal(status, 200);

  await waitFor(() => fakeExpo.requests.length >= 1);
  assert.equal(fakeExpo.requests.length, 1);
  const [message] = fakeExpo.requests[0];
  assert.equal(message.to, token);
  assert.equal(message.title, "Agent needs you");
  // JSON.stringify drops undefined-valued keys (pane_id is absent on the
  // fixture agent), so compare fields individually rather than deepEqual.
  assert.equal(message.data.terminalId, "agent-a");
  assert.equal(message.data.status, "blocked");
  assert.equal(message.data.paneId, undefined);

  await sleep(50 * 4);
  assert.equal(fakeExpo.requests.length, 1, "no further pushes once status stays blocked");
});

test("push watcher — baseline suppression: already-notify-worthy on first poll never pushes", async (t) => {
  resetPushTokenState();
  resetFakeExpo();
  const { server, port, config } = await startTestServer({
    push: { enabled: true, pollMs: 50, notifyOn: ["blocked", "done"] },
  });
  t.after(() => server.close());

  const herdr = await startFakeHerdr(config.herdrSocket, (request) => {
    if (request.method !== "agent.list") {
      return { id: request.id, result: {} };
    }
    return {
      id: request.id,
      result: {
        agents: [{ terminal_id: "agent-a", agent_status: "blocked", name: "Agent A" }],
      },
    };
  });
  t.after(() => herdr.close());

  await postJson(`http://127.0.0.1:${port}/push/register`, {
    token: "ExponentPushToken[baseline]",
    device: "phone",
  });

  await sleep(50 * 5);
  assert.equal(fakeExpo.requests.length, 0, "restart must not replay an already-blocked status as a transition");
});

test("push watcher — prunes a token whose ticket reports DeviceNotRegistered", async (t) => {
  resetPushTokenState();
  resetFakeExpo();
  const { server, port, config } = await startTestServer({
    push: { enabled: true, pollMs: 50, notifyOn: ["blocked", "done"] },
  });
  t.after(() => server.close());

  let pollCount = 0;
  const statuses = ["working", "blocked", "done"];
  const herdr = await startFakeHerdr(config.herdrSocket, (request) => {
    if (request.method !== "agent.list") {
      return { id: request.id, result: {} };
    }
    pollCount += 1;
    const status = statuses[Math.min(pollCount - 1, statuses.length - 1)];
    return {
      id: request.id,
      result: {
        agents: [{ terminal_id: "agent-a", agent_status: status, name: "Agent A" }],
      },
    };
  });
  t.after(() => herdr.close());

  const liveToken = "ExponentPushToken[alive]";
  const deadToken = "ExponentPushToken[dead]";
  await postJson(`http://127.0.0.1:${port}/push/register`, { token: liveToken, device: "phone-1" });
  await postJson(`http://127.0.0.1:${port}/push/register`, { token: deadToken, device: "phone-2" });

  fakeExpo.setResponse([
    { status: "ok", id: "1" },
    { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
  ]);

  await waitFor(() => fakeExpo.requests.length >= 1);
  assert.equal(fakeExpo.requests[0].length, 2);

  await waitFor(() => {
    const persisted = readPersistedTokens();
    return persisted.length === 1 && persisted[0].token === liveToken;
  });

  fakeExpo.setResponse(defaultResponder);

  await waitFor(() => fakeExpo.requests.length >= 2);
  assert.equal(fakeExpo.requests[1].length, 1);
  assert.equal(fakeExpo.requests[1][0].to, liveToken);
});

test("push watcher — non-DeviceNotRegistered ticket errors do not prune", async (t) => {
  resetPushTokenState();
  resetFakeExpo();
  const { server, port, config } = await startTestServer({
    push: { enabled: true, pollMs: 50, notifyOn: ["blocked", "done"] },
  });
  t.after(() => server.close());

  let pollCount = 0;
  const herdr = await startFakeHerdr(config.herdrSocket, (request) => {
    if (request.method !== "agent.list") {
      return { id: request.id, result: {} };
    }
    pollCount += 1;
    const status = pollCount === 1 ? "working" : "blocked";
    return {
      id: request.id,
      result: {
        agents: [{ terminal_id: "agent-a", agent_status: status, name: "Agent A" }],
      },
    };
  });
  t.after(() => herdr.close());

  await postJson(`http://127.0.0.1:${port}/push/register`, {
    token: "ExponentPushToken[rate-a]",
    device: "phone-1",
  });
  await postJson(`http://127.0.0.1:${port}/push/register`, {
    token: "ExponentPushToken[rate-b]",
    device: "phone-2",
  });

  fakeExpo.setResponse([
    { status: "ok", id: "1" },
    { status: "error", message: "rate exceeded", details: { error: "MessageRateExceeded" } },
  ]);

  await waitFor(() => fakeExpo.requests.length >= 1);
  await sleep(50 * 3);
  assert.equal(readPersistedTokens().length, 2, "only DeviceNotRegistered should prune a token");
});

test("push watcher — an agent that vanishes and reappears still-notify-worthy counts as a new transition", async (t) => {
  resetPushTokenState();
  resetFakeExpo();
  const { server, port, config } = await startTestServer({
    push: { enabled: true, pollMs: 50, notifyOn: ["blocked", "done"] },
  });
  t.after(() => server.close());

  let pollCount = 0;
  const responses = [
    [{ terminal_id: "agent-a", agent_status: "working", name: "Agent A" }],
    [{ terminal_id: "agent-a", agent_status: "blocked", name: "Agent A" }],
    [],
    [{ terminal_id: "agent-a", agent_status: "blocked", name: "Agent A" }],
  ];
  const herdr = await startFakeHerdr(config.herdrSocket, (request) => {
    if (request.method !== "agent.list") {
      return { id: request.id, result: {} };
    }
    pollCount += 1;
    const agents = responses[Math.min(pollCount - 1, responses.length - 1)];
    return { id: request.id, result: { agents } };
  });
  t.after(() => herdr.close());

  await postJson(`http://127.0.0.1:${port}/push/register`, {
    token: "ExponentPushToken[reappear]",
    device: "phone",
  });

  await waitFor(() => fakeExpo.requests.length >= 2, { timeoutMs: 3000 });
  assert.equal(fakeExpo.requests.length, 2, "reappearing in a notify-worthy state after vanishing is a fresh transition");

  await sleep(50 * 4);
  assert.equal(fakeExpo.requests.length, 2, "status stays blocked afterward — no additional pushes");
});
