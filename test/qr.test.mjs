import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeToMatrix, renderMatrix } from "../lib/qr.mjs";

// The exact 7x7 finder pattern every QR Code has at three corners: a solid
// dark border, one light ring in, then a solid 3x3 dark core.
const FINDER_PATTERN = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
];

function assertFinderPatternAt(matrix, top, left) {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const expected = FINDER_PATTERN[dy][dx] === 1;
      assert.equal(
        matrix[top + dy][left + dx],
        expected,
        `finder pattern mismatch at (${left + dx},${top + dy}) — expected ${expected}`,
      );
    }
  }
}

test("encodeToMatrix: short input -> version 1 (21x21) at ECC MEDIUM", () => {
  const matrix = encodeToMatrix("a");
  assert.equal(matrix.length, 21);
  for (const row of matrix) {
    assert.equal(row.length, 21);
  }
});

test("encodeToMatrix: matrix side follows 21 + 4*(version-1) for larger inputs", () => {
  // A payload long enough to need more than a single QR version; whatever
  // version is chosen, size must satisfy the QR spec's formula exactly.
  const matrix = encodeToMatrix("x".repeat(200));
  const size = matrix.length;
  assert.equal(matrix.every((row) => row.length === size), true);
  assert.equal((size - 17) % 4, 0, "size must be 21 + 4*(version-1) for some integer version");
  const version = (size - 17) / 4;
  assert.ok(version >= 1 && version <= 40);
});

test("encodeToMatrix: three finder patterns (7x7 dark-ring) present at the three corners", () => {
  const matrix = encodeToMatrix("outridr://127.0.0.1:8674?token=abc");
  const size = matrix.length;
  assertFinderPatternAt(matrix, 0, 0); // top-left
  assertFinderPatternAt(matrix, 0, size - 7); // top-right
  assertFinderPatternAt(matrix, size - 7, 0); // bottom-left
});

test("encodeToMatrix: no finder pattern drawn at the bottom-right corner (by design)", () => {
  const matrix = encodeToMatrix("outridr://127.0.0.1:8674?token=abc");
  const size = matrix.length;
  let matchesFinder = true;
  for (let dy = 0; dy < 7 && matchesFinder; dy++) {
    for (let dx = 0; dx < 7 && matchesFinder; dx++) {
      const expected = FINDER_PATTERN[dy][dx] === 1;
      if (matrix[size - 7 + dy][size - 7 + dx] !== expected) {
        matchesFinder = false;
      }
    }
  }
  assert.equal(matchesFinder, false);
});

test("renderMatrix: returns a non-empty string and never throws across a range of input sizes", () => {
  const lengths = [1, 2, 5, 10, 25, 50, 100, 250, 500];
  for (const len of lengths) {
    const matrix = encodeToMatrix("x".repeat(len));
    const rendered = renderMatrix(matrix);
    assert.equal(typeof rendered, "string");
    assert.ok(rendered.length > 0, `renderMatrix produced an empty string for length ${len}`);
    assert.ok(rendered.includes("\n"), `renderMatrix output should be multi-line for length ${len}`);
  }
});

test("renderMatrix: adds a 4-module quiet zone (blank border) on every side", () => {
  const matrix = encodeToMatrix("hi");
  const rendered = renderMatrix(matrix);
  const lines = rendered.split("\n").filter((line) => line.length > 0);
  // First two module rows are the quiet zone; rendered two-per-line, so the
  // first line is entirely blank space (no half-block glyphs).
  assert.equal(/^ +$/.test(lines[0]), true, "first rendered line should be entirely blank (quiet zone)");
  const lastLine = lines[lines.length - 1];
  assert.equal(/^ +$/.test(lastLine), true, "last rendered line should be entirely blank (quiet zone)");
  // Every line should be padded on the left/right by at least 4 blank columns.
  for (const line of lines) {
    assert.equal(line.slice(0, 4), "    ", "left quiet zone should be blank");
    assert.equal(line.slice(-4), "    ", "right quiet zone should be blank");
  }
});

test("encodeToMatrix: throws RangeError when the text exceeds byte-mode capacity for version 40", () => {
  // Version 40 at ECC MEDIUM holds a bounded number of byte-mode codewords;
  // well beyond that must raise rather than silently truncate.
  assert.throws(() => encodeToMatrix("x".repeat(5000)), RangeError);
});
