/**
 * Service management: installs outridr as a user service so it survives
 * reboots and runs without a login session.
 *
 * Linux: systemd user unit + linger. macOS: launchd agent. The unit invokes
 * the CURRENT node binary and this package's entrypoint by absolute path, so
 * version managers (fnm/mise/nvm) that only wire up interactive shells are
 * not a problem.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Escapes the XML special characters (`&`, `<`, `>`) that appear in plist string values. */
export function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SERVE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "outridr.mjs");

const SYSTEMD_UNIT_PATH = join(homedir(), ".config", "systemd", "user", "outridr.service");
const LAUNCHD_PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "dev.outridr.plist");

export function installService() {
  if (platform() === "linux") {
    installSystemd();
  } else if (platform() === "darwin") {
    installLaunchd();
  } else {
    console.error(`outridr: unsupported platform ${platform()} — run \`outridr serve\` under your own supervisor`);
    process.exit(1);
  }
}

export function uninstallService() {
  if (platform() === "linux") {
    run("systemctl", ["--user", "disable", "--now", "outridr"], true);
    rmSync(SYSTEMD_UNIT_PATH, { force: true });
    run("systemctl", ["--user", "daemon-reload"], true);
    console.log("outridr: systemd unit removed");
  } else if (platform() === "darwin") {
    run("launchctl", ["bootout", launchdTarget()], true);
    rmSync(LAUNCHD_PLIST_PATH, { force: true });
    console.log("outridr: launchd agent removed");
  }
}

export function serviceStatus() {
  if (platform() === "linux") {
    run("systemctl", ["--user", "status", "outridr", "--no-pager"], true, true);
  } else if (platform() === "darwin") {
    const printed = run("launchctl", ["print", launchdTarget()], true, true);
    if (!printed) {
      run("launchctl", ["list", "dev.outridr"], true, true);
    }
  }
}

function installSystemd() {
  const unit = `[Unit]
Description=outridr — herdr tailnet server for the outridr app
After=network-online.target

[Service]
ExecStart=${process.execPath} ${SERVE_ENTRY} serve
# Node (#!/usr/bin/env node shebang) and the tailscale binary lookup
# (tailscale ip -4 at startup) need user bins on PATH — systemd's default
# is bare.
Environment=PATH=${servicePath()}
# If this starts before tailscaled has an IP (common right after boot —
# user units can't reliably order after tailscaled), the process retries
# briefly then exits non-zero; Restart=on-failure brings it back up once
# Tailscale is ready.
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
  mkdirSync(dirname(SYSTEMD_UNIT_PATH), { recursive: true });
  writeFileSync(SYSTEMD_UNIT_PATH, unit);
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "outridr"]);
  // restart (not enable --now): reinstalls over a running service must pick
  // up the new unit and code.
  run("systemctl", ["--user", "restart", "outridr"]);
  run("loginctl", ["enable-linger", userInfo().username], true);
  console.log(`outridr: installed and started (${SYSTEMD_UNIT_PATH})`);
  console.log("outridr: check with `outridr status`");
}

function installLaunchd() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.outridr</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(SERVE_ENTRY)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(servicePath())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
</dict>
</plist>
`;
  mkdirSync(dirname(LAUNCHD_PLIST_PATH), { recursive: true });
  writeFileSync(LAUNCHD_PLIST_PATH, plist);
  run("launchctl", ["bootout", launchdTarget()], true);
  run("launchctl", ["bootstrap", launchdDomain(), LAUNCHD_PLIST_PATH]);
  console.log(`outridr: installed and started (${LAUNCHD_PLIST_PATH})`);
}

function servicePath() {
  return [
    dirname(process.execPath),
    join(homedir(), ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
}

function launchdDomain() {
  return `gui/${process.getuid()}`;
}

function launchdTarget() {
  return `${launchdDomain()}/dev.outridr`;
}

/** Runs `command`; returns true on success, false on a failure allowed via `allowFailure`. */
function run(command, args, allowFailure = false, inheritOutput = false) {
  try {
    const output = execFileSync(command, args, { encoding: "utf8" });
    if (inheritOutput && output) {
      process.stdout.write(output);
    }
    return true;
  } catch (error) {
    if (inheritOutput && (error.stdout || error.stderr)) {
      process.stdout.write(error.stdout ?? "");
      process.stderr.write(error.stderr ?? "");
    }
    if (!allowFailure) {
      console.error(`outridr: ${command} ${args.join(" ")} failed: ${error.message}`);
      process.exit(1);
    }
    return false;
  }
}
