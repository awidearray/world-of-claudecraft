// In-world advertising billboards. Framed plane-on-posts at fixed town-edge
// locations; each shows the current live ad creative for its placement (an
// uploaded image, a text sponsor card, or a localized house-ad fallback). The
// creative is painted to a canvas → CanvasTexture on an unlit material so it
// reads clearly regardless of scene lighting.
//
// ART TODO (see docs/ad-marketplace-pr-notes.md): this wooden frame is a
// procedural stand-in — an artist should provide a proper billboard model/frame.
import * as THREE from 'three';
import { groundHeight } from '../sim/world';
import type { AdActiveMap, AdContent } from '../world_api';

// Fixed billboard placements — MUST mirror server/ads_db.ts PLACEMENT_SEEDS
// (id + world x/z/yaw). Positions are seeded, so the client places the frames
// without a REST round-trip.
interface BillboardSpec { id: string; x: number; z: number; yaw: number }
const BILLBOARDS: BillboardSpec[] = [
  { id: 'billboard-townsquare', x: 8, z: -6, yaw: 0 },
  { id: 'billboard-gate', x: 0, z: 22, yaw: Math.PI },
  { id: 'billboard-market', x: -10, z: 8, yaw: 0 },
];

const CANVAS_W = 512;
const CANVAS_H = 256;
const PLANE_W = 4.2; // world units
const PLANE_H = 2.1;
const POST_H = 2.4;

interface Board {
  spec: BillboardSpec;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  key: string; // identity of the drawn creative, to skip redundant redraws
  reqId: number; // guards against a late image load overwriting a newer creative
}

export class BillboardsView {
  readonly group = new THREE.Group();
  private boards: Board[] = [];

  constructor(seed: number) {
    const postGeo = new THREE.BoxGeometry(0.18, POST_H, 0.18);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x5a3f22, roughness: 0.9 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x6b4a28, roughness: 0.85 });
    for (const spec of BILLBOARDS) {
      const canvas = document.createElement('canvas');
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      const ctx = canvas.getContext('2d')!;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      const board: Board = { spec, canvas, ctx, texture, key: '', reqId: 0 };
      this.boards.push(board);
      this.drawHouse(board);

      const node = new THREE.Group();
      node.position.set(spec.x, groundHeight(spec.x, spec.z, seed), spec.z);
      node.rotation.y = spec.yaw;
      for (const dx of [-PLANE_W / 2 + 0.25, PLANE_W / 2 - 0.25]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(dx, POST_H / 2, 0);
        node.add(post);
      }
      const frame = new THREE.Mesh(new THREE.BoxGeometry(PLANE_W + 0.3, PLANE_H + 0.3, 0.12), frameMat);
      frame.position.set(0, POST_H + PLANE_H / 2, 0);
      node.add(frame);
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(PLANE_W, PLANE_H),
        new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
      );
      plane.position.set(0, POST_H + PLANE_H / 2, 0.08);
      node.add(plane);
      this.group.add(node);
    }
  }

  // Refresh creatives from the active-ad map. Cheap: each board only redraws when
  // its active creative actually changed (tracked by `key`).
  update(active: AdActiveMap): void {
    for (const board of this.boards) {
      const ad = (active[board.spec.id] ?? [])[0] ?? null;
      const key = !ad
        ? 'house'
        : ad.kind === 'image' && ad.creativeId !== null
          ? `img:${ad.creativeId}`
          : `txt:${ad.text}`;
      if (key === board.key) continue;
      board.key = key;
      board.reqId++;
      if (!ad) this.drawHouse(board);
      else if (ad.kind === 'image' && ad.creativeId !== null) this.drawImage(board, ad.creativeId);
      else this.drawText(board, ad);
    }
  }

  private drawHouse(board: Board): void {
    const { ctx } = board;
    ctx.fillStyle = '#e9ddc0';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.strokeStyle = '#3a2e18';
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, CANVAS_W - 20, CANVAS_H - 20);
    ctx.fillStyle = '#3a2e18';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 40px Cinzel, Georgia, serif';
    ctx.fillText('YOUR AD HERE', CANVAS_W / 2, CANVAS_H / 2 - 18);
    ctx.font = '22px Georgia, serif';
    ctx.fillText('Advertise in World of ClaudeCraft', CANVAS_W / 2, CANVAS_H / 2 + 30);
    board.texture.needsUpdate = true;
  }

  private drawText(board: Board, ad: AdContent): void {
    const { ctx } = board;
    ctx.fillStyle = '#1d2740';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.strokeStyle = '#caa64a';
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, CANVAS_W - 20, CANVAS_H - 20);
    ctx.fillStyle = '#ffd76a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 34px Cinzel, Georgia, serif';
    wrapText(ctx, ad.text, CANVAS_W / 2, CANVAS_H / 2, CANVAS_W - 56, 40);
    if (ad.advertiser) {
      ctx.font = 'italic 18px Georgia, serif';
      ctx.fillStyle = '#cdd6ea';
      ctx.fillText(`— ${ad.advertiser}`, CANVAS_W / 2, CANVAS_H - 32);
    }
    board.texture.needsUpdate = true;
  }

  private drawImage(board: Board, creativeId: number): void {
    const { ctx } = board;
    ctx.fillStyle = '#161616';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    board.texture.needsUpdate = true;
    const req = board.reqId;
    const img = new Image();
    img.onload = () => {
      if (board.reqId !== req) return; // a newer creative superseded this load
      const s = Math.max(CANVAS_W / img.width, CANVAS_H / img.height);
      const w = img.width * s;
      const h = img.height * s;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.drawImage(img, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
      board.texture.needsUpdate = true;
    };
    img.onerror = () => {
      if (board.reqId === req) this.drawHouse(board);
    };
    // Same-origin: the realm that serves the client also serves the creative.
    img.src = `/ads/creative/${creativeId}.png`;
  }

  dispose(): void {
    for (const b of this.boards) b.texture.dispose();
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, lineH: number): void {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const startY = cy - ((lines.length - 1) * lineH) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lineH));
}
