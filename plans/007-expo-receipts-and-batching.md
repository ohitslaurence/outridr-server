# Plan 007: Expo push receipts polling + 100-message batching

> **Executor instructions**: Follow this plan step by step. Run every
> verification command before moving on. If a STOP condition occurs, stop and
> report. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `lib/push.mjs` must exist (plan 006 landed)
> and contain `PushTokenStore`, `startPushWatcher`, `sendExpoPush`,
> `EXPO_PUSH_URL`. If push code still lives in `lib/server.mjs`, STOP —
> plan 006 has not merged.

## Status

- **Priority**: P3 | **Effort**: M | **Risk**: LOW (additive second-phase check; worst case is a missed prune, which is today's behavior)
- **Depends on**: plans/006-split-server-modules.md
- **Category**: bug + dx
- **Planned at**: commit `8cb2c4f`, 2026-07-17

## Why this matters

Plan 005 prunes tokens that Expo rejects **synchronously** (ticket-level `DeviceNotRegistered`). But Expo's delivery model is two-phase: a ticket with `status: "ok"` only means Expo *accepted* the message — delivery can still fail at the APNs/FCM layer, and those failures (including the common uninstalled-app case) surface only via the **receipts** endpoint, typically ~15 minutes later. Without receipts polling, dead tokens that fail at the provider layer are never pruned, and Expo documents that senders who ignore receipts risk throttling/blocking. Separately, Expo caps one send request at 100 messages; today `sendExpoPush` sends all tokens in one request, which would silently break past 100 registered devices.

## Current state (lib/push.mjs, post-plan-006)

- `sendExpoPush(pushTokens, title, body, data)` builds one message per token, POSTs all in one request to `EXPO_PUSH_URL`, and in the response handler prunes on ticket-level `details.error === "DeviceNotRegistered"`, logging by device name (never the token). Successful tickets carry `{status: "ok", id: "<ticket id>"}` — **the ids are currently discarded**.
- `EXPO_PUSH_URL = new URL(process.env.OUTRIDR_EXPO_PUSH_URL ?? "https://exp.host/--/api/v2/push/send")` — read at module load; tests point it at a fake.
- `PushTokenStore` has `add`/`remove`/`count`/`all`/`#persist`.
- Test seam: `test/helpers.mjs:startFakeExpo()` — captures POST bodies in `requests`, answers with `setResponse(ticketsOrFn)`. `test/push.test.mjs` has 6 tests using it.

**Expo receipts API**: POST to `/--/api/v2/push/getReceipts` with body `{"ids": ["ticketId", ...]}` → 200 `{"data": {"<ticketId>": {"status":"ok"} | {"status":"error","message":"...","details":{"error":"DeviceNotRegistered"}}}}`. Receipts for unknown/not-yet-ready ids are simply absent from `data` — re-check later; stop tracking an id once a receipt (either status) arrives or it ages out.

## Design

1. **Derive the receipts URL from `EXPO_PUSH_URL`**: same origin, path `/--/api/v2/push/getReceipts`. For the test fake (path `/`), use `new URL("./getReceipts", EXPO_PUSH_URL)`-style resolution — simplest robust rule: replace a trailing `/send` with `/getReceipts` when present, else append `/getReceipts` to the path. Implement as a small pure function `receiptsUrl(pushUrl)` (exported for direct unit testing).
2. **Track pending tickets in memory** (no persistence — a restart dropping pending receipts is acceptable; note it in a comment): module-level array of `{ticketId, token, sentAt}` pushed from `sendExpoPush`'s ok-tickets.
3. **Check receipts on a timer** inside `startPushWatcher`: every `RECEIPT_CHECK_MS` (default 15 min, env-overridable `OUTRIDR_RECEIPT_CHECK_MS` read at module load), if pending ids exist, POST them to the receipts URL; for each returned receipt: `status:"error"` + `details.error === "DeviceNotRegistered"` → `pushTokens.remove(token)` + the same device-name prune log as plan 005; any returned receipt (ok or error) → stop tracking that id. Ids older than `RECEIPT_MAX_AGE_MS` (24 h, constant) are dropped untracked. Timer must be `unref()`d like the poll timers.
4. **Batching**: in `sendExpoPush`, chunk the messages array into groups of ≤ 100 and send one request per chunk (tickets map back per-chunk by index — keep the index→token mapping per request, not global).

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Syntax | `npm run check` | exit 0 |
| Tests | `npm test` | exit 0, all pass, exits cleanly |

## Scope

**In scope**: `lib/push.mjs`, `test/push.test.mjs`, `test/helpers.mjs` (extend `startFakeExpo` with a `/getReceipts` route capturing receipt requests and a `setReceipts(fn)` responder), `README.md` (add `OUTRIDR_RECEIPT_CHECK_MS` to env list ONLY if the README's env paragraph survives plan 009 unmerged — otherwise skip README, the reviewer will reconcile).
**Out of scope**: `lib/server.mjs` and all other modules; persisting pending tickets; any change to the send-side notification format.

## Git workflow

Branch `advisor/007-expo-receipts`; commit per logical unit; no push.

## Steps

1. **`receiptsUrl` + batching in `sendExpoPush`**: pure function + chunking. Unit-test `receiptsUrl` (send URL → `/--/api/v2/push/getReceipts`; fake URL `http://127.0.0.1:9/` → path ends `/getReceipts`). Batch test: register 3 tokens, set a chunk-size override — DO NOT add an env knob for chunk size; instead export the constant `EXPO_BATCH_LIMIT = 100` and test batching by asserting request shapes with ≤ 100 (a direct unit test of the chunk helper is fine; an integration test with 101 fake tokens is also acceptable if fast). **Verify**: `npm test` green.
2. **Ticket tracking + receipts check**: implement per Design 2–3. Tests (fake herdr transition → push → ok tickets with ids; then fake receipts responder returns `DeviceNotRegistered` for one id): with `OUTRIDR_RECEIPT_CHECK_MS=100`, assert the dead token is pruned from the persisted file and the live token survives; assert a receipt with `status:"ok"` stops re-querying (fake records receipt-request bodies — after the ok receipt, no further requests contain that id); assert `MessageRateExceeded` receipt does NOT prune. **Verify**: `node --test test/push.test.mjs` all pass; `npm test` green and exits cleanly (unref'd timer).
3. **README env mention** per scope note. **Verify**: `npm test` green.

## Done criteria

- [ ] `npm run check` exit 0; `npm test` exit 0, ≥ 3 new tests, clean exit
- [ ] `grep -n "getReceipts" lib/push.mjs test/helpers.mjs` → implementation + fake route
- [ ] `grep -n "EXPO_BATCH_LIMIT" lib/push.mjs` → constant used in chunking
- [ ] No token values in any log line (audit new console lines)
- [ ] `git diff main --stat` touches only in-scope files

## STOP conditions

- Plan 006 not merged (push code still in server.mjs).
- The receipts flow requires persisting state to survive restarts to be useful at all — that contradicts the accepted in-memory design; report rather than adding persistence.
- Test-suite clean exit requires more than `unref()` on the new timer.

## Maintenance notes

- In-memory pending tickets means receipts arriving after a restart are lost — accepted trade-off, documented in a code comment; revisit only if real deployments show dead tokens surviving.
- Reviewer: check the per-chunk index mapping (a global index across chunks would prune the wrong token).
