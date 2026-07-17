// The RiverBoat casino interior: a moored paddle-steamer saloon dressed entirely
// from PROCEDURAL geometry (no GLB dependency, so it is non-fatal and needs no
// asset preload). It is the visual counterpart of the sim-side layout in
// src/sim/riverboat_layout.ts, placed at riverboatOrigin() in the far instance
// band; the renderer builds it once, behind cfg.riverboatCasino.
//
// Palette: walnut planking, brass fittings (the Gilded Strongbox gold), crimson
// velvet, and green baize, lit by warm lanterns rendered UNLIT
// (MeshBasicMaterial, toneMapped off) so they read glowing on every quality tier
// (the billboards trick). The sportsbook screens ship here as static glowing
// panels; the sportsbook game-leaf later repaints them with live match data via
// a CanvasTexture on the same meshes.
import * as THREE from 'three';
import { riverboatOrigin } from '../sim/data';
import {
  CARD_TABLE_ANCHORS,
  CASHIER_CAGE,
  type DeckAnchor,
  GACHA_CABINETS,
  HILO_TABLE,
  RIVERBOAT_HALF_BEAM,
  RIVERBOAT_Z_MAX,
  RIVERBOAT_Z_MIN,
  SLOTS_CORNER,
  SPORTSBOOK_SCREENS,
  SPORTSBOOK_TICKET_WINDOW,
  WAGER_PIT,
} from '../sim/riverboat_layout';
import { groundHeight } from '../sim/world';
import { surfaceMat } from './gfx';
import { freezeStaticMatrices } from './static_matrix';

const WALNUT = 0x3a2416;
const WALNUT_DARK = 0x2a1810;
const BRASS = 0xc9a227;
const VELVET = 0x7a1f2b;
const BAIZE = 0x1e4d2b;
const LANTERN_GLOW = 0xffd9a0;
const SCREEN_GLOW = 0x4a90d9;
const RAIL_Y = 1.1;
const WALL_HEIGHT = 7;
const LANTERN_Y = 6.2;

export interface RiverboatSaloonView {
  group: THREE.Group;
  // Warm point lights the renderer folds into its constant fireLights budget.
  lights: THREE.PointLight[];
}

function wood(color: number): THREE.Material {
  return surfaceMat({ color, roughness: 0.85, metalness: 0.0, flatShading: true });
}
function brass(): THREE.Material {
  return surfaceMat({ color: BRASS, roughness: 0.35, metalness: 0.8, flatShading: true });
}
// Unlit emissive: reads bright on every tier without a light (lanterns, screens).
function glow(color: number): THREE.Material {
  const m = new THREE.MeshBasicMaterial({ color });
  m.toneMapped = false;
  return m;
}

function box(
  parent: THREE.Object3D,
  mat: THREE.Material,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

// A card / hi-lo table: baize top on a walnut pedestal, brass rim.
function table(parent: THREE.Object3D, a: DeckAnchor, felt: number): void {
  const woodMat = wood(WALNUT);
  box(parent, woodMat, 1.0, 1.0, 1.0, a.x, 0.5, a.z); // pedestal
  box(
    parent,
    surfaceMat({ color: felt, roughness: 0.95, flatShading: true }),
    3.0,
    0.16,
    2.2,
    a.x,
    1.05,
    a.z,
  );
  box(parent, brass(), 3.2, 0.1, 2.4, a.x, 0.98, a.z); // brass rim under the felt
}

// A tall cabinet (slots / gacha): walnut body with a glowing face panel.
function cabinet(parent: THREE.Object3D, a: DeckAnchor, faceColor: number): void {
  box(parent, wood(WALNUT_DARK), 1.6, 3.2, 1.2, a.x, 1.6, a.z);
  box(parent, brass(), 1.7, 0.3, 1.3, a.x, 3.35, a.z); // brass topper
  // Glowing reel/curio window on the aft-facing side (+z).
  box(parent, glow(faceColor), 1.1, 1.4, 0.08, a.x, 2.0, a.z + 0.64);
}

// A hanging lantern: a small glowing globe on a brass chain stub.
function lantern(parent: THREE.Object3D, x: number, z: number, lights: THREE.PointLight[]): void {
  box(parent, brass(), 0.12, 1.2, 0.12, x, LANTERN_Y + 0.9, z); // chain
  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), glow(LANTERN_GLOW));
  globe.position.set(x, LANTERN_Y, z);
  parent.add(globe);
  const light = new THREE.PointLight(0xffb060, 0.9, 22, 2);
  light.position.set(x, LANTERN_Y - 0.3, z);
  lights.push(light);
}

