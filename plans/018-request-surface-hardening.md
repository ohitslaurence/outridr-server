# Plan 018: Harden the request surface (Origin/Host validation, crash fixes, resource caps)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> any STOP condition occurs, stop and report — do not improvise. When done,
> update this plan's row in `plans/README.md` — unless a reviewer dispatched
> you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3488f44..HEAD -- lib/server.mjs lib/websocket.mjs lib/http-util.mjs lib/push.mjs test/`
> Plan 015 may land before this plan and is EXPECTED drift in `lib/server.mjs`
> (a bind guard near `resolveHost`) and `lib/config.mjs` — proceed if that is
> the only drift and the excerpts below still match their sections. Any other
> mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 015 (soft — merge order only; disjoint code sections)
- **Category**: security
- **Planned at**: commit `3488f44` (v0.4.1), 2026-07-20 (findings from an
  independent cold-context security audit of the public repo)

## Why this matters

Four verified findings from a cold security audit, in descending severity:

1. **Browser-originated connections bypass the tailnet perimeter.** WebSocket
   connections are not subject to the same-origin policy: a malicious webpage
   open in a browser on ANY tailnet device (including the dev machine) can do
   `new WebSocket("ws://100.x.y.z:8674/herdr")` and, on a tokenless server,
   drive herdr — start agents, create worktrees, arbitrary code execution by
   proxy. Plain HTTP endpoints are similarly reachable via DNS rebinding
   because the `Host` header is never validated. Native apps send no `Origin`
   header, so rejecting browser-origin upgrades costs the real client nothing.
2. **An authenticated request can crash the server.** `PUT /repos/roots`
   calls `saveRepoRoots(...).then(...)` with no `.catch`; the FS writes
   inside `saveRepoRoots` (`mkdir`/`writeFile`/`chmod`/`rename`,
   `lib/config-write.mjs:78-82`) are un-try/caught, so ENOSPC/EACCES rejects
   and Node's default unhandled-rejection behavior kills the process.
3. **`readBody` mishandles errors and over-limit bodies**: no `error`
   listener (an aborted upload raises an unhandled `'error'` event), and the
   >64 KiB path destroys the socket without responding (a 413 is correct).
4. **Unbounded growth**: any tokenless tailnet peer can grow the persisted
   push-token store without limit, and each WS text line opens a fresh unix
   connection with no in-flight cap (thousands of tiny lines in one 4 MB
   message → thousands of simultaneous sockets).

Also in scope, from the same audit: scope `?token=` query auth to the WS
upgrade only (its actual purpose) so the shared secret stops being accepted
in URLs on every HTTP endpoint, where it leaks into logs and histories.

## Current state

All excerpts verified at `3488f44`.

- `lib/websocket.mjs:17-38` (`handleUpgrade`) — checks only path + token:

  ```js
  export function handleUpgrade(config, req, socket, head) {
    const url = new URL(req.url ?? "/", "http://outridr");
    if (url.pathname !== "/herdr" || !authorized(config, req, url)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const key = req.headers["sec-websocket-key"];
  ```

- `lib/server.mjs:152-157` (`handleHttpUnsafe`) — no Host validation:

  ```js
  function handleHttpUnsafe(config, pushTokens, req, res) {
    const url = new URL(req.url ?? "/", "http://outridr");
    if (!authorized(config, req, url)) {
      res.writeHead(401).end("unauthorized");
      return;
    }
  ```

- `lib/server.mjs:244` — the un-caught promise chain:

  ```js
      saveRepoRoots(config, rawRoots).then((result) => {
  ```

- `lib/http-util.mjs:34-46` — `readBody` as described:

  ```js
  export function readBody(req, callback) {
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

- `lib/http-util.mjs:16-27` (`authorized`) — accepts Bearer OR `?token=` for
  everything; both HTTP routing and the WS upgrade call this one function.
- `lib/push.mjs:63-102` (`PushTokenStore`) — `add()` has no size cap.
- `lib/websocket.mjs:70-99` (`dispatchRequestLine`) — one unix connect per
  line, tracked in `liveUnixSockets`, no cap.
- `lib/server.mjs` route context: `PUT /repos/roots` handler spans lines
  226-257; push register/unregister at 173-211.

Conventions: zero dependencies, `node:test` integration tests through a real
server (`startTestServer` in `test/helpers.mjs`), raw-socket WS client
(`connectRawWs`, `test/helpers.mjs:286+`), fail-fast comments explain *why*.
Baseline: 83 tests green (`npm test`), `npm run check` green. If plan 015
landed first, its 6 tests make the baseline 89 — record the number you
observe before starting and use it in the done criteria below.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Syntax | `npm run check` | exit 0 |
| Tests | `npm test` | all pass; note baseline count |
| One file | `node --test test/websocket.test.mjs` | all pass |

## Scope

**In scope**: `lib/server.mjs` (routing sections only), `lib/websocket.mjs`,
`lib/http-util.mjs`, `lib/push.mjs` (store cap only), `README.md` (auth
paragraph only), and test files `test/http.test.mjs`,
`test/websocket.test.mjs`, `test/push.test.mjs`.

**Out of scope**: `resolveHost`/bind-guard territory in `lib/server.mjs`
(plan 015's), `lib/config-write.mjs` internals (the `.catch` wraps the call
site instead — do not restructure the module), `lib/session.mjs`,
`lib/herdr.mjs`, workflows, any new dependency (hard rule).

## Git workflow

- Branch: `advisor/018-request-surface-hardening`
- Imperative commit summaries; one commit per step or one overall.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Reject browser-origin WebSocket upgrades

In `lib/websocket.mjs` `handleUpgrade`, after the path/auth check, add:

```js
  // Browsers always send Origin on WS upgrades; the outridr app (a native
  // client) never does. WS is not subject to the same-origin policy, so a
  // malicious webpage on any tailnet device could otherwise open a socket
  // to this server and drive herdr. No legitimate client loses anything.
  if (typeof req.headers.origin === "string") {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
```

**Verify**: `node --test test/websocket.test.mjs` → existing tests pass
(`connectRawWs` sends no Origin header — confirm by reading its request
headers at `test/helpers.mjs:328-338`; if it did, this step would break every
WS test, which is a STOP signal that the analysis is wrong).

### Step 2: Validate the Host header on HTTP requests

In `lib/server.mjs`, give `handleHttpUnsafe` a Host check before `authorized`:

```js
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(421).end("misdirected request");
    return;
  }
```

with, at module scope:

```js
// DNS-rebinding guard: a hostile page can point its own domain's DNS at this
// server's address; the browser then sends that domain in Host. Accepting
// only IP-literal/localhost/tailnet-style hosts (with optional :port) breaks
// the technique without maintaining an allowlist of the machine's names.
function hostAllowed(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 255) {
    return false;
  }
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (name === "localhost" || /^[0-9a-f:.]+$/.test(name)) {
    return true; // IPv4/IPv6 literals and localhost
  }
  return /\.ts\.net$/.test(name); // Tailscale MagicDNS names
}
```

Apply the same check in `handleUpgrade` (`lib/websocket.mjs`), before the
Origin check, ending the socket with `HTTP/1.1 421 Misdirected Request`.

Note: Node's HTTP client and the fetch API always send Host as `IP:port` for
IP-literal URLs, so every existing test (they connect via `127.0.0.1`) passes
this check — a failure here means the regex is wrong, not the tests.

**Verify**: `npm test` → all pass. Then add the step-6 tests for the negative
cases.

### Step 3: Catch the /repos/roots promise chain

In `lib/server.mjs`, append to the `saveRepoRoots(...).then(...)` chain
(line 244 area) a final:

```js
        .catch((error) => {
          console.error(`outridr: repos.roots write failed: ${error.message}`);
          sendJson(res, 500, { error: "config-write-failed" });
        });
```

Make sure the inner `repoCache.get(...)` chain inside the success branch is
also covered (it already has its own `.catch` for the scan; the new outer
catch covers the FS writes).

**Verify**: `npm run check` → exit 0.

### Step 4: Fix readBody error handling and the over-limit response

Replace `readBody` in `lib/http-util.mjs`:

```js
export function readBody(req, callback) {
  const chunks = [];
  let total = 0;
  let done = false;
  req.on("data", (chunk) => {
    if (done) {
      return;
    }
    total += chunk.length;
    if (total > 64 * 1024) {
      done = true;
      chunks.length = 0;
      // Respond before dropping the connection; destroying first would
      // discard the pending write and the client only sees a reset.
      if (req.res && !req.res.headersSent) {
        req.res.writeHead(413, { connection: "close" });
        req.res.end("body too large", () => req.destroy());
      } else {
        req.destroy();
      }
    } else {
      chunks.push(chunk);
    }
  });
  req.on("error", () => {
    done = true;
  });
  req.on("end", () => {
    if (!done) {
      callback(Buffer.concat(chunks).toString("utf8"));
    }
  });
}
```

(`req.res` is the paired ServerResponse Node attaches to IncomingMessage on
server requests; if the executor finds it unavailable in this Node version,
change `readBody`'s signature to `readBody(req, res, callback)` and update
the five call sites in `lib/server.mjs` instead — both shapes are acceptable,
the response-before-destroy behavior is the requirement.)

**Verify**: `npm test` → all pass; step-6 adds the 413 test.

### Step 5: Resource caps

- `lib/push.mjs` `PushTokenStore.add`: before inserting a NEW token (not an
  update of an existing one), if `this.tokens.size >= 50`, evict the oldest
  entry by `registeredAt` and log
  `outridr: push token cap reached; evicted oldest`. Cap as a module const
  `MAX_PUSH_TOKENS = 50`.
- `lib/websocket.mjs` `bridgeWebSocket`: in `dispatchRequestLine`, if
  `liveUnixSockets.size >= 64`, do not connect; send back
  `{id, error: {code: "outridr_busy", message: "too many in-flight requests"}}`
  the same way the existing unix-error path does (reuse its id-parsing).
  Cap as `MAX_INFLIGHT_UNIX = 64`.

**Verify**: `npm run check` → exit 0; tests in step 6.

### Step 6: Scope ?token= to the WS upgrade only

In `lib/http-util.mjs`, split `authorized` into:

```js
export function authorized(config, req) { /* Bearer-only check */ }
export function authorizedUpgrade(config, req, url) { /* Bearer OR ?token= */ }
```

`lib/server.mjs` calls `authorized(config, req)`; `lib/websocket.mjs` calls
`authorizedUpgrade(config, req, url)`. Keep the timing-safe compare exactly
as is. Update the README's `token` bullet (Configuration section) to say the
query form is honored only on the WebSocket upgrade, with headers everywhere
else.

**Verify**: `npm test` → the two existing token tests
(`test/http.test.mjs:124` area and `test/websocket.test.mjs:29` area) — the
HTTP one may assert `?token=` works on an HTTP route; if so, UPDATE that
test to assert it now returns 401 (this is the intended behavior change; note
it in your report), and keep the WS `?token=` test passing as-is.

### Step 7: Tests

Add, following each file's existing patterns:

- `test/websocket.test.mjs`: upgrade with an `Origin: https://evil.example`
  header → connection rejected (403, no 101); upgrade with `Host: evil.example`
  → 421; a WS message of 100 one-char request lines against a fake herdr →
  all lines answered eventually with no protocol error (exercises the
  in-flight cap without asserting internals).
- `test/http.test.mjs`: request with `Host: evil.example` → 421; a >64 KiB
  POST body to `/push/register` → 413 (raw-socket client per the pattern in
  plan 015's oversize test if fetch races the response; a plain fetch is fine
  if it observes the 413 reliably); `?token=` on an HTTP route with token
  configured → 401 while `Authorization: Bearer` → 200.
- `test/push.test.mjs`: registering 51 distinct tokens → `count()` is 50 and
  the first-registered token is gone.

**Verify**: `npm test` → all pass, total = baseline + 7 (or +6 if the
`?token=` HTTP test replaces an existing assertion rather than adding one —
state the arithmetic you observed in your report).

## Done criteria

- [ ] `npm run check` exits 0; `npm test` exits 0 with baseline + new tests
      all green (state the numbers)
- [ ] `grep -n "origin" lib/websocket.mjs` shows the Origin rejection
- [ ] `grep -n "hostAllowed" lib/server.mjs lib/websocket.mjs` → both wired
- [ ] `grep -n "catch" lib/server.mjs` shows the repos/roots chain caught
- [ ] `grep -cn "searchParams.get(\"token\")" lib/http-util.mjs` → appears
      only in the upgrade-path function
- [ ] `git status` clean outside the in-scope list
- [ ] `plans/README.md` row updated

## STOP conditions

- Existing WS tests fail after step 1 (would mean `connectRawWs` sends an
  Origin header and the native-app assumption needs rechecking).
- Existing tests fail after step 2's Host check (would mean Node's client
  sends an unexpected Host form — report the observed value).
- The `req.res` pairing in step 4 is unavailable AND threading `res` through
  breaks more than the five known call sites.
- Any fix seems to require touching `lib/config-write.mjs` or plan 015's
  guard territory.

## Maintenance notes

- The Host allowlist admits any `*.ts.net` name; if the operator uses a
  custom MagicDNS suffix or plain non-Tailscale DNS names, they need a config
  escape hatch — deliberately deferred until someone actually hits it.
- The Origin rejection means a future WEB client for outridr would need a
  deliberate carve-out (checked allowlist), not a revert.
- `?token=` scoping is a breaking change for any script that used query
  tokens on HTTP routes; release notes must say "use Authorization: Bearer".
- Caps (50 tokens, 64 in-flight) are generous for a personal tool; revisit
  only with evidence.
