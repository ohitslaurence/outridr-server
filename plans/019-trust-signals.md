# Plan 019: Trust signals (SECURITY.md, workflow pinning, releases, doc rot)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> any STOP condition occurs, stop and report. When done, update this plan's
> row in `plans/README.md` — unless a reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 3488f44..HEAD -- .github/ README.md lib/service.mjs SECURITY.md`

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none (independent of 015/018)
- **Category**: dx + docs + security
- **Planned at**: commit `3488f44` (v0.4.1), 2026-07-20 (from a cold-context
  trust audit of the public repo)

## Why this matters

The code is well-engineered but the repo is missing the externally-visible
trust artifacts that a security-conscious adopter and an AI assistant both
check before recommending a tool that, by design, can drive your coding
agents. None of these change runtime behavior; all of them change whether a
stranger trusts the project. Each is independently shippable.

## Current state (verified at 3488f44)

- **No `SECURITY.md`** (GitHub community profile confirms). The README
  "Security model" section (README.md around line 171) is honest and is the
  seed for it.
- **`.github/workflows/ci.yml`**: actions pinned by mutable tag
  (`actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`),
  no top-level `permissions:` block.
- **`.github/workflows/release.yml`**: same tag-pinning; `permissions:` has
  `contents: read` + `id-token: write` (good, keep); runs
  `npm install -g npm@latest` (unpinned) inside the OIDC-privileged job.
- **Tags**: `v0.2.0`–`v0.4.1` are lightweight and unsigned, though all
  commits are GPG-signed. No GitHub Releases, no CHANGELOG.
- **Doc rot**: `lib/service.mjs:67-68` systemd unit comment still says PATH is
  for "configured exec/repos commands" — `exec` and `repos.command` were
  removed in 0.4.0. `README.md:21` hardcodes "76 tests" (actual is 83 at
  v0.4.1, and it will keep drifting).
- **`plans/README.md`** openly notes plans were generated and executed by AI
  agents non-interactively with human review — good transparency, currently
  unframed for outside readers.
- **npm**: `outridr@0.2.0` predates trusted publishing (manual publish);
  0.3.0+ carry OIDC/SLSA provenance.

Conventions: `node -e` one-liners for CI guards (see the existing version
check in release.yml); comments explain *why*.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests (for the count) | `npm test` | note the `# tests N` line |
| Syntax | `npm run check` | exit 0 |
| Actions SHA lookup | `gh api repos/<owner>/<action>/git/refs/tags/<tag> --jq .object.sha` (or the commit the tag points to) | a 40-char SHA |

## Scope

**In scope**: `SECURITY.md` (create), `.github/workflows/ci.yml`,
`.github/workflows/release.yml`, `lib/service.mjs` (the stale comment only),
`README.md` (test-count line + a short "How this project is developed" note),
`CHANGELOG.md` (create). No source-logic changes.

**Out of scope**: any `lib/` behavior, the version numbers, branch protection
and CodeQL (dashboard/admin actions the operator does, listed in the handoff
note below, not files).

## Git workflow

- Branch: `advisor/019-trust-signals`
- One commit per artifact is fine.
- Do NOT push, tag, or publish.

## Steps

### Step 1: SECURITY.md

Create `SECURITY.md` seeded from the README security model, adding what the
code does but the docs don't yet state. Include:

- **Reporting**: a private channel — GitHub private vulnerability reporting
  (Security tab → Report a vulnerability) as the primary, plus the maintainer
  contact if the operator wants one. (Leave a `TODO(owner)` if unsure; do not
  invent an email.)
- **Supported versions**: latest minor only (state it).
- **Threat model**, stated plainly: the tailnet is the perimeter; anyone who
  can reach the server can drive your agents; the optional token is
  defense-in-depth. Name the specific assumptions the audit surfaced:
  - a tokenless server accepts push-token register/unregister from any
    tailnet peer (an attacker could receive your agent notifications or drop
    them);
  - `GET /repos/roots` discloses configured root paths (home-dir structure);
  - `PUT /repos/roots` requires a token (blast-radius control).
- **Hardening guidance for operators**: set a token; keep tailnet ACLs tight;
  never bind `0.0.0.0` on a public interface.

