/**
 * Built-in repo discovery: scan configured root folders for git repos so
 * the app can offer them for new tasks — no external CLI involved. A repo
 * is any directory containing `.git` (directory or file — linked worktrees
 * and submodule checkouts use a gitfile). Scanning stops at a repo: nested
 * repos inside a checkout are the repo's own business.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const SKIP_NAMES = new Set(["node_modules"]);

async function isRepo(dir) {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function listSubdirs(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_NAMES.has(entry.name))
    .map((entry) => join(dir, entry.name));
}

function buildAliases(paths) {
  const byBasename = new Map();
  for (const path of paths) {
    const name = basename(path);
    if (!byBasename.has(name)) {
      byBasename.set(name, []);
    }
    byBasename.get(name).push(path);
  }

  const repos = [];
  for (const [name, group] of byBasename) {
    if (group.length === 1) {
      repos.push({ alias: name, path: group[0] });
      continue;
    }
    for (const path of group) {
      repos.push({ alias: `${basename(dirname(path))}/${name}`, path });
    }
  }

  return repos.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
}

/**
 * Breadth-first walk of each root up to `depth` levels below it (root
 * itself is level 0). A directory containing `.git` is recorded and not
 * descended into. Missing or unreadable roots/subdirectories are skipped
 * silently — a misconfigured root must not fail the whole scan.
 */
export async function scanRepos(roots, depth = 2) {
  const found = [];
  for (const root of roots) {
    let frontier = [root];
    for (let level = 0; level <= depth && frontier.length > 0; level++) {
      const nextFrontier = [];
      for (const dir of frontier) {
        if (await isRepo(dir)) {
          found.push(dir);
          continue;
        }
        if (level < depth) {
          nextFrontier.push(...(await listSubdirs(dir)));
        }
      }
      frontier = nextFrontier;
    }
  }
  return buildAliases(found);
}

/**
 * Memoizes the last `scan(roots, depth)` result for `ttlMs`, keyed on the
 * exact `[roots, depth]` pair. A changed key or an expired TTL triggers a
 * rescan; concurrent calls within the TTL share the same in-flight promise.
 */
export function createRepoCache(scan, ttlMs = 30_000, now = Date.now) {
  let cachedKey = null;
  let cachedAt = 0;
  let cachedPromise = null;

  return {
    get(roots, depth) {
      const key = JSON.stringify([roots, depth]);
      const currentTime = now();
      if (cachedKey === key && currentTime - cachedAt < ttlMs) {
        return cachedPromise;
      }
      cachedKey = key;
      cachedAt = currentTime;
      cachedPromise = scan(roots, depth);
      return cachedPromise;
    },
    // Forces the next get() to rescan regardless of TTL — used after
    // PUT /repos/roots changes which folders are configured.
    invalidate() {
      cachedKey = null;
      cachedPromise = null;
    },
  };
}
