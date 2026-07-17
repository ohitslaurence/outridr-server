# Plan 001: Establish a test baseline (node:test integration harness), CI, and LICENSE

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a16bc22..HEAD -- lib/ bin/ package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (adds tests and CI; only `package.json` and one exported hook change in runtime code)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `a16bc22`, 2026-07-17

## Why this matters

outridr is a zero-dependency Node server published to npm (`npx outridr install`) and distributed as a herdr plugin. Today the only verification is `npm run check`, which is `node --check` — a syntax check. There are **zero tests**. The riskiest logic in the repo — byte-offset transcript windowing with multibyte/oversized-line handling, a hand-rolled RFC6455 WebSocket codec, config precedence — is exactly the kind of fiddly code that regresses silently. Every other plan in `plans/` depends on this harness existing so its fix can ship with a regression test. This plan also adds the missing `LICENSE` file (package.json declares MIT but no license file exists — a real problem for a public package) and a GitHub Actions CI workflow.

## Current state

Repo layout (entire repo — it is small):

- `bin/outridr.mjs` — CLI entrypoint (`serve|install|uninstall|status|config|help`).
- `lib/server.mjs` — the whole server: HTTP routing, session transcript windowing, push watcher, Expo push, minimal WebSocket server bridging to herdr's unix socket. Exports only `startServer(config)`.
- `lib/config.mjs` — config loading (JSON file + env overrides). Exports `expandHome`, `CONFIG_PATH`, `STATE_DIR`, `loadConfig`.
- `lib/service.mjs` — systemd/launchd service install (not tested by this plan; it mutates the host system).
- `package.json` — `"type": "module"`, `"engines": {"node": ">=20"}`, scripts: `serve`, `check`. No test script, no devDependencies (keep it that way — **zero runtime and zero dev dependencies is a stated feature**; use only `node:test` and `node:assert`).

Key facts about `lib/server.mjs` the harness relies on (verify these against the live file):

- `startServer(config)` (line 54) creates the HTTP server, wires the upgrade handler, optionally starts the push watcher (`if (config.push.enabled)`), calls `server.listen(config.port, host, ...)` and **returns the `server` object**. Passing `port: 0` therefore works and the bound port is available via `server.address().port`.
- `resolveHost` (line 75) shells out to `tailscale` only when `config.host === "tailscale"`; tests must always pass `host: "127.0.0.1"` to avoid that.
- `STATE_DIR` is imported at module load from `lib/config.mjs`, which reads `process.env.OUTRIDR_STATE_DIR` **at import time** (config.mjs lines 32–33). The `PushTokenStore` persists tokens under it. Tests MUST set `process.env.OUTRIDR_STATE_DIR` to a temp dir **before** importing `lib/server.mjs` (use a dynamic `await import(...)` after setting env), otherwise tests write to the real `~/.local/state/outridr`.
- herdr protocol: one request per unix-socket connection. Client writes one JSON line `{"id":..., "method":..., "params":...}\n`; herdr writes one JSON line back (with a `result` field) and closes. `herdrRequest` in server.mjs (line 210) parses `JSON.parse(firstLine).result`.
- Session transcripts: `GET /session/<36-char [0-9a-f-] id>` finds `<claudeProjectsDir>/<anyDir>/<id>.jsonl` and serves newline-aligned byte windows. Constants (lines 46–47): `SESSION_TAIL_BYTES = 256 * 1024`, `SESSION_CHUNK_BYTES = 512 * 1024`. Response shape (line 355): `{ start, offset, size, entries, more }`. Query params: none → tail of 256 KiB; `offset=N` → forward from N; `end=N` → window ending at N (history pagination). An oversized line (one JSON line larger than the 512 KiB read window, with more file beyond it) is skipped via `nextNewlineOffset` so `offset` still advances (the guard at lines 333–341, added in commit `a16bc22`).
- Push registration: `POST /push/register` body `{"token": "ExponentPushToken[xxx]", "device": "name"}`; token must match `/^(ExponentPushToken|ExpoPushToken)\[.+\]$/` (line 130).
- Auth: when `config.token` is set, every HTTP request and WS upgrade requires `Authorization: Bearer <token>` or `?token=<token>` (lines 87–95, 495).
- WebSocket: path `/herdr`, standard RFC6455 handshake (Sec-WebSocket-Accept = base64(sha1(key + `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`))). Text frames carry NDJSON request lines; each line is proxied to herdr over a fresh unix connection and response lines come back as text frames. If the herdr socket is unreachable, the server synthesizes `{"id": <request id>, "error": {"code": "outridr_error", "message": "herdr socket unavailable"}}\n` (lines 562–573).
- `loadConfig()` (config.mjs line 35) reads `CONFIG_PATH` which is fixed at import time from `process.env.OUTRIDR_CONFIG` — config tests must set `OUTRIDR_CONFIG` before dynamically importing `lib/config.mjs`. Precedence per field: env var → config file → default. Defaults: port 8674, host `"tailscale"`, token null.

