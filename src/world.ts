import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { AABB, batchStatic, makeRng, meshMaterials } from '../engine/src';
import { garageTexture, grassTexture, pavingTexture, shingleTexture, sidingTexture, texMat, woodTexture } from './textures';
import { grassTintForCell } from './grass-color';
import {
  BAND, CELL, CROSS_X0, CROSS_X1, GH, GW, HEDGE_D0, HOUSE_D0, HOUSE_D1, K_BED, K_LAWN, K_NONE, K_PAVED, LOT_D1, LOT_W,
  LOTS_PER_SIDE, MAX_X, MAX_Z, MIN_X, MIN_Z, OWNERS, PUMP, PX, ROAD, STREETS, STREET_END, WALK, streetZ,
} from './config';

type Rect = [number, number, number, number]; // lx0, lx1, d0, d1 in lot-local coordinates

/** A trimmable stretch of hedge. Shaggy hedges sprout tufts; trimming hides them. */
export interface Hedge {
  lot: number;
  box: AABB;
  /** Show or hide this stretch's tufts (they're drawn as part of one mesh per lot). */
  tufts: { visible: boolean };
  shaggy: boolean;
  /** Nights until it turns shaggy again. */
  regrow: number;
}

/**
 * A house plot. Lot-local coordinates: lx runs along the street (0..LOT_W), d is the distance from
 * the road's centre line (the house front faces the road). North-side lots are rotated 180°.
 */
export interface Lot {
  id: number;
  street: number;
  zc: number;
  side: 1 | -1;
  x0: number;
  number: number;
  owner: string;
  house: Rect;
  drive: Rect;
  path: Rect;
  beds: Rect[];
  doorLx: number;
  door: { x: number; z: number };
  centre: { x: number; z: number };
  houseBox: AABB;
  houseMats: THREE.Material[];
  houseWire: THREE.LineBasicMaterial | null;
  fade: number;
  lawnCells: number[];
  pavedCells: number[];
  bedCells: number[];
  /** Paved cells along the lawn's border, where grass creeps over and needs edging. */
  edgeCells: number[];
  hedges: Hedge[];
  gnomeSpots: { x: number; z: number }[];
}

export interface Tree { x: number; z: number; mats: THREE.MeshStandardMaterial[]; wire: THREE.LineBasicMaterial; fade: number; h: number }

export interface Street {
  id: number;
  name: string;
  zc: number;
  unlocked: boolean;
  /** Road-closed barrier on the band's north edge (none for the first street). */
  barrier: { objs: THREE.Object3D[]; box: AABB } | null;
  pump: { x: number; z: number; ring: THREE.Mesh; ringMat: THREE.MeshBasicMaterial };
}

/** One ground texture per street band, so painting stripes only re-uploads that band. */
export interface Ground { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; minZ: number; dirty: boolean }

export interface World {
  scene: THREE.Scene;
  streets: Street[];
  lots: Lot[];
  boxes: AABB[];
  trees: Tree[];
  hedges: Hedge[];
  kind: Uint8Array;
  owner: Int16Array;
  edge: Uint8Array;
  grounds: Ground[];
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  /** The gradient sky dome and its cloud sprites; the dome follows the camera each frame. */
  sky: THREE.Mesh;
  clouds: THREE.Sprite[];
}

export function toWorld(lot: Lot, lx: number, d: number) {
  return lot.side > 0 ? { x: lot.x0 + lx, z: lot.zc + d } : { x: lot.x0 + LOT_W - lx, z: lot.zc - d };
}

export function rectWorld(lot: Lot, r: Rect): AABB {
  const a = toWorld(lot, r[0], r[2]), b = toWorld(lot, r[1], r[3]);
  return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
}

const inRect = (r: Rect, lx: number, d: number, pad = 0) => lx >= r[0] - pad && lx < r[1] + pad && d >= r[2] - pad && d < r[3] + pad;

/** Fill a world-space rectangle on whichever ground textures it covers. */
export function paintRect(w: { grounds: Ground[] }, b: AABB, color: string) {
  for (const g of w.grounds) {
    const z0 = Math.max(b.minZ, g.minZ), z1 = Math.min(b.maxZ, g.minZ + BAND * 2);
    if (z1 <= z0) continue;
    g.ctx.fillStyle = color;
    g.ctx.fillRect(Math.round((b.minX - MIN_X) * PX), Math.round((z0 - g.minZ) * PX), Math.round((b.maxX - b.minX) * PX), Math.round((z1 - z0) * PX));
    g.dirty = true;
  }
}

export function groundFor(w: { grounds: Ground[] }, z: number) {
  return w.grounds[Math.max(0, Math.min(w.grounds.length - 1, Math.floor((z - MIN_Z) / (BAND * 2))))];
}

const WALLS = ['#e9dcc4', '#c9d8e4', '#f1e4a8', '#d9c0b0', '#cfe0c4', '#e8c9c9', '#d6d0e8', '#f2efe8'];
const ROOFS = ['#6b4a3a', '#4a5560', '#7a3b32', '#3f4a3a', '#5a4a6a', '#665544'];
const gardenLeafGeo = new THREE.SphereGeometry(0.3, 9, 7);
const gardenFlowerGeo = new THREE.SphereGeometry(0.085, 8, 6);
const gardenStemGeo = new THREE.CylinderGeometry(0.018, 0.025, 0.34, 5);
const gardenLeafMats = ['#477b36', '#5b8b3e', '#71954a'].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.96, flatShading: true }));
const gardenStemMat = new THREE.MeshStandardMaterial({ color: '#49763a', roughness: 0.95 });
const gardenFlowerMats = ['#f2c75c', '#e989a2', '#f5eee0', '#9c8bd1'].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.78, flatShading: true }));

