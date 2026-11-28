import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Static batching: merge the meshes (and line segments) under `root` into as few draw calls as
 * possible, without changing how anything looks.
 *
 * - Meshes that share a material are merged into one mesh with that material.
 * - Plain-coloured MeshStandardMaterials that differ only in colour are merged too: the colour moves
 *   into a vertex colour and the merged mesh uses one white, vertex-coloured copy of the material.
 * - Line segments sharing a material are merged into one.
 *
 * Merging respects shadow flags and render order. Anything `skip` returns true for is left alone,
 * along with everything beneath it, so parts that move or get shown/hidden on their own can stay
 * separate. Only use this on objects that never move relative to `root` afterwards.
 */
export function batchStatic(root: THREE.Object3D, skip: (o: THREE.Object3D) => boolean = () => false) {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const buckets = new Map<string, { objs: (THREE.Mesh | THREE.LineSegments)[]; recolor: boolean }>();

  const walk = (o: THREE.Object3D) => {
    if (o !== root && skip(o)) return;
    const key = batchKey(o);
    if (key) {
      const b = buckets.get(key.key) ?? { objs: [], recolor: key.recolor };
      b.objs.push(o as THREE.Mesh | THREE.LineSegments);
      buckets.set(key.key, b);
    }
    for (const c of o.children) walk(c);
  };
  walk(root);

  const removed = new Set<THREE.Object3D>();
  const m = new THREE.Matrix4();
  for (const { objs, recolor } of buckets.values()) {
    if (objs.length < 2) continue;
    const first = objs[0];
    const isLine = (first as THREE.LineSegments).isLineSegments === true;
    const keepAttrs = isLine ? ['position'] : recolor ? ['position', 'normal'] : Object.keys(first.geometry.attributes);
    const anyUnindexed = objs.some((o) => !o.geometry.index);
    const geos: THREE.BufferGeometry[] = [];
    for (const o of objs) {
      let g = new THREE.BufferGeometry();
      for (const name of keepAttrs) g.setAttribute(name, o.geometry.attributes[name]);
      if (o.geometry.index && !anyUnindexed) g.setIndex(o.geometry.index);
      g = g.clone();
      if (o.geometry.index && anyUnindexed) { g.setIndex(o.geometry.index.clone()); g = g.toNonIndexed(); }
      g.applyMatrix4(m.multiplyMatrices(toRoot, o.matrixWorld));
      if (recolor) {
        const c = ((o.material as THREE.MeshStandardMaterial).color);
        const n = g.attributes.position.count, col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      }
      geos.push(g);
    }
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    let out: THREE.Mesh | THREE.LineSegments;
    if (isLine) out = new THREE.LineSegments(merged, first.material);
    else {
      let mat = first.material as THREE.Material;
      if (recolor) {
        const sm = (mat as THREE.MeshStandardMaterial).clone();
        sm.color.setRGB(1, 1, 1);
        sm.vertexColors = true;
        mat = sm;
      }
      out = new THREE.Mesh(merged, mat);
      out.castShadow = first.castShadow;
      out.receiveShadow = first.receiveShadow;
    }
    out.renderOrder = first.renderOrder;
    out.frustumCulled = first.frustumCulled;
    root.add(out);
    for (const o of objs) removed.add(o);
  }

  // Detach what was merged. Anything surviving beneath a merged object (e.g. a lone outline under a
  // merged mesh) is moved up to `root`, keeping its world transform.
  for (const o of removed) {
    for (const c of [...o.children]) if (!removed.has(c)) root.attach(c);
    o.removeFromParent();
  }
  // drop groups that are now empty
  const prune = (o: THREE.Object3D) => {
    for (const c of [...o.children]) prune(c);
    if (o !== root && o.type === 'Group' && o.children.length === 0 && !skip(o)) o.removeFromParent();
  };
  prune(root);
}

/** Every distinct material used by meshes under `root`. */
export function meshMaterials<T extends THREE.Material = THREE.Material>(root: THREE.Object3D): T[] {
  const set = new Set<T>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !(o as THREE.LineSegments).isLineSegments) {
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) set.add(mat as T);
    }
  });
  return [...set];
}

const MAP_KEYS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'aoMap', 'lightMap', 'bumpMap', 'displacementMap', 'envMap'] as const;

function batchKey(o: THREE.Object3D): { key: string; recolor: boolean } | null {
  const mesh = o as THREE.Mesh;
  const flags = `${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}|${o.renderOrder}|${o.frustumCulled ? 1 : 0}`;
  if ((o as THREE.LineSegments).isLineSegments) {
    const mat = (o as THREE.LineSegments).material;
    if (Array.isArray(mat)) return null;
    return { key: `L|${mat.uuid}|${flags}`, recolor: false };
  }
  if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return null;
  if (Array.isArray(mesh.material) || !mesh.geometry.attributes.position || mesh.geometry.morphAttributes.position) return null;
  const mat = mesh.material;
  const attrs = Object.keys(mesh.geometry.attributes).sort().join(',');
  const sm = mat as THREE.MeshStandardMaterial;
  const plain = sm.type === 'MeshStandardMaterial' && !sm.vertexColors && mesh.geometry.attributes.normal
    && MAP_KEYS.every((k) => !(sm as unknown as Record<string, unknown>)[k]);
  if (plain) {
    const sig = [
      sm.roughness, sm.metalness, sm.emissive.getHexString(), sm.emissiveIntensity, sm.transparent, sm.opacity,
      sm.side, sm.flatShading, sm.depthWrite, sm.depthTest, sm.fog, sm.toneMapped, sm.wireframe, sm.alphaTest,
      sm.customProgramCacheKey(),
    ].join(',');
    return { key: `R|${sig}|${flags}`, recolor: true };
  }
  return { key: `M|${mat.uuid}|${attrs}|${flags}`, recolor: false };
}
