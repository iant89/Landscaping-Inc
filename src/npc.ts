import * as THREE from 'three';
import { CollisionWorld, Mover, Squash, poseBody } from '../engine/src';
import { CROSS_MID, HEDGE_D0, LOT_D1, LOT_W, streetAt, streetZ } from './config';
import { MowerColors, MowerModel, animateMower, buildMower } from './mower';
import { Lot, toWorld } from './world';

/** A point to drive to; `mow` is the lot whose lawn gets cut on the way to this point. */
export interface Wp { x: number; z: number; mow?: number }

/**
 * A computer-driven mower (your crew, or the rival). It uses the same Mover as the player, so it has
 * the same eased, leaning, bouncing feel, and steers at each waypoint in turn. If it can't make
 * progress (a tree in the way), it gives up on that waypoint and moves on.
 */
export class Npc {
  mover = new Mover({ radius: 0.8, maxSpeed: 4.4, accel: 8, decel: 6, turnRate: 8 });
  squash = new Squash({ stiffness: 150, damping: 10 });
  model: MowerModel;
  plan: Wp[] = [];
  idx = 0;
  private best = Infinity;
  private stuckT = 0;
  private onDone: (() => void) | null = null;
  running = false;

  constructor(scene: THREE.Scene, colors: MowerColors, x: number, z: number) {
    this.model = buildMower(colors);
    scene.add(this.model.root);
    this.mover.place(x, z, Math.PI / 2);
    poseBody(this.model.root, this.model.body, this.mover, this.squash);
  }

  get busy() { return this.idx < this.plan.length; }
  /** Lot being mown on the current leg, or -1. */
  get mowLot() { return this.busy ? this.plan[this.idx].mow ?? -1 : -1; }

  go(plan: Wp[], onDone?: () => void) {
    this.plan = plan;
    this.idx = 0;
    this.best = Infinity;
    this.stuckT = 0;
    this.onDone = onDone ?? null;
    this.running = true;
  }

  stop() { this.plan = []; this.idx = 0; this.onDone = null; }

  place(x: number, z: number) { this.stop(); this.mover.place(x, z, Math.PI / 2); }

  update(dt: number, world: CollisionWorld, t: number) {
    const m = this.mover;
    if (this.busy) {
      const wp = this.plan[this.idx];
      const dx = wp.x - m.x, dz = wp.z - m.z, d = Math.hypot(dx, dz);
      const last = this.idx === this.plan.length - 1;
      if (d < (last ? 0.5 : 0.75)) this.next();
      else {
        if (d < this.best - 0.2) { this.best = d; this.stuckT = 0; } else this.stuckT += dt;
        if (this.stuckT > 1.4) this.next();
        // ease off for sharp turns and the final stop
        const slow = last && d < 2 ? 0.45 : wp.mow !== undefined ? 0.85 : 1;
        const hit = m.update(dt, dx / d, dz / d, slow, world);
        if (hit.impact > 2.5) this.squash.squash(-3);
      }
    } else {
      m.update(dt, 0, 0, 0, world);
    }
    this.squash.update(dt);
    poseBody(this.model.root, this.model.body, m, this.squash);
    animateMower(this.model, m.yaw, m.vx, m.vz, dt, t, this.running);
  }

  private next() {
    this.idx++;
    this.best = Infinity;
    this.stuckT = 0;
    if (!this.busy) { const cb = this.onDone; this.onDone = null; cb?.(); }
  }
}

/** Point on a lot's driveway at local depth d. */
const driveAt = (lot: Lot, d: number) => toWorld(lot, (lot.drive[0] + lot.drive[1]) / 2, d);

