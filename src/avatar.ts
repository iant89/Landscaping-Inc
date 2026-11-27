import * as THREE from 'three';

/** The bits of the on-foot player the game animates. */
export interface WalkerModel {
  /** Positioned and turned by the game (via poseBody). */
  root: THREE.Group;
  /** Squashes / leans. */
  body: THREE.Group;
  /** Everything above the hips: bobs while walking. */
  torso: THREE.Group;
  legL: THREE.Group; legR: THREE.Group;
  armL: THREE.Group; armR: THREE.Group;
  head: THREE.Group;
  /** Set while walking; drives the leg swing. */
  phase: number;
}

const mat = (color: string, roughness = 0.75) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.04 });

/**
 * A gardener on foot: cap, shirt, dungarees and boots, with hip and shoulder pivots so the legs and
 * arms swing as they walk. Faces +Z, the same as the mower.
 */
export function buildWalker(): WalkerModel {
  const skin = mat('#d9a173', 0.85);
  const shirt = mat('#2f5d9e', 0.9);
  const denim = mat('#3d5a86', 0.95);
  const boot = mat('#3b2b20', 0.9);
  const capM = mat('#ffd23a', 0.8);
  const hiVis = mat('#f5f1c8', 0.9);

  const root = new THREE.Group();
  const body = new THREE.Group();
  const torso = new THREE.Group();
  root.add(body);
  body.add(torso);

  // hips (dungarees) and chest (shirt with hi-vis vest)
  const hips = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.1, 4, 10), denim);
  hips.position.y = 0.82;
  hips.scale.set(1, 1, 0.85);
  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.22, 4, 12), shirt);
  chest.position.y = 1.16;
  chest.scale.set(1, 1, 0.8);
  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.16), hiVis);
  vest.position.set(0, 1.18, 0.07);
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.185, 0.06, 12), mat('#4a3728', 0.6));
  belt.position.y = 0.94;
  belt.scale.z = 0.85;

  // head
  const head = new THREE.Group();
  head.position.y = 1.44;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 14), skin);
  const capTop = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), capM);
  capTop.position.y = 0.03;
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.025, 0.16), capM);
  brim.position.set(0, 0.03, 0.12);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.06, 8), skin);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, -0.005, 0.135);
  head.add(skull, capTop, brim, nose);

  torso.add(hips, chest, vest, belt, head);

  const limb = (len: number, r: number, m: THREE.Material) => {
    const pivot = new THREE.Group();
    const seg = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), m);
    seg.position.y = -len / 2 - r * 0.5;
    pivot.add(seg);
    return { pivot, seg };
  };

  // legs: hip pivots at 0.82, boots at the end
  const legL = limb(0.52, 0.075, denim), legR = limb(0.52, 0.075, denim);
  legL.pivot.position.set(-0.09, 0.82, 0);
  legR.pivot.position.set(0.09, 0.82, 0);
  for (const l of [legL, legR]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.11, 0.24), boot);
    b.position.set(0, -0.62, 0.04);
    l.pivot.add(b);
  }
  // arms: shoulder pivots at 1.3
  const armL = limb(0.44, 0.058, shirt), armR = limb(0.44, 0.058, shirt);
  armL.pivot.position.set(-0.23, 1.3, 0);
  armR.pivot.position.set(0.23, 1.3, 0);
  for (const a of [armL, armR]) {
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.062, 10, 8), skin);
    hand.position.y = -0.56;
    a.pivot.add(hand);
  }
  torso.add(legL.pivot, legR.pivot, armL.pivot, armR.pivot);

  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { root, body, torso, legL: legL.pivot, legR: legR.pivot, armL: armL.pivot, armR: armR.pivot, head, phase: 0 };
}

/** Swing the limbs with distance travelled; idle players just breathe. */
export function animateWalker(w: WalkerModel, dt: number, speed: number, moving: boolean, t: number) {
  w.phase += dt * speed * 3.1;
  const s = Math.sin(w.phase), c = Math.cos(w.phase);
  const k = Math.min(1, speed / 2.2);
  w.legL.rotation.x = s * 0.62 * k;
  w.legR.rotation.x = -s * 0.62 * k;
  w.armL.rotation.x = -s * 0.5 * k;
  w.armR.rotation.x = s * 0.5 * k;
  w.armL.rotation.z = 0.08 + (1 - k) * 0.04;
  w.armR.rotation.z = -0.08 - (1 - k) * 0.04;
  // bob with each step, plus a slow breath when standing
  const bob = Math.abs(c) * 0.055 * k + (moving ? 0 : Math.sin(t * 1.6) * 0.006);
  w.torso.position.y = bob;
  w.head.rotation.y = Math.sin(t * 0.6) * 0.12 * (1 - k);
}

/** A red jerry can, held on the mower's trailer or carried on foot. */
export function buildFuelCan() {
  const g = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: '#c8362a', roughness: 0.55, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: '#2b2b2e', roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.18), red);
  body.position.y = 0.21;
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 6, 12, Math.PI), red);
  handle.position.y = 0.44;
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.12, 8), dark);
  spout.position.set(0.12, 0.44, 0);
  spout.rotation.z = -0.5;
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.302, 0.05, 0.182), new THREE.MeshStandardMaterial({ color: '#f2c14a', roughness: 0.5 }));
  stripe.position.y = 0.3;
  g.add(body, handle, spout, stripe);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
