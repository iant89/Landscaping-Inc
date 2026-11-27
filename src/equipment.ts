import * as THREE from 'three';

/**
 * Handheld equipment. The mower is the riding machine (see mower.ts); these three are carried on
 * foot and do one service each, so you can finish a job without dragging the mower across the lawn.
 */
export type ToolId = 'weedeater' | 'trimmer' | 'blower';

export interface ToolDef {
  id: ToolId;
  name: string;
  short: string;
  icon: string;
  /** What service it earns you. */
  action: 'edge' | 'hedge' | 'leaves';
  /** How far from your feet it works (metres). */
  reach: number;
  /** Text for the trailer menu. */
  desc: string;
}

export const TOOLS: ToolDef[] = [
  { id: 'weedeater', name: 'Weed Eater', short: 'weedeater', icon: '🌿', action: 'edge', reach: 1.5, desc: 'Trims the grass creeping over paths and kerbs' },
  { id: 'trimmer', name: 'Hedge Trimmer', short: 'trimmer', icon: '✂️', action: 'hedge', reach: 1.7, desc: 'Cuts hedges back to shape as you brush past' },
  { id: 'blower', name: 'Leaf Blower', short: 'blower', icon: '🍃', action: 'leaves', reach: 3.2, desc: 'Blows leaves off driveways and paths' },
];

export const toolDef = (id: ToolId) => TOOLS.find((t) => t.id === id)!;

const shell = (color: string, roughness = 0.45, metalness = 0.2) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });
const rubber = () => new THREE.MeshStandardMaterial({ color: '#2b2b2e', roughness: 0.9, metalness: 0 });
const steel = () => new THREE.MeshStandardMaterial({ color: '#b9bec4', roughness: 0.35, metalness: 0.8 });

/**
 * A handheld tool, built facing +Z with its grip at the origin, so it can be parented straight to a
 * hand pivot. The `run` part spins or shakes while the tool is working.
 */
export interface ToolModel {
  root: THREE.Group;
  /** Spins / oscillates while working. */
  run: THREE.Object3D;
}

export function buildTool(id: ToolId): ToolModel {
  const root = new THREE.Group();
  const orange = shell('#e8632a', 0.5, 0.15);
  const grey = shell('#4b5058', 0.6, 0.3);
  const accent = shell('#ffd23a', 0.5, 0.1);

  if (id === 'weedeater') {
    // a straight-shaft string trimmer: motor, loop handle, long shaft, guard and cutting head
    const motor = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.14, 0.2), orange);
    motor.position.set(0, 0.1, -0.06);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.06, 10), grey);
    cap.position.set(0, 0.19, -0.06);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.95, 8), steel());
    shaft.rotation.x = Math.PI / 2 - 0.42;
    shaft.position.set(0, -0.13, 0.36);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.018, 6, 14), shell('#2f2f33', 0.8));
    handle.position.set(0, 0.02, 0.16);
    handle.rotation.x = 1.1;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.16, 8), rubber());
    grip.rotation.z = Math.PI / 2;
    grip.position.set(0, 0.05, -0.16);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.14), orange);
    guard.position.set(-0.06, -0.28, 0.62);
    guard.rotation.z = 0.35;
    const head = new THREE.Group();
    head.position.set(0, -0.31, 0.65);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.06, 10), grey);
    const line1 = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.008, 0.012), accent);
    const line2 = line1.clone();
    line2.rotation.y = Math.PI / 2;
    head.add(hub, line1, line2);
    root.add(motor, cap, shaft, handle, grip, guard, head);
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    return { root, run: head };
  }

  if (id === 'trimmer') {
    // a hedge trimmer: body, front loop handle, and a long toothed bar
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.3), orange);
    body.position.set(0, 0.02, -0.02);
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 10), grey);
    motor.rotation.x = Math.PI / 2;
    motor.position.set(0, 0.06, -0.18);
    const loop = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.017, 6, 14), shell('#2f2f33', 0.8));
    loop.position.set(0, 0.12, 0.1);
    loop.rotation.x = Math.PI / 2;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.14, 8), rubber());
    grip.rotation.z = Math.PI / 2;
    grip.position.set(0, 0.04, -0.2);
    // the bar: a flat blade with teeth, in a guard
    const bar = new THREE.Group();
    bar.position.set(0, -0.02, 0.15);
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.5), grey);
    spine.position.z = 0.25;
    bar.add(spine);
    const teeth: THREE.Mesh[] = [];
    for (let k = 0; k < 12; k++) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.012, 0.028), steel());
      t.position.set(0, -0.02, 0.03 + k * 0.04);
      teeth.push(t);
    }
    const blade = new THREE.Group();
    blade.add(...teeth);
    bar.add(blade);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.03, 0.52), orange);
    guard.position.set(0, 0.045, 0.25);
    bar.add(guard);
    root.add(body, motor, loop, grip, bar);
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    return { root, run: blade };
  }

  // leaf blower: a fat body with a nozzle, a top handle and a shoulder strap
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.2, 6, 12), orange);
  body.rotation.x = Math.PI / 2;
  body.position.set(0, 0, -0.02);
  const intake = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 12), grey);
  intake.rotation.x = Math.PI / 2;
  intake.position.set(0, 0, -0.17);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.062, 0.36, 12, 1, true), grey);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(0, 0.01, 0.26);
  const nozzleTip = new THREE.Mesh(new THREE.TorusGeometry(0.037, 0.008, 6, 12), accent);
  nozzleTip.position.set(0, 0.01, 0.44);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.12), shell('#2f2f33', 0.8));
  handle.position.set(0, 0.12, -0.02);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.16, 8), rubber());
  grip.rotation.x = Math.PI / 2;
  grip.position.set(0, 0.17, -0.02);
  const fan = new THREE.Group();
  fan.position.set(0, 0, -0.2);
  for (let k = 0; k < 6; k++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.012, 0.04), grey);
    b.rotation.z = (k / 6) * Math.PI * 2;
    fan.add(b);
  }
  root.add(body, intake, nozzle, nozzleTip, handle, grip, fan);
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return { root, run: fan };
}

/**
 * The arrow that hangs above a player who is out of fuel with an empty can: it spins to point at the
 * nearest pump and bobs, so you always know which way to walk.
 */
export function buildFuelArrow() {
  const g = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: '#ffd23a', emissive: '#a97a00', emissiveIntensity: 0.7, roughness: 0.4, metalness: 0.2 });
  const white = new THREE.MeshStandardMaterial({ color: '#fffdf5', emissive: '#555044', emissiveIntensity: 0.4, roughness: 0.5 });
  // an arrow lying flat, pointing along +Z
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.62, 4), gold);
  head.rotation.set(Math.PI / 2, Math.PI / 4, 0);
  head.position.z = 0.5;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.09, 0.62), gold);
  tail.position.z = -0.06;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.045, 8, 20), white);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.02;
  // a little can silhouette so it's obvious what it means
  const can = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.11), new THREE.MeshStandardMaterial({ color: '#c8362a', emissive: '#4a0d07', emissiveIntensity: 0.5, roughness: 0.5 }));
  can.position.set(0, 0.22, -0.34);
  g.add(head, tail, ring, can);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}
