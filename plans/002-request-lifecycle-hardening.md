# Plan 002: Fix double-callback crash in herdrRequest and harden the HTTP request lifecycle

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a16bc22..HEAD -- lib/server.mjs lib/service.mjs`
> If `lib/server.mjs` changed since this plan was written (other than by plan
> 001, which does not touch it), compare the "Current state" excerpts against
> the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (small, local guards; behavior identical on happy paths)
- **Depends on**: plans/001-test-baseline-and-ci.md (regression tests land in its harness)
- **Category**: bug
- **Planned at**: commit `a16bc22`, 2026-07-17

## Why this matters

Four independent defects can crash or corrupt this long-running service, and one of them multiplies background work unboundedly:

1. **`herdrRequest` can invoke its callback more than once.** After the first response line is parsed, the `data` and `error` listeners stay armed. A late TCP chunk or an error event after success fires the callback again. In the `/health` handler that means a second `res.writeHead` → `ERR_HTTP_HEADERS_SENT` thrown inside an event handler → **process crash**. In the push watcher, each extra callback schedules an extra `setTimeout(poll)` — the poll loop **duplicates itself** and herdr gets hammered at a multiplying rate.
2. **Any synchronous throw in the request path kills the process.** `serveSessionWindow` calls `statSync`/`openSync` on a path validated earlier with `existsSync` — if the transcript is deleted between the two (Claude Code sessions get cleaned up), the request handler throws and the whole server dies.
3. **`server.listen` has no error handler.** If the port is taken (EADDRINUSE — e.g. two installs racing), the process dies with an unhandled `error` event and no actionable message.
4. **`readBody` corrupts multibyte request bodies.** `body += chunk` stringifies each Buffer chunk independently; a UTF-8 character split across chunk boundaries becomes U+FFFD, so `JSON.parse` fails and `/push/register` 400s for device names with non-ASCII characters.

Also folded in (one-liners): timing-safe token comparison, and removing the dead `serviceEntryExists` export.

## Current state

All in `lib/server.mjs` unless noted. Verify each excerpt against the live file.

**`herdrRequest` (lines 210–237)** — no settled guard:

```js
function herdrRequest(config, method, params, callback, timeoutMs = 5000) {
  const socket = connect(config.herdrSocket);
  let buffer = "";
  const timer = setTimeout(() => {
    socket.destroy();
    callback(null);
  }, timeoutMs);
  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ id: "outridr", method, params })}\n`);
  });
  socket.on("data", (data) => {
    buffer += data.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline !== -1) {
      clearTimeout(timer);
      socket.end();
      try {
        callback(JSON.parse(buffer.slice(0, newline)).result ?? null);
      } catch {
        callback(null);
      }
    }
  });
  socket.on("error", () => {
    clearTimeout(timer);
    callback(null);
  });
}
```

Failure sequences: (a) `data` with newline → callback; another `data` chunk arrives before FIN → newline still found → callback again. (b) `data` → callback; peer RSTs during `socket.end()` → `error` → callback again. (c) timeout → callback(null); `error` from the destroyed socket race → callback again.

**Callers of `herdrRequest`**: `probeHerdr` (line 239, used by `/health` handler line 107), and the push watcher `poll` (line 438) whose callback ends with `setTimeout(poll, config.push.pollMs)` (line 460).

**`handleHttp` (line 99)** — no try/catch; `serveSessionWindow` (line 275) starts:

```js
  const filePath = findSessionFile(config, sessionId);
  if (!filePath) {
    sendJson(res, 404, { error: "session transcript not found" });
    return;
  }
  const size = statSync(filePath).size;   // ← throws if file deleted since cache/existsSync
```

`findSessionFile` (line 247) caches paths in `sessionPathCache` and re-checks with `existsSync` — but the file can vanish between that check and `statSync`/`openSync` (line 299).

**`startServer` (lines 54–73)** — `server.listen(...)` with no `server.on("error", ...)`.

**`readBody` (lines 196–205)**:

```js
function readBody(req, callback) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 64 * 1024) {
      req.destroy();
    }
  });
  req.on("end", () => callback(body));
}
```

