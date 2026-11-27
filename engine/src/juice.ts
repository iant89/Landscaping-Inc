import * as THREE from 'three';
import { clamp } from './math';
import type { Mover } from './physics';

export interface SquashOptions {
  /** Spring stiffness and damping. 170 / 11 is a quick, slightly wobbly jelly. */
  stiffness: number;
  damping: number;
  limit: number;
  /** How much the body widens / stretches per unit of squash. */
  widen: number;
  stretch: number;
  /** Hop gravity, and how much of a landing's speed turns into squash. */
  gravity: number;
  landSquash: number;
}

export const DEFAULT_SQUASH: SquashOptions = {
  stiffness: 170, damping: 11, limit: 0.35, widen: 0.6, stretch: 1.2, gravity: 22, landSquash: 0.6,
};

/**
 * Squash-and-stretch spring plus a little hop. Kick it on impacts (`squash(-5)`) or launch it
 * (`jump(4)`) and it wobbles back to rest on its own.
 */
export class Squash {
  sq = 0;
  sqv = 0;
  hop = 0;
  hopV = 0;
  o: SquashOptions;

  constructor(opts: Partial<SquashOptions> = {}) {
    this.o = { ...DEFAULT_SQUASH, ...opts };
  }

  /** Add velocity to the squash spring: negative squashes flat, positive stretches tall. */
  squash(v: number) { this.sqv += v; }
  jump(v: number) { this.hopV = Math.max(this.hopV, v); }
  reset() { this.sq = this.sqv = this.hop = this.hopV = 0; }

  update(dt: number) {
    const o = this.o;
    this.sqv += (-this.sq * o.stiffness - this.sqv * o.damping) * dt;
    this.sq = clamp(this.sq + this.sqv * dt, -o.limit, o.limit);
    this.hopV -= o.gravity * dt;
    this.hop += this.hopV * dt;
    if (this.hop < 0) {
      if (this.hopV < -3) this.sqv -= this.hopV * o.landSquash;
      this.hop = 0; this.hopV = 0;
    }
  }

  /** Scale `body` by the squash. */
  apply(body: THREE.Object3D) {
    const s = this.sq;
    body.scale.set(1 - s * this.o.widen, 1 + s * this.o.stretch, 1 - s * this.o.widen);
  }
}

/**
 * Pose a typical character: `root` sits at the mover's position (raised by the hop) and turns
 * with its yaw; `body` (a child of root) squashes and leans.
 */
export function poseBody(root: THREE.Object3D, body: THREE.Object3D, m: Mover, sq: Squash) {
  root.position.set(m.x, sq.hop, m.z);
  root.rotation.y = m.yaw;
  sq.apply(body);
  body.rotation.x = m.leanX;
  body.rotation.z = m.leanZ;
}

/** Radial soft blob, handy for glows and sprites. */
export function blobTexture(inner: string, outer: string, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, inner);
  gr.addColorStop(1, outer);
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
