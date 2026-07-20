# Plan 016: Built-in git repo discovery; remove /exec and command-based /repos

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 017a618..HEAD -- lib/config.mjs lib/server.mjs package.json herdr-plugin.toml README.md test/http.test.mjs`
> Expected drift: NONE. Mismatch = STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (removes a public endpoint — breaking for /exec users;
  mitigated by version bump + README migration note; the operator's own
  client stops using /exec in a same-day companion change)
- **Depends on**: none
- **Category**: direction (generalize beyond the operator's personal CLI)
- **Planned at**: commit `017a618`, 2026-07-20

## Why this matters

`/exec` and `/repos` currently shell out to a configured binary — in
practice the operator's personal `dev` CLI. The config file itself labels
them "workflow-specific". For outridr to be installable by strangers, repo
discovery must be built in (scan configured root folders for git repos) and
the run-a-binary-with-client-args endpoint must go away entirely: the
outridr app now performs task creation through herdr's native
`worktree.create`/`agent.start` over the WS passthrough, so the server no
longer needs any exec capability. Removing `/exec` also deletes the
riskiest surface in the product (a network-reachable argv runner) before a
general release.

## Current state

- `lib/config.mjs` — full file is ~70 lines; the doc-comment (lines 1-17)
  documents `"exec": { "command": ... }` and `"repos": { "command": [...] }`.
  `loadConfig()` returns `exec` and `repos` command fields (lines ~59-64):

  ```js
  exec: file.exec?.command
    ? { command: expandHome(file.exec.command) }
    : null,
  repos: file.repos?.command
    ? { command: (Array.isArray(file.repos.command) ? file.repos.command : [file.repos.command]).map(expandHome) }
    : null,
  ```

- `lib/server.mjs:206-252` — the two routes:
  - `GET /repos` (line 206): `execFile(config.repos.command...)`, parses
    stdout JSON, replies `{ repos }` (empty list on any failure).
  - `POST /exec` (line 222): validates `{args: string[]}` (MAX_EXEC_ARGS,
    length < 200 each), `execFile(config.exec.command, args, ...)`, replies
    `{ code, stdout, stderr }`.
  - Constants `MAX_EXEC_ARGS` / `EXEC_TIMEOUT_MS` near the top of the file;
    `execFile` is imported from `node:child_process` alongside
    `execFileSync` (which the tailscale probe still needs — keep it).
  - The startup log line (~line 62) prints
    `exec: ... | repos: enabled/disabled` — update it.
- `test/http.test.mjs` — `node:test` suite with helpers
  (`startTestServer(configOverrides)`, `makeTmpDir(prefix)`, `getJson`,
  `postJson`). Existing `/exec` tests at lines ~221-260 and `/repos` tests
  nearby — read them before editing; they get REPLACED, not extended.
- `package.json` — `"version": "0.3.0"`; the `check` script is an explicit
  `node --check` list of every lib file (a new lib file must be added
  there); `check:versions` asserts `herdr-plugin.toml` version matches
  package.json — bump BOTH to `0.4.0`.
- `README.md` — documents the config keys and endpoints; grep for `exec`
  and `repos` and update every occurrence.
- Zero-dependency rule: node stdlib only (`node:fs/promises`, `node:path`).
  ESM (`type: module`). No new packages.
- The outridr app's `GET /repos` consumer expects exactly
  `{ repos: [{ alias: string, path: string }] }` — the response shape is a
  compatibility contract; only its SOURCE changes.

## Commands you will need

| Purpose  | Command                  | Expected on success        |
| -------- | ------------------------ | -------------------------- |
| Syntax   | `npm run check`          | exit 0                     |
| Versions | `npm run check:versions` | exit 0                     |
| Tests    | `npm test`               | all pass                   |

(This repo uses npm, not pnpm. No install step is needed — zero deps.)

## Scope

**In scope**:

- `lib/repos.mjs` (create)
- `test/repos.test.mjs` (create)
- `lib/config.mjs` (repos.roots parsing; drop exec; doc-comment update)
- `lib/server.mjs` (replace /repos implementation; delete /exec route +
  its constants; startup log line)
- `test/http.test.mjs` (replace exec/repos route tests)
- `README.md` (config + endpoint docs, migration note)
- `package.json` + `herdr-plugin.toml` (version 0.4.0; add lib/repos.mjs
  to the `check` script)

**Out of scope** (do NOT touch):

- `lib/websocket.mjs`, `lib/herdr.mjs`, `lib/session.mjs`, `lib/push.mjs`,
  `lib/service.mjs`, `bin/outridr.mjs` (unless `bin` references exec —
  grep first; if it does, report in NOTES with the minimal removal).
- Any other plan file; `plans/015-*.md` is another initiative.

## Git workflow

- Branch: create `advisor/016-native-repo-scan` (this repo's convention —
  see prior `advisor/*` merges in `git log`).
- One commit: `Replace exec/command repos with built-in git repo scanning`
  with a short body noting the breaking change and the 0.4.0 bump.

## Steps

### Step 1: `lib/repos.mjs`

```js
/**
 * Built-in repo discovery: scan configured root folders for git repos so
 * the app can offer them for new tasks — no external CLI involved. A repo
 * is any directory containing `.git` (directory or file — linked worktrees
 * and submodule checkouts use a gitfile). Scanning stops at a repo: nested
 * repos inside a checkout are the repo's own business.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
```

Export `async function scanRepos(roots, depth = 2)`:

- For each root (missing/unreadable roots are skipped silently — a
  misconfigured root must not 500 the endpoint): breadth-first directory
  walk to `depth` levels below the root.
- Skip entries starting with `.` and the names `node_modules`.
- A directory containing `.git` (check via `stat(join(dir, ".git"))` in a
  try/catch — both file and directory count) is a repo: record it, do not
  descend into it.
- Alias: `basename(path)`; if two repos share a basename, disambiguate
  BOTH as `${basename(parentDir)}/${basename(path)}`.
- Return `[{ alias, path }]` sorted by alias.

Also export `function createRepoCache(scan, ttlMs = 30_000)` returning
`{ get(roots, depth) }` that memoizes the last scan result for `ttlMs`
(single-entry cache keyed on `JSON.stringify([roots, depth])`; a changed
key or expired TTL rescans). Inject `Date.now` optionally for tests.

### Step 2: `test/repos.test.mjs`

`node:test` + `makeTmpDir` (import from `./helpers.mjs`). Cases:

1. Finds a repo (`root/a/.git/` as directory) and a gitfile repo
   (`root/b/.git` as plain file) → both listed, sorted, correct paths.
2. Respects depth: `root/x/y/repo/.git` found at depth 2 params, NOT found
   with `depth = 1`.
3. Does not descend into repos: `root/a/.git` + `root/a/vendor/inner/.git`
   → only `a` listed.
4. Skips hidden dirs and `node_modules`.
5. Basename collision → both disambiguated with parent prefix.
6. Missing root → empty result, no throw.
7. Cache: two `get` calls within TTL scan once (count via injected scan
   spy); after TTL advances (injected clock), rescans.

**Verify**: `npm test` → new suite passes.

### Step 3: Config

In `lib/config.mjs`: `repos` becomes

```js
repos: Array.isArray(file.repos?.roots) && file.repos.roots.length > 0
  ? { roots: file.repos.roots.map(expandHome), depth: file.repos.depth ?? 2 }
  : null,
```

Delete the `exec` field entirely. If the loaded file contains `exec` or
`repos.command`, print ONE clear `console.error` warning naming the removed
key and pointing at the README migration note (do not exit). Update the
doc-comment: `"repos": { "roots": ["~/Development"], "depth": 2 }`.

**Verify**: `npm run check` → exit 0.

### Step 4: Routes

In `lib/server.mjs`:

- Replace the `/repos` handler body: `repoCache.get(config.repos.roots, config.repos.depth)`
  (module-level `const repoCache = createRepoCache(scanRepos)`) →
  `sendJson(res, 200, { repos })`; on scan rejection reply
  `sendJson(res, 200, { repos: [] })` (parity with today's fail-soft).
  Disabled (`config.repos` null) still falls through to 404.
- Delete the `POST /exec` route, `MAX_EXEC_ARGS`, `EXEC_TIMEOUT_MS`, and
  the `execFile` import if now unused (`execFileSync` stays for the
  tailscale probe).
- Startup log: replace the `exec: ... | repos: ...` fragment with
  `repos: <n roots>/disabled`.

**Verify**: `npm run check` → exit 0.

### Step 5: Route tests

In `test/http.test.mjs`: delete the `/exec` tests; replace `/repos` tests
with: disabled → 404; configured roots (tmp dir with two fake repos) → 200
with the expected `{ repos: [{alias, path}] }`; `POST /exec` now → 404
(one regression test that the endpoint is GONE).

**Verify**: `npm test` → all suites pass.

### Step 6: Docs + version

- README: update the config example and endpoint list; add a short
  "Migrating from 0.3.x" note: `/exec` removed (the app now uses herdr's
  native worktree/agent APIs over `/herdr`), `repos.command` →
  `repos.roots`.
- `package.json` + `herdr-plugin.toml` → `0.4.0`; add `lib/repos.mjs` to
  the `check` script's file list.

**Verify**: `npm run check` → exit 0; `npm run check:versions` → exit 0;
`npm test` → all pass; `grep -rn "exec" lib/ | grep -v execFileSync` →
no remaining exec-endpoint code (report any hits).

## Test plan

Steps 2 and 5. Model on the existing suites (`test/http.test.mjs` /
`test/push.test.mjs` show the startTestServer + tmp-dir patterns).

## Done criteria

- [ ] `npm run check`, `npm run check:versions`, `npm test` all exit 0
- [ ] `POST /exec` returns 404 (test proves it)
- [ ] `GET /repos` serves scanned repos from `repos.roots` config
- [ ] README documents the new config and the migration
- [ ] `git status --short` clean after commit; only in-scope files changed

## STOP conditions

- Drift check fails.
- `bin/outridr.mjs` turns out to have deep exec coupling beyond a grep-level
  mention (report what you find; don't restructure the CLI).
- The response-shape contract (`{repos:[{alias,path}]}`) would need to
  change for any reason.

## Maintenance notes

- The app-side companion (herdr-mobile plan 017) deletes its `/exec`
  client the same day — coordinate release order loosely: server 0.4.0 can
  deploy first (the old app's exec-based new-task breaks only at that
  moment; the operator accepts this for their own device).
- A future "set roots from the app" onboarding endpoint (PUT, token-gated)
  should reuse `scanRepos` and write `repos.roots` back to the config file
  — design deliberately deferred; see the onboarding plan when it exists.
- If scanning ever needs to cross network mounts or huge trees, add an
  ignore list to config rather than cleverness in the scanner.
