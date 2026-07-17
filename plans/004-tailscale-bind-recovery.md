# Plan 004: Make `host: "tailscale"` resolution survive boot ordering (retry, then fail fast)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a16bc22..HEAD -- lib/server.mjs lib/service.mjs README.md`
> If `resolveHost`/`startServer` in `lib/server.mjs` differ from the excerpts
> below beyond plan 002's documented edits (an added `server.on("error")`
> block), treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW–MED (changes startup behavior: failure to find a Tailscale IP now exits instead of silently binding loopback; that is the point, but it is a behavior change to document)
- **Depends on**: plans/001-test-baseline-and-ci.md (harness), plans/002-request-lifecycle-hardening.md (its `server.on("error")` + exit convention — land 002 first to avoid merge friction in `startServer`)
- **Category**: bug
- **Planned at**: commit `a16bc22`, 2026-07-17

## Why this matters

The default config is `host: "tailscale"`, resolved by shelling out to `tailscale ip -4` **once, synchronously, at startup**. On boot, the user service frequently starts before `tailscaled` has an address (the systemd unit orders only `After=network-online.target`, which user units can't reliably couple to tailscaled anyway; launchd has no ordering at all). When that happens the current code logs one line and **falls back to binding 127.0.0.1 — permanently**. The service is "running" (so `Restart=on-failure` never triggers) but unreachable from the tailnet until someone manually restarts it. For a package whose one-line pitch is "install a service and point your phone at it", a machine reboot silently breaking the app is the single worst operational failure mode.

The fix: retry resolution briefly, and if it still fails, **exit non-zero** so the supervisor (systemd `Restart=on-failure`, launchd `KeepAlive.Crashed`) keeps retrying until Tailscale is up. Never silently bind a different interface than configured.

## Current state

**`lib/server.mjs` — `resolveHost` (lines 75–85) and its call site in `startServer` (lines 63–64):**

```js
function resolveHost(configured) {
  if (configured !== "tailscale") {
    return configured;
  }
  try {
    return execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8" }).trim().split("\n")[0];
  } catch {
    console.error("outridr: `tailscale ip -4` failed; falling back to 127.0.0.1");
    return "127.0.0.1";
  }
}
```

```js
  const host = resolveHost(config.host);
  server.listen(config.port, host, () => { ... });
```

Note `startServer` is currently synchronous and returns `server` (line 72) — the plan-001 test helper `startTestServer` awaits the `listening` event on the returned server. Keep `startServer`'s signature and return value unchanged; tests always pass a literal host, so they never enter the retry path.

Two additional latent issues to fix in passing, same function:
- `tailscale ip -4` exiting 0 with **empty output** (or only a warning line) yields `""` or garbage as the host — treat empty/non-IP output as failure. A minimal sanity check `/^\d+\.\d+\.\d+\.\d+$/` on the chosen line is enough.
- The fallback masks a genuinely absent `tailscale` binary the same way — the error message should distinguish "binary not found" from "no address yet" if cheaply possible (the catch error's `code === "ENOENT"` means not installed → retrying will never help → exit immediately with a message pointing at the `host` config option).

**`lib/service.mjs`** — systemd unit (lines 54–68) has `Restart=on-failure`, `RestartSec=3`; launchd plist (lines 82–101) has `KeepAlive.Crashed=true`. Both restart a process that exits non-zero. No changes needed here except optionally documenting the behavior in the unit comment.

**`README.md`** — "Configuration" section documents `host: "tailscale"` (lines 63–64) and currently implies nothing about the fallback. Update wording per Step 3.

## Commands you will need

| Purpose      | Command         | Expected on success |
|--------------|-----------------|---------------------|
| Syntax check | `npm run check` | exit 0              |
| Tests        | `npm test`      | exit 0              |

## Scope

**In scope**:
- `lib/server.mjs` — `resolveHost` and minimal glue in `startServer`.
- `README.md` — the `host` bullet in Configuration + one line in Security model if apt.
- `test/http.test.mjs` or a new `test/host.test.mjs` — subprocess tests.
- `lib/service.mjs` — comment-only edits allowed (no functional change).

**Out of scope**:
- Any attempt to add systemd `After=tailscaled.service` ordering — user units cannot depend on system units reliably; the retry/exit loop is the mechanism.
- Watching for Tailscale IP *changes* after startup (rebinding a live server) — deferred, see maintenance notes.
- The `server.on("error")` handler — plan 002 owns it.

## Git workflow

- Branch: `advisor/004-tailscale-bind-recovery`
- Commit per step; short imperative messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Retry + fail-fast in `resolveHost`

Replace `resolveHost` with a version that, for `"tailscale"` only:

1. Attempts `tailscale ip -4` up to `HOST_RESOLVE_ATTEMPTS = 5` times, `HOST_RESOLVE_DELAY_MS = 2000` apart (constants near the other top-of-file constants). Synchronous sleep is fine given startup context — but prefer making `resolveHost` async with `await setTimeout` from `node:timers/promises` and awaiting it in `startServer` **only if** `startServer`'s external contract (returns the server synchronously) can be preserved; it cannot, so use the simple approach: keep it synchronous with `execFileSync` and a blocking sleep via `execFileSync(process.execPath, ["-e", "setTimeout(()=>{}, 2000)"])`? — NO. That's ugly. Correct simple design: make an internal async `resolveTailscaleHost()` and restructure `startServer` to do `server.listen` inside a `.then()`, while still returning `server` immediately (listeners can be attached to a server before `listen` is called, and `startTestServer` awaits the `listening` event, which still fires). This preserves the public contract: `startServer(config)` returns the `http.Server`; `listen` just happens a tick (or a few retries) later.
2. On each attempt: take stdout, split lines, pick the first line matching `/^\d+\.\d+\.\d+\.\d+$/`. Found → resolve with it.
3. `error.code === "ENOENT"` (tailscale not installed) → log `` `outridr: tailscale binary not found; set "host" in the config to a literal address` `` and `process.exit(1)` immediately (no retries).
4. Attempts exhausted → log `` `outridr: no Tailscale IPv4 after ${attempts} attempts; is tailscale up? (set "host" to a literal address to bind something else)` `` and `process.exit(1)`.
5. Literal hosts (anything ≠ `"tailscale"`) keep the exact current behavior: used as-is, synchronously, zero retries.

Shape:

```js
async function resolveHost(configured) {
  if (configured !== "tailscale") {
    return configured;
  }
  for (let attempt = 1; attempt <= HOST_RESOLVE_ATTEMPTS; attempt++) {
    try {
      const line = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8" })
        .split("\n").map((l) => l.trim()).find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l));
      if (line) {
        return line;
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        console.error('outridr: tailscale binary not found; set "host" in the config to a literal address');
        process.exit(1);
      }
    }
    if (attempt < HOST_RESOLVE_ATTEMPTS) {
      console.error(`outridr: waiting for a Tailscale IPv4 (attempt ${attempt}/${HOST_RESOLVE_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, HOST_RESOLVE_DELAY_MS));
    }
  }
  console.error("outridr: no Tailscale IPv4; is tailscale up? Exiting so the service supervisor retries.");
  process.exit(1);
}
```

In `startServer`, replace the two lines `const host = resolveHost(config.host); server.listen(...)` with:

```js
  resolveHost(config.host).then((host) => {
    server.listen(config.port, host, () => { /* existing log lines */ });
  });
  return server;
