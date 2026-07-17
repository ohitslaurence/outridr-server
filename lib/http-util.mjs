/**
 * Small HTTP request/response helpers shared by the routing and WebSocket
 * layers: shared-token authorization plus JSON/body plumbing.
 */
import { createHash, timingSafeEqual } from "node:crypto";

function tokenMatches(provided, expected) {
  if (typeof provided !== "string") {
    return false;
  }
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function authorized(config, req, url) {
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

export function readBody(req, callback) {
  const chunks = [];
  let total = 0;
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > 64 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => callback(Buffer.concat(chunks).toString("utf8")));
}
