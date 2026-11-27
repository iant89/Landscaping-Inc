import * as THREE from 'three';
import { dampK } from './math';

export interface FollowCameraOptions {
  /** Camera offset from the focus point (above and behind). */
  offset: THREE.Vector3;
  /** On portrait screens the camera pulls back by up to this much extra so you still see around you. */
  portraitPullback: number;
  /** Seconds of velocity to look ahead by, so the view leads where you're heading. */
  lead: number;
  /** How quickly the focus catches up (per second). */
  followRate: number;
  /** Look slightly past the target along -Z. */
  lookAhead: number;
  /** Normal FOV, extra FOV while boosting, and how fast it eases between them. */
  fov: number;
  boostFov: number;
  fovRate: number;
  /** Trauma decay per second and shake strength. Shake = trauma², so small hits barely register. */
  traumaDecay: number;
  shakeMove: number;
  shakeRoll: number;
}

export const DEFAULT_FOLLOW: FollowCameraOptions = {
  offset: new THREE.Vector3(0, 11.3, 7.8),
  portraitPullback: 0.75,
  lead: 0.28,
  followRate: 6,
  lookAhead: 0.6,
  fov: 50,
  boostFov: 7,
  fovRate: 5,
  traumaDecay: 1.7,
  shakeMove: 1.2,
  shakeRoll: 0.08,
};

/** A smoothed, leading, top-down chase camera with trauma-based screen shake and FOV kick. */
export class FollowCamera {
  o: FollowCameraOptions;
  focus = new THREE.Vector3();
  trauma = 0;
  private fovNow: number;

  /** `onProjection` is called when the FOV changes (the Engine uses it to rescale particles). */
  constructor(public camera: THREE.PerspectiveCamera, opts: Partial<FollowCameraOptions> = {}, private onProjection?: () => void) {
    this.o = { ...DEFAULT_FOLLOW, ...opts };
    this.fovNow = this.o.fov;
    camera.fov = this.fovNow;
    camera.updateProjectionMatrix();
  }

  addTrauma(v: number) { this.trauma = Math.min(1, this.trauma + v); }

  /** Where the camera sits for a given focus point (accounts for portrait aspect). */
  positionFor(focus: THREE.Vector3, out = new THREE.Vector3()) {
    const a = this.camera.aspect;
    const k = a < 1 ? 1 + (1 - a) * this.o.portraitPullback : 1;
    return out.set(focus.x + this.o.offset.x * k, focus.y + this.o.offset.y * k, focus.z + this.o.offset.z * k);
  }

  /** Jump straight to the target with no glide (after teleports, level loads, cutscenes). */
  snap(x: number, z: number) {
    this.focus.set(x, 0, z);
    this.camera.position.copy(this.positionFor(this.focus));
    this.lookAtFocus();
  }

  update(dt: number, x: number, z: number, vx = 0, vz = 0, boost = false) {
    this.track(dt, x, z, vx, vz, boost);
    this.shake(dt);
  }

  /** Follow and FOV without shake: lets a game nudge the camera (zooms, cutscene blends) before calling shake(). */
  track(dt: number, x: number, z: number, vx = 0, vz = 0, boost = false) {
    const o = this.o;
    const k = dampK(o.followRate, dt);
    this.focus.x += (x + vx * o.lead - this.focus.x) * k;
    this.focus.z += (z + vz * o.lead - this.focus.z) * k;
    this.camera.position.copy(this.positionFor(this.focus));
    this.lookAtFocus();

    const tf = o.fov + (boost ? o.boostFov : 0);
    if (Math.abs(this.fovNow - tf) > 0.01) {
      this.fovNow += (tf - this.fovNow) * Math.min(1, dt * o.fovRate);
      this.camera.fov = this.fovNow;
      this.camera.updateProjectionMatrix();
      this.onProjection?.();
    }
  }

  /** Point the camera at the current focus (after moving it yourself). */
  lookAtFocus() { this.camera.lookAt(this.focus.x, 0, this.focus.z - this.o.lookAhead); }

  /** Apply (and decay) screen shake on top of wherever the camera currently is. */
  shake(dt: number) {
    this.trauma = Math.max(0, this.trauma - dt * this.o.traumaDecay);
    const s = this.trauma * this.trauma;
    if (s <= 0.0005) return;
    const c = this.camera, m = this.o.shakeMove;
    c.position.x += (Math.random() - 0.5) * m * s;
    c.position.y += (Math.random() - 0.5) * m * 0.66 * s;
    c.position.z += (Math.random() - 0.5) * m * s;
    c.rotateZ((Math.random() - 0.5) * this.o.shakeRoll * s);
  }
}
