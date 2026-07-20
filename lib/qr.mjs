/*
 * QR Code generator library
 *
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */

/**
 * outridr port notes (this block, and everything below it, is NOT upstream —
 * the MIT header above is kept verbatim as the license requires):
 *
 * Ported from the clean upstream TypeScript source
 * (typescript-javascript/qrcodegen.ts at
 * https://github.com/nayuki/QR-Code-generator), stripped of TypeScript types
 * for this repo's zero-dependency, stdlib-only JS ESM. Scope trimmed to what
 * a terminal QR renderer needs:
 *  - QrCode, QrSegment, Ecc, Mode are ported near-verbatim: the version
 *    search, bit packing, Reed-Solomon ECC over GF(256), function-pattern
 *    drawing, and the real 8-mask penalty-score evaluation are all present
 *    (not a simplified fixed-mask shortcut).
 *  - Segment encoding is BYTE MODE ONLY — the connection URI is ASCII, so the
 *    numeric/alphanumeric/kanji/ECI segment modes and mode-mixing
 *    (`makeSegments`/`makeNumeric`/`makeAlphanumeric`/`makeEci`) are not
 *    ported since nothing here ever produces them.
 *  - SVG/browser rendering (`toSvgString`, `window.btoa`) is dropped;
 *    `encodeToMatrix`/`renderMatrix` at the bottom of this file are outridr
 *    additions that render to a terminal instead.
 *  - UTF-8 byte conversion uses the standard `TextEncoder` instead of
 *    upstream's `encodeURI`-based helper — same output, simpler stdlib call.
 *
 * This is project-owned code under test from here on — bugs are outridr's to
 * fix like any other module, not a reason to reach for a dependency.
 */

// Appends the given number of low-order bits of the given value to the given
// buffer. Requires 0 <= len <= 31 and 0 <= val < 2^len.
function appendBits(val, len, bb) {
  if (len < 0 || len > 31 || val >>> len !== 0) {
    throw new RangeError("Value out of range");
  }
  for (let i = len - 1; i >= 0; i--) {
    bb.push((val >>> i) & 1);
  }
}

// Returns true iff the i'th bit of x is set to 1.
function getBit(x, i) {
  return ((x >>> i) & 1) !== 0;
}

function assert(cond) {
  if (!cond) {
    throw new Error("Assertion error");
  }
}

function toUtf8ByteArray(text) {
  return Array.from(new TextEncoder().encode(text));
}

/*---- Public helper enumeration: error correction level ----*/

/**
 * The error correction level in a QR Code symbol. Immutable.
 */
export class Ecc {
  constructor(ordinal, formatBits) {
    this.ordinal = ordinal;
    this.formatBits = formatBits;
  }
}
Ecc.LOW = new Ecc(0, 1); // The QR Code can tolerate about  7% erroneous codewords
Ecc.MEDIUM = new Ecc(1, 0); // The QR Code can tolerate about 15% erroneous codewords
Ecc.QUARTILE = new Ecc(2, 3); // The QR Code can tolerate about 25% erroneous codewords
Ecc.HIGH = new Ecc(3, 2); // The QR Code can tolerate about 30% erroneous codewords

/*---- Public helper enumeration: segment mode ----*/

/**
 * Describes how a segment's data bits are interpreted. Immutable.
 * Only BYTE mode is ported (see the module-level port notes above).
 */
export class Mode {
  constructor(modeBits, numBitsCharCount) {
    this.modeBits = modeBits;
    this.numBitsCharCount = numBitsCharCount;
  }

  // Returns the bit width of the character count field for a segment in this
  // mode in a QR Code at the given version number. The result is in [0, 16].
  numCharCountBits(ver) {
    return this.numBitsCharCount[Math.floor((ver + 7) / 17)];
  }
}
Mode.BYTE = new Mode(0x4, [8, 16, 16]);

/*---- Data segment class ----*/

/**
 * A segment of byte-mode data in a QR Code symbol. Instances are immutable.
 */
