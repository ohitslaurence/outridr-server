# Plan 021: `outridr pair` — generate a token and show a QR code for the app

> **Executor instructions**: Follow step by step. Run every verification
> command and confirm the expected result before moving on. STOP conditions
> halt you. Update this plan's row in `plans/README.md` when done unless a
> reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 3488f44..HEAD -- bin/outridr.mjs lib/config.mjs README.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (new command; touches no request path)
- **Depends on**: none (but reads token/host config shaped by 015/018)
- **Category**: dx / feature
- **Planned at**: commit `3488f44` (v0.4.1), 2026-07-20 (operator idea:
  replace manual token copy-paste with a scannable QR)

## Why this matters

Connecting the app currently means the user hand-copies a token, host, and
port into the app's fields — the exact step three separate cold-context audits
flagged as undocumented and error-prone. A single `outridr pair` command that
(1) ensures a strong token exists, (2) encodes host + port + token into a
connection URI, and (3) renders that URI as a QR code in the terminal turns
setup into "run one command, scan with the app." It also fixes the "no token
generation guidance" gap: pairing generates a cryptographically strong token
automatically.

## Design decision: vendor the Nayuki QR encoder (READ BEFORE STARTING)

This repo's defining property is **zero runtime dependencies** — it hand-rolls
its own RFC 6455 WebSocket rather than depend on `ws` (see `lib/websocket.mjs`).
A QR encoder must therefore be **vendored as the project's own stdlib-only
module**, NOT added via `npm install qrcode`. Adding any dependency is a STOP
condition.

