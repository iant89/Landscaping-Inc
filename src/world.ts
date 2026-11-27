import * as THREE from 'three';
import { AABB, makeRng } from '../engine/src';
import {
  CELL, GH, GW, HOUSE_D0, HOUSE_D1, K_BED, K_LAWN, K_NONE, K_PAVED, LOT_D1, LOT_W, LOTS_PER_SIDE, MAX_X, MAX_Z,
  MIN_X, MIN_Z, OWNERS, PUMP, PX, ROAD, STREET_END, WALK,
} from './config';

type Rect = [number, number, number, number]; // lx0, lx1, d0, d1 in lot-local coordinates

/**
 * A house plot. Lot-local coordinates: lx runs along the street (0..LOT_W), d is the distance from
 * the road's centre line (the house front faces the road). North-side lots are rotated 180°.
 */
export interface Lot {
  id: number;
  side: 1 | -1;
  x0: number;
  number: number;
  owner: string;
  house: Rect;
  drive: Rect;
  path: Rect;
  beds: Rect[];
  doorLx: number;
  /** Knock spot in front of the door (world). */
  door: { x: number; z: number };
  /** Middle of the front lawn (world), for markers and the minimap. */
  centre: { x: number; z: number };
  /** World-space bounds of the house, for fading it when it hides the mower. */
  houseBox: AABB;
  houseMats: THREE.Material[];
  fade: number;
  lawnCells: number[];
  pavedCells: number[];
  bedCells: number[];
  gnomeSpots: { x: number; z: number }[];
}

export interface Tree { x: number; z: number; mat: THREE.MeshLambertMaterial; fade: number; h: number }

export interface World {
  scene: THREE.Scene;
  lots: Lot[];
  boxes: AABB[];
  trees: Tree[];
  /** Per grid cell: K_* kind and owning lot (-1 for none). */
  kind: Uint8Array;
  owner: Int16Array;
  ground: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  pump: { ring: THREE.Mesh; ringMat: THREE.MeshBasicMaterial };
}

export const LAWN_UNCUT = '#3d6a2a';

export function toWorld(lot: Lot, lx: number, d: number) {
  return lot.side > 0 ? { x: lot.x0 + lx, z: d } : { x: lot.x0 + LOT_W - lx, z: -d };
}

export function rectWorld(lot: Lot, r: Rect): AABB {
  const a = toWorld(lot, r[0], r[2]), b = toWorld(lot, r[1], r[3]);
  return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
}

const inRect = (r: Rect, lx: number, d: number, pad = 0) => lx >= r[0] - pad && lx < r[1] + pad && d >= r[2] - pad && d < r[3] + pad;

const WALLS = ['#e9dcc4', '#c9d8e4', '#f1e4a8', '#d9c0b0', '#cfe0c4', '#e8c9c9', '#d6d0e8', '#f2efe8'];
const ROOFS = ['#6b4a3a', '#4a5560', '#7a3b32', '#3f4a3a', '#5a4a6a', '#665544'];

