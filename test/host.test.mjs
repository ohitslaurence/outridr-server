import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { makeTmpDir } from "./helpers.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverUrl = pathToFileURL(join(repoRoot, "lib", "server.mjs")).href;

function writeFakeTailscale(dir, scriptBody) {
  const path = join(dir, "tailscale");
  writeFileSync(path, scriptBody);
  chmodSync(path, 0o755);
  return dir;
}

function writeChildScript(config) {
  const dir = makeTmpDir("outridr-host-child");
  const scriptPath = join(dir, "child.mjs");
  writeFileSync(
    scriptPath,
    `import { startServer } from ${JSON.stringify(serverUrl)};\nstartServer(${JSON.stringify(config)});\n`,
  );
  return scriptPath;
}

function childConfig() {
  return {
    port: 0,
    host: "tailscale",
    token: null,
    herdrSocket: join(makeTmpDir("outridr-host-herdr"), "herdr.sock"),
    claudeProjectsDir: makeTmpDir("outridr-host-projects"),
    exec: null,
    repos: null,
    push: { notifyOn: ["blocked", "done"], pollMs: 5000, enabled: false },
  };
}

function spawnChild(scriptPath, env) {
  const child = spawn(process.execPath, [scriptPath], { env });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk.toString("utf8");
  });
  return { child, output };
}

