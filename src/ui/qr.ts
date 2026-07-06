// Ported verbatim (encoder logic) from the economy service's proven encoder
// (svc-daily-rewards/service/src/qr/qr.ts), which is jsQR round-trip tested. This
// replaces the deleted hand-rolled game-client encoder that failed the design sweep.
// The ONLY divergence from the service copy is qrToSvg's color defaults: to keep this
// module free of raw hex (the src/styles token rule), dark/light default to
// 'currentColor' / 'transparent' so the CALLER threads theme tokens; a caller may
// still pass explicit colors. The round-trip test (tests/claudium_qr.test.ts) decodes
// the output with jsQR and asserts it equals the exact input at every EC level.
//
// A dependency-free, spec-correct (ISO/IEC 18004) QR encoder. Byte mode only
// (sufficient for redeem URLs and Solana base58 addresses), Reed-Solomon error
// correction over GF(256), correct data/EC codeword interleaving, all 8 mask
// patterns with penalty scoring, BCH-encoded format and version information,
// finder / timing / alignment patterns, and a 4-module quiet zone.
//
// Public API:
//   encodeQr(text, opts?) -> { size, modules } where modules[y][x], true=dark,
//     INCLUDING the 4-module quiet zone.
//   qrToSvg(text, opts?)  -> a standalone <svg> string.
//
// Version/EC are chosen automatically to fit the payload (default EC 'M').

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

// ---- GF(256) arithmetic (primitive polynomial 0x11d, generator 2) -----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Generator polynomial for `degree` EC codewords (coefficients, high to low).
function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

// Reed-Solomon EC codewords for a block of data codewords.
function rsEncode(data: number[], ecCount: number): number[] {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Array(ecCount).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) res[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return res;
}

// ---- Version / EC capacity tables (versions 1..10, byte mode) ---------------
// For each version and EC level: [ecCodewordsPerBlock, numBlocksGroup1,
// dataCodewordsGroup1, numBlocksGroup2, dataCodewordsGroup2]. From ISO/IEC 18004
// Table 9. Total data codewords = g1*d1 + g2*d2.
type EcSpec = [number, number, number, number, number];
type VersionSpec = { L: EcSpec; M: EcSpec; Q: EcSpec; H: EcSpec };

