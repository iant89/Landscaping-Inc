import * as THREE from 'three';
import { CELL, MIN_X, MIN_Z, PX, cellX, cellZ } from './config';
import { LAWN_UNCUT, Lot, World } from './world';

const TUFTS_PER_CELL = 2;
const STUBBLE = 0.14;
const STRIPE_LIGHT = ['#8fc862', '#93cc66', '#8ac45e'];
const STRIPE_DARK = ['#62993f', '#5e9a3c', '#66a043'];

/**
 * Every lawn cell holds two instanced grass tufts. Cutting a cell shrinks its tufts to stubble and
 * paints a mow stripe into the ground texture, light or dark depending on which way you drove.
 * Tuft heights live in a per-instance attribute, and a shader patch scales and sways them.
 */
export class Grass {
  mesh: THREE.InstancedMesh;
  /** Per grid cell: first tuft instance, or -1. */
  private slot: Int32Array;
  private h: Float32Array;
  private target: Float32Array;
  private hAttr: THREE.InstancedBufferAttribute;
  private moving = new Set<number>();
  /** Per grid cell: 1 once mown today. */
  cut: Uint8Array;
  readonly time = { value: 0 };
  private dirtyTex = false;

  constructor(private world: World) {
    const cells = world.lots.flatMap((l) => l.lawnCells);
    const n = cells.length * TUFTS_PER_CELL;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.time;
      sh.vertexShader = 'attribute float aH;\nuniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        transformed.y *= aH;
        float ph = uTime * 1.6 + instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.23;
        float sway = (sin(ph) + 0.5 * sin(ph * 2.3)) * 0.05 * position.y * aH;
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
    for (const c of cells) {
      this.slot[c] = k;
      for (let t = 0; t < TUFTS_PER_CELL; t++, k++) {
        p.set(cellX(c) + (Math.random() - 0.5) * CELL * 0.8, 0, cellZ(c) + (Math.random() - 0.5) * CELL * 0.8);
        q.setFromAxisAngle(up, Math.random() * Math.PI * 2);
        const sc = 0.85 + Math.random() * 0.4;
        s.set(sc, sc * (0.85 + Math.random() * 0.35), sc);
        this.mesh.setMatrixAt(k, m.compose(p, q, s));
        col.setHSL(0.24 + Math.random() * 0.06, 0.5 + Math.random() * 0.15, 0.3 + Math.random() * 0.08);
        this.mesh.setColorAt(k, col);
      }
    }
    world.scene.add(this.mesh);
  }

  isCut(cell: number) { return this.cut[cell] === 1; }

  /** Mow one lawn cell. `light` picks the stripe shade. Returns false if it was already cut. */
  cutCell(cell: number, light: boolean) {
    const k = this.slot[cell];
    if (k < 0 || this.cut[cell]) return false;
    this.cut[cell] = 1;
    for (let t = 0; t < TUFTS_PER_CELL; t++) { this.target[k + t] = STUBBLE; this.moving.add(k + t); }
    const shades = light ? STRIPE_LIGHT : STRIPE_DARK;
    const ctx = this.world.ground.ctx;
    ctx.fillStyle = shades[cell % shades.length];
    ctx.fillRect(px(cellX(cell) - CELL / 2), pz(cellZ(cell) - CELL / 2), CELL * PX, CELL * PX);
    this.dirtyTex = true;
    return true;
  }

  /** Overnight: every lawn grows back. */
  regrowAll() {
    const ctx = this.world.ground.ctx;
    ctx.fillStyle = LAWN_UNCUT;
    for (const lot of this.world.lots) for (const c of lot.lawnCells) {
      if (!this.cut[c]) continue;
      this.cut[c] = 0;
      ctx.fillRect(px(cellX(c) - CELL / 2), pz(cellZ(c) - CELL / 2), CELL * PX, CELL * PX);
    }
    this.h.fill(1);
    this.target.fill(1);
    this.moving.clear();
    this.hAttr.needsUpdate = true;
    this.dirtyTex = true;
  }

  cutCount(lot: Lot) { let n = 0; for (const c of lot.lawnCells) n += this.cut[c]; return n; }

  update(dt: number, t: number) {
    this.time.value = t;
    if (this.moving.size) {
      const k = Math.min(1, dt * 16);
      for (const i of this.moving) {
        this.h[i] += (this.target[i] - this.h[i]) * k;
        if (Math.abs(this.h[i] - this.target[i]) < 0.01) { this.h[i] = this.target[i]; this.moving.delete(i); }
      }
      this.hAttr.needsUpdate = true;
    }
  }