export function buildRiverboatSaloon(seed: number): RiverboatSaloonView {
  const group = new THREE.Group();
  const origin = riverboatOrigin();
  group.position.set(origin.x, groundHeight(origin.x, origin.z, seed), origin.z);
  const lights: THREE.PointLight[] = [];

  const beam = RIVERBOAT_HALF_BEAM;
  const zMin = RIVERBOAT_Z_MIN;
  const zMax = RIVERBOAT_Z_MAX;
  const len = zMax - zMin;
  const zMid = (zMin + zMax) / 2;

  // Deck floor + a crimson runner down the central promenade.
  box(group, wood(WALNUT), beam * 2, 0.2, len, 0, 0.0, zMid);
  box(
    group,
    surfaceMat({ color: VELVET, roughness: 0.95, flatShading: true }),
    6,
    0.06,
    len - 8,
    0,
    0.14,
    zMid,
  );

  // Hull side walls (port/starboard) + bow/stern walls, plus a brass rail cap.
  box(group, wood(WALNUT_DARK), 0.6, WALL_HEIGHT, len, -beam, WALL_HEIGHT / 2, zMid);
  box(group, wood(WALNUT_DARK), 0.6, WALL_HEIGHT, len, beam, WALL_HEIGHT / 2, zMid);
  box(group, wood(WALNUT_DARK), beam * 2, WALL_HEIGHT, 0.6, 0, WALL_HEIGHT / 2, zMin);
  box(group, wood(WALNUT_DARK), beam * 2, WALL_HEIGHT, 0.6, 0, WALL_HEIGHT / 2, zMax);
  box(group, brass(), 0.3, 0.3, len, -beam, RAIL_Y + 0.4, zMid);
  box(group, brass(), 0.3, 0.3, len, beam, RAIL_Y + 0.4, zMid);

  // Card tables (aft) + hi-lo table (mid-port), on green baize.
  for (const a of CARD_TABLE_ANCHORS) table(group, a, BAIZE);
  table(group, HILO_TABLE, BAIZE);

  // The wager ring: a roped brass circle around the pit anchor.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.14, 8, 24), brass());
  ring.rotation.x = Math.PI / 2;
  ring.position.set(WAGER_PIT.x, RAIL_Y, WAGER_PIT.z);
  group.add(ring);

  // Slot cabinets (port-bow) + gacha cabinets (starboard-bow).
  for (const a of SLOTS_CORNER) cabinet(group, a, LANTERN_GLOW);
  for (const a of GACHA_CABINETS) cabinet(group, a, VELVET);

  // Cashier cage at the bow: a walnut counter behind brass bars, and a coin
  // glyph glow above it.
  box(group, wood(WALNUT_DARK), 8, 2.4, 1.4, CASHIER_CAGE.x, 1.2, CASHIER_CAGE.z);
  for (let i = -3; i <= 3; i++) {
    box(group, brass(), 0.12, 2.2, 0.12, CASHIER_CAGE.x + i * 1.1, 3.4, CASHIER_CAGE.z + 0.1);
  }
  box(group, glow(BRASS), 1.2, 1.2, 0.1, CASHIER_CAGE.x, 4.4, CASHIER_CAGE.z);

  // Sportsbook screen wall (forward-starboard) + ticket window: glowing panels
  // in brass frames. The sportsbook leaf later swaps the panel material for a
  // live CanvasTexture; here they are static attract-boards.
  for (const s of SPORTSBOOK_SCREENS) {
    box(group, brass(), 3.4, 2.2, 0.16, s.x, 3.0, s.z); // frame
    const screen = box(group, glow(SCREEN_GLOW), 3.0, 1.8, 0.1, s.x, 3.0, s.z + 0.1);
    screen.name = `riverboat_screen_${s.x}_${s.z}`;
  }
  box(
    group,
    wood(WALNUT_DARK),
    5,
    2.2,
    1.2,
    SPORTSBOOK_TICKET_WINDOW.x,
    1.1,
    SPORTSBOOK_TICKET_WINDOW.z,
  );

  // Hanging lanterns down the promenade centreline for warm light.
  for (let z = zMin + 12; z <= zMax - 12; z += 16) {
    lantern(group, -beam * 0.5, z, lights);
    lantern(group, beam * 0.5, z, lights);
  }

  freezeStaticMatrices(group);
  return { group, lights };
}
