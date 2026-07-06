// Tiny, self-contained QR-code matrix encoder (byte mode, low ECC) plus an SVG
// renderer, for the Claudium native pay panel. This is NOT a dependency: it is a
// small standard implementation of the QR spec (ISO/IEC 18004) so a player can
// scan the pay address/amount with a wallet instead of hand-copying it. DOM-free
// and deterministic so tests/qr.test.ts can drive the matrix directly.
//
// Scope: byte (8-bit) mode, error-correction level L, versions 1..10 (up to 174
// data codewords), auto-selecting the smallest version that fits. That range
// covers a Solana-pay style URI comfortably; anything longer returns null and the
// consumer falls back to the copyable monospace address (which it already shows).
// No kanji/numeric/alphanumeric optimization, no structured append: one segment,
// one clean matrix, which is all the pay panel needs.

// ---- Galois field (GF(256)) tables for Reed-Solomon ECC ----------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** Reed-Solomon generator polynomial of the given degree. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let d = 0; d < degree; d++) {
    const next = new Uint8Array(poly.length + 1);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i];
      next[i + 1] ^= gfMul(poly[i], EXP[d]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon ECC codewords for a data block. */
function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const res = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[res.length - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < gen.length; i++) res[i] ^= gfMul(gen[i], factor);
    }
  }
  return res;
}

// ---- Version capacity (byte mode, ECC level L) -------------------------------
// Per-version: [ total data codewords, EC codewords per block, block count ].
// L level, single-block for these small versions except where noted (v1..10 L are
// all single-block in the spec). Total modules and alignment handled below.

interface VersionSpec {
  version: number;
  dataCodewords: number; // total data codewords across all blocks
  ecPerBlock: number;
  blocks: number;
}

// Byte-mode, level L, versions 1..10 (all single data block at L).
const VERSIONS: VersionSpec[] = [
  { version: 1, dataCodewords: 19, ecPerBlock: 7, blocks: 1 },
  { version: 2, dataCodewords: 34, ecPerBlock: 10, blocks: 1 },
  { version: 3, dataCodewords: 55, ecPerBlock: 15, blocks: 1 },
  { version: 4, dataCodewords: 80, ecPerBlock: 20, blocks: 1 },
  { version: 5, dataCodewords: 108, ecPerBlock: 26, blocks: 1 },
  { version: 6, dataCodewords: 136, ecPerBlock: 18, blocks: 2 },
  { version: 7, dataCodewords: 156, ecPerBlock: 20, blocks: 2 },
  { version: 8, dataCodewords: 194, ecPerBlock: 24, blocks: 2 },
  { version: 9, dataCodewords: 232, ecPerBlock: 30, blocks: 2 },
  { version: 10, dataCodewords: 274, ecPerBlock: 18, blocks: 4 },
];

// Alignment-pattern center coordinates per version (empty for v1).
const ALIGN_POS: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

function sizeForVersion(version: number): number {
  return 17 + version * 4;
}

// ---- Bit buffer --------------------------------------------------------------

class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function encodeBytes(text: string): Uint8Array {
  // UTF-8 encode; byte-mode payload.
  return new TextEncoder().encode(text);
}

/**
 * Build the full data+ECC codeword stream for the chosen version. Returns the
 * interleaved final codewords ready for placement.
 */
function buildCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const buf = new BitBuffer();
  buf.put(0b0100, 4); // byte mode indicator
  // Character-count indicator is 8 bits for versions 1..9, 16 for 10..26.
  const ccBits = spec.version <= 9 ? 8 : 16;
  buf.put(bytes.length, ccBits);
  for (const b of bytes) buf.put(b, 8);
  // Terminator + pad to byte boundary.
  const capacityBits = spec.dataCodewords * 8;
  const terminator = Math.min(4, capacityBits - buf.bits.length);
  buf.put(0, terminator);
  while (buf.bits.length % 8 !== 0) buf.bits.push(0);
  const dataBytes: number[] = [];
  for (let i = 0; i < buf.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | buf.bits[i + j];
    dataBytes.push(v);
  }
  // Pad bytes.
  const pad = [0xec, 0x11];
  let pi = 0;
  while (dataBytes.length < spec.dataCodewords) dataBytes.push(pad[pi++ % 2]);

  // Split into blocks, compute ECC per block, then interleave.
  const totalBlocks = spec.blocks;
  const baseCount = Math.floor(spec.dataCodewords / totalBlocks);
  const remainder = spec.dataCodewords % totalBlocks;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let b = 0; b < totalBlocks; b++) {
    const count = baseCount + (b >= totalBlocks - remainder ? 1 : 0);
    const block = dataBytes.slice(offset, offset + count);
    offset += count;
    dataBlocks.push(block);
    ecBlocks.push(Array.from(rsEncode(Uint8Array.from(block), spec.ecPerBlock)));
  }
  const result: number[] = [];
  const maxData = Math.max(...dataBlocks.map((d) => d.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return Uint8Array.from(result);
}

// ---- Matrix placement --------------------------------------------------------

type Grid = Int8Array[]; // -1 = unset, 0/1 = module; function patterns marked separately.

function makeGrid(size: number): { grid: Grid; reserved: boolean[][] } {
  const grid: Grid = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  return { grid, reserved };
}

function placeFinder(grid: Grid, reserved: boolean[][], row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= grid.length || cc >= grid.length) continue;
      const inRing =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      grid[rr][cc] = inRing ? 1 : 0;
      reserved[rr][cc] = true;
    }
  }
}

function placeAlignment(grid: Grid, reserved: boolean[][], centers: number[]): void {
  for (const r of centers) {
    for (const c of centers) {
      if (reserved[r][c]) continue; // skip finder overlaps
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          grid[r + dr][c + dc] = on ? 1 : 0;
          reserved[r + dr][c + dc] = true;
        }
      }
    }
  }
}

