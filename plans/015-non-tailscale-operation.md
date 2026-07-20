# Plan 015: Make non-Tailscale operation a supported, safe path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e704a60..HEAD -- lib/server.mjs lib/config.mjs README.md test/host.test.mjs test/config.test.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (deliberate behavior change for some existing deployment shapes — see Maintenance notes)
- **Depends on**: none
- **Category**: security + docs
- **Planned at**: commit `e704a60`, 2026-07-20 (revised same day after a
  three-agent red-team review; the loopback check, env opt-out, and README
  wording below already incorporate that review's findings)

## Why this matters

outridr is tailnet-*default* but not tailnet-*locked*: setting `host` to a
literal address runs it on any network. Today that path is an undocumented
escape hatch with a footgun — nothing stops a tokenless bind to `0.0.0.0` on
a machine with a public interface, where the server's plain-HTTP surface
(drive-your-agents WebSocket included) would be open to anyone. This plan
makes non-Tailscale use a first-class path: a startup guard that refuses
non-loopback, non-Tailscale binds unless a token is configured (with an
explicit `insecureNoToken` opt-out for already-protected interfaces like
WireGuard), plus README documentation of the whole posture. The operator's
goal: people without a tailnet can use this — safely.

## Current state

- `lib/server.mjs` — startup + routing. `startServer` resolves the host, then
  listens with no safety check between (lines 58–70):

  ```js
    resolveHost(config.host).then((host) => {
      server.listen(config.port, host, () => {
        console.log(`outridr listening on ${host}:${config.port} → ${config.herdrSocket}`);
  ```

  `resolveHost` (lines 102–128) returns `configured` unchanged unless it is
  the literal string `"tailscale"`, in which case it shells out to
  `tailscale ip -4`. So at the `.then`, `config.host === "tailscale"` is the
  only marker distinguishing a tailnet bind from a literal one. Note the
  `.then` has no `.catch`: anything the new guard throws (as opposed to
  exiting) would become an unhandled rejection — the guard below therefore
  handles non-string hosts itself instead of assuming `host` is a string.

- `lib/config.mjs` — `loadConfig` returns (lines 48–50):

  ```js
    return {
      port: Number.parseInt(process.env.OUTRIDR_PORT ?? "", 10) || file.port || 8674,
      host: process.env.OUTRIDR_HOST ?? file.host ?? "tailscale",
      token: process.env.OUTRIDR_TOKEN ?? file.token ?? null,
  ```

  Note: an empty-string token is falsy — `authorized` in `lib/http-util.mjs:17`
  starts with `if (!config.token) return true;`, so `token: ""` already means
  "no auth". The new guard must treat it the same way (plain truthiness), so
  the two can never disagree.

- `README.md` — the `host` config bullet (lines 106–116), "Security model"
  (lines 145–154), and the config example (lines 94–104). The security model
  ends with the flat sentence "Do not bind `0.0.0.0` on a machine with a
  public interface." — step 4 replaces it (a supported non-tailnet path
  contradicts an absolute prohibition).

- `test/host.test.mjs` — the subprocess harness for startup/exit behavior:
  `writeChildScript(config)` (lines 20–28) writes a script that calls
  `startServer(config)`; `childConfig()` (lines 30–41) builds the config
  object; `spawnChild` + `waitForExit` + `waitFor` (lines 43–86) run it and
  observe stdout/stderr/exit code. Guard tests MUST use this harness — the
  guard calls `process.exit(1)`, which would kill the test runner if invoked
  in-process.

- Server spawn inventory (all verified guard-exempt, so no existing test
  changes are needed): every `startTestServer` call goes through `makeConfig`
  (`test/helpers.mjs:16-32`, base `host: "127.0.0.1"` — loopback);
  `test/host.test.mjs` children use `host: "tailscale"`; and one direct
  `startServer` subprocess at `test/http.test.mjs:310-333` (EADDRINUSE test)
  uses `host: "127.0.0.1"`, `token: null` — loopback-exempt.

- `test/config.test.mjs` — subprocess-based `loadConfig` tests:
  `loadConfigInSubprocess(env)` / `baseEnv(overrides)` / `writeConfigFile`
  (lines 11–30). The new `insecureNoToken` config case goes here.

Repo conventions that apply:

- Zero dependencies, plain `.mjs` ESM, `node:test`.
- Fail-fast startup errors: `console.error("outridr: ...")` then
  `process.exit(1)` — see `resolveHost`'s ENOENT branch
  (`lib/server.mjs:116-119`) for the voice and shape to match.
- Config keys: file key, env override where operationally needed; booleans
  normalized strictly (`push.enabled !== false` pattern at
  `lib/config.mjs:75`).
