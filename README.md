# outridr

Ride flank on your coding agents.

outridr is a single small Node server that exposes a machine running
[herdr](https://herdr.dev) to your tailnet, so the outridr mobile app can
watch and drive your agents from anywhere: **live statuses**, **structured
Claude Code transcripts with full history**, **remote input**, and **push
notifications when an agent needs you**.

[![CI](https://github.com/ohitslaurence/outridr-server/actions/workflows/ci.yml/badge.svg)](https://github.com/ohitslaurence/outridr-server/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/outridr)](https://www.npmjs.com/package/outridr) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Design

- **Zero dependencies.** Every line of the server is stdlib Node. There is
  nothing to audit but this repo — no transitive supply-chain surface, no
  version-skew breakage from someone else's package.
- **Tailnet-first.** outridr binds to your Tailscale interface, not the
  public internet; your tailnet ACLs are the access-control boundary, and an
  optional shared token is a second factor on top of that.
- **Tested.** 76 tests, run on every push and PR across Linux and macOS on
  Node 20 and 22 (see the CI badge above).
- **MIT licensed.**

## Quick start

On the machine running herdr (with [Tailscale](https://tailscale.com) up):

```sh
npx outridr install     # installs + starts a user service (systemd/launchd)
```

or as a herdr plugin:

```sh
herdr plugin install ohitslaurence/outridr-server
# then run the "outridr: install service" action
```

Check it:

```sh
curl "http://$(tailscale ip -4):8674/health"
```

Then point the outridr app at this machine's tailnet hostname. Done.

## How it works

```mermaid
flowchart LR
    App["outridr app<br/>(phone, on your tailnet)"]
    Outridr["outridr"]
    Herdr["herdr<br/>(unix socket API)"]
    Transcripts["~/.claude/projects/**/*.jsonl"]
    Expo["Expo Push API"]

    App -- "WS /herdr, HTTP" --> Outridr
    Outridr -- "unix socket, one conn/request" --> Herdr
    Outridr -. "reads" .-> Transcripts
    Outridr -- "push on blocked/done" --> Expo
    Expo -.-> App
```

herdr's socket API closes the connection after each response, so outridr
opens one fresh unix connection per request line and multiplexes the
replies back over the app's single long-lived WebSocket, correlated by
request id — the app never has to manage its own pool of socket
connections. Claude Code session transcripts are large, append-only JSONL
files, so outridr never reads a whole one into memory: `/session/<id>`
serves newline-aligned byte-offset windows, letting the app tail new lines
as they're written and separately page backward through history. Push
notifications and the Tailscale IP watch run as background loops alongside
HTTP/WS request handling, in the same process.

## What it serves

| Endpoint | Purpose |
| --- | --- |
| `WS /herdr` | NDJSON session to herdr's socket API. herdr closes its socket after each response, so outridr opens one unix connection per request line and multiplexes replies back over the websocket, correlated by request id. |
| `GET /session/<id>` | Byte-offset windows over a Claude Code session transcript (`~/.claude/projects/**/<id>.jsonl`): tail, forward polling, and backward history pagination. |
| `POST /push/register` | Register an Expo push token. A watcher polls agent statuses and pushes when an agent transitions to `blocked`/`done`. |
| `POST /push/unregister` | Remove a previously registered push token. |
| `GET /health` | Liveness probe (pings herdr through its socket). |
| `GET /repos` † | Built-in scan of your configured root folders for git repos. |
| `GET /repos/roots` | The configured `repos.roots` (empty array if unset). |
| `PUT /repos/roots` ‡ | Set `repos.roots` remotely, for the app's onboarding flow. |

† Opt-in via config, disabled by default.
‡ Requires a configured token — see "Remote configuration" below.

## Configuration

Everything is optional. `~/.config/outridr/config.json`:

```json
{
  "port": 8674,
  "host": "tailscale",
  "token": "optional-shared-secret",
  "herdrSocket": "~/.config/herdr/herdr.sock",
  "repos": { "roots": ["~/Development"], "depth": 2 },
  "push": { "notifyOn": ["blocked", "done"], "pollMs": 5000 }
}
```

- `host`: a literal address, or `"tailscale"` to bind the machine's Tailscale
  IPv4 (the default — tailnet-only exposure). Resolving `"tailscale"` shells
  out to `tailscale ip -4`, retrying briefly if it fails (common right after
  boot, before `tailscaled` has an address). If it still can't find one, the
  process exits non-zero rather than silently falling back to a loopback
  bind. While running, outridr also re-checks the Tailscale IPv4
  periodically and exits non-zero if it changed, so a supervisor rebinds it
  to the new address — see [Service management](#service-management) below.
  If you run `outridr serve` in the foreground without a supervisor, know
  that it deliberately exits in both of these cases rather than serving on
  a stale or unreachable address.
- `token`: optional bearer/`?token=` check on every request, for defense in
  depth on top of tailnet ACLs.
- `herdrSocket`: path to herdr's unix socket.
- `repos`: absent = `/repos` disabled. When set, `roots` is a list of folders
  to scan (breadth-first, `depth` levels below each root, default `2`) for
  git repos — any directory containing `.git` (a directory or a gitfile, so
  linked worktrees and submodule checkouts count). Scanning does not descend
  into a repo it already found.
- `push`: `notifyOn` is the set of `agent_status` values that trigger a push;
  `pollMs` is the agent-status poll interval.

### Remote configuration

`GET /repos/roots` follows normal auth like every other read — open if you
haven't set a token, gated by it if you have. `PUT /repos/roots` (used by the
app's onboarding flow to configure and live-preview scan roots from the
phone) additionally requires a configured token: a tokenless server refuses
the write with `403 { error: "config-token-required" }` even if the request
would otherwise pass auth, because a tokenless deployment has no way to
distinguish "the app" from "anyone on the tailnet" and letting either rewrite
server config would be a bigger blast radius than the read-only endpoints.
Set a token to enable it. `depth` is not settable remotely — it's file-only
tuning.

### Migrating from 0.3.x

`POST /exec` is gone — the outridr app now creates tasks through herdr's
native `worktree.create`/`agent.start` over `/herdr` instead of shelling out
to a configured CLI. `repos.command` (an external repo-listing command) is
replaced by `repos.roots` (folders for outridr's built-in scanner to walk);
update your config accordingly. Any leftover `exec` or `repos.command` key
is ignored with a startup warning, not a hard failure.

Env overrides (primary):

| Variable | Overrides |
| --- | --- |
| `OUTRIDR_PORT` | `port` |
| `OUTRIDR_HOST` | `host` |
| `OUTRIDR_TOKEN` | `token` |
| `OUTRIDR_CONFIG` | path to the config file itself |
| `HERDR_SOCKET_PATH` | `herdrSocket` |
| `CLAUDE_PROJECTS_DIR` | the Claude Code projects directory transcripts are read from |
| `OUTRIDR_EXPO_PUSH_URL` | the Expo push-send endpoint |

The rest are mostly for tuning/testing and rarely need to change:
`OUTRIDR_STATE_DIR` (where push token state is persisted, default
`~/.local/state/outridr`), `OUTRIDR_RECEIPT_CHECK_MS` (Expo receipts poll
interval, default 900000 = 15 min), `OUTRIDR_HOST_RESOLVE_ATTEMPTS` /
`OUTRIDR_HOST_RESOLVE_DELAY_MS` (boot-time Tailscale IP resolution retries
and delay), and `OUTRIDR_HOST_RECHECK_MS` (running IP re-check interval,
default 60000).

## Security model

Bind to the Tailscale interface and let your tailnet ACLs decide who can
reach outridr — that's the actual perimeter. herdr's own socket has no
auth, so the threat model is simple: anyone who can reach outridr can
drive your agents through it. The optional `token` is a second factor on
top of the tailnet boundary, not a replacement for it.
`repos` only reads directory names and `.git` presence under folders you
configure — it runs no external commands — and is still opt-in: `/repos`
is off unless you set `repos.roots`.
Do not bind `0.0.0.0` on a machine with a public interface.

## Service management

```
outridr serve        Run in the foreground
outridr install      Install + start as a user service (systemd/launchd + linger)
outridr uninstall    Stop and remove the service
outridr status       Service status
outridr config       Print resolved configuration
```

`outridr install` writes a systemd user unit (Linux, plus `loginctl
enable-linger` so it survives logout) or a launchd agent (macOS, loaded via
`launchctl bootstrap`/removed via `bootout`). Both pin the absolute path of
the *current* `node` binary and this package's entrypoint, so installs
managed by fnm/mise/nvm work under the service manager even though it
doesn't see your shell's version-manager setup. The service restarts on failure: if it
starts before `tailscaled` has an address (common right after boot), it
retries briefly then exits, and the restart brings it back once Tailscale
is up; if the Tailscale IP changes while it's running, it exits so the same
restart mechanism rebinds it to the new address.

If you have a `dev.outridr` launchd agent from an old version of outridr
that used `launchctl load` instead of `bootstrap`, run `outridr uninstall
&& outridr install` once to migrate it to the modern API.

## Development

```sh
git clone https://github.com/ohitslaurence/outridr-server
cd outridr-server
npm test
```

No install step — zero dependencies means `npm test` works straight out of
`git clone`.

Module layout:

- `lib/server.mjs` — HTTP routing and startup (host resolution, listen)
- `lib/repos.mjs` — built-in git repo scanning + caching for `/repos`
- `lib/session.mjs` — byte-offset transcript windowing for `/session/<id>`
- `lib/websocket.mjs` — minimal RFC6455 server bridging the app to herdr
- `lib/push.mjs` — Expo push token store, status watcher, and send/receipts lifecycle
- `lib/herdr.mjs` — one-request-per-connection herdr socket client
- `lib/http-util.mjs` — shared token auth and request/response helpers
- `lib/service.mjs` — systemd/launchd service install
- `lib/config.mjs` — config file + env override loading
- `lib/config-write.mjs` — validated, atomic config writes (`repos.roots`)

See [`plans/`](plans/) for the project's engineering record — every
non-trivial change here started as a written plan.

## License

MIT — see [LICENSE](LICENSE).
