import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function baseEnv(overrides = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...overrides };
}

function runPair(env) {
  return execFileSync(process.execPath, [join(repoRoot, "bin", "outridr.mjs"), "pair"], {
    encoding: "utf8",
    env,
  });
}

function tmpConfigPath() {
  return join(mkdtempSync(join(tmpdir(), "outridr-pair-")), "config.json");
}

// Writes a fake `tailscale` that answers `ip -4` and `status --json`, and
// returns the dir to point OUTRIDR_TAILSCALE_BIN at (the binary itself).
function fakeTailscale(ip, dnsName) {
  const dir = mkdtempSync(join(tmpdir(), "outridr-pair-ts-"));
  const bin = join(dir, "tailscale");
  const status = dnsName
    ? JSON.stringify({ Self: { DNSName: dnsName } })
    : JSON.stringify({ Self: {} });
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1 $2" = "status --json" ]; then\n  echo '${status}'\nelse\n  echo ${ip}\nfi\n`,
    { mode: 0o755 },
  );
  return bin;
}

test("pair: with host + token in env -> prints the outridr:// URI and a QR block", () => {
  const stdout = runPair(
    baseEnv({
      OUTRIDR_CONFIG: tmpConfigPath(),
      OUTRIDR_HOST: "127.0.0.1",
      OUTRIDR_PORT: "8674",
      OUTRIDR_TOKEN: "abc",
    }),
  );
  assert.match(stdout, /outridr:\/\/pair\?v=1&host=127\.0\.0\.1&port=8674&token=abc/);
  // A QR block (rendered with half-block glyphs) appears before the URI line.
  const uriIndex = stdout.indexOf("outridr://pair?v=1&host=127.0.0.1&port=8674&token=abc");
  const qrBlock = stdout.slice(0, uriIndex);
  assert.match(qrBlock, /[█▀▄]/, "expected half-block QR glyphs above the URI");
});

test("pair: no token configured -> generates one, persists it, and reuses it on a second run", () => {
  const cfgPath = tmpConfigPath();
  const env = baseEnv({ OUTRIDR_CONFIG: cfgPath, OUTRIDR_HOST: "127.0.0.1", OUTRIDR_PORT: "8674" });

  const firstStdout = runPair(env);
  const firstMatch = firstStdout.match(
    /outridr:\/\/pair\?v=1&host=127\.0\.0\.1&port=8674&token=([0-9a-f]+)/,
  );
  assert.ok(firstMatch, "expected a generated token in the URI");
  const firstToken = firstMatch[1];
  assert.equal(firstToken.length, 64, "generated token should be 64 hex characters");

  const configFile = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(configFile.token, firstToken);

  const secondStdout = runPair(env);
  const secondMatch = secondStdout.match(
    /outridr:\/\/pair\?v=1&host=127\.0\.0\.1&port=8674&token=([0-9a-f]+)/,
  );
  assert.ok(secondMatch, "expected a token in the second run's URI");
  assert.equal(
    secondMatch[1],
    firstToken,
    "pairing must be idempotent: same token on a second run",
  );
});

test("pair: prints a human summary line and a caution about the URI granting access", () => {
  const stdout = runPair(
    baseEnv({
      OUTRIDR_CONFIG: tmpConfigPath(),
      OUTRIDR_HOST: "127.0.0.1",
      OUTRIDR_PORT: "9999",
      OUTRIDR_TOKEN: "secret-token-value",
    }),
  );
  assert.match(stdout, /host=127\.0\.0\.1 port=9999 token=set/);
  assert.match(stdout, /treat it like a password/);
  // The bare token must not appear on its own outside the URI (only as part
  // of the outridr:// URI's query string).
  const withoutUri = stdout.replace(/outridr:\/\/[^\s]+/g, "");
  assert.equal(withoutUri.includes("secret-token-value"), false);
});

test("pair: host=tailscale prefers the MagicDNS name over the IP", () => {
  const stdout = runPair(
    baseEnv({
      OUTRIDR_CONFIG: tmpConfigPath(),
      OUTRIDR_HOST: "tailscale",
      OUTRIDR_PORT: "8674",
      OUTRIDR_TOKEN: "abc",
      OUTRIDR_TAILSCALE_BIN: fakeTailscale("100.114.60.46", "gondor.tailtest.ts.net."),
    }),
  );
  assert.match(stdout, /outridr:\/\/pair\?v=1&host=gondor\.tailtest\.ts\.net&port=8674&token=abc/);
  assert.doesNotMatch(
    stdout,
    /host=100\.114\.60\.46/,
    "should not fall back to the IP when a MagicDNS name exists",
  );
});

test("pair: host=tailscale falls back to the IP when MagicDNS has no name", () => {
  const stdout = runPair(
    baseEnv({
      OUTRIDR_CONFIG: tmpConfigPath(),
      OUTRIDR_HOST: "tailscale",
      OUTRIDR_PORT: "8674",
      OUTRIDR_TOKEN: "abc",
      OUTRIDR_TAILSCALE_BIN: fakeTailscale("100.114.60.46", null),
    }),
  );
  assert.match(stdout, /outridr:\/\/pair\?v=1&host=100\.114\.60\.46&port=8674&token=abc/);
});
