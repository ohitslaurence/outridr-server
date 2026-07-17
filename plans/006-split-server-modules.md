# Plan 006: Split lib/server.mjs (850 lines) into focused modules

> **Executor instructions**: Follow this plan step by step. Run every
> verification command before moving on. If a STOP condition occurs, stop and
> report. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: HEAD must contain commit `8ee9519` (plans
> 001–005 merged; 59 passing tests). `wc -l lib/server.mjs` ≈ 850.

## Status

- **Priority**: P2 | **Effort**: M | **Risk**: MED (pure mechanical move — the 59-test integration suite is the safety net; behavior must not change)
- **Depends on**: none (plans 001–005 merged)
- **Category**: tech-debt
- **Planned at**: commit `8cb2c4f`, 2026-07-17

## Why this matters

`lib/server.mjs` holds five unrelated concerns (HTTP routing, session transcript windowing, herdr socket client, push notifications, a WebSocket implementation) in one 850-line file. For a public plugin whose adoption depends on people reading the code and trusting it, focused modules are the difference between "I skimmed it, looks legit" and "850 lines, closed the tab." The integration tests were deliberately written against HTTP/WS surfaces so this split is mechanical and verifiable.

## Current state

`lib/server.mjs` structure (section markers at lines 135, 281, 322, 481, 630):

| Lines (approx) | Symbols |
|---|---|
| 46–57 | constants: `SESSION_TAIL_BYTES`, `SESSION_CHUNK_BYTES`, `EXEC_TIMEOUT_MS`, `MAX_EXEC_ARGS`, `WS_GUID`, `WS_MAX_PAYLOAD_BYTES`, `WS_MAX_MESSAGE_BYTES`, `EXPO_PUSH_URL`, `HOST_RESOLVE_ATTEMPTS`, `HOST_RESOLVE_DELAY_MS` |
| 59–83 | `startServer` (export), wires routes + upgrade + push watcher, deferred listen |
| 85–111 | `resolveHost` (async, retry/exit) |
| 113–133 | `tokenMatches`, `authorized` |
| 137–279 | `handleHttp`/`handleHttpUnsafe` (routes: /health, /session, /push/register, /push/unregister, /repos, /exec), `sendJson`, `readBody` |
| 284–320 | `herdrRequest` (settle-guarded), `probeHerdr` |
| 326–479 | `sessionPathCache`, `findSessionFile`, `serveSessionWindow`, `nextNewlineOffset` |
| 483–628 | `PushTokenStore` (class, `#persist`), `startPushWatcher`, `sendExpoPush` |
| 632–850 | `handleUpgrade`, `bridgeWebSocket`, `closePayload`, `decodeFrame`, `encodeFrame` |

Only `startServer` is exported. `STATE_DIR` is imported from `./config.mjs`. Tests import only `startServer` (dynamically, via `test/helpers.mjs:startTestServer`) plus `lib/config.mjs` exports — **no test imports internals**, so the split must not change any test file.

Env-read-at-import-time contract (tests depend on it): `EXPO_PUSH_URL` reads `OUTRIDR_EXPO_PUSH_URL` and the HOST_RESOLVE constants read their env vars at module load. After the split these reads happen in the new modules, which `lib/server.mjs` imports — the contract holds as long as the reads stay at module top level. Do not convert them to lazy reads.

## Target layout