export class QrSegment {
  // Returns a segment representing the given binary data encoded in byte
  // mode. All input byte arrays are acceptable.
  static makeBytes(data) {
    const bb = [];
    for (const b of data) {
      appendBits(b, 8, bb);
    }
    return new QrSegment(Mode.BYTE, data.length, bb);
  }

  // (Package-private) Calculates and returns the number of bits needed to
  // encode the given segments at the given version. The result is Infinity
  // if a segment has too many characters to fit its length field.
  static getTotalBits(segs, version) {
    let result = 0;
    for (const seg of segs) {
      const ccbits = seg.mode.numCharCountBits(version);
      if (seg.numChars >= 1 << ccbits) {
        return Infinity;
      }
      result += 4 + ccbits + seg.bitData.length;
    }
    return result;
  }

  constructor(mode, numChars, bitData) {
    if (numChars < 0) {
      throw new RangeError("Invalid argument");
    }
    this.mode = mode;
    this.numChars = numChars;
    this.bitData = bitData.slice(); // Defensive copy
  }

  // Returns a new copy of the data bits of this segment.
  getData() {
    return this.bitData.slice();
  }
}

/*---- QR Code symbol class ----*/

/**
 * A QR Code symbol, which is a type of two-dimension barcode.
 * Invented by Denso Wave and described in the ISO/IEC 18004 standard.
 * Instances represent an immutable square grid of dark and light cells.
 * Covers QR Code Model 2, all versions (sizes) 1 to 40 and all 4 ECC levels.
 */
export class QrCode {
  /*-- Static factory functions (high level) --*/

  // Returns a QR Code representing the given Unicode text string (encoded as
  // a single byte-mode segment — see the module-level port notes) at the
  // given error correction level.
  static encodeText(text, ecl) {
    const seg = QrSegment.makeBytes(toUtf8ByteArray(text));
    return QrCode.encodeSegments([seg], ecl);
  }

  /*-- Static factory functions (mid level) --*/

  // Returns a QR Code representing the given segments with the given
  // encoding parameters. The smallest possible QR Code version within the
  // given range is automatically chosen. Iff boostEcl is true, the ECC level
  // of the result may be higher than ecl if it can be done without
  // increasing the version. mask is -1 to automatically choose (evaluating
  // all 8 mask patterns' penalty scores), or 0-7 to force one.
  static encodeSegments(
    segs,
    ecl,
    minVersion = 1,
    maxVersion = 40,
    mask = -1,
    boostEcl = true,
  ) {
    if (
      !(QrCode.MIN_VERSION <= minVersion && minVersion <= maxVersion && maxVersion <= QrCode.MAX_VERSION) ||
      mask < -1 ||
      mask > 7
    ) {
      throw new RangeError("Invalid value");
    }

    // Find the minimal version number to use
    let version;
    let dataUsedBits;
    for (version = minVersion; ; version++) {
      const dataCapacityBits = QrCode.getNumDataCodewords(version, ecl) * 8;
      const usedBits = QrSegment.getTotalBits(segs, version);
      if (usedBits <= dataCapacityBits) {
        dataUsedBits = usedBits;
        break;
      }
      if (version >= maxVersion) {
        throw new RangeError("Data too long");
      }
    }

    // Increase the error correction level while the data still fits
    for (const newEcl of [Ecc.MEDIUM, Ecc.QUARTILE, Ecc.HIGH]) {
      if (boostEcl && dataUsedBits <= QrCode.getNumDataCodewords(version, newEcl) * 8) {
        ecl = newEcl;
      }
    }

    // Concatenate all segments to create the data bit string
    const bb = [];
    for (const seg of segs) {
      appendBits(seg.mode.modeBits, 4, bb);
      appendBits(seg.numChars, seg.mode.numCharCountBits(version), bb);
      for (const b of seg.getData()) {
        bb.push(b);
      }
    }
    assert(bb.length === dataUsedBits);

    // Add terminator and pad up to a byte if applicable
    const dataCapacityBits = QrCode.getNumDataCodewords(version, ecl) * 8;
    assert(bb.length <= dataCapacityBits);
    appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
    appendBits(0, (8 - (bb.length % 8)) % 8, bb);
    assert(bb.length % 8 === 0);

    // Pad with alternating bytes until data capacity is reached
    for (let padByte = 0xec; bb.length < dataCapacityBits; padByte ^= 0xec ^ 0x11) {
      appendBits(padByte, 8, bb);
    }

    // Pack bits into bytes in big endian
    const dataCodewords = [];
    while (dataCodewords.length * 8 < bb.length) {
      dataCodewords.push(0);
    }
    bb.forEach((b, i) => {
      dataCodewords[i >>> 3] |= b << (7 - (i & 7));
    });

    return new QrCode(version, ecl, dataCodewords, mask);
  }