export function buildWorld(seed = 1): World {
  const rng = makeRng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)];
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fd3f0');
  // a soft blue haze, kept close so the far end of the street melts away
  scene.fog = new THREE.Fog('#a8d8f0', 62, 148);

  const hemi = new THREE.HemisphereLight('#dff1ff', '#4a6b33', 1.25);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff2d6', 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 110;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const { sky, clouds } = buildSky(scene);

  // a dim cool fill from the opposite side so shadowed faces aren't black
  const fill = new THREE.DirectionalLight('#bcd6ff', 0.35);
  fill.position.set(-18, 14, -20);
  scene.add(fill);

  const boxes: AABB[] = [];
  const trees: Tree[] = [];
  const hedges: Hedge[] = [];
  const owners = [...OWNERS].sort(() => rng() - 0.5);
  const streets: Street[] = [];
  const lots: Lot[] = [];

  // ---------------------------------------------------------------- lots
  for (let si = 0; si < STREETS.length; si++) {
    const zc = streetZ(si);
    for (let s = 0; s < 2; s++) for (let i = 0; i < LOTS_PER_SIDE; i++) {
      const side: 1 | -1 = s === 0 ? 1 : -1;
      const hx0 = 3 + rng() * 1.5, hx1 = Math.min(19, hx0 + 12 + rng() * 2.5);
      const garageLeft = rng() < 0.5;
      const garageCx = garageLeft ? hx0 + 2.2 : hx1 - 2.2;
      const doorLx = garageLeft ? hx1 - 3.5 : hx0 + 3.5;
      const beds: Rect[] = [];
      const bedA = garageLeft ? garageCx + 2.4 : hx0 + 0.8, bedB = doorLx - 1.2;
      const bedC = doorLx + 1.2, bedD = garageLeft ? hx1 - 0.8 : garageCx - 2.4;
      if (bedB - bedA > 1) beds.push([bedA, bedB, 16.7, HOUSE_D0]);
      if (bedD - bedC > 1) beds.push([bedC, bedD, 16.7, HOUSE_D0]);
      const lot: Lot = {
        id: lots.length, street: si, zc, side, x0: i * LOT_W,
        number: 100 + i * 20 + (side > 0 ? 2 : 1),
        owner: owners[lots.length % owners.length],
        house: [hx0, hx1, HOUSE_D0, HOUSE_D1],
        drive: [garageCx - 2, garageCx + 2, WALK, HOUSE_D0],
        path: [doorLx - 0.7, doorLx + 0.7, WALK, HOUSE_D0],
        beds, doorLx,
        door: { x: 0, z: 0 }, centre: { x: 0, z: 0 },
        houseBox: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, houseMats: [], houseWire: null, fade: 1,
        lawnCells: [], pavedCells: [], bedCells: [], edgeCells: [], hedges: [], gnomeSpots: [],
      };
      lot.door = toWorld(lot, doorLx, 16.9);
      lot.centre = toWorld(lot, LOT_W / 2, 12);
      lot.houseBox = rectWorld(lot, lot.house);
      lots.push(lot);
    }
  }

  const blockers: { lot: Lot; lx: number; d: number; r: number }[] = [];
  const hedgeMat = new THREE.MeshStandardMaterial({ color: '#335f26', roughness: 0.95, flatShading: true });
  const tuftMat = new THREE.MeshStandardMaterial({ color: '#4c8a33', roughness: 0.9, flatShading: true });
  const tuftGeo = new THREE.IcosahedronGeometry(0.26, 0);
  for (const lot of lots) {
    const g = new THREE.Group();
    if (lot.side > 0) g.position.set(lot.x0, 0, lot.zc);
    else { g.position.set(lot.x0 + LOT_W, 0, lot.zc); g.rotation.y = Math.PI; }
    scene.add(g);
    const house = buildHouse(g, lot, pick(WALLS), pick(ROOFS), rng);
    const tuftSet = new TuftSet(tuftMat);
    addGardenPlanting(g, lot, rng);
    boxes.push(lot.houseBox);

    const mbLx = lot.drive[1] + 0.6;
    addMailbox(g, mbLx, WALK + 0.4);
    blockers.push({ lot, lx: mbLx, d: WALK + 0.4, r: 0.35 });
    boxes.push(rectWorld(lot, [mbLx - 0.2, mbLx + 0.2, WALK + 0.2, WALK + 0.6]));

    // back fence, in picket segments so it reads as timber
    const fenceTex = woodTexture();
    const fenceMat = texMat(fenceTex, '#f6f3ea', 0.9);
    const nP = Math.round(LOT_W / 0.42);
    const pickets: THREE.BufferGeometry[] = [];
    for (let k = 0; k < nP; k++) {
      const b = new THREE.BoxGeometry(0.14, 1.05, 0.06);
      b.translate(0.1 + k * (LOT_W / nP), 0.56, LOT_D1 + 0.12);
      pickets.push(b);
    }
    for (const y of [0.4, 0.95]) {
      const rail = new THREE.BoxGeometry(LOT_W, 0.1, 0.05);
      rail.translate(LOT_W / 2, y, LOT_D1 + 0.09);
      pickets.push(rail);
    }
    const fence = new THREE.Mesh(mergeGeometries(pickets), fenceMat);
    g.add(fence);
    boxes.push(rectWorld(lot, [0, LOT_W, LOT_D1, LOT_D1 + 0.3]));

    // side hedges, in trimmable segments
    for (const hx of [0.3, LOT_W - 0.3]) {
      const n = 6, len = (LOT_D1 - HEDGE_D0) / n;
      for (let k = 0; k < n; k++) {
        const d0 = HEDGE_D0 + k * len;
        const seg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.3, len), hedgeMat);
        seg.position.set(hx, 0.65, d0 + len / 2);
        seg.castShadow = seg.receiveShadow = true;
        const parts: THREE.BufferGeometry[] = [];
        for (let t = 0; t < 5; t++) {
          const b = new THREE.Object3D();
          b.position.set(hx + (rng() - 0.5) * 0.5, 1.2 + rng() * 0.3, d0 + rng() * len);
          b.rotation.set(rng() * 3, rng() * 3, 0);
          b.scale.setScalar(0.8 + rng() * 0.6);
          b.updateMatrix();
          parts.push(tuftGeo.clone().applyMatrix4(b.matrix));
        }
        const tufts = tuftSet.addSection(parts);
        g.add(seg);
        const box = rectWorld(lot, [hx - 0.25, hx + 0.25, d0, d0 + len]);
        boxes.push(box);
        const h: Hedge = { lot: lot.id, box, tufts, shaggy: true, regrow: 0 };
        lot.hedges.push(h);
        hedges.push(h);
      }
    }

    const nTrees = 1 + (rng() < 0.6 ? 1 : 0);
    for (let k = 0, tries = 0; k < nTrees && tries < 40; tries++) {
      const front = rng() < 0.6;
      const lx = front ? 2 + rng() * (LOT_W - 4) : (rng() < 0.5 ? 1.2 + rng() * (lot.house[0] - 2.6) : lot.house[1] + 1.6 + rng() * (LOT_W - lot.house[1] - 3));
      const d = front ? 9 + rng() * 5 : 20.5 + rng() * 6;
      if (inRect(lot.drive, lx, d, 2.2) || inRect(lot.path, lx, d, 2.2) || inRect(lot.house, lx, d, 1.2)) continue;
      if (!front) continue; // keep the side yards clear so mowers (and your crew) can get round the back
      if (blockers.some((b) => b.lot === lot && Math.hypot(b.lx - lx, b.d - d) < 4)) continue;
      const w = toWorld(lot, lx, d);
      trees.push(addTree(scene, w.x, w.z, rng));
      blockers.push({ lot, lx, d, r: 0.45 });
      boxes.push({ minX: w.x - 0.35, maxX: w.x + 0.35, minZ: w.z - 0.35, maxZ: w.z + 0.35 });
      k++;
    }
    if (rng() < 0.7) {
      for (let tries = 0; tries < 20; tries++) {
        const lx = 2 + rng() * (LOT_W - 4), d = 8 + rng() * 7;
        if (inRect(lot.drive, lx, d, 1) || inRect(lot.path, lx, d, 1)) continue;
        if (blockers.some((b) => b.lot === lot && Math.hypot(b.lx - lx, b.d - d) < 2)) continue;
        lot.gnomeSpots.push(toWorld(lot, lx, d));
        break;
      }
    }
    // The yard's static props (fence, hedge segments, mailbox, shrubs) collapse into a few meshes.
    // The house fades on its own and each hedge's tufts get hidden when trimmed, so those stay apart.
    g.add(tuftSet.build());
    batchStatic(g, (o) => o === house || o === tuftSet.mesh);
  }

  // ---------------------------------------------------------------- grid classification
  const kind = new Uint8Array(GW * GH);
  const owner = new Int16Array(GW * GH).fill(-1);
  const edge = new Uint8Array(GW * GH);
  for (let gz = 0; gz < GH; gz++) for (let gx = 0; gx < GW; gx++) {
    const x = MIN_X + (gx + 0.5) * CELL, z = MIN_Z + (gz + 0.5) * CELL;
    if (x < 0 || x >= STREET_END) continue;
    const si = Math.max(0, Math.min(STREETS.length - 1, Math.round(z / (BAND * 2))));
    const zc = streetZ(si), d = Math.abs(z - zc);
    if (d < ROAD || d >= LOT_D1) continue;
    const lot = lots[si * LOTS_PER_SIDE * 2 + (z > zc ? 0 : LOTS_PER_SIDE) + Math.floor(x / LOT_W)];
    const lx = lot.side > 0 ? x - lot.x0 : lot.x0 + LOT_W - x;
    const k = classify(lot, lx, d, blockers);
    if (k === K_NONE) continue;
    const idx = gz * GW + gx;
    kind[idx] = k;
    owner[idx] = lot.id;
    if (k === K_LAWN) lot.lawnCells.push(idx);
    else if (k === K_PAVED) lot.pavedCells.push(idx);
    else lot.bedCells.push(idx);
  }
  for (const lot of lots) for (const c of lot.pavedCells) {
    const gx = c % GW;
    const nb = [gx > 0 ? c - 1 : -1, gx < GW - 1 ? c + 1 : -1, c - GW, c + GW];
    if (nb.some((n) => n >= 0 && n < kind.length && kind[n] === K_LAWN && owner[n] === lot.id)) { edge[c] = 1; lot.edgeCells.push(c); }
  }

  // ---------------------------------------------------------------- ground textures, one per street band
  const grounds: Ground[] = [];
  for (let si = 0; si < STREETS.length; si++) {
    const canvas = document.createElement('canvas');
    canvas.width = (MAX_X - MIN_X) * PX;
    canvas.height = BAND * 2 * PX;
    const ctx = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const minZ = streetZ(si) - BAND;
    grounds.push({ canvas, ctx, tex, minZ, dirty: true });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(MAX_X - MIN_X, BAND * 2),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((MIN_X + MAX_X) / 2, 0, minZ + BAND);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  paintGround({ grounds }, lots, kind, owner, rng);

  // a big grass apron under the whole map so the horizon is turf, not a hard edge
  {
    const gt = grassTexture();
    const apron = new THREE.Mesh(new THREE.PlaneGeometry((MAX_X - MIN_X) * 3, (MAX_Z - MIN_Z) * 3),
      texMat(gt, '#7fae5c', 0.95));
    apron.rotation.x = -Math.PI / 2;
    apron.position.set((MIN_X + MAX_X) / 2, -0.06, (MIN_Z + MAX_Z) / 2);
    apron.receiveShadow = true;
    scene.add(apron);
  }

  // ---------------------------------------------------------------- streets: pumps, barriers, cars, trees
  const carColors = ['#c0392b', '#2e86c1', '#f4f6f7', '#27ae60', '#7d3c98', '#d4ac0d'];
  for (let si = 0; si < STREETS.length; si++) {
    const zc = streetZ(si);
    const pump = { x: PUMP.x, z: zc + PUMP.z };
    if (si > 0) {
      // a little gas station at the west end of the street
      const st = buildGasStation();
      st.position.set(pump.x - 3.2, 0, pump.z);
      batchStatic(st);
      scene.add(st);
      boxes.push({ minX: pump.x - 5, maxX: pump.x - 1.6, minZ: pump.z - 1.2, maxZ: pump.z + 1.2 });
    }
    const ringMat = new THREE.MeshBasicMaterial({ color: '#ffd23a', transparent: true, opacity: 0.6, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.45, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pump.x + 0.2, 0.03, pump.z);
    scene.add(ring);

    // parked cars and streetlamps never move, so each street's set is batched into a few meshes
    const props = new THREE.Group();
    scene.add(props);
    for (let k = 0; k < 3; k++) {
      const x = 14 + k * 24 + rng() * 10, z = zc + (k % 2 ? -1 : 1) * 2.7;
      const car = buildCar(pick(carColors));
      car.position.set(x, 0, z);
      props.add(car);
      boxes.push({ minX: x - 2.1, maxX: x + 2.1, minZ: z - 0.95, maxZ: z + 0.95 });
    }
    for (let k = 0; k < 7; k++) {
      const x = MIN_X + 3 + rng() * 17;
      const z = zc + (rng() < 0.5 ? -1 : 1) * (WALK + 3 + rng() * 22);
      trees.push(addTree(scene, x, z, rng));
      boxes.push({ minX: x - 0.35, maxX: x + 0.35, minZ: z - 0.35, maxZ: z + 0.35 });
    }

    // Repeated warm-toned streetlamps give the neighborhood a clear streetscape silhouette.
    for (let x = MIN_X + 9; x < CROSS_X0 - 2; x += 24) {
      for (const side of [-1, 1] as const) {
        const lamp = buildStreetLight(side);
        lamp.position.set(x, 0, zc + side * 5.15);
        props.add(lamp);
      }
    }
    batchStatic(props);

    let barrier: Street['barrier'] = null;
    if (si > 0) {
      const bz = zc - BAND;
      const objs: THREE.Object3D[] = [];
      // the sawhorses are only ever cleared all at once, so they share one batched group
      const horses = new THREE.Group();
      for (let x = MIN_X + 1; x < MAX_X; x += 2.2) {
        if (x > 1 && x < STREET_END) continue; // the back fences already close this stretch
        const s = buildSawhorse();
        s.position.set(x, 0, bz);
        horses.add(s);
      }
      batchStatic(horses);
      scene.add(horses);
      objs.push(horses);
      const sign = new THREE.Mesh(new THREE.BoxGeometry(6, 1.6, 0.1), new THREE.MeshBasicMaterial({ map: textTexture(`${STREETS[si].name.toUpperCase()} · COMING SOON`, '#1f2a1c', '#ffd23a', 1024, 256, 64) }));
      sign.position.set((CROSS_X0 + CROSS_X1) / 2, 2.1, bz + 0.3);
      scene.add(sign);
      objs.push(sign);
      const box = { minX: MIN_X - 5, maxX: MAX_X + 5, minZ: bz - 0.4, maxZ: bz + 0.4 };
      boxes.push(box);
      barrier = { objs, box };
    }
    streets.push({ id: si, name: STREETS[si].name, zc, unlocked: si === 0, barrier, pump: { ...pump, ring, ringMat } });
  }

  const B = 5;
  boxes.push(
    { minX: MIN_X - B, maxX: MIN_X + 0.5, minZ: MIN_Z - B, maxZ: MAX_Z + B },
    { minX: MAX_X - 0.5, maxX: MAX_X + B, minZ: MIN_Z - B, maxZ: MAX_Z + B },
    { minX: MIN_X - B, maxX: MAX_X + B, minZ: MIN_Z - B, maxZ: MIN_Z + 0.5 },
    { minX: MIN_X - B, maxX: MAX_X + B, minZ: MAX_Z - 0.5, maxZ: MAX_Z + B },
  );

  return { scene, streets, lots, boxes, trees, hedges, kind, owner, edge, grounds, sun, hemi, sky, clouds };
}

function classify(lot: Lot, lx: number, d: number, blockers: { lot: Lot; lx: number; d: number; r: number }[]) {
  if (d < WALK) return K_PAVED;
  if (d >= LOT_D1 - 0.25) return K_NONE;
  if (lx < 0.15 || lx > LOT_W - 0.15) return K_NONE;
  if (d >= HEDGE_D0 && (lx < 0.65 || lx > LOT_W - 0.65)) return K_NONE;
  if (inRect(lot.house, lx, d, 0.15)) return K_NONE;
  if (inRect(lot.drive, lx, d) || inRect(lot.path, lx, d)) return K_PAVED;
  if (lot.beds.some((b) => inRect(b, lx, d))) return K_BED;
  for (const b of blockers) if (b.lot === lot && Math.hypot(b.lx - lx, b.d - d) < b.r) return K_NONE;
  return K_LAWN;
}

// ---------------------------------------------------------------- painting
/**
 * Paint the whole street band into one canvas. Roads, sidewalks, driveways and paths get real
 * surface detail (asphalt grain, paving joints, brick courses) drawn procedurally, then the lots are
 * laid over the top.
 */
function paintGround(w: { grounds: Ground[] }, lots: Lot[], kind: Uint8Array, owner: Int16Array, rng: () => number) {
  const rect = (b: AABB, color: string) => paintRect(w, b, color);
  for (const g of w.grounds) {
    const W = g.canvas.width, H = g.canvas.height;
    g.ctx.fillStyle = '#5c8a3d';
    g.ctx.fillRect(0, 0, W, H);
    // mottled meadow base
    for (let k = 0; k < 2600; k++) {
      g.ctx.fillStyle = `rgba(${rng() < 0.5 ? '40,70,25' : '125,165,85'},${0.06 + rng() * 0.1})`;
      g.ctx.beginPath();
      g.ctx.arc(rng() * W, rng() * H, 3 + rng() * 12, 0, Math.PI * 2);
      g.ctx.fill();
    }
    // fine blade texture over the whole band
    g.ctx.lineWidth = 1;
    for (let k = 0; k < 9000; k++) {
      const x = rng() * W, y = rng() * H, h = 1 + rng() * 3;
      g.ctx.strokeStyle = `rgba(${rng() < 0.5 ? '150,190,110' : '60,95,45'},${0.06 + rng() * 0.14})`;
      g.ctx.beginPath(); g.ctx.moveTo(x, y); g.ctx.lineTo(x + (rng() - 0.5) * 2, y - h); g.ctx.stroke();
    }
  }

  /** Overlay the grain/joints of one surface inside a world rectangle. */
  const detail = (b: AABB, style: 'asphalt' | 'paving' | 'path' | 'wood') => {
    for (const g of w.grounds) {
      const z0 = Math.max(b.minZ, g.minZ), z1 = Math.min(b.maxZ, g.minZ + BAND * 2);
      if (z1 <= z0) continue;
      const ctx = g.ctx;
      const x0 = (b.minX - MIN_X) * PX, x1 = (b.maxX - MIN_X) * PX;
      const y0 = (z0 - g.minZ) * PX, y1 = (z1 - g.minZ) * PX;
      const wpx = x1 - x0, hpx = y1 - y0;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, wpx, hpx);
      ctx.clip();
      if (style === 'asphalt') {
        for (let k = 0; k < wpx * hpx * 0.05; k++) {
          ctx.fillStyle = rng() < 0.5 ? `rgba(25,27,31,${0.3 + rng() * 0.4})` : `rgba(130,133,140,${0.12 + rng() * 0.2})`;
          ctx.fillRect(x0 + rng() * wpx, y0 + rng() * hpx, 1 + rng() * 1.6, 1 + rng() * 1.6);
        }
      } else if (style === 'paving') {
        const cell = 1.1 * PX; // ~1.1 m slabs
        ctx.strokeStyle = 'rgba(105,103,95,0.4)';
        ctx.lineWidth = 1;
        for (let x = x0; x < x1; x += cell) { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); }
        for (let y = y0; y < y1; y += cell) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
        for (let k = 0; k < wpx * hpx * 0.01; k++) {
          ctx.fillStyle = `rgba(${rng() < 0.5 ? '150,148,140' : '220,218,208'},${0.08 + rng() * 0.12})`;
          ctx.fillRect(x0 + rng() * wpx, y0 + rng() * hpx, 2 + rng() * 3, 2 + rng() * 3);
        }
      } else if (style === 'path') {
        const bh = 0.28 * PX, bw = 0.55 * PX;
        ctx.lineWidth = 1;
        for (let row = 0, y = y0; y < y1; y += bh, row++) {
          for (let x = x0 - bw + (row % 2 ? bw / 2 : 0); x < x1; x += bw) {
            ctx.fillStyle = `rgba(${150 + rng() * 40},${105 + rng() * 30},${72 + rng() * 26},0.5)`;
            ctx.fillRect(x + 0.4, y + 0.4, bw - 0.8, bh - 0.8);
          }
        }
      }
      ctx.restore();
      g.dirty = true;
    }
  };

  const lastZ = streetZ(STREETS.length - 1);
  // sidewalks, then roads, then surface detail
  rect({ minX: CROSS_X0 - 2, maxX: CROSS_X1 + 2, minZ: -WALK, maxZ: lastZ + WALK }, '#cdc9bf');
  for (let si = 0; si < STREETS.length; si++) {
    const zc = streetZ(si);
    rect({ minX: MIN_X, maxX: MAX_X, minZ: zc - WALK, maxZ: zc + WALK }, '#cdc9bf');
  }
  for (let si = 0; si < STREETS.length; si++) {
    const zc = streetZ(si);
    rect({ minX: MIN_X, maxX: MAX_X, minZ: zc - ROAD, maxZ: zc + ROAD }, '#3a3c41');
    detail({ minX: MIN_X, maxX: MAX_X, minZ: zc - ROAD, maxZ: zc + ROAD }, 'asphalt');
    // Fine lane-edge paint and a zebra crossing at the neighborhood junction.
    rect({ minX: MIN_X, maxX: CROSS_X0 - 3, minZ: zc - ROAD + 0.28, maxZ: zc - ROAD + 0.36 }, 'rgba(245,244,232,0.72)');
    rect({ minX: MIN_X, maxX: CROSS_X0 - 3, minZ: zc + ROAD - 0.36, maxZ: zc + ROAD - 0.28 }, 'rgba(245,244,232,0.72)');
    for (let x = CROSS_X0 - 3; x < CROSS_X0 - 0.4; x += 0.95) {
      rect({ minX: x, maxX: Math.min(x + 0.48, CROSS_X0 - 0.4), minZ: zc - ROAD + 0.35, maxZ: zc + ROAD - 0.35 }, 'rgba(247,246,235,0.86)');
    }
    // kerb
    rect({ minX: MIN_X, maxX: CROSS_X0, minZ: zc + ROAD, maxZ: zc + ROAD + 0.15 }, '#a8a49a');
    rect({ minX: MIN_X, maxX: CROSS_X0, minZ: zc - ROAD - 0.15, maxZ: zc - ROAD }, '#a8a49a');
    // dashes down the middle
    for (let x = MIN_X + 1; x < CROSS_X0 - 2; x += 4) rect({ minX: x, maxX: x + 2, minZ: zc - 0.08, maxZ: zc + 0.08 }, '#e8c547');
    // sidewalk joints
    for (let x = MIN_X; x < CROSS_X0; x += 2) {
      rect({ minX: x, maxX: x + 0.1, minZ: zc + ROAD, maxZ: zc + WALK }, 'rgba(0,0,0,0.12)');
      rect({ minX: x, maxX: x + 0.1, minZ: zc - WALK, maxZ: zc - ROAD }, 'rgba(0,0,0,0.12)');
    }
    detail({ minX: MIN_X, maxX: CROSS_X0, minZ: zc + ROAD, maxZ: zc + WALK }, 'paving');
    detail({ minX: MIN_X, maxX: CROSS_X0, minZ: zc - WALK, maxZ: zc - ROAD }, 'paving');
  }
  rect({ minX: CROSS_X0, maxX: CROSS_X1, minZ: -ROAD, maxZ: lastZ + ROAD }, '#3a3c41');
  detail({ minX: CROSS_X0, maxX: CROSS_X1, minZ: -ROAD, maxZ: lastZ + ROAD }, 'asphalt');
  for (let z = -ROAD; z < lastZ; z += 4) rect({ minX: (CROSS_X0 + CROSS_X1) / 2 - 0.08, maxX: (CROSS_X0 + CROSS_X1) / 2 + 0.08, minZ: z, maxZ: z + 2 }, '#e8c547');
  // Crosswalk bars on both sides of each cross-street junction.
  for (const street of STREETS) {
    const zc = streetZ(STREETS.indexOf(street));
    for (const direction of [-1, 1]) {
      const z = zc + direction * (ROAD + 0.8);
      for (let x = CROSS_X0 + 0.25; x < CROSS_X1 - 0.1; x += 0.95) {
        rect({ minX: x, maxX: Math.min(x + 0.52, CROSS_X1 - 0.1), minZ: z - 0.22, maxZ: z + 0.22 }, 'rgba(247,246,235,0.86)');
      }
    }
  }

  for (const lot of lots) {
    const dr = rectWorld(lot, lot.drive);
    rect(dr, '#a8a49b');
    detail(dr, 'paving');
    const p = rectWorld(lot, lot.path);
    rect(p, '#c9ab86');
    detail(p, 'path');
    for (let z = p.minZ; z < p.maxZ; z += 0.7) rect({ minX: p.minX, maxX: p.maxX, minZ: z, maxZ: z + 0.1 }, 'rgba(60,40,25,0.14)');
    for (const b of lot.beds) rect(rectWorld(lot, b), '#5b3a22');
  }
  // Cell-level lawn tint gives each yard its own green, with a soft color handoff at shared edges.
  for (const lot of lots) for (const c of lot.lawnCells) {
    const gx = c % GW, gz = Math.floor(c / GW);
    const x = gx * CELL * PX;
    const z = MIN_Z + gz * CELL;
    const tint = grassTintForCell(c, kind, owner);
    for (const g of w.grounds) {
      if (z < g.minZ || z >= g.minZ + BAND * 2) continue;
      g.ctx.fillStyle = tint.getStyle(THREE.SRGBColorSpace);
      g.ctx.globalAlpha = 0.82;
      g.ctx.fillRect(x, (z - g.minZ) * PX, CELL * PX + 0.5, CELL * PX + 0.5);
      g.ctx.globalAlpha = 1;
      g.dirty = true;
      break;
    }
  }
  // Fine, rounded color variation keeps the turf from reading as a grid of flat green tiles.
  for (let i = 0; i < kind.length; i++) {
    if (kind[i] !== K_LAWN || rng() < 0.66) continue;
    const gx = i % GW, gz = Math.floor(i / GW);
    const x = (gx + 0.5 + (rng() - 0.5) * 0.6) * CELL * PX;
    const z = MIN_Z + (gz + 0.5 + (rng() - 0.5) * 0.6) * CELL;
    const g = w.grounds[Math.floor((z - MIN_Z) / (BAND * 2))];
    if (!g) continue;
    const ctx = g.ctx, radius = 0.8 + rng() * 1.8;
    ctx.fillStyle = rng() < 0.72 ? 'rgba(28,58,20,0.10)' : 'rgba(188,205,120,0.12)';
    ctx.beginPath();
    ctx.ellipse(x, (z - g.minZ) * PX, radius, radius * (0.4 + rng() * 0.55), rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Sky: a big inverted sphere with a vertical gradient (deep blue overhead, pale at the horizon),
 * plus a handful of soft cloud sprites. Fog fades the far ground into the horizon colour.
 */
function buildSky(scene: THREE.Scene): { sky: THREE.Mesh; clouds: THREE.Sprite[] } {
  const geo = new THREE.SphereGeometry(165, 28, 18);
  const pos = geo.attributes.position;
  const col: number[] = [];
  const top = new THREE.Color('#5aa6e8'), mid = new THREE.Color('#a8d8f0'), low = new THREE.Color('#dceef8');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = Math.max(0, Math.min(1, (pos.getY(i) / 165 + 0.15) / 1.1));
    if (h < 0.35) c.copy(low).lerp(mid, h / 0.35); else c.copy(mid).lerp(top, (h - 0.35) / 0.65);
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -1000;
  scene.add(sky);

  // clouds: soft blobs on a canvas, scattered high up
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d')!;
  for (let k = 0; k < 26; k++) {
    const x = 40 + Math.random() * 176, y = 50 + Math.random() * 44, r = 18 + Math.random() * 34;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const clouds: THREE.Sprite[] = [];
  for (let k = 0; k < 14; k++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.55 + Math.random() * 0.3, depthWrite: false, fog: false }));
    const a = Math.random() * Math.PI * 2, r = 40 + Math.random() * 95;
    sp.position.set(Math.cos(a) * r, 48 + Math.random() * 40, Math.sin(a) * r);
    const sc = 50 + Math.random() * 70;
    sp.scale.set(sc, sc * 0.5, 1);
    sp.renderOrder = -999;
    scene.add(sp);
    clouds.push(sp);
  }
  return { sky, clouds };
}

