/**
 * Remote config writes — currently just `repos.roots`, for the app's
 * onboarding flow (`PUT /repos/roots`). Split from `lib/config.mjs` (which
 * only reads at startup) because writing is a different concern: it
 * validates, persists atomically, and mutates the live in-process config so
 * the change is visible to the next request in this process.
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { CONFIG_PATH, expandHome } from "./config.mjs";

const MAX_ROOTS = 16;
const MAX_ROOT_LENGTH = 512;

function invalidRoots(message) {
  return { ok: false, status: 400, error: "invalid-roots", message };
}

/**
 * Validates, persists, and applies a new `repos.roots` list for
 * `PUT /repos/roots`. Writes atomically (write-then-rename) to the config
 * FILE at `CONFIG_PATH`, preserving every other key (including an existing
 * `repos.depth`), then mutates `config` in place so the change is visible
 * to subsequent requests in this process. Returns `{ ok: true, roots }` or
 * a typed error `{ ok: false, status, error, message }` — never throws for
 * validation failures.
 */
export async function saveRepoRoots(config, rawRoots) {
  if (!Array.isArray(rawRoots)) {
    return invalidRoots("roots must be an array of strings");
  }
  if (rawRoots.length > MAX_ROOTS) {
    return invalidRoots(`roots must have at most ${MAX_ROOTS} entries`);
  }
  for (const entry of rawRoots) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length >= MAX_ROOT_LENGTH) {
      return invalidRoots(
        `each root must be a non-empty string under ${MAX_ROOT_LENGTH} characters: ${JSON.stringify(entry)}`,
      );
    }
  }

  const expanded = rawRoots.map(expandHome);
  for (let i = 0; i < expanded.length; i++) {
    if (!expanded[i].startsWith("/")) {
      return invalidRoots(`root must be an absolute path or start with "~/": ${rawRoots[i]}`);
    }
  }
  for (let i = 0; i < expanded.length; i++) {
    let stats;
    try {
      stats = await stat(expanded[i]);
    } catch {
      return invalidRoots(`root does not exist on the server: ${rawRoots[i]}`);
    }
    if (!stats.isDirectory()) {
      return invalidRoots(`root is not a directory: ${rawRoots[i]}`);
    }
  }

  let file = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (error) {
      return {
        ok: false,
        status: 500,
        error: "config-unreadable",
        message: `config file at ${CONFIG_PATH} is not valid JSON: ${error.message}`,
      };
    }
  }
  file.repos = { ...file.repos, roots: expanded };

  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  const tmpPath = `${CONFIG_PATH}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, CONFIG_PATH);

  config.repos = { roots: expanded, depth: config.repos?.depth ?? 2 };

  return { ok: true, roots: expanded };
}