The config object shape tests should construct directly (mirrors `loadConfig()` output, config.mjs lines 47–70):

```js
{
  port: 0,
  host: "127.0.0.1",
  token: null,                       // or a string to test auth
  herdrSocket: "<tmpdir>/herdr.sock",
  claudeProjectsDir: "<tmpdir>/projects",
  exec: null,                        // or { command: "<abs path>" }
  repos: null,                       // or { command: ["<abs path>", ...args] }
  push: { notifyOn: ["blocked", "done"], pollMs: 5000, enabled: false },
}
```

Repo conventions to match: plain modern ESM `.mjs`, named exports only, kebab-case filenames, no inline comments except "why" notes, 2-space indent, double quotes, trailing commas (see any file in `lib/`).

## Commands you will need

| Purpose        | Command          | Expected on success |
|----------------|------------------|---------------------|
| Syntax check   | `npm run check`  | exit 0              |
| Tests (after this plan) | `npm test` | exit 0, all pass |
| Single test file | `node --test test/session.test.mjs` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `test/helpers.mjs` (create)
- `test/http.test.mjs` (create)
- `test/session.test.mjs` (create)
- `test/websocket.test.mjs` (create)
- `test/config.test.mjs` (create)
- `package.json` (add `test` script only)
- `.github/workflows/ci.yml` (create)
- `LICENSE` (create)

**Out of scope** (do NOT touch):
- `lib/server.mjs`, `lib/config.mjs`, `lib/service.mjs`, `bin/outridr.mjs` — this plan is characterization only. If a test reveals a bug, write the test to assert **current** behavior with a `// BUG:` comment referencing the relevant plan (002–005), or skip it with `t.skip("fixed by plan NNN")`. Do not fix runtime code here.
- `lib/service.mjs` testing — service install mutates the host (systemd/launchd); explicitly untested.
- Any new dependency, including devDependencies. `node:test` + `node:assert` only.

## Git workflow

- Branch: `advisor/001-test-baseline`
- Commit style (match `git log`): short imperative header, optional body. Example from repo: `Skip oversized transcript lines so the stream can't freeze`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the `test` script and LICENSE

In `package.json` scripts, add: `"test": "node --test test/"`.

Create `LICENSE` with the standard MIT license text, copyright line: `Copyright (c) 2026 outridr contributors` (unless the operator supplies a name).

