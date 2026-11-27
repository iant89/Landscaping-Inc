import { clamp, dampK, lerpAngle } from './math';

/** Axis-aligned box on the ground plane (X/Z). */
export interface AABB { minX: number; maxX: number; minZ: number; maxZ: number }

/** Optional tile grid: any tile where `solid(c, r)` is true (or off the edge) blocks movement. */
export interface TileGrid {
  cols: number;
  rows: number;
  tile: number;
  solid: (c: number, r: number) => boolean;
}

export interface CollisionWorld {
  boxes: AABB[];
  grid?: TileGrid;
}

export interface Hit {
  /** Speed into the surface at the hardest contact this step (0 = no contact). */
  impact: number;
  /** Surface normal of that contact. */
  nx: number;
  nz: number;
}

export interface MoverOptions {
  radius: number;
  maxSpeed: number;
  /** Velocity smoothing rate while the stick is pushed / released (per second). Higher = snappier. */
  accel: number;
  decel: number;
  /** How fast the body turns to face its velocity, and the speed below which it stops turning. */
  turnRate: number;
  minTurnSpeed: number;
  /** Visual lean from acceleration: radians per (unit/s²), the cap, and how fast it settles. */
  lean: number;
  leanMax: number;
  leanRate: number;
  /** Bounce off walls: 1 = slide, >1 = kicks back a little (1.15 gives the springy "bonk"). */
  restitution: number;
  /** Max distance travelled per collision substep, so fast movers never tunnel. */
  substep: number;
}

export const DEFAULT_MOVER: MoverOptions = {
  radius: 0.55,
  maxSpeed: 5.8,
  accel: 13,
  decel: 9,
  turnRate: 14,
  minTurnSpeed: 0.4,
  lean: 0.004,
  leanMax: 0.14,
  leanRate: 10,
  restitution: 1.15,
  substep: 0.2,
};

/**
 * A circle that glides over the X/Z plane: velocity eases toward the stick instead of snapping,
 * leans into acceleration, turns smoothly to face where it's going, and bounces off boxes.
 * This is the core of the "fluid" driving feel.
 */
export class Mover {
  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  yaw = 0;
  /** Pitch / roll lean, to apply to the visual body. */
  leanX = 0;
  leanZ = 0;
  o: MoverOptions;

  constructor(opts: Partial<MoverOptions> = {}) {
    this.o = { ...DEFAULT_MOVER, ...opts };
  }

  get speed() { return Math.hypot(this.vx, this.vz); }

  place(x: number, z: number, yaw = this.yaw) {
    this.x = x; this.z = z; this.vx = this.vz = 0; this.yaw = yaw;
  }

  /**
   * Steer toward (sx, sz) * magnitude * maxSpeed * speedMul, move, collide.
   * Returns the hardest hit this frame so the game can play a bump.
   */
  update(dt: number, sx: number, sz: number, m: number, world: CollisionWorld, speedMul = 1): Hit {
    const o = this.o;
    const spd = o.maxSpeed * speedMul;
    const k = dampK(m > 0.05 ? o.accel : o.decel, dt);
    const ovx = this.vx, ovz = this.vz;
    this.vx += (sx * spd - this.vx) * k;
    this.vz += (sz * spd - this.vz) * k;

    // lean from acceleration, in the body's own frame
    const ax = (this.vx - ovx) / dt, az = (this.vz - ovz) / dt;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const af = ax * sy + az * cy, as = ax * cy - az * sy;
    const lk = Math.min(1, dt * o.leanRate);
    this.leanX += (clamp(-af * o.lean, -o.leanMax, o.leanMax) - this.leanX) * lk;
    this.leanZ += (clamp(as * o.lean, -o.leanMax, o.leanMax) - this.leanZ) * lk;

    const hit = this.integrate(dt, world);

    if (this.speed > o.minTurnSpeed) this.yaw = lerpAngle(this.yaw, Math.atan2(this.vx, this.vz), Math.min(1, dt * o.turnRate));
    return hit;
  }

  /** Move by the current velocity in small substeps, resolving collisions after each. */
  integrate(dt: number, world: CollisionWorld): Hit {
    const steps = Math.max(1, Math.ceil((this.speed * dt) / this.o.substep));
    const best: Hit = { impact: 0, nx: 0, nz: 0 };
    for (let s = 0; s < steps; s++) {
      this.x += (this.vx * dt) / steps;
      this.z += (this.vz * dt) / steps;
      const h = this.collide(world);
      if (h.impact > best.impact) Object.assign(best, h);
    }
    return best;
  }

  /** Push the circle out of every overlapping box and reflect the inward part of its velocity. */
  collide(world: CollisionWorld): Hit {
    const R = this.o.radius, e = this.o.restitution;
    const hit: Hit = { impact: 0, nx: 0, nz: 0 };
    const resolve = (minX: number, maxX: number, minZ: number, maxZ: number) => {
      const cx = clamp(this.x, minX, maxX), cz = clamp(this.z, minZ, maxZ);
      let dx = this.x - cx, dz = this.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R) return;
      const d = Math.sqrt(d2);
      if (d < 1e-5) {
        // centre inside the box: push out along the shortest axis
        const l = this.x - minX, r = maxX - this.x, t = this.z - minZ, b = maxZ - this.z;
        const mn = Math.min(l, r, t, b);
        if (mn === l) { dx = -1; dz = 0; } else if (mn === r) { dx = 1; dz = 0; } else if (mn === t) { dx = 0; dz = -1; } else { dx = 0; dz = 1; }
        this.x += dx * (mn + R); this.z += dz * (mn + R);
      } else {
        dx /= d; dz /= d;
        this.x += dx * (R - d); this.z += dz * (R - d);
      }
      const vn = this.vx * dx + this.vz * dz;
      if (vn < 0) {
        this.vx -= dx * vn * e;
        this.vz -= dz * vn * e;
        if (-vn > hit.impact) { hit.impact = -vn; hit.nx = dx; hit.nz = dz; }
      }
    };
    for (let it = 0; it < 2; it++) {
      const g = world.grid;
      if (g) {
        const T = g.tile;
        const c0 = Math.floor((this.x - R) / T), c1 = Math.floor((this.x + R) / T);
        const r0 = Math.floor((this.z - R) / T), r1 = Math.floor((this.z + R) / T);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          if (r < 0 || c < 0 || r >= g.rows || c >= g.cols || g.solid(c, r)) resolve(c * T, (c + 1) * T, r * T, (r + 1) * T);
        }
      }
      for (const b of world.boxes) {
        if (this.x + R < b.minX || this.x - R > b.maxX || this.z + R < b.minZ || this.z - R > b.maxZ) continue;
        resolve(b.minX, b.maxX, b.minZ, b.maxZ);
      }
    }
    return hit;
  }
}
