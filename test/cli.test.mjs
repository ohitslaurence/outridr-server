import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binPath = join(repoRoot, "bin", "outridr.mjs");

function baseEnv(overrides = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...overrides };
}

function missingConfigPath() {
  return join(mkdtempSync(join(tmpdir(), "outridr-config-")), "missing.json");
}

function runCli(args, env) {
  return spawnSync(process.execPath, [binPath, ...args], { cwd: repoRoot, encoding: "utf8", env });
}

test("outridr config: token is masked by default, revealed with --show-secrets", () => {
  const env = baseEnv({ OUTRIDR_CONFIG: missingConfigPath(), OUTRIDR_TOKEN: "supersecretvalue" });

  const masked = runCli(["config"], env);
  assert.equal(masked.status, 0);
  assert.match(masked.stdout, /<hidden/);
  assert.doesNotMatch(masked.stdout, /supersecretvalue/);

  const revealed = runCli(["config", "--show-secrets"], env);
  assert.equal(revealed.status, 0);
  assert.match(revealed.stdout, /supersecretvalue/);
});

test("outridr config: no token configured -> token stays null, not masked", () => {
  const env = baseEnv({ OUTRIDR_CONFIG: missingConfigPath() });
  const result = runCli(["config"], env);
  assert.equal(result.status, 0);
  const config = JSON.parse(result.stdout);
  assert.equal(config.token, null);
});

// An uncaught startup rejection (e.g. an out-of-range port reaching
// server.listen()) must be caught by the startup chain's `.catch` and
// reported cleanly, not crash with a raw Node stack trace and a bare
// unhandledRejection. Port validation happens deep in node:net, well past
// config loading, so this exercises the real end-to-end startup path.
test("outridr serve: a startup failure (invalid port) exits 1 with a clean message, not a raw crash", () => {
  const env = baseEnv({
    OUTRIDR_CONFIG: missingConfigPath(),
    OUTRIDR_PORT: "999999",
    OUTRIDR_HOST: "127.0.0.1",
  });
  const result = runCli(["serve"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outridr: startup failed:/);
  assert.doesNotMatch(result.stderr, /unhandledRejection/i);
});
