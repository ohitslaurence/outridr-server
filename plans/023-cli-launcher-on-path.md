# Plan 023: `outridr install` puts the CLI on PATH via a pinned launcher

> **Executor instructions**: Follow step by step. Run every verification
> command and confirm the expected result before moving on. STOP conditions
> halt you. SKIP updating `plans/README.md` — your reviewer maintains it.
>
> **Drift check (run first)**: `git diff --stat 81c9a63..HEAD -- lib/service.mjs bin/outridr.mjs README.md test/service.test.mjs`

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: MED (touches the install/uninstall flow real users run)
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `81c9a63` (v0.5.0), 2026-07-20

## Why this matters

Today `outridr` is only on your PATH via the npm global bin of whatever Node
installed it. Under a per-user version manager (fnm/nvm/mise), that bin dir is
Node-version-specific and shell-auto-switches, so `outridr pair` /
`outridr status` become "command not found" the moment you `cd` into a project
pinned to a different Node — a real footgun hit during a live deployment. The
daemon doesn't have this problem because its systemd/launchd unit pins the
absolute Node path (`process.execPath`) and entrypoint. This plan extends that
same decoupling to the CLI: `outridr install` writes a tiny launcher onto PATH
that execs the pinned Node + entrypoint, so the `outridr` command works from
any directory and any active Node, and `outridr uninstall` removes it. The
launcher is a two-line POSIX shell script the user can read — transparent and
no sudo.

## Current state (verified at 81c9a63)

- `lib/service.mjs`:
  - `SERVE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "outridr.mjs")` (line 21) — absolute path to the CLI entrypoint.
  - `installService()` (lines 26-35) branches to `installSystemd()` (linux) / `installLaunchd()` (darwin), else errors + exits.
  - `uninstallService()` (lines 37-48) tears down the unit per platform.
  - `installSystemd`/`installLaunchd` both already pin `${process.execPath} ${SERVE_ENTRY}` into the unit (lines 67, and the launchd `ProgramArguments`).
  - `xmlEscape` is an exported named function; `run(command, args, allowFailure, inheritOutput)` is the shell helper.
  - Imports at top: `execFileSync` from node:child_process; `mkdirSync, rmSync, writeFileSync` (plus `readFileSync` may need adding) from node:fs; `homedir, platform, userInfo` from node:os; `dirname, join` from node:path.
- `test/service.test.mjs` reads `lib/service.mjs` as source text and asserts on
  `xmlEscape` + a regex count of template usages. It does NOT execute install
  (which would touch the real system), so new launcher tests must be
  filesystem-scoped to a temp dir via an env override (below).
- `bin/outridr.mjs` — the CLI whose `HELP` may mention install behavior.

Conventions: zero deps, stdlib Node, `outridr:`-prefixed logs, named exports,
env-overridable knobs for testability, POSIX-portable. Baseline: 112 tests,
`npm run check` green.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Syntax | `npm run check` (add lib check if needed) | exit 0 |
| Tests | `npm test` | all pass; baseline 112 |
| One file | `node --test test/service.test.mjs` | all pass |

## Scope

**In scope**: `lib/service.mjs` (add launcher install/remove + wire into
install/uninstall + transparent output), `bin/outridr.mjs` (only if a HELP
line needs a mention — optional), `README.md` (document the PATH behavior),
`test/service.test.mjs`.

**Out of scope**: the systemd/launchd unit contents (unchanged), the daemon,
any auto-editing of the user's shell rc files (explicitly forbidden — see
STOP conditions), Windows support, any new dependency.

## Git workflow

- Branch: `advisor/023-cli-launcher-on-path`
- Do NOT push or open a PR unless instructed (your reviewer builds the PR).

## Steps

### Step 1: Add the launcher writer + remover to lib/service.mjs

Add `readFileSync` to the `node:fs` import if not present. Add near the other
path constants:

```js
// The CLI launcher goes in ~/.local/bin (XDG user bin; no sudo). Overridable
// for tests. It's a tiny POSIX shell script that execs the SAME absolute Node
// that ran the install and this package's entrypoint — so `outridr` resolves
// from any directory regardless of which Node a version manager (fnm/nvm) has
// active, exactly like the systemd/launchd unit already does for the daemon.
const CLI_BIN_DIR = process.env.OUTRIDR_BIN_DIR ?? join(homedir(), ".local", "bin");
const CLI_LAUNCHER_PATH = join(CLI_BIN_DIR, "outridr");
const LAUNCHER_MARKER = "# managed by `outridr install` — safe to delete";

export function installCliLauncher() {
  const script = `#!/bin/sh\n${LAUNCHER_MARKER}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SERVE_ENTRY)} "$@"\n`;
  mkdirSync(CLI_BIN_DIR, { recursive: true });
  writeFileSync(CLI_LAUNCHER_PATH, script, { mode: 0o755 });
  const onPath = (process.env.PATH ?? "").split(":").includes(CLI_BIN_DIR);
  console.log(`outridr: CLI available at ${CLI_LAUNCHER_PATH}`);
  if (!onPath) {
    console.log(
      `outridr: ${CLI_BIN_DIR} is not on your PATH — add it so \`outridr\` resolves:\n` +
        `  echo 'export PATH="${CLI_BIN_DIR}:$PATH"' >> ~/.profile   # or your shell's rc, then restart the shell`,
    );
  }
}

