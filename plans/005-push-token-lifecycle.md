# Plan 005: Push token lifecycle — prune dead Expo tokens, add unregister, clean the watcher's state

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a16bc22..HEAD -- lib/server.mjs README.md`
> If the push section of `lib/server.mjs` (`PushTokenStore` through
> `sendExpoPush`, plus `startPushWatcher`) differs from the excerpts below
> beyond plan 002's `herdrRequest` change, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive endpoint + response handling; worst case is over-pruning, mitigated by only pruning on Expo's explicit `DeviceNotRegistered`)
- **Depends on**: plans/001-test-baseline-and-ci.md; plans/002-request-lifecycle-hardening.md (the fixed `herdrRequest` — watcher tests rely on single-fire callbacks)
- **Category**: bug + dx
- **Planned at**: commit `a16bc22`, 2026-07-17

## Why this matters

Push tokens only ever accumulate. `PushTokenStore` persists every registered token forever; there is no unregister endpoint, and the Expo push response — which explicitly reports dead tokens via `DeviceNotRegistered` — is discarded (`response.resume()`), so every notification is sent to every token ever seen, including phones that uninstalled the app months ago. Expo documents that repeatedly pushing to dead tokens can get a sender throttled or blocked. Separately, the watcher's `lastStatus` map keeps entries for agents that no longer exist (unbounded slow growth on a long-lived service). For general use — many users, long-lived installs — token hygiene is table stakes.

## Current state

All in `lib/server.mjs` (line numbers at commit `a16bc22`).

**`PushTokenStore` (lines 390–420)** — `add`, `count`, `all`; persistence to `join(STATE_DIR, "push-tokens.json")` as a JSON array of `{token, device, registeredAt}`; no `remove`:

```js
class PushTokenStore {
  constructor() { this.path = join(STATE_DIR, "push-tokens.json"); this.tokens = new Map(); ...load... }
  add(token, device) { this.tokens.set(token, {...}); ...persist... }
  count() { return this.tokens.size; }
  all() { return [...this.tokens.keys()]; }
}
```

**`startPushWatcher` (lines 427–464)** — polls `agent.list`; `lastStatus` map keyed by `agent.terminal_id`, entries never deleted; on notify-worthy transition calls `sendExpoPush(pushTokens.all(), title, body, data)`.

**`sendExpoPush` (lines 466–489)** — POSTs `tokens.map((to) => ({to, title, body, data, sound: "default"}))` to hardcoded `EXPO_PUSH_HOST = "exp.host"`, `EXPO_PUSH_PATH = "/--/api/v2/push/send"` (constants, lines 51–52) via `node:https`. Response body is discarded:

```js
    (response) => {
      if (response.statusCode !== 200) {
        console.error(`outridr: expo push returned ${response.statusCode}`);
      }
      response.resume();
    },
