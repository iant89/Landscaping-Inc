import * as THREE from 'three';
import { dampK, lerpAngle } from './math';

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
  /** How quickly the view swings behind a vehicle that's driving forward (per second). */
  headingRate: number;
  /** Forward speed (units/s) above which the view starts following the heading. */
  headingMinSpeed: number;
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
  headingRate: 3.5,
  headingMinSpeed: 0.8,
};

/** A smoothed, leading, top-down chase camera with trauma-based screen shake and FOV kick. */
export class FollowCamera {
  o: FollowCameraOptions;
  focus = new THREE.Vector3();
  trauma = 0;
  /**
   * The yaw the camera is actually at. The player owns it (drag / snap), and vehicles with
   * heading-relative controls can also ease it behind themselves while driving forward
   * (see followHeading). Camera-relative characters must NOT use followHeading: their keys
   * are turned by this angle, so a chasing view would rotate the controls underneath them.
   */
  angle = 0;
  /** Height multiplier: the game raises the view a little for a big vehicle. Eased by setPull(). */
  pull = 1;
  /** Current FOV (eased between the normal and boost values). */
  private fovNow: number;

  /** `onProjection` is called when the FOV changes (the Engine uses it to rescale particles). */
  constructor(public camera: THREE.PerspectiveCamera, opts: Partial<FollowCameraOptions> = {}, private onProjection?: () => void) {
    this.o = { ...DEFAULT_FOLLOW, ...opts };
    this.fovNow = this.o.fov;
    camera.fov = this.fovNow;
    camera.updateProjectionMatrix();
  }

  addTrauma(v: number) { this.trauma = Math.min(1, this.trauma + v); }

  /** Turn the view to `target` with no glide at all (after a teleport, or when the player asks). */
  snapAngle(target: number) {
    this.angle = target;
    this.camera.position.copy(this.positionFor(this.focus));
    this.lookAtFocus();
  }

  /** Ease the camera's height multiplier (a bigger subject wants a wider, higher view). */
  setPull(target: number, dt: number) {
    this.pull += (target - this.pull) * (dt <= 0 ? 1 : dampK(3.5, dt));
  }

  /** Where the camera sits for a given focus point (accounts for portrait aspect). */
  positionFor(focus: THREE.Vector3, out = new THREE.Vector3()) {
    const a = this.camera.aspect;
    const k = a < 1 ? 1 + (1 - a) * this.o.portraitPullback : 1;
    // third person: the camera sits `offset.z` BEHIND the focus (opposite its facing) and
    // `offset.y` up. angle = the facing the view looks along, so behind = -sin/-cos(angle).
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    const back = this.o.offset.z * this.pull;
    return out.set(
      focus.x - s * back * k,
      focus.y + this.o.offset.y * this.pull * k,
      focus.z - c * back * k,
    );
  }

  /** Turn the camera by hand (radians). */
  turn(by: number) { this.angle += by; }

  /**
   * Ease the view behind a vehicle that's driving forward. Does nothing at or below
   * `headingMinSpeed`, so reversing, idling and parking never flip the view around.
   * Only safe with heading-relative controls (throttle + steer): with camera-relative
   * keys the swing would drag "up" around with it and a held turn would spiral.
   */
  followHeading(dt: number, heading: number, forwardSpeed: number) {
    if (forwardSpeed <= this.o.headingMinSpeed || dt <= 0) return;
    this.angle = lerpAngle(this.angle, heading, dampK(this.o.headingRate, dt));
  }

  /**
   * Jump straight to the target with no glide (after teleports, level loads, cutscenes). A teleport
   * usually comes with a new facing, so the view snaps in behind it too.
   */
  snap(x: number, z: number, yaw?: number) {
    this.focus.set(x, 0, z);
    if (yaw !== undefined) { this.angle = yaw; }
    this.camera.position.copy(this.positionFor(this.focus));
    this.lookAtFocus();
  }

  /** Where the camera is looking, in world yaw (0 = toward -Z, matching a Mover's yaw). */
  get yaw() { return this.angle; }

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
  lookAtFocus() {
    // look past the focus along the view direction, and at chest height rather than the floor so
    // the subject sits comfortably in frame
    const a = this.angle;
    this.camera.lookAt(
      this.focus.x + Math.sin(a) * this.o.lookAhead,
      1.0,
      this.focus.z + Math.cos(a) * this.o.lookAhead,
    );
  }


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
