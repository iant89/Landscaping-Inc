import { UPGRADES, UpKey, WEEKDAYS, fmtHour } from './config';

export interface JobLine {
  label: string;
  lawn: number;
  /** Remaining work per extra service, or null if not booked. */
  leaves: number | null;
  edge: number | null;
  hedges: number | null;
  due: string;
  here: boolean;
  trial: boolean;
  crew: string | null;
}
export interface HudData {
  money: number; dayLabel: string; hour: number; rep: number; weather: string;
  fuel: number; fuelMax: number; refueling: boolean;
  /** Fuel left in the spare can, same units. */
  can: number;
  /** Blades engaged, and whether you're riding the mower or on foot. */
  blades: boolean; riding: boolean;
  jobs: JobLine[]; regulars: number;
}
export type CellState = 'done' | 'missed' | 'due' | 'later';
export interface ScheduleCell { label: string; state: CellState; crew?: string }
export interface ScheduleData { week: number; today: number; days: ScheduleCell[][]; forecast: { day: string; icon: string; name: string; note: string }[] }
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

const STATE_ICON: Record<CellState, string> = { done: '✓', missed: '✕', due: '●', later: '' };

function scheduleGrid(d: ScheduleData) {
  const cols = WEEKDAYS.map((name, i) => {
    const cells = d.days[i].map((c) => `<div class="chip ${c.state}">${STATE_ICON[c.state]} ${c.label}${c.crew ? ` <span class="crew">👷${c.crew}</span>` : ''}</div>`).join('');
    const load = d.days[i].length;
    return `<div class="day${i === d.today ? ' today' : ''}${i < d.today ? ' past' : ''}">
      <div class="day-head">${name}<span>${load ? `${load} lawn${load > 1 ? 's' : ''}` : ''}</span></div>
      ${cells || '<div class="empty">free</div>'}
    </div>`;
  }).join('');
  return `<div class="week">${cols}</div>`;
}

function forecastRow(f: ScheduleData['forecast']) {
  return `<div class="forecast">${f.map((x) => `<div><b>${x.icon}</b><span>${x.day}</span><small>${x.name}</small></div>`).join('')}</div>`;
}

/** All the DOM on top of the 3D view. */
export class Hud {
  readonly root: HTMLDivElement;
  readonly minimap: HTMLCanvasElement;
  private stats: HTMLDivElement;
  private fuelBar: HTMLDivElement;
  private fuelText: HTMLDivElement;
  private canEl: HTMLDivElement;
  private modeEl: HTMLDivElement;
  private jobs: HTMLDivElement;
  private toasts: HTMLDivElement;
  private overlay: HTMLDivElement;
  private dialogKeys: DialogOption[] = [];

