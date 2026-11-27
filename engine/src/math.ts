/**
 * Frame-rate independent smoothing helpers. Every "glide" in the engine uses these instead of a
 * plain `a += (b - a) * 0.1`, so the feel is identical at 30, 60 or 144 fps.
 */

/** Blend factor for exponential smoothing at `rate` per second over `dt` seconds. */
export function dampK(rate: number, dt: number) {
  return 1 - Math.exp(-rate * dt);
}

/** Move `a` toward `b` with exponential smoothing. */
export function damp(a: number, b: number, rate: number, dt: number) {
  return a + (b - a) * dampK(rate, dt);
}

/** Interpolate between two angles (radians) along the short way round. */
export function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Ease in-out quad, 0..1 -> 0..1. */
export function easeInOut(u: number) {
  return u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
}

/** Small seeded PRNG (mulberry32) for repeatable level generation. */
export function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
