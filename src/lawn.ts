import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CELL, cellX, cellZ } from './config';
import { LAWN_UNCUT, Lot, World, paintRect } from './world';

const STUBBLE = 0.14;
const STRIPE_LIGHT = ['rgba(143,200,98,0.78)', 'rgba(147,204,102,0.78)', 'rgba(138,196,94,0.78)'];
const STRIPE_DARK = ['rgba(98,153,63,0.82)', 'rgba(94,154,60,0.82)', 'rgba(102,160,67,0.82)'];

export type CutKind = 'lawn' | 'edge' | null;

/**
 * Lawn cells hold instanced grass tufts; so do "edge" cells (paving along the lawn's border, where
 * grass creeps over). Cutting a lawn cell shrinks it to stubble and paints a mow stripe, light or
 * dark by direction of travel; cutting an edge cell clears the creep entirely. Tuft heights live in
 * a per-instance attribute, scaled and swayed by a shader patch.
 */
export class Grass {
  mesh: THREE.InstancedMesh;
  private slot: Int32Array;
  private h: Float32Array;
  private target: Float32Array;
  private hAttr: THREE.InstancedBufferAttribute;
  private moving = new Set<number>();
  cut: Uint8Array;
  readonly time = { value: 0 };
  readonly wind = { value: 1 };