  constructor(parent: HTMLElement, isTouch: boolean, onBoost: (b: boolean) => void, onPause: () => void, onSchedule: () => void) {
    this.root = h('div', 'hud');
    parent.appendChild(this.root);
    const tl = h('div', 'panel tl');
    this.stats = h('div', 'stats');
    const fuel = h('div', 'fuel');
    this.fuelBar = h('div', 'fuel-fill');
    this.fuelText = h('div', 'fuel-text');
    const track = h('div', 'fuel-track');
    track.appendChild(this.fuelBar);
    this.canEl = h('div', 'can-text');
    fuel.append(h('span', 'fuel-icon', '⛽'), track, this.fuelText);
    this.modeEl = h('div', 'mode');
    tl.append(this.stats, fuel, this.canEl, this.modeEl);
    this.jobs = h('div', 'panel jobs');
    const tr = h('div', 'tr');
    this.minimap = h('canvas', 'panel minimap');
    const btns = h('div', 'btn-col');
    const pause = h('button', 'round-btn', '❚❚');
    pause.title = 'Pause (Esc)';
    pause.onclick = onPause;
    const cal = h('button', 'round-btn', '📅');
    cal.title = 'Schedule (C)';
    cal.onclick = onSchedule;
    btns.append(pause, cal);
    tr.append(btns, this.minimap);
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
    }
  }

  setPlaying(on: boolean) { this.root.classList.toggle('playing', on); }

  update(d: HudData) {
    this.stats.innerHTML =
      `<div class="money">$${Math.floor(d.money).toLocaleString()}</div>` +
      `<div class="clock">${d.dayLabel} · ${fmtHour(d.hour)} <span class="wx">${d.weather}</span></div>` +
      `<div class="rep" title="Reputation">${stars(d.rep)} <span>${d.rep.toFixed(1)}</span></div>`;
    const f = d.fuel / d.fuelMax;
    const cf = d.fuelMax ? d.can / d.fuelMax : 0;
    this.fuelBar.style.width = `${(f * 100).toFixed(1)}%`;
    this.fuelBar.className = `fuel-fill${f < 0.2 ? ' low' : ''}${d.refueling ? ' filling' : ''}`;
    this.fuelText.textContent = d.refueling ? 'Filling…' : `${Math.ceil(f * 100)}%`;
    this.canEl.innerHTML = `<span class="jerry${cf > 0 ? '' : ' empty'}">🛢️</span>${cf > 0 ? `${Math.ceil(cf * 100)}%` : 'empty'}<span class="k">G</span>`;
    this.modeEl.innerHTML = (d.riding
      ? `<span class="chip-mode">🚜 riding</span><span class="chip-mode ${d.blades ? 'on' : 'off'}">${d.blades ? '🌀 blades on' : '⏸ blades off'} <span class="k">B</span></span><span class="chip-mode">🚶 <span class="k">E</span></span>`
      : '<span class="chip-mode walk">🚶 on foot</span><span class="chip-mode"><span class="k">E</span> climb on</span>');
    if (!d.jobs.length) {
      this.jobs.innerHTML = d.regulars
        ? '<div class="hint">✅ Nothing left on today\'s schedule. Knock on doors marked <b>!</b> to grow the business.</div>'
        : '<div class="hint">No customers yet: drive up to a front door marked <b>!</b> to knock.</div>';
      return;
    }
    const shown = d.jobs.slice(0, 5);
    this.jobs.innerHTML = '<div class="jobs-title">Today\'s schedule</div>' + shown.map((j) => {
      const chips = [
        `<span>🌱 ${Math.floor(j.lawn * 100)}%</span>`,
        j.leaves !== null ? `<span class="${j.leaves <= 1 ? 'ok' : ''}">🍂 ${j.leaves <= 1 ? '✓' : j.leaves}</span>` : '',
        j.edge !== null ? `<span class="${j.edge >= 0.9 ? 'ok' : ''}">📏 ${j.edge >= 0.9 ? '✓' : `${Math.floor(j.edge * 100)}%`}</span>` : '',
        j.hedges !== null ? `<span class="${j.hedges === 0 ? 'ok' : ''}">✂️ ${j.hedges === 0 ? '✓' : j.hedges}</span>` : '',
      ].join('');
      return `<div class="job${j.here ? ' here' : ''}">
        <div class="job-head"><span>${j.trial ? '<em>trial</em> ' : ''}${j.label}</span><span class="due">${j.crew ? `👷 ${j.crew}` : `due ${j.due}`}</span></div>
        <div class="bars"><div class="bar"><div style="width:${Math.min(100, j.lawn * 100).toFixed(0)}%"></div></div>${chips}</div>
      </div>`;
    }).join('') + (d.jobs.length > shown.length ? `<div class="more">+${d.jobs.length - shown.length} more (C for schedule)</div>` : '');
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
      <div class="tag">One mower, three streets. Build the best lawn business in town.</div>
      <ul class="how">
        <li>Drive to a front door marked <b>!</b> to knock and pitch your services</li>
        <li>Each customer books 1–3 cuts a week on set days. <b class="cal">📅</b> Stick to the schedule: missed visits are strikes</li>
        <li>Some also want leaves cleared 🍂, edges trimmed 📏 or hedges cut ✂️</li>
        <li>Rain makes grass shoot up; wind brings leaves. Watch out for Green Giant Lawns.</li>
        <li>Hire crew to mow your regulars, and win more streets as your reputation grows</li>
        <li><b class="key">E</b> hop off and walk (a parked mower barely drinks fuel) · <b class="key">B</b> blades off · <b class="key">G</b> pour the spare can</li>
        <li>Rung down? Knock again and <b>haggle</b> — cheaper rate, or drop a service they don't need</li>
      </ul>
      <div class="controls">WASD / arrows to drive · Shift for full throttle · E mount/dismount · B blades · G spare can · C schedule · Esc pause · M mute</div>`);
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

  schedule(d: ScheduleData, onClose: () => void) {
    const card = h('div', 'card wide', `<div class="card-title">📅 Week ${d.week} schedule</div>${scheduleGrid(d)}${forecastRow(d.forecast)}
      <div class="legend"><span class="chip done">✓ done</span><span class="chip missed">✕ missed</span><span class="chip due">● due today</span><span class="chip later">booked</span></div>`);
    const opts: DialogOption[] = [{ label: 'Back to work', key: 'C', primary: true, onPick: onClose }, { label: '', key: 'Esc', onPick: onClose }];
    card.appendChild(this.buttons(opts.slice(0, 1)));
    this.open(card, opts, 'center');
  }

  /** End of the working day: summary, the week ahead, the forecast, then the shop. */
  evening(o: {
    title: string; earned: number; jobs: number; lines: string[]; money: number; rep: number;
    schedule: ScheduleData; unlock: string | null;
    up: Record<UpKey, number>; crew: { count: number; max: number; cost: number | null; wage: number };
    onBuy: (k: UpKey) => void; onHire: () => void; onNext: () => void; nextLabel: string;
  }) {
    const card = h('div', 'card wide evening', `
      <div class="card-title">${o.title}</div>
      <div class="summary">
        <div><b>$${Math.round(o.earned)}</b><span>earned today</span></div>
        <div><b>${o.jobs}</b><span>lawns done</span></div>
        <div><b>${stars(o.rep)}</b><span>reputation ${o.rep.toFixed(1)}</span></div>
      </div>
      ${o.lines.length ? `<ul class="notes">${o.lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : ''}
      ${o.unlock ? `<div class="unlock">${o.unlock}</div>` : ''}
      <div class="section">This week</div>
      ${scheduleGrid(o.schedule)}
      ${forecastRow(o.schedule.forecast)}
      <div class="section">Equipment &amp; crew <span class="cash">$${Math.floor(o.money)}</span></div>`);
    const shop = h('div', 'shop');
    const opts: DialogOption[] = [{ label: o.nextLabel, key: '⏎', primary: true, onPick: o.onNext }];
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
      opts.push({ label: '', key: String(i + 1), onPick: () => o.onBuy(u.key) });
    });
    const hk = String(UPGRADES.length + 1);
    const crew = h('button', `item${o.crew.cost !== null && o.money >= o.crew.cost ? '' : ' dim'}`, `
      <span class="icon">👷</span>
      <span class="name">Hire crew<small>Mows your booked lawns for you · $${o.crew.wage}/day wage each</small></span>
      <span class="lvl">${'●'.repeat(o.crew.count)}${'○'.repeat(o.crew.max - o.crew.count)}</span>
      <span class="price">${o.crew.cost === null ? 'FULL' : `$${o.crew.cost}`}</span>
      <span class="k">${hk}</span>`);
    crew.onclick = o.onHire;
    shop.appendChild(crew);
    opts.push({ label: '', key: hk, onPick: o.onHire });
    card.appendChild(shop);
    card.appendChild(this.buttons(opts.slice(0, 1)));
    this.open(card, opts, 'center');
  }
}
