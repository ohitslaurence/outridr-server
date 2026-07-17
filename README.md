# outridr

Ride flank on your coding agents.

outridr exposes a machine running [herdr](https://herdr.dev) to your tailnet
so the outridr mobile app can watch and drive your agents from anywhere:
live statuses, structured Claude Code transcripts with full history, remote
input, and push notifications when an agent needs you.

Zero dependencies — one small Node server.

## Install

On the machine running herdr (with [Tailscale](https://tailscale.com) up):

```sh
npx outridr install     # installs + starts a user service (systemd/launchd)
```

Check it:

```sh
curl "http://$(tailscale ip -4):8674/health"
```

Then point the outridr app at this machine's tailnet hostname. Done.

## What it serves

| Endpoint | Purpose |
| --- | --- |
| `WS /herdr` | NDJSON session to herdr's socket API. herdr closes its socket after each response, so outridr opens one unix connection per request line and multiplexes replies back over the websocket, correlated by request id. |
| `GET /session/<id>` | Byte-offset windows over a Claude Code session transcript (`~/.claude/projects/**/<id>.jsonl`): tail, forward polling, and backward history pagination. |
| `POST /push/register` | Register an Expo push token. A watcher polls agent statuses and pushes when an agent transitions to `blocked`/`done`. |
| `GET /health` | Liveness probe (pings herdr through its socket). |
| `POST /exec` † | Run your configured task CLI (e.g. a worktree-task spawner). |
| `GET /repos` † | Run your configured repo-listing command. |

† Opt-in via config — workflow-specific, disabled by default.

## Configuration

Everything is optional. `~/.config/outridr/config.json`:

```json
{
  "port": 8674,
  "host": "tailscale",
  "token": "optional-shared-secret",
  "exec": { "command": "~/.local/bin/dev" },
  "repos": { "command": ["~/.local/bin/dev", "repos", "--json"] },
  "push": { "notifyOn": ["blocked", "done"], "pollMs": 5000 }
}
```

- `host`: a literal address, or `"tailscale"` to bind the machine's Tailscale
  IPv4 (the default — tailnet-only exposure).
- `token`: optional bearer/`?token=` check on every request, for defense in
  depth on top of tailnet ACLs.
- `exec`/`repos`: absent = endpoints disabled. `exec` runs exactly the one
  configured binary with client-supplied args.

Env overrides: `OUTRIDR_PORT`, `OUTRIDR_HOST`, `OUTRIDR_TOKEN`,
`OUTRIDR_CONFIG`, `HERDR_SOCKET_PATH`, `CLAUDE_PROJECTS_DIR`.

## Security model

Bind to the Tailscale interface and let your tailnet ACLs decide who can
reach it — herdr's own socket has no auth, so whoever can reach outridr can
drive your agents. The optional `token` adds a second factor. Do not bind
`0.0.0.0` on a machine with a public interface.

## CLI

```
outridr serve        Run in the foreground
outridr install      Install + start as a user service (systemd/launchd + linger)
outridr uninstall    Stop and remove the service
outridr status       Service status
outridr config       Print resolved configuration
```

The service unit pins the absolute paths of the current `node` and this
package, so fnm/mise/nvm-managed node installs work under systemd/launchd.
