# Plan 010: npm release readiness — metadata, version 0.2.0, publish guard

> **Executor instructions**: Follow this plan step by step. If a STOP
> condition occurs, stop and report. Your reviewer maintains
> `plans/README.md`. You will NOT run `npm publish` — only the dry run.
> The actual publish is the operator's action (requires their npm auth).
>
> **Drift check (run first)**: plans 006–009 merged (README rewritten,
> modules split). `npm view outridr` must still 404 (name free); if it
> resolves, STOP — someone claimed the name.

## Status

- **Priority**: P2 | **Effort**: S | **Risk**: LOW
- **Depends on**: plans 006–009 (publish last, over the final shape)
- **Category**: dx
- **Planned at**: commit `8cb2c4f`, 2026-07-17

## Why this matters

`npx outridr install` is the front door of the README, and it 404s today — the package has never been published. Before the first publish, the manifest needs the metadata npm surfaces on the package page (keywords, homepage, bugs), a version that reflects the changes since 0.1.0, and a guard so a publish can never ship untested code.

## Current state

`package.json`: name `outridr`, version `0.1.0`, description set, MIT, `repository: "github:ohitslaurence/outridr-server"`, `type: module`, bin, `files: ["bin", "lib", "herdr-plugin.toml", "README.md"]`, engines `>=20`, scripts `serve`/`check`/`test`. Missing: `keywords`, `homepage`, `bugs`, publish guard. `herdr-plugin.toml` also carries `version = "0.1.0"` and its own `min_herdr_version`/actions — keep in sync.

## Steps

1. **Metadata** in `package.json` (key order: keep npm-conventional grouping, don't reshuffle existing keys needlessly):
   - `"keywords": ["herdr", "claude-code", "coding-agents", "tailscale", "tailnet", "mobile", "push-notifications", "agent-monitoring"]`
   - `"homepage": "https://github.com/ohitslaurence/outridr-server#readme"`
   - `"bugs": "https://github.com/ohitslaurence/outridr-server/issues"`
   - `"scripts.prepublishOnly": "npm run check && npm test"`
   - Do NOT add an `author` field (operator hasn't specified their public identity — leave it out; npm shows the publisher account anyway).
   **Verify**: `node -e "JSON.parse(require('fs').readFileSync('package.json'))"` → exit 0.
2. **Version 0.2.0** in both `package.json` and `herdr-plugin.toml` (`version = "0.2.0"`). **Verify**: `grep -n '"version"' package.json; grep -n '^version' herdr-plugin.toml` → both 0.2.0.
3. **LICENSE completeness check**: `files` doesn't list LICENSE — npm auto-includes LICENSE/README regardless of `files`; confirm via the dry run's file list. If absent from the tarball, add `"LICENSE"` to `files`.
4. **Dry run**: `npm publish --dry-run` → tarball contents must be exactly: `bin/`, `lib/` (all 8 mjs files), `herdr-plugin.toml`, `README.md`, `LICENSE`, `package.json` — and must NOT contain `test/`, `plans/`, `.github/`. Record the full file list in your report.
   **Verify**: dry-run output shows the exact expected file set; `prepublishOnly` ran check + tests during it (if npm skips lifecycle scripts on dry-run in this npm version, run `npm run check && npm test` manually and say so).

## Scope

**In scope**: `package.json`, `herdr-plugin.toml`.
**Out of scope**: `npm publish` (operator does it), any code or README change, git tags (reviewer/operator tag after publish).

## Git workflow

Branch `advisor/010-npm-release`; single commit (`Prepare 0.2.0 npm release`); no push.

## Done criteria

- [ ] `npm run check && npm test` exit 0
- [ ] Both version fields read 0.2.0
- [ ] `npm publish --dry-run` file list = expected set, recorded in report
- [ ] `git diff main --stat` → package.json + herdr-plugin.toml only

## STOP conditions

- The npm name `outridr` is no longer free.
- The dry-run tarball includes test/plans/.github files that `files` should have excluded — report the list rather than guessing at fixes beyond adding to `files`.

## Maintenance notes

- After the operator publishes: `git tag v0.2.0 && git push --tags`; the README's npm badge goes live.
- Future releases: bump both version fields together; `prepublishOnly` is the safety net.