**Verify**: `test -f SECURITY.md && echo ok`.

### Step 2: Pin workflow actions to SHAs + add permissions

In both workflow files, replace each `uses: <action>@<tag>` with
`uses: <action>@<40-char-sha> # <tag>` (look each up with `gh api` per the
command table; keep the human-readable tag in a trailing comment). Add a
top-level `permissions: { contents: read }` to `ci.yml`. In `release.yml`,
pin the npm version: replace `npm install -g npm@latest` with a specific
version that supports trusted publishing (`npm@11.5.1` or newer — state the
one you pick), keeping the existing comment about why the upgrade is needed.

**Verify**: `grep -nE "uses: .*@[0-9a-f]{40}" .github/workflows/*.yml` shows
every action pinned; `grep -n "permissions:" .github/workflows/ci.yml` → present.

### Step 3: CHANGELOG + release-notes automation

- Create `CHANGELOG.md` (Keep a Changelog format) with entries reconstructed
  from `plans/README.md` and `git tag`: 0.2.0 (initial npm), 0.3.0 (version
  in /health, tag-triggered publish), 0.4.0 (**breaking**: removed
  `/exec`/`repos.command`, added built-in repo scanning), 0.4.1
  (`/repos/roots` onboarding). Keep it brief and factual.
- In `release.yml`, add a step after publish that creates a GitHub Release for
  the pushed tag with auto-generated notes:
  `gh release create "$GITHUB_REF_NAME" --generate-notes` (needs
  `contents: write` — add it to that job's `permissions` alongside the
  existing `id-token: write`; do not widen `ci.yml`).

**Verify**: `test -f CHANGELOG.md`; `grep -n "release create" .github/workflows/release.yml`.

### Step 4: Fix doc rot

- `lib/service.mjs`: reword the PATH comment to drop the removed
  `exec/repos commands` reference — the reason PATH is set now is for node +
  user bins for the `#!/usr/bin/env node` shebang and the `tailscale` lookup.
- `README.md`: change "76 tests" to not hardcode a number — e.g. "run on
  every push and PR across Linux and macOS on Node 20 and 22" (drop the
  count), so it can't rot again.
- `README.md`: add a short "How this project is developed" note (2–3
  sentences) framing the `plans/` record: every non-trivial change starts as
  a written plan, is executed against the test suite, and is human-reviewed
  before merge. Turns the AI-assisted-development transparency into a
  strength rather than a surprise.

**Verify**: `grep -c "exec/repos commands" lib/service.mjs` → 0;
`grep -c "76 tests" README.md` → 0; `npm run check` → exit 0.

## Done criteria

- [ ] `SECURITY.md`, `CHANGELOG.md` exist
- [ ] every workflow action pinned to a 40-char SHA; `ci.yml` has `permissions`
- [ ] `release.yml` pins npm and creates a GitHub Release
- [ ] no "76 tests" in README; no "exec/repos commands" in service.mjs
- [ ] `npm run check` and `npm test` still green
- [ ] `git status` clean outside scope; `plans/README.md` row updated

## STOP conditions

- `gh api` can't resolve an action's tag→SHA (network/permissions) — report
  rather than guessing a SHA.
- A workflow edit changes trigger/matrix/publish semantics — this plan pins
  and adds notes only; it must not alter what runs.

## Handoff to the operator (NOT executor steps — cannot be done from files)

Record these in your report for the human:
- Enable branch protection / a ruleset on `main` requiring CI (observable
  trust signal; free).
- Enable CodeQL default setup (Security → Code scanning).
- Switch to signed annotated tags going forward: `git tag -s vX.Y.Z`.
- `npm deprecate outridr@0.2.0 "pre-provenance build; use >=0.3.0"` to nudge
  everyone onto attested builds.

## Maintenance notes

- SHA-pinned actions need periodic bumping (Dependabot can do it if the
  operator enables it for `github-actions`); the trailing tag comment keeps
  them readable.
- Keep SECURITY.md's threat model in sync with plan 018 (once Origin/Host
  validation lands, the "any tailnet peer drives your agents" line should
  note the browser-origin hole is closed).
