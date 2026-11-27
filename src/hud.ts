import { UPGRADES, UpKey, fmtHour } from './config';

export interface JobLine { label: string; lawn: number; leaves: number; due: string; here: boolean; client: boolean }
export interface HudData {
  money: number; day: number; hour: number; rep: number; regulars: number;
  fuel: number; fuelMax: number; refueling: boolean;
  jobs: JobLine[];
}
export interface DialogOption { label: string; sub?: string; key: string; primary?: boolean; onPick: () => void }
export type ToastKind = 'info' | 'good' | 'bad' | 'big';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export const stars = (r: number) => {
  const full = Math.round(r * 2) / 2;
  let s = '';
  for (let i = 1; i <= 5; i++) s += full >= i ? '★' : full >= i - 0.5 ? '⯪' : '☆';
  return s;
};

/** All the DOM on top of the 3D view. */
export class Hud {
  readonly root: HTMLDivElement;
  readonly minimap: HTMLCanvasElement;
  private stats: HTMLDivElement;
  private fuelBar: HTMLDivElement;
  private fuelText: HTMLDivElement;
  private jobs: HTMLDivElement;
  private toasts: HTMLDivElement;
  private overlay: HTMLDivElement;
  private dialogKeys: DialogOption[] = [];
  boostBtn: HTMLButtonElement | null = null;

  constructor(parent: HTMLElement, isTouch: boolean, onBoost: (b: boolean) => void, onPause: () => void) {
    this.root = h('div', 'hud');
    parent.appendChild(this.root);
    const tl = h('div', 'panel tl');
    this.stats = h('div', 'stats');
    const fuel = h('div', 'fuel');
    this.fuelBar = h('div', 'fuel-fill');
    this.fuelText = h('div', 'fuel-text');
    fuel.append(h('span', 'fuel-icon', '⛽'), h('div', 'fuel-track'), this.fuelText);
    fuel.querySelector('.fuel-track')!.appendChild(this.fuelBar);
    tl.append(this.stats, fuel);
    this.jobs = h('div', 'panel jobs');
    const tr = h('div', 'tr');
    this.minimap = h('canvas', 'panel minimap');
    const pause = h('button', 'round-btn', '❚❚');
    pause.onclick = onPause;
    tr.append(pause, this.minimap);
    this.toasts = h('div', 'toasts');
    this.overlay = h('div', 'overlay hidden');
    this.root.append(tl, this.jobs, tr, this.toasts, this.overlay);
    if (isTouch) {
      const b = h('button', 'boost-btn', '⚡');
      const on = (v: boolean) => (e: Event) => { e.preventDefault(); e.stopPropagation(); b.classList.toggle('on', v); onBoost(v); };
      b.addEventListener('pointerdown', on(true));
      b.addEventListener('pointerup', on(false));
      b.addEventListener('pointercancel', on(false));
      b.addEventListener('pointerleave', on(false));
      this.root.appendChild(b);
      this.boostBtn = b;
    }
  }

  setPlaying(on: boolean) { this.root.classList.toggle('playing', on); }

  update(d: HudData) {
    this.stats.innerHTML =
      `<div class="money">$${Math.floor(d.money).toLocaleString()}</div>` +
      `<div class="clock">Day ${d.day} · ${fmtHour(d.hour)}</div>` +
      `<div class="rep" title="Reputation">${stars(d.rep)} <span>${d.rep.toFixed(1)}</span></div>`;
    const f = d.fuel / d.fuelMax;
    this.fuelBar.style.width = `${(f * 100).toFixed(1)}%`;
    this.fuelBar.className = `fuel-fill${f < 0.2 ? ' low' : ''}${d.refueling ? ' filling' : ''}`;
    this.fuelText.textContent = d.refueling ? 'Filling…' : `${Math.ceil(f * 100)}%`;
    if (!d.jobs.length) {
      this.jobs.innerHTML = d.regulars
        ? '<div class="hint">✅ All caught up! Knock on more doors marked <b>!</b> to grow the business.</div>'
        : '<div class="hint">No jobs yet: drive up to a front door marked <b>!</b> to knock.</div>';
      return;
    }
    this.jobs.innerHTML = '<div class="jobs-title">Today\'s jobs</div>' + d.jobs.map((j) => `
      <div class="job${j.here ? ' here' : ''}">
        <div class="job-head"><span>${j.client ? '🔁 ' : ''}${j.label}</span><span class="due">due ${j.due}</span></div>
        <div class="bars">
          <div class="bar"><div style="width:${Math.min(100, j.lawn * 100).toFixed(0)}%"></div></div>
          <span>🌱 ${Math.floor(j.lawn * 100)}%</span><span>🍂 ${j.leaves}</span>
        </div>
      </div>`).join('');
  }