```

**Verify**: `npm run check` → exit 0; `npm test` → all existing tests still pass (they use literal hosts and the `listening` event — confirm none broke from the deferred listen).

### Step 2: Tests

Subprocess-based, in `test/host.test.mjs` (create; import helpers as needed). Technique: control the `tailscale` binary by putting a fake executable named `tailscale` first on `PATH` in the subprocess env.

1. **Fake tailscale prints an IP** → subprocess running `startServer({host:"tailscale", port:0, ...})` (via `node -e` importing `lib/server.mjs`) logs `outridr listening on 100.` (fake prints e.g. `100.64.0.1`) and stays alive — assert the log then kill it.
2. **Fake tailscale exits 1 every time** (with `HOST_RESOLVE_ATTEMPTS` reachable in reasonable test time — make the constants overridable via env `OUTRIDR_HOST_RESOLVE_ATTEMPTS` / `OUTRIDR_HOST_RESOLVE_DELAY_MS` read with defaults at module top, so tests set attempts=2, delay=50) → process exits 1, stderr mentions `no Tailscale IPv4`.
3. **PATH without tailscale at all** → ENOENT path: exits 1 quickly, stderr mentions `not found`.
4. **Fake tailscale fails twice then prints an IP** (fake script counts invocations via a temp file) → server comes up; stderr shows waiting attempts.

**Verify**: `node --test test/host.test.mjs` → all pass; total runtime < 15 s (tuned via the env-overridable delay).

### Step 3: Document the behavior change

- `README.md` `host` bullet: replace the implicit fallback description with: resolution retries briefly, then exits so the service manager restarts it until Tailscale is up; `outridr serve` in a foreground shell will exit with a clear message.
- Optional comment in the systemd unit template (`lib/service.mjs`) noting that startup-before-tailscaled is handled by exit+`Restart=on-failure`.

**Verify**: `grep -n "127.0.0.1" README.md lib/server.mjs` → the silent-fallback wording/behavior is gone (the literal string may legitimately remain in tests/unrelated code — check each hit).

## Test plan

The four subprocess tests in Step 2; model the subprocess pattern on plan 001's config tests (`test/config.test.mjs`). Verification: `npm test` → all pass including 4 new.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `npm test` exits 0; the 4 host-resolution tests exist and pass
- [ ] `grep -n "falling back to 127.0.0.1" lib/server.mjs` → no matches
- [ ] Existing plan-001 HTTP/WS/session tests pass unchanged (contract of `startServer` preserved)
- [ ] `README.md` documents retry-then-exit for `host: "tailscale"`
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `startServer`'s deferred-listen restructuring breaks plan-001 helpers in a way that requires editing more than the `startTestServer` helper (the public contract was supposed to hold).
- Plan 002 has not landed and its `server.on("error")` edit would conflict — land 002 first or report.
- The operator environment shows `tailscale ip -4` output in a format the `/^\d+\.\d+\.\d+\.\d+$/` filter rejects (e.g. only IPv6) — report rather than loosening the regex blindly.

## Maintenance notes

- **Deferred, worth a future plan**: the Tailscale IP can *change* while the server runs (key expiry, node re-auth); today that means a stale bind until restart. A lightweight periodic re-check that exits (letting the supervisor rebind) when the IP no longer matches would close the loop. Not done now: it adds a restart trigger to a running service and needs operator buy-in.
- Reviewer should scrutinize: `process.exit(1)` inside a promise chain in `startServer` — ensure no test harness leaves orphaned subprocesses (tests must `kill` spawned servers in `finally`).
- If IPv6-only tailnets become a target, add `tailscale ip -6` as a second probe — deliberately out of scope now.
