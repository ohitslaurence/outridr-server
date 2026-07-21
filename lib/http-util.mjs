/**
 * Small HTTP request/response helpers shared by the routing and WebSocket
 * layers: shared-token authorization plus JSON/body plumbing.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

function tokenMatches(provided, expected) {
  if (typeof provided !== "string") {
    return false;
  }
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// DNS-rebinding guard: a hostile page can point its own domain's DNS at this
// server's address; the browser then sends that domain in Host. Accepting
// only IP-literal/localhost/tailnet-style hosts (with optional :port) breaks
// the technique without maintaining an allowlist of the machine's names.
export function hostAllowed(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 255) {
    return false;
  }
  const name = host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (name === "localhost" || isIP(name) !== 0) {
    return true; // IPv4/IPv6 literals and localhost
  }
  return name.endsWith(".ts.net"); // Tailscale MagicDNS names
}

// `?token=` is honored only on the WebSocket upgrade (authorizedUpgrade) —
// its actual purpose, since a native client can't set a header on the
// upgrade request it initiates through the platform's WebSocket API. Every
// other HTTP route accepts only the Authorization header, so the shared
// secret stops leaking into URLs, logs, and shell/browser history.
export function authorized(config, req) {
  if (!config.token) {
    return true;
  }
  const authorization = req.headers.authorization;
  return (
    typeof authorization === "string" &&
    authorization.startsWith("Bearer ") &&
    tokenMatches(authorization.slice("Bearer ".length), config.token)
  );
}

export function authorizedUpgrade(config, req, url) {
  if (!config.token) {
    return true;
  }
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    if (tokenMatches(authorization.slice("Bearer ".length), config.token)) {
      return true;
    }
  }
  return tokenMatches(url.searchParams.get("token"), config.token);
}

export function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

// `res` is threaded through explicitly (rather than read off `req.res`) —
// that pairing isn't set by Node's http server on every supported version,
// and passing it in is unconditionally reliable.
export function readBody(req, res, callback) {
  const chunks = [];
  let total = 0;
  let done = false;
  req.on("data", (chunk) => {
    if (done) {
      return;
    }
    total += chunk.length;
    if (total > 64 * 1024) {
      done = true;
      chunks.length = 0;
      // Respond before dropping the connection; destroying first would
      // discard the pending write and the client only sees a reset.
      if (!res.headersSent) {
        res.writeHead(413, { connection: "close" });
        res.end("body too large", () => req.destroy());
      } else {
        req.destroy();
      }
    } else {
      chunks.push(chunk);
    }
  });
  req.on("error", () => {
    done = true;
  });
  req.on("end", () => {
    if (!done) {
      callback(Buffer.concat(chunks).toString("utf8"));
    }
  });
}
