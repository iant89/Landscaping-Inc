import { UPGRADES, UpKey, WEEKDAYS, fmtHour } from './config';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface JobLine {
  label: string;
  lawn: number;
  /** Remaining work per extra service, or null if not booked. */
  leaves: number | null;
  edge: number | null;
  hedges: number | null;
  clippings: number | null;
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
  /** What you're driving: the mower, the truck and trailer, or nothing (on foot). */
  mounted: 'mower' | 'rig' | null;
  /** The hand tool you're carrying, if any, and how much fuel it has. */
  tool: string | null;
  toolFuel: number;
  /** > 0 while the winch is loading the mower. */
  loading: number;
  /** Is the mower strapped on the trailer? */
  mowerLoaded: boolean;
  /** Stranded with no fuel anywhere: show the refuel hint. */
  stranded: boolean;
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
  private tutorialEl: HTMLDivElement | null = null;
  private promptEl: HTMLDivElement;
  private overlay: HTMLDivElement;
  private dialogKeys: DialogOption[] = [];
  private driveControls: HTMLDivElement | null = null;
  private mobileActions: HTMLDivElement | null = null;
  private mobileToolButton: HTMLButtonElement | null = null;

  constructor(
    parent: HTMLElement, isTouch: boolean, onBoost: (b: boolean) => void,
    onPause: () => void, onSchedule: () => void,
    onDriveControl: (key: 'left' | 'right' | 'forward' | 'reverse', down: boolean) => void,
    onMobileAction: (key: 'mount' | 'trailer' | 'tool', down: boolean) => void,
  ) {
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
    this.promptEl = h('div', 'action-prompt');
    this.toasts = h('div', 'toasts');
    this.overlay = h('div', 'overlay hidden');
    this.root.append(tl, this.jobs, tr, this.promptEl, this.toasts, this.overlay);
    if (isTouch) {
      const pad = h('div', 'drive-controls');
      const steer = h('div', 'drive-group steer-group');
      const pedals = h('div', 'drive-group pedal-group');
      const addDriveButton = (group: HTMLElement, cls: string, label: string, key: 'left' | 'right' | 'forward' | 'reverse') => {
        const button = h('button', `drive-btn ${cls}`, label);
        button.setAttribute('aria-label', key);
        const down = (e: PointerEvent) => {
          e.preventDefault(); e.stopPropagation();
          button.classList.add('on');
          onDriveControl(key, true);
          button.setPointerCapture(e.pointerId);
        };
        const up = (e: PointerEvent) => {
          e.preventDefault(); e.stopPropagation();
          button.classList.remove('on');
          onDriveControl(key, false);
          if (button.hasPointerCapture(e.pointerId)) button.releasePointerCapture(e.pointerId);
        };
        button.addEventListener('pointerdown', down);
        button.addEventListener('pointerup', up);
        button.addEventListener('pointercancel', up);
        button.addEventListener('lostpointercapture', up);
        group.appendChild(button);
      };
      addDriveButton(steer, 'steer-left', '◀', 'left');
      addDriveButton(steer, 'steer-right', '▶', 'right');
      addDriveButton(pedals, 'drive-forward', '▲', 'forward');
      addDriveButton(pedals, 'drive-reverse', '▼', 'reverse');
      pad.append(steer, pedals);
      this.driveControls = pad;
      this.root.appendChild(pad);

      const actions = h('div', 'mobile-actions');
      const addActionButton = (label: string, key: 'mount' | 'trailer' | 'tool', hold: boolean) => {
        const button = h('button', `mobile-action${key === 'tool' ? ' tool-action' : ''}`, label);
        button.setAttribute('aria-label', key === 'mount' ? 'Mount or dismount' : key === 'trailer' ? 'Trailer and equipment' : 'Run tool');
        const down = (e: PointerEvent) => {
          e.preventDefault(); e.stopPropagation();
          button.classList.add('on');
          onMobileAction(key, true);
          button.setPointerCapture(e.pointerId);
        };
        const up = (e: PointerEvent) => {
          e.preventDefault(); e.stopPropagation();
          button.classList.remove('on');
          if (hold) onMobileAction(key, false);
          if (button.hasPointerCapture(e.pointerId)) button.releasePointerCapture(e.pointerId);
        };
        button.addEventListener('pointerdown', down);
        button.addEventListener('pointerup', up);
        button.addEventListener('pointercancel', up);
        button.addEventListener('lostpointercapture', up);
        actions.appendChild(button);
        return button;
      };
      addActionButton('E', 'mount', false);
      addActionButton('T', 'trailer', false);
      this.mobileToolButton = addActionButton('F', 'tool', true);
      this.mobileActions = actions;
      this.root.appendChild(actions);

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

  /** The "you can do something here" line: F to run a tool, T at the trailer, L at the ramps... */
  prompt(text: string | null, tone: 'info' | 'ok' | 'warn' = 'info') {
    if (!text) { this.promptEl.className = 'action-prompt'; this.promptEl.innerHTML = ''; return; }
    this.promptEl.className = `action-prompt on ${tone}`;
    this.promptEl.innerHTML = text;
  }

  update(d: HudData) {
    this.stats.innerHTML =
      `<div class="money">$${Math.floor(d.money).toLocaleString()}</div>` +
      `<div class="clock">${d.dayLabel} · ${fmtHour(d.hour)} <span class="wx" title="Weather">${d.weather}</span></div>` +
      `<div class="rep" title="Reputation">${stars(d.rep)} <span>${d.rep.toFixed(1)}</span></div>`;
    const f = d.fuel / d.fuelMax;
    const cf = d.fuelMax ? d.can / d.fuelMax : 0;
    this.fuelBar.style.width = `${(f * 100).toFixed(1)}%`;
    this.fuelBar.className = `fuel-fill${f < 0.2 ? ' low' : ''}${d.refueling ? ' filling' : ''}`;
    this.fuelText.textContent = d.refueling ? 'Filling…' : `${Math.ceil(f * 100)}%`;
    this.canEl.innerHTML = `<span class="jerry${cf > 0 ? '' : ' empty'}">🛢️</span>spare ${cf > 0 ? `${Math.ceil(cf * 100)}%` : 'empty'}<span class="k">G</span>`;
    const chips: string[] = [];
    if (d.mounted === 'rig') {
      chips.push('<span class="chip-mode rig">🚚 driving the rig</span>');
    } else if (d.mounted === 'mower') {
      chips.push('<span class="chip-mode">🚜 mowing</span>');
      chips.push(`<span class="chip-mode ${d.blades ? 'on' : 'off'}">${d.blades ? '🌀 blades on' : '⏸ blades off'} <span class="k">B</span></span>`);
    } else {
      chips.push('<span class="chip-mode walk">🚶 on foot</span>');
    }
    if (d.loading > 0) chips.push('<span class="chip-mode loading">⛓️ hitching up…</span>');
    if (d.mowerLoaded) chips.push('<span class="chip-mode">🛖 mower stowed <span class="k">L</span></span>');
    if (d.tool) chips.push(`<span class="chip-mode tool">${d.tool} <b>${d.toolFuel < 0 ? 'manual' : `${Math.ceil(d.toolFuel * 100)}%`}</b></span>`);
    chips.push(`<span class="chip-mode"><span class="k">E</span> ${d.mounted ? 'get off' : 'climb on'}</span>`);
    if (d.stranded) chips.push('<span class="chip-mode warn">⛽ stranded — follow the arrow</span>');
    this.modeEl.innerHTML = chips.join('');
    if (this.driveControls) this.driveControls.classList.toggle('visible', d.mounted !== null);
    if (this.mobileActions) this.mobileActions.classList.add('visible');
    if (this.mobileToolButton) this.mobileToolButton.classList.toggle('visible', d.mounted === null && !!d.tool);
    if (!d.jobs.length) {
      this.jobs.innerHTML = '<div class="jobs-title">Today\'s schedule</div>' + (d.regulars
        ? '<div class="hint">✅ Nothing left on today\'s schedule. Knock on doors marked <b>!</b> to grow the business.</div>'
        : '<div class="hint">No customers yet: drive up to a front door marked <b>!</b> to knock.</div>');
      return;
    }
    const shown = d.jobs.slice(0, 5);
    this.jobs.innerHTML = '<div class="jobs-title">Today\'s schedule</div>' + shown.map((j) => {
      const chips = [
        `<span>🌱 ${Math.floor(j.lawn * 100)}%</span>`,
        j.leaves !== null ? `<span class="${j.leaves <= 1 ? 'ok' : ''}">🍂 ${j.leaves <= 1 ? '✓' : j.leaves}</span>` : '',
        j.edge !== null ? `<span class="${j.edge >= 0.9 ? 'ok' : ''}">📏 ${j.edge >= 0.9 ? '✓' : `${Math.floor(j.edge * 100)}%`}</span>` : '',
        j.hedges !== null ? `<span class="${j.hedges === 0 ? 'ok' : ''}">✂️ ${j.hedges === 0 ? '✓' : j.hedges}</span>` : '',
        j.clippings !== null ? `<span class="${j.clippings === 0 ? 'ok' : ''}">🌿 ${j.clippings === 0 ? '✓' : j.clippings}</span>` : '',
      ].join('');
      return `<div class="job${j.here ? ' here' : ''}">
        <div class="job-head"><span>${j.trial ? '<em>trial</em> ' : ''}${j.label}</span><span class="due">${j.crew ? `👷 ${j.crew}` : j.due === 'no deadline' ? j.due : `due ${j.due}`}</span></div>
        <div class="bars"><div class="bar"><div style="width:${Math.min(100, j.lawn * 100).toFixed(0)}%"></div></div>${chips}</div>
      </div>`;
    }).join('') + (d.jobs.length > shown.length ? `<div class="more">+${d.jobs.length - shown.length} more · press C for the week</div>` : '');
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

  /** A card that sits low on screen so you can still see the world while you talk. */
  dialog(title: string, body: string, options: DialogOption[], eyebrow?: string) {
    const card = h('div', 'card dialog', `<div class="card-title">${title}</div>${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}<div class="card-body">${body}</div>`);
    card.appendChild(this.buttons(options));
    this.open(card, options, 'bottom');
  }

  // ------------------------------------------------------------------ title
  /** Splash screen: brand and pitch on the left, the menu on the right. */
  title(hasSave: boolean, onNew: () => void, onContinue: () => void, difficulty: Difficulty, onDifficulty: (value: Difficulty) => void) {
    let currentDifficulty = difficulty;
    const screen = h('div', 'title-screen', `
      <div class="title-hero">
        <div class="brand">
          <div class="brand-mark">🌱</div>
          <div class="brand-text">
            <div class="brand-name">Landscaping <em>Inc.</em></div>
            <div class="brand-sub">Lawn care · Route work · Small business</div>
          </div>
        </div>
        <p class="tagline">One mower, a trailer of hand tools and a town that needs cutting. Knock on doors, build a route and turn a borrowed mower into the best lawn business on the block.</p>
        <div class="feature-row">
          <span class="feature"><span>🚜</span> Mow &amp; trim</span>
          <span class="feature"><span>📅</span> Keep the schedule</span>
          <span class="feature"><span>👷</span> Hire a crew</span>
          <span class="feature"><span>🛣️</span> Open new streets</span>
        </div>
        <ul class="brief">
          <li><b>Knock</b> on doors marked <b class="bang">!</b> and pitch your price.</li>
          <li>Customers book <b>1–3 cuts a week</b> — missed visits are handled according to difficulty.</li>
          <li>Upsell leaves 🍂, edges 📏 and hedges ✂️ for a bigger ticket.</li>
          <li>Rain grows grass, wind brings leaves, and <b>Green Giant Lawns</b> wants your streets.</li>
        </ul>
      </div>
      <div class="title-menu">
        <div class="menu-card">
          <div class="menu-eyebrow">${hasSave ? 'Welcome back' : 'New business'}</div>
          ${hasSave ? '' : '<div class="menu-headline">Ready to mow?</div>'}
          <label class="difficulty-picker"><span>Difficulty</span><select data-act="difficulty" aria-label="Difficulty">
            <option value="easy"${difficulty === 'easy' ? ' selected' : ''}>Easy · no cutting deadlines</option>
            <option value="normal"${difficulty === 'normal' ? ' selected' : ''}>Normal · standard deadlines</option>
            <option value="hard"${difficulty === 'hard' ? ' selected' : ''}>Hard · tighter deadlines</option>
          </select></label>
          <button class="menu-btn primary" data-act="go">
            <span class="mb-icon">${hasSave ? '▶' : '🌱'}</span>
            <span class="mb-text">
              <span class="mb-title">${hasSave ? 'Continue' : 'Start mowing'}</span>
              <span class="mb-sub">${hasSave ? 'Pick up where you left off' : 'Day one · one mower · $30'}</span>
            </span>
            <span class="k mb-key">⏎</span>
          </button>
          ${hasSave ? `<button class="menu-btn" data-act="new">
            <span class="mb-icon">✚</span>
            <span class="mb-text"><span class="mb-title">New business</span><span class="mb-sub">Start over from day one</span></span>
            <span class="k mb-key">N</span>
          </button>` : ''}
          <button class="menu-btn" data-act="help">
            <span class="mb-icon">🎮</span>
            <span class="mb-text"><span class="mb-title">How to play</span><span class="mb-sub">Every control, one screen</span></span>
            <span class="k mb-key">H</span>
          </button>
          <div class="menu-foot">
            <kbd>WASD</kbd> drive · <kbd>E</kbd> get on/off · <kbd>T</kbd> trailer · <kbd>C</kbd> schedule · <kbd>Esc</kbd> pause
            <br>Mouse wheel zooms · middle-drag orbits the camera
          </div>
        </div>
      </div>`);
    screen.querySelector<HTMLSelectElement>('[data-act="difficulty"]')!.onchange = (event) => {
      currentDifficulty = (event.currentTarget as HTMLSelectElement).value as Difficulty;
      onDifficulty(currentDifficulty);
    };
    screen.querySelector<HTMLButtonElement>('[data-act="go"]')!.onclick = hasSave ? onContinue : onNew;
    const nw = screen.querySelector<HTMLButtonElement>('[data-act="new"]');
    if (nw) nw.onclick = onNew;
    screen.querySelector<HTMLButtonElement>('[data-act="help"]')!.onclick =
      () => this.controls(() => this.title(hasSave, onNew, onContinue, currentDifficulty, onDifficulty));
    const opts: DialogOption[] = [];
    if (hasSave) opts.push({ label: 'Continue', key: '⏎', primary: true, onPick: onContinue });
    opts.push({ label: hasSave ? 'New business' : 'Start mowing', key: hasSave ? 'N' : '⏎', primary: !hasSave, onPick: onNew });
    opts.push({ label: 'How to play', key: 'H', onPick: () => this.controls(() => this.title(hasSave, onNew, onContinue, currentDifficulty, onDifficulty)) });
    this.open(screen, opts, 'title');
  }

  // --------------------------------------------------------------- controls
  /** The full controls sheet, openable from the pause menu, the title (and after skipping the tour). */
  controls(onClose: () => void) {
    const rows: [string, string][] = [
      ['Mobile', 'Hold ◀ / ▶ to steer and ▲ / ▼ to drive; use E / T for nearby actions and hold F to run a tool'],
      ['WASD / arrows', 'Drive, or walk on foot'],
      ['Shift', 'Full throttle'],
      ['E', 'Climb into the nearest vehicle / hop out'],
      ['B', 'Blades on or off (only on the mower)'],
      ['F', 'Hold to run the tool in your hands'],
      ['L', 'Ramps down / winch the mower on (or drive it up yourself)'],
      ['T', 'Trailer menu: swap tools'],
      ['G', 'Pour the spare fuel can'],
      ['V', 'Cycle camera: third person (far), third person (close & above), first person'],
      ['Middle-drag', 'Orbit the camera (Shift+drag also works). In vehicles it swings in behind you while driving forward; on foot it holds still until you move it.'],
      ['R', 'Snap the camera in behind you'],
      ['C', 'Schedule'],
      ['H', 'Replay the tutorial'],
      ['Esc', 'Pause · M mutes'],
    ];
    const card = h('div', 'card', `
      <div class="card-title">🎮 Controls</div>
      <div class="card-sub">Everything is on the keyboard — nothing is hidden in a menu.</div>
      <div class="keylist">${rows.map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('')}</div>`);
    const opts: DialogOption[] = [{ label: 'Back', key: 'Esc', primary: true, onPick: onClose }];
    card.appendChild(this.buttons(opts));
    this.open(card, opts, 'center');
  }

  // --------------------------------------------------------------- tutorial
  /**
   * The new-game guided tour: a small card in the corner that does not stop you playing. It moves on
   * when you do the thing it asks, when you hit Next, or on its own after a while.
   */
  tutorial(d: { step: number; total: number; icon: string; title: string; body: string; keys: string; onNext: () => void; onSkip: () => void }) {
    if (!this.tutorialEl) {
      this.tutorialEl = h('div', 'tutorial-card');
      this.root.appendChild(this.tutorialEl);
    }
    const dots = Array.from({ length: d.total }, (_, i) => `<span class="dot${i < d.step ? ' done' : i === d.step ? ' now' : ''}"></span>`).join('');
    const el = this.tutorialEl;
    el.className = 'tutorial-card on';
    el.innerHTML = `
      <div class="steps">${dots}<span class="step-n">STEP ${d.step + 1} / ${d.total}</span></div>
      <div class="tut-head"><span class="tut-icon">${d.icon}</span><b>${d.title}</b></div>
      <div class="tut-body">${d.body}</div>
      <div class="tut-keys">${d.keys}</div>`;
    const row = h('div', 'tut-buttons');
    const next = h('button', 'btn primary small', d.step + 1 === d.total ? 'Start working' : 'Next');
    next.onclick = d.onNext;
    const skip = h('button', 'btn small', 'Skip tour');
    skip.onclick = d.onSkip;
    row.append(next, skip);
    el.appendChild(row);
  }

  hideTutorial() {
    if (!this.tutorialEl) return;
    this.tutorialEl.className = 'tutorial-card';
    this.tutorialEl.innerHTML = '';
  }

  // ------------------------------------------------------------------ pause
  pause(onResume: () => void, onMute: () => void, muted: boolean, onQuit: () => void, onHelp?: () => void,
    meta?: { dayLabel: string; hour: number; money: number; rep: number }) {
    const stats = meta
      ? `<div class="pause-stats">
          <div><span>Day</span><b>${meta.dayLabel}</b></div>
          <div><span>Time</span><b>${fmtHour(meta.hour)}</b></div>
          <div><span>Cash</span><b class="gold">$${Math.floor(meta.money).toLocaleString()}</b></div>
          <div><span>Rep</span><b class="gold">${stars(meta.rep)}</b></div>
        </div>`
      : '';
    const card = h('div', 'card pause-card', `
      <div class="card-title">Paused</div>
      ${stats}
      <div class="card-sub">The clock is stopped — the lawns will wait.</div>`);
    const opts: DialogOption[] = [
      { label: 'Resume', key: 'Esc', primary: true, onPick: onResume },
      { label: muted ? 'Sound on' : 'Sound off', key: 'M', onPick: onMute },
    ];
    if (onHelp) opts.push({ label: 'Controls', key: 'K', onPick: onHelp });
    opts.push({ label: 'Save & quit', key: 'Q', onPick: onQuit });
    card.appendChild(this.buttons(opts));
    this.open(card, opts, 'center');
  }

  // --------------------------------------------------------------- schedule
  schedule(d: ScheduleData, onClose: () => void) {
    const card = h('div', 'card wide', `
      <div class="card-title">📅 Week ${d.week} schedule</div>
      <div class="card-sub">Today is <b>${WEEKDAYS[d.today]}</b> — the highlighted column.</div>
      ${scheduleGrid(d)}
      <div class="legend"><span class="chip done">✓ done</span><span class="chip missed">✕ missed</span><span class="chip due">● due today</span><span class="chip later">booked</span></div>
      <div class="section">Forecast</div>
      ${forecastRow(d.forecast)}`);
    const opts: DialogOption[] = [{ label: 'Back to work', key: 'C', primary: true, onPick: onClose }, { label: '', key: 'Esc', onPick: onClose }];
    card.appendChild(this.buttons(opts.slice(0, 1)));
    this.open(card, opts, 'center');
  }

  // ----------------------------------------------------------------- evening
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
        <span class="k">${i + 1}</span>
        <span class="icon">${u.icon}</span>
        <span class="name">${u.name}<small>${u.desc}</small></span>
        <span class="lvl">${'●'.repeat(lvl)}${'○'.repeat(u.costs.length - lvl)}</span>
        <span class="price">${maxed ? 'MAX' : `$${cost}`}</span>`);
      b.onclick = () => o.onBuy(u.key);
      shop.appendChild(b);
      opts.push({ label: '', key: String(i + 1), onPick: () => o.onBuy(u.key) });
    });
    const hk = String(UPGRADES.length + 1);
    const crew = h('button', `item${o.crew.cost !== null && o.money >= o.crew.cost ? '' : ' dim'}`, `
      <span class="k">${hk}</span>
      <span class="icon">👷</span>
      <span class="name">Hire crew<small>Mows your booked lawns for you · $${o.crew.wage}/day wage each</small></span>
      <span class="lvl">${'●'.repeat(o.crew.count)}${'○'.repeat(o.crew.max - o.crew.count)}</span>
      <span class="price">${o.crew.cost === null ? 'FULL' : `$${o.crew.cost}`}</span>`);
    crew.onclick = o.onHire;
    shop.appendChild(crew);
    opts.push({ label: '', key: hk, onPick: o.onHire });
    card.appendChild(shop);
    card.appendChild(this.buttons(opts.slice(0, 1)));
    this.open(card, opts, 'center');
  }
}
