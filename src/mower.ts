import * as THREE from 'three';

export interface MowerModel {
  /** Positioned and turned by the game (via poseBody). */
  root: THREE.Group;
  /** Squashes and leans. */
  body: THREE.Group;
  wheels: THREE.Mesh[];
  blade: THREE.Mesh;
  /** Local position of the side discharge chute (clippings fly out of here). */
  chute: THREE.Vector3;
}

export interface MowerColors { body: string; shirt: string; cap: string }
export const PLAYER_COLORS: MowerColors = { body: '#d23a2c', shirt: '#2f5d9e', cap: '#ffd23a' };
export const CREW_COLORS: MowerColors = { body: '#2f9e57', shirt: '#f2efe8', cap: '#1f6f43' };
export const RIVAL_COLORS: MowerColors = { body: '#2b6fd6', shirt: '#14365f', cap: '#9be15d' };

/** A chunky riding mower with a driver. Faces +Z. */
export function buildMower(colors: MowerColors = PLAYER_COLORS): MowerModel {
  const lam = (c: string) => new THREE.MeshLambertMaterial({ color: c });
  const red = lam(colors.body), dark = lam('#2b2b2e'), metal = lam('#9aa0a6');
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.35, 1.9), red);
  chassis.position.y = 0.55;
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.4, 0.8), red);
  hood.position.set(0, 0.85, 0.5);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.25, 0.05), dark);
  grille.position.set(0, 0.8, 0.92);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.55), dark);
  seat.position.set(0, 0.9, -0.45);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.12), dark);
  back.position.set(0, 1.15, -0.72);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6), metal);
  column.position.set(0, 1.1, 0.12);
  column.rotation.x = -0.5;
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.05, 6, 16), dark);
  wheel.position.set(0, 1.38, 0.0);
  wheel.rotation.x = -Math.PI / 2 + 0.5;
  // deck slung underneath, wider than the body, with a chute on the right (+X)
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.8, 0.18, 24), red);
  deck.position.set(0, 0.22, 0.15);
  deck.scale.set(1.15, 1, 0.8);
  const chuteM = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.35), dark);
  chuteM.position.set(0.95, 0.22, 0.15);
  chuteM.rotation.z = -0.25;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.02, 0.1), metal);
  blade.position.set(0, 0.12, 0.15);

  // driver: overalls, head, cap
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.55, 10), lam(colors.shirt));
  torso.position.set(0, 1.3, -0.42);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), lam('#e8b98f'));
  head.position.set(0, 1.72, -0.4);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.09, 12), lam(colors.cap));
  cap.position.set(0, 1.84, -0.4);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.2), lam(colors.cap));
  brim.position.set(0, 1.81, -0.22);

  body.add(chassis, hood, grille, seat, back, column, wheel, deck, chuteM, blade, torso, head, cap, brim);

  const wheels: THREE.Mesh[] = [];
  for (const [x, z, r] of [[0.6, 0.65, 0.26], [-0.6, 0.65, 0.26], [0.62, -0.6, 0.38], [-0.62, -0.6, 0.38]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.26, 14), dark);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, r, z);
    body.add(w);
    wheels.push(w);
  }
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return { root, body, wheels, blade, chute: new THREE.Vector3(1.15, 0.25, 0.15) };
}

/** Spin wheels and blade and shake the body while the engine runs. */
export function animateMower(md: MowerModel, yaw: number, vx: number, vz: number, dt: number, t: number, running: boolean) {
  const fwd = vx * Math.sin(yaw) + vz * Math.cos(yaw);
  md.wheels.forEach((w, i) => { w.rotation.x += (fwd * dt) / (i < 2 ? 0.26 : 0.38); });
  md.blade.rotation.y += dt * (running ? 45 : 2);
  md.body.position.y = running ? Math.sin(t * 70) * 0.012 : 0;
}