- Comments explain *why*; docblocks at module top list the config shape
  (`lib/config.mjs:1-18`) — new keys must be added there.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Syntax check | `npm run check` | exit 0 |
| Version sync | `npm run check:versions` | exit 0 |
| Full tests | `npm test` | all pass (73 at planning time) |
| One file | `node --test test/host.test.mjs` | all pass |

No install step — the project has zero dependencies.

## Scope

**In scope** (the only files you should modify):
- `lib/server.mjs` (add the guard + call it before `server.listen`)
- `lib/config.mjs` (add `insecureNoToken`, docblock line)
- `README.md` (host bullet, security model, new section)
- `test/host.test.mjs` (guard tests; `childConfig` gains an overrides param)
- `test/config.test.mjs` (one `insecureNoToken` case)

**Out of scope** (do NOT touch):
- `lib/http-util.mjs` — `authorized` is unchanged; the guard reuses its
  truthiness semantics, it does not replace them.
- TLS/HTTPS support — deliberately excluded; the README section points at
  reverse proxies instead.
- `test/helpers.mjs` — `makeConfig` needs no change: its base is
  `host: "127.0.0.1"` (loopback-exempt) and a missing `insecureNoToken` is
  falsy, so every existing test passes through the guard untouched. If you
  find yourself editing helpers, you've broken the exemption — STOP.
- `package.json` / `herdr-plugin.toml` — the version bump mentioned in
  Maintenance notes is a RELEASE-TIME action for the maintainer, NOT part of
  this execution. Do not bump versions.
- `bin/outridr.mjs`, `lib/service.mjs`, workflows.

## Git workflow

