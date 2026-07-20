/**
 * `outridr pair` — the one-command onboarding flow for the outridr mobile
 * app: ensure a strong token exists, resolve the configured host to a
 * concrete address, build a connection URI, and print it as both a scannable
 * terminal QR code and plain text (so the command is useful even where a QR
 * can't render — piped output, screen readers).
 *
 * URI shape (a contract with the app — see the README's "Connecting the
 * app" section, and coordinate any change with the app team):
 *
 *   outridr://<host>:<port>?token=<token>
 */
import { loadConfig } from "./config.mjs";
import { saveToken } from "./config-write.mjs";
import { encodeToMatrix, renderMatrix } from "./qr.mjs";
import { resolveHost } from "./server.mjs";

export async function runPair() {
  const config = loadConfig();
  const host = await resolveHost(config.host);
  const token = await saveToken(config);

  const uri = `outridr://${host}:${config.port}?token=${token}`;

  console.log(`outridr pair: host=${host} port=${config.port} token=set`);
  console.log(
    "outridr: the QR/URI below grants access to this machine — treat it like a password; don't share it outside a trusted pairing.",
  );
  console.log("");
  console.log(renderMatrix(encodeToMatrix(uri)));
  console.log(uri);
}
