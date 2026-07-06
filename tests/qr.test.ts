import { describe, expect, it } from 'vitest';
import { claudiumPayQrSvg, encodeQr, qrSvg } from '../src/ui/qr';

// The tiny self-contained QR encoder. It is not a dependency; these pin the
// matrix contract the pay panel relies on: a well-formed square matrix with the
// three finder patterns, a scannable SVG, and a clean null fallback.

describe('encodeQr', () => {
  it('produces a square matrix sized 17 + 4*version', () => {
    const m = encodeQr('solana:So1DestinationAddress1111111111111111111111');
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.modules.length).toBe(m.size);
    expect(m.modules.every((row) => row.length === m.size)).toBe(true);
    // Version >= 1 so size is at least 21.
    expect(m.size).toBeGreaterThanOrEqual(21);
    expect((m.size - 17) % 4).toBe(0);
  });

  it('places the three finder patterns (dark 7x7 rings in three corners)', () => {
    const m = encodeQr('hello world');
    expect(m).not.toBeNull();
    if (!m) return;
    const s = m.size;
    // Each finder's outer corner module is dark, and its (3,3) center is dark.
    const finderDark = (r: number, c: number): boolean =>
      m.modules[r][c] && m.modules[r + 3]?.[c + 3];
    expect(finderDark(0, 0)).toBe(true);
    expect(finderDark(0, s - 7)).toBe(true);
    expect(finderDark(s - 7, 0)).toBe(true);
  });

  it('is deterministic for the same input', () => {
    const a = encodeQr('CLDM:ref-woc-1');
    const b = encodeQr('CLDM:ref-woc-1');
    expect(a).toEqual(b);
  });

  it('returns null for empty input and for input too long for the supported range', () => {
    expect(encodeQr('')).toBeNull();
    // Well past the version-10 byte-mode L capacity (~271 bytes).
    expect(encodeQr('x'.repeat(4000))).toBeNull();
  });
});

describe('qrSvg', () => {
  it('renders a self-contained SVG with a quiet zone and tokenized colors', () => {
    const svg = qrSvg('solana:So1DestinationAddress1111111111111111111111');
    expect(svg).not.toBeNull();
    if (!svg) return;
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('var(--cl-qr-bg)');
    expect(svg).toContain('var(--cl-qr-fg)');
    expect(svg).toContain('shape-rendering="crispEdges"');
    // No raw hex color in the rendered SVG (theme-driven).
    expect(/#[0-9a-fA-F]{3,8}/.test(svg)).toBe(false);
  });
});

describe('claudiumPayQrSvg', () => {
  it('builds a solana: URI QR from destination + base amount', () => {
    const svg = claudiumPayQrSvg('So1DestinationAddress1111111111111111111111', '1500000000');
    expect(svg).not.toBeNull();
    expect(svg?.startsWith('<svg')).toBe(true);
  });

  it('returns null when there is no destination (falls back to copyable address)', () => {
    expect(claudiumPayQrSvg(null, '1500000000')).toBeNull();
  });

  it('renders even with no amount (destination-only scan)', () => {
    expect(claudiumPayQrSvg('So1DestinationAddress1111111111111111111111', null)).not.toBeNull();
  });
});