// ---------------------------------------------------------------- props
function shadowed<T extends THREE.Object3D>(o: T) {
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  return o;
}

/** A subdued edge trace, revealed only while its model is faded to help preserve its silhouette. */
function addWireOutline(root: THREE.Object3D, color = '#25311f') {
  // starts invisible (material.visible = false skips the draw entirely); fading code turns it on
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, visible: false });
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  for (const mesh of meshes) {
    const edges = new THREE.EdgesGeometry(mesh.geometry, 22);
    const lines = new THREE.LineSegments(edges, material);
    lines.scale.setScalar(1.004);
    lines.renderOrder = 2;
    mesh.add(lines);
  }
  return material;
}

/**
 * A suburban house: textured siding walls, a hipped shingle roof with gable ends, a panelled garage
 * door, a front door with a porch lantern and step, and windows with trim, sills and curtains.
 */
function buildHouse(parent: THREE.Group, lot: Lot, wall: string, roof: string, rng: () => number) {
  const g = new THREE.Group();
  const [x0, x1, d0, d1] = lot.house;
  const w = x1 - x0, depth = d1 - d0, cx = (x0 + x1) / 2, cz = (d0 + d1) / 2;
  const mk = (c: string, opts: THREE.MeshStandardMaterialParameters = {}) => {
    const m = new THREE.MeshStandardMaterial({ color: c, transparent: true, roughness: 0.82, metalness: 0.04, ...opts });
    lot.houseMats.push(m);
    return m;
  };
  const track = (m: THREE.Material) => { lot.houseMats.push(m); return m; };

  // walls: siding texture tinted to the house colour, plus a brick base course
  const wallTex = sidingTexture().clone();
  wallTex.needsUpdate = true;
  wallTex.repeat.set(Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(3.6 / 2.2)));
  const wallMat = track(new THREE.MeshStandardMaterial({ color: wall, map: wallTex, transparent: true, roughness: 0.85, metalness: 0 }));
  const walls = new THREE.Mesh(new THREE.BoxGeometry(w, 3.6, depth), wallMat);
  walls.position.set(cx, 1.8, cz);

  const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.5, depth + 0.08), mk('#8d8478', { roughness: 0.95 }));
  base.position.set(cx, 0.25, cz);

  // roof: a shallow hip made of four sloped faces, textured with shingles
  const shTex = shingleTexture().clone();
  shTex.needsUpdate = true;
  shTex.repeat.set(3, 2);
  const roofMat = track(new THREE.MeshStandardMaterial({ color: roof, map: shTex, transparent: true, roughness: 0.9, metalness: 0.02, flatShading: true }));
  const rise = 2.5, over = 0.5;
  const rw = w / 2 + over, rd = depth / 2 + over;
  const roofGeo = new THREE.BufferGeometry();
  const ridge = 1.5; // length of the ridge along X
  const verts = new Float32Array([
    // front slope
    -rw, 0, rd, rw, 0, rd, ridge, rise, 0,
    -rw, 0, rd, ridge, rise, 0, -ridge, rise, 0,
    // back slope
    rw, 0, -rd, -rw, 0, -rd, -ridge, rise, 0,
    rw, 0, -rd, -ridge, rise, 0, ridge, rise, 0,
    // left hip
    -rw, 0, -rd, -rw, 0, rd, -ridge, rise, 0,
    // right hip
    rw, 0, rd, rw, 0, -rd, ridge, rise, 0,
  ]);
  roofGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  roofGeo.computeVertexNormals();
  const uvs: number[] = [];
  for (let i = 0; i < verts.length / 3; i++) uvs.push((verts[i * 3] + rw) / (rw * 2), (verts[i * 3 + 2] + rd) / (rd * 2));
  roofGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  const roofM = new THREE.Mesh(roofGeo, roofMat);
  roofM.position.set(cx, 3.6, cz);
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(w + over * 2, 0.16, depth + over * 2), mk('#f7f5ef', { roughness: 0.7 }));
  fascia.position.set(cx, 3.62, cz);

  // chimney
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.5, 0.6), mk('#a8735c', { roughness: 0.95 }));
  chimney.position.set(cx + w * 0.22, 4.6, cz - depth * 0.18);

  const gx = (lot.drive[0] + lot.drive[1]) / 2;
  // garage door: panelled texture in a timber frame
  const gTex = garageTexture().clone();
  gTex.needsUpdate = true;
  const garage = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.6, 0.1), track(new THREE.MeshStandardMaterial({ color: '#ffffff', map: gTex, transparent: true, roughness: 0.6, metalness: 0.05 })));
  garage.position.set(gx, 1.3, d0 - 0.06);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(3.7, 2.8, 0.12), mk('#f7f5ef', { roughness: 0.65 }));
  frame.position.set(gx, 1.4, d0 - 0.02);

  // front door, with a little porch lantern over it
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.06, 2.12, 0.12), mk(roof, { roughness: 0.55 }));
  door.position.set(lot.doorLx, 1.08, d0 - 0.07);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), mk('#e0b34a', { metalness: 0.8, roughness: 0.3 }));
  knob.position.set(lot.doorLx + 0.36, 1.05, d0 - 0.15);
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.16), mk('#f7f5ef'));
  lintel.position.set(lot.doorLx, 2.2, d0 - 0.05);
  const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 0.14), track(new THREE.MeshStandardMaterial({ color: '#ffe9a8', emissive: '#ffd27a', emissiveIntensity: 0.9, transparent: true, roughness: 0.3 })));
  lantern.position.set(lot.doorLx + 0.78, 2.05, d0 - 0.14);
  const step = new THREE.Mesh(new THREE.BoxGeometry(2, 0.14, 1), mk('#d7d3c8', { roughness: 0.95 }));
  step.position.set(lot.doorLx, 0.07, d0 - 0.5);
  const step2 = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.1, 1.3), mk('#c9c5ba', { roughness: 0.95 }));
  step2.position.set(lot.doorLx, 0.02, d0 - 0.62);

  g.add(walls, base, roofM, fascia, chimney, frame, garage, door, knob, lintel, lantern, step, step2);

  // windows: white frame, glass, sill, and a curtain behind the glass
  const glass = mk('#9ec9e6', { emissive: '#243444', emissiveIntensity: 0.35, roughness: 0.15, metalness: 0.35 });
  const trim = mk('#f7f5ef', { roughness: 0.6 });
  const curtain = mk('#f0e2c8', { roughness: 0.95, side: THREE.DoubleSide });
  let placed = 0;
  for (let k = 0; k < 8 && placed < 3; k++) {
    const wxp = x0 + 1.4 + rng() * (w - 2.8);
    if (Math.abs(wxp - gx) < 2.6 || Math.abs(wxp - lot.doorLx) < 1.5) continue;
    placed++;
    const ww = 1.25, wh = 1.1;
    const pane = new THREE.Mesh(new THREE.BoxGeometry(ww, wh, 0.08), glass);
    pane.position.set(wxp, 2.15, d0 - 0.07);
    const surround = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.16, wh + 0.16, 0.06), trim);
    surround.position.set(wxp, 2.15, d0 - 0.03);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.28, 0.09, 0.16), trim);
    sill.position.set(wxp, 2.15 - wh / 2 - 0.08, d0 - 0.06);
    const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.05, wh, 0.1), trim);
    mullion.position.set(wxp, 2.15, d0 - 0.08);
    const drapes = new THREE.Mesh(new THREE.PlaneGeometry(ww - 0.1, wh - 0.12), curtain);
    drapes.position.set(wxp, 2.15, d0 - 0.14);
    g.add(pane, surround, sill, mullion, drapes);
  }
  shadowed(g);
  lot.houseWire = addWireOutline(g);
  parent.add(g);
  // ~40 parts become a handful of meshes; the fade then drives the merged materials
  batchStatic(g);
  lot.houseMats = meshMaterials(g);
  // opaque until the player walks behind it (the fade code switches blending on as needed)
  for (const m of lot.houseMats) m.transparent = false;
  return g;
}

