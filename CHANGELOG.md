# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.5] - 2026-07-21

### Security

- **Tokenless HTTP surface now rejects requests carrying an `Origin` header**
  (`403`), matching the WebSocket upgrade guard and the behavior SECURITY.md
  already documents. Previously a hostile web page could `POST /push/register`
  as a CORS "simple request" (`text/plain`, no preflight) — the Host allowlist
  accepts a loopback/tailnet literal and nothing checked `Origin` — and
  register its own device to receive the owner's push notifications. The
  native app sends no `Origin` on its HTTP requests, so it is unaffected.
  Found by an adversarial review of the tokenless perimeter.

### Fixed

- WebSocket request dispatch now drains through a queue that honors
  `ws.write` backpressure (pause on a full socket buffer, resume on `drain`),
  so a single large message can no longer expand into unbounded outbound
  buffering for a slow-reading peer. Response correlation by id is unchanged.
- `hostAllowed` no longer mishandles bracketless IPv6 `Host` values: the
  `:port` strip previously ate the final hextet of literals like `::1` /
  `fe80::1`, wrongly `421`-ing them on tokenless servers. Bracketed and
  bracketless IPv6 literals are now parsed correctly, and malformed brackets
  fail closed.

## [0.5.4] - 2026-07-21

### Added

- Lint and format tooling: [oxlint](https://oxc.rs) and oxfmt, the repo's
  first (and only) dev dependencies, with committed configs and a dedicated
  CI lint job. The test matrix and the release pipeline remain
  dependency-free — `git clone && npm test` still needs no install, and
  nothing third-party runs next to the publish token.
- README "For agents" section: a deliberately fake (and immediately
  retracted) prompt injection, followed by the real ask — review this
  project adversarially, starting from `SECURITY.md` and `plans/`, and open
  an issue for any security concern.

### Changed

- Codebase reformatted with oxfmt. Mechanical except three oxlint fixes,
  the only findings in the codebase: `hostAllowed`'s `.ts.net` suffix test
  now uses `String#endsWith` instead of a regex (behavior unchanged), plus
  two test-only cleanups.
- `npm run check` now globs `bin/*.mjs lib/*.mjs` instead of enumerating
  files by hand, so new modules can't silently escape it.

## [0.5.3] - 2026-07-20

### Changed

- Repo discovery (`GET /repos`) now lists only standalone repositories (a
  `.git` directory). Linked worktrees and submodule checkouts (whose `.git`
  is a gitfile) are excluded — they're workspace artifacts, not repos to
  start new tasks from.

## [0.5.2] - 2026-07-20

### Fixed

- The Origin and Host (DNS-rebinding) checks on the HTTP and WebSocket
  surfaces are now enforced only on **tokenless** servers. They are
  browser-drive-by defenses that a configured `token` already supersedes
  (an unauthorized page can't present the secret), and enforcing them with a
  token set wrongly rejected the real app — a React Native client whose
  WebSocket sends an `Origin` header and which addresses the machine by its
  short MagicDNS hostname (not an IP or `*.ts.net` FQDN). Tokenless servers
  keep the full protection. Fixes the app hanging on connect.

## [0.5.1] - 2026-07-20

### Changed

- `outridr pair` now emits the app's deep-link contract
  `outridr://pair?v=1&host=<host>&port=<port>&token=<token>` (was
  `outridr://<host>:<port>?token=<token>`). Scanned QR codes from earlier
  builds won't pair; re-run `outridr pair`.
- When bound to Tailscale, the pairing `host` is this machine's stable
  MagicDNS name rather than its raw IP (falling back to the IP if MagicDNS
  is unavailable), so a pairing survives a Tailscale IP change.

### Added

- `outridr install` places the `outridr` CLI on your PATH at
  `~/.local/bin/outridr` — a small launcher pinned to the Node that ran the
  install, so the command resolves from any directory regardless of a Node
  version manager's active version. `outridr uninstall` removes it.
  Override the location with `OUTRIDR_BIN_DIR`.

## [0.5.0] - 2026-07-20

Security-hardening and onboarding release, from four independent
cold-context audits (site, repo, setup simulation, and a security trust
review).

### Added

- `outridr pair`: generates a strong token if none is set, then prints a
  scannable QR code and an `outridr://<host>:<port>?token=<token>` URI for
  the app. QR encoder is a vendored, zero-dependency port of the MIT Nayuki
  library.
- Automatic discovery of the macOS Tailscale.app CLI when it isn't on `PATH`
  (overridable with `OUTRIDR_TAILSCALE_BIN`), plus a Prerequisites section
  and non-Tailscale operation guide in the README.
- WebSocket concurrency cap (`OUTRIDR_WS_MAX_CONNECTIONS`, default 32) and
  idle-connection timeout (`OUTRIDR_WS_IDLE_MS`, default 10 min).
- `SECURITY.md` with a documented threat model and disclosure policy.

### Changed

- **Origin and Host validation** on both HTTP and the WebSocket upgrade
  closes browser-origin and DNS-rebinding paths into the tailnet server.
- The shared `token` is accepted in a `?token=` query string only on the
  `/herdr` WebSocket upgrade; every other endpoint requires the
  `Authorization: Bearer` header.
- `outridr config` masks the token by default (`--show-secrets` to reveal).
- Startup failures now log and exit non-zero cleanly instead of crashing on
  an unhandled rejection.

### Security

- A non-loopback bind with a literal `host` (i.e. outside Tailscale) now
  refuses to start without a `token`, unless `insecureNoToken: true` is set
  explicitly. **This can stop an existing tokenless non-loopback deployment
  from starting after upgrade** — set a token or `insecureNoToken`.
- Bounded the push-token store and per-connection herdr sockets; hardened
  request-body handling; CI/release GitHub Actions pinned to commit SHAs.

## [0.4.1] - 2026-07-20

- Added `GET`/`PUT /repos/roots` so the outridr app can read and set
  `repos.roots` remotely for its onboarding flow. `PUT` requires a
  configured `token` (403 without one).

## [0.4.0] - 2026-07-20

### Breaking

- Removed `POST /exec` and the `repos.command` config option — the app now
  drives agents through herdr's native `worktree.create`/`agent.start` over
  `/herdr` instead of shelling out to a configured CLI.
- Added built-in git repo scanning (`repos.roots`, opt-in) replacing the
  external `repos.command` listing.

## [0.3.0] - 2026-07-19

- Added the package version to the `GET /health` response.
- Switched releases to tag-triggered npm publishing with npm trusted
  publishing (GitHub OIDC) and provenance — no long-lived npm token.

## [0.2.0] - 2026-07-17

- First npm release (`outridr@0.2.0`), published manually before trusted
  publishing was set up.
