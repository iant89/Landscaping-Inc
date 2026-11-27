import * as THREE from 'three';

export type Weather = 'sunny' | 'cloudy' | 'rain' | 'windy';

export const WEATHER: Record<Weather, { icon: string; name: string; growth: number; note: string }> = {
  sunny: { icon: '☀️', name: 'Sunny', growth: 0.18, note: 'Grass grows slowly' },
  cloudy: { icon: '⛅', name: 'Cloudy', growth: 0.25, note: 'Normal growth' },
  rain: { icon: '🌧️', name: 'Rain', growth: 0.45, note: 'Slippery, grass shoots up' },
  windy: { icon: '💨', name: 'Windy', growth: 0.22, note: 'Leaves everywhere' },
};

/** Tomorrow's weather, loosely following today's. */
export function rollWeather(prev: Weather | null, rand = Math.random): Weather {
  const r = rand();
  if (prev === 'rain' && r < 0.4) return 'rain';
  if (prev === 'windy' && r < 0.3) return 'windy';
  const r2 = rand();
  return r2 < 0.42 ? 'sunny' : r2 < 0.7 ? 'cloudy' : r2 < 0.86 ? 'rain' : 'windy';
}

/** Rain streaks falling in a box that follows the camera, with splashes reported back to the caller. */
export class Rain {
  lines: THREE.LineSegments;
  private pos: Float32Array;
  private speed: Float32Array;
  private mat: THREE.LineBasicMaterial;
  static readonly N = 1100;
  private readonly SX = 34;
  private readonly SZ = 30;
  private readonly H = 22;

  constructor(scene: THREE.Scene) {
    this.pos = new Float32Array(Rain.N * 6);
    this.speed = new Float32Array(Rain.N);
    for (let i = 0; i < Rain.N; i++) this.reset(i, 0, 0, Math.random() * this.H);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.LineBasicMaterial({ color: '#d6e6f5', transparent: true, opacity: 0, depthWrite: false });
    this.lines = new THREE.LineSegments(g, this.mat);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  private reset(i: number, cx: number, cz: number, y: number) {
    const x = cx + (Math.random() - 0.5) * this.SX * 2, z = cz + (Math.random() - 0.5) * this.SZ * 2;
    const o = i * 6;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    this.pos[o + 3] = x + 0.08; this.pos[o + 4] = y + 0.7; this.pos[o + 5] = z;
    this.speed[i] = 22 + Math.random() * 8;
  }

  /** Advance the rain around (cx, cz); `onSplash` is called for some drops as they land. */
  update(dt: number, cx: number, cz: number, intensity: number, onSplash: (x: number, z: number) => void) {
    this.mat.opacity += (intensity * 0.55 - this.mat.opacity) * Math.min(1, dt * 2);
    this.lines.visible = this.mat.opacity > 0.01;
    if (!this.lines.visible) return;
    for (let i = 0; i < Rain.N; i++) {
      const o = i * 6, dy = this.speed[i] * dt;
      this.pos[o + 1] -= dy; this.pos[o + 4] -= dy;
      this.pos[o] += dt * 1.5; this.pos[o + 3] += dt * 1.5;
      const out = Math.abs(this.pos[o] - cx) > this.SX || Math.abs(this.pos[o + 2] - cz) > this.SZ;
      if (this.pos[o + 1] <= 0 || out) {
        if (!out && intensity > 0.5 && Math.random() < 0.12) onSplash(this.pos[o], this.pos[o + 2]);
        this.reset(i, cx, cz, this.H * (0.8 + Math.random() * 0.2));
      }
    }
    (this.lines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