/** Small layered shrubs and seasonal flowers bring color to the otherwise flat mulch beds. */
function addGardenPlanting(g: THREE.Group, lot: Lot, rng: () => number) {
  for (const bed of lot.beds) {
    const width = bed[1] - bed[0];
    const count = Math.max(1, Math.floor(width / 1.35));
    for (let i = 0; i < count; i++) {
      const lx = bed[0] + (i + 0.5) * width / count;
      const d = (bed[2] + bed[3]) / 2 + (rng() - 0.5) * 0.24;
      const shrub = new THREE.Group();
      const pieces = 2 + Math.floor(rng() * 2);
      for (let p = 0; p < pieces; p++) {
        const leaf = new THREE.Mesh(gardenLeafGeo, gardenLeafMats[Math.floor(rng() * gardenLeafMats.length)]);
        leaf.position.set((rng() - 0.5) * 0.34, 0.22 + rng() * 0.13, (rng() - 0.5) * 0.25);
        leaf.scale.set(0.8 + rng() * 0.6, 0.65 + rng() * 0.5, 0.8 + rng() * 0.5);
        shrub.add(leaf);
      }
      if (rng() < 0.72) {
        const bloomCount = 2 + Math.floor(rng() * 3);
        for (let b = 0; b < bloomCount; b++) {
          const stem = new THREE.Mesh(gardenStemGeo, gardenStemMat);
          stem.position.set((rng() - 0.5) * 0.38, 0.31, (rng() - 0.5) * 0.28);
          shrub.add(stem);
          const flower = new THREE.Mesh(gardenFlowerGeo, gardenFlowerMats[Math.floor(rng() * gardenFlowerMats.length)]);
          flower.position.copy(stem.position).y += 0.17;
          flower.scale.set(1, 0.72, 1);
          shrub.add(flower);
        }
      }
      shrub.position.set(lx, 0, d);
      shrub.traverse((obj) => { if ((obj as THREE.Mesh).isMesh) { obj.castShadow = true; obj.receiveShadow = true; } });
      g.add(shrub);
    }
  }
}

