# Plan 022: WS connection cap + idle timeout, startup rejection handling, token masking

> **Executor instructions**: Follow step by step. Run every verification
> command and confirm the expected result before moving on. STOP conditions
> halt you. Update this plan's row in `plans/README.md` when done unless a
> reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 68bc404..HEAD -- lib/websocket.mjs lib/server.mjs bin/outridr.mjs test/`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: security + dx
- **Planned at**: commit `68bc404`, 2026-07-20 (three residual items from a
  fresh cold-context security re-audit; the audit's other findings were
  already fixed in plans 015/018/019)

## Why this matters

Three small, independent hardening items a thorough security re-audit surfaced
after the main batch:

1. **No cap on concurrent WebSocket connections, and no idle timeout.**
   `MAX_INFLIGHT_UNIX` (`lib/websocket.mjs:19`) caps unix sockets *per* WS, but
   nothing limits the *number* of simultaneous WS connections or reaps idle
   ones. One tailnet peer can open many connections and hold herdr file
   descriptors open indefinitely (N connections × 64 unix sockets each). This
   is the last unbounded resource on the most sensitive surface.
2. **The startup promise chain is uncaught.** `lib/server.mjs:78`,
   `resolveHost(config.host).then((host) => { assertBindAllowed(...); server.listen(...); })`,
   has no `.catch`, and there is no global `unhandledRejection`/`uncaughtException`
   handler. A throw during async startup becomes an unhandled rejection with
   default crash semantics and no logged context.
3. **`outridr config` prints the token in cleartext.** `bin/outridr.mjs:44`
   does `console.log(JSON.stringify(loadConfig(), null, 2))`, which includes
   `token`. A screen-share / shell-log footgun.

## Current state (verified at 68bc404)

- `lib/websocket.mjs`:
  - Caps: `WS_MAX_PAYLOAD_BYTES` / `WS_MAX_MESSAGE_BYTES` / `MAX_INFLIGHT_UNIX`
    declared near the top (lines ~13-19).
  - `handleUpgrade(config, req, socket, head)` (lines 17-54) does path/auth/
    host/origin checks, writes the 101 response, then calls
    `bridgeWebSocket(config, socket, head)`.
  - `bridgeWebSocket` (line 56+) holds per-connection state and a `closeAll`
    (lines 63-78) that is idempotent (`wsOpen` guard) and already destroys the
    ws + all unix sockets.
  - `onData` (the frame loop) is where inbound activity happens; `ws.on("data", onData)`.
- `lib/server.mjs`:
  - `server.on("upgrade", (req, socket, head) => handleUpgrade(config, req, socket, head))` (line ~55).
  - `resolveHost(config.host).then((host) => { assertBindAllowed(config, host); server.listen(...); })` at line ~78 — NO `.catch`.
  - `server.on("error", ...)` already exits non-zero on listen errors (lines ~73-76).
- `bin/outridr.mjs`:
  - `case "config": console.log(JSON.stringify(loadConfig(), null, 2)); break;` (line ~43-44).
  - `HELP` string lists subcommands; `const [command = "help"] = process.argv.slice(2);`.
  - Entry point — the natural place for a global rejection handler.
- Tests: `connectRawWs(port, path, opts)` in `test/helpers.mjs:286+` performs a
  real masked-WS handshake and returns a client with `nextFrame()`, `close()`,
  and the handshake `statusCode`. `test/websocket.test.mjs` uses it. Config/CLI
  behavior is tested via subprocess in `test/config.test.mjs` /
  `test/host.test.mjs` (spawn `node bin/...` or `loadConfig` in a child).

Conventions: zero deps, `node:test`, env-overridable knobs for testability
(e.g. `OUTRIDR_HOST_RECHECK_MS`), `outridr:`-prefixed logs, `.unref()` on
background timers so they never keep the process alive. Baseline: 107 tests
(`npm test`), `npm run check` green.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Syntax | `npm run check` | exit 0 |
| Tests | `npm test` | all pass; baseline 107 |
| One file | `node --test test/websocket.test.mjs` | all pass |

## Scope

**In scope**: `lib/websocket.mjs`, `lib/server.mjs` (startup `.catch` only),
`bin/outridr.mjs` (config masking + global handler), `README.md` (document the
two new env knobs + `--show-secrets`), `test/websocket.test.mjs`,
`test/config.test.mjs` (or a new `test/cli.test.mjs` for the config-mask test —
executor's choice, match existing subprocess style).

**Out of scope**: the frame decoder internals, auth, the host-resolution logic,
any request-routing change, new dependencies.

## Git workflow

- Branch: `advisor/022-ws-limits-startup-catch-token-mask`
- Commit per item is fine.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: WS connection cap + idle timeout

In `lib/websocket.mjs`:

```js
const WS_MAX_CONNECTIONS = Number(process.env.OUTRIDR_WS_MAX_CONNECTIONS) || 32;
const WS_IDLE_MS = Number(process.env.OUTRIDR_WS_IDLE_MS) || 10 * 60 * 1000;

