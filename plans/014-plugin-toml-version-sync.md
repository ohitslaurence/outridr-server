# Plan 014: Enforce herdr-plugin.toml version sync in CI and the release workflow

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6245d2f..HEAD -- .github/workflows package.json herdr-plugin.toml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `6245d2f`, 2026-07-20

## Why this matters

The repo carries its version in two files: `package.json` (`0.3.0`) and
`herdr-plugin.toml` (`version = "0.3.0"`, consumed by `herdr plugin install`).
The release workflow verifies the git tag against `package.json` but never
looks at the toml, so a routine version bump that forgets the toml ships a
plugin manifest advertising a stale version — exactly the kind of silent skew
a two-line check prevents forever. The check should run in CI too, so the
drift is caught on the PR that introduces it, not at tag time.

## Current state

- `herdr-plugin.toml:3` — `version = "0.3.0"`.
- `package.json` — `"version": "0.3.0"`; `scripts` block currently:

```json
  "scripts": {
    "serve": "node bin/outridr.mjs serve",
    "check": "node --check bin/outridr.mjs && node --check lib/config.mjs && ...",
    "test": "node --test test/*.test.mjs",
    "prepublishOnly": "npm run check && npm test"
  }
```

(If plan 012 landed, `check` also contains `lib/transcribe.mjs` — irrelevant
here; you are appending a new script, not editing `check`.)

- `.github/workflows/release.yml` — tag-triggered publish; the existing guard
  step this plan extends:

```yaml
      - name: Tag must match package.json version
        run: node -e "const v=require('./package.json').version; const t=process.env.GITHUB_REF_NAME; if (t !== 'v'+v) { console.error('tag '+t+' != package version '+v); process.exit(1); }"
```

- `.github/workflows/ci.yml` — matrix (node 20/22 × ubuntu/macos) running
  `npm run check` then `npm test`.

Conventions: zero dependencies — no TOML parser; the toml is hand-written and
its version line is exactly `version = "x.y.z"` at column 0, so an anchored
regex is the right tool. Inline `node -e` one-liners are the established
pattern for workflow guards (see the excerpt above).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| New sync check | `npm run check:versions` | exit 0 |
| Existing checks | `npm run check && npm test` | exit 0, all pass |

## Scope

**In scope**:
- `package.json` (add one script)
- `.github/workflows/ci.yml` (add one step)
- `.github/workflows/release.yml` (add one step)

**Out of scope**:
- `herdr-plugin.toml` itself — versions currently match; nothing to fix.
- The `prepublishOnly` guard — publishing goes through the release workflow,
  which will run the new check; keep `prepublishOnly` as is.
- Any restructuring of the workflows (matrix, npm upgrade step, publish step).

## Git workflow

- Branch: `advisor/014-plugin-toml-version-sync`
- One commit, imperative summary (e.g. "Enforce herdr-plugin.toml version
  sync in CI and release").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a check:versions script

In `package.json` scripts, after `"check"`, add:

```json
    "check:versions": "node -e \"const {readFileSync}=require('node:fs'); const v=require('./package.json').version; const m=readFileSync('herdr-plugin.toml','utf8').match(/^version = \\\"(.+)\\\"$/m); if(!m||m[1]!==v){console.error('herdr-plugin.toml version '+(m?m[1]:'<missing>')+' != package.json '+v); process.exit(1);}\"",
```

Mind the JSON escaping: the regex's quote marks are `\\\"` inside the
package.json string. If the escaping fights you, an equivalent standalone
guard is acceptable, but do not add a file outside the scope list — the
one-liner must live in package.json.

**Verify**: `npm run check:versions` → exit 0, no output.
Negative check: `sed -i.bak 's/^version = ".*"/version = "9.9.9"/' herdr-plugin.toml && npm run check:versions; mv herdr-plugin.toml.bak herdr-plugin.toml`
→ the check exits non-zero and prints both versions, and the toml is restored
afterward (`git status` clean for herdr-plugin.toml).

### Step 2: Run it in CI

In `.github/workflows/ci.yml`, add a step after `- run: npm run check`:

```yaml
      - run: npm run check:versions
```

**Verify**: `node -e "require('node:fs').readFileSync('.github/workflows/ci.yml','utf8').includes('check:versions') || process.exit(1)"` → exit 0.
(No YAML parser needed; indentation must match the surrounding steps — two
spaces deeper than `steps:`.)

### Step 3: Run it in the release workflow

In `.github/workflows/release.yml`, add the same step immediately after the
"Tag must match package.json version" step:

```yaml
      - run: npm run check:versions
```

**Verify**: `grep -c "check:versions" .github/workflows/release.yml` → 1.

## Test plan

No `node:test` additions — this is CI plumbing. The verification gates are:

- `npm run check:versions` passes on the current tree.
- The step-1 negative check fails as described (proves the guard actually
  guards).
- `npm run check && npm test` still pass (nothing else disturbed).

## Done criteria

- [ ] `npm run check:versions` exits 0
- [ ] Temporarily mismatched toml version makes it exit non-zero (step 1's
      negative check), and the toml is restored
- [ ] Both workflow files contain a `check:versions` step
- [ ] `git status` shows only package.json and the two workflow files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `herdr-plugin.toml`'s version line is no longer of the exact form
  `version = "x.y.z"` at the start of a line — the regex assumption is false;
  report instead of loosening the regex silently.
- The JSON-escaped one-liner cannot be made to pass both the positive and
  negative checks after two attempts.

## Maintenance notes

- Release cadence now requires bumping BOTH `package.json` and
  `herdr-plugin.toml` before tagging — which is the point; the failure mode
  changes from "silently stale manifest" to "red CI on the bump PR".
- If more versioned artifacts appear (e.g. a second manifest), extend the same
  one-liner rather than adding a parallel script.