function buildStreetLight(roadSide: 1 | -1) {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: '#3d4946', roughness: 0.52, metalness: 0.48 });
  const trim = new THREE.MeshStandardMaterial({ color: '#b99b62', roughness: 0.5, metalness: 0.45 });
  const glow = new THREE.MeshStandardMaterial({ color: '#fff0c2', emissive: '#ffc85a', emissiveIntensity: 1.15, roughness: 0.32 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.18, 10), metal);
  base.position.y = 0.09;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.09, 3.35, 9), metal);
  pole.position.y = 1.76;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.12, 10), trim);
  collar.position.y = 3.12;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.82), metal);
  arm.position.set(0, 3.27, -roadSide * 0.36);
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.23, 0.13, 10), metal);
  shade.position.set(0, 3.19, -roadSide * 0.74);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), glow);
  bulb.position.set(0, 3.1, -roadSide * 0.74);
  g.add(base, pole, collar, arm, shade, bulb);
  g.traverse((obj) => { if ((obj as THREE.Mesh).isMesh) { obj.castShadow = true; obj.receiveShadow = true; } });
  return g;
}

function addMailbox(g: THREE.Group, lx: number, d: number) {
  const postM = texMat(woodTexture(), '#6b5136', 0.95);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.1), postM);
  post.position.set(lx, 0.5, d);
  const bodyM = new THREE.MeshStandardMaterial({ color: '#2d3e50', roughness: 0.4, metalness: 0.55 });
  const box = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.28, 4, 10), bodyM);
  box.rotation.z = Math.PI / 2;
  box.position.set(lx, 1.1, d);
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.08), new THREE.MeshStandardMaterial({ color: '#d0352b', roughness: 0.5 }));
  flag.position.set(lx + 0.16, 1.25, d + 0.1);
  g.add(shadowed(post), shadowed(box), flag);
}