  /** Push painted stripes to the GPU (throttled by the caller). */
  flush() {
    if (!this.dirtyTex) return;
    this.dirtyTex = false;
    this.world.ground.tex.needsUpdate = true;
  }
}

const px = (x: number) => Math.round((x - MIN_X) * PX);
const pz = (z: number) => Math.round((z - MIN_Z) * PX);

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

/** One flower per flower-bed cell. Drive over them and they get squashed (and the owner notices). */
export class Flowers {
  mesh: THREE.InstancedMesh;
  private slot = new Map<number, number>();
  private base: THREE.Matrix4[] = [];
  squashed: Uint8Array;

  constructor(world: World) {
    const cells = world.lots.flatMap((l) => l.bedCells);
    const geo = new THREE.IcosahedronGeometry(0.16, 0);
    geo.translate(0, 0.32, 0);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ flatShading: true }), cells.length);
    this.squashed = new Uint8Array(cells.length);
    const palette = ['#ff6fa1', '#ffd23a', '#b48cff', '#ff8c42', '#ffffff', '#ff4d5e'];
    const m = new THREE.Matrix4();
    cells.forEach((c, k) => {
      this.slot.set(c, k);
      m.makeTranslation(cellX(c) + (Math.random() - 0.5) * 0.2, 0, cellZ(c) + (Math.random() - 0.5) * 0.2);
      this.base.push(m.clone());
      this.mesh.setMatrixAt(k, m);
      this.mesh.setColorAt(k, new THREE.Color(palette[Math.floor(Math.random() * palette.length)]));
    });
    this.mesh.castShadow = true;
    world.scene.add(this.mesh);
  }

  /** Squash the flower in this cell; true if it was standing. */
  squash(cell: number) {
    const k = this.slot.get(cell);
    if (k === undefined || this.squashed[k]) return false;
    this.squashed[k] = 1;
    const m = this.base[k].clone().multiply(new THREE.Matrix4().makeScale(1.4, 0.15, 1.4));
    this.mesh.setMatrixAt(k, m);
    this.mesh.setColorAt(k, new THREE.Color('#6b4b2a'));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    return true;
  }

  restoreAll() {
    this.squashed.fill(0);
    this.base.forEach((m, k) => this.mesh.setMatrixAt(k, m));
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export interface Leaf { x: number; z: number; lot: number; alive: boolean; rot: number; tilt: number }

/** Autumn leaves scattered over each lot's sidewalk, driveway and path; the mower's vac sucks them up. */
export class Leaves {
  mesh: THREE.InstancedMesh;
  list: Leaf[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();
  static readonly MAX = 500;

  constructor(world: World) {
    const geo = new THREE.CircleGeometry(0.16, 5);
    geo.scale(1, 0.6, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }), Leaves.MAX);
    const palette = ['#d9622b', '#c0392b', '#e8a23a', '#a0522d', '#d4ac0d'];
    for (let k = 0; k < Leaves.MAX; k++) this.mesh.setColorAt(k, new THREE.Color(palette[k % palette.length]));
    this.mesh.frustumCulled = false;
    world.scene.add(this.mesh);
  }

  /** Scatter a fresh batch of leaves on every lot's paved areas. */
  scatter(world: World, perLot = 30) {
    this.list = [];
    for (const lot of world.lots) {
      const cells = lot.pavedCells;
      const n = Math.min(perLot + Math.floor(Math.random() * 12), Math.floor(Leaves.MAX / world.lots.length));
      for (let k = 0; k < n; k++) {
        const c = cells[Math.floor(Math.random() * cells.length)];
        this.list.push({ x: cellX(c) + (Math.random() - 0.5) * CELL, z: cellZ(c) + (Math.random() - 0.5) * CELL, lot: lot.id, alive: true, rot: Math.random() * 6, tilt: (Math.random() - 0.5) * 0.4 });
      }
    }
  }

  left(lot: number) { let n = 0; for (const l of this.list) if (l.alive && l.lot === lot) n++; return n; }
  total(lot: number) { let n = 0; for (const l of this.list) if (l.lot === lot) n++; return n; }

  sync(t: number) {
    for (let k = 0; k < Leaves.MAX; k++) {
      const l = this.list[k];
      if (!l || !l.alive) { this.mesh.setMatrixAt(k, this.m.makeScale(0, 0, 0)); continue; }
      const flutter = Math.sin(t * 3 + l.rot * 5) * 0.08;
      this.e.set(l.tilt + flutter, l.rot, 0);
      this.q.setFromEuler(this.e);
      this.p.set(l.x, 0.03, l.z);
      this.mesh.setMatrixAt(k, this.m.compose(this.p, this.q, this.s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

