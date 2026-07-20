#!/usr/bin/env node
/**
 * outridr — ride flank on your coding agents.
 *
 * Exposes a herdr machine to your tailnet for the outridr mobile app:
 * live agent statuses, structured Claude Code transcripts, remote input,
 * and push notifications when an agent needs you.
 */
import { CONFIG_PATH, loadConfig } from "../lib/config.mjs";
import { runPair } from "../lib/pair.mjs";
import { startServer } from "../lib/server.mjs";
import { installService, serviceStatus, uninstallService } from "../lib/service.mjs";

const HELP = `outridr — ride flank on your coding agents

Usage:
  outridr serve        Run the server in the foreground
  outridr install      Install + start as a user service (systemd/launchd)
  outridr uninstall    Stop and remove the user service
  outridr status       Show service status
  outridr config       Print the resolved configuration
  outridr pair         Generate a token (if needed) and print a QR + URI for the app

Config file: ${CONFIG_PATH} (all fields optional; see README)
Env: OUTRIDR_PORT, OUTRIDR_HOST, OUTRIDR_TOKEN, HERDR_SOCKET_PATH
`;

const [command = "help"] = process.argv.slice(2);

switch (command) {
  case "serve":
    startServer(loadConfig());
    break;
  case "install":
    installService();
    break;
  case "uninstall":
    uninstallService();
    break;
  case "status":
    serviceStatus();
    break;
  case "config":
    console.log(JSON.stringify(loadConfig(), null, 2));
    break;
  case "pair":
    await runPair();
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`outridr: unknown command '${command}'\n`);
    console.log(HELP);
    process.exit(1);
}