/** A tree: a tapered trunk with bark, roots flaring at the base, and a cloud of leafy blobs. */
function addTree(scene: THREE.Scene, x: number, z: number, rng: () => number): Tree {
  const h = 2.8 + rng() * 1.6;
  const root = new THREE.Group();
  root.position.set(x, 0, z);
  const trunkMat = new THREE.MeshStandardMaterial({ color: '#6b4a2e', roughness: 0.95, flatShading: true, transparent: true });
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.34, h, 9), trunkMat);
  trunk.position.set(0, h / 2, 0);
  trunk.rotation.y = rng() * 3;
  // a couple of branches
  const branches: THREE.Mesh[] = [];
  for (let k = 0; k < 3; k++) {
    const a = rng() * Math.PI * 2, bl = 0.9 + rng() * 0.7;
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.11, bl, 6), trunkMat);
    b.position.set(Math.cos(a) * bl * 0.32, h * 0.78 + rng() * 0.6, Math.sin(a) * bl * 0.32);
    b.rotation.set(Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8);
    branches.push(b);
  }
  const hue = 0.26 + rng() * 0.08;
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(hue, 0.42, 0.27 + rng() * 0.07),
    roughness: 0.94, metalness: 0, transparent: true,
  });
  const matDark = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(hue + 0.015, 0.44, 0.18 + rng() * 0.025), roughness: 0.96, metalness: 0, transparent: true,
  });
  const crown = new THREE.Group();
  // darker inner blobs, brighter outer ones, so the canopy has depth
  for (let k = 0; k < 6; k++) {
    const r = 1.15 + rng() * 0.75;
    const inner = k < 3;
    const b = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 9), inner ? matDark : mat);
    const a = (k / 6) * Math.PI * 2 + rng();
    const rad = inner ? 0.35 : 0.85;
    b.position.set(Math.cos(a) * rad, h + 0.5 + rng() * 1.1, Math.sin(a) * rad);
    b.rotation.set(rng() * 3, rng() * 3, 0);
    b.scale.y = 0.82 + rng() * 0.3;
    crown.add(b);
  }
  root.add(shadowed(trunk), ...branches.map((b) => shadowed(b)), shadowed(crown));
  const wire = addWireOutline(root);
  scene.add(root);
  batchStatic(root);
  const mats = meshMaterials<THREE.MeshStandardMaterial>(root);
  for (const m of mats) m.transparent = false;
  return { x, z, mats, wire, fade: 1, h };
}