let activeConnections = 0;
```

In `handleUpgrade`, AFTER the auth/host/origin checks but before writing the
101 (so a rejected client never gets upgraded), add:

```js
  if (activeConnections >= WS_MAX_CONNECTIONS) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }
```

In `bridgeWebSocket`, increment on entry and decrement exactly once when the
connection closes. Use the existing idempotent `closeAll` as the single
decrement point:

```js
  activeConnections++;
  // ... existing state ...
  const closeAll = (code) => {
    if (!wsOpen) {
      return;
    }
    wsOpen = false;
    activeConnections--;
    // ... existing teardown ...
  };
```

(The `wsOpen` guard already makes `closeAll` run its body once, so the
decrement is balanced.)

Idle timeout: arm a timer that closes the connection if no inbound frame
arrives within `WS_IDLE_MS`; reset it on each `onData` call. `.unref()` it.

```js
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => closeAll(1000), WS_IDLE_MS);
    idleTimer.unref();
  };
```

Call `resetIdle()` at the top of `onData` and once after wiring handlers; clear
it inside `closeAll` (`clearTimeout(idleTimer)`).

**Verify**: `node --test test/websocket.test.mjs` → existing tests pass (they
send frames promptly, well under the 10-min default, so the idle timer never
fires; and they open one connection at a time, under the cap).

### Step 2: Catch the startup chain + global handler

In `lib/server.mjs`, append a `.catch` to the startup chain:

```js
  resolveHost(config.host)
    .then((host) => {
      assertBindAllowed(config, host);
      server.listen(config.port, host, () => { /* ... */ });
    })
    .catch((error) => {
      console.error(`outridr: startup failed: ${error.message}`);
      process.exit(1);
    });
```

In `bin/outridr.mjs`, register a process-wide safety net near the top (after
imports, before the switch):

```js
process.on("unhandledRejection", (reason) => {
  console.error(`outridr: unhandled rejection: ${reason instanceof Error ? reason.message : reason}`);
  process.exit(1);
});
```

(Do NOT add `uncaughtException` unless you also confirm it won't swallow the
existing `process.exit(1)` fast-exit paths — a bare `unhandledRejection`
handler is the safe minimum the audit asked for.)

**Verify**: `npm run check` → exit 0; `npm test` → still 107 (no behavior
change on the happy path). If you can add a cheap subprocess test that induces
a startup rejection and asserts exit 1 + the "startup failed" message, do so in
`test/host.test.mjs` style; if not cleanly inducible, note that in your report
rather than forcing a brittle test.

### Step 3: Mask the token in `outridr config`

In `bin/outridr.mjs`, change the `config` case to redact `token` unless
`--show-secrets` is passed:

```js
  case "config": {
    const resolved = loadConfig();
    const showSecrets = process.argv.includes("--show-secrets");
    const view =
      !showSecrets && resolved.token
        ? { ...resolved, token: "<hidden — pass --show-secrets to reveal>" }
        : resolved;
    console.log(JSON.stringify(view, null, 2));
    break;
  }