**Verify**: `npm test` → exits non-zero with "no test files" or runs 0 tests (directory doesn't exist yet — either outcome is fine); `test -f LICENSE` → exit 0.

### Step 2: Write `test/helpers.mjs`

Create shared helpers. Required exports (shape below is load-bearing; implement bodies as needed):

```js
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MUST run before importing lib/server.mjs anywhere in the test process:
process.env.OUTRIDR_STATE_DIR = mkdtempSync(join(tmpdir(), "outridr-state-"));

export function makeTmpDir(prefix) { /* mkdtempSync under os.tmpdir() */ }

// Config factory matching loadConfig() output; overrides merged on top.
export function makeConfig(overrides = {}) { /* shape from plan "Current state" */ }

// Fake herdr: unix-socket server. `handler(request)` returns the response
// object to write as one JSON line, or null to close without answering.
// Must close each connection after responding (herdr's real behavior).
export function startFakeHerdr(socketPath, handler) { /* net.createServer */ }

// Boot the real server on port 0; resolves { server, port, baseUrl }.
export async function startTestServer(configOverrides) {
  const { startServer } = await import("../lib/server.mjs");
  /* listen, await 'listening', return address().port */
}

// Minimal HTTP helpers over fetch (Node 20 has global fetch).
export async function getJson(url, headers) { /* fetch, return {status, body} */ }
export async function postJson(url, payload, headers) { /* ... */ }

// Raw WebSocket client for /herdr: performs the RFC6455 handshake over
// net.connect, sends MASKED text frames (clients must mask), collects
// received text frames. Node 20's global WebSocket (undici) may be used
// instead if available — but the raw client is required by at least one
// test in websocket.test.mjs to control masking/fragmentation precisely.
export function connectRawWs(port, path, { headers } = {}) { /* ... */ }
```

Also add a `writeSessionFixture(projectsDir, sessionId, lines)` helper: creates `projectsDir/<dirname>/<sessionId>.jsonl` (any single subdirectory name, e.g. `proj-a`) with the given array of objects serialized one-per-line.

**Verify**: `node --check test/helpers.mjs` → exit 0.

### Step 3: Write `test/config.test.mjs`

Test `loadConfig` precedence via a subprocess or dynamic import per case. Because `CONFIG_PATH` is frozen at import time, the cleanest pattern is one subprocess per case:

```js
execFileSync(process.execPath, ["-e", "import('./lib/config.mjs').then(m => console.log(JSON.stringify(m.loadConfig())))"], { env: { ...process.env, OUTRIDR_CONFIG: cfgPath, OUTRIDR_PORT: "9999" }, cwd: repoRoot, encoding: "utf8" })
```

Cases:
1. No config file, no env → port 8674, host `"tailscale"`, token null, push defaults `{notifyOn:["blocked","done"], pollMs:5000, enabled:true}`.
2. Config file sets `port: 1234, host: "10.0.0.5", token: "s"` → those win over defaults.
3. Env `OUTRIDR_PORT=9999`, `OUTRIDR_HOST=1.2.3.4`, `OUTRIDR_TOKEN=t` over a config file that also sets them → env wins.
4. `exec` absent → `exec: null`; `exec: {command: "~/x"}` → command has `~/` expanded to an absolute path.
5. `repos.command` as a bare string → normalized to a one-element array.
6. Invalid JSON in config file → process exits 1 (assert on subprocess throwing, and stderr containing `invalid config`).
7. `expandHome` (plain import, no subprocess): `"~/x"` → `join(homedir(), "x")`; `"/abs"` unchanged; non-string passthrough.

**Verify**: `node --test test/config.test.mjs` → all pass.

### Step 4: Write `test/http.test.mjs`

Using `startTestServer` + `startFakeHerdr`:

1. **/health happy path**: fake herdr answers `{"id":"outridr","result":{"pong":true}}` → GET `/health` → 200, body `{ ok: true, herdr: { pong: true }, pushTokens: 0 }`.
2. **/health with herdr down** (no fake herdr listening): → 200, `herdr: null`. (Allow up to the 2 s probe timeout.)
3. **Auth**: server with `token: "secret"` → `/health` without token → 401; with `Authorization: Bearer secret` → 200; with `?token=secret` → 200; wrong token → 401.
4. **/push/register**: valid `{token: "ExponentPushToken[abc]", device: "phone"}` → 200 `{ok:true, registered:1}`; malformed JSON body → 400; `{token: "junk"}` → 400. Assert the token file was persisted under the temp `OUTRIDR_STATE_DIR` (`push-tokens.json` contains the token).
5. **/exec disabled** (exec: null) → POST `/exec` → 404. **/exec enabled**: config `exec: { command: process.execPath }` is unsafe-looking but fine — instead use a fixture script: write `<tmp>/echo-args.mjs` containing `console.log(JSON.stringify(process.argv.slice(2)))`, set `exec: { command: process.execPath }`? No — exec runs exactly one binary with client args, so set `exec: { command: process.execPath }` and POST `{args: ["<tmp>/echo-args.mjs", "a", "b"]}` → 200, `code: 0`, stdout parses to `["a","b"]`. Validation: `args: []` → 400; 11 args → 400; a 200-char arg → 400; non-array → 400.
6. **/repos**: fixture script printing `{"repos":[{"name":"x"}]}` → config `repos: { command: [process.execPath, "<tmp>/repos.mjs"] }` → 200 `{repos:[{name:"x"}]}`; script printing garbage → 200 `{repos: []}`.
7. **Unknown route** → 404.

Every test closes its server (`server.close()`) and fake herdr in `after`/`finally`; use `t.after`.

**Verify**: `node --test test/http.test.mjs` → all pass.

### Step 5: Write `test/session.test.mjs`

Fixtures via `writeSessionFixture` with a valid 36-char id like `"0a1b2c3d-0000-4000-8000-000000000001"` (literally: `0a1b2c3d-0000-4000-8000-000000000001` — must match `/^[0-9a-f-]{36}$/`).

1. **Unknown id** → 404 `{error: "session transcript not found"}`.
2. **Small file tail** (3 lines) → 200; `entries` is the 3 parsed objects; `start` 0; `offset === size`; `more === false`.
3. **Forward poll**: request with `offset=<previous offset>` after appending a 4th line → entries = just the 4th; `offset` advances to new size.
4. **Torn trailing line**: file whose last line has no trailing `\n` → that line is NOT in `entries` and `offset` stops at the end of the last complete line.
5. **Tail alignment**: file > 256 KiB (write ~300 lines of ~1 KiB JSON) with no params → `start > 0`, first entry is a complete parsed object (the partial first line was skipped), `offset === size`.
6. **History pagination**: `end=<start from case 5>` → returns the window ending there; last entry of this window is the line immediately preceding the first entry of the tail window (assert via a per-line `seq` field in fixtures).
7. **Oversized line skip** (regression for commit `a16bc22`): fixture = line A (small, seq 1), line B of ~600 KiB (bigger than `SESSION_CHUNK_BYTES` = 512 KiB, e.g. one JSON object with a long string), line C (small, seq 3). Request `offset=<end of line A>` → response has `entries: []` (or without seq 2), and `offset` lands at the start of line C (a follow-up request from the returned `offset` yields seq 3). Assert `offset` strictly advanced past B.
8. **offset beyond size** (`offset=999999999` on a small file) → 200, `entries: []`, `offset` clamped to ≤ size.

**Verify**: `node --test test/session.test.mjs` → all pass.

### Step 6: Write `test/websocket.test.mjs`

Using the raw WS client from helpers:

1. **Handshake**: connect to `/herdr`, assert `101`, and `Sec-WebSocket-Accept` equals base64(sha1(key + GUID)) for the key you sent.
2. **Auth on upgrade**: server with token → upgrade without token gets `401` and the socket closes; with `?token=` succeeds.
3. **Round trip**: fake herdr answers `{"id":"r1","result":{"agents":[]}}` for a request line `{"id":"r1","method":"agent.list","params":{}}` → send as one masked text frame → receive one text frame whose JSON has `id === "r1"` and `result.agents`.
4. **herdr unreachable**: no fake herdr → send a request line → receive `{"id":"r1","error":{"code":"outridr_error","message":"herdr socket unavailable"}}`.
5. **Ping/pong**: send a masked ping frame (opcode 0x9, small payload) → receive pong (0xA) with identical payload.
6. **Multiple lines in one frame**: two NDJSON request lines in a single text frame → two response frames (any order), correlated by id.
7. **Fragmented message**: send a request line split across a first frame (opcode 0x1, FIN=0) and a continuation (opcode 0x0, FIN=1) → still answered.
8. **Close**: send close frame (0x8) → server responds with close and the TCP socket ends.

**Verify**: `node --test test/websocket.test.mjs` → all pass.

### Step 7: CI workflow

Create `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    strategy:
      matrix:
        node: [20, 22]
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node }}" }
      - run: npm run check
      - run: npm test
```

**Verify**: `npm run check && npm test` locally → both exit 0.

## Test plan

This plan IS the test plan; the suite above is the deliverable. Target: every core endpoint (`/health`, `/session`, `/push/register`, `/exec`, `/repos`, WS `/herdr`, auth) has at least one happy-path and one failure-path test; session windowing has offset/end/torn-line/oversized-line coverage; config precedence is covered per field group.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `npm test` exits 0 with ≥ 25 passing tests across 4 test files
- [ ] No test writes outside temp dirs: `ls ~/.local/state/outridr/push-tokens.json` unchanged (or absent) after the run — compare mtime before/after
- [ ] `LICENSE` exists and contains "MIT"
- [ ] `.github/workflows/ci.yml` exists
- [ ] `git status` shows no modifications to `lib/` or `bin/`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `startServer` does not return the server object or `port: 0` does not work — the harness design assumes both (server.mjs line 72 `return server`).
- Tests cannot avoid touching the real `~/.local/state/outridr` even with `OUTRIDR_STATE_DIR` set before import — that means the import-time env read changed.
- Any test requires modifying `lib/*.mjs` to pass (other than marking it `t.skip` with a plan reference) — characterization must not change runtime behavior.
- The oversized-line test (Step 5.7) does not observe the skip behavior — the guard may have changed since `a16bc22`.
- You find yourself wanting to add a devDependency.

## Maintenance notes

- Plans 002–005 each add regression tests into these files; keep helpers generic.
- The push watcher is intentionally untested here (`push.enabled: false` everywhere) — plan 005 covers it and will need a fake Expo endpoint.
- If `lib/server.mjs` is ever split into modules (deferred finding), these integration tests should keep passing unchanged — that's the point of testing over HTTP/WS rather than internals.
- Flakiness watch: the `/health`-with-herdr-down test waits on a 2 s timeout; keep test timeouts ≥ 5 s in CI.
