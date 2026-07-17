# Plan 003: Harden the WebSocket bridge — honor the upgrade `head`, cap buffer growth, enforce client masking

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a16bc22..HEAD -- lib/server.mjs`
> Plans 002/004/005 also touch `lib/server.mjs` but not the WS section
> (`handleUpgrade` through `encodeFrame`). If the WS section differs from the
> excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches the frame codec the mobile app depends on; the plan-001 WS tests are the safety net)
- **Depends on**: plans/001-test-baseline-and-ci.md
- **Category**: bug + security
- **Planned at**: commit `a16bc22`, 2026-07-17

## Why this matters

Three defects in the hand-rolled RFC6455 bridge:

1. **The upgrade `head` buffer is dropped.** Node's `upgrade` event delivers `(req, socket, head)` where `head` contains any bytes the client sent after the handshake in the same packet. The handler ignores it, so a client that pipelines its first frame with the handshake loses that frame silently — a "first request sometimes never answered" bug that is miserable to debug from the app side.
2. **Unbounded memory growth from declared frame lengths.** `decodeFrame` accepts a 64-bit declared payload length (up to 2^63). A client that declares a huge length and streams data makes `wsBuffer` grow without limit (with O(n²) re-concat per chunk on top). Same for accumulated `fragments`. The client is tailnet-authenticated so this is a robustness/defense-in-depth issue, not an open attack surface — but one buggy or malicious app build can OOM the host process.
3. **Unmasked client frames are accepted.** RFC 6455 §5.1 requires a server to fail the connection when a client frame is unmasked. Accepting them mostly matters as a protocol-conformance/robustness issue (a broken client silently "works" until it doesn't).

## Current state

All in `lib/server.mjs`. Verify excerpts against the live file (line numbers are for commit `a16bc22`; plan 002 may have shifted them slightly — the WS section itself should be byte-identical).

**Upgrade wiring (line 57)** — `head` not passed:

```js
  server.on("upgrade", (req, socket) => handleUpgrade(config, req, socket));
```

**`handleUpgrade` (lines 493–514)** ends with `bridgeWebSocket(config, socket);` — no head parameter.

**`bridgeWebSocket` (lines 516–603)** — relevant parts:

```js
function bridgeWebSocket(config, ws) {
  let wsBuffer = Buffer.alloc(0);
  let fragments = [];
  let wsOpen = true;
  const liveUnixSockets = new Set();

  const closeAll = () => {
    if (!wsOpen) {
      return;
    }
    wsOpen = false;
    try {
      ws.write(encodeFrame(0x8, Buffer.alloc(0)));
    } catch { /* already gone */ }
    ws.destroy();
    ...
  };
  ...
  ws.on("data", (data) => {
    wsBuffer = Buffer.concat([wsBuffer, data]);
    let frame = decodeFrame(wsBuffer);
    while (frame) {
      wsBuffer = wsBuffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) { closeAll(); return; }
      else if (frame.opcode === 0x9) { ws.write(encodeFrame(0xa, frame.payload)); }
      else if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
        fragments.push(frame.payload);
        if (frame.fin) { ...dispatch lines... }
      }
      frame = decodeFrame(wsBuffer);
    }
  });