  toast(text: string, kind: ToastKind = 'info', ms = 2600) {
    const t = h('div', `toast ${kind}`, text);
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 3) this.toasts.firstChild!.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, kind === 'big' ? ms + 800 : ms);
  }

  get overlayOpen() { return !this.overlay.classList.contains('hidden'); }

  close() { this.overlay.classList.add('hidden'); this.overlay.innerHTML = ''; this.dialogKeys = []; }

  private open(card: HTMLElement, options: DialogOption[] = [], cls = '') {
    this.overlay.innerHTML = '';
    this.overlay.className = `overlay ${cls}`;
    this.overlay.appendChild(card);
    this.dialogKeys = options;
  }

  private buttons(options: DialogOption[]) {
    const row = h('div', 'buttons');
    for (const o of options) {
      const b = h('button', o.primary ? 'btn primary' : 'btn', `<span class="k">${o.key}</span>${o.label}${o.sub ? `<small>${o.sub}</small>` : ''}`);
      b.onclick = () => o.onPick();
      row.appendChild(b);
    }
    return row;
  }

  /** Keyboard shortcut for the open dialog. Returns true if handled. */
  key(code: string) {
    const k = code.replace(/^Digit|^Key/, '');
    const o = this.dialogKeys.find((d) => d.key === k || (d.key === '⏎' && code === 'Enter') || (d.key === 'Esc' && code === 'Escape'));
    if (!o) return false;
    o.onPick();
    return true;
  }

  dialog(title: string, body: string, options: DialogOption[]) {
    const card = h('div', 'card dialog', `<div class="card-title">${title}</div><div class="card-body">${body}</div>`);
    card.appendChild(this.buttons(options));
    this.open(card, options, 'bottom');
  }

  title(hasSave: boolean, onNew: () => void, onContinue: () => void) {
    const card = h('div', 'card title-card', `
      <div class="logo">🌱 LANDSCAPING INC.</div>
      <div class="tag">One mower. One street. Build the best lawn business on ${'Maple Street'}.</div>
      <ul class="how">
        <li>Drive to a front door marked <b>!</b> to knock and pitch your services</li>
        <li>Mow the lawn and vacuum the leaves off the sidewalk, path and driveway before it's due</li>
        <li>Happy customers become regulars and pay every day</li>
        <li>Refuel at your truck. Don't squash the flowers!</li>
      </ul>
      <div class="controls">WASD / arrows to drive · Shift to go full throttle · Esc to pause · M to mute</div>`);
    const opts: DialogOption[] = [];
    if (hasSave) opts.push({ label: 'Continue', key: '⏎', primary: true, onPick: onContinue });
    opts.push({ label: hasSave ? 'New business' : 'Start mowing', key: hasSave ? 'N' : '⏎', primary: !hasSave, onPick: onNew });
    card.appendChild(this.buttons(opts));
    this.open(card, opts, 'center');
  }

  pause(onResume: () => void, onMute: () => void, muted: boolean, onQuit: () => void) {
    const card = h('div', 'card', '<div class="card-title">Paused</div>');
    const opts: DialogOption[] = [
      { label: 'Resume', key: 'Esc', primary: true, onPick: onResume },
      { label: muted ? 'Sound on' : 'Sound off', key: 'M', onPick: onMute },
      { label: 'Save & quit to title', key: 'Q', onPick: onQuit },
    ];
    card.appendChild(this.buttons(opts));
    this.open(card, opts, 'center');
  }

  /** End of the working day: summary, then the shop, then on to tomorrow. */
  evening(o: {
    day: number; earned: number; jobs: number; lines: string[]; money: number; rep: number;
    up: Record<UpKey, number>; onBuy: (k: UpKey) => void; onNext: () => void;
  }) {
    const card = h('div', 'card evening', `
      <div class="card-title">🌇 End of day ${o.day}</div>
      <div class="summary">
        <div><b>$${Math.round(o.earned)}</b><span>earned today</span></div>
        <div><b>${o.jobs}</b><span>lawns done</span></div>
        <div><b>${stars(o.rep)}</b><span>reputation ${o.rep.toFixed(1)}</span></div>
      </div>
      ${o.lines.length ? `<ul class="notes">${o.lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : ''}
      <div class="shop-title">Equipment shop <span class="cash">$${Math.floor(o.money)}</span></div>`);
    const shop = h('div', 'shop');
    UPGRADES.forEach((u, i) => {
      const lvl = o.up[u.key], cost = u.costs[lvl];
      const maxed = cost === undefined;
      const b = h('button', `item${!maxed && o.money >= cost ? '' : ' dim'}`, `
        <span class="icon">${u.icon}</span>
        <span class="name">${u.name}<small>${u.desc}</small></span>
        <span class="lvl">${'●'.repeat(lvl)}${'○'.repeat(u.costs.length - lvl)}</span>
        <span class="price">${maxed ? 'MAX' : `$${cost}`}</span>
        <span class="k">${i + 1}</span>`);
      b.onclick = () => o.onBuy(u.key);
      shop.appendChild(b);
    });
    card.appendChild(shop);
    const opts: DialogOption[] = [
      { label: `Start day ${o.day + 1}`, key: '⏎', primary: true, onPick: o.onNext },
      ...UPGRADES.map((u, i) => ({ label: '', key: String(i + 1), onPick: () => o.onBuy(u.key) })),
    ];
    card.appendChild(this.buttons(opts.slice(0, 1)));
    this.open(card, opts, 'center');
  }
}