**`authorized` (lines 87–95)** — `===` comparison of the shared token (not timing-safe):

```js
  if (req.headers.authorization === `Bearer ${config.token}`) {
    return true;
  }
  return url.searchParams.get("token") === config.token;
```

**`lib/service.mjs` (lines 137–139)** — dead export, no callers anywhere in the repo:

```js
export function serviceEntryExists() {
  return existsSync(SERVE_ENTRY);
}
```

Conventions: ESM `.mjs`, named exports, no classes except `PushTokenStore`, small top-level functions, double quotes, 2-space indent. Match them.

## Commands you will need

| Purpose      | Command         | Expected on success |
|--------------|-----------------|---------------------|
| Syntax check | `npm run check` | exit 0              |
| Tests        | `npm test`      | exit 0, all pass    |

## Scope

**In scope**:
- `lib/server.mjs`
- `lib/service.mjs` (only the `serviceEntryExists` deletion)
- `test/http.test.mjs`, `test/session.test.mjs`, `test/helpers.mjs` (add regression tests/helpers)

**Out of scope**:
- The WebSocket bridge (`handleUpgrade`, `bridgeWebSocket`, frame codec) — plan 003.
- `resolveHost` / tailscale behavior — plan 004.
- Push watcher logic beyond what the herdrRequest fix touches — plan 005.
- Any change to response shapes or the herdr wire protocol.

## Git workflow

- Branch: `advisor/002-request-lifecycle`
- Commit per step; message style: short imperative header (e.g. `Guard herdrRequest against double callbacks`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Settle guard in `herdrRequest`

Rewrite `herdrRequest` so the callback can fire at most once and the socket is always cleaned up:

```js
function herdrRequest(config, method, params, callback, timeoutMs = 5000) {
  const socket = connect(config.herdrSocket);
  let buffer = "";
  let settled = false;
  const settle = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    callback(result);
  };
  const timer = setTimeout(() => settle(null), timeoutMs);
  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ id: "outridr", method, params })}\n`);
  });
  socket.on("data", (data) => {
    if (settled) {
      return;
    }
    buffer += data.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline !== -1) {
      try {
        settle(JSON.parse(buffer.slice(0, newline)).result ?? null);
      } catch {
        settle(null);
      }
    }
  });
  socket.on("error", () => settle(null));
}
```

Note `socket.destroy()` replaces `socket.end()` — herdr has already answered and closes its side anyway; destroy guarantees no further events.

**Verify**: `npm run check` → exit 0.

### Step 2: Regression test for the double callback

In `test/http.test.mjs`: a fake herdr variant that writes the response line and then immediately `socket.destroy(new Error("boom"))` (RST instead of clean close), plus a variant that writes the response line followed by a second garbage line `"trailing\n"` before closing. For each: GET `/health` → exactly one 200 response, and a subsequent `/health` still works (server did not crash). Add a helper in `test/helpers.mjs` if the fake-herdr factory needs a post-response hook.

**Verify**: `node --test test/http.test.mjs` → all pass. Then `git stash` the Step 1 change and re-run to confirm at least one of the new tests fails or crashes against the old code (`git stash pop` after). If the old code passes both, the test isn't exercising the race — tighten it (e.g. write the response in two chunks with the newline in the first) before proceeding.

### Step 3: Make the request path throw-proof

1. Wrap the body of `handleHttp` in try/catch: on catch, log `` `outridr: request failed: ${error.message}` `` and, if `!res.headersSent`, respond `sendJson(res, 500, { error: "internal error" })`; otherwise `res.destroy()`.
2. In `serveSessionWindow`, wrap the `statSync` and the open/read block in try/catch: on failure, delete the session's `sessionPathCache` entry and respond 404 `{ error: "session transcript not found" }` (the file disappeared — same user-visible meaning).
3. In `startServer`, before `server.listen`, add:

```js
  server.on("error", (error) => {
    console.error(`outridr: server error: ${error.message}`);
    process.exit(1);
  });
