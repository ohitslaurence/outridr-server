# Plan 020: Find the macOS Tailscale binary + fix onboarding docs

> **Executor instructions**: Follow step by step. Run every verification
> command and confirm the expected result before moving on. STOP conditions
> halt you. Update this plan's row in `plans/README.md` when done unless a
> reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 3488f44..HEAD -- lib/server.mjs README.md test/host.test.mjs`
> Plan 015's bind guard near `resolveHost` is EXPECTED drift; proceed if that
> is the only change to `lib/server.mjs` and the excerpts below still match.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: MED (touches host resolution — well tested)
- **Depends on**: none (coordinate merge with 015, same file region)
- **Category**: bug + docs
- **Planned at**: commit `3488f44` (v0.4.1), 2026-07-20 (from a cold
  setup-simulation audit: an assistant got a Mac user ~75% of the way, then
  the Tailscale-CLI-not-on-PATH gap broke the documented commands)

## Why this matters

On a stock macOS Tailscale.app install (Mac App Store or direct download),
the `tailscale` CLI is NOT on `PATH` — it lives at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`. Two consequences:

1. The server's own host resolution shells out to `execFileSync("tailscale",
   ...)`; with the default `host: "tailscale"`, a Mac user's server fails to
   resolve its bind address and exits, even though Tailscale is running.
2. The README's health-check command `curl "http://$(tailscale ip -4):..."`
   fails to run for the same user.

This is the single most likely stumble for the exact platform the product
targets first (Claude Code developers on Macs). A fallback lookup of the known
app-bundle path fixes the server; a README note fixes the human.

## Current state (verified at 3488f44)

- `lib/server.mjs:94` and `:115` — both call `execFileSync("tailscale",
  ["ip", "-4"], ...)` with a bare command name (relies on PATH). `resolveHost`
  (lines 109-135) already handles `error.code === "ENOENT"` by exiting with
  "tailscale binary not found".
- `lib/service.mjs:120-129` `servicePath()` builds the launchd/systemd PATH;
  it does NOT include `/Applications/Tailscale.app/Contents/MacOS`, so even
  the installed service can't find the CLI on macOS.
- `README.md:25` Quick start: `curl "http://$(tailscale ip -4):8674/health"`.
- `README.md` has no "Prerequisites" block; Node ≥20 appears only as a CI
  mention (line 21 area); herdr is linked but "install herdr first" is not
  stated; the phone needing Tailscale is only implied by the mermaid diagram.
- `test/host.test.mjs` — subprocess harness with a fake `tailscale` on a
  temp-dir PATH (lines 13-18, 97+); the fallback path must remain testable
  through it.

Conventions: fail-fast with `outridr:`-prefixed messages; comments say *why*.
Baseline: 83 tests (89 if plan 015 landed first).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Syntax | `npm run check` | exit 0 |
| Tests | `npm test` | all pass |
| Host tests | `node --test test/host.test.mjs` | all pass |

## Scope

**In scope**: `lib/server.mjs` (the two `tailscale` invocations + a helper),
`lib/service.mjs` (`servicePath()` only), `README.md`, `test/host.test.mjs`.

**Out of scope**: `resolveHost`'s retry/exit logic and plan 015's bind guard;
Linux/Windows path assumptions; any non-macOS behavior change.

## Git workflow

- Branch: `advisor/020-macos-tailscale-onboarding`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Resolve the tailscale binary with a macOS fallback

In `lib/server.mjs`, add a module-scope helper and use it in both places that
run tailscale:

```js
import { existsSync } from "node:fs";