export function removeCliLauncher() {
  // Only remove OUR launcher — never clobber an unrelated file a user may
  // have placed at this path.
  let existing;
  try {
    existing = readFileSync(CLI_LAUNCHER_PATH, "utf8");
  } catch {
    return; // nothing there
  }
  if (existing.includes(LAUNCHER_MARKER)) {
    rmSync(CLI_LAUNCHER_PATH, { force: true });
    console.log(`outridr: removed CLI launcher ${CLI_LAUNCHER_PATH}`);
  }
}
```

`JSON.stringify` on the two absolute paths gives correct shell double-quoting
for paths containing spaces. The marker line makes removal safe and tells a
curious user the file is managed.

**Verify**: `npm run check` → exit 0.

### Step 2: Wire into install/uninstall

In `installService()`, after the platform branch calls `installSystemd()` /
`installLaunchd()` succeed, call `installCliLauncher()` (add it once at the end
of `installService`, inside the linux/darwin branches only — not the
unsupported-platform branch which exits). In `uninstallService()`, call
`removeCliLauncher()` in both the linux and darwin branches (after the unit
teardown).

**Verify**: `npm run check` → exit 0; `npm test` → 112 still pass (no test
executes install against the real system, so this doesn't touch anything).

### Step 3: Tests (filesystem-scoped)

In `test/service.test.mjs`, add tests that import `installCliLauncher` /
`removeCliLauncher`, set `process.env.OUTRIDR_BIN_DIR` to a fresh
`mkdtempSync` dir BEFORE importing (the const is read at module load — use a
dynamic `await import("../lib/service.mjs")` after setting the env, mirroring
the env-before-import discipline in `test/push.test.mjs`), and assert:

1. after `installCliLauncher()`: the launcher file exists at
   `<bindir>/outridr`, is executable (mode `& 0o111`), contains
   `process.execPath`, contains `SERVE_ENTRY`'s basename `outridr.mjs`, and
   contains the marker line.
2. `removeCliLauncher()` deletes it.
3. **safety**: write a foreign file (no marker) to `<bindir>/outridr`, call
   `removeCliLauncher()`, and assert the foreign file is STILL there.

**Verify**: `node --test test/service.test.mjs` → all pass (5 existing + 3 new).
Then `npm test` → all pass, state final count.

### Step 4: README

Document, near "Service management", that `outridr install` places the
`outridr` CLI at `~/.local/bin/outridr` (a launcher pinned to the Node that
ran the install, so it works regardless of version managers), that it prints
a PATH hint if `~/.local/bin` isn't on your PATH, and that `outridr uninstall`
removes it. Mention `OUTRIDR_BIN_DIR` to override the location in the
tuning/testing env list.

**Verify**: `grep -c "OUTRIDR_BIN_DIR" README.md` → ≥1; `npm run check` → 0.

## Done criteria

- [ ] `npm run check` exits 0; `npm test` exits 0 with the 3 new tests (state count)
- [ ] `grep -n "installCliLauncher" lib/service.mjs` → defined, exported, called in installService
- [ ] `grep -n "removeCliLauncher" lib/service.mjs` → defined, exported, called in uninstallService
- [ ] the launcher content execs `process.execPath` (not `env node`) — grep the writer
- [ ] `removeCliLauncher` only deletes a file containing the marker (safety test passes)
- [ ] `git status` clean outside scope

## STOP conditions

- You find yourself editing the user's shell rc (`~/.zshrc`/`~/.bashrc`/
  `~/.profile`) from code — DO NOT. Printing an instruction is the whole
  design; silently mutating rc files is the unsafe thing this plan avoids.
- The env-before-import trick doesn't isolate `OUTRIDR_BIN_DIR` (the const is
  frozen at module load) — if you can't scope the tests to a temp dir, STOP
  and report rather than writing to the real `~/.local/bin` in a test.
- Adding `installCliLauncher()` to `installService` somehow runs during a test
  that calls the real install — it shouldn't (no test calls installService);
  if one does, report.

## Maintenance notes

- The launcher pins `process.execPath` at install time, matching the daemon
  unit. If the user later removes that exact Node (e.g. `fnm uninstall`), both
  the launcher and the unit break — re-running `outridr install` under a
  present Node fixes both. This is the intended trade (decouple from the
  *active* Node, pin the *install-time* Node); a self-contained binary would
  remove the Node dependency entirely but conflicts with the zero-dep,
  stdlib-only build and is deliberately out of scope.
- macOS note: `~/.local/bin` is often not on PATH there by default, so the
  printed hint matters more on darwin. Do not special-case /usr/local/bin
  (needs sudo) — keep it uniform and let the hint guide the user.
- This changes what `outridr install` does; the CHANGELOG for the next release
  should note "install now puts the CLI on PATH at ~/.local/bin."
- Operator follow-up already applied by hand on the `gondor` host: a launcher
  of exactly this shape was written to `~/.local/bin/outridr`; once this ships
  and `outridr install` is re-run there, it becomes the managed version.
