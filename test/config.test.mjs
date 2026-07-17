import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function loadConfigInSubprocess(env) {
  const script = "import('./lib/config.mjs').then(m => console.log(JSON.stringify(m.loadConfig())))";
  const stdout = execFileSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
  return JSON.parse(stdout);
}

function baseEnv(overrides = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...overrides };
}

function writeConfigFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), "outridr-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

test("loadConfig: no config file, no env -> defaults", () => {
  const config = loadConfigInSubprocess(
    baseEnv({ OUTRIDR_CONFIG: join(mkdtempSync(join(tmpdir(), "outridr-config-")), "missing.json") }),
  );
  assert.equal(config.port, 8674);
  assert.equal(config.host, "tailscale");
  assert.equal(config.token, null);
  assert.deepEqual(config.push, { notifyOn: ["blocked", "done"], pollMs: 5000, enabled: true });
});

test("loadConfig: config file values win over defaults", () => {
  const cfgPath = writeConfigFile({ port: 1234, host: "10.0.0.5", token: "s" });
  const config = loadConfigInSubprocess(baseEnv({ OUTRIDR_CONFIG: cfgPath }));
  assert.equal(config.port, 1234);
  assert.equal(config.host, "10.0.0.5");
  assert.equal(config.token, "s");
});

test("loadConfig: env overrides win over config file", () => {
  const cfgPath = writeConfigFile({ port: 1234, host: "10.0.0.5", token: "s" });
  const config = loadConfigInSubprocess(
    baseEnv({
      OUTRIDR_CONFIG: cfgPath,
      OUTRIDR_PORT: "9999",
      OUTRIDR_HOST: "1.2.3.4",
      OUTRIDR_TOKEN: "t",
    }),
  );
  assert.equal(config.port, 9999);
  assert.equal(config.host, "1.2.3.4");
  assert.equal(config.token, "t");
});

test("loadConfig: exec absent -> null; exec.command expands ~/", () => {
  const missingPath = join(mkdtempSync(join(tmpdir(), "outridr-config-")), "missing.json");
  const noExec = loadConfigInSubprocess(baseEnv({ OUTRIDR_CONFIG: missingPath }));
  assert.equal(noExec.exec, null);

  const cfgPath = writeConfigFile({ exec: { command: "~/x" } });
  const withExec = loadConfigInSubprocess(baseEnv({ OUTRIDR_CONFIG: cfgPath }));
  assert.equal(withExec.exec.command, join(homedir(), "x"));
  assert.ok(withExec.exec.command.startsWith("/"));
});

test("loadConfig: repos.command bare string -> one-element array", () => {
  const cfgPath = writeConfigFile({ repos: { command: "~/x" } });
  const config = loadConfigInSubprocess(baseEnv({ OUTRIDR_CONFIG: cfgPath }));
  assert.deepEqual(config.repos.command, [join(homedir(), "x")]);
});

test("loadConfig: invalid JSON in config file -> process exits 1 with 'invalid config'", () => {
  const dir = mkdtempSync(join(tmpdir(), "outridr-config-"));
  const cfgPath = join(dir, "bad.json");
  writeFileSync(cfgPath, "not json");
  assert.throws(
    () => loadConfigInSubprocess(baseEnv({ OUTRIDR_CONFIG: cfgPath })),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr.toString(), /invalid config/);
      return true;
    },
  );
});

test("expandHome: ~/x expands, /abs unchanged, non-string passthrough", async () => {
  const { expandHome } = await import("../lib/config.mjs");
  assert.equal(expandHome("~/x"), join(homedir(), "x"));
  assert.equal(expandHome("/abs"), "/abs");
  assert.equal(expandHome(42), 42);
  assert.equal(expandHome(null), null);
});
