/**
 * outridr configuration: JSON file + env overrides, all optional.
 *
 * File: ~/.config/outridr/config.json (or $OUTRIDR_CONFIG)
 * {
 *   "port": 8674,
 *   "host": "tailscale",            // literal address, or "tailscale"
 *   "token": "shared-secret",       // optional bearer/query token
 *   "insecureNoToken": false,       // allow tokenless non-loopback binds off-tailnet
 *   "herdrSocket": "~/.config/herdr/herdr.sock",
 *   "repos": { "roots": ["~/Development"], "depth": 2 },  // GET /repos
 *   "push":  { "notifyOn": ["blocked", "done"], "pollMs": 5000 }     // watcher
 * }
 *
 * The core surface (WS /herdr, GET /session/<id>, /health, /push/register)
 * is always on. repos is opt-in and built-in: it scans the configured root
 * folders for git repos, no external CLI involved.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function expandHome(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

export const CONFIG_PATH =
  process.env.OUTRIDR_CONFIG ?? join(homedir(), ".config", "outridr", "config.json");

export const STATE_DIR =
  process.env.OUTRIDR_STATE_DIR ?? join(homedir(), ".local", "state", "outridr");

export function loadConfig() {
  let file = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (error) {
      console.error(`outridr: invalid config at ${CONFIG_PATH}: ${error.message}`);
      process.exit(1);
    }
  }

  if (file.exec !== undefined) {
    console.error(
      'outridr: config key "exec" was removed in 0.4.0 (see the README\'s "Migrating from 0.3.x" note) — ignoring it',
    );
  }
  if (file.repos?.command !== undefined) {
    console.error(
      'outridr: config key "repos.command" was removed in 0.4.0; use "repos.roots" instead (see the README\'s "Migrating from 0.3.x" note) — ignoring it',
    );
  }

  const push = file.push ?? {};
  return {
    port: Number.parseInt(process.env.OUTRIDR_PORT ?? "", 10) || file.port || 8674,
    host: process.env.OUTRIDR_HOST ?? file.host ?? "tailscale",
    token: process.env.OUTRIDR_TOKEN ?? file.token ?? null,
    insecureNoToken: process.env.OUTRIDR_INSECURE_NO_TOKEN === "1" || file.insecureNoToken === true,
    herdrSocket: expandHome(
      process.env.HERDR_SOCKET_PATH ??
        file.herdrSocket ??
        join(homedir(), ".config", "herdr", "herdr.sock"),
    ),
    claudeProjectsDir: expandHome(
      process.env.CLAUDE_PROJECTS_DIR ??
        file.claudeProjectsDir ??
        join(homedir(), ".claude", "projects"),
    ),
    repos:
      Array.isArray(file.repos?.roots) && file.repos.roots.length > 0
        ? { roots: file.repos.roots.map(expandHome), depth: file.repos.depth ?? 2 }
        : null,
    push: {
      notifyOn: Array.isArray(push.notifyOn) ? push.notifyOn : ["blocked", "done"],
      pollMs: push.pollMs ?? 5000,
      enabled: push.enabled !== false,
    },
  };
}
