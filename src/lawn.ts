import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BAND, CELL, GH, GW, MIN_X, PX, cellIndex, cellX, cellZ } from './config';
import { Lot, World, paintRect } from './world';
import { grassTintForCell } from './grass-color';
import { grassTexture } from './textures';

const STUBBLE = 0;
let cutTurfMap: THREE.Texture | null = null;

function cutTurfTexture() {
  if (!cutTurfMap) {
    cutTurfMap = new THREE.TextureLoader().load('/textures/cut-turf.jpeg');
    cutTurfMap.colorSpace = THREE.SRGBColorSpace;
    cutTurfMap.wrapS = cutTurfMap.wrapT = THREE.RepeatWrapping;
    cutTurfMap.anisotropy = 8;
  }
  return cutTurfMap;
}

export type CutKind = 'lawn' | 'edge' | null;

/**
 * Lawn cells hold instanced grass tufts; so do "edge" cells (paving along the lawn's border, where
 * grass creeps over). Cutting a lawn cell hides its blades to reveal a smooth, subtly striped turf
 * layer; cutting an edge cell clears the creep entirely. Tuft heights live in a per-instance
 * attribute, scaled and swayed by a shader patch.
 */
export class Grass {
  mesh: THREE.InstancedMesh;
  /** Continuous turf texture under every lawn blade; cut cells lift this layer slightly. */
  private cutTurf: THREE.InstancedMesh;
  /** Fine short-grass surface shown over cells after mowing. */
  private cutSurface: THREE.InstancedMesh;
  private surfaceSlot: Int32Array;
  private surfaceMatrix = new THREE.Matrix4();
  private surfaceColor = new THREE.Color();
  private hiddenSurfaceMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  private slot: Int32Array;
  private h: Float32Array;
  private target: Float32Array;
  private hAttr: THREE.InstancedBufferAttribute;
  private bendData: Float32Array;
  private bendTarget: Float32Array;
  private bendAttr: THREE.InstancedBufferAttribute;
  private instanceYaw: Float32Array;
  private moving = new Set<number>();
  private bending = new Set<number>();
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
      sh.vertexShader = 'attribute float aH;\nattribute vec3 aBend;\nuniform float uTime;\nuniform float uWind;\nvarying float vGrassHeight;\n' + sh.vertexShader.replace('#include <begin_vertex>', `
        vGrassHeight = aH;
        vec3 transformed = vec3(position);
        float lay = position.y * aH * aBend.z;
        transformed.y *= aH * (1.0 - aBend.z * 0.86);
        transformed.x += aBend.x * lay * 1.55;
        transformed.z += aBend.y * lay * 1.55;
        float ph = uTime * (1.6 + uWind * 0.8) + instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.23;
        float sway = (sin(ph) + 0.5 * sin(ph * 2.3) + (uWind - 1.0) * 0.8) * 0.05 * uWind * position.y * aH * (1.0 - aBend.z * 0.75);
        transformed.x += sway; transformed.z += sway * 0.6;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGrassHeight;')
        .replace('#include <color_fragment>', 'if (vGrassHeight < 0.02) discard;\n#include <color_fragment>');
    };
    const geo = tuftGeometry();
    this.h = new Float32Array(n).fill(1);
    this.target = new Float32Array(n).fill(1);
    this.hAttr = new THREE.InstancedBufferAttribute(this.h, 1);
    this.hAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aH', this.hAttr);
    this.bendData = new Float32Array(n * 3);
    this.bendTarget = new Float32Array(n);
    this.instanceYaw = new Float32Array(n);
    this.bendAttr = new THREE.InstancedBufferAttribute(this.bendData, 3);
    this.bendAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aBend', this.bendAttr);
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    const turfGeo = new THREE.PlaneGeometry(CELL, CELL);
    turfGeo.rotateX(-Math.PI / 2);
    const turfMaterial = new THREE.MeshStandardMaterial({ map: cutTurfTexture(), color: '#ffffff', roughness: 1, metalness: 0 });
    turfMaterial.onBeforeCompile = (shader) => {
      // Sample the reference turf in continuous world-space UVs so the image flows across cut cells
      // instead of restarting as a little square texture on every half-metre tile.
      shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xz * 0.55;
        #endif`);
    };
    this.cutTurf = new THREE.InstancedMesh(turfGeo, turfMaterial, lawn.length);
    this.cutTurf.receiveShadow = true;
    this.cutTurf.frustumCulled = false;
    this.cutTurf.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const shortMaterial = new THREE.MeshStandardMaterial({ map: grassTexture(), color: '#ffffff', roughness: 1, metalness: 0 });
    shortMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xz * 0.75;
        #endif`);
    };
    this.cutSurface = new THREE.InstancedMesh(turfGeo, shortMaterial, lawn.length);
    this.cutSurface.receiveShadow = true;
    this.cutSurface.frustumCulled = false;
    this.cutSurface.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.surfaceSlot = new Int32Array(world.kind.length).fill(-1);
    const initialTurf = new THREE.Color('#ffffff'), baseTurfMatrix = new THREE.Matrix4();
    const hiddenSurface = this.hiddenSurfaceMatrix;
    lawn.forEach((cell, i) => {
      this.surfaceSlot[cell] = i;
      this.cutTurf.setMatrixAt(i, baseTurfMatrix.makeTranslation(cellX(cell), 0.008, cellZ(cell)));
      this.cutTurf.setColorAt(i, initialTurf);
      this.cutSurface.setMatrixAt(i, hiddenSurface);
      this.cutSurface.setColorAt(i, initialTurf);
    });
    this.cutTurf.instanceMatrix.needsUpdate = true;
    if (this.cutTurf.instanceColor) this.cutTurf.instanceColor.needsUpdate = true;
    this.cutSurface.instanceMatrix.needsUpdate = true;
    if (this.cutSurface.instanceColor) this.cutSurface.instanceColor.needsUpdate = true;
    this.slot = new Int32Array(world.kind.length).fill(-1);
    this.cut = new Uint8Array(world.kind.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    let k = 0;
    const place = (c: number, edge: boolean) => {
      this.slot[c] = k;
      const tint = grassTintForCell(c, world.kind, world.owner);
      const hsl = tint.getHSL({ h: 0, s: 0, l: 0 });
      for (let t = 0; t < perCell; t++, k++) {
        p.set(cellX(c) + (Math.random() - 0.5) * CELL * 0.8, 0, cellZ(c) + (Math.random() - 0.5) * CELL * 0.8);
        const yaw = Math.random() * Math.PI * 2;
        q.setFromAxisAngle(up, yaw);
        this.instanceYaw[k] = yaw;
        const sc = (edge ? 0.6 : 0.85) + Math.random() * 0.4;
        s.set(sc, sc * (0.85 + Math.random() * 0.35), sc);
        this.mesh.setMatrixAt(k, m.compose(p, q, s));
        col.setHSL(
          hsl.h + (Math.random() - 0.5) * 0.012,
          Math.max(0.38, Math.min(0.72, hsl.s + (Math.random() - 0.5) * 0.1)),
          Math.max(0.22, Math.min(0.48, hsl.l + (Math.random() - 0.5) * 0.08)),
        );
        this.mesh.setColorAt(k, col);
      }
    };
    for (const c of lawn) place(c, false);
    for (const c of edges) place(c, true);
    world.scene.add(this.mesh, this.cutTurf, this.cutSurface);
  }

  isCut(cell: number) { return this.cut[cell] === 1; }

  /** Current average height multiplier for the cell, sampled before a cut changes it. */
  heightAt(cell: number) {
    const first = this.slot[cell];
    if (first < 0) return 0;
    let total = 0;
    for (let i = 0; i < this.perCell; i++) total += this.h[first + i];
    return total / this.perCell;
  }

  private showCutTurf(cell: number, light: boolean) {
    const i = this.surfaceSlot[cell];
    if (i < 0) return;
    this.cutSurface.setMatrixAt(i, this.surfaceMatrix.makeTranslation(cellX(cell), 0.02, cellZ(cell)));
    this.cutSurface.setColorAt(i, this.surfaceColor.set(light ? '#ffffff' : '#d9e8c8'));
    this.cutSurface.instanceMatrix.addUpdateRange(i * 16, 16);
    this.cutSurface.instanceColor?.addUpdateRange(i * 3, 3);
    this.cutSurface.instanceMatrix.needsUpdate = true;
    if (this.cutSurface.instanceColor) this.cutSurface.instanceColor.needsUpdate = true;
  }

  private hideCutTurf(cell: number) {
    const i = this.surfaceSlot[cell];
    if (i < 0) return;
    this.cutSurface.setMatrixAt(i, this.hiddenSurfaceMatrix);
    this.cutSurface.setColorAt(i, this.surfaceColor.set('#ffffff'));
    this.cutSurface.instanceMatrix.addUpdateRange(i * 16, 16);
    this.cutSurface.instanceColor?.addUpdateRange(i * 3, 3);
    this.cutSurface.instanceMatrix.needsUpdate = true;
    if (this.cutSurface.instanceColor) this.cutSurface.instanceColor.needsUpdate = true;
  }

  /** Cut one lawn or edge cell. `light` picks the stripe shade. Returns what was cut, or null. */
  cutCell(cell: number, light: boolean): CutKind {
    const k = this.slot[cell];
    if (k < 0 || this.cut[cell]) return null;
    this.cut[cell] = 1;
    const edge = this.world.edge[cell] === 1;
    for (let t = 0; t < this.perCell; t++) { this.target[k + t] = edge ? 0 : STUBBLE; this.moving.add(k + t); }
    if (edge) return 'edge';
    const turf = grassTintForCell(cell, this.world.kind, this.world.owner);
    turf.lerp(new THREE.Color(light ? '#82aa5e' : '#3d682f'), 0.2);
    this.showCutTurf(cell, light);
    this.paintCell(cell, turf);
    return 'lawn';
  }

  private paintCell(c: number, color: string | THREE.Color) {
    const x = cellX(c) - CELL / 2, z = cellZ(c) - CELL / 2;
    if (typeof color === 'string') {
      paintRect(this.world, { minX: x, maxX: x + CELL, minZ: z, maxZ: z + CELL }, color);
      return;
    }
    for (const g of this.world.grounds) {
      const z0 = Math.max(z, g.minZ), z1 = Math.min(z + CELL, g.minZ + 2 * BAND);
      if (z1 <= z0) continue;
      g.ctx.fillStyle = color.getStyle(THREE.SRGBColorSpace);
      g.ctx.globalAlpha = 0.82;
      g.ctx.fillRect((x - MIN_X) * PX, (z0 - g.minZ) * PX, CELL * PX, (z1 - z0) * PX);
      g.ctx.globalAlpha = 1;
      g.dirty = true;
    }
  }

  /** Push grass over beneath a moving vehicle; the bend eases back upright after it passes. */
  press(x: number, z: number, vx: number, vz: number, radius = 1.2) {
    const speed = Math.hypot(vx, vz);
    const center = cellIndex(x, z);
    if (speed < 0.1 || center < 0) return;
    const gx0 = center % GW, gz0 = Math.floor(center / GW), reach = Math.ceil(radius / CELL);
    const dx = vx / speed, dz = vz / speed;
    let changed = false;
    for (let gz = Math.max(0, gz0 - reach); gz <= Math.min(GH - 1, gz0 + reach); gz++) {
      for (let gx = Math.max(0, gx0 - reach); gx <= Math.min(GW - 1, gx0 + reach); gx++) {
        const c = gz * GW + gx, k0 = this.slot[c];
        if (k0 < 0) continue;
        const d = Math.hypot(cellX(c) - x, cellZ(c) - z);
        if (d > radius) continue;
        const amount = 0.35 + 0.65 * (1 - d / radius);
        for (let t = 0; t < this.perCell; t++) {
          const k = k0 + t, yaw = this.instanceYaw[k], co = Math.cos(yaw), si = Math.sin(yaw), i = k * 3;
          this.bendData[i] = co * dx - si * dz;
          this.bendData[i + 1] = si * dx + co * dz;
          this.bendTarget[k] = Math.max(this.bendTarget[k], amount);
          this.bending.add(k);
        }
        changed = true;
      }
    }
    if (changed) this.bendAttr.needsUpdate = true;
  }

  /**
   * Overnight growth: the whole lot needs cutting again, at grass height `level` (0..1). Short grass
   * keeps yesterday's stripes; long grass hides them.
   */
  growLot(lot: Lot, level: number) {
    const hLawn = Math.max(0.3, level), hEdge = Math.min(1, 0.25 + level);
    for (const c of lot.lawnCells) {
      if (this.cut[c] && level >= 0.5) this.paintCell(c, grassTintForCell(c, this.world.kind, this.world.owner));
      if (this.cut[c]) this.hideCutTurf(c);
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
    if (this.moving.size) {
      const k = Math.min(1, dt * 16);
      for (const i of this.moving) {
        this.h[i] += (this.target[i] - this.h[i]) * k;
        if (Math.abs(this.h[i] - this.target[i]) < 0.01) { this.h[i] = this.target[i]; this.moving.delete(i); }
      }
      this.hAttr.needsUpdate = true;
    }
    if (this.bending.size) {
      const follow = Math.min(1, dt * 12), release = Math.exp(-dt * 1.8);
      for (const i of this.bending) {
        const j = i * 3 + 2;
        this.bendTarget[i] *= release;
        this.bendData[j] += (this.bendTarget[i] - this.bendData[j]) * follow;
        if (this.bendTarget[i] < 0.008 && this.bendData[j] < 0.015) {
          this.bendTarget[i] = this.bendData[j] = 0;
          this.bending.delete(i);
        }
      }
      this.bendAttr.needsUpdate = true;
    }
  }

  /** Push painted stripes to the GPU, one street band at a time (throttled by the caller). */
  flush() {
    for (const g of this.world.grounds) if (g.dirty) { g.dirty = false; g.tex.needsUpdate = true; }
  }
}

