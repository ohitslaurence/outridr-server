# Plan 011: Version in /health + tag-triggered npm publish with provenance

> **Executor instructions**: Follow this plan step by step. Run every
> verification command before moving on. If a STOP condition occurs, stop and
> report. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: HEAD at `f9d0944` or later; `npm test` → 73
> passing; `outridr@0.2.0` already published (do not publish anything).

## Status

- **Priority**: P3 | **Effort**: S | **Risk**: LOW
- **Depends on**: plans 001–010 (all DONE)
- **Category**: dx
- **Planned at**: commit `f9d0944`, 2026-07-17

## Why this matters

(1) The mobile app has no way to know what server version it reached — once the app/server pair evolves, "please update outridr on your machine" prompts need `/health` to report a version. (2) Releases are currently manual `npm publish` with an interactive OTP; a tag-triggered CI publish with `--provenance` removes that friction and puts a cryptographic build-from-this-repo attestation on the npm page — the strongest form of the trust story the README tells.

## Current state

- `lib/server.mjs` `/health` route (in `handleHttpUnsafe`): `probeHerdr(config, (herdr) => { sendJson(res, 200, { ok: true, herdr, pushTokens: pushTokens.count() }); })`.
- `test/http.test.mjs` has two `/health` tests asserting the exact body with `assert.deepEqual` — they will need the new field added.
- `.github/workflows/ci.yml` exists (check + test matrix). No release workflow.
- `package.json` version `0.2.0`; publishes so far were manual.

## Steps

1. **Version in `/health`**: in `lib/server.mjs`, read the package version once at module load — `JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version` (add the needed `node:url`/`node:path`/`node:fs` imports; do NOT use `import ... with {type:"json"}` — it warns on Node 20). Add `version` to the `/health` response object. Update both `/health` tests in `test/http.test.mjs` to expect it, asserting equality against the version each test reads from `package.json` itself (not a hard-coded string). **Verify**: `npm run check` exit 0; `npm test` → all pass.

2. **Release workflow**: create `.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: "https://registry.npmjs.org"
      - name: Tag must match package.json version
        run: node -e "const v=require('./package.json').version; const t=process.env.GITHUB_REF_NAME; if (t !== 'v'+v) { console.error('tag '+t+' != package version '+v); process.exit(1); }"
      - run: npm run check
      - run: npm test
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Verify**: `node -e "require('js-yaml')"` is NOT available (zero deps) — validate YAML by eye and with `node --eval` on the embedded version-check script logic instead; run the tag-check one-liner locally with `GITHUB_REF_NAME=v0.2.0` (expect pass) and `GITHUB_REF_NAME=v9.9.9` (expect exit 1).

## Scope

**In scope**: `lib/server.mjs`, `test/http.test.mjs`, `.github/workflows/release.yml` (create).
**Out of scope**: publishing, tagging, README, any other module. Do not modify `ci.yml`.

## Git workflow

Branch `advisor/011-version-and-release`; commit per step; no push.

## Done criteria

- [ ] `npm run check` && `npm test` exit 0; `/health` tests assert `version` dynamically
- [ ] `curl`-shaped check: a locally started test server's `/health` body contains `"version":"0.2.0"` (covered by the updated tests)
- [ ] `.github/workflows/release.yml` exists with `id-token: write`, the tag/version guard, check+test before publish, `--provenance`
- [ ] `git diff main --stat` → only the three in-scope files

## STOP conditions

- `/health` response shape is consumed with strict equality anywhere in lib/ (it isn't — only tests) such that adding a field breaks non-test code.
- Anything tempts you to run a real `npm publish` or create a tag.

## Maintenance notes

- The workflow needs a repo secret `NPM_TOKEN` (npm granular automation token) before the next tag push — operator action, documented in the reviewer's summary. Alternative: configure npm trusted publishing (GitHub OIDC) for the package on npmjs.com, then the token env line can be dropped entirely.
- Release procedure from now on: bump both version fields (package.json + herdr-plugin.toml), commit, `git tag vX.Y.Z && git push origin vX.Y.Z` — CI does the rest.
