import * as THREE from 'three';
import { CELL, GH, GW, K_LAWN } from './config';

/** Natural green palettes with enough hue/value spread to make adjoining lawns distinct. */
export const LOT_GRASS_PALETTE = [
  '#3c6a2d', '#476f32', '#3d6938', '#4b7139',
  '#41682b', '#3d6e40', '#496e3a', '#3d6630',
  '#4a7134', '#406b36', '#466d2e', '#3c6940',
  '#416d31', '#4a7137', '#3b6633', '#4a7033',
  '#416c3c', '#3e6830', '#4d743b', '#3a6535',
  '#456d2f', '#3e6b3b', '#4a6d32', '#406738',
];

const paletteColors = LOT_GRASS_PALETTE.map((hex) => new THREE.Color(hex));

/**
 * Return a lot's grass color, softly blended toward neighboring yards near their shared edge.
 * The cell grid is also the ownership grid, so the same blend is used by the ground texture,
 * grass instances, and regrowth paint to keep the transition seamless throughout gameplay.
 */
export function grassTintForCell(cell: number, kind: Uint8Array, owner: Int16Array) {
  const lot = owner[cell];
  const tint = paletteColors[((lot % paletteColors.length) + paletteColors.length) % paletteColors.length].clone();
  if (lot < 0 || kind[cell] !== K_LAWN) return tint;

  const gx = cell % GW, gz = Math.floor(cell / GW);
  const radius = 4; // two metres of soft transition on either side of a yard boundary
  let nearest = Infinity;
  const neighbors = new Set<number>();
  for (let dz = -radius; dz <= radius; dz++) {
    const z = gz + dz;
    if (z < 0 || z >= GH) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dz === 0) continue;
      const x = gx + dx;
      if (x < 0 || x >= GW) continue;
      const otherCell = z * GW + x;
      const otherLot = owner[otherCell];
      if (otherLot < 0 || otherLot === lot || kind[otherCell] !== K_LAWN) continue;
      const d = Math.hypot(dx, dz) * CELL;
      if (d < nearest - 0.001) { nearest = d; neighbors.clear(); neighbors.add(otherLot); }
      else if (Math.abs(d - nearest) < 0.001) neighbors.add(otherLot);
    }
  }
  if (!neighbors.size) return tint;

  const neighborTint = new THREE.Color(0, 0, 0);
  for (const id of neighbors) {
    const i = ((id % paletteColors.length) + paletteColors.length) % paletteColors.length;
    neighborTint.add(paletteColors[i]);
  }
  neighborTint.multiplyScalar(1 / neighbors.size);

  // Cell centers straddle the border; blend both lawns toward the same midpoint, then fade
  // the effect smoothly over the first ~1.6 m of each yard.
  const edgeDistance = nearest * 0.5;
  const t = Math.min(1, edgeDistance / 1.6);
  const smooth = t * t * (3 - 2 * t);
  tint.lerp(neighborTint, 0.5 * (1 - smooth));
  return tint;
}