function placeTiming(grid: Grid, reserved: boolean[][]): void {
  const size = grid.length;
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    if (!reserved[6][i]) {
      grid[6][i] = v;
      reserved[6][i] = true;
    }
    if (!reserved[i][6]) {
      grid[i][6] = v;
      reserved[i][6] = true;
    }
  }
}

function reserveFormatAreas(reserved: boolean[][], size: number, version: number): void {
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  // The dark module is always reserved at (size-8, 8).
  reserved[size - 8][8] = true;
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[i][size - 11 + j] = true;
        reserved[size - 11 + j][i] = true;
      }
    }
  }
}

function placeData(grid: Grid, reserved: boolean[][], codewords: Uint8Array): void {
  const size = grid.length;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const bitAt = (i: number): number =>
    i < totalBits ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // skip vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[row][cc]) continue;
        grid[row][cc] = bitAt(bitIndex++);
      }
    }
    upward = !upward;
  }
}

// Mask condition 0: (row + col) % 2 === 0.
function applyMask0(grid: Grid, reserved: boolean[][]): void {
  const size = grid.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if ((r + c) % 2 === 0) grid[r][c] ^= 1;
    }
  }
}

// Format info for ECC level L (bits 01) + mask 0, BCH-encoded and XOR-masked.
function placeFormatInfo(grid: Grid, size: number): void {
  // Precomputed 15-bit format string for (L, mask 0).
  const FORMAT_L_MASK0 = 0b111011111000100;
  const bits: number[] = [];
  for (let i = 14; i >= 0; i--) bits.push((FORMAT_L_MASK0 >> i) & 1);
  // Placement around the top-left finder and split across the other two.
  const coords1: [number, number][] = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ];
  coords1.forEach(([r, c], i) => {
    grid[r][c] = bits[i];
  });
  const coords2: [number, number][] = [];
  for (let i = 0; i < 7; i++) coords2.push([size - 1 - i, 8]);
  for (let i = 0; i < 8; i++) coords2.push([8, size - 8 + i]);
  coords2.forEach(([r, c], i) => {
    grid[r][c] = bits[i];
  });
  // Dark module.
  grid[size - 8][8] = 1;
}

function placeVersionInfo(grid: Grid, size: number, version: number): void {
  if (version < 7) return;
  // BCH(18,6) version information.
  const VERSION_BITS: Record<number, number> = {
    7: 0x07c94,
    8: 0x085bc,
    9: 0x09a99,
    10: 0x0a4d3,
  };
  const bits = VERSION_BITS[version];
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    grid[r][size - 11 + c] = bit;
    grid[size - 11 + c][r] = bit;
  }
}

export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

/**
 * Encode `text` into a QR matrix (byte mode, ECC L, mask 0). Picks the smallest
 * supported version that fits. Returns null when the text is too long for the
 * supported range (the consumer then falls back to the copyable address).
 */
export function encodeQr(text: string): QrMatrix | null {
  if (!text) return null;
  const bytes = encodeBytes(text);
  const spec = VERSIONS.find((v) => {
    const ccBits = v.version <= 9 ? 8 : 16;
    const needed = Math.ceil((4 + ccBits + bytes.length * 8) / 8);
    return needed <= v.dataCodewords;
  });
  if (!spec) return null;
  const size = sizeForVersion(spec.version);
  const codewords = buildCodewords(bytes, spec);
  const { grid, reserved } = makeGrid(size);
  placeFinder(grid, reserved, 0, 0);
  placeFinder(grid, reserved, 0, size - 7);
  placeFinder(grid, reserved, size - 7, 0);
  placeAlignment(grid, reserved, ALIGN_POS[spec.version]);
  placeTiming(grid, reserved);
  reserveFormatAreas(reserved, size, spec.version);
  placeData(grid, reserved, codewords);
  applyMask0(grid, reserved);
  placeFormatInfo(grid, size);
  placeVersionInfo(grid, size, spec.version);
  const modules: boolean[][] = grid.map((row) => Array.from(row, (m) => m === 1));
  return { size, modules };
}

/**
 * Render a QR matrix as a crisp, self-contained SVG string sized for scanning. A
 * quiet zone of 4 modules is included (the spec minimum). Colors are the token
 * foreground/background so it reads in every theme; the caller wraps it. Returns
 * null when the text does not fit the supported range.
 */
export function qrSvg(text: string): string | null {
  const matrix = encodeQr(text);
  if (!matrix) return null;
  const quiet = 4;
  const dim = matrix.size + quiet * 2;
  const rects: string[] = [];
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.modules[r][c]) {
        rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
      }
    }
  }
  return (
    `<svg class="cl-qr-svg" viewBox="0 0 ${dim} ${dim}" width="132" height="132" ` +
    `role="img" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="0" width="${dim}" height="${dim}" fill="var(--cl-qr-bg)"/>` +
    `<g fill="var(--cl-qr-fg)">${rects.join('')}</g>` +
    `</svg>`
  );
}

/**
 * Build a Solana-pay style URI from a destination address and a base-unit amount,
 * then render its QR. Amount is passed as the raw base-unit string (the service
 * value) to avoid re-deriving a decimal; a wallet reads it verbatim. Returns null
 * when there is no destination or the URI does not fit the supported QR range.
 */
export function claudiumPayQrSvg(
  destination: string | null,
  amountBase: string | null,
): string | null {
  if (!destination) return null;
  // A minimal solana: URI. amountBase rides as a spl-token-agnostic reference; the
  // primary purpose is scanning the destination, which every wallet handles.
  const uri = amountBase ? `solana:${destination}?amount=${amountBase}` : `solana:${destination}`;
  return qrSvg(uri);
}
