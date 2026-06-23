// Procedural $WOC holder travel-mount visual.
//
// The character rigs are all GLB-loaded, but there is no mount GLB asset; in the
// project's procedural-everything spirit we build the steed from primitives at
// runtime — a stylized low-poly quadruped parented under the rider's entity group
// (so it inherits the entity's world position + facing for free). The renderer
// attaches one when an entity's `mountId` is set and removes it on dismount.
//
// Per-tier escalation is read from the sim MountDef (src/sim/content/mounts.ts):
// body tint, a small size bump, barding/saddle accent, and — for the higher
// rungs — a crest plume and a faint emissive glow, so a Sovereign Dreadsteed
// reads as grander than an Ashmane Courser at a glance.
import * as THREE from 'three';
import { surfaceMat } from '../gfx';
import { MOUNTS, type MountDef } from '../../sim/content/mounts';

// Diagonal gait pairs (trot): front-left + back-right swing together, the other
// diagonal opposite. Indices into the leg array [FL, FR, BL, BR].
const LEG_PHASE = [0, Math.PI, Math.PI, 0];
// Local layout (pre-scale), in yards. Tuned so the rider sits astride naturally.
const HIP_Y = 0.78;
const LEG_LEN = 0.7;
const BODY_CENTER_Y = 0.96;
const BODY_H = 0.6;
const BODY_W = 0.58;
const BODY_L = 1.6;

function shade(hex: number, factor: number): number {
  const c = new THREE.Color(hex);
  c.multiplyScalar(factor);
  c.r = Math.min(1, c.r); c.g = Math.min(1, c.g); c.b = Math.min(1, c.b);
  return c.getHex();
}

export class MountVisual {
  readonly root = new THREE.Group();
  /** Y offset to raise the rider rig onto the saddle (already scaled). */
  readonly riderLift: number;
  private readonly bodyGroup = new THREE.Group();
  private readonly legPivots: THREE.Group[] = [];
  private readonly geoms: THREE.BufferGeometry[] = [];
  private readonly meshes: THREE.Mesh[] = [];
  private phase = 0;
  private readonly bodyBaseY: number;

