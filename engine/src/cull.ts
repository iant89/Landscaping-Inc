import * as THREE from 'three';

/**
 * Hides objects that are too far from the camera to matter, typically past the point where fog has
 * turned everything into the horizon colour. This complements three's frustum culling, which only
 * skips things outside the view, not things inside it but far away.
 *
 * It works through layers rather than `visible`, so it never fights game code that shows and hides
 * the same objects for its own reasons. An object counts as out of range once the nearest point of
 * its world-space bounding sphere is further than `distance` from the camera. Only use it on objects
 * that don't move: their spheres are measured once, when they're added.
 */
export class DistanceCuller {
  private items: { obj: THREE.Object3D; sphere: THREE.Sphere; hidden: boolean }[] = [];
  private timer = 0;
  /** Objects on this layer are drawn; the camera must have it enabled (layer 0 is the default). */
  readonly layer: number;

  constructor(public distance: number, opts: { layer?: number; interval?: number } = {}) {
    this.layer = opts.layer ?? 0;
    this.interval = opts.interval ?? 0.2;
  }

  private interval: number;

  /** Track a static object. Its bounding sphere is taken from its geometry and current world matrix. */
  add(obj: THREE.Object3D, sphere?: THREE.Sphere) {
    let s = sphere;
    if (!s) {
      obj.updateWorldMatrix(true, false);
      const g = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      const inst = obj as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        if (!inst.boundingSphere) inst.computeBoundingSphere();
        s = inst.boundingSphere!.clone();
      } else if (g) {
        if (!g.boundingSphere) g.computeBoundingSphere();
        s = g.boundingSphere!.clone();
      } else return;
      s.applyMatrix4(obj.matrixWorld);
    }
    this.items.push({ obj, sphere: s, hidden: false });
  }

  /** Track every static mesh and line under `root` that three would frustum-cull anyway. */
  addTree(root: THREE.Object3D, skip: (o: THREE.Object3D) => boolean = () => false) {
    root.traverse((o) => {
      if (skip(o) || !o.frustumCulled) return;
      if ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine) this.add(o);
    });
  }

  get count() { return this.items.length; }
  get hiddenCount() { return this.items.reduce((n, i) => n + (i.hidden ? 1 : 0), 0); }

  /** Re-check distances (throttled); pass `force` to check right away, e.g. after a teleport. */
  update(dt: number, camera: THREE.Camera, force = false) {
    this.timer -= dt;
    if (this.timer > 0 && !force) return;
    this.timer = this.interval;
    const cam = camera.getWorldPosition(_v);
    for (const it of this.items) {
      const hide = cam.distanceTo(it.sphere.center) - it.sphere.radius > this.distance;
      if (hide === it.hidden) continue;
      it.hidden = hide;
      if (hide) it.obj.layers.disable(this.layer); else it.obj.layers.enable(this.layer);
    }
  }
}

const _v = new THREE.Vector3();