```

(Exit non-zero is deliberate: under systemd/launchd `Restart=on-failure`/`KeepAlive` the supervisor retries; in the foreground the user sees the message.)

**Verify**: `npm run check` → exit 0. Add tests: (a) in `test/session.test.mjs`, register a session fixture, request it once (200), delete the fixture file, request again → 404 and the server still answers `/health` afterwards; (b) in `test/http.test.mjs`, start a second server on the first server's (non-zero) port via `startServer` with that explicit port in a **subprocess** (`node -e`) and assert it exits 1 with `server error` on stderr — or, simpler and acceptable: assert the `error` listener exists by binding twice inside one subprocess. `node --test` → all pass.

### Step 4: Fix `readBody` chunk handling

Accumulate Buffers; enforce the cap in bytes; decode once:

```js
function readBody(req, callback) {
  const chunks = [];
  let total = 0;
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > 64 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => callback(Buffer.concat(chunks).toString("utf8")));
}
```

Regression test in `test/http.test.mjs`: POST `/push/register` with `device: "téléphone-📱"` sent as a raw request where the body is written in two chunks split **mid-multibyte-character** (use `net.connect` or `http.request` with two `req.write(buf.subarray(...))` calls splitting inside the emoji's bytes) → 200 and the persisted `push-tokens.json` contains the intact device string.

**Verify**: `node --test test/http.test.mjs` → all pass, including the new multibyte test failing against stashed old code (same stash technique as Step 2).

### Step 5: Timing-safe token comparison

In `authorized`, compare via sha256 digests with `timingSafeEqual` (digesting first sidesteps the equal-length requirement):

```js
import { createHash, timingSafeEqual } from "node:crypto";

function tokenMatches(provided, expected) {
  if (typeof provided !== "string") {
    return false;
  }
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
```

Use it for both the bearer header (extract the part after `"Bearer "`) and the query param. Existing auth tests from plan 001 must still pass unchanged.

**Verify**: `node --test test/http.test.mjs` → all pass (401/200 auth cases unchanged).

### Step 6: Delete the dead export

Remove `serviceEntryExists` from `lib/service.mjs` and its now-unused `existsSync` import if nothing else uses it (check: `rmSync`, `mkdirSync`, `writeFileSync` are used; `existsSync` is only used by `serviceEntryExists`).

**Verify**: `grep -rn "serviceEntryExists" bin/ lib/ test/` → no matches; `npm run check` → exit 0.

## Test plan

New tests (all listed inline in steps above): double-callback herdr fakes (RST-after-response, trailing-garbage), deleted-transcript 404 + survival, EADDRINUSE exit path, multibyte body split, auth unchanged. Model structure after the existing plan-001 tests in the same files. Verification: `npm test` → all pass, including ≥ 5 new tests.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `npm test` exits 0; the Step 2 and Step 4 regression tests exist and fail against pre-fix code (spot-checked via `git stash`)
- [ ] `grep -n "settled" lib/server.mjs` shows the guard in `herdrRequest`
- [ ] `grep -n "timingSafeEqual" lib/server.mjs` → 1+ match
- [ ] `grep -rn "serviceEntryExists" .` (excluding plans/) → no matches
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above don't match `lib/server.mjs` (drift — e.g. plan 003/004/005 landed first and touched adjacent lines; re-anchor carefully, and stop if the herdrRequest shape itself changed).
- The Step 2 test cannot be made to fail against the old code after two attempts — the race may already be fixed; report instead of shipping a vacuous test.
- Fixing anything here seems to require touching the WS bridge or push watcher logic beyond the shared `herdrRequest`.

## Maintenance notes

- `herdrRequest`'s settle pattern is the template for any future one-shot socket helper in this codebase; the WS `dispatchRequestLine` (plan 003's territory) has a milder variant of the same issue (error after data) that plan 003 should mirror-fix if it touches that function.
- Reviewer should scrutinize: that `socket.destroy()` in `settle` doesn't cut off a response that spans multiple chunks *before* the newline arrives (it can't — settle only runs after a full line or a terminal condition).
- Deferred: `/health` 500-vs-degraded semantics (herdr down still returns 200 with `herdr: null`) — intentional current behavior, left unchanged.
