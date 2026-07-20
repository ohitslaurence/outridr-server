# Security Policy

## Supported versions

Only the latest minor release line is supported with security fixes. Please
upgrade to the latest published version before reporting an issue.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ohitslaurence/outridr-server/security/advisories/new)
(Security tab → "Report a vulnerability") so the report and any fix can be
coordinated privately before disclosure.

Do not open a public issue for a suspected vulnerability.

## Threat model

outridr is designed to run on a private [Tailscale](https://tailscale.com)
tailnet. **The tailnet is the security perimeter.** Anyone who can reach the
server over HTTP/WS can drive your coding agents through it — the herdr
socket API it proxies has no auth of its own, and outridr's optional shared
`token` is defense-in-depth on top of the tailnet boundary, not a
replacement for it.

Browser-drive-by hardening (Origin rejection and a Host/DNS-rebinding
allowlist on the HTTP and WebSocket surfaces) is enforced **only when no
token is configured** — that is the case where a hostile web page on a
tailnet device is a real threat. With a token set, those checks are
redundant (an unauthorized page can't present the secret) and would
otherwise reject legitimate native clients, so they are skipped in favor of
the token. Set a token.

Specific consequences worth knowing before you deploy:

- **Without a configured `token`, every endpoint is open to any tailnet
  peer**, including `POST /push/register` and `POST /push/unregister` — an
  attacker on your tailnet could register their own device to receive your
  agent's push notifications, or unregister yours to silence them.
- **`GET /repos/roots` discloses your configured scan-root paths**, which
  can reveal home-directory structure (usernames, project directory names).
  It follows the same open-if-tokenless policy as other reads.
- **`PUT /repos/roots` always requires a configured token**, regardless of
  whether one is set for reads — a tokenless server refuses the write with
  `403 { error: "config-token-required" }`. This is a deliberate
  blast-radius control: a tokenless deployment has no way to distinguish
  "the app" from "anyone on the tailnet," and remote config writes are a
  bigger blast radius than read-only endpoints.

## Hardening guidance for operators

- **Set a `token`** (`~/.config/outridr/config.json` or `OUTRIDR_TOKEN`) —
  it gates every endpoint and is required for `PUT /repos/roots`.
- **Keep your tailnet ACLs tight.** They are the actual access-control
  boundary; the token is a second factor, not a substitute.
- **Never bind `0.0.0.0`** or otherwise expose outridr on a public
  interface. `host: "tailscale"` (the default) binds only the machine's
  Tailscale IPv4.
- **Zero dependencies by design** — there is no third-party supply-chain
  surface in this package to monitor beyond this repo itself.
