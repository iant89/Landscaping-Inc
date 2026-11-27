import * as THREE from 'three';
import { textTexture } from './world';

export interface RigModel {
  /** Positioned and turned by the game. The trailer hangs off the back of this. */
  root: THREE.Group;
  /** Squashes and leans with the mover. */
  body: THREE.Group;
  wheels: THREE.Mesh[];
  /** Rear axle of the truck: the trailer's tow ball follows this. */
  hitch: THREE.Vector3;
  /** Spare cans ride here and are hidden as they're used. */
  cans: THREE.Object3D[];
  /** Hand tools hanging on the trailer's rack, in TOOLS order, hidden while they're in your hands. */
  toolSlots: THREE.Group[];
}

const paint = (color: string, metalness = 0.4, roughness = 0.35) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
const plastic = (color: string, roughness = 0.75) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 });
const METAL = () => new THREE.MeshStandardMaterial({ color: '#b6bcc2', metalness: 0.85, roughness: 0.3 });
const RUBBER = () => new THREE.MeshStandardMaterial({ color: '#232326', roughness: 0.95, metalness: 0 });
export const RIG_GREEN = '#1f6f43';

/**
 * The work truck: a cab with a windscreen and mirrors, a flatbed with tie-down rails, signwriting on
 * the doors, a light bar, and a tow ball at the back for the trailer.
 */
export function buildTruck(): RigModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const green = paint(RIG_GREEN, 0.35, 0.4);
  const glass = new THREE.MeshStandardMaterial({ color: '#8fc4e0', roughness: 0.08, metalness: 0.7 });
  const dark = plastic('#26262a');
  const steel = METAL();

  // chassis rails
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.22, 6.4), plastic('#33333a', 0.6));
  frame.position.set(0, 0.55, 0);
  // cab: lower body, greenhouse, bonnet
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.0, 2.0), green);
  cab.position.set(0, 1.16, 1.55);
  const greenhouse = new THREE.Mesh(new THREE.BoxGeometry(1.88, 0.78, 1.7), green);
  greenhouse.position.set(0, 2.0, 1.15);
  const windscreen = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.62, 0.08), glass);
  windscreen.position.set(0, 2.02, 2.01);
  windscreen.rotation.x = -0.16;
  const sideGlassL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 1.1), glass);
  sideGlassL.position.set(-0.95, 2.0, 1.2);
  const sideGlassR = sideGlassL.clone();
  sideGlassR.position.x = 0.95;
  const rearGlass = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.06), glass);
  rearGlass.position.set(0, 2.0, 0.32);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.1, 1.74), green);
  roof.position.set(0, 2.42, 1.15);
  const bonnet = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.42, 1.0), green);
  bonnet.position.set(0, 1.05, 2.9);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.3, 0.08), steel);
  grille.position.set(0, 1.02, 3.4);
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.24, 0.26), steel);
  bumper.position.set(0, 0.72, 3.42);
  // mirrors
  for (const x of [-1.05, 1.05]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.04), dark);
    arm.position.set(x, 2.1, 1.98);
    const glassM = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.14), glass);
    glassM.position.set(x * 1.12, 2.06, 1.98);
    body.add(arm, glassM);
  }
  // headlights and a light bar
  const lampMat = new THREE.MeshStandardMaterial({ color: '#fffbe8', emissive: '#ffedb0', emissiveIntensity: 1.2, roughness: 0.2 });
  for (const x of [-0.68, 0.68]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.18, 0.06), lampMat);
    lamp.position.set(x, 1.02, 3.44);
    body.add(lamp);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.09, 0.09), new THREE.MeshStandardMaterial({ color: '#ffcf5a', emissive: '#c98a10', emissiveIntensity: 1.1, roughness: 0.35 }));
  bar.position.set(0, 2.5, 1.6);
  // flat bed with rails, and the sign on the sides
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.16, 3.4), plastic('#8d949b', 0.5));
  bed.position.set(0, 0.74, -1.35);
  const railY = 0.98;
  for (const x of [-1.0, 1.0]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 3.4), green);
    rail.position.set(x, railY, -1.35);
    body.add(rail);
  }
  const tailgate = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.34, 0.08), green);
  tailgate.position.set(0, railY, -3.03);
  const signTex = textTexture('LANDSCAPING INC.', '#ffd23a', RIG_GREEN, 512, 128, 54);
  const signMat = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.5, metalness: 0.2 });
  for (const x of [-1.03, 1.03]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.62, 1.9), signMat);
    panel.position.set(x, 1.28, 1.6);
    body.add(panel);
  }
  // spare cans in the bed
  const cans: THREE.Object3D[] = [];
  for (const x of [-0.55, 0.55]) {
    const canGroup = new THREE.Group();
    canGroup.position.set(x, 1.06, -2.5);
    const can = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.48, 0.24), new THREE.MeshStandardMaterial({ color: '#c8362a', roughness: 0.55, metalness: 0.15 }));
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.345, 0.06, 0.245), new THREE.MeshStandardMaterial({ color: '#f2c14a', roughness: 0.5 }));
    stripe.position.y = 0.06;
    canGroup.add(can, stripe);
    body.add(canGroup);
    cans.push(canGroup);
  }
  // fuel tank under the bed
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.2, 12), steel);
  tank.rotation.z = Math.PI / 2;
  tank.position.set(0.78, 0.62, -0.4);
  // tow ball
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), METAL());
  ball.position.set(0, 0.72, -3.2);

  body.add(frame, cab, greenhouse, windscreen, sideGlassL, sideGlassR, rearGlass, roof, bonnet, grille, bumper, bar, bed, tailgate, tank, ball);

  const wheels: THREE.Mesh[] = [];
  for (const [x, z, r] of [[1.0, 2.5, 0.5], [-1.0, 2.5, 0.5], [1.0, -1.9, 0.5], [-1.0, -1.9, 0.5]]) {
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.36, 18), RUBBER());
    tyre.rotation.z = Math.PI / 2;
    tyre.position.set(x, r, z);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.5, 0.38, 12), new THREE.MeshStandardMaterial({ color: '#d8d2c4', metalness: 0.5, roughness: 0.4 }));
    hub.rotation.z = Math.PI / 2;
    hub.position.copy(tyre.position);
    body.add(tyre, hub);
    wheels.push(tyre);
  }
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { root, body, wheels, hitch: new THREE.Vector3(0, 0.62, -3.2), cans, toolSlots: [] };
}

