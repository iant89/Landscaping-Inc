import * as THREE from 'three';

interface Popup { el: HTMLDivElement; x: number; y: number; z: number; age: number; life: number }

/**
 * Floating text ("+5", "BONK!", "COMBO x3!") anchored to a 3D point: pops in, drifts up, fades.
 * DOM-based, so it stays crisp at any resolution and any font works.
 */
export class Popups {
  private list: Popup[] = [];
  private tmp = new THREE.Vector3();
  readonly layer: HTMLDivElement;

  private max: number;
  private font: string;
  private className?: string;
  private ownsLayer: boolean;

  /**
   * Makes its own full-size overlay inside `container`, or uses `opts.layer` if you already have one.
   * With `opts.className` the font and shadow come from your CSS instead of inline styles.
   */
  constructor(container: HTMLElement, opts: { max?: number; font?: string; layer?: HTMLElement; className?: string } = {}) {
    this.max = opts.max ?? 22;
    this.font = opts.font ?? 'system-ui, sans-serif';
    this.className = opts.className;
    this.ownsLayer = !opts.layer;
    if (opts.layer) this.layer = opts.layer as HTMLDivElement;
    else {
      this.layer = document.createElement('div');
      this.layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
      container.appendChild(this.layer);
    }
  }

  spawn(text: string, x: number, y: number, z: number, color = '#fff', life = 1, scale = 1) {
    if (this.list.length > this.max) this.list.shift()!.el.remove();
    const el = document.createElement('div');
    el.textContent = text;
    if (this.className) el.className = this.className;
    else {
      el.style.cssText = `position:absolute;left:0;top:0;white-space:nowrap;font-weight:900;letter-spacing:.02em;will-change:transform,opacity;` +
        `font-family:${this.font};text-shadow:0 2px 0 rgba(0,0,0,.75),0 0 12px rgba(0,0,0,.6)`;
    }
    el.style.color = color;
    el.style.fontSize = `${Math.round(22 * scale)}px`;
    this.layer.appendChild(el);
    this.list.push({ el, x, y, z, age: 0, life });
  }

  update(dt: number, camera: THREE.Camera) {
    const w = this.layer.clientWidth, h = this.layer.clientHeight;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.age += dt;
      if (p.age >= p.life) { p.el.remove(); this.list.splice(i, 1); continue; }
      this.tmp.set(p.x, p.y, p.z).project(camera);
      const sx = (this.tmp.x * 0.5 + 0.5) * w;
      const sy = (-this.tmp.y * 0.5 + 0.5) * h - p.age * 70;
      const k = p.age / p.life;
      const pop = p.age < 0.12 ? 0.6 + (p.age / 0.12) * 0.6 : 1.2 - Math.min(0.2, (p.age - 0.12) * 1.5);
      p.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%) scale(${pop.toFixed(3)})`;
      p.el.style.opacity = String(k > 0.7 ? (1 - k) / 0.3 : 1);
    }
  }

  clear() { for (const p of this.list) p.el.remove(); this.list = []; }
  dispose() { this.clear(); if (this.ownsLayer) this.layer.remove(); }
}
