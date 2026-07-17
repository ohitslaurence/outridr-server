# Plan 009: README overhaul — make a stranger willing to install this

> **Executor instructions**: Follow this plan step by step. If a STOP
> condition occurs, stop and report. Your reviewer maintains
> `plans/README.md` and will edit your draft — aim for substance and
> accuracy; the reviewer handles final polish.
>
> **Drift check (run first)**: plans 006–008 must be merged (lib/ split into
> modules; receipts + re-check features exist). Read the CURRENT `README.md`,
> `lib/*.mjs` headers, `bin/outridr.mjs` help text, and `test/` file list
> before writing — every claim in the README must be true of the code as it
> is now. Verify each endpoint/env var/config key you document by grepping
> for it.

## Status

- **Priority**: P2 | **Effort**: M | **Risk**: LOW (docs only)
- **Depends on**: plans 006, 007, 008 (documents their results)
- **Category**: docs
- **Planned at**: commit `8cb2c4f`, 2026-07-17

## Why this matters

The README is the product page. The current one is accurate and terse — fine for the author, thin for a stranger deciding whether to run a network service on their dev machine. The bar: a skeptical developer skims for 60 seconds and concludes "I understand what this does, what it exposes, and why it's safe enough for my tailnet; installing is two commands." Trust is the feature: security model, zero-dependency claim, and test/CI evidence must be prominent, not buried.

## Requirements

**Tone**: confident, concrete, no marketing fluff. Short sentences. The reader is a developer who runs coding agents and owns a tailnet. Keep the existing "Ride flank on your coding agents" tagline — it's the product's voice.

**Structure** (in this order):

1. **Header**: `# outridr` + tagline + one paragraph: what it is (a single small Node server that exposes a herdr machine to your tailnet so the outridr mobile app can watch and drive your coding agents), the three headline capabilities (live statuses + structured Claude Code transcripts with full history, remote input, push notifications when an agent needs you). Badges on one line: CI (`https://github.com/ohitslaurence/outridr-server/actions/workflows/ci.yml/badge.svg`), npm version (`https://img.shields.io/npm/v/outridr`), license MIT. (npm badge will 404 until first publish — fine, plan 010 publishes.)
2. **Why you can trust it** (short section, whatever heading reads naturally — e.g. "Design"): zero dependencies (stdlib only — say why that matters: nothing to audit but this repo, no supply-chain surface); tailnet-first security model in two sentences; ~59+ tests run on CI across linux/macos, node 20/22 (state the real current number — count via `npm test` output, don't guess); MIT.
3. **Quick start**: the two install paths (npx / herdr plugin) + the health-check curl + "point the app at your tailnet hostname". Must be copy-pasteable and nothing else.
4. **How it works**: a compact mermaid diagram (GitHub renders `mermaid` fences) — phone app → WS/HTTP over tailnet → outridr → unix socket → herdr, plus the side channels (transcript files read from `~/.claude/projects`, Expo push out). Below it, 3–4 sentences covering the one-request-per-connection herdr bridge and the byte-offset transcript windowing (why: transcripts are large, append-only JSONL; outridr serves newline-aligned windows so the app can tail live and paginate history).
5. **Endpoints**: the existing table, updated to include `/push/unregister`; keep the † opt-in convention.
6. **Configuration**: the existing JSON example + per-key bullets, updated for anything plans 006–008 added; env override list complete (grep `process.env.OUTRIDR_` + `HERDR_SOCKET_PATH` + `CLAUDE_PROJECTS_DIR` across lib/ — document every one, including the test-oriented ones under a "mostly for testing" note).
7. **Security model**: expand the current paragraph slightly: tailnet ACLs are the perimeter; what an attacker who reaches the port can do (drive agents via herdr — be honest); token as second factor; exec/repos opt-in and why they're off by default; explicit "do not bind 0.0.0.0" warning kept.
8. **Service management**: the CLI table + what install actually does (systemd user unit + linger / launchd agent, absolute node path pinning for fnm/mise/nvm, restart-on-failure semantics incl. the boot-before-tailscaled and IP-change behaviors from plans 004/008 — one sentence each).
9. **Development**: clone, `npm test` (zero deps — no install step; say so, it's charming), module layout in one line per file (`lib/server.mjs` routing/startup, `lib/session.mjs` transcript windows, `lib/websocket.mjs` RFC6455 bridge, `lib/push.mjs` Expo lifecycle, `lib/herdr.mjs` socket client, `lib/http-util.mjs` shared helpers, `lib/service.mjs` install, `lib/config.mjs` config), pointer to `plans/` as the audit/engineering record.
10. **License**: one line.

**Hard accuracy rules**: every command, path, endpoint, config key, env var, badge URL, and number (test count, node versions) must be verified against the repo before writing it. No screenshots/GIFs (nothing to capture in this repo). No promises about the mobile app beyond what the server provably serves.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Tests still green | `npm test` | exit 0 (README-only change — run once to confirm nothing else broke and to read the real test count) |
| Link/anchor sanity | manual read of the rendered markdown | headings/anchors consistent |

## Scope

**In scope**: `README.md` only.
**Out of scope**: all code, package.json, LICENSE, plans/.

## Git workflow

Branch `advisor/009-readme-overhaul`; single commit (`Rewrite README for public release`); no push.

## Done criteria

- [ ] All 10 structure sections present in order
- [ ] `npm test` count stated matches actual output
- [ ] Every env var found by `grep -rho "OUTRIDR_[A-Z_]*" lib/ | sort -u` appears in the README
- [ ] Endpoint table includes `/push/unregister`
- [ ] Mermaid block present and syntactically valid (renders on GitHub — validate the fence syntax carefully)
- [ ] `git diff main --stat` → README.md only

## STOP conditions

- Plans 006–008 not all merged (the layout/features you'd document don't exist yet).
- You catch yourself documenting behavior you couldn't verify in the code.

## Maintenance notes

- Reviewer edits the draft for voice before merge; expect edits, don't gold-plate.
- The npm version badge goes live after plan 010's publish.