Do NOT write a QR encoder from scratch. **Port the Project Nayuki QR Code
generator** (MIT, https://www.nayuki.io/page/qr-code-generator-library) — the
same library the outridr mobile app already uses, so both sides produce
compatible codes. Port from the **clean upstream source**, not any variant you
may find in a sibling repo (a copy exists in the app with a `bit`→`number`
identifier rename that makes it unreadable — do not reproduce that).

Porting scope, precisely:
- Take ONLY the pure classes: `QrCode`, `QrSegment`, and the `Ecc`/`Mode`
  helpers. These are pure computation with no DOM/browser calls.
- DROP the SVG/browser rendering (`toSvgString`, `window.btoa`, any UI-token
  imports) — the server renders to a terminal, not SVG.
- Strip TypeScript types to plain `.mjs` (this repo is JS ESM, stdlib only).
- **Keep the Nayuki MIT copyright header verbatim** at the top of `lib/qr.mjs`.
  The license requires the notice to travel with the code; in a zero-dep repo
  this is also a positive provenance signal. Note in the README/SECURITY that
  `lib/qr.mjs` is a vendored MIT library, the one piece of non-original code.
- The only surface the renderer consumes is `QrCode.encodeText(text, Ecc.MEDIUM)`
  → an object with `.size` and `.getModule(x, y)`.

The connection URI is emitted as **text as well**, always, so the command is
useful even where a QR can't render (piped output, screen readers): the QR is
an affordance, not the only channel.

## Current state (verified at 3488f44)

- `bin/outridr.mjs` — command dispatch (`switch (command)`), commands:
  serve/install/uninstall/status/config/help. No `pair`, no token generation.
- `lib/config.mjs` — `loadConfig()` returns `{ port, host, token, ... }`;
  `token` is `null` when unset; `CONFIG_PATH` exported. `host` may be the
  literal `"tailscale"` (needs resolving to an address for a URI).
- `lib/config-write.mjs` — `saveRepoRoots` shows the atomic write-then-rename
  pattern and preserves other keys; a token writer should mirror it.
- `lib/server.mjs` `resolveHost` — the logic to turn `"tailscale"` into an
  IPv4; `pair` needs the same resolution (extract/share, don't duplicate the
  tailscale shell-out — see step 2).
- No existing QR or pairing code anywhere.

Conventions: named exports, zero deps, `outridr:`-prefixed messages,
`node:test`. Baseline 83 tests (more if 015/018/020 landed).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Syntax | `npm run check` (add new files to it) | exit 0 |
| Tests | `npm test` | all pass |
| Manual smoke | `OUTRIDR_HOST=127.0.0.1 OUTRIDR_TOKEN=test node bin/outridr.mjs pair` | prints a URI + a QR block |

## Scope

**In scope**: `bin/outridr.mjs` (new `pair` case + help text),
`lib/pair.mjs` (create — orchestration: ensure token, resolve host, build
URI, print), `lib/qr.mjs` (create — vendored zero-dep QR encoder +
terminal renderer), `lib/config-write.mjs` (add a `saveToken` writer, or a
new tiny module — mirror the atomic-write pattern), `package.json` (`check`
script: add the two new files), `README.md` (document `outridr pair`),
`test/qr.test.mjs` and `test/pair.test.mjs` (create).

**Out of scope**: any HTTP/WS request path; the app side (this only emits a
URI the app agrees to parse); changing how `token` is read at startup.

## Git workflow

- Branch: `advisor/021-pair-command-qr`
- Commit the QR encoder separately from the command wiring if convenient.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Vendored QR encoder (`lib/qr.mjs`)

Implement a byte-mode QR encoder, stdlib only. Minimum viable scope:

- Byte (8-bit) mode only; the payload is an ASCII URI.
- Error-correction level M.
- Auto-pick the smallest QR version (1–10 is plenty; a connection URI is
  short) that fits the data at level M.
- Export `encodeToMatrix(text) → boolean[][]` (the modules) and
  `renderMatrix(matrix) → string` that draws it with Unicode half-blocks
  (`█`, `▀`, `▄`, space) so two rows map to one text line and it scans off a
  terminal. Add a quiet-zone border (4 modules).

This is real work: numeric-to-bits, Reed–Solomon ECC over GF(256), the
version/format bit tables, mask pattern selection. Implement it carefully and
lean on the test in step 5 (decode-independent structural checks + known
vectors) to prove correctness. If a full mask-evaluation is too much, applying
a single fixed mask (pattern 0) with the correct format bits still produces a
scannable code — acceptable for v1; note the simplification in a comment.

**Verify**: `node -e "import('./lib/qr.mjs').then(m => console.log(m.renderMatrix(m.encodeToMatrix('https://example.com')).length))"`
prints a positive number (renders without throwing).

### Step 2: Share host resolution

`pair` needs `"tailscale"` → IPv4. Do NOT duplicate the tailscale shell-out.
Export the existing resolver from `lib/server.mjs` (rename the internal
`resolveHost` to an exported `resolveHost` if it isn't already, or lift it
into a small shared module both import). If plan 020 landed, reuse its
`tailscaleBin()` fallback so pairing works on macOS too. Keep the change
minimal and behavior-identical for the server.

**Verify**: `npm test` → the existing host tests still pass (proves the
extraction didn't change server behavior).

### Step 3: Token generation + persistence

Add a `saveToken(config)` (in `lib/config-write.mjs` or a sibling) that, when
`config.token` is null, generates `randomBytes(32).toString("hex")` (via
`node:crypto`), writes it into the config file atomically (write-then-rename,
mode 0o600, preserving all other keys — mirror `saveRepoRoots`), mutates
`config.token` in place, and returns the token. If a token already exists,
return it unchanged (pairing is idempotent).

**Verify**: `npm run check` → exit 0.

### Step 4: The `pair` command (`lib/pair.mjs` + `bin/outridr.mjs`)

`lib/pair.mjs` exports `runPair()` that:
1. loads config, resolves host to a concrete address, ensures a token
   (step 3),
2. builds a connection URI. Use a clear custom scheme the app registers, e.g.
   `outridr://<host>:<port>?token=<token>` (state the exact shape in the
   README so the app team implements the matching parser),
3. prints: a one-line human summary (host, port, "token: set"), the QR block,
   and the raw URI on its own line (so it's copyable and pipe-safe). Do NOT
   print the token by itself in the clear beyond its presence in the URI, and
   add a one-line caution that the QR/URI grants access — treat it like a
   password.

Wire `case "pair":` into `bin/outridr.mjs` and add it to `HELP`.

**Verify**: `OUTRIDR_HOST=127.0.0.1 OUTRIDR_PORT=8674 OUTRIDR_TOKEN=abc node bin/outridr.mjs pair`
prints a URI containing `outridr://127.0.0.1:8674?token=abc` and a QR block
above it.

### Step 5: Tests

- `test/qr.test.mjs`: `encodeToMatrix` returns a square matrix whose side is
  `21 + 4*(version-1)` for a known short input; the three finder patterns
  (7×7 with the known ring structure) are present at the three corners;
  `renderMatrix` returns a non-empty string and never throws on inputs from 1
  char to a few hundred. If you can find published QR test vectors for a fixed
  input+version+mask, assert the module matrix matches — strongest check.
- `test/pair.test.mjs`: run `pair` in a subprocess (like
  `test/config.test.mjs` runs `loadConfig`) with `OUTRIDR_CONFIG` pointing at
  a temp file and `OUTRIDR_HOST`/`OUTRIDR_TOKEN` set; assert stdout contains
  the expected `outridr://...` URI. Second case: no token in config →
  `pair` generates one, the temp config file now contains a 64-hex-char
  token, and a second `pair` run emits the SAME token (idempotent).

**Verify**: `npm test` → all pass, new tests included.

### Step 6: Wire check script + README

- `package.json` `check`: add `&& node --check lib/pair.mjs && node --check lib/qr.mjs`.
- README: document `outridr pair` in the service-management command list and
  add a short "Connecting the app" section: run `outridr pair`, scan the QR,
  done — plus the URI scheme for reference and the security caution.

**Verify**: `npm run check` includes the new files;
`grep -c "outridr pair" README.md` → ≥1.

## Done criteria

- [ ] `node bin/outridr.mjs pair` (with host/token in env) prints a URI + QR
- [ ] `npm run check` covers `lib/pair.mjs` and `lib/qr.mjs`; exits 0
- [ ] `npm test` exits 0 with `test/qr.test.mjs` + `test/pair.test.mjs` green
- [ ] No new entry in `package.json` `dependencies` (`git diff` shows deps
      unchanged) — vendored, not installed
- [ ] pairing is idempotent (second run = same token) and generates a
      64-hex-char token when none exists
- [ ] `git status` clean outside scope; `plans/README.md` row updated

## STOP conditions

- You are tempted to `npm install` a QR or CLI library — STOP; the vendored
  encoder is the whole point. Report if it's genuinely infeasible in budget.
- Extracting `resolveHost` changes server behavior (any host test fails) —
  STOP; the extraction must be behavior-preserving.
- The QR won't scan from a terminal in your own manual test — report the
  rendering approach you used; half-block rendering + a 4-module quiet zone is
  the known-good recipe, but font/terminal aspect ratio can defeat it.

## Maintenance notes

- The `outridr://` scheme is a contract with the app: whatever you finalize
  here, the app's deep-link/QR parser must match. Document it in the README so
  both sides stay in sync; a change here is a coordinated change with the app.
- Rotating a token: `outridr pair` is idempotent by design (won't clobber an
  existing token). A future `outridr pair --rotate` could regenerate; left out
  of v1 deliberately.
- The vendored QR encoder is now project-owned code under test — treat bugs in
  it like any other module; do not "fix" it by adding a dependency.
- If the app supports Tailscale MagicDNS, the URI could carry the `*.ts.net`
  hostname instead of a raw IP (more stable across IP changes) — a nice future
  refinement once the app confirms it resolves MagicDNS.
