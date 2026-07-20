# Plan 017: GET/PUT /repos/roots — remote repo-roots configuration for onboarding

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ac8cab6..HEAD -- lib/config.mjs lib/server.mjs lib/repos.mjs test/http.test.mjs test/repos.test.mjs README.md`
> Expected drift: NONE. Mismatch = STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (first endpoint that WRITES server config; mitigated by the
  403-without-token rule, path validation, and atomic file writes)
- **Depends on**: plan 016 (DONE — `lib/repos.mjs`, `repos.roots` config)
- **Category**: direction (onboarding — herdr-mobile plan 019 companion)
- **Planned at**: commit `ac8cab6`, 2026-07-20

## Why this matters

The outridr app's onboarding (herdr-mobile plan 019) lets a new user
configure which folders get scanned for repos — from the phone, in the
setup flow, with a live "found N repos" preview. That requires the server
to expose its `repos.roots` config: read always, write token-gated.
Operator decisions (2026-07-20): PUT requires a configured token — a
tokenless server refuses config writes with 403 and a message naming the
config key; reads follow normal auth.

## Current state

- `lib/server.mjs:146-149` — every HTTP route already passes one
  `authorized(config, req, url)` gate (401 on mismatch; tokenless servers
  pass it trivially). New routes inherit this; PUT adds its own check on
  top.
- `lib/repos.mjs` (plan 016) — `scanRepos(roots, depth)` +
  `createRepoCache(scan, ttlMs)`; `lib/server.mjs` holds a module-level
  `repoCache` used by `GET /repos`.
- `lib/config.mjs` — `loadConfig()` reads `CONFIG_PATH`
  (`~/.config/outridr/config.json` or `$OUTRIDR_CONFIG`), returns a plain
  object; `config.repos` is `{ roots, depth }` or `null`; `config.token`
  is string or null; `expandHome` exported. The config object is loaded
  once at startup and passed by reference into `startServer` — mutating
  `config.repos` at runtime is visible to subsequent requests (verify this
  by reading how `startServer`/`handleHttp` receive `config`; if any route
  re-loads config per request, STOP and report).
- Route helpers: `sendJson(res, status, payload)`, `readBody(req, cb)`
  (`lib/http-util.mjs`). Body-size cap exists in `readBody`.
- Test helpers: `startTestServer(configOverrides)` — check `test/helpers.mjs`
  for how it builds the config file/env; the PUT tests need a REAL temp
  config file path (`OUTRIDR_CONFIG` env) so writes can be asserted.
  If `startTestServer` doesn't currently thread a config-file path, extend
  `test/helpers.mjs` minimally (add it to the in-scope list in your report).
- Repo conventions: zero-dep node stdlib ESM; `npm run check` lists every
  lib file; tests via `node:test`.

## Endpoint contract (the mobile app builds against exactly this)

- `GET /repos/roots` → `200 { roots: string[] }` — always available (empty
  array when unconfigured). Normal auth (401 on bad token).
- `PUT /repos/roots` body `{ roots: string[] }`:
  - `403 { error: "config-token-required", message: "Set a token in ~/.config/outridr/config.json (or OUTRIDR_TOKEN) to allow remote config changes" }`
    when `config.token` is null — BEFORE any validation.
  - `400` with `{ error: "invalid-roots", message }` when: not an array;
    > 16 entries; any entry not a non-empty string < 512 chars; any
    expanded entry is not an absolute-or-`~/` path; any expanded entry is
    not an existing directory on the server (message names the failing
    entry).
  - `200 { roots: string[], repos: [{alias, path}] }` on success: expanded
    roots are persisted, the in-process config updated, the repo cache
    invalidated, and a fresh scan returned (one round-trip for the app's
    live preview).
  - Depth is NOT settable remotely — file-only tuning.

## Commands you will need

| Purpose  | Command                  | Expected on success |
| -------- | ------------------------ | ------------------- |
| Syntax   | `npm run check`          | exit 0              |
| Versions | `npm run check:versions` | exit 0              |
| Tests    | `npm test`               | all pass            |

## Scope

**In scope**:

- `lib/server.mjs` (two routes)
- `lib/config.mjs` (add `saveRepoRoots(config, roots)` — validation +
  atomic write + in-process update; or a new small `lib/config-write.mjs`
  if config.mjs would double in size — your call, name it in the report)
- `test/http.test.mjs` (route tests)
- `test/helpers.mjs` (ONLY if the config-file path needs threading)
- `README.md` (endpoint docs + the token-required-for-writes note)
- `package.json` `check` script (only if a new lib file is added)

**Out of scope** (do NOT touch):

- `lib/repos.mjs` scanning logic (cache invalidation uses its existing
  surface — if the cache lacks an invalidation method, add `invalidate()`
  to `createRepoCache` and note it).
- Version bump — 0.4.x stays; the operator decides when to cut 0.5.0.
- Any depth/remote-token configuration.

## Git workflow

- Branch: create `advisor/017-repo-roots-endpoints` from `ac8cab6`.
- One commit: `Add GET/PUT /repos/roots for app-driven onboarding`

## Steps

### Step 1: Config write helper

`saveRepoRoots(config, rawRoots)` (async):

1. Validate per the contract (return a typed error object
   `{ ok: false, status, error, message }` rather than throwing — routes
   translate it).
2. Expand each entry via `expandHome`; `stat` each — must be a directory.
3. Read the current config FILE (`CONFIG_PATH` / `$OUTRIDR_CONFIG`; treat
   missing file as `{}`; a file that exists but fails to parse → error
   `{ status: 500, error: "config-unreadable" }` — do NOT clobber a file
   the operator hand-edited into a broken state).
4. Set `file.repos = { ...file.repos, roots: <expanded> }` (preserve an
   existing `depth` and every unknown key elsewhere in the file).
5. Atomic write: write to `CONFIG_PATH + ".tmp"`, `rename` over the
   original. Mode 0600 for the new file (config may hold the token).
6. Update the in-process object: `config.repos = { roots: <expanded>, depth: config.repos?.depth ?? 2 }`.
7. Return `{ ok: true, roots: <expanded> }`.

**Verify**: `npm run check` → exit 0.

### Step 2: Routes in `lib/server.mjs`

- `GET /repos/roots` → `sendJson(res, 200, { roots: config.repos?.roots ?? [] })`.
- `PUT /repos/roots` → the 403-without-token check first, then `readBody`
  → JSON parse (400 on garbage) → `saveRepoRoots` → on ok: invalidate the
  repo cache, run a fresh scan via the cache, reply
  `{ roots, repos }`; on error object: reply with its status/payload.
- Startup log line: extend the `repos:` fragment or leave — your call.

**Verify**: `npm run check` → exit 0.

### Step 3: Tests (`test/http.test.mjs`)

1. `GET /repos/roots` unconfigured → `{ roots: [] }`.
2. `GET /repos/roots` with roots configured → the expanded roots.
3. `PUT` on a TOKENLESS server → 403 with `error: "config-token-required"`;
   config file untouched (assert file content unchanged).
4. `PUT` with token configured + correct bearer header + valid roots
   (tmp dirs) → 200, response carries `roots` (expanded) and `repos`
   (scan finds a planted fake repo); the config FILE now contains the
   roots; a subsequent `GET /repos` serves the new scan (cache
   invalidated).
5. `PUT` with an entry that is not an existing directory → 400 naming the
   entry; file untouched.
6. `PUT` preserving unknown config keys: seed the config file with
   `{"token": "...", "custom": {"keep": true}}` → after PUT, `custom` and
   `token` survive in the file.
7. `PUT` with wrong bearer token → 401 (the global gate, existing
   behavior).

**Verify**: `npm test` → all pass.

### Step 4: README

Document both endpoints in the endpoint table + a short "Remote
configuration" paragraph: reads open (normal auth), writes require a
configured token, and why (the 403 message text matches).

**Verify**: `npm run check && npm run check:versions && npm test` → all
exit 0.

## Test plan

Step 3. Model on the existing `/repos` and `/push/register` tests.

## Done criteria

- [ ] All three gate commands exit 0
- [ ] The seven test cases above exist and pass
- [ ] Tokenless PUT provably leaves the config file byte-identical
- [ ] Unknown config keys survive a write (test 6)
- [ ] `git status --short` clean after commit; only in-scope files (+ any
      declared additions)

## STOP conditions

- Drift check fails.
- Config turns out to be re-loaded per request (in-process mutation
  wouldn't stick) — report how it actually flows.
- `startTestServer` can't be extended to a real config file without
  restructuring the helpers.

## Maintenance notes

- The mobile companion (herdr-mobile plan 019) builds against the contract
  block above verbatim — if implementation forced any deviation, the
  reviewer must update that plan BEFORE it executes.
- If a second writable config key ever appears, generalize to
  `PATCH /config` with an allowlist — don't accrete per-key endpoints past
  two.
- The 0600 chmod on rewrite tightens permissions on configs created looser
  by hand; intentional.
