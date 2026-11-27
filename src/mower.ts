import * as THREE from 'three';
import { contactShadow } from './avatar';

export interface MowerModel {
  /** Positioned and turned by the game (via poseBody). */
  root: THREE.Group;
  /** Squashes and leans. */
  body: THREE.Group;
  wheels: THREE.Mesh[];
  blade: THREE.Mesh;
  /** Local position of the side discharge chute (clippings fly out of here). */
  chute: THREE.Vector3;
  /** Spins a little while the engine idles; dark and still with the engine off. */
  exhaust: THREE.Mesh;
  /** Dashboard light that shows the blades are engaged. */
  bladeLamp: THREE.Mesh;
  /** Puffs of exhaust smoke come from here. */
  pipeTip: THREE.Vector3;
}

export interface MowerColors { body: string; shirt: string; cap: string }
export const PLAYER_COLORS: MowerColors = { body: '#c8362a', shirt: '#2f5d9e', cap: '#ffd23a' };
export const CREW_COLORS: MowerColors = { body: '#2f9e57', shirt: '#f2efe8', cap: '#1f6f43' };
export const RIVAL_COLORS: MowerColors = { body: '#2b6fd6', shirt: '#14365f', cap: '#9be15d' };

const paint = (color: string, metalness = 0.35, roughness = 0.38) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness });
const plastic = (color: string, roughness = 0.75) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 });
const METAL = () => new THREE.MeshStandardMaterial({ color: '#b6bcc2', metalness: 0.85, roughness: 0.32 });
const RUBBER = () => new THREE.MeshStandardMaterial({ color: '#232326', roughness: 0.95, metalness: 0 });