```

Add `--show-secrets` to the `config` line in `HELP`.

**Verify**: `OUTRIDR_TOKEN=supersecretvalue node bin/outridr.mjs config` →
output contains `<hidden` and does NOT contain `supersecretvalue`;
`OUTRIDR_TOKEN=supersecretvalue node bin/outridr.mjs config --show-secrets` →
output DOES contain `supersecretvalue`.

### Step 4: Tests

- `test/websocket.test.mjs`:
  - **connection cap**: set `OUTRIDR_WS_MAX_CONNECTIONS=2` before starting the
    server for this test (env-before-first-import applies — start a dedicated
    server, or if the suite shares one, spawn a fresh `startTestServer` in a
    child/scoped process; match how the file already isolates env-sensitive
    tests). Open 2 WS via `connectRawWs` and keep them open, then a 3rd →
    assert its handshake does not reach 101 (the socket ends with 503 / the
    handshake fails). Close all.
  - **idle timeout**: set `OUTRIDR_WS_IDLE_MS` to a small value (e.g. 200),
    open a WS, send nothing, and assert the server closes it (nextFrame yields
    a close frame, or the socket ends) within a short deadline.
- config-mask test (in `test/config.test.mjs` or a new `test/cli.test.mjs`,
  subprocess style): the two assertions from Step 3.

**Verify**: `npm test` → all pass; state the final count (107 + new).

### Step 5: Document the knobs

In `README.md`'s tuning/testing env list, add `OUTRIDR_WS_MAX_CONNECTIONS`
(default 32) and `OUTRIDR_WS_IDLE_MS` (default 600000), and note
`outridr config` masks the token by default (`--show-secrets` to reveal).

**Verify**: `grep -c "OUTRIDR_WS_MAX_CONNECTIONS" README.md` → ≥1; `npm run check` → 0.

## Done criteria

- [ ] `npm run check` exits 0; `npm test` exits 0 with the new tests (state count)
- [ ] `grep -n "WS_MAX_CONNECTIONS" lib/websocket.mjs` → cap defined + enforced in handleUpgrade
- [ ] `grep -n "activeConnections--" lib/websocket.mjs` → exactly one decrement (in closeAll)
- [ ] `grep -n "unhandledRejection" bin/outridr.mjs` → handler present
- [ ] `grep -n "\.catch" lib/server.mjs` → the startup chain is caught
- [ ] `OUTRIDR_TOKEN=x node bin/outridr.mjs config` does not print `x`
- [ ] `git status` clean outside scope; `plans/README.md` row updated

## STOP conditions

- The connection-cap decrement can double-fire (if `closeAll` is somehow
  reachable twice past its guard) — if you can't prove exactly-once decrement,
  STOP and report rather than risking a counter that drifts negative and
  permanently blocks connections.
- Existing WS tests fail after step 1 (the idle timer or cap is interfering
  with prompt-frame tests) — the defaults (10 min, 32) should make that
  impossible; a failure means the wiring is wrong.
- Adding the `unhandledRejection` handler makes existing subprocess tests that
  assert specific exit codes/messages flaky — if so, scope the handler so it
  doesn't intercept the intended `process.exit(1)` paths, and report.

## Maintenance notes

- The two new env knobs are testability + operator tuning; keep them
  documented. Defaults (32 connections, 10-min idle) are generous for a
  single-user tool serving one app; revisit only with evidence.
- If a future multi-device story lets several phones connect at once, the
  connection cap is the knob to raise.
- `--show-secrets` is the reveal path; don't add an env var that unmasks (env
  is exactly where you don't want the reveal to be scriptable by accident).
- Deferred to a later plan (audit's "for later" tier, intentionally not here):
  adversarial fuzz tests for the RFC6455 `decodeFrame` (RSV bits, reserved
  opcodes) and Dependabot for the `github-actions` ecosystem.