/** The equipment trailer: a flat tray with ramps, a tool rack and its own axle. Faces +Z. */
export function buildTrailer(): RigModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const steel = METAL();
  const dark = plastic('#3a3f46', 0.6);
  const green = paint(RIG_GREEN, 0.35, 0.45);

  // drawbar and hitch cup
  const drawbar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 1.0), steel);
  drawbar.position.set(0, 0.42, 1.9);
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.14, 12), steel);
  cup.position.set(0, 0.5, 2.4);
  const jockey = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), steel);
  jockey.position.set(0, 0.25, 1.7);
  // tray and sides
  const tray = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 3.2), dark);
  tray.position.set(0, 0.52, 0);
  for (const x of [-0.95, 0.95]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 3.2), green);
    side.position.set(x, 0.72, 0);
    body.add(side);
  }
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.34, 0.06), green);
  nose.position.set(0, 0.72, 1.6);
  // profile rails under the tray
  const beamL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 3.2), steel);
  beamL.position.set(-0.6, 0.44, 0);
  const beamR = beamL.clone();
  beamR.position.x = 0.6;
  // ramps folded at the back
  for (const x of [-0.5, 0.5]) {
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 1.1), steel);
    ramp.position.set(x, 0.62, -1.95);
    ramp.rotation.x = -0.3;
    body.add(ramp);
  }
  // a tool rack at the front of the tray for the hand tools
  const rack = new THREE.Group();
  rack.position.set(0, 1.0, 1.15);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.06), steel);
  rack.add(bar);
  for (let k = 0; k < 4; k++) {
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.04), steel);
    hook.position.set(-0.6 + k * 0.4, 0.09, 0);
    rack.add(hook);
  }
  // the hand tools hang from the rack: three slots, filled by the game when they're stowed
  const toolSlots: THREE.Group[] = [];
  for (let k = 0; k < 3; k++) {
    const slot = new THREE.Group();
    slot.position.set(-0.55 + k * 0.55, 0.98, 1.22);
    slot.rotation.z = (k - 1) * 0.12;
    toolSlots.push(slot);
  }
  // mudguards over the wheels
  const wheelZ = -0.1;
  body.add(drawbar, cup, jockey, tray, beamL, beamR, rack, ...toolSlots);
  for (const x of [-0.98, 0.98]) {
    const guard = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.34, 14, 1, true, 0, Math.PI), dark);
    guard.rotation.z = Math.PI / 2;
    guard.rotation.y = Math.PI / 2;
    guard.position.set(x, 0.5, wheelZ);
    body.add(guard);
  }
  const wheels: THREE.Mesh[] = [];
  for (const x of [-0.98, 0.98]) {
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.22, 16), RUBBER());
    tyre.rotation.z = Math.PI / 2;
    tyre.position.set(x, 0.34, wheelZ);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.24, 10), new THREE.MeshStandardMaterial({ color: '#d8d2c4', metalness: 0.5, roughness: 0.4 }));
    hub.rotation.z = Math.PI / 2;
    hub.position.copy(tyre.position);
    body.add(tyre, hub);
    wheels.push(tyre);
  }
  // a spare can and a toolbox on the tray
  const can = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.22), new THREE.MeshStandardMaterial({ color: '#c8362a', roughness: 0.55, metalness: 0.15 }));
  can.position.set(-0.55, 0.79, 0.55);
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.34), new THREE.MeshStandardMaterial({ color: '#c8362a', roughness: 0.5, metalness: 0.3 }));
  box.position.set(0.35, 0.72, -0.7);
  body.add(can, box);
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { root, body, wheels, hitch: new THREE.Vector3(0, 0.5, 2.4), cans: [], toolSlots };
}