// On macOS the Tailscale.app CLI isn't on PATH by default; fall back to its
// known bundle location before giving up. Returns the command name (found on
// PATH) or the absolute app-bundle path, so execFileSync just works.
const MACOS_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
function tailscaleBin() {
  return process.platform === "darwin" && existsSync(MACOS_TAILSCALE)
    ? MACOS_TAILSCALE
    : "tailscale";
}
```

Replace `execFileSync("tailscale", ["ip", "-4"], ...)` at both sites
(`checkTailscaleHost`, `resolveHost`) with
`execFileSync(tailscaleBin(), ["ip", "-4"], ...)`.

Keep the ENOENT handling: if the bundle path doesn't exist and PATH lookup
also fails, behavior is unchanged (the existing exit message still fires).

**Verify**: `node --test test/host.test.mjs` → existing tests pass (they put a
fake `tailscale` on PATH; on the test platform `tailscaleBin()` returns
`"tailscale"` unless the runner is macOS AND the real app is installed — see
step 3 for making the fallback itself testable).

### Step 2: Add the app-bundle dir to the service PATH (macOS)

In `lib/service.mjs` `servicePath()`, include the Tailscale.app MacOS dir when
on darwin so the installed launchd service can also find the CLI:

```js
function servicePath() {
  const dirs = [
    dirname(process.execPath),
    join(homedir(), ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  if (process.platform === "darwin") {
    dirs.push("/Applications/Tailscale.app/Contents/MacOS");
  }
  return dirs.join(":");
}
```

**Verify**: `npm run check` → exit 0. `test/service.test.mjs` (if it asserts
on the PATH string) still passes; if it hardcodes the old list, update that
assertion and note it.

### Step 3: Make the fallback testable

Add one test to `test/host.test.mjs` that exercises the fallback WITHOUT
depending on the runner being macOS: introduce an env override the helper
honors, e.g. `OUTRIDR_TAILSCALE_BIN`, checked first in `tailscaleBin()`:

```js
function tailscaleBin() {
  if (process.env.OUTRIDR_TAILSCALE_BIN) {
    return process.env.OUTRIDR_TAILSCALE_BIN;
  }
  return process.platform === "darwin" && existsSync(MACOS_TAILSCALE)
    ? MACOS_TAILSCALE
    : "tailscale";
}
```

Then a test writes a fake tailscale script at an arbitrary path, points
`OUTRIDR_TAILSCALE_BIN` at it (NOT on PATH), and asserts the server resolves
its host and listens — proving `execFileSync` used the absolute path. Model
it on the existing "reports an IPv4 → server listens" test (lines 97-114).
Document the env var in the README's tuning list.

**Verify**: `node --test test/host.test.mjs` → all pass including the new one.

### Step 4: README onboarding fixes

- Add a **Prerequisites** block at the top of Quick start:
  - Node.js ≥ 20 (`node --version`)
  - herdr installed and running — "outridr is a window onto herdr; install it
    first" with the herdr.dev link and its min version (`min_herdr_version`
    from `herdr-plugin.toml` — read the current value; do not hardcode a stale
    one)
  - Tailscale on this machine AND on your phone (same tailnet)
  - macOS note: the `tailscale` CLI isn't on PATH by default; either use the
    full path `/Applications/Tailscale.app/Contents/MacOS/Tailscale` or alias
    it. The server finds it automatically (step 1); this note is for the
    manual `curl` health check.
- Change the health-check line to be copy-paste-safe on macOS, e.g. show both
  the PATH form and the full-path fallback.
- State how to apply a config change to a running service: re-run
  `outridr install` (it restarts; the README's migration note already relies
  on this) — say it explicitly near the config docs.

**Verify**: `grep -c "Prerequisites" README.md` → ≥1;
`grep -c "Applications/Tailscale.app" README.md` → ≥1; `npm run check` → 0.

## Done criteria

- [ ] `grep -n "tailscaleBin" lib/server.mjs` → helper defined and used twice
- [ ] `grep -c "Applications/Tailscale.app" lib/server.mjs lib/service.mjs README.md` → each ≥1
- [ ] `npm run check` exits 0; `npm test` exits 0 with the new host test green
- [ ] README has Prerequisites + the macOS PATH note + config-reload note
- [ ] `git status` clean outside scope; `plans/README.md` row updated

## STOP conditions

- Existing host tests fail after step 1 (the fake-tailscale-on-PATH mechanism
  interacts with the fallback — the env override in step 3 is the intended
  fix; if it still fails, report).
- `test/service.test.mjs` asserts a PATH form that step 2 breaks in a way that
  isn't a simple assertion update.

## Maintenance notes

- The hardcoded `/Applications/Tailscale.app/...` path is the standard install
  location; the standalone (non-App-Store) Tailscale also installs a
  `/usr/local/bin/tailscale` symlink, which PATH already covers, so the
  fallback is specifically for the App Store sandboxed app.
- `OUTRIDR_TAILSCALE_BIN` is now a supported override — keep it documented.
- If Tailscale ever ships the CLI elsewhere, this is the one place to update.
