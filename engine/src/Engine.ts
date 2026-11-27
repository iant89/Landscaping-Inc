import * as THREE from 'three';
import { Particles } from './particles';

export interface EngineOptions {
  /** Called every frame with a clamped delta (seconds) and the rAF timestamp in seconds. */
  update: (dt: number, time: number) => void;
  /** Longest frame step allowed; a tab hiccup never teleports anything. */
  maxDt?: number;
  /** Lower the pixel ratio automatically if frames stay slow. Return false to pause the check (menus). */
  adaptive?: () => boolean;
  /** Called when the tab is hidden or loses focus (pause your game here). */
  onBlur?: () => void;
  fov?: number;
  near?: number;
  far?: number;
  background?: THREE.ColorRepresentation;
  /** Enable shadow map rendering (PCFSoft). Default false. */
  shadows?: boolean;
}

/**
 * Owns the renderer, scene, camera and frame loop. Keeps the canvas sized to its container
 * (window, visual viewport and ResizeObserver, so mobile rotation and address bars are fine),
 * clamps dt, and drops resolution on slow devices.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  /** The scene that gets rendered. Swap it freely (e.g. one scene per level). */
  scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly isTouch: boolean;
  pixelRatio: number;
  /** Set false to freeze the update callback (rendering continues). */
  running = true;
  private particles: Particles[] = [];
  private raf = 0;
  private last = 0;
  private slowFrames = 0;
  private resizeObs?: ResizeObserver;
  private onCtx?: (e: Event) => void;
  private disposed = false;

  constructor(readonly container: HTMLElement, private opts: EngineOptions) {
    this.isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.renderer = new THREE.WebGLRenderer({ antialias: !this.isTouch || window.devicePixelRatio < 2, powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio, this.isTouch ? 1.5 : 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (opts.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    const el = this.renderer.domElement;
    el.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
    container.appendChild(el);
    // Suppress the browser context menu on the game canvas so right-drag never shows it.
    // Bound in capture phase so it always wins over any bubbling handler; cleaned up in dispose().
    this.onCtx = (e: Event) => e.preventDefault();
    el.addEventListener('contextmenu', this.onCtx, true);
    if (opts.background !== undefined) this.scene.background = new THREE.Color(opts.background);

    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 50, 1, opts.near ?? 0.1, opts.far ?? 220);

    this.onResize();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.onResize());
      this.resizeObs.observe(container);
    }
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVis);
  }

  /** Create a particle system kept at the right size on screen (added to the current scene unless told not to). */
  addParticles(max: number, additive: boolean, addToScene = true) {
    const p = new Particles(max, additive);
    this.particles.push(p);
    if (addToScene) this.scene.add(p.points);
    this.syncProjection();
    return p;
  }

  start() {
    this.renderer.compile(this.scene, this.camera); // warm up shaders so the first frames don't stutter
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Reset the frame clock, e.g. after a pause, so the next dt isn't huge. */
  resetClock() { this.last = performance.now(); }

  /** Call after changing camera.fov (FollowCamera does this for you). */
  syncProjection = () => {
    const h = this.renderer.domElement.height;
    const s = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    for (const p of this.particles) p.mat.uniforms.uScale.value = s;
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onResize);
    this.resizeObs?.disconnect();
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVis);
    if (this.onCtx) this.renderer.domElement.removeEventListener('contextmenu', this.onCtx, true);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    let dt = (now - this.last) / 1000;
    this.last = now;
    dt = Math.min(this.opts.maxDt ?? 0.05, Math.max(0.001, dt));
    this.adapt(dt);
    if (this.running) this.opts.update(dt, now / 1000);
    this.renderer.render(this.scene, this.camera);
  };

  private adapt(dt: number) {
    if (!this.running || !(this.opts.adaptive?.() ?? true)) { this.slowFrames = 0; return; }
    if (dt > 1 / 42) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 0.5);
    if (this.slowFrames > 90 && this.pixelRatio > 0.8) {
      this.pixelRatio = Math.max(0.75, this.pixelRatio - 0.25);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.onResize();
      this.slowFrames = 0;
    }
  }

  private onResize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false); // CSS keeps the canvas at 100%; only the buffer changes
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.syncProjection();
  };

  private onBlur = () => { this.opts.onBlur?.(); };
  private onVis = () => { if (document.hidden) this.onBlur(); };
}