const VERSIONS: Record<number, VersionSpec> = {
  1: { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  2: { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  3: { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  4: { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  5: { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  7: { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  8: { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  9: { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  10: {
    L: [18, 2, 68, 2, 69],
    M: [26, 4, 43, 1, 44],
    Q: [24, 6, 19, 2, 20],
    H: [28, 6, 15, 2, 16],
  },
  11: { L: [20, 4, 81, 0, 0], M: [30, 1, 50, 4, 51], Q: [28, 4, 22, 4, 23], H: [24, 3, 12, 8, 13] },
  12: {
    L: [24, 2, 92, 2, 93],
    M: [22, 6, 36, 2, 37],
    Q: [26, 4, 20, 6, 21],
    H: [28, 7, 14, 4, 15],
  },
  13: {
    L: [26, 4, 107, 0, 0],
    M: [22, 8, 37, 1, 38],
    Q: [24, 8, 20, 4, 21],
    H: [22, 12, 11, 4, 12],
  },
};

function totalDataCodewords(spec: EcSpec): number {
  const [, g1, d1, g2, d2] = spec;
  return g1 * d1 + g2 * d2;
}

function versionSize(version: number): number {
  return 17 + version * 4;
}

// Alignment pattern centre coordinates per version (ISO Table E.1), versions 1..10.
const ALIGN_POS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
};

// ---- Bit buffer -------------------------------------------------------------
class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

// Char-count indicator bit-length for byte mode: 8 bits for versions 1..9,
// 16 bits for versions 10..40 (ISO/IEC 18004 Table 3).
function byteCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

// ---- Data encoding ----------------------------------------------------------
function encodeData(bytes: number[], version: number, ec: EcLevel): number[] {
  const spec = VERSIONS[version][ec];
  const totalData = totalDataCodewords(spec);
  const capacityBits = totalData * 8;

  const bb = new BitBuffer();
  bb.put(0b0100, 4); // byte mode indicator
  bb.put(bytes.length, byteCountBits(version));
  for (const b of bytes) bb.put(b, 8);

  // Terminator: up to 4 zero bits, not exceeding capacity.
  const remaining = capacityBits - bb.length;
  bb.put(0, Math.min(4, remaining));
  // Pad to a byte boundary.
  while (bb.length % 8 !== 0) bb.bits.push(0);

  // Turn bits into codewords.
  const codewords: number[] = [];
  for (let i = 0; i < bb.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bb.bits[i + j];
    codewords.push(v);
  }
  // Pad codewords with the alternating 0xEC / 0x11 pattern.
  const PAD = [0xec, 0x11];
  let pi = 0;
  while (codewords.length < totalData) codewords.push(PAD[pi++ % 2]);

  // Split into blocks, compute EC per block, then interleave.
  const [ecCount, g1, d1, g2, d2] = spec;
  const blocks: { data: number[]; ec: number[] }[] = [];
  let idx = 0;
  for (let i = 0; i < g1; i++) {
    const data = codewords.slice(idx, idx + d1);
    idx += d1;
    blocks.push({ data, ec: rsEncode(data, ecCount) });
  }
  for (let i = 0; i < g2; i++) {
    const data = codewords.slice(idx, idx + d2);
    idx += d2;
    blocks.push({ data, ec: rsEncode(data, ecCount) });
  }

  // Interleave data codewords, then EC codewords.
  const result: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const blk of blocks) if (i < blk.data.length) result.push(blk.data[i]);
  }
  for (let i = 0; i < ecCount; i++) {
    for (const blk of blocks) result.push(blk.ec[i]);
  }
  return result;
}

// ---- Matrix construction ----------------------------------------------------
type Cell = { dark: boolean; reserved: boolean };

function makeMatrix(version: number): Cell[][] {
  const n = versionSize(version);
  const m: Cell[][] = [];
  for (let y = 0; y < n; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < n; x++) row.push({ dark: false, reserved: false });
    m.push(row);
  }
  return m;
}

function placeFinder(m: Cell[][], top: number, left: number): void {
  for (let y = -1; y <= 7; y++) {
    for (let x = -1; x <= 7; x++) {
      const yy = top + y;
      const xx = left + x;
      if (yy < 0 || yy >= m.length || xx < 0 || xx >= m.length) continue;
      const inRing =
        (y >= 0 && y <= 6 && (x === 0 || x === 6)) || (x >= 0 && x <= 6 && (y === 0 || y === 6));
      const inCore = y >= 2 && y <= 4 && x >= 2 && x <= 4;
      m[yy][xx].dark = inRing || inCore;
      m[yy][xx].reserved = true;
    }
  }
}

function placeAlignment(m: Cell[][], cx: number, cy: number): void {
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      const ring = Math.max(Math.abs(x), Math.abs(y));
      m[cy + y][cx + x].dark = ring !== 1;
      m[cy + y][cx + x].reserved = true;
    }
  }
}

function placePatterns(m: Cell[][], version: number): void {
  const n = m.length;
  placeFinder(m, 0, 0);
  placeFinder(m, 0, n - 7);
  placeFinder(m, n - 7, 0);

  // Timing patterns.
  for (let i = 8; i < n - 8; i++) {
    const on = i % 2 === 0;
    if (!m[6][i].reserved) {
      m[6][i].dark = on;
      m[6][i].reserved = true;
    }
    if (!m[i][6].reserved) {
      m[i][6].dark = on;
      m[i][6].reserved = true;
    }
  }

  // Alignment patterns. They are placed at every (row, col) pair of the
  // alignment-position list EXCEPT the three that overlap the finder patterns:
  // (min,min), (min,max), (max,min). Positions that merely cross a timing line
  // (e.g. (6, mid)) ARE placed; alignment overrides the timing modules there.
  const pos = ALIGN_POS[version];
  const n2 = m.length;
  const lo = 6;
  const hi = n2 - 7;
  for (const cy of pos) {
    for (const cx of pos) {
      const overlapsFinder =
        (cy === lo && cx === lo) || (cy === lo && cx === hi) || (cy === hi && cx === lo);
      if (overlapsFinder) continue;
      placeAlignment(m, cx, cy);
    }
  }

  // Dark module.
  m[n - 8][8].dark = true;
  m[n - 8][8].reserved = true;

  // Reserve format-information areas.
  reserveFormatAreas(m);
}

function reserveFormatAreas(m: Cell[][]): void {
  const n = m.length;
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      m[8][i].reserved = true;
      m[i][8].reserved = true;
    }
  }
  for (let i = 0; i < 8; i++) {
    m[8][n - 1 - i].reserved = true;
    m[n - 1 - i][8].reserved = true;
  }
  m[8][n - 8].reserved = true; // adjacent to dark module column
}

