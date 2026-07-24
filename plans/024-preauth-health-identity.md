# Plan 024: /health answers pre-auth with an identity payload

## Status

- **Priority**: P1 (blocks the app's onboarding diagnostic ladder)
- **Effort**: S
- **Risk**: LOW–MED (deliberate change to the pre-auth surface; documented
  below and in SECURITY.md)
- **Depends on**: none
- **Category**: feature (client onboarding support)
- **Planned at**: commit `f3c9d39` (v0.5.6), 2026-07-24

## Why this matters

The outridr app is growing a guided onboarding flow that diagnoses exactly
where a first connection fails: host unreachable → something answered but it
is not outridr → outridr found but the token is wrong → outridr found but
herdr is not running → herdr protocol mismatch → connected. Today the app
cannot tell "not outridr" from "outridr, wrong token": every route —
including `/health` — returns a bare `401 unauthorized` before revealing
anything, and a bare 401 could come from any server.

One probe should answer the whole ladder. `/health` already reports the
herdr probe result (`herdr: null` when the socket is down) and the server
version; it just needs to answer *before* the token gate with a minimal
identity payload, and keep the herdr/push detail behind the token.

## The change (`lib/server.mjs`)

Move the `/health` branch above the `authorized()` gate in
`handleHttpUnsafe`:

- **Unauthorized** request (token configured, header missing/wrong):
  `200 {ok: true, service: "outridr", version, authorized: false}`.
  No herdr probe (an unauthenticated caller must not be able to trigger
  unix-socket work), no push-token count.
- **Authorized** request (or no token configured):
  `200 {ok: true, service: "outridr", version, authorized: true, herdr,
  pushTokens}` — today's payload plus the two new fields.

The browser-drive-by defenses (tokenless Host allowlist + Origin rejection)
stay above the health branch, unchanged. Update the endpoint table in the
module docblock.

Every other route keeps the existing `401 unauthorized` behavior — add/keep
a test proving that.

## Security tradeoff (also record in SECURITY.md)

Anyone who can reach the port — tailnet peers, or whatever the operator has
exposed it to — can now learn that the service is outridr, its version, and
that a token is required, without presenting the token. Accepted with open
eyes: the perimeter is the tailnet, the payload contains no herdr state and
triggers no backend work, and version disclosure is what lets the app say
"your outridr is outdated" before the user has a token at all. Browser
pages still cannot read the response cross-origin (no CORS headers are
set), and the tokenless drive-by guards are unaffected.

## Tests (`test/http.test.mjs`)

1. Existing happy-path and late-chunk `deepEqual`s gain
   `service: "outridr"`, `authorized: true`.
2. New: server with `token` configured, GET /health with no header →
   `200` and body deep-equals the four-field unauthorized shape (asserting
   `herdr`/`pushTokens` are absent).
3. New: token configured, wrong bearer → same unauthorized shape.
4. New: token configured, correct bearer → `authorized: true` with `herdr`
   key present.
5. New/existing: token configured, another route (e.g. GET /repos/roots)
   without the header still → `401`.

## Done criteria

- `npm run check` exit 0, `npm test` all pass.
- README/docblock endpoint description updated; SECURITY.md notes the
  pre-auth identity disclosure and its rationale.
- Released as a minor bump (pre-auth surface change) and deployed.

## Client contract (for the app repo)

The app's `probeBridge()` maps: fetch error/timeout → `unreachable`;
non-JSON or `service !== "outridr"` → `not-outridr`; `authorized: false` →
`unauthorized`; `herdr: null` → `no-herdr`; herdr ping protocol ≠ app
protocol → `protocol-mismatch`; else `ok`. Servers ≤0.5.6 return 401 on
/health with a bad token — the app treats a bare 401 as
"unauthorized (or outridr needs an update)".