export function buildWorld(seed = 1): World {
  const rng = makeRng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)];
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fd3f0');
  scene.fog = new THREE.Fog('#9fd3f0', 50, 110);

  const hemi = new THREE.HemisphereLight('#dff1ff', '#55703a', 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff4dc', 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -28; sc.right = 28; sc.top = 28; sc.bottom = -28; sc.near = 1; sc.far = 90;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const boxes: AABB[] = [];
  const trees: Tree[] = [];
  const owners = [...OWNERS].sort(() => rng() - 0.5);

  // ---------------------------------------------------------------- lots
  const lots: Lot[] = [];
  for (let s = 0; s < 2; s++) for (let i = 0; i < LOTS_PER_SIDE; i++) {
    const side: 1 | -1 = s === 0 ? 1 : -1;
    const hx0 = 3 + rng() * 1.5, hx1 = Math.min(19, hx0 + 12 + rng() * 2.5);
    const garageLeft = rng() < 0.5;
    const garageCx = garageLeft ? hx0 + 2.2 : hx1 - 2.2;
    const doorLx = garageLeft ? hx1 - 3.5 : hx0 + 3.5;
    const beds: Rect[] = [];
    const bedA = garageLeft ? garageCx + 2.4 : hx0 + 0.8, bedB = garageLeft ? doorLx - 1.2 : doorLx - 1.2;
    const bedC = doorLx + 1.2, bedD = garageLeft ? hx1 - 0.8 : garageCx - 2.4;
    if (bedB - bedA > 1) beds.push([bedA, bedB, 16.7, HOUSE_D0]);
    if (bedD - bedC > 1) beds.push([bedC, bedD, 16.7, HOUSE_D0]);
    const lot: Lot = {
      id: lots.length, side, x0: i * LOT_W,
      number: 100 + i * 20 + (side > 0 ? 2 : 1),
      owner: owners[lots.length % owners.length],
      house: [hx0, hx1, HOUSE_D0, HOUSE_D1],
      drive: [garageCx - 2, garageCx + 2, WALK, HOUSE_D0],
      path: [doorLx - 0.7, doorLx + 0.7, WALK, HOUSE_D0],
      beds, doorLx,
      door: { x: 0, z: 0 }, centre: { x: 0, z: 0 },
      houseBox: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, houseMats: [], fade: 1,
      lawnCells: [], pavedCells: [], bedCells: [], gnomeSpots: [],
    };
    lot.door = toWorld(lot, doorLx, 16.9);
    lot.centre = toWorld(lot, LOT_W / 2, 12);
    lot.houseBox = rectWorld(lot, lot.house);
    lots.push(lot);
  }

  // obstacles per lot, in local coords, so the grass classification can skip them
  const blockers: { lot: Lot; lx: number; d: number; r: number }[] = [];
  const lotGroups: THREE.Group[] = [];
  for (const lot of lots) {
    const g = new THREE.Group();
    if (lot.side > 0) g.position.set(lot.x0, 0, 0);
    else { g.position.set(lot.x0 + LOT_W, 0, 0); g.rotation.y = Math.PI; }
    scene.add(g);
    lotGroups.push(g);
    buildHouse(g, lot, pick(WALLS), pick(ROOFS), rng);
    boxes.push(lot.houseBox);

    // mailbox by the end of the driveway
    const mbLx = lot.drive[1] + 0.6;
    addMailbox(g, mbLx, WALK + 0.4);
    blockers.push({ lot, lx: mbLx, d: WALK + 0.4, r: 0.35 });
    boxes.push(rectWorld(lot, [mbLx - 0.2, mbLx + 0.2, WALK + 0.2, WALK + 0.6]));

    // back fence and side hedges
    const fence = new THREE.Mesh(new THREE.BoxGeometry(LOT_W, 1.2, 0.25), new THREE.MeshLambertMaterial({ color: '#f4f1ea' }));
    fence.position.set(LOT_W / 2, 0.6, LOT_D1 + 0.12);
    fence.castShadow = true;
    g.add(fence);
    boxes.push(rectWorld(lot, [0, LOT_W, LOT_D1, LOT_D1 + 0.3]));
    for (const hx of [0.15, LOT_W - 0.15]) {
      const hedge = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.4, LOT_D1 - 19), new THREE.MeshLambertMaterial({ color: '#2f5a25' }));
      hedge.position.set(hx, 0.7, (19 + LOT_D1) / 2);
      hedge.castShadow = true;
      g.add(hedge);
      boxes.push(rectWorld(lot, [hx - 0.15, hx + 0.15, 19, LOT_D1]));
    }

    // trees: one or two, in the front lawn or a side yard
    const nTrees = 1 + (rng() < 0.6 ? 1 : 0);
    for (let k = 0, tries = 0; k < nTrees && tries < 40; tries++) {
      const front = rng() < 0.6;
      const lx = front ? 2 + rng() * (LOT_W - 4) : (rng() < 0.5 ? 0.6 + rng() * (lot.house[0] - 2.2) : lot.house[1] + 1.6 + rng() * (LOT_W - lot.house[1] - 2.4));
      const d = front ? 9 + rng() * 5 : 20 + rng() * 7;
      if (inRect(lot.drive, lx, d, 2.2) || inRect(lot.path, lx, d, 2.2) || inRect(lot.house, lx, d, 1.2)) continue;
      if (blockers.some((b) => b.lot === lot && Math.hypot(b.lx - lx, b.d - d) < 4)) continue;
      const w = toWorld(lot, lx, d);
      trees.push(addTree(scene, w.x, w.z, rng));
      blockers.push({ lot, lx, d, r: 0.45 });
      boxes.push({ minX: w.x - 0.35, maxX: w.x + 0.35, minZ: w.z - 0.35, maxZ: w.z + 0.35 });
      k++;
    }
    // gnome spots in the front lawn
    if (rng() < 0.7) {
      for (let tries = 0; tries < 20; tries++) {
        const lx = 2 + rng() * (LOT_W - 4), d = 8 + rng() * 7;
        if (inRect(lot.drive, lx, d, 1) || inRect(lot.path, lx, d, 1)) continue;
        if (blockers.some((b) => b.lot === lot && Math.hypot(b.lx - lx, b.d - d) < 2)) continue;
        lot.gnomeSpots.push(toWorld(lot, lx, d));
        break;
      }
    }
  }

  // ---------------------------------------------------------------- grid classification
  const kind = new Uint8Array(GW * GH);
  const owner = new Int16Array(GW * GH).fill(-1);
  for (let gz = 0; gz < GH; gz++) for (let gx = 0; gx < GW; gx++) {
    const x = MIN_X + (gx + 0.5) * CELL, z = MIN_Z + (gz + 0.5) * CELL;
    const d = Math.abs(z);
    if (x < 0 || x >= STREET_END || d < ROAD || d >= LOT_D1) continue;
    const lot = lots[(z > 0 ? 0 : LOTS_PER_SIDE) + Math.floor(x / LOT_W)];
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

  // ---------------------------------------------------------------- ground texture
  const canvas = document.createElement('canvas');
  canvas.width = (MAX_X - MIN_X) * PX;
  canvas.height = (MAX_Z - MIN_Z) * PX;
  const ctx = canvas.getContext('2d')!;
  paintGround(ctx, lots, kind, rng);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAX_X - MIN_X, MAX_Z - MIN_Z), new THREE.MeshLambertMaterial({ map: tex }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((MIN_X + MAX_X) / 2, 0, (MIN_Z + MAX_Z) / 2);
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------------------------------------------------------------- street furniture
  // your truck and trailer at the west end of the street
  const truck = buildTruck();
  truck.position.set(PUMP.x - 6.5, 0, PUMP.z);
  scene.add(truck);
  boxes.push({ minX: PUMP.x - 13.5, maxX: PUMP.x - 2.2, minZ: PUMP.z - 1.15, maxZ: PUMP.z + 1.15 });
  const ringMat = new THREE.MeshBasicMaterial({ color: '#ffd23a', transparent: true, opacity: 0.6, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.45, 40), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(PUMP.x + 0.2, 0.03, PUMP.z);
  scene.add(ring);

  // parked cars on the road, clear of the truck
  const carColors = ['#c0392b', '#2e86c1', '#f4f6f7', '#27ae60', '#7d3c98', '#d4ac0d'];
  for (let k = 0; k < 3; k++) {
    const x = 14 + k * 26 + rng() * 10, z = (k % 2 ? -1 : 1) * 2.7;
    const car = buildCar(pick(carColors));
    car.position.set(x, 0, z);
    scene.add(car);
    boxes.push({ minX: x - 2.1, maxX: x + 2.1, minZ: z - 0.95, maxZ: z + 0.95 });
  }
  // trees on the open grass at each end of the street
  for (let k = 0; k < 14; k++) {
    const west = k < 7;
    const x = west ? MIN_X + 3 + rng() * 18 : STREET_END + 2 + rng() * 7;
    const z = (rng() < 0.5 ? -1 : 1) * (WALK + 3 + rng() * 24);
    trees.push(addTree(scene, x, z, rng));
    boxes.push({ minX: x - 0.35, maxX: x + 0.35, minZ: z - 0.35, maxZ: z + 0.35 });
  }
  // world bounds
  const B = 5;
  boxes.push(
    { minX: MIN_X - B, maxX: MIN_X + 0.5, minZ: MIN_Z - B, maxZ: MAX_Z + B },
    { minX: MAX_X - 0.5, maxX: MAX_X + B, minZ: MIN_Z - B, maxZ: MAX_Z + B },
    { minX: MIN_X - B, maxX: MAX_X + B, minZ: MIN_Z - B, maxZ: MIN_Z + 0.5 },
    { minX: MIN_X - B, maxX: MAX_X + B, minZ: MAX_Z - 0.5, maxZ: MAX_Z + B },
  );

  return { scene, lots, boxes, trees, kind, owner, ground: { canvas, ctx, tex }, sun, hemi, pump: { ring, ringMat } };
}

function classify(lot: Lot, lx: number, d: number, blockers: { lot: Lot; lx: number; d: number; r: number }[]) {
  if (d < WALK) return K_PAVED; // the lot's stretch of sidewalk
  if (d >= LOT_D1 - 0.25) return K_NONE;
  if (lx < 0.15 || lx > LOT_W - 0.15) return K_NONE;
  if (d >= 19 && (lx < 0.35 || lx > LOT_W - 0.35)) return K_NONE; // hedges
  if (inRect(lot.house, lx, d, 0.15)) return K_NONE;
  if (inRect(lot.drive, lx, d) || inRect(lot.path, lx, d)) return K_PAVED;
  if (lot.beds.some((b) => inRect(b, lx, d))) return K_BED;
  for (const b of blockers) if (b.lot === lot && Math.hypot(b.lx - lx, b.d - d) < b.r) return K_NONE;
  return K_LAWN;
}

// ---------------------------------------------------------------- painting
function paintGround(ctx: CanvasRenderingContext2D, lots: Lot[], kind: Uint8Array, rng: () => number) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const wx = (x: number) => (x - MIN_X) * PX, wz = (z: number) => (z - MIN_Z) * PX;
  const rect = (b: AABB, color: string) => { ctx.fillStyle = color; ctx.fillRect(wx(b.minX), wz(b.minZ), (b.maxX - b.minX) * PX, (b.maxZ - b.minZ) * PX); };

  // open grass with mottling
  ctx.fillStyle = '#5c8a3d';
  ctx.fillRect(0, 0, W, H);
  for (let k = 0; k < 2500; k++) {
    ctx.fillStyle = `rgba(${rng() < 0.5 ? '40,70,25' : '120,160,80'},${0.08 + rng() * 0.1})`;
    ctx.beginPath();
    ctx.arc(rng() * W, rng() * H, 3 + rng() * 14, 0, Math.PI * 2);
    ctx.fill();
  }
  // road with curb, lane dashes
  rect({ minX: MIN_X, maxX: MAX_X, minZ: -ROAD, maxZ: ROAD }, '#3a3c41');
  for (let k = 0; k < 900; k++) {
    ctx.fillStyle = `rgba(255,255,255,${rng() * 0.05})`;
    ctx.fillRect(rng() * W, wz(-ROAD) + rng() * ROAD * 2 * PX, 2, 2);
  }
  ctx.fillStyle = '#e8c547';
  for (let x = MIN_X + 1; x < MAX_X; x += 4) ctx.fillRect(wx(x), wz(-0.08), 2 * PX, 0.16 * PX);
  for (const s of [-1, 1]) {
    rect({ minX: MIN_X, maxX: MAX_X, minZ: s > 0 ? ROAD : -WALK, maxZ: s > 0 ? WALK : -ROAD }, '#cdc9bf');
    rect({ minX: MIN_X, maxX: MAX_X, minZ: s > 0 ? ROAD : -ROAD - 0.15, maxZ: s > 0 ? ROAD + 0.15 : -ROAD }, '#9d998f');
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = MIN_X; x < MAX_X; x += 2) ctx.fillRect(wx(x), wz(s > 0 ? ROAD : -WALK), 1, 2 * PX);
  }
  // each lot: tall lawn, driveway, path, beds
  for (const lot of lots) {
    rect(rectWorld(lot, [0, LOT_W, WALK, LOT_D1]), LAWN_UNCUT);
    rect(rectWorld(lot, lot.drive), '#a8a49b');
    rect(rectWorld(lot, lot.path), '#c9ab86');
    const p = rectWorld(lot, lot.path);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    for (let z = p.minZ; z < p.maxZ; z += 0.7) ctx.fillRect(wx(p.minX), wz(z), (p.maxX - p.minX) * PX, 1);
    for (const b of lot.beds) rect(rectWorld(lot, b), '#5b3a22');
  }
  // speckle the uncut lawn so it doesn't read as flat paint between the tufts
  for (let i = 0; i < kind.length; i++) {
    if (kind[i] !== K_LAWN || rng() < 0.6) continue;
    ctx.fillStyle = rng() < 0.5 ? '#355f24' : '#477a30';
    const x = MIN_X + (i % GW) * CELL, z = MIN_Z + Math.floor(i / GW) * CELL;
    ctx.fillRect(wx(x) + rng() * 3, wz(z) + rng() * 3, 2, 2);
  }
}