Each new module keeps its code **byte-identical** where possible (move, don't rewrite), with a short `/** ... */` header comment explaining its role (mirror the tone of the existing file headers):

- `lib/http-util.mjs` — `authorized`, `tokenMatches` (private, not exported), `sendJson`, `readBody`. Exports: `authorized`, `sendJson`, `readBody`.
- `lib/herdr.mjs` — `herdrRequest`, `probeHerdr`. Exports both.
- `lib/session.mjs` — `SESSION_TAIL_BYTES`, `SESSION_CHUNK_BYTES`, `sessionPathCache`, `findSessionFile`, `serveSessionWindow`, `nextNewlineOffset`. Exports: `serveSessionWindow` only. Imports `sendJson` from `./http-util.mjs`.
- `lib/push.mjs` — `EXPO_PUSH_URL`, `PushTokenStore`, `startPushWatcher`, `sendExpoPush` (internal). Exports: `PushTokenStore`, `startPushWatcher`. Imports `herdrRequest` from `./herdr.mjs`, `STATE_DIR` from `./config.mjs`.
- `lib/websocket.mjs` — `WS_GUID`, `WS_MAX_PAYLOAD_BYTES`, `WS_MAX_MESSAGE_BYTES`, `handleUpgrade`, `bridgeWebSocket` (internal), `closePayload`, `decodeFrame`, `encodeFrame` (all internal except `handleUpgrade`). Exports: `handleUpgrade`. Imports `authorized` from `./http-util.mjs`.
- `lib/server.mjs` (remains) — `EXEC_TIMEOUT_MS`, `MAX_EXEC_ARGS`, `HOST_RESOLVE_*`, `startServer`, `resolveHost`, `handleHttp`, `handleHttpUnsafe`. Imports from the five modules above. Keeps its top-of-file overview comment (trim the parts that moved with their sections).

Each moved section's existing `/** */` doc comments move with it. Move each import to the module that uses it; remove now-unused imports from server.mjs. No circular imports in this layout (verify: `http-util` and `herdr` import nothing local except possibly config; `session`/`push`/`websocket` import only `http-util`/`herdr`/`config`; `server` imports all).

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Syntax | `npm run check` | exit 0 |
| Tests | `npm test` | exit 0, 59/59 |

## Scope

**In scope**: `lib/server.mjs`, the five new `lib/*.mjs` files, `package.json` (extend the `check` script to cover the new files).
**Out of scope**: every test file (zero changes — this is the proof of a clean split), `lib/config.mjs`, `lib/service.mjs`, `bin/outridr.mjs`, `README.md` (plan 009 documents layout), any behavior change however small.

## Git workflow

Branch `advisor/006-split-server-modules`; one commit per extracted module is ideal (each commit keeps `npm test` green), or a single commit if intermediate states can't stay green; short imperative messages. No push.

## Steps

1. **Extract `lib/http-util.mjs`** (authorized/tokenMatches/sendJson/readBody + their imports: `createHash`, `timingSafeEqual`). server.mjs imports them. **Verify**: `npm run check && npm test` → 59/59.
2. **Extract `lib/herdr.mjs`**. **Verify**: same.
3. **Extract `lib/session.mjs`**. **Verify**: same.
4. **Extract `lib/push.mjs`**. **Verify**: same (push tests prove the env-at-import contract held).
5. **Extract `lib/websocket.mjs`**. **Verify**: same.
6. **Tidy `lib/server.mjs`**: trim the header comment to routing/startup concerns with one line pointing at the module layout; confirm no unused imports remain (`npm run check` catches syntax only — grep each remaining import specifier for use). Update `package.json` `check` to include all six lib files + bin. **Verify**: `npm run check && npm test` → 59/59; `wc -l lib/*.mjs` shows server.mjs ≈ 300 or less and no module > 300.

## Done criteria

- [ ] `npm run check` exits 0 and covers all `lib/*.mjs` + `bin/outridr.mjs`
- [ ] `npm test` exits 0, 59/59 — with `git diff --stat` showing **zero test-file changes**
- [ ] `git diff main --stat` touches only `lib/*.mjs` and `package.json`
- [ ] No module exceeds ~350 lines (`wc -l lib/*.mjs`)
- [ ] `grep -n "export" lib/*.mjs` matches the export lists in "Target layout" exactly — no extra exports "for testing"

## STOP conditions

- Any test needs editing to pass — the split changed behavior; stop.
- A circular-import runtime error (ESM TDZ) appears — stop and report the cycle rather than restructuring beyond the target layout.
- You find yourself rewriting logic instead of moving it.

## Maintenance notes

- Future plans (007 receipts → `lib/push.mjs`; 008 tailscale watch → `lib/server.mjs`, service polish → `lib/service.mjs`) assume this layout.
- Reviewer: diff each moved block against the original (`git diff --color-moved=dimmed-zebra`) to confirm move-not-rewrite.