/** A chunky riding mower with a driver. Faces +Z. */
export function buildMower(colors: MowerColors = PLAYER_COLORS): MowerModel {
  const bodyMat = paint(colors.body);
  const dark = plastic('#26262a');
  const metal = METAL();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // --- chassis: a rounded tub rather than a plain box
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.34, 1.86), bodyMat);
  chassis.position.y = 0.56;
  const tub = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 1.1, 6, 12), bodyMat);
  tub.rotation.x = Math.PI / 2;
  tub.position.set(0, 0.62, 0.15);
  tub.scale.set(1.4, 1, 0.6);

  // --- bonnet sloping down to the grille
  const hood = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.38, 0.72), bodyMat);
  hood.position.set(0, 0.9, 0.52);
  hood.rotation.x = -0.06;
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.26, 0.06), dark);
  grille.position.set(0, 0.82, 0.92);
  for (let k = 0; k < 5; k++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.018, 0.02), metal);
    slat.position.set(0, 0.74 + k * 0.045, 0.95);
    body.add(slat);
  }
  const bumper = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.0, 8), metal);
  bumper.rotation.z = Math.PI / 2;
  bumper.position.set(0, 0.5, 1.0);
  const badge = new THREE.Mesh(new THREE.CircleGeometry(0.075, 16), new THREE.MeshStandardMaterial({ color: colors.cap, metalness: 0.6, roughness: 0.3 }));
  badge.position.set(0, 0.95, 0.885);

  // --- headlights
  const lampMat = new THREE.MeshStandardMaterial({ color: '#fffbe8', emissive: '#ffedb0', emissiveIntensity: 1.1, roughness: 0.2 });
  for (const x of [-0.32, 0.32]) {
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 14), lampMat);
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(x, 0.87, 0.93);
    body.add(lamp);
  }

  // --- seat, backrest, steering
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.16, 0.54), dark);
  seat.position.set(0, 0.92, -0.44);
  const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.07, 0.46), plastic('#33333a', 0.85));
  cushion.position.set(0, 1.01, -0.44);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.52, 0.13), dark);
  back.position.set(0, 1.2, -0.72);
  back.rotation.x = 0.12;
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.62, 8), metal);
  column.position.set(0, 1.1, 0.12);
  column.rotation.x = -0.5;
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.045, 8, 20), dark);
  wheel.position.set(0, 1.4, -0.02);
  wheel.rotation.x = -Math.PI / 2 + 0.5;
  const dash = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.12), plastic('#1f1f22', 0.5));
  dash.position.set(0, 1.16, 0.18);
  const bladeLamp = new THREE.Mesh(new THREE.CircleGeometry(0.022, 10), new THREE.MeshStandardMaterial({ color: '#7dff9a', emissive: '#7dff9a', emissiveIntensity: 1.6 }));
  bladeLamp.position.set(0.07, 1.177, 0.18);
  bladeLamp.rotation.x = -Math.PI / 2 + 0.35;

  // --- deck slung underneath, wider than the body, with a chute on the right (+X)
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(0.74, 0.8, 0.17, 26), bodyMat);
  deck.position.set(0, 0.23, 0.15);
  deck.scale.set(1.15, 1, 0.8);
  const deckRim = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.035, 6, 30), plastic('#8d1f16', 0.6));
  deckRim.rotation.x = Math.PI / 2;
  deckRim.position.set(0, 0.16, 0.15);
  deckRim.scale.set(1.12, 0.8, 1);
  const chuteM = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.35), dark);
  chuteM.position.set(0.95, 0.24, 0.15);
  chuteM.rotation.z = -0.25;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.02, 0.1), metal);
  blade.position.set(0, 0.12, 0.15);

  // --- engine block and exhaust
  const engine = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.3, 0.4), plastic('#4a4a50', 0.5));
  engine.position.set(0, 1.0, 0.32);
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.04, 0.26, 8), METAL());
  exhaust.position.set(0.24, 0.86, 0.62);
  exhaust.rotation.z = 0.3;
  const pipeTip = new THREE.Vector3(0.3, 0.72, 0.62);

  // --- driver: dungarees, head, cap, and hands on the wheel
  const skin = plastic('#e0b08a', 0.9);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.26, 4, 12), plastic(colors.shirt, 0.9));
  torso.position.set(0, 1.3, -0.42);
  torso.scale.set(1, 1, 0.82);
  const bib = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.22, 0.06), plastic('#3d5a86', 0.95));
  bib.position.set(0, 1.3, -0.25);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 16, 12), skin);
  head.position.set(0, 1.73, -0.4);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.165, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), plastic(colors.cap, 0.8));
  cap.position.set(0, 1.74, -0.4);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.2), plastic(colors.cap, 0.8));
  brim.position.set(0, 1.76, -0.22);
  for (const x of [-0.21, 0.21]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.34, 4, 8), plastic(colors.shirt, 0.9));
    arm.position.set(x, 1.42, -0.2);
    arm.rotation.x = -0.85;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), skin);
    hand.position.set(x * 0.75, 1.44, 0.02);
    body.add(arm, hand);
  }

  body.add(chassis, tub, hood, grille, bumper, badge, seat, cushion, back, column, wheel, dash, bladeLamp, deck, deckRim, chuteM, blade, engine, exhaust, torso, bib, head, cap, brim);

  // --- wheels: chunky turf tyres with hubs
  const wheels: THREE.Mesh[] = [];
  for (const [x, z, r] of [[0.6, 0.65, 0.27], [-0.6, 0.65, 0.27], [0.63, -0.6, 0.39], [-0.63, -0.6, 0.39]]) {
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.26, 16), RUBBER());
    tyre.rotation.z = Math.PI / 2;
    tyre.position.set(x, r, z);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, 0.275, 12), new THREE.MeshStandardMaterial({ color: '#d8d2c4', metalness: 0.5, roughness: 0.4 }));
    hub.rotation.z = Math.PI / 2;
    hub.position.copy(tyre.position);
    body.add(tyre, hub);
    wheels.push(tyre);
  }
  // a soft blob under the deck so it reads as sitting on the grass in bright sun
  const blob = contactShadow(1.6, 0.34);
  blob.position.y = 0.012;
  root.add(blob);
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { root, body, wheels, blade, chute: new THREE.Vector3(1.15, 0.25, 0.15), exhaust, bladeLamp, pipeTip };
}

/** Spin wheels and blade and shake the body while the engine runs. */
export function animateMower(md: MowerModel, yaw: number, vx: number, vz: number, dt: number, t: number, running: boolean, blades = true) {
  const fwd = vx * Math.sin(yaw) + vz * Math.cos(yaw);
  md.wheels.forEach((w, i) => { w.rotation.x += (fwd * dt) / (i < 2 ? 0.26 : 0.38); });
  md.blade.rotation.y += dt * (blades && running ? 45 : blades ? 6 : 0);
  md.body.position.y = running ? Math.sin(t * 70) * 0.012 : 0;
  md.exhaust.rotation.y += dt * (running ? 2 : 0);
  const lamp = md.bladeLamp.material as THREE.MeshStandardMaterial;
  const on = blades && running;
  lamp.color.set(on ? '#7dff9a' : '#5a2b2b');
  lamp.emissive.set(on ? '#7dff9a' : '#3a1414');
  lamp.emissiveIntensity = on ? 1.6 : 0.3;
}