  /*-- Constructor (low level) and fields --*/

  // Creates a new QR Code with the given version number, error correction
  // level, data codeword bytes, and mask number (-1 for automatic).
  constructor(version, errorCorrectionLevel, dataCodewords, msk) {
    if (version < QrCode.MIN_VERSION || version > QrCode.MAX_VERSION) {
      throw new RangeError("Version value out of range");
    }
    if (msk < -1 || msk > 7) {
      throw new RangeError("Mask value out of range");
    }
    this.version = version;
    this.errorCorrectionLevel = errorCorrectionLevel;
    this.size = version * 4 + 17;

    // Initialize both grids to be size*size arrays of Boolean false
    this.modules = [];
    this.isFunction = [];
    const row = new Array(this.size).fill(false);
    for (let i = 0; i < this.size; i++) {
      this.modules.push(row.slice()); // Initially all light
      this.isFunction.push(row.slice());
    }

    // Compute ECC, draw modules
    this.drawFunctionPatterns();
    const allCodewords = this.addEccAndInterleave(dataCodewords);
    this.drawCodewords(allCodewords);

    // Do masking
    if (msk === -1) {
      // Automatically choose best mask
      let minPenalty = Infinity;
      for (let i = 0; i < 8; i++) {
        this.applyMask(i);
        this.drawFormatBits(i);
        const penalty = this.getPenaltyScore();
        if (penalty < minPenalty) {
          msk = i;
          minPenalty = penalty;
        }
        this.applyMask(i); // Undoes the mask due to XOR
      }
    }
    assert(0 <= msk && msk <= 7);
    this.mask = msk;
    this.applyMask(msk); // Apply the final choice of mask
    this.drawFormatBits(msk); // Overwrite old format bits

    this.isFunction = [];
  }

  /*-- Accessor methods --*/

  // Returns the color of the module (pixel) at the given coordinates, which
  // is false for light or true for dark. (0,0) is the top left corner.
  // Out-of-bounds coordinates return false (light).
  getModule(x, y) {
    return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
  }

  /*-- Private helper methods for constructor: Drawing function modules --*/

  drawFunctionPatterns() {
    // Draw horizontal and vertical timing patterns
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }

