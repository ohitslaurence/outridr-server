# Plan 008: Operational polish — Tailscale IP re-check, modern launchctl, plist escaping

> **Executor instructions**: Follow this plan step by step. Run every
> verification command before moving on. If a STOP condition occurs, stop and
> report. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: plan 006 must be merged — `lib/server.mjs`
> should be ≈ 300 lines containing `startServer`/`resolveHost`/HTTP routing,
> and `lib/websocket.mjs`/`lib/push.mjs` etc. must exist. Otherwise STOP.

## Status

- **Priority**: P3 | **Effort**: S–M | **Risk**: MED for the launchctl change (hard to test in CI; manual verification needed on the operator's Mac — flag it in your report)
- **Depends on**: plans/006-split-server-modules.md
- **Category**: bug + dx
- **Planned at**: commit `8cb2c4f`, 2026-07-17

## Why this matters

Three deferred operational gaps: (1) if the machine's Tailscale IP changes while outridr runs (key re-auth, node re-join), the server keeps serving on a stale bind — unreachable until someone restarts it manually, the same class of silent failure plan 004 fixed at boot; (2) `launchctl load/unload` has been deprecated since macOS 10.11 — `bootstrap`/`bootout` is the supported path and behaves better on re-install; (3) the launchd plist interpolates filesystem paths into XML without escaping — a path containing `&` (rare but legal, e.g. `~/Dev & Play/`) produces an invalid plist that fails at load time with an opaque error.

## Current state

**`lib/server.mjs`** (post-006): `resolveHost(configured)` — async, returns literal hosts as-is; for `"tailscale"` retries `tailscale ip -4` (`HOST_RESOLVE_ATTEMPTS` × `HOST_RESOLVE_DELAY_MS`, env-overridable), exits 1 on ENOENT or exhaustion. `startServer` calls `resolveHost(config.host).then((host) => server.listen(...))` and returns the server synchronously.

**`lib/service.mjs`**:
- `installLaunchd()` writes `~/Library/LaunchAgents/dev.outridr.plist` via a template literal interpolating `process.execPath`, `SERVE_ENTRY`, and `servicePath()` raw into XML, then `run("launchctl", ["unload", PLIST], true)` + `run("launchctl", ["load", PLIST])`.
- `uninstallService()` darwin branch: `run("launchctl", ["unload", PLIST], true)`.
- `serviceStatus()` darwin branch: `run("launchctl", ["list", "dev.outridr"], true, true)`.
- `run(command, args, allowFailure, inheritOutput)` wraps `execFileSync`.
- Existing tests: none for service.mjs (mutates the host — kept manual). `test/host.test.mjs` has the subprocess + fake-tailscale-on-PATH pattern to reuse.

## Design

**A — Tailscale IP re-check** (`lib/server.mjs`): after a successful tailscale-mode listen, start an interval (`HOST_RECHECK_MS`, default 60_000, env `OUTRIDR_HOST_RECHECK_MS` read at module load, `unref()`d) that runs `tailscale ip -4` (single attempt, no retries); if it yields a valid IPv4 that **differs** from the bound host, log `outridr: Tailscale IPv4 changed <old> → <new>; exiting so the service supervisor rebinds` and `process.exit(1)`. A failed/empty check logs nothing and waits for the next tick (transient tailscaled hiccups must not kill a working server — only a *changed* address may). Literal-host mode: no interval at all.

**B — launchctl modernization** (`lib/service.mjs`): use `launchctl bootout gui/<uid>/dev.outridr` (allowFailure) before install and in uninstall, and `launchctl bootstrap gui/<uid> <plist>` to load. Get uid from `process.getuid()`. Keep `launchctl list dev.outridr` for status (still supported; `launchctl print gui/<uid>/dev.outridr` is richer — use `print`, falling back to `list` if print errors, via the existing allowFailure mechanics).

**C — plist escaping** (`lib/service.mjs`): add a tiny exported pure function `xmlEscape(value)` (`&` `<` `>` → entities; quotes not needed in text nodes) and run every interpolated value in the plist template through it. The systemd unit is not XML — but `ExecStart` paths containing spaces would also break; out of scope here (systemd quoting is a rabbit hole; note it in the report if you disagree).

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Syntax | `npm run check` | exit 0 |
| Tests | `npm test` | exit 0, all pass |

## Scope

**In scope**: `lib/server.mjs` (re-check interval only), `lib/service.mjs`, `test/host.test.mjs` (re-check tests), `test/service.test.mjs` (create — unit test for `xmlEscape` only; do NOT invoke real launchctl/systemctl in tests).
**Out of scope**: systemd unit quoting; any push/session/WS code; README (plan 009 will document; note anything 009 must mention in your report NOTES).

## Git workflow

Branch `advisor/008-operational-polish`; commit per design item (A, B, C); no push.

## Steps

1. **A — re-check interval** with tests in `test/host.test.mjs` (reuse the fake-tailscale + subprocess pattern; `OUTRIDR_HOST_RECHECK_MS=100`): (i) fake tailscale switches its reported IP after the first call (invocation-counter trick from the existing retry-then-succeed test, but note the counter file must distinguish resolve calls from re-check calls only by count) → child exits 1 and stderr matches `Tailscale IPv4 changed`; (ii) fake tailscale keeps reporting the same IP → child still alive after ~5 intervals (assert no exit, then kill); (iii) fake tailscale starts failing after bind (exit 1 on later calls) → child still alive (transient failure tolerated). Literal-host regression: existing suites (which use `host: "127.0.0.1"`) must show no new timers — `npm test` still exits cleanly. **Verify**: `node --test test/host.test.mjs` all pass; `npm test` green + clean exit.
2. **B — bootstrap/bootout**. No automated tests; keep the change minimal and symmetrical (install = bootout(allowFailure) → write plist → bootstrap; uninstall = bootout(allowFailure) → rm). **Verify**: `npm run check` exit 0; report clearly that launchctl paths need one manual `outridr install`/`status`/`uninstall` round on the operator's Mac.
3. **C — xmlEscape** + `test/service.test.mjs` unit tests (`&` `<` `>` escaped; clean path unchanged; the plist template uses it for all three interpolations — assert by importing `xmlEscape` and, for the template, grep `lib/service.mjs` for `${xmlEscape(` occurrences ≥ 3 as a done-criterion instead of executing installLaunchd). **Verify**: `npm test` green.

## Done criteria

- [ ] `npm run check` exit 0; `npm test` exit 0, ≥ 4 new tests, clean exit
- [ ] `grep -n "bootstrap gui\|bootout" lib/service.mjs` → both present; `grep -n '"load"\|"unload"' lib/service.mjs` → no matches
- [ ] `grep -c 'xmlEscape(' lib/service.mjs` ≥ 4 (3 uses + definition)
- [ ] `grep -n "OUTRIDR_HOST_RECHECK_MS" lib/server.mjs` → present
- [ ] `git diff main --stat` touches only in-scope files
- [ ] Report NOTES explicitly lists what needs manual macOS verification

## STOP conditions

- Plan 006 not merged.
- The re-check design can't avoid keeping the event loop alive in literal-host test runs (i.e. `npm test` stops exiting cleanly) after two attempts.
- `process.getuid` unavailable on the platform path you're editing (it exists on darwin/linux; if you find otherwise, report).

## Maintenance notes

- The exit-on-change behavior means a mid-session IP change drops live WS connections — intended (they were about to break anyway); the app reconnects.
- Reviewer: manually run `outridr install` + `outridr status` + `outridr uninstall` on macOS after merge (executor cannot).