```

**Expo push API response shape** (for the handler you will write): HTTP 200 with body `{"data": [ticket, ticket, ...]}` — one ticket per message, **in the same order as the request array**. A ticket is either `{"status":"ok","id":"..."}` or `{"status":"error","message":"...","details":{"error":"DeviceNotRegistered"}}` (other `details.error` values exist — `MessageTooBig`, `MessageRateExceeded`, `InvalidCredentials`; only `DeviceNotRegistered` means the token is dead).

**`POST /push/register` handler** (`handleHttp`, lines 120–138) — the pattern to mirror for `/push/unregister`: `readBody` → `JSON.parse` → validate token against `/^(ExponentPushToken|ExpoPushToken)\[.+\]$/` → act → `sendJson`.

**`README.md`** — endpoint table (lines 37–46) lists `POST /push/register`; will gain the unregister row.

Testability constraint: `EXPO_PUSH_HOST` is hardcoded and uses `node:https` — tests can't intercept it. Step 1 makes the push URL overridable via env so tests point it at a local `http` server. `lib/server.mjs` already imports both `httpRequest` (node:http) and `httpsRequest` (node:https) at lines 39–40 — `httpRequest` is currently unused-except-imported, so no new imports are needed.

## Commands you will need

| Purpose      | Command         | Expected on success |
|--------------|-----------------|---------------------|
| Syntax check | `npm run check` | exit 0              |
| Tests        | `npm test`      | exit 0              |

## Scope

**In scope**:
- `lib/server.mjs` — push section only: constants, `PushTokenStore`, `startPushWatcher`, `sendExpoPush`, and the `/push/*` routes in `handleHttp`.
- `test/push.test.mjs` (create), `test/helpers.mjs` (fake Expo helper).
- `README.md` — endpoint table row + config note.

**Out of scope**:
- Session/WS/exec/repos code paths.
- Expo *receipts* API (the second-phase check of ticket ids) — deferred; `DeviceNotRegistered` arrives in tickets too and covers the pruning need.
- Any change to the notification content/format the app parses (`data: {terminalId, paneId, status}` stays exactly as is).

## Git workflow

- Branch: `advisor/005-push-token-lifecycle`
- Commit per step; short imperative messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make the Expo endpoint overridable (test seam)

Replace the two constants with one URL resolved at module load:

```js
const EXPO_PUSH_URL = new URL(process.env.OUTRIDR_EXPO_PUSH_URL ?? "https://exp.host/--/api/v2/push/send");
```

In `sendExpoPush`, choose the transport by protocol (`EXPO_PUSH_URL.protocol === "https:" ? httpsRequest : httpRequest`) and pass `{host: EXPO_PUSH_URL.hostname, port: EXPO_PUSH_URL.port || undefined, path: EXPO_PUSH_URL.pathname, ...}`. Default behavior is byte-identical to today.

**Verify**: `npm run check` → exit 0; `npm test` → existing suite green.

### Step 2: Parse tickets and prune `DeviceNotRegistered`

1. Add `remove(token)` to `PushTokenStore`: delete from the map and persist (reuse the same try/catch-persist block as `add`; factor a private `#persist()` if cleaner).
2. `sendExpoPush` gains a `pushTokens` store parameter (change the call site in `startPushWatcher` from `sendExpoPush(pushTokens.all(), ...)` to `sendExpoPush(pushTokens, ...)` and take `.all()` inside, so ticket order can be mapped back to tokens).
3. In the response handler: collect the body (`data` events into chunks, `end` → `JSON.parse`), and for each ticket with `status === "error"`: log `` `outridr: expo push error for token: ${ticket.details?.error ?? ticket.message}` `` (do NOT log the token value — it's a capability); if `ticket.details?.error === "DeviceNotRegistered"`, call `pushTokens.remove(<token at same index>)` and log that a dead token was pruned (log the device name from the store entry, not the token).
4. Malformed/absent body → keep today's behavior (status-code log only); never throw from the handler.

**Verify**: `npm run check` → exit 0.

### Step 3: `POST /push/unregister`

Mirror the register handler: validate the token format the same way; `pushTokens.remove(token)` (idempotent — removing an unknown token still returns ok); respond `sendJson(res, 200, { ok: true, registered: pushTokens.count() })`. Add the route directly below `/push/register` in `handleHttp`.

Update `README.md`: add `| POST /push/unregister | Remove a previously registered push token. |` to the endpoint table, and mention `OUTRIDR_EXPO_PUSH_URL` only if the README documents other env vars' style permits (it lists env overrides at lines 70–71 — append it there).

**Verify**: `npm run check` → exit 0.

### Step 4: Clean `lastStatus` for vanished agents

In `startPushWatcher`'s poll callback, after processing `agents`, drop stale keys:

```js
        const liveIds = new Set(agents.map((agent) => agent.terminal_id));
        for (const id of lastStatus.keys()) {
          if (!liveIds.has(id)) {
            lastStatus.delete(id);
          }
        }
```

Place it inside the `if (result)` block (a failed poll must not wipe the baseline — otherwise every herdr hiccup would suppress the next real transition… actually worse, re-notify: keep state untouched on `result == null`).

**Verify**: `npm run check` → exit 0.

### Step 5: Tests (`test/push.test.mjs`)

Helper: `startFakeExpo()` in `test/helpers.mjs` — a local `node:http` server capturing POST bodies and responding with a configurable ticket array; returns `{url, requests, setResponse, close}`. Tests set `process.env.OUTRIDR_EXPO_PUSH_URL = url` **before** importing `lib/server.mjs` (same import-time-env pattern as `OUTRIDR_STATE_DIR` — see `test/helpers.mjs` header from plan 001). Watcher tests use a fake herdr whose `agent.list` response is swappable between polls, `push: {enabled: true, pollMs: 50, notifyOn: ["blocked","done"]}`.

1. **Unregister**: register a token (200, registered 1) → unregister it (200, registered 0) → `push-tokens.json` no longer contains it; unregistering again → still 200.
2. **Transition pushes once**: fake herdr returns agent A `working` on poll 1 (baseline), `blocked` on poll 2 → exactly one Expo request whose body has the registered token, title `Agent needs you`, `data.terminalId` = A; poll 3 still `blocked` → no further request.
3. **Baseline suppression**: agent already `blocked` on the very first poll → no push (restart must not replay).
4. **Prune on DeviceNotRegistered**: two tokens registered; fake Expo responds `[{status:"ok",id:"1"},{status:"error",message:"x",details:{error:"DeviceNotRegistered"}}]` → after the push settles, store count is 1 and the persisted file lacks the second token; next transition pushes to 1 token only.
5. **Other ticket errors don't prune**: response with `details.error: "MessageRateExceeded"` → count unchanged.
6. **lastStatus cleanup** (observable indirectly): agent A `blocked` (poll 2, push sent) → A absent from poll 3 → A returns `blocked` on poll 4 → a **second** push is sent (fresh baseline for a re-appearing agent is a transition from unknown… wait — no: `previous === undefined` and `baselined === true`, so `!baselined || previous === agent.agent_status` → `previous(undefined) !== "blocked"` → notify fires). Assert exactly that: re-appearing already-blocked agent notifies once. This pins the chosen semantics; if the assertion feels wrong to a reviewer, that's a semantics discussion for the maintainer — the test documents current-design-after-cleanup.

Every test closes servers, watchers (close the outridr server to stop timers — note `startPushWatcher`'s `setTimeout` chain keeps the process alive; call `server.close()` and use `t.after`; if the poll timer keeps node alive after tests, `unref()` the watcher's timers as part of this plan — an allowed one-line adjustment in `startPushWatcher`).

**Verify**: `node --test test/push.test.mjs` → all pass; `npm test` → full suite green, no hanging process (the run terminates without `--test-force-exit`).

## Test plan

The six tests in Step 5. Pattern: fake-server helpers as in plan 001 (`startFakeHerdr`), env-before-import as `OUTRIDR_STATE_DIR`. Verification: `npm test` → all pass, ≥ 6 new tests, suite exits cleanly.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `npm test` exits 0 and terminates without force-exit flags
- [ ] `grep -n "DeviceNotRegistered" lib/server.mjs` → prune path present
- [ ] `grep -n "push/unregister" lib/server.mjs README.md` → route + doc present
- [ ] `grep -n "OUTRIDR_EXPO_PUSH_URL" lib/server.mjs README.md` → seam + doc present
- [ ] No raw push-token values logged anywhere: inspect the new `console.error` lines
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The push section differs from the excerpts (drift beyond plan 002's `herdrRequest` change).
- Expo's documented ticket ordering (same order as request messages) appears not to hold in any reference you consult — index-based token mapping would be unsafe; report instead of guessing a correlation.
- Making the test suite exit cleanly requires more than `unref()`ing the watcher's timers.
- Test 6's re-appearing-agent semantics assertion fails in a way that suggests the cleanup changed notification behavior beyond the documented case.

## Maintenance notes

- Deferred: Expo **receipts** polling (tickets can succeed while delivery later fails; receipts carry late `DeviceNotRegistered`s). The ticket-level pruning here catches the common case; receipts need persisted ticket ids + a delayed check — a future plan if dead tokens still accumulate.
- Deferred: batching >100 messages per Expo request (Expo's documented cap). Irrelevant at personal scale; revisit if a deployment ever has ≥100 registered devices.
- Reviewer should scrutinize: that `sendExpoPush`'s new signature change updated its only call site, and that no log line includes a token value.
- The app team should adopt `POST /push/unregister` on sign-out/uninstall flows.