    // Draw 3 finder patterns (all corners except bottom right)
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);

    // Draw numerous alignment patterns
    const alignPatPos = this.getAlignmentPatternPositions();
    const numAlign = alignPatPos.length;
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        // Don't draw on the three finder corners
        if (!((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0))) {
          this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
        }
      }
    }

    // Draw configuration data
    this.drawFormatBits(0); // Dummy mask value; overwritten later
    this.drawVersion();
  }

  // Draws two copies of the format bits (with its own error correction code)
  // based on the given mask and this object's error correction level.
  drawFormatBits(mask) {
    const data = (this.errorCorrectionLevel.formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const bits = ((data << 10) | rem) ^ 0x5412; // uint15
    assert(bits >>> 15 === 0);

    // Draw first copy
    for (let i = 0; i <= 5; i++) {
      this.setFunctionModule(8, i, getBit(bits, i));
    }
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) {
      this.setFunctionModule(14 - i, 8, getBit(bits, i));
    }

    // Draw second copy
    for (let i = 0; i < 8; i++) {
      this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
    }
    for (let i = 8; i < 15; i++) {
      this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
    }
    this.setFunctionModule(8, this.size - 8, true); // Always dark
  }

  // Draws two copies of the version bits, iff 7 <= version <= 40.
  drawVersion() {
    if (this.version < 7) {
      return;
    }

    let rem = this.version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const bits = (this.version << 12) | rem; // uint18
    assert(bits >>> 18 === 0);

    for (let i = 0; i < 18; i++) {
      const color = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, color);
      this.setFunctionModule(b, a, color);
    }
  }

  // Draws a 9*9 finder pattern including the border separator, with the
  // center module at (x, y). Modules can be out of bounds.
  drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy)); // Chebyshev norm
        const xx = x + dx;
        const yy = y + dy;
        if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size) {
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  // Draws a 5*5 alignment pattern, with the center module at (x, y). All
  // modules must be in bounds.
  drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  // Sets the color of a module and marks it as a function module. Only used
  // by the constructor. Coordinates must be in bounds.
  setFunctionModule(x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }

  /*-- Private helper methods for constructor: Codewords and masking --*/

  // Returns a new byte string representing the given data with the
  // appropriate error correction codewords appended, based on this object's
  // version and error correction level.
  addEccAndInterleave(data) {
    const ver = this.version;
    const ecl = this.errorCorrectionLevel;
    if (data.length !== QrCode.getNumDataCodewords(ver, ecl)) {
      throw new RangeError("Invalid argument");
    }

    const numBlocks = QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
    const blockEccLen = QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
    const rawCodewords = Math.floor(QrCode.getNumRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    // Split data into blocks and append ECC to each block
    const blocks = [];
    const rsDiv = QrCode.reedSolomonComputeDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc = QrCode.reedSolomonComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) {
        dat.push(0);
      }
      blocks.push(dat.concat(ecc));
    }

    // Interleave (not concatenate) the bytes from every block
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        // Skip the padding byte in short blocks
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
          result.push(block[i]);
        }
      });
    }
    assert(result.length === rawCodewords);
    return result;
  }

  // Draws the given sequence of 8-bit codewords (data and ECC) onto the
  // entire data area of this QR Code. Function modules must be marked first.
  drawCodewords(data) {
    if (data.length !== Math.floor(QrCode.getNumRawDataModules(this.version) / 8)) {
      throw new RangeError("Invalid argument");
    }
    let i = 0; // Bit index into the data
    // Do the funny zigzag scan
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right = 5;
      }
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
          // Remainder bits (0 to 7), if any, stay 0/false/light as initialized
        }
      }
    }
    assert(i === data.length * 8);
  }

  // XORs the codeword modules in this QR Code with the given mask pattern.
  // Function modules must be marked and codeword bits drawn before masking.
  // Calling with the same mask value twice undoes it.
  applyMask(mask) {
    if (mask < 0 || mask > 7) {
      throw new RangeError("Mask value out of range");
    }
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = (x * y) % 2 + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = ((x * y) % 2 + ((x * y) % 3)) % 2 === 0;
            break;
          case 7:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            throw new Error("Unreachable");
        }
        if (!this.isFunction[y][x] && invert) {
          this.modules[y][x] = !this.modules[y][x];
        }
      }
    }
  }

  // Calculates and returns the penalty score based on the current state of
  // this QR Code's modules. Used by the automatic mask-choice algorithm.
  getPenaltyScore() {
    let result = 0;

    // Adjacent modules in row having same color, and finder-like patterns
    for (let y = 0; y < this.size; y++) {
      let runColor = false;
      let runX = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < this.size; x++) {
        if (this.modules[y][x] === runColor) {
          runX++;
          if (runX === 5) {
            result += QrCode.PENALTY_N1;
          } else if (runX > 5) {
            result++;
          }
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) {
            result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
          }
          runColor = this.modules[y][x];
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * QrCode.PENALTY_N3;
    }
    // Adjacent modules in column having same color, and finder-like patterns
    for (let x = 0; x < this.size; x++) {
      let runColor = false;
      let runY = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < this.size; y++) {
        if (this.modules[y][x] === runColor) {
          runY++;
          if (runY === 5) {
            result += QrCode.PENALTY_N1;
          } else if (runY > 5) {
            result++;
          }
        } else {
          this.finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) {
            result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
          }
          runColor = this.modules[y][x];
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * QrCode.PENALTY_N3;
    }

    // 2*2 blocks of modules having same color
    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const color = this.modules[y][x];
        if (color === this.modules[y][x + 1] && color === this.modules[y + 1][x] && color === this.modules[y + 1][x + 1]) {
          result += QrCode.PENALTY_N2;
        }
      }
    }

    // Balance of dark and light modules
    let dark = 0;
    for (const row of this.modules) {
      dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
    }
    const total = this.size * this.size; // size is odd, so dark/total != 1/2
    // Smallest integer k >= 0 such that (45-5k)% <= dark/total <= (55+5k)%
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    assert(0 <= k && k <= 9);
    result += k * QrCode.PENALTY_N4;
    assert(0 <= result && result <= 2568888);
    return result;
  }

  /*-- Private helper functions --*/

  // Returns an ascending list of positions of alignment patterns for this
  // version number. Each position is in [0,177), used on both x and y axes.
  getAlignmentPatternPositions() {
    if (this.version === 1) {
      return [];
    }
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }

  // Returns the number of data bits that can be stored in a QR Code of the
  // given version number, after all function modules are excluded (includes
  // remainder bits, so may not be a multiple of 8). Range [208, 29648].
  static getNumRawDataModules(ver) {
    if (ver < QrCode.MIN_VERSION || ver > QrCode.MAX_VERSION) {
      throw new RangeError("Version number out of range");
    }
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) {
        result -= 36;
      }
    }
    assert(208 <= result && result <= 29648);
    return result;
  }

  // Returns the number of 8-bit data (not ECC) codewords contained in any QR
  // Code of the given version number and ECC level, remainder bits discarded.
  static getNumDataCodewords(ver, ecl) {
    return (
      Math.floor(QrCode.getNumRawDataModules(ver) / 8) -
      QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver]
    );
  }

  // Returns a Reed-Solomon ECC generator polynomial for the given degree.
  static reedSolomonComputeDivisor(degree) {
    if (degree < 1 || degree > 255) {
      throw new RangeError("Degree out of range");
    }
    // Coefficients stored highest to lowest power, excluding the leading
    // term (always 1). e.g. x^3 + 255x^2 + 8x + 93 is stored as [255, 8, 93].
    const result = [];
    for (let i = 0; i < degree - 1; i++) {
      result.push(0);
    }
    result.push(1); // Start off with the monomial x^0

    // Compute (x - r^0) * (x - r^1) * ... * (x - r^{degree-1}), dropping the
    // highest monomial term which is always 1x^degree. r = 0x02, a generator
    // element of GF(2^8/0x11D).
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = QrCode.reedSolomonMultiply(result[j], root);
        if (j + 1 < result.length) {
          result[j] ^= result[j + 1];
        }
      }
      root = QrCode.reedSolomonMultiply(root, 0x02);
    }
    return result;
  }

  // Returns the Reed-Solomon error correction codeword for the given data
  // and divisor polynomials.
  static reedSolomonComputeRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => {
        result[i] ^= QrCode.reedSolomonMultiply(coef, factor);
      });
    }
    return result;
  }

  // Returns the product of the two given field elements modulo GF(2^8/0x11D).
  static reedSolomonMultiply(x, y) {
    if (x >>> 8 !== 0 || y >>> 8 !== 0) {
      throw new RangeError("Byte out of range");
    }
    // Russian peasant multiplication
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    assert(z >>> 8 === 0);
    return z;
  }

  // Can only be called immediately after a light run is added. Returns 0, 1,
  // or 2. A helper for getPenaltyScore().
  finderPenaltyCountPatterns(runHistory) {
    const n = runHistory[1];
    assert(n <= this.size * 3);
    const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
    return (
      (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
      (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
    );
  }

  // Must be called at the end of a line (row or column). A helper for
  // getPenaltyScore().
  finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
    if (currentRunColor) {
      // Terminate dark run
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += this.size; // Add light border to final run
    this.finderPenaltyAddHistory(currentRunLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  }

  // Pushes the given value to the front and drops the last value. A helper
  // for getPenaltyScore().
  finderPenaltyAddHistory(currentRunLength, runHistory) {
    if (runHistory[0] === 0) {
      currentRunLength += this.size; // Add light border to initial run
    }
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }
}

/*-- Constants and tables --*/

QrCode.MIN_VERSION = 1;
QrCode.MAX_VERSION = 40;

QrCode.PENALTY_N1 = 3;
QrCode.PENALTY_N2 = 3;
QrCode.PENALTY_N3 = 40;
QrCode.PENALTY_N4 = 10;

QrCode.ECC_CODEWORDS_PER_BLOCK = [
  // Version: (index 0 is padding, set to an illegal value)
  //0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Low
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // Medium
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Quartile
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // High
];

QrCode.NUM_ERROR_CORRECTION_BLOCKS = [
  // Version: (index 0 is padding, set to an illegal value)
  //0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40    Error correction level
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // Low
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // Medium
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Quartile
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // High
];

/*---- outridr additions: terminal rendering (not upstream) ----*/

const QUIET_ZONE_MODULES = 4;

/**
 * Encodes `text` as a QR Code at error-correction level MEDIUM and returns
 * its modules as a square `boolean[][]` (row-major, `matrix[y][x]`, true =
 * dark). No quiet zone is included — that's `renderMatrix`'s job.
 */
export function encodeToMatrix(text) {
  const qr = QrCode.encodeText(text, Ecc.MEDIUM);
  const matrix = [];
  for (let y = 0; y < qr.size; y++) {
    const row = [];
    for (let x = 0; x < qr.size; x++) {
      row.push(qr.getModule(x, y));
    }
    matrix.push(row);
  }
  return matrix;
}

/**
 * Renders a module matrix (as returned by `encodeToMatrix`) to a
 * newline-terminated string using Unicode half-blocks (`█`, `▀`, `▄`, space),
 * so two module rows map to one terminal text line — this keeps the QR
 * roughly square on typical terminal fonts (character cells are usually
 * taller than wide) and scannable off a screen. Adds a 4-module quiet zone
 * (blank border) on every side, as the QR spec requires for reliable
 * scanning.
 */
export function renderMatrix(matrix) {
  const size = matrix.length;
  const bordered = size + QUIET_ZONE_MODULES * 2;

  const isDark = (x, y) => {
    const mx = x - QUIET_ZONE_MODULES;
    const my = y - QUIET_ZONE_MODULES;
    if (mx < 0 || mx >= size || my < 0 || my >= size) {
      return false; // Quiet zone is always light
    }
    return matrix[my][mx];
  };

  let out = "";
  for (let y = 0; y < bordered; y += 2) {
    let line = "";
    for (let x = 0; x < bordered; x++) {
      const top = isDark(x, y);
      const bottom = y + 1 < bordered ? isDark(x, y + 1) : false;
      if (top && bottom) {
        line += "█";
      } else if (top && !bottom) {
        line += "▀";
      } else if (!top && bottom) {
        line += "▄";
      } else {
        line += " ";
      }
    }
    out += `${line}\n`;
  }
  return out;
}