/** Get from somewhere inside a lot back to the end of its driveway, going round the house if needed. */
export function leaveLot(x: number, z: number, lot: Lot): Wp[] {
  const lx = lot.side > 0 ? x - lot.x0 : lot.x0 + LOT_W - x, d = Math.abs(z - lot.zc);
  const wps: Wp[] = [];
  if (d > 16) {
    const sideX = lx < (lot.house[0] + lot.house[1]) / 2 ? (0.65 + lot.house[0]) / 2 : (lot.house[1] + LOT_W - 0.65) / 2;
    wps.push(toWorld(lot, sideX, Math.min(d, LOT_D1 - 1)), toWorld(lot, sideX, 16.2));
  }
  wps.push(driveAt(lot, Math.min(d, 16.2)), driveAt(lot, 2));
  return wps;
}

/** Drive from (x, z) along the roads to the end of a lot's driveway. */
export function routeTo(x: number, z: number, lot: Lot): Wp[] {
  const wps: Wp[] = [];
  const s0 = streetAt(z), z0 = streetZ(s0);
  if (Math.abs(z - z0) > 2.5) wps.push({ x, z: z0 + Math.sign(z - z0) * 1.6 });
  if (lot.street !== s0) {
    wps.push({ x: CROSS_MID, z: z0 }, { x: CROSS_MID, z: lot.zc });
  }
  // keep right-ish: drive in the lane nearest the lot's side of the street
  const lane = lot.zc + lot.side * 1.6;
  const entry = driveAt(lot, 2);
  wps.push({ x: entry.x, z: lane });
  const top = driveAt(lot, 7);
  wps.push(top);
  return wps;
}

/** Lanes across the whole lawn: front rows, up one side yard, along the back, down the other side. */
export function mowPlan(lot: Lot): Wp[] {
  const L = (lx: number, d: number): Wp => ({ ...toWorld(lot, lx, d), mow: lot.id });
  const [hx0, hx1] = lot.house;
  const dc = (lot.drive[0] + lot.drive[1]) / 2;
  const wps: Wp[] = [];
  const LANE = 1.55;
  // front lawn, serpentine, starting on the driveway's side so we end on the far side
  let ltr = dc < LOT_W / 2;
  for (let d = 6.9; d <= 16; d += LANE) {
    wps.push(L(ltr ? 1.1 : LOT_W - 1.1, d), L(ltr ? LOT_W - 1.1 : 1.1, d));
    ltr = !ltr;
  }
  const atRight = !ltr; // the last row ended at the right
  const cols = (a: number, b: number) => {
    const xs: number[] = [];
    if (b - a < LANE) xs.push((a + b) / 2);
    else for (let x = a; x <= b + 0.01; x += LANE) xs.push(x);
    return xs;
  };
  const left = cols(1.45, hx0 - 0.85), right = cols(hx1 + 0.85, LOT_W - 1.45);
  const yTop = LOT_D1 - 1, yBot = HEDGE_D0 - 0.6;
  /** Up and down a side yard; finish at the top when going `up`, otherwise at the bottom. */
  const yard = (xs: number[], up: boolean) => {
    const out: Wp[] = [];
    let goingUp = xs.length % 2 === 1 ? up : !up;
    for (const x of xs) {
      out.push(L(x, goingUp ? yBot : yTop), L(x, goingUp ? yTop : yBot));
      goingUp = !goingUp;
    }
    return out;
  };
  // the near yard runs from the outside in, ending at the top beside the house
  const nearOrdered = atRight ? [...right].reverse() : left;
  wps.push(L(atRight ? LOT_W - 1.45 : 1.45, 16.3));
  wps.push(...yard(nearOrdered, true));
  // along the back strip behind the house
  wps.push(L(atRight ? hx1 + 0.85 : hx0 - 0.85, yTop), L(atRight ? hx0 - 0.85 : hx1 + 0.85, yTop));
  // down the far yard from beside the house outwards, finishing at the bottom
  const farOrdered = atRight ? [...left].reverse() : right;
  wps.push(...yard(farOrdered, false));
  // back round the front of the house to the driveway and out to the road
  const outX = atRight ? 1.45 : LOT_W - 1.45;
  wps.push(L(outX, 16.2));
  wps.push({ ...toWorld(lot, dc, 16.2) }, driveAt(lot, 5), driveAt(lot, 2));
  return wps;
}
