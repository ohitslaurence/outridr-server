import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serviceSource = readFileSync(join(repoRoot, "lib", "service.mjs"), "utf8");

// Env-before-import: CLI_BIN_DIR is read at module load of lib/service.mjs,
// so OUTRIDR_BIN_DIR must be set to an isolated temp dir before the first
// import of that module in this process (module instances are cached by
// resolved URL, so a static import here would evaluate service.mjs too
// early — with the real ~/.local/bin — and poison the cache). This file
// must never write to the real ~/.local/bin.
const binDir = mkdtempSync(join(tmpdir(), "outridr-bin-"));
process.env.OUTRIDR_BIN_DIR = binDir;

const { xmlEscape, installCliLauncher, removeCliLauncher } = await import("../lib/service.mjs");

const launcherPath = join(binDir, "outridr");

test("xmlEscape: escapes &, <, and >", () => {
  assert.equal(xmlEscape("a<&>b"), "a&lt;&amp;&gt;b");
});

test("xmlEscape: escapes & before < and >, so already-escaped entities are not double-escaped incorrectly", () => {
  // Escaping & first, then < and >, means a literal "&lt;" in the input
  // becomes "&amp;lt;" — the correct, safe outcome for an unescaped input
  // that merely contains those characters.
  assert.equal(xmlEscape("&lt;"), "&amp;lt;");
});

test("xmlEscape: a clean absolute path is unchanged", () => {
  assert.equal(xmlEscape("/usr/local/bin/node"), "/usr/local/bin/node");
});

test("xmlEscape: non-string values are coerced to string", () => {
  assert.equal(xmlEscape(42), "42");
});

test("lib/service.mjs: the launchd plist template runs interpolated values through xmlEscape", () => {
  const usages = serviceSource.match(/\$\{xmlEscape\(/g) ?? [];
  assert.ok(usages.length >= 3, `expected >= 3 template usages of xmlEscape(, found ${usages.length}`);
});

test("installCliLauncher: writes an executable launcher that execs the pinned Node binary", () => {
  installCliLauncher();
  const contents = readFileSync(launcherPath, "utf8");
  const mode = statSync(launcherPath).mode;
  assert.ok(mode & 0o111, "launcher should be executable");
  assert.ok(contents.includes(process.execPath), "launcher should exec the pinned Node binary");
  assert.ok(contents.includes("outridr.mjs"), "launcher should invoke the outridr entrypoint");
  assert.ok(contents.includes("# managed by `outridr install` — safe to delete"), "launcher should contain the marker");
});

test("removeCliLauncher: deletes the launcher it wrote", () => {
  installCliLauncher();
  removeCliLauncher();
  assert.throws(() => readFileSync(launcherPath, "utf8"));
});

test("removeCliLauncher: leaves a foreign file (no marker) in place", () => {
  writeFileSync(launcherPath, "#!/bin/sh\necho not ours\n", { mode: 0o755 });
  removeCliLauncher();
  assert.equal(readFileSync(launcherPath, "utf8"), "#!/bin/sh\necho not ours\n");
});
