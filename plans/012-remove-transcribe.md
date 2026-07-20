# Plan 012: Remove the /transcribe endpoint and all Groq code

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6245d2f..HEAD -- lib/transcribe.mjs lib/server.mjs lib/config.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `6245d2f`, 2026-07-20

## Why this matters

`POST /transcribe` (added in commit `6245d2f`) proxied audio from the outridr
mobile app to Groq's Whisper API so the API key stayed on the server machine.
The operator has confirmed the app now calls Groq directly, so this endpoint
is dead code — and it is the worst kind of dead code: an untested,
undocumented network endpoint holding an API-key config path. Removing it
deletes the repo's only third-party egress besides Expo push, shrinks the
audit surface the README's zero-dependency pitch is built on, and closes the
2026-07-20 audit findings (no tests, no docs, no fetch timeout, broken 413
flush, config edge case) by making them moot.

## Current state

The feature touches exactly three files. It was never documented in
`README.md`, never listed in `package.json`'s `check` script, never tested,
and never mentioned in `bin/outridr.mjs` or `herdr-plugin.toml` — so those
files need no edits (verified at `6245d2f` via
`grep -rni "transcribe\|groq"`).

- `lib/transcribe.mjs` — the entire endpoint implementation (87 lines).
  Delete the whole file.
- `lib/server.mjs` — one header-comment line, one import, one route block:

  Line 13 (inside the module docblock's opt-in endpoint list):
  ```
   *   POST /transcribe      → proxy raw audio to Groq Whisper → {text}
  ```

  Line 30 (import):
  ```js
  import { serveTranscribe } from "./transcribe.mjs";
  ```

  Lines 224–227 (route, between the `/repos` and `/exec` blocks in
  `handleHttpUnsafe`):
  ```js
    if (req.method === "POST" && url.pathname === "/transcribe" && config.groq) {
      serveTranscribe(config, req, res);
      return;
    }
  ```

- `lib/config.mjs` — one header-comment line and the `groq` slice:

  Line 12 (inside the docblock's example config):
  ```
   *   "groq":  { "apiKey": "gsk_...", "model": "whisper-large-v3-turbo" }, // POST /transcribe
  ```

  Lines 66–72 (property in `loadConfig`'s returned object, between `repos:`
  and `push:`):
  ```js
      groq:
        process.env.OUTRIDR_GROQ_API_KEY || file.groq?.apiKey
          ? {
              apiKey: process.env.OUTRIDR_GROQ_API_KEY ?? file.groq.apiKey,
              model: file.groq?.model ?? "whisper-large-v3-turbo",
            }
          : null,
  ```

Conventions: this repo removes features cleanly — no commented-out code, no
"removed" tombstone comments. A deleted feature leaves zero trace in source.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Syntax check | `npm run check` | exit 0 |
| Tests | `npm test` | 73 pass, 0 fail |
| Trace sweep | `grep -rni "transcribe\|groq" bin lib test README.md package.json herdr-plugin.toml .github` | no matches |

No install step — the project has zero dependencies.

## Scope

**In scope** (the only files you should modify):
- `lib/transcribe.mjs` (delete)
- `lib/server.mjs` (remove the three excerpted spots only)
- `lib/config.mjs` (remove the two excerpted spots only)

**Out of scope**:
- `test/` — no test references transcribe or groq; nothing to remove, and no
  removal test is needed (a deleted route returning 404 is default behavior
  already covered by the existing 404 test in `test/http.test.mjs`).
- `README.md`, `package.json`, `bin/outridr.mjs`, `herdr-plugin.toml`,
  `.github/` — verified free of transcribe/groq references; do not edit.
- The `plans/` directory except your own status row in `plans/README.md`.

## Git workflow

- Branch: `advisor/012-remove-transcribe`
- One commit, imperative summary matching repo style, e.g.
  "Remove POST /transcribe — the app now calls Groq directly". Use `git rm`
  for the deleted file.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Delete the module

`git rm lib/transcribe.mjs`

**Verify**: `ls lib/` → no `transcribe.mjs`.

### Step 2: Remove the route from lib/server.mjs

Remove the three excerpted spots: docblock line 13, the import at line 30,
and the route block at lines 224–227. Leave the surrounding `/repos` and
`/exec` blocks and their blank-line separation untouched.

**Verify**: `npm run check` → exit 0 (this fails on a dangling import, so it
proves the import removal too).

### Step 3: Remove the groq config slice from lib/config.mjs

Remove docblock line 12 and the `groq:` property (lines 66–72). The returned
object goes straight from `repos:` to `push:`.

**Verify**: `npm run check` → exit 0.

### Step 4: Sweep and run the suite

**Verify**:
`grep -rni "transcribe\|groq" bin lib test README.md package.json herdr-plugin.toml .github` → no matches.
`npm test` → 73 pass, 0 fail.

## Test plan

No new tests. The full existing suite (73 tests) must pass unchanged — none
of them reference the removed feature, so any failure means the removal
touched something it shouldn't have.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `lib/transcribe.mjs` does not exist
- [ ] `grep -rni "transcribe\|groq" bin lib test README.md package.json herdr-plugin.toml .github` → no matches
- [ ] `npm run check` exits 0
- [ ] `npm test` exits 0 with 73 passing tests
- [ ] `git status` shows only the deletion and the two edited lib files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows the excerpted code has changed — in particular if
  plans 012/013 in their *earlier, withdrawn* form were somehow executed
  (signs: `lib/transcribe.mjs` mentions `OUTRIDR_GROQ_URL`, a
  `test/transcribe.test.mjs` exists, or the README documents `/transcribe`).
  The removal is then wider than this plan's scope list, and the plan must be
  refreshed rather than improvised around.
- The step-4 grep finds transcribe/groq references in files outside the scope
  list.
- Any of the 73 existing tests fail after the removal.

## Maintenance notes

- Old app builds that still call `POST /transcribe` will get a 404 after this
  lands; the operator has confirmed the app calls Groq directly now, so this
  is intended. No deprecation window on a single-operator tailnet service.
- Operator config files in the wild may still contain a `"groq"` key —
  `loadConfig` ignores unknown keys, so it is harmless; operators can prune
  it at leisure.
- If server-side transcription ever comes back, prefer a local-command design
  (`transcribe.command`, piping audio to e.g. whisper.cpp) over reintroducing
  a cloud-key proxy — see the direction note in `plans/README.md`.
