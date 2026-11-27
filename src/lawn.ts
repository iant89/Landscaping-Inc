import * as THREE from 'three';
import { CELL, cellX, cellZ } from './config';
import { LAWN_UNCUT, Lot, World, paintRect } from './world';

const STUBBLE = 0.14;
const STRIPE_LIGHT = ['#8fc862', '#93cc66', '#8ac45e'];
const STRIPE_DARK = ['#62993f', '#5e9a3c', '#66a043'];

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
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
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

/** One flower per flower-bed cell. Drive over them and they get squashed (and the owner notices). */
export class Flowers {
  mesh: THREE.InstancedMesh;
  private slot = new Map<number, number>();
  private base: THREE.Matrix4[] = [];
  private colors: THREE.Color[] = [];
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
      const col = new THREE.Color(palette[Math.floor(Math.random() * palette.length)]);
      this.colors.push(col);
      this.mesh.setColorAt(k, col);
    });
    this.mesh.castShadow = true;
    world.scene.add(this.mesh);
  }

  squash(cell: number) {
    const k = this.slot.get(cell);
    if (k === undefined || this.squashed[k]) return false;
    this.squashed[k] = 1;
    this.mesh.setMatrixAt(k, this.base[k].clone().multiply(new THREE.Matrix4().makeScale(1.4, 0.15, 1.4)));
    this.mesh.setColorAt(k, new THREE.Color('#6b4b2a'));
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

export interface Leaf { x: number; z: number; lot: number; alive: boolean; rot: number; tilt: number; fall: number }

/** Autumn leaves on each lot's sidewalk, driveway and path; the mower's vac sucks them up. */
export class Leaves {
  mesh: THREE.InstancedMesh;
  list: Leaf[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();
  static readonly MAX = 2400;

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
    this.list.push({ x: cellX(c) + (Math.random() - 0.5) * CELL, z: cellZ(c) + (Math.random() - 0.5) * CELL, lot: lot.id, alive: true, rot: Math.random() * 6, tilt: (Math.random() - 0.5) * 0.4, fall: falling ? 4 + Math.random() * 3 : 0 });
  }

  left(lot: number) { let n = 0; for (const l of this.list) if (l.alive && l.lot === lot) n++; return n; }

  update(dt: number, t: number, wind: number) {
    for (let k = 0; k < Leaves.MAX; k++) {
      const l = this.list[k];
      if (!l || !l.alive) { this.mesh.setMatrixAt(k, this.m.makeScale(0, 0, 0)); continue; }
      if (l.fall > 0) { l.fall = Math.max(0, l.fall - dt * 2.2); l.x += dt * wind * 0.8; l.rot += dt * 3; }
      const flutter = Math.sin(t * 3 + l.rot * 5) * (0.08 + (wind - 1) * 0.1);
      this.e.set(l.tilt + flutter, l.rot, l.fall > 0 ? Math.sin(t * 6 + l.rot) * 0.8 : 0);
      this.q.setFromEuler(this.e);
      this.p.set(l.x, 0.03 + l.fall, l.z);
      this.mesh.setMatrixAt(k, this.m.compose(this.p, this.q, this.s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
