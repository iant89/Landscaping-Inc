import * as THREE from 'three';

/**
 * Procedural materials and textures. Nothing is downloaded: every pattern is drawn once into a
 * canvas (or built out of a few vertices) and reused, so the whole neighbourhood looks hand-made
 * without a single image file.
 */

const cache = new Map<string, THREE.Texture>();

/** A repeating canvas texture. `draw` paints one tile of `size` x `size` pixels. */
function tile(key: string, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, repeat = 1) {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  cache.set(key, t);
  return t;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Soft blotches, the base of almost every organic texture. */
function speckle(g: CanvasRenderingContext2D, s: number, n: number, colors: string[], rMin: number, rMax: number) {
  for (let k = 0; k < n; k++) {
    g.fillStyle = colors[Math.floor(Math.random() * colors.length)];
    g.beginPath();
    g.arc(Math.random() * s, Math.random() * s, rnd(rMin, rMax), 0, Math.PI * 2);
    g.fill();
  }
}

/** Grass: mown turf seen from above, with faint blades and clover. */
export const grassTexture = () => tile('grass', 256, (g, s) => {
  g.fillStyle = '#4f7f36';
  g.fillRect(0, 0, s, s);
  speckle(g, s, 900, ['rgba(60,95,40,0.30)', 'rgba(120,165,80,0.26)', 'rgba(88,130,55,0.30)', 'rgba(35,60,25,0.22)'], 2, 11);
  g.lineWidth = 1;
  for (let k = 0; k < 1400; k++) {
    const x = Math.random() * s, y = Math.random() * s, h = rnd(2, 6);
    g.strokeStyle = `rgba(${Math.random() < 0.5 ? '150,190,110' : '70,110,50'},${rnd(0.1, 0.3)})`;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + rnd(-1.5, 1.5), y - h); g.stroke();
  }
}, 6);

/** Concrete paving slabs, with joints and a fine mottle. */
export const pavingTexture = () => tile('paving', 256, (g, s) => {
  g.fillStyle = '#c4c2b8';
  g.fillRect(0, 0, s, s);
  speckle(g, s, 700, ['rgba(150,148,138,0.28)', 'rgba(215,213,205,0.35)', 'rgba(120,118,110,0.16)'], 1, 5);
  const n = 4, cell = s / n;
  g.strokeStyle = 'rgba(120,118,108,0.55)';
  g.lineWidth = 2;
  for (let i = 0; i <= n; i++) {
    g.beginPath(); g.moveTo(i * cell, 0); g.lineTo(i * cell, s); g.stroke();
    g.beginPath(); g.moveTo(0, i * cell); g.lineTo(s, i * cell); g.stroke();
  }
  // a few hairline cracks
  g.strokeStyle = 'rgba(110,108,100,0.3)';
  g.lineWidth = 1;
  for (let k = 0; k < 6; k++) {
    let x = Math.random() * s, y = Math.random() * s;
    g.beginPath(); g.moveTo(x, y);
    for (let j = 0; j < 5; j++) { x += rnd(-14, 14); y += rnd(-14, 14); g.lineTo(x, y); }
    g.stroke();
  }
}, 8);

/** Brick path pavers in a running bond. */
export const pathTexture = () => tile('path', 256, (g, s) => {
  g.fillStyle = '#b9a58c';
  g.fillRect(0, 0, s, s);
  const bh = 24, bw = 48;
  for (let row = 0; row * bh < s; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let x = -bw; x < s + bw; x += bw) {
      const c = rnd(0.86, 1.06);
      g.fillStyle = `rgb(${Math.round(168 * c)},${Math.round(122 * c)},${Math.round(88 * c)})`;
      g.fillRect(x + off + 2, row * bh + 2, bw - 4, bh - 4);
    }
  }
  speckle(g, s, 400, ['rgba(90,60,40,0.14)', 'rgba(240,225,200,0.14)'], 1, 4);
}, 4);