// Zig-zag data placement (bottom-right upward), skipping reserved cells.
function placeData(m: Cell[][], codewords: number[]): void {
  const n = m.length;
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let bi = 0;
  let upward = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the timing column
    for (let r = 0; r < n; r++) {
      const y = upward ? n - 1 - r : r;
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (m[y][x].reserved) continue;
        m[y][x].dark = bi < bits.length ? bits[bi] === 1 : false;
        bi++;
      }
    }
    upward = !upward;
  }
}

function maskFn(pattern: number): (x: number, y: number) => boolean {
  switch (pattern) {
    case 0:
      return (x, y) => (x + y) % 2 === 0;
    case 1:
      return (_x, y) => y % 2 === 0;
    case 2:
      return (x, _y) => x % 3 === 0;
    case 3:
      return (x, y) => (x + y) % 3 === 0;
    case 4:
      return (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new Error('mask 0..7');
  }
}

function applyMask(m: Cell[][], pattern: number): Cell[][] {
  const fn = maskFn(pattern);
  const out = m.map((row) => row.map((c) => ({ ...c })));
  for (let y = 0; y < out.length; y++) {
    for (let x = 0; x < out.length; x++) {
      if (!out[y][x].reserved && fn(x, y)) out[y][x].dark = !out[y][x].dark;
    }
  }
  return out;
}

// Format information: 5 bits (EC level 2 + mask 3) with BCH(15,5) + mask 0x5412.
const EC_BITS: Record<EcLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

function formatBits(ec: EcLevel, mask: number): number[] {
  const data = (EC_BITS[ec] << 3) | mask;
  let rem = data << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= g << (i - 10);
  }
  const bits = ((data << 10) | rem) ^ 0b101010000010010;
  const out: number[] = [];
  for (let i = 14; i >= 0; i--) out.push((bits >> i) & 1);
  return out;
}

function placeFormat(m: Cell[][], ec: EcLevel, mask: number): void {
  const n = m.length;
  const bits = formatBits(ec, mask);
  // Around top-left finder.
  const coords1: [number, number][] = [];
  for (let i = 0; i <= 5; i++) coords1.push([8, i]);
  coords1.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i <= 14; i++) coords1.push([14 - i, 8]);
  // bits[0..14] map to coords1[0..14]
  for (let i = 0; i < 15; i++) {
    const [y, x] = coords1[i];
    m[y][x].dark = bits[i] === 1;
    m[y][x].reserved = true;
  }
  // Mirror copy: bits[0..7] along the bottom-left column, bits[8..14] along the
  // top-right row.
  for (let i = 0; i < 8; i++) {
    m[n - 1 - i][8].dark = bits[i] === 1;
    m[n - 1 - i][8].reserved = true;
  }
  for (let i = 8; i < 15; i++) {
    m[8][n - 15 + i].dark = bits[i] === 1;
    m[8][n - 15 + i].reserved = true;
  }
}

// Version information: BCH(18,6), only for version >= 7.
function versionInfoBits(version: number): number[] {
  let rem = version << 12;
  const g = 0b1111100100101;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= g << (i - 12);
  }
  const bits = (version << 12) | rem;
  const out: number[] = [];
  for (let i = 17; i >= 0; i--) out.push((bits >> i) & 1);
  return out;
}

function placeVersion(m: Cell[][], version: number): void {
  if (version < 7) return;
  const n = m.length;
  const bits = versionInfoBits(version); // bits[0]=MSB (bit17) .. bits[17]=LSB(bit0)
  // Spec fills modules with the LSB first: module index i (0..17) carries bit i,
  // where bit 0 is the LSB of the 18-bit codeword. bits[] is MSB-first, so bit i
  // is bits[17 - i].
  for (let i = 0; i < 18; i++) {
    const bit = bits[17 - i] === 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    // bottom-left block: rows n-11..n-9, columns 0..5
    m[n - 11 + col][row].dark = bit;
    m[n - 11 + col][row].reserved = true;
    // top-right block: columns n-11..n-9, rows 0..5
    m[row][n - 11 + col].dark = bit;
    m[row][n - 11 + col].reserved = true;
  }
}