function waitFor(getValue, predicate, { timeoutMs = 10000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const value = getValue();
      if (predicate(value)) {
        resolve(value);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timeout waiting for condition; last value seen: ${JSON.stringify(value)}`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for process exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseEnv(overrides = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OUTRIDR_STATE_DIR: makeTmpDir("outridr-host-state"),
    ...overrides,
  };
}

test("host resolution: tailscale reports an IPv4 -> server listens on it", async (t) => {
  // The fake tailscale reports 127.0.0.1 (the only IPv4 guaranteed bindable
  // in any test sandbox) — what's under test is that resolveHost's output
  // reaches server.listen unmodified, not which address it happens to be.
  const fakeDir = writeFakeTailscale(makeTmpDir("outridr-fake-tailscale"), "#!/bin/sh\necho 127.0.0.1\n");
  const scriptPath = writeChildScript(childConfig());
  const { child, output } = spawnChild(
    scriptPath,
    baseEnv({
      PATH: fakeDir,
      OUTRIDR_HOST_RESOLVE_ATTEMPTS: "2",
      OUTRIDR_HOST_RESOLVE_DELAY_MS: "50",
    }),
  );
  t.after(() => child.kill());

  await waitFor(() => output.stdout, (stdout) => stdout.includes("outridr listening on 127.0.0.1:"));
});

test("host resolution: tailscale always fails -> subprocess exits 1", async (t) => {
  const fakeDir = writeFakeTailscale(makeTmpDir("outridr-fake-tailscale"), "#!/bin/sh\nexit 1\n");
  const scriptPath = writeChildScript(childConfig());
  const { child, output } = spawnChild(
    scriptPath,
    baseEnv({
      PATH: fakeDir,
      OUTRIDR_HOST_RESOLVE_ATTEMPTS: "2",
      OUTRIDR_HOST_RESOLVE_DELAY_MS: "50",
    }),
  );
  t.after(() => child.kill());

  const { code } = await waitForExit(child);
  assert.equal(code, 1);
  assert.match(output.stderr, /no Tailscale IPv4/);
});

test("host resolution: tailscale binary missing -> subprocess exits 1 with a clear message", async (t) => {
  const emptyDir = makeTmpDir("outridr-empty-path");
  const scriptPath = writeChildScript(childConfig());
  const { child, output } = spawnChild(
    scriptPath,
    baseEnv({
      PATH: `${emptyDir}:${dirname(process.execPath)}`,
      OUTRIDR_HOST_RESOLVE_ATTEMPTS: "2",
      OUTRIDR_HOST_RESOLVE_DELAY_MS: "50",
    }),
  );
  t.after(() => child.kill());

  const { code } = await waitForExit(child);
  assert.equal(code, 1);
  assert.match(output.stderr, /not found/);
});

test("host resolution: tailscale fails twice then succeeds -> server eventually listens", async (t) => {
  const fakeDir = makeTmpDir("outridr-fake-tailscale");
  const countFile = join(fakeDir, "count");
  writeFakeTailscale(
    fakeDir,
    [
      "#!/bin/sh",
      `COUNT_FILE="${countFile}"`,
      "COUNT=0",
      'if [ -f "$COUNT_FILE" ]; then COUNT=$(cat "$COUNT_FILE"); fi',
      "COUNT=$((COUNT + 1))",
      'echo "$COUNT" > "$COUNT_FILE"',
      'if [ "$COUNT" -le 2 ]; then',
      "  exit 1",
      "fi",
      "echo 127.0.0.1",
      "",
    ].join("\n"),
  );
  const scriptPath = writeChildScript(childConfig());
  const { child, output } = spawnChild(
    scriptPath,
    baseEnv({
      // Unlike the other fakes, this one shells out to `cat` internally to
      // read its invocation counter, so PATH needs real system dirs too —
      // fakeDir still wins the `tailscale` lookup because it's listed first.
      PATH: `${fakeDir}:/bin:/usr/bin`,
      OUTRIDR_HOST_RESOLVE_ATTEMPTS: "3",
      OUTRIDR_HOST_RESOLVE_DELAY_MS: "50",
    }),
  );
  t.after(() => child.kill());

  await waitFor(() => output.stdout, (stdout) => stdout.includes("outridr listening on 127.0.0.1:"));
  assert.match(output.stderr, /waiting for a Tailscale IPv4/);
});

test("host re-check: Tailscale IPv4 changes after listen -> subprocess exits 1", async (t) => {
  const fakeDir = makeTmpDir("outridr-fake-tailscale");
  const countFile = join(fakeDir, "count");
  writeFakeTailscale(
    fakeDir,
    [
      "#!/bin/sh",
      `COUNT_FILE="${countFile}"`,
      "COUNT=0",
      'if [ -f "$COUNT_FILE" ]; then COUNT=$(cat "$COUNT_FILE"); fi',
      "COUNT=$((COUNT + 1))",
      'echo "$COUNT" > "$COUNT_FILE"',
      'if [ "$COUNT" -eq 1 ]; then',
      "  echo 127.0.0.1",
      "else",
      "  echo 127.0.0.2",
      "fi",
      "",
    ].join("\n"),
  );
  const scriptPath = writeChildScript(childConfig());
  const { child, output } = spawnChild(
    scriptPath,
    baseEnv({
      // Shells out to `cat` internally, so PATH needs real system dirs too —
      // fakeDir still wins the `tailscale` lookup because it's listed first.
      PATH: `${fakeDir}:/bin:/usr/bin`,
      OUTRIDR_HOST_RESOLVE_ATTEMPTS: "2",
      OUTRIDR_HOST_RESOLVE_DELAY_MS: "50",
      OUTRIDR_HOST_RECHECK_MS: "100",
    }),
  );
  t.after(() => child.kill());

  await waitFor(() => output.stdout, (stdout) => stdout.includes("outridr listening on 127.0.0.1:"));
  const { code } = await waitForExit(child);
  assert.equal(code, 1);
  assert.match(output.stderr, /Tailscale IPv4 changed/);
});

test("host re-check: Tailscale IPv4 unchanged -> subprocess stays alive", async (t) => {
  const fakeDir = writeFakeTailscale(makeTmpDir("outridr-fake-tailscale"), "#!/bin/sh\necho 127.0.0.1\n");
  const scriptPath = writeChildScript(childConfig());
  const { child, output } = spawnChild(
    scriptPath,
    baseEnv({
      PATH: fakeDir,
      OUTRIDR_HOST_RESOLVE_ATTEMPTS: "2",
      OUTRIDR_HOST_RESOLVE_DELAY_MS: "50",
      OUTRIDR_HOST_RECHECK_MS: "100",
    }),
  );
  t.after(() => child.kill());

  await waitFor(() => output.stdout, (stdout) => stdout.includes("outridr listening on 127.0.0.1:"));
  await delay(500);
  assert.equal(child.exitCode, null);
  child.kill();
});

test("host re-check: transient Tailscale failure after listen -> subprocess stays alive", async (t) => {
  const fakeDir = makeTmpDir("outridr-fake-tailscale");
  const countFile = join(fakeDir, "count");
  writeFakeTailscale(
    fakeDir,
    [
      "#!/bin/sh",
      `COUNT_FILE="${countFile}"`,
      "COUNT=0",
      'if [ -f "$COUNT_FILE" ]; then COUNT=$(cat "$COUNT_FILE"); fi',
      "COUNT=$((COUNT + 1))",
      'echo "$COUNT" > "$COUNT_FILE"',
      'if [ "$COUNT" -eq 1 ]; then',
      "  echo 127.0.0.1",
      "else",
      "  exit 1",
      "fi",
      "",
    ].join("\n"),
  );
  const scriptPath = writeChildScript(childConfig());
  const { child, output } = spawnChild(
    scriptPath,
    baseEnv({
      PATH: `${fakeDir}:/bin:/usr/bin`,
      OUTRIDR_HOST_RESOLVE_ATTEMPTS: "2",
      OUTRIDR_HOST_RESOLVE_DELAY_MS: "50",
      OUTRIDR_HOST_RECHECK_MS: "100",
    }),
  );
  t.after(() => child.kill());

  await waitFor(() => output.stdout, (stdout) => stdout.includes("outridr listening on 127.0.0.1:"));
  await delay(500);
  assert.equal(child.exitCode, null);
  child.kill();
});