// ---------------------------------------------------------------- props
const lam = (color: string) => new THREE.MeshLambertMaterial({ color });

function shadowed<T extends THREE.Object3D>(o: T) {
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  return o;
}

function buildHouse(g: THREE.Group, lot: Lot, wall: string, roof: string, rng: () => number) {
  const [x0, x1, d0, d1] = lot.house;
  const w = x1 - x0, depth = d1 - d0, cx = (x0 + x1) / 2, cz = (d0 + d1) / 2;
  const mk = (c: string, opts: THREE.MeshLambertMaterialParameters = {}) => {
    const m = new THREE.MeshLambertMaterial({ color: c, transparent: true, ...opts });
    lot.houseMats.push(m);
    return m;
  };
  const walls = new THREE.Mesh(new THREE.BoxGeometry(w, 3.6, depth), mk(wall));
  walls.position.set(cx, 1.8, cz);
  const roofGeo = new THREE.ConeGeometry(1, 1, 4);
  roofGeo.rotateY(Math.PI / 4);
  const roofM = new THREE.Mesh(roofGeo, mk(roof));
  roofM.scale.set((w / Math.SQRT2) * 1.12, 2.6, (depth / Math.SQRT2) * 1.12);
  roofM.position.set(cx, 3.6 + 1.3, cz);
  const trim = mk('#f7f5ef');
  const gx = (lot.drive[0] + lot.drive[1]) / 2;
  const garage = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.6, 0.12), trim);
  garage.position.set(gx, 1.3, d0 - 0.06);
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.15, 0.14), mk(roof));
  door.position.set(lot.doorLx, 1.08, d0 - 0.07);
  const step = new THREE.Mesh(new THREE.BoxGeometry(2, 0.14, 1), trim);
  step.position.set(lot.doorLx, 0.07, d0 - 0.5);
  g.add(walls, roofM, garage, door, step);
  const glass = mk('#a9d4ef', { emissive: '#203040' });
  for (let k = 0; k < 4; k++) {
    const wxp = x0 + 1.4 + rng() * (w - 2.8);
    if (Math.abs(wxp - gx) < 2.4 || Math.abs(wxp - lot.doorLx) < 1.4) continue;
    const win = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.1, 0.12), glass);
    win.position.set(wxp, 2.1, d0 - 0.06);
    g.add(win);
  }
  shadowed(g);
}