function buildGasStation() {
  const g = new THREE.Group();
  const booth = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.4, 2), texMat(pavingTexture(), '#e8e4d8', 0.8));
  booth.position.y = 1.2;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.25, 2.4), new THREE.MeshStandardMaterial({ color: '#d0352b', roughness: 0.5 }));
  roof.position.y = 2.5;
  const pumpBody = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.4, 0.6), new THREE.MeshStandardMaterial({ color: '#ffd23a', roughness: 0.45 }));
  pumpBody.position.set(1.4, 0.7, 0);
  const pumpFace = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.02), new THREE.MeshStandardMaterial({ color: '#20262b', roughness: 0.3 }));
  pumpFace.position.set(1.4, 1.0, 0.31);
  const nozzle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 0.06), new THREE.MeshStandardMaterial({ color: '#2b2b2e', roughness: 0.6 }));
  nozzle.position.set(1.72, 0.85, 0.1);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.05), new THREE.MeshBasicMaterial({ map: textTexture('GAS', '#fff', '#d0352b', 256, 96, 70) }));
  sign.position.set(0, 1.6, 1.03);
  g.add(booth, roof, pumpBody, pumpFace, nozzle, sign);
  return shadowed(g);
}

function buildSawhorse() {
  const g = new THREE.Group();
  const board = new THREE.Mesh(new THREE.BoxGeometry(2, 0.35, 0.12), new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.55 }));
  board.position.y = 0.95;
  g.add(board);
  for (const x of [-0.8, 0.8]) for (const z of [-0.25, 0.25]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 0.08), new THREE.MeshStandardMaterial({ color: '#d9d4c8', roughness: 0.8 }));
    leg.position.set(x, 0.5, z);
    leg.rotation.x = z > 0 ? -0.25 : 0.25;
    g.add(leg);
  }
  return shadowed(g);
}

