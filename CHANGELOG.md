# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
