import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

test("loadConfig: repos absent -> null; repos.roots expands ~/ and defaults depth to 2", () => {
  const missingPath = join(mkdtempSync(join(tmpdir(), "outridr-config-")), "missing.json");
  const noRepos = loadConfigInSubprocess(baseEnv({ OUTRIDR_CONFIG: missingPath }));
  assert.equal(noRepos.repos, null);

  const cfgPath = writeConfigFile({ repos: { roots: ["~/x", "/abs/y"] } });
  const withRepos = loadConfigInSubprocess(baseEnv({ OUTRIDR_CONFIG: cfgPath }));
  assert.deepEqual(withRepos.repos.roots, [join(homedir(), "x"), "/abs/y"]);
  assert.equal(withRepos.repos.depth, 2);
});

test("loadConfig: repos.depth overrides the default", () => {
  const cfgPath = writeConfigFile({ repos: { roots: ["/abs"], depth: 4 } });
  const config = loadConfigInSubprocess(baseEnv({ OUTRIDR_CONFIG: cfgPath }));
  assert.equal(config.repos.depth, 4);
});

test("loadConfig: legacy exec/repos.command keys are ignored with a startup warning, not a crash", () => {
  const cfgPath = writeConfigFile({ exec: { command: "~/x" }, repos: { command: ["~/x"] } });
  const result = spawnSync(
    process.execPath,
    ["-e", "import('./lib/config.mjs').then(m => console.log(JSON.stringify(m.loadConfig())))"],
    { cwd: repoRoot, encoding: "utf8", env: baseEnv({ OUTRIDR_CONFIG: cfgPath }) },
  );
  assert.equal(result.status, 0);
  const config = JSON.parse(result.stdout);
  assert.equal(config.exec, undefined);
  assert.equal(config.repos, null);
  assert.match(result.stderr, /"exec" was removed/);
  assert.match(result.stderr, /"repos\.command" was removed/);
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
