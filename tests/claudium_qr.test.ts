// Round-trip proof for the ported QR encoder (src/ui/qr.ts). Encode a spread of
// real payloads, render the module matrix to an RGBA bitmap, decode with jsQR, and
// assert the decode equals the EXACT input at every EC level. A QR that does not
// decode back to its input is a FAIL, not a "looks right" pass.

import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { type EcLevel, encodeQr, qrToSvg } from '../src/ui/qr';

// Expand a module matrix (true=dark) to an RGBA pixel buffer at `scale` px per
// module. jsQR wants (Uint8ClampedArray, width, height).
function toRgba(modules: boolean[][], scale: number) {
  const n = modules.length;
  const width = n * scale;
  const height = n * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dark = modules[Math.floor(y / scale)][Math.floor(x / scale)];
      const v = dark ? 0 : 255;
      const off = (y * width + x) * 4;
      data[off] = v;
      data[off + 1] = v;
      data[off + 2] = v;
      data[off + 3] = 255;
    }
  }
  return { data, width, height };
}

function roundTrip(input: string, ec: EcLevel): string {
  const { modules } = encodeQr(input, { ecLevel: ec });
  const { data, width, height } = toRgba(modules, 6);
  const decoded = jsQR(data, width, height);
  expect(
    decoded,
    `jsQR failed to decode payload at EC ${ec}: ${JSON.stringify(input)}`,
  ).not.toBeNull();
  return (decoded as { data: string }).data;
}

const REDEEM_URL =
  'https://play.worldofclaudecraft.com/claudium/redeem?code=AB12C-DE3FG-H4JKM-N5PQR';
const SOL_ADDR = '3WjLscH2JsXLEFJZRA9z8ti8yRGxWGKbqymPd7UicRth';
const SHORT = 'CLAUDIUM';
const LONG =
  'https://play.worldofclaudecraft.com/claudium/redeem?code=AB12C-DE3FG-H4JKM-N5PQR&ref=birthday&from=Levy&to=Ada&note=enjoy';

const PAYLOADS: Record<string, string> = {
  redeemUrl: REDEEM_URL,
  solAddress: SOL_ADDR,
  short: SHORT,
  long: LONG,
};
const LEVELS: EcLevel[] = ['L', 'M', 'Q', 'H'];

describe('claudium QR encoder round-trips through jsQR', () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    for (const ec of LEVELS) {
      it(`decodes ${name} at EC ${ec} back to the exact payload`, () => {
        const decoded = roundTrip(payload, ec);
        expect(decoded).toBe(payload);
      });
    }
  }

  it('includes a 4-module quiet zone and a fitting version', () => {
    const { size, modules } = encodeQr(SHORT, { ecLevel: 'M' });
    expect(modules.length).toBe(size);
    for (let i = 0; i < size; i++) {
      for (let q = 0; q < 4; q++) {
        expect(modules[q][i]).toBe(false);
        expect(modules[size - 1 - q][i]).toBe(false);
        expect(modules[i][q]).toBe(false);
        expect(modules[i][size - 1 - q]).toBe(false);
      }
    }
  });

  it('emits a standalone svg with a module path and token-friendly default colors', () => {
    const svg = qrToSvg(REDEEM_URL, { moduleSize: 5 });
    expect(svg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toMatch(/<path d="M/);
    expect(svg).toMatch(/shape-rendering="crispEdges"/);
    // No raw hex leaks from the defaults: dark is currentColor, light transparent.
    expect(svg).toContain('fill="currentColor"');
    expect(svg).toContain('fill="transparent"');
    expect(svg).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('rejects an empty payload', () => {
    expect(() => encodeQr('')).toThrow(/non-empty/);
  });
});