/** Asphalt: dark, coarse, with tar and gravel flecks. */
export const asphaltTexture = () => tile('asphalt', 256, (g, s) => {
  g.fillStyle = '#3c3e43';
  g.fillRect(0, 0, s, s);
  speckle(g, s, 2400, ['rgba(28,30,34,0.5)', 'rgba(90,92,98,0.35)', 'rgba(120,122,128,0.25)', 'rgba(60,62,66,0.5)'], 0.6, 2.6);
  g.strokeStyle = 'rgba(20,22,26,0.4)';
  for (let k = 0; k < 8; k++) {
    let x = Math.random() * s, y = Math.random() * s;
    g.beginPath(); g.moveTo(x, y);
    for (let j = 0; j < 6; j++) { x += rnd(-20, 20); y += rnd(-20, 20); g.lineTo(x, y); }
    g.lineWidth = rnd(1, 2.4); g.stroke();
  }
}, 5);

/** Timber siding: horizontal boards with grain and shadow lines. */
export const sidingTexture = () => tile('siding', 256, (g, s) => {
  g.fillStyle = '#d8d2c2';
  g.fillRect(0, 0, s, s);
  const bh = 26;
  for (let y = 0; y < s; y += bh) {
    const c = rnd(0.94, 1.04);
    g.fillStyle = `rgba(${Math.round(220 * c)},${Math.round(214 * c)},${Math.round(200 * c)},0.55)`;
    g.fillRect(0, y, s, bh - 2);
    g.fillStyle = 'rgba(90,84,74,0.35)';
    g.fillRect(0, y + bh - 2, s, 2);
    for (let k = 0; k < 8; k++) {
      g.strokeStyle = `rgba(150,142,128,${rnd(0.06, 0.16)})`;
      g.lineWidth = 1;
      const yy = y + rnd(2, bh - 4);
      g.beginPath(); g.moveTo(0, yy); g.bezierCurveTo(s * 0.3, yy + rnd(-2, 2), s * 0.6, yy + rnd(-2, 2), s, yy); g.stroke();
    }
  }
}, 3);

/** Roof shingles in staggered courses. */
export const shingleTexture = () => tile('shingle', 256, (g, s) => {
  g.fillStyle = '#4a4038';
  g.fillRect(0, 0, s, s);
  const th = 20, tw = 34;
  for (let row = 0; row * th < s + th; row++) {
    const off = row % 2 ? tw / 2 : 0;
    for (let x = -tw; x < s + tw; x += tw) {
      const c = rnd(0.75, 1.12);
      g.fillStyle = `rgb(${Math.round(96 * c)},${Math.round(84 * c)},${Math.round(74 * c)})`;
      g.fillRect(x + off + 1, row * th + 1, tw - 2, th - 2);
      g.fillStyle = 'rgba(20,16,12,0.28)';
      g.fillRect(x + off + 1, row * th + th - 3, tw - 2, 2);
    }
  }
  speckle(g, s, 500, ['rgba(30,26,22,0.25)', 'rgba(150,140,128,0.12)'], 1, 3);
}, 4);

/** Rough timber for fences and posts, with vertical grain. */
export const woodTexture = () => tile('wood', 128, (g, s) => {
  g.fillStyle = '#e6e0d2';
  g.fillRect(0, 0, s, s);
  for (let k = 0; k < 40; k++) {
    g.strokeStyle = `rgba(${Math.random() < 0.5 ? '150,138,118' : '250,246,238'},${rnd(0.08, 0.24)})`;
    g.lineWidth = rnd(0.6, 2);
    const x = Math.random() * s;
    g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + rnd(-4, 4), s * 0.4, x + rnd(-4, 4), s * 0.7, x + rnd(-3, 3), s); g.stroke();
  }
}, 2);

/** A dark panelled garage door. */
export const garageTexture = () => tile('garage', 128, (g, s) => {
  g.fillStyle = '#efece2';
  g.fillRect(0, 0, s, s);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
    g.fillStyle = y % 2 ? '#e2ded2' : '#e9e5d9';
    g.fillRect(x * 64 + 6, y * 32 + 4, 52, 24);
    g.strokeStyle = 'rgba(120,116,104,0.5)';
    g.lineWidth = 1.5;
    g.strokeRect(x * 64 + 6, y * 32 + 4, 52, 24);
  }
});

/** A standard, slightly rough material that reads nicely in sunlight. */
export const mat = (color: string, roughness = 0.75, metalness = 0.05) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

/** Standard material with a repeating texture. */
export const texMat = (tex: THREE.Texture, color = '#ffffff', roughness = 0.85) =>
  new THREE.MeshStandardMaterial({ color, map: tex, roughness, metalness: 0.02 });
