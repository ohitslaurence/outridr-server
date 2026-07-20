import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createRepoCache, scanRepos } from "../lib/repos.mjs";
import { makeTmpDir } from "./helpers.mjs";

function makeGitDir(repoDir) {
  mkdirSync(join(repoDir, ".git"), { recursive: true });
}

function makeGitFile(repoDir) {
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, ".git"), "gitdir: ../.git/worktrees/x\n");
}

test("scanRepos: excludes linked worktrees and submodule checkouts (gitfile .git)", async () => {
  const root = makeTmpDir("outridr-repos-basic");
  makeGitDir(join(root, "a"));
  makeGitFile(join(root, "b"));

  const repos = await scanRepos([root]);

  assert.deepEqual(repos, [{ alias: "a", path: join(root, "a") }]);
});

test("scanRepos: respects depth", async () => {
  const root = makeTmpDir("outridr-repos-depth");
  makeGitDir(join(root, "x", "y"));

  const shallow = await scanRepos([root], 1);
  assert.deepEqual(shallow, []);

  const deep = await scanRepos([root], 2);
  assert.deepEqual(deep, [{ alias: "y", path: join(root, "x", "y") }]);
});

test("scanRepos: does not descend into a found repo", async () => {
  const root = makeTmpDir("outridr-repos-nodescend");
  makeGitDir(join(root, "a"));
  makeGitDir(join(root, "a", "vendor", "inner"));

  const repos = await scanRepos([root]);

  assert.deepEqual(repos, [{ alias: "a", path: join(root, "a") }]);
});

test("scanRepos: skips hidden directories and node_modules", async () => {
  const root = makeTmpDir("outridr-repos-skip");
  makeGitDir(join(root, "a"));
  makeGitDir(join(root, ".hidden", "repo"));
  makeGitDir(join(root, "node_modules", "pkg"));

  const repos = await scanRepos([root]);

  assert.deepEqual(repos, [{ alias: "a", path: join(root, "a") }]);
});

test("scanRepos: disambiguates basename collisions with the parent dir", async () => {
  const root = makeTmpDir("outridr-repos-collision");
  makeGitDir(join(root, "a", "proj"));
  makeGitDir(join(root, "b", "proj"));

  const repos = await scanRepos([root]);

  assert.deepEqual(repos, [
    { alias: "a/proj", path: join(root, "a", "proj") },
    { alias: "b/proj", path: join(root, "b", "proj") },
  ]);
});

test("scanRepos: missing root -> empty result, no throw", async () => {
  const root = makeTmpDir("outridr-repos-missing");
  const repos = await scanRepos([join(root, "does-not-exist")]);
  assert.deepEqual(repos, []);
});

test("createRepoCache: memoizes within TTL, rescans after TTL expires", async () => {
  const root = makeTmpDir("outridr-repos-cache");
  makeGitDir(join(root, "a"));

  let now = 0;
  let calls = 0;
  const spyScan = async (roots, depth) => {
    calls++;
    return scanRepos(roots, depth);
  };
  const cache = createRepoCache(spyScan, 30_000, () => now);

  await cache.get([root], 2);
  await cache.get([root], 2);
  assert.equal(calls, 1, "second call within TTL must reuse the cached scan");

  now += 30_001;
  await cache.get([root], 2);
  assert.equal(calls, 2, "call after TTL expiry must rescan");
});