function addMailbox(g: THREE.Group, lx: number, d: number) {
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.1), lam('#6b5136'));
  post.position.set(lx, 0.5, d);
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.5), lam('#2d3e50'));
  box.position.set(lx, 1.1, d);
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.08), lam('#d0352b'));
  flag.position.set(lx + 0.16, 1.25, d + 0.1);
  g.add(shadowed(post), shadowed(box), flag);
}

function addTree(scene: THREE.Scene, x: number, z: number, rng: () => number): Tree {
  const h = 2.6 + rng() * 1.4;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, h, 8), lam('#6b4a2e'));
  trunk.position.set(x, h / 2, z);
  const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(0.27 + rng() * 0.07, 0.45, 0.28 + rng() * 0.08), transparent: true, flatShading: true });
  const crown = new THREE.Group();
  for (let k = 0; k < 3; k++) {
    const r = 1.3 + rng() * 0.7;
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), mat);
    b.position.set((rng() - 0.5) * 1.4, h + 0.6 + rng() * 1, (rng() - 0.5) * 1.4);
    b.rotation.set(rng() * 3, rng() * 3, 0);
    crown.add(b);
  }
  crown.position.set(x, 0, z);
  scene.add(shadowed(trunk), shadowed(crown));
  return { x, z, mat, fade: 1, h };
}