let stripeTex: THREE.CanvasTexture | null = null;
function stripeTexture() {
  if (stripeTex) return stripeTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 32);
  g.fillStyle = '#f07a1a';
  for (let x = -32; x < 160; x += 32) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 16, 32); g.lineTo(x + 32, 0); g.lineTo(x + 16, 0); g.fill(); }
  stripeTex = new THREE.CanvasTexture(c);
  stripeTex.colorSpace = THREE.SRGBColorSpace;
  return stripeTex;
}

/** A parked car: rounded body, cabin with glass all round, wheels with hubs and a little chrome. */
function buildCar(color: string) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0.55 });
  const glassM = new THREE.MeshStandardMaterial({ color: '#9fd0ea', roughness: 0.1, metalness: 0.7 });
  const chrome = new THREE.MeshStandardMaterial({ color: '#d7dade', roughness: 0.25, metalness: 0.9 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(4, 0.8, 1.8), paint);
  body.position.y = 0.7;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.55, 1.7), paint);
  nose.position.set(2.05, 0.62, 0);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.68, 1.75), paint);
  tail.position.set(-2.05, 0.66, 0);
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 1.6), glassM);
  top.position.set(-0.2, 1.4, 0);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 1.55), paint);
  roof.position.set(-0.3, 1.78, 0);
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.18, 1.84), chrome);
  skirt.position.y = 0.4;
  const lights = new THREE.MeshStandardMaterial({ color: '#fff6d8', emissive: '#ffe9a0', emissiveIntensity: 0.8 });
  const tails = new THREE.MeshStandardMaterial({ color: '#e0533f', emissive: '#8a1d12', emissiveIntensity: 0.9 });
  for (const z of [0.62, -0.62]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.32), lights);
    hl.position.set(2.4, 0.72, z);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.34), tails);
    tl.position.set(-2.3, 0.74, z);
    g.add(hl, tl);
  }
  g.add(body, nose, tail, top, roof, skirt);
  for (const [x, z] of [[-1.3, 0.86], [-1.3, -0.86], [1.3, 0.86], [1.3, -0.86]]) {
    const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.25, 16), new THREE.MeshStandardMaterial({ color: '#1d1d1f', roughness: 0.95 }));
    wh.rotation.x = Math.PI / 2;
    wh.position.set(x, 0.36, z);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.27, 10), chrome);
    hub.rotation.x = Math.PI / 2;
    hub.position.copy(wh.position);
    g.add(wh, hub);
  }
  return shadowed(g);
}

/** A canvas texture with centred text, for signs and markers. */
export function textTexture(text: string, fg: string, bg: string | null, w = 128, h = 128, size = 90) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  g.font = `900 ${size}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = fg;
  g.fillText(text, w / 2, h / 2 + size * 0.05);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * All of a lot's hedge tufts in one mesh. Each hedge stretch owns a range of vertices; hiding a
 * stretch rewrites the index buffer to leave its range out, so trimming costs no extra draw calls.
 */
class TuftSet {
  mesh!: THREE.Mesh;
  private parts: THREE.BufferGeometry[] = [];
  private sections: { start: number; count: number; visible: boolean }[] = [];
  private vertices = 0;

  constructor(private material: THREE.Material) {}

  addSection(geos: THREE.BufferGeometry[]): { visible: boolean } {
    const start = this.vertices;
    for (const g of geos) {
      const ng = g.index ? g.toNonIndexed() : g;
      this.parts.push(ng);
      this.vertices += ng.attributes.position.count;
    }
    const sec = { start, count: this.vertices - start, visible: true };
    this.sections.push(sec);
    const set = this;
    return {
      get visible() { return sec.visible; },
      set visible(v: boolean) { if (sec.visible !== v) { sec.visible = v; set.reindex(); } },
    };
  }

  build() {
    const geo = mergeGeometries(this.parts)!;
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(this.vertices), 1));
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    this.reindex();
    return this.mesh;
  }

  private reindex() {
    if (!this.mesh) return;
    const index = this.mesh.geometry.index!, arr = index.array as Uint32Array;
    let n = 0;
    for (const s of this.sections) if (s.visible) for (let i = 0; i < s.count; i++) arr[n++] = s.start + i;
    this.mesh.geometry.setDrawRange(0, n);
    this.mesh.visible = n > 0;
    index.needsUpdate = true;
  }
}

/** Open a street: clear its barrier away. */
export function unlockStreet(w: World, s: Street) {
  s.unlocked = true;
  if (!s.barrier) return;
  for (const o of s.barrier.objs) o.visible = false;
  const i = w.boxes.indexOf(s.barrier.box);
  if (i >= 0) w.boxes.splice(i, 1);
}
