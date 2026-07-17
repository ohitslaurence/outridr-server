/**
 * herdr socket helpers — one-request-per-connection JSON-RPC over herdr's
 * unix socket API.
 */
import { connect } from "node:net";

/** One request over a fresh unix connection (herdr closes after answering). */
export function herdrRequest(config, method, params, callback, timeoutMs = 5000) {
  const socket = connect(config.herdrSocket);
  let buffer = "";
  let settled = false;
  const settle = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    callback(result);
  };
  const timer = setTimeout(() => settle(null), timeoutMs);
  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ id: "outridr", method, params })}\n`);
  });
  socket.on("data", (data) => {
    if (settled) {
      return;
    }
    buffer += data.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline !== -1) {
      try {
        settle(JSON.parse(buffer.slice(0, newline)).result ?? null);
      } catch {
        settle(null);
      }
    }
  });
  socket.on("error", () => settle(null));
}

export function probeHerdr(config, callback) {
  herdrRequest(config, "ping", {}, callback, 2000);
}