  constructor(private world: World, private perCell = 2) {
    const lawn = world.lots.flatMap((l) => l.lawnCells);
    const edges = world.lots.flatMap((l) => l.edgeCells);
    const n = (lawn.length + edges.length) * perCell;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.time;
      sh.uniforms.uWind = this.wind;
      sh.vertexShader = 'attribute float aH;\nuniform float uTime;\nuniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        transformed.y *= aH;
        float ph = uTime * (1.6 + uWind * 0.8) + instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.23;
        float sway = (sin(ph) + 0.5 * sin(ph * 2.3) + (uWind - 1.0) * 0.8) * 0.05 * uWind * position.y * aH;
        transformed.x += sway; transformed.z += sway * 0.6;`);
    };
    const geo = tuftGeometry();
    this.h = new Float32Array(n).fill(1);
    this.target = new Float32Array(n).fill(1);
    this.hAttr = new THREE.InstancedBufferAttribute(this.h, 1);
    this.hAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aH', this.hAttr);
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.slot = new Int32Array(world.kind.length).fill(-1);
    this.cut = new Uint8Array(world.kind.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    let k = 0;
    const place = (c: number, edge: boolean) => {
      this.slot[c] = k;
      for (let t = 0; t < perCell; t++, k++) {
        p.set(cellX(c) + (Math.random() - 0.5) * CELL * 0.8, 0, cellZ(c) + (Math.random() - 0.5) * CELL * 0.8);
        q.setFromAxisAngle(up, Math.random() * Math.PI * 2);
        const sc = (edge ? 0.6 : 0.85) + Math.random() * 0.4;
        s.set(sc, sc * (0.85 + Math.random() * 0.35), sc);
        this.mesh.setMatrixAt(k, m.compose(p, q, s));
        col.setHSL(0.24 + Math.random() * 0.06, 0.5 + Math.random() * 0.15, 0.3 + Math.random() * 0.08);
        this.mesh.setColorAt(k, col);
      }
    };
    for (const c of lawn) place(c, false);
    for (const c of edges) place(c, true);
    world.scene.add(this.mesh);
  }

  isCut(cell: number) { return this.cut[cell] === 1; }

  /** Cut one lawn or edge cell. `light` picks the stripe shade. Returns what was cut, or null. */
  cutCell(cell: number, light: boolean): CutKind {
    const k = this.slot[cell];
    if (k < 0 || this.cut[cell]) return null;
    this.cut[cell] = 1;
    const edge = this.world.edge[cell] === 1;
    for (let t = 0; t < this.perCell; t++) { this.target[k + t] = edge ? 0 : STUBBLE; this.moving.add(k + t); }
    if (edge) return 'edge';
    const shades = light ? STRIPE_LIGHT : STRIPE_DARK;
    this.paintCell(cell, shades[cell % shades.length]);
    return 'lawn';
  }

  private paintCell(c: number, color: string) {
    const x = cellX(c) - CELL / 2, z = cellZ(c) - CELL / 2;
    paintRect(this.world, { minX: x, maxX: x + CELL, minZ: z, maxZ: z + CELL }, color);
  }

  /**
   * Overnight growth: the whole lot needs cutting again, at grass height `level` (0..1). Short grass
   * keeps yesterday's stripes; long grass hides them.
   */
  growLot(lot: Lot, level: number) {
    const hLawn = Math.max(0.3, level), hEdge = Math.min(1, 0.25 + level);
    for (const c of lot.lawnCells) {
      if (this.cut[c] && level >= 0.5) this.paintCell(c, LAWN_UNCUT);
      this.cut[c] = 0;
      this.setCell(c, hLawn);
    }
    for (const c of lot.edgeCells) { this.cut[c] = 0; this.setCell(c, hEdge); }
    this.hAttr.needsUpdate = true;
  }

  private setCell(c: number, h: number) {
    const k = this.slot[c];
    for (let t = 0; t < this.perCell; t++) { this.h[k + t] = this.target[k + t] = h; this.moving.delete(k + t); }
  }

  count(cells: number[]) { let n = 0; for (const c of cells) n += this.cut[c]; return n; }

  update(dt: number, t: number) {
    this.time.value = t;
    if (!this.moving.size) return;
    const k = Math.min(1, dt * 16);
    for (const i of this.moving) {
      this.h[i] += (this.target[i] - this.h[i]) * k;
      if (Math.abs(this.h[i] - this.target[i]) < 0.01) { this.h[i] = this.target[i]; this.moving.delete(i); }
    }
    this.hAttr.needsUpdate = true;
  }

  /** Push painted stripes to the GPU, one street band at a time (throttled by the caller). */
  flush() {
    for (const g of this.world.grounds) if (g.dirty) { g.dirty = false; g.tex.needsUpdate = true; }
  }
}

/** Five thin blades fanned around the origin; normals all point up so the grass lights evenly. */
function tuftGeometry() {
  const pos: number[] = [], col: number[] = [], nrm: number[] = [];
  for (let b = 0; b < 5; b++) {
    const a = (b / 5) * Math.PI * 2 + Math.random() * 0.6;
    const r = 0.05 + Math.random() * 0.09;
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const w = 0.055, h = 0.36 + Math.random() * 0.18, lean = 0.1;
    const wx = -Math.sin(a) * w, wz = Math.cos(a) * w;
    pos.push(ox - wx, 0, oz - wz, ox + wx, 0, oz + wz, ox + Math.cos(a) * lean, h, oz + Math.sin(a) * lean);
    col.push(0.5, 0.55, 0.45, 0.5, 0.55, 0.45, 1.25, 1.25, 1.1);
    nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/** One flower cluster per flower-bed cell. Drive over them and they get squashed (and the owner notices). */
export class Flowers {
  mesh: THREE.InstancedMesh;
  private slot = new Map<number, number>();
  private base: THREE.Matrix4[] = [];
  private colors: THREE.Color[] = [];
  squashed: Uint8Array;

  constructor(world: World) {
    const cells = world.lots.flatMap((l) => l.bedCells);
    const geo = flowerGeometry();
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0 }), cells.length);
    this.squashed = new Uint8Array(cells.length);
    const palette = ['#ff6fa1', '#ffd23a', '#b48cff', '#ff8c42', '#fff6f0', '#ff4d5e', '#7ec8ff'];
    const m = new THREE.Matrix4();
    cells.forEach((c, k) => {
      this.slot.set(c, k);
      m.makeTranslation(cellX(c) + (Math.random() - 0.5) * 0.2, 0, cellZ(c) + (Math.random() - 0.5) * 0.2);
      m.multiply(new THREE.Matrix4().makeRotationY(Math.random() * Math.PI * 2));
      const sc = 0.85 + Math.random() * 0.4;
      m.multiply(new THREE.Matrix4().makeScale(sc, sc, sc));
      this.base.push(m.clone());
      this.mesh.setMatrixAt(k, m);
      const col2 = new THREE.Color(palette[Math.floor(Math.random() * palette.length)]);
      this.colors.push(col2);
      this.mesh.setColorAt(k, col2);
    });
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    world.scene.add(this.mesh);
  }

  squash(cell: number) {
    const k = this.slot.get(cell);
    if (k === undefined || this.squashed[k]) return false;
    this.squashed[k] = 1;
    this.mesh.setMatrixAt(k, this.base[k].clone().multiply(new THREE.Matrix4().makeScale(1.4, 0.15, 1.4)));
    this.mesh.setColorAt(k, new THREE.Color('#6b8a3a'));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    return true;
  }

  restoreAll() {
    this.squashed.fill(0);
    this.base.forEach((m, k) => { this.mesh.setMatrixAt(k, m); this.mesh.setColorAt(k, this.colors[k]); });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/**
 * A little cluster: green stems and leaves with three blossoms on top, built once and merged so the
 * whole flower bed is a single instanced draw. The blossom vertices are white so the per-instance
 * colour tints only the petals; the stems keep a low vertex colour so they stay green.
 */
function flowerGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const tint = (src: THREE.BufferGeometry, stem: boolean) => {
    // mergeGeometries needs every part to be indexed or every part non-indexed; primitives mix both
    const g = src.index ? src.toNonIndexed() : src;
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      if (stem) { col[i * 3] = 0.24; col[i * 3 + 1] = 0.45; col[i * 3 + 2] = 0.16; }
      else { col[i * 3] = 1; col[i * 3 + 1] = 0.92; col[i * 3 + 2] = 0.95; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI * 2 + 0.4;
    const ox = Math.cos(a) * 0.1, oz = Math.sin(a) * 0.1;
    const h = 0.24 + b * 0.035;
    const stem = new THREE.CylinderGeometry(0.008, 0.012, h, 4);
    stem.translate(ox, h / 2, oz);
    parts.push(tint(stem, true));
    // two little leaves on the stem
    for (const side of [-1, 1]) {
      const leaf = new THREE.SphereGeometry(0.045, 5, 3);
      leaf.scale(1.6, 0.22, 0.8);
      leaf.translate(ox + side * 0.05, h * 0.45, oz);
      parts.push(tint(leaf, true));
    }
    const head = new THREE.IcosahedronGeometry(0.085, 0);
    head.scale(1, 0.55, 1);
    head.translate(ox, h, oz);
    parts.push(tint(head, false));
    const core = new THREE.SphereGeometry(0.032, 6, 4);
    core.translate(ox, h + 0.03, oz);
    parts.push(tint(core, false));
  }
  return mergeGeometries(parts);
}

export interface Leaf {
  x: number; z: number; lot: number; alive: boolean;
  /** Height above the ground, and its vertical speed (positive = going up). */
  y: number; vy: number;
  /** Horizontal speed, which the wind and bounces push around. */
  vx: number; vz: number;
  /** Tumble: current yaw / pitch-and-roll and how fast each is changing. */
  rot: number; spin: number; tumble: number; tumbleV: number;
  /** Seconds until the ground grabs it again; > 0 means it is airborne and ignoring the floor. */
  air: number;
  /** A leaf still fluttering down from a tree. */
  fall: number;
}

const GRAVITY = 9.5;

/**
 * Autumn leaves on each lot's sidewalk, driveway and path. They are little physics bodies: wind
 * lifts them into the air, they tumble, they get knocked up by the mower's deck, and they drift back
 * down to land somewhere new. The mower's vac sucks them up.
 */
export class Leaves {
  mesh: THREE.InstancedMesh;
  list: Leaf[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();
  static readonly MAX = 2400;
  /** Called when a leaf is airborne at (x, z) — used for little gusts of dust. */
  onLift: ((x: number, z: number) => void) | null = null;

  constructor(world: World) {
    const geo = leafGeometry();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
    this.mesh = new THREE.InstancedMesh(geo, mat, Leaves.MAX);
    const palette = ['#d9622b', '#c0392b', '#e8a23a', '#a0522d', '#d4ac0d', '#b8461f'];
    for (let k = 0; k < Leaves.MAX; k++) this.mesh.setColorAt(k, new THREE.Color(palette[k % palette.length]));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    world.scene.add(this.mesh);
  }

  /** Scatter a fresh batch of leaves; `perLot(lot)` says how many on each. */
  scatter(world: World, perLot: (lot: Lot) => number) {
    this.list = [];
    for (const lot of world.lots) for (let k = perLot(lot); k > 0; k--) this.drop(lot, false);
  }

  /** One more leaf on a lot (wind blows them in during the day; they flutter down). */
  drop(lot: Lot, falling = true) {
    if (this.list.length >= Leaves.MAX) {
      const i = this.list.findIndex((l) => !l.alive);
      if (i < 0) return;
      this.list.splice(i, 1);
    }
    const c = lot.pavedCells[Math.floor(Math.random() * lot.pavedCells.length)];
    const f = falling ? 3 + Math.random() * 3 : 0;
    this.list.push({
      x: cellX(c) + (Math.random() - 0.5) * CELL, z: cellZ(c) + (Math.random() - 0.5) * CELL, lot: lot.id, alive: true,
      y: falling ? 5 + Math.random() * 2.5 : 0, vy: 0, vx: (Math.random() - 0.5) * 0.6, vz: (Math.random() - 0.5) * 0.6,
      rot: Math.random() * 6, spin: (Math.random() - 0.5) * 3, tumble: Math.random() * 6, tumbleV: (Math.random() - 0.5) * 3,
      air: 0, fall: f,
    });
  }

  left(lot: number) { let n = 0; for (const l of this.list) if (l.alive && l.lot === lot) n++; return n; }

  /** Kick the leaves in a disc into the air (the mower's deck blast, a gust, a bump). */
  gust(cx: number, cz: number, R: number, up: number, out: number, only = -1) {
    let n = 0;
    for (const l of this.list) {
      if (!l.alive) continue;
      if (only >= 0 && l.lot !== only) continue;
      const dx = l.x - cx, dz = l.z - cz, d = Math.hypot(dx, dz);
      if (d > R) continue;
      const f = 1 - d / R;
      const a = d > 0.01 ? Math.atan2(dz, dx) : Math.random() * Math.PI * 2;
      l.vx += Math.cos(a) * out * f + (Math.random() - 0.5) * out * 0.4;
      l.vz += Math.sin(a) * out * f + (Math.random() - 0.5) * out * 0.4;
      l.vy = Math.max(l.vy, up * (0.35 + Math.random() * 0.65) * (0.4 + f));
      l.spin += (Math.random() - 0.5) * 10;
      l.tumbleV += (Math.random() - 0.5) * 12;
      l.air = 0.22;
      l.lot = -1; // airborne leaves belong to nobody until they land again
      n++;
    }
    return n;
  }

  update(dt: number, t: number, wind: number, onLand?: (l: Leaf) => void) {
    const drag = Math.exp(-1.5 * dt);
    for (let k = 0; k < Leaves.MAX; k++) {
      const l = this.list[k];
      if (!l || !l.alive) { this.mesh.setMatrixAt(k, this.m.makeScale(0, 0, 0)); continue; }
      const airborne = l.y > 0.001 || l.vy > 0;
      if (airborne) {
        if (l.air > 0) l.air = Math.max(0, l.air - dt);
        l.vy -= GRAVITY * dt;
        // wind pushes horizontally, a little air resistance slows the fall
        l.vx += (wind * 1.5 - l.vx) * Math.min(1, dt * 0.9);
        l.vz += (Math.sin(t * 0.5 + l.rot) * wind * 0.7 - l.vz) * Math.min(1, dt * 0.9);
        if (l.vy < -2.4) l.vy = -2.4 + (l.vy + 2.4) * drag * 0.3;
        l.x += l.vx * dt; l.z += l.vz * dt; l.y += l.vy * dt;
        l.rot += l.spin * dt;
        l.tumble += l.tumbleV * dt;
        l.vx *= Math.exp(-0.8 * dt); l.vz *= Math.exp(-0.8 * dt);
        l.spin *= Math.exp(-1.2 * dt); l.tumbleV *= Math.exp(-1.2 * dt);
        if (l.y <= 0) {
          const land = l.air <= 0 && l.vy < -1.2;
          l.y = 0;
          if (land) {
            // settle flat on the ground with a little hop
            l.vy = -l.vy * 0.28;
            if (l.vy < 0.6) { l.vy = 0; l.tumble = 0; l.tumbleV *= 0.2; l.spin *= 0.3; }
            onLand?.(l);
          } else if (l.air <= 0) l.vy = 0;
        }
      } else if (l.fall > 0) {
        // still fluttering down from its tree
        l.fall = Math.max(0, l.fall - dt * 2.2);
        l.x += dt * wind * 0.8; l.z += dt * Math.sin(t * 0.7 + l.rot) * 0.35;
        l.rot += dt * 3;
      }
      const wobble = l.y > 0.01 ? Math.sin(t * 6 + l.rot) * 0.5 : 0;
      this.e.set(l.y > 0.01 ? l.tumble : 0, l.rot, wobble);
      this.q.setFromEuler(this.e);
      this.p.set(l.x, 0.012 + l.y, l.z);
      this.mesh.setMatrixAt(k, this.m.compose(this.p, this.q, this.s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** A maple-ish leaf: five thin lobes fanned around a stem, with a warm rim so it reads at a glance. */
function leafGeometry() {
  const shape = new THREE.Shape();
  const lobes = 5;
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const lobe = 0.55 + 0.45 * Math.abs(Math.cos((a * lobes) / 2));
    const r = 0.17 * lobe;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  const g = new THREE.ShapeGeometry(shape, 2);
  g.rotateX(-Math.PI / 2);
  // colour the rim slightly brighter so leaves catch the light
  const pos = g.attributes.position;
  const col: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const d = Math.hypot(pos.getX(i), pos.getZ(i)) / 0.17;
    const k = 0.75 + Math.min(1, d) * 0.5;
    col.push(k, k * 0.96, k * 0.9);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