  constructor(def: MountDef) {
    const scale = 1 + (def.tier - 1) * 0.014; // subtle grandeur up the ladder
    this.root.scale.setScalar(scale);
    this.riderLift = (BODY_CENTER_Y - 0.06) * scale;

    const bodyMat = surfaceMat({ color: def.tint, roughness: 0.72, flatShading: true });
    const maneMat = surfaceMat({ color: shade(def.tint, 0.62), roughness: 0.8, flatShading: true });
    const hoofMat = surfaceMat({ color: 0x1c160f, roughness: 0.6, flatShading: true });
    // Barding/saddle: a precious accent that brightens + gains metalness up-ladder;
    // the top three rungs also glow faintly so whales literally shine.
    const accentMetal = Math.min(0.85, 0.15 + def.tier * 0.06);
    const glow = def.tier >= 9 ? def.tier * 0.05 : 0;
    const accentMat = surfaceMat({
      color: shade(def.tint, 1.25), roughness: 0.4, metalness: accentMetal,
      emissive: glow > 0 ? def.tint : 0x000000, emissiveIntensity: glow, flatShading: true,
    });

    const mesh = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
      const g = new THREE.BoxGeometry(w, h, d);
      this.geoms.push(g);
      const m = new THREE.Mesh(g, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      this.meshes.push(m);
      return m;
    };

    this.bodyBaseY = 0;
    this.root.add(this.bodyGroup);

    // Barrel of the body.
    this.bodyGroup.add(mesh(BODY_W, BODY_H, BODY_L, bodyMat, 0, BODY_CENTER_Y, 0));
    // Chest taper + haunch.
    this.bodyGroup.add(mesh(BODY_W * 0.92, BODY_H * 0.9, 0.3, bodyMat, 0, BODY_CENTER_Y + 0.02, BODY_L / 2));
    this.bodyGroup.add(mesh(BODY_W * 1.02, BODY_H * 1.02, 0.32, bodyMat, 0, BODY_CENTER_Y + 0.03, -BODY_L / 2));

    // Neck rising to the front, head, ears, snout.
    const neck = mesh(0.36, 0.62, 0.34, bodyMat, 0, BODY_CENTER_Y + 0.42, BODY_L / 2 + 0.12);
    neck.rotation.x = -0.55;
    const head = mesh(0.3, 0.34, 0.6, bodyMat, 0, BODY_CENTER_Y + 0.78, BODY_L / 2 + 0.42);
    head.rotation.x = -0.2;
    this.bodyGroup.add(mesh(0.22, 0.16, 0.34, bodyMat, 0, BODY_CENTER_Y + 0.66, BODY_L / 2 + 0.74)); // snout
    this.bodyGroup.add(mesh(0.08, 0.16, 0.06, maneMat, -0.1, BODY_CENTER_Y + 0.98, BODY_L / 2 + 0.34)); // ear L
    this.bodyGroup.add(mesh(0.08, 0.16, 0.06, maneMat, 0.1, BODY_CENTER_Y + 0.98, BODY_L / 2 + 0.34)); // ear R
    // Mane along the neck + forelock.
    this.bodyGroup.add(mesh(0.1, 0.5, 0.3, maneMat, 0, BODY_CENTER_Y + 0.5, BODY_L / 2 + 0.0));
    // Tail.
    const tail = mesh(0.12, 0.5, 0.14, maneMat, 0, BODY_CENTER_Y + 0.1, -BODY_L / 2 - 0.12);
    tail.rotation.x = 0.5;

    // Saddle + barding accent on top of the barrel.
    this.bodyGroup.add(mesh(BODY_W + 0.06, 0.14, 0.66, accentMat, 0, BODY_CENTER_Y + BODY_H / 2 + 0.04, -0.05));
    // Chest plate.
    this.bodyGroup.add(mesh(BODY_W + 0.04, 0.3, 0.1, accentMat, 0, BODY_CENTER_Y + 0.02, BODY_L / 2 + 0.13));
    // Crest plume for the top rungs.
    if (def.tier >= 7) {
      const plume = mesh(0.08, 0.3 + def.tier * 0.03, 0.08, accentMat, 0, BODY_CENTER_Y + 1.06, BODY_L / 2 + 0.3);
      plume.rotation.x = -0.25;
    }

    // Four legs on hip pivots so they swing from the shoulder/haunch.
    const legX = BODY_W / 2 - 0.04;
    const legZ = BODY_L / 2 - 0.28;
    const legPos: [number, number][] = [[legX, legZ], [-legX, legZ], [legX, -legZ], [-legX, -legZ]];
    for (const [x, z] of legPos) {
      const pivot = new THREE.Group();
      pivot.position.set(x, HIP_Y, z);
      const leg = mesh(0.16, LEG_LEN, 0.18, bodyMat, 0, -LEG_LEN / 2, 0);
      pivot.add(leg);
      const hoof = mesh(0.2, 0.12, 0.22, hoofMat, 0, -LEG_LEN - 0.02, 0.01);
      pivot.add(hoof);
      this.bodyGroup.add(pivot);
      this.legPivots.push(pivot);
    }
  }

  /** Advance the gait. `speed` is the rider's world u/s; legs swing + the barrel
   *  bobs proportionally, settling to a stand at rest. */
  update(dt: number, speed: number): void {
    const norm = Math.min(1, speed / 9); // ~epic-mount top speed
    this.phase += dt * (3 + norm * 9);
    const swing = (0.12 + norm * 0.5);
    for (let i = 0; i < this.legPivots.length; i++) {
      this.legPivots[i].rotation.x = Math.sin(this.phase + LEG_PHASE[i]) * swing;
    }
    // gentle vertical bob synced to the diagonal beat, plus a forward pitch lean.
    this.bodyGroup.position.y = this.bodyBaseY + Math.abs(Math.sin(this.phase)) * 0.04 * norm;
    this.bodyGroup.rotation.x = -norm * 0.05;
  }

  setShadow(on: boolean): void {
    for (const m of this.meshes) m.castShadow = on;
  }

  /** Release this clone's geometries (materials are shared via surfaceMat and are
   *  never disposed). Call on dismount / view removal. */
  dispose(): void {
    this.root.parent?.remove(this.root);
    for (const g of this.geoms) g.dispose();
    this.geoms.length = 0;
  }
}

/** Build the steed for a mount id, or null for an unknown id. */
export function createMountVisual(mountId: string): MountVisual | null {
  const def: MountDef | undefined = MOUNTS[mountId];
  return def ? new MountVisual(def) : null;
}