/** Eight fine blades fanned around each tuft; varied footprints help the lawn read as continuous. */
function tuftGeometry() {
  const pos: number[] = [], col: number[] = [];
  const vertex = (x: number, y: number, z: number, shade: number) => {
    pos.push(x, y, z);
    col.push(shade * 0.78, shade, shade * 0.68);
  };
  // Narrow, gently curved blades with a tapered tip read more like turf than flat triangular flags.
  for (let b = 0; b < 7; b++) {
    const a = (b / 7) * Math.PI * 2 + Math.random() * 0.65;
    const r = 0.025 + Math.random() * 0.12;
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const h = 0.34 + Math.random() * 0.3;
    const lean = 0.08 + Math.random() * 0.16;
    const sideX = -Math.sin(a), sideZ = Math.cos(a);
    const bend = (Math.random() - 0.5) * 0.07;
    const bx = ox + Math.cos(a) * lean * 0.36 + sideX * bend;
    const bz = oz + Math.sin(a) * lean * 0.36 + sideZ * bend;
    const tx = ox + Math.cos(a) * lean, tz = oz + Math.sin(a) * lean;
    const w0 = 0.014 + Math.random() * 0.008, w1 = w0 * 0.58;
    const p0L: [number, number, number] = [ox - sideX * w0, 0, oz - sideZ * w0];
    const p0R: [number, number, number] = [ox + sideX * w0, 0, oz + sideZ * w0];
    const p1L: [number, number, number] = [bx - sideX * w1, h * 0.56, bz - sideZ * w1];
    const p1R: [number, number, number] = [bx + sideX * w1, h * 0.56, bz + sideZ * w1];
    const tip: [number, number, number] = [tx, h, tz];
    const baseShade = 0.66 + Math.random() * 0.26, tipShade = 0.94 + Math.random() * 0.18;
    // Lower half of the blade, then its tapered upper half. Duplicate vertices keep crisp blade faces.
    vertex(...p0L, baseShade); vertex(...p0R, baseShade); vertex(...p1L, baseShade * 0.9);
    vertex(...p1L, baseShade * 0.9); vertex(...p0R, baseShade); vertex(...p1R, baseShade * 0.9);
    vertex(...p1L, baseShade * 0.9); vertex(...p1R, baseShade * 0.9); vertex(...tip, tipShade);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
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
      // a leaf keeps its lot while it's in the air: blowing it off the driveway isn't the same as
      // clearing it (the vac still has to do that)
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

export interface ClippingSave { x: number; z: number; lot: number; size: number; yaw: number }

interface Clipping extends ClippingSave {
  alive: boolean;
  y: number; vy: number;
  vx: number; vz: number;
}

/**
 * Fresh mower clippings. They fly out of the discharge chute, settle into visible little green
 * piles, and remain until a blower or rake clears them. The mower deck kicks them sideways when
 * driven over, just as it does with loose grass in the yard.
 */
export class Clippings {
  static readonly MAX = 15000;
  static readonly YIELD_MULTIPLIER = 3;
  /** A yard only needs a cleanup pass when the loose clippings have built up into a real mess. */
  static readonly CLEANUP_MIN = 90;
  readonly mesh: THREE.InstancedMesh;
  readonly list: Clipping[] = [];
  private matrix = new THREE.Matrix4();
  private quaternion = new THREE.Quaternion();
  private position = new THREE.Vector3();
  private scale = new THREE.Vector3();
  private palette = ['#85a742', '#a2b957', '#6f9138', '#b1be62'];

  constructor(world: World) {
    this.mesh = new THREE.InstancedMesh(clippingGeometry(), new THREE.MeshStandardMaterial({ color: '#8da84c', roughness: 0.92 }), Clippings.MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    world.scene.add(this.mesh);
  }

  /** Discharge some cut grass to the mower's side. Direction is normalized by the caller. */
  eject(lot: number, x: number, z: number, vx: number, vz: number, amount = 1) {
    if (lot < 0) return;
    for (let n = 0; n < Math.ceil(amount * Clippings.YIELD_MULTIPLIER); n++) {
      const i = this.slot();
      if (i < 0) return;
      const spread = 0.1;
      const clip: Clipping = {
        x: x + (Math.random() - 0.5) * spread, z: z + (Math.random() - 0.5) * spread,
        y: 0.06 + Math.random() * 0.13, vy: 1.1 + Math.random() * 1.1,
        vx: vx + (Math.random() - 0.5) * 0.9, vz: vz + (Math.random() - 0.5) * 0.9,
        lot, alive: true, size: 0.48 + Math.random() * 0.36, yaw: Math.random() * Math.PI * 2,
      };
      this.list[i] = clip;
      this.mesh.setColorAt(i, new THREE.Color(this.palette[Math.floor(Math.random() * this.palette.length)]));
      this.mesh.count = Math.max(this.mesh.count, i + 1);
      this.write(i, clip);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Push a resting pile out through the mower's side-discharge path. */
  mowerPass(x: number, z: number, yaw: number, speed: number, radius = 1.1) {
    if (speed < 0.15) return;
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    for (const c of this.list) {
      if (!c.alive || Math.hypot(c.x - x, c.z - z) > radius) continue;
      const strength = 1 - Math.hypot(c.x - x, c.z - z) / radius;
      c.vx = rx * (1.2 + speed * 0.16) + fx * 0.25 + (Math.random() - 0.5) * 0.45;
      c.vz = rz * (1.2 + speed * 0.16) + fz * 0.25 + (Math.random() - 0.5) * 0.45;
      c.vy = Math.max(c.vy, 0.45 + strength * 1.1);
      c.y = Math.max(c.y, 0.035);
    }
  }

  /** Blow clippings forward in a cone and clear them from the yard. */
  blow(x: number, z: number, fx: number, fz: number, length: number, width: number) {
    let removed = 0;
    for (const c of this.list) {
      if (!c.alive) continue;
      const dx = c.x - x, dz = c.z - z;
      const along = dx * fx + dz * fz;
      const across = Math.abs(dx * fz - dz * fx);
      if (along < -0.25 || along > length || across > width) continue;
      c.alive = false;
      removed++;
    }
    return removed;
  }

  /** Rake a small patch into a bag / off the lawn. */
  rake(x: number, z: number, radius: number) {
    let removed = 0;
    for (const c of this.list) {
      if (!c.alive || Math.hypot(c.x - x, c.z - z) > radius) continue;
      c.alive = false;
      removed++;
    }
    return removed;
  }

  nearest(x: number, z: number, radius: number) {
    let best: { x: number; z: number } | null = null, distance = radius;
    for (const c of this.list) {
      if (!c.alive) continue;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < distance) { distance = d; best = { x: c.x, z: c.z }; }
    }
    return best;
  }

  left(lot: number) { let n = 0; for (const c of this.list) if (c.alive && c.lot === lot) n++; return n; }

  clearLot(lot: number) { for (const c of this.list) if (c.alive && c.lot === lot) c.alive = false; }
  clearAll() { for (const c of this.list) c.alive = false; }

  save(): ClippingSave[] {
    return this.list.filter((c) => c.alive).map(({ x, z, lot, size, yaw }) => ({ x, z, lot, size, yaw }));
  }

  restore(saved: ClippingSave[]) {
    this.clearAll();
    for (const c of saved.slice(0, Clippings.MAX)) {
      const i = this.slot();
      if (i < 0) break;
      const clip: Clipping = { ...c, alive: true, y: 0.015, vy: 0, vx: 0, vz: 0 };
      this.list[i] = clip;
      this.mesh.setColorAt(i, new THREE.Color(this.palette[Math.floor(Math.random() * this.palette.length)]));
      this.mesh.count = Math.max(this.mesh.count, i + 1);
      this.write(i, clip);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    const drag = Math.exp(-3.5 * dt);
    for (let i = 0; i < this.mesh.count; i++) {
      const c = this.list[i];
      if (!c?.alive) { this.mesh.setMatrixAt(i, this.matrix.makeScale(0, 0, 0)); continue; }
      if (c.y > 0.015 || Math.abs(c.vy) > 0.02) {
        c.x += c.vx * dt; c.z += c.vz * dt;
        c.vx *= drag; c.vz *= drag;
        c.vy -= 7.5 * dt; c.y += c.vy * dt;
        if (c.y <= 0.015) {
          c.y = 0.015;
          c.vy = -c.vy * 0.12;
          if (c.vy < 0.18) { c.vy = 0; c.vx *= 0.25; c.vz *= 0.25; }
        }
      }
      this.write(i, c);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private slot() {
    const dead = this.list.findIndex((c) => !c.alive);
    if (dead >= 0) return dead;
    return this.list.length < Clippings.MAX ? this.list.length : -1;
  }

  private write(i: number, c: Clipping) {
    this.position.set(c.x, c.y, c.z);
    this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.yaw);
    this.scale.set(c.size, c.size, c.size);
    this.mesh.setMatrixAt(i, this.matrix.compose(this.position, this.quaternion, this.scale));
  }
}

/** A small low pile of freshly cut blades, laid flat so many pieces read as a mound. */
function clippingGeometry() {
  const positions: number[] = [], colors: number[] = [], normals: number[] = [];
  for (let blade = 0; blade < 9; blade++) {
    const a = blade / 9 * Math.PI * 2 + Math.random() * 0.5;
    const r = (Math.random() - 0.5) * 0.04;
    const x = Math.cos(a), z = Math.sin(a), w = 0.005 + Math.random() * 0.004, len = 0.055 + Math.random() * 0.045;
    const wx = -z * w, wz = x * w;
    const bx = x * r, bz = z * r, tx = bx + x * len, tz = bz + z * len;
    positions.push(bx - wx, 0.004, bz - wz, bx + wx, 0.004, bz + wz, tx, 0.012 + Math.random() * 0.01, tz);
    const shade = 0.75 + Math.random() * 0.4;
    colors.push(shade, shade, shade, shade, shade, shade, shade * 1.1, shade * 1.1, shade * 1.1);
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geo;
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