function buildTruck() {
  const g = new THREE.Group();
  const body = lam('#1f6f43');
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.7, 2), body);
  cab.position.set(-3.2, 1.25, 0);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 2), body);
  hood.position.set(-4.9, 0.9, 0);
  const bed = new THREE.Mesh(new THREE.BoxGeometry(3, 0.9, 2), body);
  bed.position.set(-0.6, 0.85, 0);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.7, 1.7), lam('#a9d4ef'));
  glass.position.set(-4.25, 1.55, 0);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(2, 0.6, 0.05), new THREE.MeshBasicMaterial({ map: textTexture('LANDSCAPING INC.', '#ffd23a', '#1f6f43', 512, 128, 52) }));
  sign.position.set(-3.2, 1.35, 1.03);
  const sign2 = sign.clone();
  sign2.position.z = -1.03;
  sign2.rotation.y = Math.PI;
  // trailer with a fuel can rack
  const trailer = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.25, 2), lam('#555b61'));
  trailer.position.set(2.8, 0.6, 0);
  const can = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.35), lam('#d0352b'));
  can.position.set(3.8, 1.07, 0.5);
  const can2 = can.clone();
  can2.position.z = -0.5;
  g.add(cab, hood, bed, glass, sign, sign2, trailer, can, can2);
  for (const [x, z] of [[-4.5, 1], [-4.5, -1], [-1, 1], [-1, -1], [2.8, 1], [2.8, -1]]) {
    const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 14), lam('#1d1d1f'));
    wh.rotation.x = Math.PI / 2;
    wh.position.set(x, 0.42, z);
    g.add(wh);
  }
  return shadowed(g);
}

function buildCar(color: string) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(4, 0.8, 1.8), lam(color));
  body.position.y = 0.7;
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 1.6), lam('#a9d4ef'));
  top.position.set(-0.2, 1.4, 0);
  g.add(body, top);
  for (const [x, z] of [[-1.3, 0.85], [-1.3, -0.85], [1.3, 0.85], [1.3, -0.85]]) {
    const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.25, 12), lam('#1d1d1f'));
    wh.rotation.x = Math.PI / 2;
    wh.position.set(x, 0.36, z);
    g.add(wh);
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