```

**`decodeFrame` (lines 605–645)** — parses fin/opcode/mask/length; for length 127 does `length = Number(buffer.readBigUInt64BE(offset))`; returns `null` when the buffer doesn't yet hold the full frame; no size limits; `masked` may be false and the frame is still decoded.

**`encodeFrame` (lines 647–663)** — server frames, unmasked (correct for server→client), handles 7/16/64-bit lengths.

Close-frame convention in this codebase: bare close frame with empty payload (`encodeFrame(0x8, Buffer.alloc(0))`). RFC allows a 2-byte status code payload; this plan adds coded closes.

Plan-001 test coverage that must keep passing: handshake accept-hash, auth 401, round trip, herdr-down error line, ping/pong, multi-line frame, fragmented message, close (see `test/websocket.test.mjs`).

## Commands you will need

| Purpose      | Command                                | Expected on success |
|--------------|----------------------------------------|---------------------|
| Syntax check | `npm run check`                        | exit 0              |
| WS tests     | `node --test test/websocket.test.mjs`  | all pass            |
| Full suite   | `npm test`                             | exit 0              |

## Scope

**In scope**:
- `lib/server.mjs` — ONLY the WS section: the `server.on("upgrade", ...)` line, `handleUpgrade`, `bridgeWebSocket`, `decodeFrame`, `encodeFrame`, and new WS-related constants next to the existing ones at the top.
- `test/websocket.test.mjs`, `test/helpers.mjs`.

**Out of scope**:
- `handleHttp` and everything HTTP (plans 002/004/005).
- `dispatchRequestLine`'s herdr-socket semantics (one unix conn per line) — do not redesign; the only permitted touch is the mirror settle-guard noted in the maintenance notes of plan 002, and only if trivial.
- Any change to the NDJSON message format the app consumes.

## Git workflow

- Branch: `advisor/003-websocket-hardening`
- Commit per step; short imperative messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Honor the `head` buffer

1. Change the wiring: `server.on("upgrade", (req, socket, head) => handleUpgrade(config, req, socket, head));`
2. `handleUpgrade(config, req, socket, head)` → pass through: `bridgeWebSocket(config, socket, head);`
3. In `bridgeWebSocket(config, ws, head)`: initialize `let wsBuffer = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);` and, immediately after the listeners are attached, process it by factoring the body of the current `ws.on("data")` handler into a named `const onData = (data) => {...}` used both for the listener and one direct `onData(Buffer.alloc(0))`-style initial drain (guard `Buffer.concat` against the empty case, or simply call the shared drain function that loops `decodeFrame` over `wsBuffer`).

Regression test (`test/websocket.test.mjs`): with the raw WS client, write the handshake request and a complete masked text frame containing a request line **in a single `socket.write` call**, before reading the 101 response. Expect the herdr response frame to arrive. (This is exactly the pipelining case; against current code the frame is lost and the test times out — assert with a bounded wait.)

**Verify**: `node --test test/websocket.test.mjs` → all pass; temporarily `git stash` and confirm the new test fails against old code, then `git stash pop`.

### Step 2: Cap frame and message sizes

Add constants next to `WS_GUID` (top of file, near line 50):

```js
const WS_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024;   // per frame, declared
const WS_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;   // accumulated fragments + buffer
```

1. In `decodeFrame`, after computing `length` (both the 16-bit and 64-bit branches and the 7-bit case), if `length > WS_MAX_PAYLOAD_BYTES`, return a sentinel `{ error: "too_large" }` instead of a frame. (Returning the sentinel *before* waiting for the payload matters — the whole point is not to buffer it.)
2. In the drain loop in `bridgeWebSocket`, handle the sentinel: send a close frame with status code 1009 (message too big) and `closeAll()`. Implement coded closes as `encodeFrame(0x8, closePayload(1009))` where `closePayload(code)` returns a 2-byte big-endian buffer.
3. Also guard cumulative growth: if `wsBuffer.length > WS_MAX_MESSAGE_BYTES` or the summed length of `fragments` exceeds it, close 1009 the same way.
4. Keep the existing bare close in `closeAll` for other paths, or route it through `closePayload(1000)` — either is fine; be consistent.

Tests: (a) send a frame header declaring a 2 MiB payload (don't send the payload) → connection closes promptly (read the close frame, assert code 1009 from its payload bytes); (b) send > 4 MiB of never-FIN'd fragments of small frames → closed 1009; (c) a legitimate 100 KiB text frame still round-trips.

**Verify**: `node --test test/websocket.test.mjs` → all pass.

### Step 3: Enforce client masking

In the drain loop (or `decodeFrame` via another sentinel), when a data/continuation frame (opcode 0x0/0x1/0x2) arrives with `masked === false`, close with code 1002 (protocol error). Control frames from the client must also be masked per RFC — apply the same rule to 0x8/0x9/0xA.

Check the plan-001 raw client sends masked frames (it should — the plan required it); if any existing test sent unmasked frames, fix the test client, not the rule.

Test: send a valid-but-unmasked text frame → close frame with code 1002.

**Verify**: `node --test test/websocket.test.mjs` → all pass; `npm test` → full suite green.

## Test plan

New tests, all in `test/websocket.test.mjs` (structure modeled on the plan-001 tests already there): pipelined head frame answered; oversized declared frame → 1009 close without buffering; fragment-flood → 1009; unmasked frame → 1002; large-but-legal frame OK. Verification: `npm test` → all pass, ≥ 5 new tests.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `npm test` exits 0; new tests listed above exist; the Step 1 test fails against pre-fix code (spot-checked via `git stash`)
- [ ] `grep -n "WS_MAX_PAYLOAD_BYTES" lib/server.mjs` → constant defined and used in `decodeFrame`
- [ ] `grep -n "head" lib/server.mjs` shows head flowing `upgrade → handleUpgrade → bridgeWebSocket`
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The WS section differs from the excerpts (drift beyond plans 002/004/005's expected non-overlapping edits).
- The outridr mobile app is known (per operator note or repo docs) to send frames > 1 MiB — the caps would break it; report and ask for sizing guidance instead of guessing. (Requests are NDJSON commands; 1 MiB should be generous — but confirm rather than assume if any test or doc contradicts it.)
- Enforcing masking breaks the plan-001 round-trip test and the cause is the server rather than the test client.
- You find yourself modifying `dispatchRequestLine`'s connection-per-line model.

## Maintenance notes

- If the app ever needs to *upload* large payloads over WS (it shouldn't — big data flows via `GET /session` windows), `WS_MAX_PAYLOAD_BYTES` is the knob; revisit the O(n²) `Buffer.concat` pattern at the same time (a chunk-list with lazy concat) — deliberately not done now because the caps bound the cost.
- Reviewer should scrutinize the sentinel handling in the drain loop: a `{error}` return must always terminate the loop (no `continue`), or a malformed client could spin it.
- Deferred: permessage-deflate, binary-frame semantics (currently treated as text), Sec-WebSocket-Version negotiation — all unnecessary for the single first-party client.
