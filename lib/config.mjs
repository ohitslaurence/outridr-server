/**
 * outridr configuration: JSON file + env overrides, all optional.
 *
 * File: ~/.config/outridr/config.json (or $OUTRIDR_CONFIG)
 * {
 *   "port": 8674,
 *   "host": "tailscale",            // literal address, or "tailscale"
 *   "token": "shared-secret",       // optional bearer/query token
 *   "herdrSocket": "~/.config/herdr/herdr.sock",
 *   "exec":  { "command": "~/.local/bin/dev" },   // enables POST /exec
 *   "repos": { "command": ["~/.local/bin/dev", "repos", "--json"] }, // GET /repos
 *   "push":  { "notifyOn": ["blocked", "done"], "pollMs": 5000 }     // watcher
 * }
 *
 * The core surface (WS /herdr, GET /session/<id>, /health, /push/register)
 * is always on. exec/repos are opt-in because they are workflow-specific.
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

  const push = file.push ?? {};
  return {
    port: Number.parseInt(process.env.OUTRIDR_PORT ?? "", 10) || file.port || 8674,
    host: process.env.OUTRIDR_HOST ?? file.host ?? "tailscale",
    token: process.env.OUTRIDR_TOKEN ?? file.token ?? null,
    herdrSocket: expandHome(
      process.env.HERDR_SOCKET_PATH ??
        file.herdrSocket ??
        join(homedir(), ".config", "herdr", "herdr.sock"),
    ),
    claudeProjectsDir: expandHome(
      process.env.CLAUDE_PROJECTS_DIR ?? file.claudeProjectsDir ?? join(homedir(), ".claude", "projects"),
    ),
    exec: file.exec?.command
      ? { command: expandHome(file.exec.command) }
      : null,
    repos: file.repos?.command
      ? { command: (Array.isArray(file.repos.command) ? file.repos.command : [file.repos.command]).map(expandHome) }
      : null,
    push: {
      notifyOn: Array.isArray(push.notifyOn) ? push.notifyOn : ["blocked", "done"],
      pollMs: push.pollMs ?? 5000,
      enabled: push.enabled !== false,
    },
  };
}
