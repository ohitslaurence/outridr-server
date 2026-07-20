/**
 * outridr server — exposes a herdr machine to the tailnet for the outridr app.
 *
 * Core endpoints (always on):
 *   GET  /health          → {ok, version, herdr} liveness probe
 *   GET  /session/<id>    → tail a Claude Code session transcript (JSONL)
 *   POST /push/register   → register an Expo push token {token, device?}
 *   WS   /herdr           → NDJSON session to herdr's socket API
 *
 * Opt-in endpoint (config-driven):
 *   GET  /repos           → built-in scan of the configured root folders
 *                            for git repos
 *
 * Onboarding endpoints (always on; PUT token-gated):
 *   GET  /repos/roots     → the configured repos.roots (empty if unset)
 *   PUT  /repos/roots     → set repos.roots remotely; requires a configured
 *                            token; 403 without one
 *
 * Owns startup (host resolution, listen) and HTTP routing; the herdr socket
 * client, session transcript windowing, push notifications, and the
 * WebSocket implementation each live in their own lib/*.mjs module.
 *
 * Security model: bind to the Tailscale interface and let tailnet ACLs guard
 * access; optionally set a shared token (bearer header or ?token=).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { saveRepoRoots } from "./config-write.mjs";
import { probeHerdr } from "./herdr.mjs";
import { authorized, hostAllowed, readBody, sendJson } from "./http-util.mjs";
import { PushTokenStore, startPushWatcher } from "./push.mjs";
import { createRepoCache, scanRepos } from "./repos.mjs";
import { serveSessionWindow } from "./session.mjs";
import { handleUpgrade } from "./websocket.mjs";

const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

const repoCache = createRepoCache(scanRepos);

const HOST_RESOLVE_ATTEMPTS =
  Number.parseInt(process.env.OUTRIDR_HOST_RESOLVE_ATTEMPTS ?? "", 10) || 5;
const HOST_RESOLVE_DELAY_MS =
  Number.parseInt(process.env.OUTRIDR_HOST_RESOLVE_DELAY_MS ?? "", 10) || 2000;
const HOST_RECHECK_MS = Number.parseInt(process.env.OUTRIDR_HOST_RECHECK_MS ?? "", 10) || 60_000;

// On macOS the Tailscale.app CLI isn't on PATH by default; fall back to its
// known bundle location before giving up. Returns the command name (found on
// PATH), an absolute app-bundle path, or an explicit test/tuning override, so
// execFileSync just works either way.
const MACOS_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
function tailscaleBin() {
  if (process.env.OUTRIDR_TAILSCALE_BIN) {
    return process.env.OUTRIDR_TAILSCALE_BIN;
  }
  return process.platform === "darwin" && existsSync(MACOS_TAILSCALE) ? MACOS_TAILSCALE : "tailscale";
}

export function startServer(config) {
  const pushTokens = new PushTokenStore();
  const server = createServer((req, res) => handleHttp(config, pushTokens, req, res));
  server.on("upgrade", (req, socket, head) => handleUpgrade(config, req, socket, head));

  if (config.push.enabled) {
    startPushWatcher(config, pushTokens);
  }

  server.on("error", (error) => {
    console.error(`outridr: server error: ${error.message}`);
    process.exit(1);
  });
  resolveHost(config.host).then((host) => {
    assertBindAllowed(config, host);
    server.listen(config.port, host, () => {
      console.log(`outridr listening on ${host}:${config.port} → ${config.herdrSocket}`);
      console.log(
        `  repos: ${
          config.repos ? `${config.repos.roots.length} root(s)` : "disabled"
        } | push: ${config.push.enabled ? `${pushTokens.count()} token(s)` : "disabled"}`,
      );
      if (config.host === "tailscale") {
        startHostRecheck(host);
      }
    });
  });
  return server;
}

// Detects a Tailscale re-auth or node re-join that changes this machine's
// IPv4 mid-run, which would otherwise leave the server listening on a stale,
// unreachable address until someone restarts it. A single-attempt, no-retry
// check: transient tailscaled hiccups (empty output, command failure) must
// not kill a working server — only a *changed* address may.
function startHostRecheck(boundHost) {
  const interval = setInterval(() => checkTailscaleHost(boundHost), HOST_RECHECK_MS);
  interval.unref();
}

function checkTailscaleHost(boundHost) {
  let current;
  try {
    current = execFileSync(tailscaleBin(), ["ip", "-4"], { encoding: "utf8" })
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => /^\d+\.\d+\.\d+\.\d+$/.test(candidate));
  } catch {
    return;
  }
  if (current && current !== boundHost) {
    console.error(
      `outridr: Tailscale IPv4 changed ${boundHost} → ${current}; exiting so the service supervisor rebinds`,
    );
    process.exit(1);
  }
}

// String-prefix tests are not IP-range tests: "127.0.0.1.evil.example" would
// pass a startsWith("127.") check and then resolve via DNS to anywhere. Only
// exact well-known names and numerically-verified 127/8 literals count.
function isLoopbackHost(host) {
  if (typeof host !== "string") {
    return false;
  }
  if (host === "localhost" || host === "::1") {
    return true;
  }
  return isIP(host) === 4 && host.startsWith("127.");
}

// A non-loopback bind outside Tailscale has no tailnet ACL in front of it —
// plain truthiness on token matches authorized() in http-util.mjs, so the
// guard can never pass while auth is effectively off (e.g. token: "").
function assertBindAllowed(config, host) {
  if (config.host === "tailscale" || isLoopbackHost(host) || config.token || config.insecureNoToken) {
    return;
  }
  console.error(
    `outridr: refusing to listen on ${host} without a token — outside Tailscale there is no tailnet ACL in front of this server.\n` +
      `  Set "token" in the config (or OUTRIDR_TOKEN). If this address is your Tailscale IP, set "host": "tailscale" instead.\n` +
      `  Or set "insecureNoToken": true (or OUTRIDR_INSECURE_NO_TOKEN=1) if this interface is already protected (VPN, firewalled LAN).`,
  );
  process.exit(1);
}

async function resolveHost(configured) {
  if (configured !== "tailscale") {
    return configured;
  }
  for (let attempt = 1; attempt <= HOST_RESOLVE_ATTEMPTS; attempt++) {
    try {
      const line = execFileSync(tailscaleBin(), ["ip", "-4"], { encoding: "utf8" })
        .split("\n")
        .map((candidate) => candidate.trim())
        .find((candidate) => /^\d+\.\d+\.\d+\.\d+$/.test(candidate));
      if (line) {
        return line;
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        console.error('outridr: tailscale binary not found; set "host" in the config to a literal address');
        process.exit(1);
      }
    }
    if (attempt < HOST_RESOLVE_ATTEMPTS) {
      console.error(`outridr: waiting for a Tailscale IPv4 (attempt ${attempt}/${HOST_RESOLVE_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, HOST_RESOLVE_DELAY_MS));
    }
  }
  console.error("outridr: no Tailscale IPv4; is tailscale up? Exiting so the service supervisor retries.");
  process.exit(1);
}

// ── HTTP routing ────────────────────────────────────────────────────────────

function handleHttp(config, pushTokens, req, res) {
  try {
    handleHttpUnsafe(config, pushTokens, req, res);
  } catch (error) {
    console.error(`outridr: request failed: ${error.message}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal error" });
    } else {
      res.destroy();
    }
  }
}

function handleHttpUnsafe(config, pushTokens, req, res) {
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(421).end("misdirected request");
    return;
  }
  const url = new URL(req.url ?? "/", "http://outridr");
  if (!authorized(config, req)) {
    res.writeHead(401).end("unauthorized");
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    probeHerdr(config, (herdr) => {
      sendJson(res, 200, { ok: true, version: PACKAGE_VERSION, herdr, pushTokens: pushTokens.count() });
    });
    return;
  }

  const sessionMatch =
    req.method === "GET" ? url.pathname.match(/^\/session\/([0-9a-f-]{36})$/) : null;
  if (sessionMatch) {
    serveSessionWindow(config, sessionMatch[1], url, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/push/register") {
    readBody(req, res, (body) => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end("invalid json");
        return;
      }
      const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
      if (!/^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(token)) {
        res.writeHead(400).end("token must be an Expo push token");
        return;
      }
      pushTokens.add(token, typeof parsed.device === "string" ? parsed.device : "");
      sendJson(res, 200, { ok: true, registered: pushTokens.count() });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/push/unregister") {
    readBody(req, res, (body) => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end("invalid json");
        return;
      }
      const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
      if (!/^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(token)) {
        res.writeHead(400).end("token must be an Expo push token");
        return;
      }
      pushTokens.remove(token);
      sendJson(res, 200, { ok: true, registered: pushTokens.count() });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/repos" && config.repos) {
    repoCache
      .get(config.repos.roots, config.repos.depth)
      .then((repos) => sendJson(res, 200, { repos }))
      .catch(() => sendJson(res, 200, { repos: [] }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/repos/roots") {
    sendJson(res, 200, { roots: config.repos?.roots ?? [] });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/repos/roots") {
    if (!config.token) {
      sendJson(res, 403, {
        error: "config-token-required",
        message:
          "Set a token in ~/.config/outridr/config.json (or OUTRIDR_TOKEN) to allow remote config changes",
      });
      return;
    }
    readBody(req, res, (body) => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end("invalid json");
        return;
      }
      const rawRoots = parsed !== null && typeof parsed === "object" ? parsed.roots : undefined;
      saveRepoRoots(config, rawRoots)
        .then((result) => {
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error, message: result.message });
            return;
          }
          repoCache.invalidate();
          repoCache
            .get(config.repos.roots, config.repos.depth)
            .then((repos) => sendJson(res, 200, { roots: result.roots, repos }))
            .catch(() => sendJson(res, 200, { roots: result.roots, repos: [] }));
        })
        .catch((error) => {
          console.error(`outridr: repos.roots write failed: ${error.message}`);
          sendJson(res, 500, { error: "config-write-failed" });
        });
    });
    return;
  }

  res.writeHead(404).end("not found");
}
