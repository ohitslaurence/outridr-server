/**
 * `outridr pair` — the one-command onboarding flow for the outridr mobile
 * app: ensure a strong token exists, resolve the configured host to a
 * concrete address, build a connection URI, and print it as both a scannable
 * terminal QR code and plain text (so the command is useful even where a QR
 * can't render — piped output, screen readers).
 *
 * URI shape (a contract with the app — see the README's "Connecting the
 * app" section, and coordinate any change with the app team). `v` is the
 * pairing-payload version so the app can evolve the format compatibly:
 *
 *   outridr://pair?v=1&host=<host>&port=<port>&token=<token>
 *
 * `host` prefers this machine's stable MagicDNS name when bound to Tailscale,
 * falling back to the resolved IP — so a pairing survives a Tailscale IP
 * change.
 */
import { loadConfig } from "./config.mjs";
import { saveToken } from "./config-write.mjs";
import { encodeToMatrix, renderMatrix } from "./qr.mjs";
import { resolveHost, tailscaleHostname } from "./server.mjs";

export async function runPair() {
  const config = loadConfig();
  const ip = await resolveHost(config.host);
  const host = config.host === "tailscale" ? (tailscaleHostname() ?? ip) : ip;
  const token = await saveToken(config);

  const uri = `outridr://pair?v=1&host=${host}&port=${config.port}&token=${token}`;

  console.log(`outridr pair: host=${host} port=${config.port} token=set`);
  console.log(
    "outridr: the QR/URI below grants access to this machine — treat it like a password; don't share it outside a trusted pairing.",
  );
  console.log("");
  console.log(renderMatrix(encodeToMatrix(uri)));
  console.log(uri);
}