- Branch: `advisor/015-non-tailscale-operation`
- One commit, imperative summary (e.g. "Require a token for non-loopback
  binds outside Tailscale; document non-Tailscale use").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `insecureNoToken` to config

In `lib/config.mjs`, add to the returned object directly after the `token:`
line:

```js
    insecureNoToken: process.env.OUTRIDR_INSECURE_NO_TOKEN === "1" || file.insecureNoToken === true,
```

Strict comparisons (the `push.enabled` normalization style): only the literal
JSON boolean or the exact env value `"1"` opts out — disabling auth must be
unmistakably deliberate. The env form exists for env-only deployments
(containers) that have no config file. Add to the docblock's example config
(after the `"token"` line):

```
 *   "insecureNoToken": false,       // allow tokenless non-loopback binds off-tailnet
```

**Verify**: `npm run check` → exit 0.

### Step 2: Add the bind guard to lib/server.mjs

Add `import { isIP } from "node:net";` to the imports (alphabetical order:
after `node:http`, before `node:path`). Then add near `resolveHost` (module
scope, matching its fail-fast style):

```js
// String-prefix tests are not IP-range tests: "127.0.0.1.evil.example" would
// pass a startsWith("127.") check and then resolve via DNS to anywhere. Only
// exact well-known names and numerically-verified 127/8 literals count.
function isLoopbackHost(host) {
  if (typeof host !== "string") {
    return false;
  }
  if (host === "localhost" || host === "::1") {
    return true;
  }
  return isIP(host) === 4 && host.startsWith("127.");
}

// A non-loopback bind outside Tailscale has no tailnet ACL in front of it —
// plain truthiness on token matches authorized() in http-util.mjs, so the
// guard can never pass while auth is effectively off (e.g. token: "").
function assertBindAllowed(config, host) {
  if (config.host === "tailscale" || isLoopbackHost(host) || config.token || config.insecureNoToken) {
    return;
  }
  console.error(
    `outridr: refusing to listen on ${host} without a token — outside Tailscale there is no tailnet ACL in front of this server.\n` +
      `  Set "token" in the config (or OUTRIDR_TOKEN). If this address is your Tailscale IP, set "host": "tailscale" instead.\n` +
      `  Or set "insecureNoToken": true (or OUTRIDR_INSECURE_NO_TOKEN=1) if this interface is already protected (VPN, firewalled LAN).`,
  );
  process.exit(1);
}
```

Call it as the first line of the `resolveHost(...).then((host) => { ... })`
callback in `startServer`, before `server.listen`:

```js
  resolveHost(config.host).then((host) => {
    assertBindAllowed(config, host);
    server.listen(config.port, host, () => {
```

Guard placement rationale (inline this understanding, not the text): it runs
on the *resolved* host but keys the Tailscale exemption off the *configured*
`config.host === "tailscale"`, because a tailnet-resolved address IS behind
tailnet ACLs while the same literal address typed by hand may not be. A
non-string `host` (bad JSON like `"host": 123`) falls through to the guard's
error-and-exit rather than throwing inside the un-`catch`ed `.then`.

**Verify**: `npm run check` → exit 0, and `npm test` → all pass (every
existing test binds loopback or resolves via the fake tailscale, so the
guard must not fire; a failure here means the exemptions are wrong).

### Step 3: Guard tests in test/host.test.mjs

Change `childConfig()` to `childConfig(overrides = {})` returning
`{ ...base, ...overrides }` (keep the existing base object exactly). Then add
five tests using the existing `writeChildScript`/`spawnChild` harness, in the
style of "host resolution: tailscale always fails -> subprocess exits 1"
(lines 116–132). **All five spawn with `baseEnv()` as the env argument** — no
fake tailscale binary is needed, since `config.host` is a literal and
`resolveHost` never shells out:

1. `bind guard: non-loopback host without token -> subprocess exits 1` —
   `childConfig({ host: "0.0.0.0" })`; assert exit code 1 and
   `assert.match(output.stderr, /refusing to listen/)`.
2. `bind guard: non-loopback host with token -> server listens` —
   `childConfig({ host: "0.0.0.0", token: "test-token" })`; wait for stdout
   `outridr listening on 0.0.0.0:`, then `child.kill()`.
3. `bind guard: non-loopback host with insecureNoToken -> server listens` —
   `childConfig({ host: "0.0.0.0", insecureNoToken: true })`; same listening
   assertion.
4. `bind guard: loopback host without token -> server listens` —
   `childConfig({ host: "127.0.0.1" })`; same listening assertion. (The rest
   of the suite covers this implicitly; this makes the exemption explicit.)
5. `bind guard: hostname starting with 127. is not loopback -> subprocess exits 1` —
   `childConfig({ host: "127.0.0.1.invalid" })`; assert exit code 1 and
   `/refusing to listen/`. This is the regression test for the DNS-bypass
   attack on the loopback check: the guard must fire BEFORE any DNS lookup
   (the child must exit 1 with the guard's message, not a DNS error).

**Verify**: `node --test test/host.test.mjs` → all pass (7 existing + 5 new).
Then `npm test` → all pass.

### Step 4: Config test for insecureNoToken

In `test/config.test.mjs`, using the existing helpers (lines 11–30), add one
test asserting:

- defaults (no file key, no env) → `config.insecureNoToken === false`;
- file `{"insecureNoToken": true}` → `true`;
- file `{"insecureNoToken": "yes"}` (non-boolean truthy) → `false` (strict
  normalization);
- env `OUTRIDR_INSECURE_NO_TOKEN: "1"` with no file key → `true`;
- env `OUTRIDR_INSECURE_NO_TOKEN: "true"` → `false` (only `"1"` counts).

**Verify**: `node --test test/config.test.mjs` → all pass, including the new one.

### Step 5: README — document the posture

Four edits:

1. **`host` bullet** (Configuration section): append:
   "Binding a non-loopback address with `host` set to anything other than
   `\"tailscale\"` requires a `token` — outridr refuses to start otherwise
   (see [Running without Tailscale](#running-without-tailscale))."
2. **Config example**: no change to the JSON block (keep it minimal;
   `insecureNoToken` is documented in the new section, not advertised in the
   happy-path example).
3. **Security model section**: after the `exec`/`repos` sentence, add:
   "Off the tailnet the perimeter disappears, so outridr enforces the second
   factor: a non-loopback bind with a literal `host` refuses to start without
   a `token` unless you explicitly set `insecureNoToken: true`."
   Then REPLACE the section's final sentence
   "Do not bind `0.0.0.0` on a machine with a public interface." with:
   "Binding `0.0.0.0` is only sane behind a firewall or NAT — see
   [Running without Tailscale](#running-without-tailscale)."
   (Leaving the old absolute prohibition standing would contradict the new
   section.)
4. **New section** `## Running without Tailscale`, placed directly after
   "Security model". Content to convey (write it in the README's plain,
   direct voice — see the Security model section for register):
   - You don't need Tailscale: set `host` to a literal address — a LAN IP,
     a WireGuard/ZeroTier interface address, or `0.0.0.0` behind a
     firewall/NAT (normal in containers).
   - A `token` is required for any non-loopback literal bind. Make it long
     and random (e.g. `openssl rand -hex 32`) — it is the only lock on the
     door out here. The app authenticates with
     `Authorization: Bearer <token>`.
   - `?token=` also works for clients that can't set headers, but query
     strings end up in reverse-proxy and access logs — prefer the header
     everywhere you can.
   - `insecureNoToken: true` (or env `OUTRIDR_INSECURE_NO_TOKEN=1` for
     config-file-less deployments) opts out, for interfaces that already
     carry their own auth/encryption boundary (a VPN, an isolated LAN).
     One-line example config.
   - Traffic is plain HTTP. On a network you don't fully trust, put a
     TLS-terminating reverse proxy (e.g. Caddy) in front and keep outridr
     bound to loopback behind it. Never expose outridr directly to the
     public internet — the token gates requests, but it travels in cleartext
     and there is no rate limiting.

**Verify**: `grep -c "Running without Tailscale" README.md` → 3 (heading +
host-bullet link + security-model link). `npm run check && npm test` → all
pass.

## Test plan

Steps 3–4 are the test plan (5 new subprocess tests in `test/host.test.mjs`
modeled on the existing exit-code tests at lines 116–132, plus 1 in
`test/config.test.mjs`). Full-suite gate: `npm test` → 0 failures, total
count = planning-time 73 + 6 = 79.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run check` and `npm run check:versions` exit 0
- [ ] `npm test` exits 0 with 79 passing tests
- [ ] `node -e "process.exit(require('node:fs').readFileSync('lib/server.mjs','utf8').includes('assertBindAllowed') ? 0 : 1)"` → exit 0
- [ ] `grep -c "insecureNoToken" lib/config.mjs` → 2 (docblock line + property line)
- [ ] `grep -c "Running without Tailscale" README.md` → 3
- [ ] `grep -c "startsWith(\"127.\")" lib/server.mjs` → 1, on the same line or
      adjacent to an `isIP` check (the DNS-bypass fix)
- [ ] `git status` shows only the five in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows in-scope files changed and the excerpts don't match.
- Any *existing* test fails after step 2 — the loopback/tailscale exemptions
  are wrong; do not "fix" existing tests to accommodate the guard.
- You find yourself modifying `test/helpers.mjs`, `lib/http-util.mjs`,
  `package.json`, or `herdr-plugin.toml`.
- Binding `0.0.0.0` fails in the sandbox (some CI environments forbid it) —
  report rather than substituting a different address, since the test would
  then no longer exercise a non-loopback bind.
- Guard test 5 exits for the wrong reason (a DNS error rather than the
  guard's message) — that means the guard ran after name resolution and the
  design's ordering assumption is broken.

## Maintenance notes

- **Behavior change — breaking shapes on upgrade** (all fixed by one config
  line; the startup error says exactly which):
  - a literal non-loopback `host` with no token — including someone who typed
    their Tailscale 100.x address instead of `"tailscale"` (the error message
    points them to `"host": "tailscale"`);
  - container/NAT deployments binding `0.0.0.0` behind a firewall with no
    token (opt-out: `OUTRIDR_INSECURE_NO_TOKEN=1`, added precisely so
    env-only deployments don't need to grow a config file);
  - `OUTRIDR_HOST=<literal>` env users with no token.
- **Supervisor interaction**: unlike the tailscale-not-ready exit (transient
  by design — restart eventually succeeds), the guard's `exit(1)` is a
  permanent misconfiguration, so systemd (`Restart=on-failure`, 3 s) and
  launchd (`KeepAlive Crashed=true`) will restart-loop it. The loop is
  cheap (the process exits in milliseconds) but noisy. Release notes should
  tell upgraders to check `outridr status` / logs after upgrading. A distinct
  exit code for config errors plus `RestartPreventExitStatus` (systemd) is a
  possible follow-up — deliberately out of scope here.
- **Release**: this warrants a minor version bump (0.4.0) at release time —
  NOT during this plan's execution — and the bump must update BOTH
  `package.json` and `herdr-plugin.toml`, or `check:versions` blocks CI and
  publish.
- The loopback list is deliberately minimal (`localhost`, `::1`, verified
  `127.*` IPv4 literals). Exotic spellings (`127.1`, `0x7f.0.0.1`,
  `0:0:0:0:0:0:0:1`) are treated as non-loopback and thus require a token —
  the safe direction to fail. Do not grow the list without a real user need.
- The guard's token truthiness must stay in lockstep with `authorized()` in
  `lib/http-util.mjs` — if token semantics ever change there (e.g. multiple
  tokens), revisit the guard in the same change.
- Red-team findings considered and REJECTED (do not re-add): exempting
  literal `100.64.0.0/10` addresses (a CGNAT prefix is not proof of tailnet
  ACLs — VPS providers assign from that range); enforcing token length in
  code (README guidance instead — an operator's short token is their call);
  validating `tailscale ip -4` output against the CGNAT range (the attack
  requires local PATH compromise, which defeats everything anyway).
- Deferred, on purpose: TLS support (reverse proxy is the recommendation),
  rate limiting, and any change to the app-side connection flow (whether the
  outridr app can dial arbitrary host:port is an app-repo concern).
