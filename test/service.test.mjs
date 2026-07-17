import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { xmlEscape } from "../lib/service.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serviceSource = readFileSync(join(repoRoot, "lib", "service.mjs"), "utf8");

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