// ---- Mask penalty scoring (ISO 6.8.3) ---------------------------------------
function penalty(m: Cell[][]): number {
  const n = m.length;
  const d = (y: number, x: number) => m[y][x].dark;
  let score = 0;

  // Rule 1: runs of >=5 same-colour modules (rows and columns).
  for (let y = 0; y < n; y++) {
    let run = 1;
    for (let x = 1; x < n; x++) {
      if (d(y, x) === d(y, x - 1)) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let x = 0; x < n; x++) {
    let run = 1;
    for (let y = 1; y < n; y++) {
      if (d(y, x) === d(y - 1, x)) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }

  // Rule 2: 2x2 blocks of the same colour.
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = d(y, x);
      if (v === d(y, x + 1) && v === d(y + 1, x) && v === d(y + 1, x + 1)) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns (with 4 light modules on a side).
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  const match = (arr: boolean[], off: number, pat: boolean[]) => {
    for (let k = 0; k < 11; k++) if (arr[off + k] !== pat[k]) return false;
    return true;
  };
  for (let y = 0; y < n; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < n; x++) row.push(d(y, x));
    for (let x = 0; x + 11 <= n; x++) {
      if (match(row, x, pat1) || match(row, x, pat2)) score += 40;
    }
  }
  for (let x = 0; x < n; x++) {
    const col: boolean[] = [];
    for (let y = 0; y < n; y++) col.push(d(y, x));
    for (let y = 0; y + 11 <= n; y++) {
      if (match(col, y, pat1) || match(col, y, pat2)) score += 40;
    }
  }

  // Rule 4: dark-module proportion.
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (d(y, x)) dark++;
  const percent = (dark * 100) / (n * n);
  const prev = Math.floor(percent / 5) * 5;
  const next = prev + 5;
  score += Math.min(Math.abs(prev - 50), Math.abs(next - 50)) * 2;

  return score;
}

// ---- Public API -------------------------------------------------------------
function utf8Bytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

function chooseVersion(byteLen: number, ec: EcLevel, minVersion: number): number {
  const MAX_VERSION = 13;
  for (let v = Math.max(1, minVersion); v <= MAX_VERSION; v++) {
    const spec = VERSIONS[v][ec];
    const total = totalDataCodewords(spec);
    // header = 4 (mode) + count-indicator bits; data = byteLen*8; terminator is
    // handled by the capacity check.
    const needBits = 4 + byteCountBits(v) + byteLen * 8;
    if (needBits <= total * 8) return v;
  }
  throw new Error(
    `payload too large for versions 1..${MAX_VERSION} at EC ${ec} (${byteLen} bytes)`,
  );
}

const QUIET = 4;

function buildModules(
  text: string,
  ec: EcLevel,
  minVersion: number,
): { version: number; modules: boolean[][] } {
  const bytes = utf8Bytes(text);
  const version = chooseVersion(bytes.length, ec, minVersion);
  const codewords = encodeData(bytes, version, ec);

  const base = makeMatrix(version);
  placePatterns(base, version);
  placeVersion(base, version);
  placeData(base, codewords);

  // Try all 8 masks; pick the lowest penalty. Format info is placed per mask so
  // penalty scoring sees the final matrix.
  let best: Cell[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(base, mask);
    placeFormat(masked, ec, mask);
    const s = penalty(masked);
    if (s < bestScore) {
      bestScore = s;
      best = masked;
    }
  }
  const chosen = best as Cell[][];

  // Expand to boolean[][] with the quiet zone.
  const n = chosen.length;
  const size = n + QUIET * 2;
  const modules: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = new Array(size).fill(false);
    modules.push(row);
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) modules[y + QUIET][x + QUIET] = chosen[y][x].dark;
  }
  return { version, modules };
}

export function encodeQr(
  text: string,
  opts?: { ecLevel?: EcLevel; minVersion?: number },
): { size: number; modules: boolean[][] } {
  const ec = opts?.ecLevel ?? 'M';
  const minVersion = opts?.minVersion ?? 1;
  if (text.length === 0) throw new Error('encodeQr requires a non-empty payload');
  const { modules } = buildModules(text, ec, minVersion);
  return { size: modules.length, modules };
}

/**
 * Render a payload to a standalone <svg> string. Colors default to token-friendly
 * keywords (the module keeps zero raw hex per the src/styles rule): `dark`
 * defaults to `currentColor` (the caller sets `color` via a CSS token) and `light`
 * to `transparent`. A caller may pass explicit colors, but the Claudium window
 * passes token-driven values so the code reads in both themes.
 */
export function qrToSvg(
  text: string,
  opts?: { ecLevel?: EcLevel; moduleSize?: number; dark?: string; light?: string },
): string {
  const ec = opts?.ecLevel ?? 'M';
  const ms = opts?.moduleSize ?? 4;
  const dark = opts?.dark ?? 'currentColor';
  const light = opts?.light ?? 'transparent';
  const { modules } = buildModules(text, ec, 1);
  const n = modules.length;
  const dim = n * ms;
  let paths = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules[y][x]) paths += `M${x * ms} ${y * ms}h${ms}v${ms}h-${ms}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${paths}" fill="${dark}"/>` +
    `</svg>`
  );
}
