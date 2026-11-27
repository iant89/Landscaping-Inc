/**
 * Keyboard + virtual joystick, merged into one normalized analog stick.
 * Keys map to actions; the four directions are 'up' | 'down' | 'left' | 'right'.
 */

export type Action = 'up' | 'down' | 'left' | 'right' | 'boost' | (string & {});

export const DEFAULT_KEYMAP: Record<string, Action> = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'boost', ShiftRight: 'boost', Space: 'boost',
};

export interface Stick {
  /** World X direction (-1..1). */
  x: number;
  /** World Z direction (-1..1); "up" on screen is -Z. */
  z: number;
  /** Magnitude 0..1. */
  m: number;
  /** A drive control is physically held, even if opposite keys cancel out. */
  held: boolean;
  boost: boolean;
}

export interface InputOptions {
  keymap?: Record<string, Action>;
  /** Called on every non-repeat keydown, after the action state is updated. */
  onKey?: (code: string, e: KeyboardEvent) => void;
  /** preventDefault on mapped keys while this returns true (stops arrow keys scrolling the page). */
  capture?: () => boolean;
  /** Joystick dead zone and the radius at which it reaches full tilt. */
  deadZone?: number;
  fullTilt?: number;
}

export class Input {
  readonly actions = new Set<Action>();
  joy = { x: 0, y: 0, active: false };
  boostTouch = false;
  private keymap: Record<string, Action>;
  private opts: InputOptions;

  constructor(opts: InputOptions = {}) {
    this.opts = opts;
    this.keymap = opts.keymap ?? DEFAULT_KEYMAP;
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.clear);
  }

  dispose() {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.clear);
  }

  has(a: Action) { return this.actions.has(a); }

  setJoystick(x: number, y: number, active: boolean) { this.joy.x = x; this.joy.y = y; this.joy.active = active; }
  setBoost(b: boolean) { this.boostTouch = b; }

  clear = () => { this.actions.clear(); this.joy.active = false; this.boostTouch = false; };

  /** Current stick. Keyboard diagonals are normalized; the joystick has a dead zone and analog ramp. */
  read(): Stick {
    let x = 0, z = 0;
    if (this.has('left')) x -= 1;
    if (this.has('right')) x += 1;
    if (this.has('up')) z -= 1;
    if (this.has('down')) z += 1;
    let m = Math.hypot(x, z);
    if (m > 0) { x /= m; z /= m; m = 1; }
    if (this.joy.active) {
      const dz = this.opts.deadZone ?? 0.12, full = this.opts.fullTilt ?? 0.87;
      const jm = Math.hypot(this.joy.x, this.joy.y);
      if (jm > dz) {
        const mag = Math.min(1, (jm - dz) / (full - dz));
        x = (this.joy.x / jm) * mag; z = (this.joy.y / jm) * mag; m = mag;
      }
    }
    const held = this.has('left') || this.has('right') || this.has('up') || this.has('down') || this.joy.active;
    return { x, z, m, held, boost: this.has('boost') || this.boostTouch };
  }

  private onDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const a = this.keymap[e.code];
    if (a) {
      this.actions.add(a);
      if (this.opts.capture?.() ?? true) e.preventDefault();
    }
    if (!e.repeat) this.opts.onKey?.(e.code, e);
  };

  private onUp = (e: KeyboardEvent) => {
    const a = this.keymap[e.code];
    if (a) this.actions.delete(a);
  };
}

/**
 * Floating "drag anywhere" touch stick: press anywhere on `el`, drag to steer. If you drag past
 * the radius the base follows your finger, so you never run out of stick.
 */
export class TouchStick {
  private pid: number | null = null;
  private bx = 0;
  private by = 0;
  private base: HTMLDivElement;
  private knob: HTMLDivElement;

  constructor(private el: HTMLElement, private input: Input, private radius = 62) {
    el.style.touchAction = 'none';
    const mk = (size: number, css: string) => {
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;pointer-events:none;border-radius:50%;width:${size}px;height:${size}px;display:none;${css}`;
      document.body.appendChild(d);
      return d;
    };
    this.base = mk(radius * 2, 'border:2px solid rgba(160,240,255,.4);background:rgba(160,240,255,.1)');
    this.knob = mk(52, 'background:rgba(160,240,255,.8);border:2px solid rgba(255,255,255,.8)');
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
  }

  dispose() {
    this.el.removeEventListener('pointerdown', this.down);
    this.el.removeEventListener('pointermove', this.move);
    this.el.removeEventListener('pointerup', this.up);
    this.el.removeEventListener('pointercancel', this.up);
    this.base.remove();
    this.knob.remove();
  }

  private draw(kx: number, ky: number) {
    const R = this.radius;
    this.base.style.display = this.knob.style.display = 'block';
    this.base.style.transform = `translate(${this.bx - R}px, ${this.by - R}px)`;
    this.knob.style.transform = `translate(${this.bx + kx - 26}px, ${this.by + ky - 26}px)`;
  }

  private down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' || this.pid !== null) return;
    this.pid = e.pointerId;
    this.el.setPointerCapture(e.pointerId);
    this.bx = e.clientX; this.by = e.clientY;
    this.draw(0, 0);
    this.input.setJoystick(0, 0, true);
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pid) return;
    const R = this.radius;
    let dx = e.clientX - this.bx, dy = e.clientY - this.by;
    const len = Math.hypot(dx, dy);
    if (len > R) {
      const over = len - R;
      this.bx += (dx / len) * over; this.by += (dy / len) * over;
      dx = (dx / len) * R; dy = (dy / len) * R;
    }
    this.draw(dx, dy);
    this.input.setJoystick(dx / R, dy / R, true);
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pid) return;
    this.pid = null;
    this.base.style.display = this.knob.style.display = 'none';
    this.input.setJoystick(0, 0, false);
  };
}
