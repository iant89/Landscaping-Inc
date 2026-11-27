import * as THREE from 'three';
import { Engine, FollowCamera, Input, Mover, Particles, Popups, Squash, TouchStick, clamp, poseBody } from '../engine/src';
import {
  BURN, CAN_FRACTION, CAN_POUR_TIME, CELL, CROSS_MID, DAY_END, DAY_START, FUEL_PRICE, GH, GW, HELPER_COST, HELPER_NAMES,
  HELPER_WAGE, K_BED, K_LAWN, MAX_STRIKES, MAX_X, MAX_Z, MIN_X, MIN_Z, PUMP, PUMP_R, SEC_PER_HOUR, STREETS, TOW_FEE,
  UPGRADES, UpKey, WEEKDAYS, WEEKDAYS_LONG, cellX, cellZ, fmtHour, streetZ,
} from './config';
import { Flowers, Grass, Leaf, Leaves } from './lawn';
import { CREW_COLORS, MowerModel, RIVAL_COLORS, animateMower, buildMower } from './mower';
import { WalkerModel, animateWalker, buildFuelCan, buildWalker } from './avatar';
import { DialogOption, Hud, JobLine, ScheduleCell, ScheduleData } from './hud';
import { Npc, leaveLot, mowPlan, routeTo } from './npc';
import { Sfx } from './sfx';
import { Rain, WEATHER, Weather, rollWeather } from './weather';
import { Hedge, Lot, World, buildWorld, unlockStreet } from './world';

type Phase = 'title' | 'play' | 'dialog' | 'paused' | 'schedule' | 'evening' | 'tow';
type Status = 'prospect' | 'declined' | 'job' | 'client' | 'rival';
interface Services { sweep: boolean; edge: boolean; hedge: boolean }
interface Offer { price: number; days: number[]; services: Services }

interface LotState {
  status: Status;
  /** Hour today's visit must be finished by. */
  deadline: number;
  /** Agreed price per visit. */
  pay: number;
  /** Booked weekdays (0 = Monday). */
  days: number[];
  services: Services;
  doneToday: boolean;
  /** 0..1: how hard this owner is to win over. */
  grumpy: number;
  strikes: number;
  /** Visits done in a row since the last strike; two of them wipe a strike. */
  good: number;
  rivalDays: number;
  /** Grass height, 0 (just mown) .. 1 (jungle). Grows every night, faster after rain. */
  level: number;
  flowers: number;
  gnome: boolean;
  cut: number;
  edgeCut: number;
  /** Today's offer, so knocking twice shows the same terms. */
  offer: Offer | null;
  /** How many times they've turned you down today; 3 and they're done. */
  tries: number;
  /** Times you've talked about money today (used for the grumpier line). */
  asked: number;
  /** You waived the first visit to soften them up. */
  sweetened: boolean;
  /** Crew member working this lot today, or -1. */
  crew: number;
}

interface Crew { npc: Npc; name: string; lot: number }
interface Gnome { obj: THREE.Group; hx: number; hz: number; x: number; z: number; vx: number; vz: number; spin: number; tip: number; knocked: boolean; lot: number }

interface SaveFile {
  v: 3; money: number; rep: number; day: number; fuel: number; up: Record<UpKey, number>;
  crew: number; streets: number; forecast: Weather[]; week: Record<string, 'done' | 'missed'>;
  hedges: number[];
  /** fuel left in the spare can (fraction of a full tank), and whether the blades are engaged. */
  can: number;
  lots: Pick<LotState, 'status' | 'grumpy' | 'pay' | 'days' | 'services' | 'strikes' | 'good' | 'rivalDays' | 'level'>[];
}
const SAVE_KEY = 'li_save_v3';
const RIVAL = 'Green Giant Lawns';
const RIVAL_HOME = { x: CROSS_MID + 1.8, z: 14 };

const NO_THANKS = [
  '"We\'re fine, thanks. My nephew does it."', '"Not today, sweetie."', '"I\'ll think about it." *door closes*',
  '"Is this a timeshare thing? No."', '"We like it wild. For the bees."', '"Maybe tomorrow, I\'m on a call."',
];

const freshUp = (): Record<UpKey, number> => ({ deck: 0, engine: 0, tank: 0, bagger: 0, tires: 0 });
const noServices = (): Services => ({ sweep: false, edge: false, hedge: false });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const dayList = (days: number[]) => days.map((d) => WEEKDAYS[d]).join(' & ');

export class Game {
  engine: Engine;
  world: World;
  grass: Grass;
  flowers: Flowers;
  leaves: Leaves;
  model: MowerModel;
  mover = new Mover({ radius: 0.8, maxSpeed: 5.4, accel: 10, decel: 7, turnRate: 10 });
  squash = new Squash({ stiffness: 150, damping: 10 });
  cam: FollowCamera;
  controls: Input;
  sfx = new Sfx();
  popups: Popups;
  hud: Hud;
  clips: Particles;
  sparks: Particles;
  smoke: Particles;
  rain: Rain;
  markers: THREE.Sprite[] = [];
  private markerTex: Record<string, THREE.Texture> = {};

  // --- on foot
  walker: WalkerModel;
  /** The player's own mover: drives the mower when riding, walks when on foot. */
  feet = new Mover({ radius: 0.42, maxSpeed: 3.9, accel: 14, decel: 11, turnRate: 12 });
  riding = true;
  /** Where the mower is parked, so you can climb back on. */
  mowerPark = { x: 0, z: 0, yaw: 0 };
  /** The spare can's model, carried or left by the mower. */
  canModel: THREE.Group;
  /** Fuel left in the spare can, in the same units as the tank. */
  canFuel = 0;
  /** > 0 while pouring the can into the tank. */
  pouring = 0;
  /** Blades are engaged: cutting grass costs extra fuel, disengaged saves it. */
  blades = true;
  private walkHinted = false;
  private bladeHinted = false;
  private walkT = 0;
  private deckT = 0;
  private puffT = 0;
  private canHinted = false;
  gnomes: Gnome[] = [];
  crew: Crew[] = [];
  rival: { npc: Npc; target: number; active: boolean };

  phase: Phase = 'title';
  money = 0;
  rep = 3;
  day = 1;
  hour = DAY_START;
  fuel = 100;
  up = freshUp();
  lots: LotState[] = [];
  forecast: Weather[] = [];
  week: Record<string, 'done' | 'missed'> = {};
  earnedToday = 0;
  mownToday = 0;
  notes: string[] = [];
  yesterday: Weather = 'sunny';

  curLot = -1;
  private knockLock = -1;
  private bumpCd = 0;
  private npcBumpCd = 0;
  private chopT = 0;
  private leafT = 0;
  private glugT = 0;
  private texT = 0;
  private hudT = 0;
  private mapT = 0;
  private checkT = 0;
  private towT = 0;
  private menuT = 0;
  private windT = 0;
  private wx = { rain: 0, cloud: 0, wind: 1 };
  private refueling = false;
  private fuelWarned = false;
  private pumpHinted = false;
  private boost = false;
  private tmp = new THREE.Vector3();

  get weekday() { return (this.day - 1) % 7; }
  get weekNo() { return Math.floor((this.day - 1) / 7) + 1; }
  get today(): Weather { return this.forecast[0] ?? 'sunny'; }
  get deckR() { return 0.95 * (1 + 0.18 * this.up.deck); }
  get speedMax() { return 5.4 * (1 + 0.12 * this.up.engine); }
  get fuelMax() { return 100 * (1 + 0.35 * this.up.tank); }
  get vacR() { return 1.1 * (1 + 0.3 * this.up.bagger); }
  get regulars() { return this.lots.filter((l) => l.status === 'client').length; }

  constructor(container: HTMLElement) {
    this.engine = new Engine(container, {
      update: this.frame,
      adaptive: () => this.phase === 'play',
      onBlur: () => { this.controls.clear(); if (this.phase === 'play') this.pause(); },
      fov: 50, near: 0.1, far: 200,
      shadows: true,
    });
    this.world = buildWorld(7);
    if (this.engine.isTouch) this.world.sun.shadow.mapSize.set(1024, 1024);
    this.engine.scene = this.world.scene;
    this.grass = new Grass(this.world, this.engine.isTouch ? 1 : 2);
    this.flowers = new Flowers(this.world);
    this.leaves = new Leaves(this.world);
    this.clips = this.engine.addParticles(1200, false);
    this.sparks = this.engine.addParticles(700, true);
    this.smoke = this.engine.addParticles(400, false);
    this.rain = new Rain(this.world.scene);
    this.model = buildMower();
    this.world.scene.add(this.model.root);
    this.walker = buildWalker();
    this.walker.root.visible = false;
    this.world.scene.add(this.walker.root);
    this.canModel = buildFuelCan();
    this.canModel.visible = false;
    this.world.scene.add(this.canModel);
    this.cam = new FollowCamera(this.engine.camera, { offset: new THREE.Vector3(0, 14.5, 7.5), boostFov: 6 }, this.engine.syncProjection);
    this.controls = new Input({ capture: () => this.phase === 'play', onKey: this.onKey });
    new TouchStick(container, this.controls);
    this.popups = new Popups(container);
    this.hud = new Hud(container, this.engine.isTouch, (b) => this.controls.setBoost(b), () => this.pause(), () => this.toggleSchedule());
    container.addEventListener('pointerdown', () => this.sfx.unlock());
    this.rival = { npc: new Npc(this.world.scene, RIVAL_COLORS, RIVAL_HOME.x, RIVAL_HOME.z), target: -1, active: false };
    this.rival.npc.mover.o.maxSpeed = 3.8;
    this.buildMarkers();
    this.buildGnomes();
    this.lots = this.world.lots.map(() => this.freshLot());
    this.forecast = [rollWeather(null), rollWeather(null), rollWeather(null), rollWeather(null)];
    this.leaves.scatter(this.world, () => 20);
    this.placeAtPump();
    this.showTitle();
    this.engine.start();
  }

  private freshLot(): LotState {
    return {
      status: 'prospect', deadline: DAY_END, pay: 0, days: [], services: noServices(), doneToday: false,
      grumpy: Math.random() * 0.6, strikes: 0, good: 0, rivalDays: 0, level: 0.7 + Math.random() * 0.3,
      flowers: 0, gnome: false, cut: 0, edgeCut: 0, offer: null, tries: 0, asked: 0, sweetened: false, crew: -1,
    };
  }

  private isDue(st: LotState) { return st.status === 'job' || (st.status === 'client' && st.days.includes(this.weekday)); }
  private isActive(st: LotState) { return this.isDue(st) && !st.doneToday; }
  private open(lot: Lot) { return this.world.streets[lot.street].unlocked; }

  // ================================================================ flow
  private showTitle() {
    this.phase = 'title';
    this.hud.setPlaying(false);
    this.sfx.rain(0);
    this.hud.title(!!this.readSave(), () => this.newGame(), () => this.continueGame());
  }

  private newGame() {
    this.sfx.unlock();
    this.money = 30; this.rep = 3; this.day = 1; this.up = freshUp(); this.fuel = this.fuelMax;
    this.canFuel = this.fuelMax * CAN_FRACTION;
    this.blades = true;
    this.lots = this.world.lots.map(() => this.freshLot());
    this.week = {};
    this.forecast = ['sunny', rollWeather('sunny'), rollWeather(null), rollWeather(null)];
    this.yesterday = 'sunny';
    this.setCrew(0);
    this.setStreets(1);
    for (const h of this.world.hedges) { h.shaggy = true; h.regrow = 0; }
    this.startDay();
    setTimeout(() => this.hud.toast('Drive to a front door marked <b>!</b> to knock and offer your services', 'info', 4200), 1800);
  }

  private continueGame() {
    const s = this.readSave();
    if (!s) return this.newGame();
    this.sfx.unlock();
    this.money = s.money; this.rep = s.rep; this.day = s.day; this.up = { ...freshUp(), ...s.up };
    this.fuel = Math.min(this.fuelMax, s.fuel);
    this.canFuel = s.can === undefined ? this.fuelMax * CAN_FRACTION : s.can * this.fuelMax;
    this.lots = this.world.lots.map((_, i) => ({ ...this.freshLot(), ...(s.lots[i] ?? {}) }));
    this.forecast = [...s.forecast, 'sunny', 'cloudy', 'sunny', 'sunny'].slice(0, 4) as Weather[];
    this.week = s.week ?? {};
    this.world.hedges.forEach((h, i) => { h.regrow = s.hedges[i] ?? 0; h.shaggy = h.regrow <= 0; });
    this.setCrew(s.crew);
    this.setStreets(s.streets);
    this.startDay();
  }

  private setCrew(n: number) {
    while (this.crew.length > n) this.world.scene.remove(this.crew.pop()!.npc.model.root);
    while (this.crew.length < n) {
      const i = this.crew.length;
      this.crew.push({ npc: new Npc(this.world.scene, CREW_COLORS, i * 3, 1.6), name: HELPER_NAMES[i], lot: -1 });
    }
  }

  private setStreets(n: number) {
    this.world.streets.forEach((s, i) => { if (i < n && !s.unlocked) unlockStreet(this.world, s); });
  }

  private startDay() {
    if (this.weekday === 0) this.week = {};
    this.hour = DAY_START;
    for (const lot of this.world.lots) this.grass.growLot(lot, this.lots[lot.id].level);
    this.flowers.restoreAll();
    const windy = this.yesterday === 'windy';
    this.leaves.scatter(this.world, (lot) => {
      const st = this.lots[lot.id];
      return Math.round((st.status === 'rival' ? 4 : 10 + Math.random() * 12) * (windy ? 1.8 : 1));
    });
    for (const h of this.world.hedges) h.tufts.visible = h.shaggy;
    this.resetGnomes();
    let booked = 0;
    this.lots.forEach((st) => {
      if (st.status === 'declined' || st.status === 'job') st.status = 'prospect';
      st.doneToday = false; st.flowers = 0; st.gnome = false; st.cut = 0; st.edgeCut = 0; st.offer = null; st.crew = -1; st.tries = 0; st.asked = 0; st.sweetened = false;
      st.deadline = DAY_END;
      if (this.isDue(st)) booked++;
    });
    this.earnedToday = 0; this.mownToday = 0; this.notes = [];
    this.placeAtPump();
    this.squash.reset();
    this.cam.snap(this.mover.x, this.mover.z);
    this.crew.forEach((c, i) => { c.lot = -1; c.npc.place(i * 3, 1.6); });
    this.rival.npc.place(RIVAL_HOME.x, RIVAL_HOME.z);
    this.rival.target = -1;
    this.rival.active = this.day >= 3;
    this.hud.close();
    this.hud.setPlaying(true);
    this.phase = 'play';
    this.engine.resetClock();
    this.sfx.morning();
    const w = WEATHER[this.today];
    this.hud.toast(`${w.icon} ${WEEKDAYS_LONG[this.weekday]}, week ${this.weekNo} · ${booked ? `${booked} lawn${booked > 1 ? 's' : ''} booked today` : 'nothing booked yet'}`, 'big');
    if (this.today === 'rain') setTimeout(() => this.hud.toast('🌧️ Rain today: the grass is slippery, take corners easy', 'info', 3400), 3600);
    if (this.today === 'windy') setTimeout(() => this.hud.toast('💨 Windy: leaves will keep blowing onto driveways', 'info', 3400), 3600);
    this.sendRival();
    this.save();
    this.pushHud();
  }

  private endDay() {
    this.phase = 'evening';
    this.hud.setPlaying(false);
    this.sfx.drone(0, 0);
    this.sfx.rain(0);
    this.sfx.evening();
    for (const c of this.crew) { c.npc.stop(); c.lot = -1; }
    this.rival.npc.stop();
    const wd = this.weekday;
    // missed bookings are strikes
    this.lots.forEach((st, i) => {
      if (st.status !== 'client' || !st.days.includes(wd) || st.doneToday) return;
      const lot = this.world.lots[i];
      st.strikes++;
      st.good = 0;
      this.week[`${wd}:${i}`] = 'missed';
      this.rep = clamp(this.rep - 0.25, 0, 5);
      if (st.strikes >= MAX_STRIKES) {
        const poached = this.rival.active && Math.random() < 0.6;
        st.status = poached ? 'rival' : 'prospect';
        st.rivalDays = poached ? 7 : 0;
        st.grumpy = Math.min(1, st.grumpy + 0.4);
        st.days = [];
        this.notes.push(`💔 ${cap(lot.owner)} (#${lot.number}) cancelled after ${MAX_STRIKES} missed visits${poached ? ` and signed with ${RIVAL}` : ''}.`);
      } else this.notes.push(`⚠️ Missed #${lot.number} ${cap(lot.owner)}: strike ${st.strikes} of ${MAX_STRIKES}.`);
    });
    // crew wages
    if (this.crew.length) {
      const wages = this.crew.length * HELPER_WAGE;
      if (this.money >= wages) { this.money -= wages; this.notes.push(`👷 Paid crew wages: −$${wages}`); } else {
        this.money = 0;
        this.notes.push(`👷 Couldn't make payroll: ${this.crew[this.crew.length - 1].name} quit.`);
        this.setCrew(this.crew.length - 1);
      }
    }
    // the night: grass grows, hedges get shaggy, rival contracts run down
    const growth = WEATHER[this.today].growth;
    this.world.lots.forEach((lot, i) => {
      const st = this.lots[i];
      const mown = this.grass.count(lot.lawnCells) / lot.lawnCells.length >= 0.9;
      st.level = mown ? 0.08 : Math.min(1, st.level + growth);
      if (st.status === 'rival') {
        st.level = Math.min(st.level, 0.2);
        if (--st.rivalDays <= 0) {
          st.status = 'prospect';
          st.grumpy = 0.1;
          if (this.open(lot)) this.notes.push(`🚩 #${lot.number} ${cap(lot.owner)} dropped ${RIVAL}. Go knock!`);
        }
      }
    });
    for (const h of this.world.hedges) if (!h.shaggy && --h.regrow <= 0) h.shaggy = true;
    this.checkUnlocks();
    this.yesterday = this.today;
    this.day++;
    this.forecast.shift();
    this.forecast.push(rollWeather(this.forecast[this.forecast.length - 1]));
    this.save();
    this.showEvening();
  }

  private checkUnlocks() {
    const regs = this.regulars;
    this.world.streets.forEach((s, i) => {
      if (s.unlocked || !this.world.streets[i - 1]?.unlocked) return;
      const need = STREETS[i].need;
      if (regs >= need.regulars && this.rep >= need.rep) {
        unlockStreet(this.world, s);
        this.sfx.unlock2();
        this.notes.push(`🛣️ <b>${s.name} is open!</b> Take the cross road at the east end. It has its own gas station at the west end.`);
        this.hud.toast(`🛣️ ${s.name} is open for business!`, 'big');
      }
    });
  }

  private unlockLine() {
    const i = this.world.streets.findIndex((s) => !s.unlocked);
    if (i < 0) return null;
    const need = STREETS[i].need;
    return `🛣️ <b>${STREETS[i].name}</b> opens at ${need.regulars} regulars (you have ${this.regulars}) and ★${need.rep.toFixed(1)} reputation (you have ${this.rep.toFixed(1)}).`;
  }

  private showEvening() {
    const prev = this.day - 2;
    this.hud.evening({
      title: `🌇 ${WEEKDAYS_LONG[prev % 7]} wrap-up · week ${Math.floor(prev / 7) + 1}`,
      earned: this.earnedToday, jobs: this.mownToday, lines: this.notes, money: this.money, rep: this.rep,
      schedule: this.scheduleData(), unlock: this.unlockLine(), up: this.up,
      crew: { count: this.crew.length, max: HELPER_COST.length, cost: HELPER_COST[this.crew.length] ?? null, wage: HELPER_WAGE },
      onBuy: (k) => this.buy(k),
      onHire: () => this.hireCrew(),
      onNext: () => this.startDay(),
      nextLabel: `Start ${WEEKDAYS_LONG[this.weekday]}`,
    });
  }

  private buy(k: UpKey) {
    const def = UPGRADES.find((u) => u.key === k)!;
    const cost = def.costs[this.up[k]];
    if (cost === undefined || this.money < cost) { this.sfx.deny(); return; }
    this.money -= cost;
    const oldMax = this.fuelMax;
    this.up[k]++;
    if (k === 'tank') this.fuel += this.fuelMax - oldMax;
    this.sfx.cash();
    this.save();
    this.showEvening();
  }

  private hireCrew() {
    const cost = HELPER_COST[this.crew.length];
    if (cost === undefined || this.money < cost) { this.sfx.deny(); return; }
    this.money -= cost;
    this.setCrew(this.crew.length + 1);
    this.sfx.hired();
    this.notes.push(`👷 Hired ${this.crew[this.crew.length - 1].name}! They'll mow booked lawns for you.`);
    this.save();
    this.showEvening();
  }

  pause() {
    if (this.phase !== 'play') return;
    this.phase = 'paused';
    this.sfx.drone(0, 0);
    this.hud.pause(() => this.resume(), () => { this.sfx.setMuted(!this.sfx.muted); this.phase = 'play'; this.pause(); }, this.sfx.muted, () => { this.save(); this.showTitle(); });
  }

  private resume() { if (this.phase === 'paused' || this.phase === 'schedule') { this.hud.close(); this.phase = 'play'; this.engine.resetClock(); } }

  private toggleSchedule() {
    if (this.phase === 'schedule') { this.resume(); return; }
    if (this.phase !== 'play') return;
    this.phase = 'schedule';
    this.sfx.drone(0, 0);
    this.hud.schedule(this.scheduleData(), () => this.resume());
  }

  private scheduleData(): ScheduleData {
    const today = this.weekday;
    const days: ScheduleCell[][] = WEEKDAYS.map(() => []);
    this.world.lots.forEach((lot, i) => {
      const st = this.lots[i];
      const label = `#${lot.number}`;
      for (let d = 0; d < 7; d++) {
        const log = this.week[`${d}:${i}`];
        if (d < today) { if (log) days[d].push({ label, state: log }); continue; }
        if (d === today && log && !st.days.includes(d)) { days[d].push({ label, state: log }); continue; }
        const booked = (st.status === 'client' && st.days.includes(d)) || (d === today && st.status === 'job');
        if (!booked) continue;
        const state = d === today ? (st.doneToday ? 'done' : 'due') : 'later';
        days[d].push({ label, state, crew: d === today && st.crew >= 0 ? this.crew[st.crew]?.name : undefined });
      }
    });
    const forecast = this.forecast.map((w, k) => ({ day: k === 0 && this.phase !== 'evening' ? 'Today' : WEEKDAYS[(today + k) % 7], icon: WEATHER[w].icon, name: WEATHER[w].name, note: WEATHER[w].note }));
    return { week: this.weekNo, today, days, forecast };
  }

  private onKey = (code: string, e: KeyboardEvent) => {
    this.sfx.unlock();
    if (this.hud.overlayOpen && this.hud.key(code)) { e.preventDefault(); return; }
    if (code === 'KeyM') this.sfx.setMuted(!this.sfx.muted);
    if (code === 'KeyC' || code === 'Tab') { e.preventDefault(); this.toggleSchedule(); }
    if (this.phase === 'play' && (code === 'Escape' || code === 'KeyP')) this.pause();
    if (this.phase !== 'play') return;
    if (code === 'KeyE') this.riding ? this.dismount() : this.mount();
    if (code === 'KeyB' && this.riding) this.toggleBlades();
    if (code === 'KeyG') this.startPour();
  };

  // ================================================================ save
  private save() {
    try { localStorage.removeItem('li_save_v2'); } catch { /* storage blocked */ }
    const s: SaveFile = {
      v: 3, money: this.money, rep: this.rep, day: this.day, fuel: this.fuel, up: this.up,
      crew: this.crew.length, streets: this.world.streets.filter((x) => x.unlocked).length,
      forecast: this.forecast, week: this.week, hedges: this.world.hedges.map((h) => (h.shaggy ? 0 : h.regrow)),
      can: this.canFuel / Math.max(1, this.fuelMax),
      lots: this.lots.map((l) => ({
        status: l.status === 'job' || l.status === 'declined' ? 'prospect' : l.status,
        grumpy: l.grumpy, pay: l.pay, days: l.days, services: l.services, strikes: l.strikes, good: l.good, rivalDays: l.rivalDays, level: l.level,
      })),
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
  }

  private readSave(): SaveFile | null {
    try {
      const key = localStorage.getItem(SAVE_KEY) ? SAVE_KEY : 'li_save_v2';
      const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as (SaveFile & { v: number }) | null;
      if (!raw || (raw.v !== 3 && raw.v !== 2)) return null;
      // older saves predate the spare can: top it up
      if (raw.can === undefined) raw.can = CAN_FRACTION;
      raw.v = 3;
      return raw;
    } catch { return null; }
  }

  /** The mover you're controlling right now: the mower when riding, your feet when walking. */
  get active() { return this.riding ? this.mover : this.feet; }

  // ================================================================ frame
  private frame = (dt: number, t: number) => {
    this.grass.update(dt, t);
    const live = this.phase === 'play' || this.phase === 'dialog' || this.phase === 'tow';
    switch (this.phase) {
      case 'title': this.updateTitle(dt); break;
      case 'play': this.play(dt, t); break;
      case 'dialog': { const a = this.active; a.vx *= 0.8; a.vz *= 0.8; this.cam.update(dt, a.x, a.z); break; }
      case 'tow': this.updateTow(dt); break;
      default: break;
    }
    if (live) this.squash.update(dt);
    // the mower sits where it was parked while you walk
    if (this.riding) {
      poseBody(this.model.root, this.model.body, this.mover, this.squash);
      animateMower(this.model, this.mover.yaw, this.mover.vx, this.mover.vz, dt, t, live && this.phase !== 'tow', this.blades);
    } else {
      this.model.root.position.set(this.mowerPark.x, 0, this.mowerPark.z);
      this.model.root.rotation.y = this.mowerPark.yaw;
      this.model.body.position.y = 0;
      if (this.blades && live) this.model.blade.rotation.y += dt * 6;
      const lamp = this.model.bladeLamp.material as THREE.MeshStandardMaterial;
      lamp.color.set(this.blades ? '#7dff9a' : '#5a2b2b');
      lamp.emissive.set(this.blades ? '#7dff9a' : '#3a1414');
      lamp.emissiveIntensity = this.blades ? 0.8 : 0.3;
    }
    {
      const w = this.walker;
      w.root.visible = !this.riding;
      if (!this.riding) {
        poseBody(w.root, w.body, this.feet, this.squash);
        animateWalker(w, dt, this.feet.speed, this.phase === 'play', t);
      }
    }
    if (this.phase !== 'play') {
      for (const c of this.crew) c.npc.update(0, this.world, t);
      this.rival.npc.update(0, this.world, t);
    }
    this.updateWeather(dt, live);
    this.updateGnomes(dt);
    this.updateMarkers(t);
    this.updateFades(dt);
    this.updateLighting();
    this.leaves.update(dt, t, this.wx.wind, this.onLeafLand);
    if (this.phase === 'play') this.refillCanAtPump(dt);
    this.canModel.visible = this.canFuel > 0.02;
    if (this.canModel.visible) {
      if (this.riding) { this.canModel.position.set(this.mover.x + 0.62, 0.72, this.mover.z - 0.4); this.canModel.rotation.y = this.mover.yaw; }
      else { this.canModel.position.set(this.feet.x - 0.24, 0.35, this.feet.z); this.canModel.rotation.y = this.feet.yaw + Math.PI; }
    }
    this.clips.update(dt, this.mover.x, 0.4, this.mover.z);
    this.sparks.update(dt, this.mover.x, 0.4, this.mover.z);
    this.smoke.update(dt, this.mover.x, 0.9, this.mover.z);
    this.exhaustPuffs(dt);
    this.popups.update(dt, this.engine.camera);
    this.texT -= dt;
    if (this.texT <= 0) { this.texT = 0.1; this.grass.flush(); }
    this.hudT -= dt;
    if (this.hudT <= 0 && live) { this.hudT = 0.1; this.pushHud(); }
    this.mapT -= dt;
    if (this.mapT <= 0) { this.mapT = 0.2; this.drawMinimap(); }
  };

  /** A leaf just landed: a tiny puff of dust, and the lot it fell on gets it back. */
  private onLeafLand = (l: Leaf) => {
    if (Math.random() < 0.25) this.clips.spawn(l.x, 0.06, l.z, (Math.random() - 0.5) * 0.8, 0.4, (Math.random() - 0.5) * 0.8, 0.55, 0.35, 0.16, 0.06, 0.35, 9);
    const c = this.cellAt(l.x, l.z);
    const o = c >= 0 ? this.world.owner[c] : -1;
    if (o >= 0) l.lot = o; else l.alive = false;
  };

  private updateTitle(dt: number) {
    this.menuT += dt;
    const a = this.menuT * 0.06;
    const cam = this.engine.camera;
    cam.position.set(44 + Math.sin(a) * 46, 32, Math.cos(a) * 46);
    cam.lookAt(44, 0, 0);
  }

  private play(dt: number, t: number) {
    this.hour += dt / SEC_PER_HOUR;
    if (this.hour >= DAY_END) { this.hour = DAY_END; this.endDay(); return; }

    const inp = this.controls.read();
    this.boost = this.riding && inp.boost && inp.m > 0.1;
    const m = this.active;
    // rain makes the grass slick: slower to grip, slower to stop (better tyres help)
    const grip = this.riding && this.today === 'rain' ? 0.42 + 0.17 * this.up.tires : 1;
    if (this.riding) {
      m.o.maxSpeed = this.speedMax;
      m.o.accel = 10 * grip;
      m.o.decel = 7 * grip;
      m.o.turnRate = 10 * (0.55 + 0.45 * grip);
    }
    const hit = m.update(dt, inp.x, inp.z, inp.m, this.world, this.boost ? 1.35 : 1);
    this.bumpCd -= dt;
    if (hit.impact > 2.4 && this.bumpCd <= 0) this.bump(hit.impact, hit.nx, hit.nz);
    const frac = Math.min(1, m.speed / (this.riding ? this.speedMax : this.feet.o.maxSpeed));

    let cutNow = 0;
    if (this.riding) {
      cutNow = this.blades ? this.cutAround(dt) : this.idleDeck(dt);
      if (this.blades) this.deckBlast(dt); else this.pushLeaves(dt);
      this.squashFlowers();
      this.vacuumLeaves(dt);
      if (this.blades) this.trimHedges();
    } else {
      this.walkAbout(dt);
    }
    this.updateNpcs(dt, t);
    this.updateFuel(dt, frac, cutNow);
    if (this.phase !== 'play') return;

    const cell = this.cellAt(m.x, m.z);
    this.curLot = cell >= 0 ? this.world.owner[cell] : -1;
    this.checkKnock();
    this.checkT -= dt;
    if (this.checkT <= 0) { this.checkT = 0.2; this.checkJobs(); }

    if (this.riding) this.sfx.drone(0.45 + frac * 0.4 + Math.min(0.3, cutNow * 0.05), frac * (this.boost ? 1.3 : 1) + Math.min(0.5, cutNow * 0.06));
    else this.sfx.drone(0, 0);
    this.cam.update(dt, m.x, m.z, m.vx, m.vz, this.boost);
  }

  // ---------------------------------------------------------------- on foot
  /** Rough walking: brush the hedges and kick up any leaves you scuff through. */
  /** A wisp of exhaust from the pipe while the engine runs: grey, drifting up and back. */
  private exhaustPuffs(dt: number) {
    const running = this.riding || this.blades;
    if (!running) return;
    this.puffT -= dt;
    if (this.puffT > 0) return;
    this.puffT = 0.1 + Math.random() * 0.1;
    const m = this.mover;
    const p = this.model.pipeTip;
    // particle space is world space: the mower model sits at the mover's x/z
    const x = m.x + p.x, y = p.y + 0.25, z = m.z + p.z;
    const k = this.riding ? 0.5 : 0.75;
    this.smoke.spawn(x, y, z, (Math.random() - 0.5) * 0.3, 0.55 + Math.random() * 0.35, (Math.random() - 0.5) * 0.3,
      0.55 * k, 0.55 * k, 0.58 * k, 0.5 + Math.random() * 0.4, 0.55, 0);
  }

  private walkAbout(dt: number) {
    const f = this.feet;
    if (f.speed > 0.6) {
      this.leaves.gust(f.x, f.z, 0.55, 1.5, 0.7);
      this.squashFlowers();
      this.walkT -= dt;
      if (this.walkT <= 0) { this.walkT = 0.34; this.sfx.walk(Math.min(3, Math.floor(f.speed))); }
    }
    // the deck blast: leaves near the parked mower lift and tumble while the blades spin
    if (this.blades) {
      this.deckT -= dt;
      if (this.deckT <= 0) { this.deckT = 0.2; this.leaves.gust(this.mowerPark.x, this.mowerPark.z, 1.6, 1.2, 1.6); }
    }
    void dt;
  }

  /** Aim the deck at what is under it without turning the blade: pushes leaves around. */
  private idleDeck(dt: number) {
    const m = this.mover;
    const n = this.leaves.gust(m.x, m.z, 1.5, 0.9, 1.1);
    if (n > 0 && Math.random() < 0.3) this.sfx.leaf();
    void dt;
    return 0;
  }

  /** With the blades off the deck still shoves leaves along the grass at low speed. */
  private pushLeaves(dt: number) {
    const m = this.mover;
    if (m.speed < 0.3) return;
    this.deckT -= dt;
    if (this.deckT > 0) return;
    this.deckT = 0.12;
    this.leaves.gust(m.x, m.z, 1.3, 0.5, 1.0);
  }

  /** Dismount: park the mower where it stands and step off to the side. */
  dismount() {
    if (!this.riding || this.phase !== 'play') return;
    const m = this.mover;
    if (m.speed > 1.6) { this.hud.toast('Slow down before hopping off!', 'bad', 1800); return; }
    this.mowerPark = { x: m.x, z: m.z, yaw: m.yaw };
    const wasBlades = this.blades;
    this.blades = false;
    // step out to the mower's left, or right if that side is blocked
    const rx = Math.cos(m.yaw), rz = -Math.sin(m.yaw);
    const R = this.mover.o.radius + this.feet.o.radius + 0.15;
    this.riding = false;
    this.feet.place(m.x + rx * R, m.z + rz * R, m.yaw);
    this.feet.collide(this.world);
    this.squash.reset();
    this.squash.jump(2.6);
    this.sfx.dismount();
    this.cam.snap(this.feet.x, this.feet.z);
    this.popups.spawn('on foot', m.x, 1.6, m.z, '#e8f4ff', 0.9, 0.8);
    if (!this.walkHinted) {
      this.walkHinted = true;
      this.hud.toast('🚶 On foot. The mower idles but only sips fuel. Walk up to a door and knock. Press E to climb back on.', 'info', 4600);
    }
    if (wasBlades) {
      this.sfx.blade(false);
      this.hud.toast('🛑 Blades stopped so it is safe to walk around. Press B when you are back on.', 'info', 3600);
    }
  }

  /** Climb back on, if you're standing close enough. */
  mount() {
    if (this.riding || this.phase !== 'play') return;
    const p = this.mowerPark;
    const d = Math.hypot(this.feet.x - p.x, this.feet.z - p.z);
    if (d > 2.2) { this.hud.toast('Walk back to the mower and press E to climb on.', 'info', 2000); return; }
    this.riding = true;
    this.mover.place(p.x, p.z, p.yaw);
    this.squash.reset();
    this.squash.jump(2.2);
    this.sfx.mount();
    this.cam.snap(this.mover.x, this.mover.z);
  }

  /** Leaving the mower also means it can't cut: that's the trade for saving fuel. */
  private toggleBlades() {
    this.blades = !this.blades;
    this.sfx.blade(this.blades);
    if (this.blades) {
      this.popups.spawn('BLADES ON', this.mover.x, 1.9, this.mover.z, '#9dffb0', 0.9, 0.9);
    } else {
      this.popups.spawn('BLADES OFF', this.mover.x, 1.9, this.mover.z, '#ffd23a', 0.9, 0.9);
      if (!this.bladeHinted) {
        this.bladeHinted = true;
        this.hud.toast('🛑 Blades off: no cutting, but the engine burns less fuel. Press B to spin them up again.', 'info', 4200);
      }
    }
  }

  private cellAt(x: number, z: number) {
    const gx = Math.floor((x - MIN_X) / CELL), gz = Math.floor((z - MIN_Z) / CELL);
    return gx < 0 || gz < 0 || gx >= GW || gz >= GH ? -1 : gz * GW + gx;
  }

  // ---------------------------------------------------------------- mowing
  /** Cut lawn and edge cells within `R` of (cx, cz); only lot `only` if given. Returns the count. */
  private cutDisc(cx: number, cz: number, R: number, light: boolean, only = -1) {
    let n = 0;
    const g0x = Math.floor((cx - R - MIN_X) / CELL), g1x = Math.floor((cx + R - MIN_X) / CELL);
    const g0z = Math.floor((cz - R - MIN_Z) / CELL), g1z = Math.floor((cz + R - MIN_Z) / CELL);
    for (let gz = Math.max(0, g0z); gz <= Math.min(GH - 1, g1z); gz++) for (let gx = Math.max(0, g0x); gx <= Math.min(GW - 1, g1x); gx++) {
      const c = gz * GW + gx;
      const owner = this.world.owner[c];
      if (owner < 0 || (only >= 0 && owner !== only) || this.grass.isCut(c)) continue;
      if (this.world.kind[c] !== K_LAWN && !this.world.edge[c]) continue;
      if (Math.hypot(cellX(c) - cx, cellZ(c) - cz) > R) continue;
      const k = this.grass.cutCell(c, light);
      if (k === 'lawn') { this.lots[owner].cut++; n++; } else if (k === 'edge') { this.lots[owner].edgeCut++; n++; }
    }
    return n;
  }

  /** The spinning deck throws nearby leaves into the air; they tumble and land somewhere new. */
  private deckBlast(dt: number) {
    const m = this.mover;
    if (m.speed < 0.4) return;
    this.deckT -= dt;
    if (this.deckT > 0) return;
    this.deckT = 0.07;
    const n = this.leaves.gust(m.x, m.z, 2.1, 4.2 + m.speed * 0.5, 3.0 + m.speed * 0.45);
    if (n > 0) this.sfx.leaf();
  }

  private cutAround(dt: number) {
    const m = this.mover;
    const fx = Math.sin(m.yaw), fz = Math.cos(m.yaw);
    const light = Math.abs(m.vx) > Math.abs(m.vz) ? m.vx > 0 : m.vz < 0;
    const n = this.cutDisc(m.x + fx * 0.15, m.z + fz * 0.15, this.deckR, light);
    if (n > 0) {
      const rx = Math.cos(m.yaw), rz = -Math.sin(m.yaw);
      const ox = m.x + rx * 1.15 + fx * 0.15, oz = m.z + rz * 1.15 + fz * 0.15;
      for (let k = 0; k < Math.min(6, n * 2); k++) {
        const s = 3 + Math.random() * 3.5, sh = 0.75 + Math.random() * 0.4;
        this.clips.spawn(ox, 0.3, oz, rx * s + m.vx * 0.5 + (Math.random() - 0.5) * 1.5, 1.5 + Math.random() * 2, rz * s + m.vz * 0.5 + (Math.random() - 0.5) * 1.5,
          0.36 * sh, 0.62 * sh, 0.22 * sh, 0.07 + Math.random() * 0.06, 0.9 + Math.random() * 0.5, 9);
      }
      this.chopT -= dt;
      if (this.chopT <= 0) { this.chopT = 0.05; this.sfx.chop(Math.min(1, n / 6)); }
    }
    return n;
  }

  private squashFlowers() {
    const m = this.active;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const c = this.cellAt(m.x + dx * 0.55, m.z + dz * 0.55);
      if (c < 0 || this.world.kind[c] !== K_BED) continue;
      if (!this.flowers.squash(c)) continue;
      const st = this.lots[this.world.owner[c]];
      st.flowers++;
      st.grumpy = Math.min(1, st.grumpy + 0.03);
      this.sfx.crunch();
      this.cam.addTrauma(0.08);
      this.popups.spawn(this.isActive(st) ? '−$3' : 'oops!', cellX(c), 1, cellZ(c), '#ff8a7a', 0.8, 0.8);
      for (let k = 0; k < 5; k++) this.clips.spawn(cellX(c), 0.3, cellZ(c), (Math.random() - 0.5) * 3, 2 + Math.random() * 2, (Math.random() - 0.5) * 3, 1, 0.45, 0.65, 0.09, 0.7, 9);
    }
  }

  private vacuumLeaves(dt: number) {
    const m = this.mover, R = this.vacR;
    for (const l of this.leaves.list) {
      if (!l.alive) continue;
      const dx = m.x - l.x, dz = m.z - l.z;
      if (Math.abs(dx) > R * 2 || Math.abs(dz) > R * 2) continue;
      const d = Math.hypot(dx, dz);
      if (d > R * 1.9) continue;
      if (d < R * 0.6) {
        l.alive = false;
        this.clips.spawn(l.x, 0.1, l.z, dx * 2, 1.5, dz * 2, 0.85, 0.45, 0.15, 0.1, 0.35, 0, 30);
        this.leafT -= 1;
        if (this.leafT <= 0) { this.leafT = 3; this.sfx.leaf(); }
        continue;
      }
      const pull = (R * 1.9 - d) * 7 * dt;
      l.x += (dx / d) * Math.min(d, pull);
      l.z += (dz / d) * Math.min(d, pull);
      l.rot += dt * 8;
    }
  }

  /** Brushing along a shaggy hedge trims it. */
  private trimHedges() {
    const m = this.mover;
    for (const h of this.world.hedges) {
      if (!h.shaggy) continue;
      const b = h.box;
      if (m.x < b.minX - 2 || m.x > b.maxX + 2 || m.z < b.minZ - 2 || m.z > b.maxZ + 2) continue;
      const cx = clamp(m.x, b.minX, b.maxX), cz = clamp(m.z, b.minZ, b.maxZ);
      if (Math.hypot(m.x - cx, m.z - cz) > m.o.radius + 0.3) continue;
      this.trim(h, true);
    }
  }

  private trim(h: Hedge, fx: boolean) {
    h.shaggy = false;
    h.regrow = 5 + Math.floor(Math.random() * 3);
    h.tufts.visible = false;
    if (!fx) return;
    const b = h.box, x = (b.minX + b.maxX) / 2, z = (b.minZ + b.maxZ) / 2;
    this.sfx.trim();
    for (let k = 0; k < 14; k++) this.clips.spawn(x + (Math.random() - 0.5) * 0.6, 1.2 + Math.random() * 0.3, z + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 4, 1 + Math.random() * 2, (Math.random() - 0.5) * 4, 0.3, 0.55, 0.2, 0.1, 0.8, 9);
  }

  // ---------------------------------------------------------------- crew and rival
  private updateNpcs(dt: number, t: number) {
    // crew: each free helper takes the nearest booked lawn nobody is working on
    for (let i = 0; i < this.crew.length; i++) {
      const c = this.crew[i];
      if (c.lot < 0 && this.hour < DAY_END - 0.75) this.assignCrew(i);
      this.npcStep(c.npc, dt, t);
    }
    this.npcStep(this.rival.npc, dt, t);
    // nobody drives through anybody
    const all = [this.active, ...this.crew.map((c) => c.npc.mover), this.rival.npc.mover];
    this.npcBumpCd -= dt;
    for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) {
      const imp = separate(all[a], all[b]);
      if (a === 0 && imp > 2.5 && this.npcBumpCd <= 0) {
        this.npcBumpCd = 0.6;
        this.bump(imp, all[b].x - all[0].x, all[b].z - all[0].z);
        const isRival = all[b] === this.rival.npc.mover;
        this.popups.spawn(isRival ? 'HEY! 😠' : 'Easy, boss!', all[b].x, 2, all[b].z, isRival ? '#7fb2ff' : '#9dffb0', 1, 1);
        if (isRival) this.sfx.horn();
      }
    }
  }

  private npcStep(npc: Npc, dt: number, t: number) {
    npc.update(dt, this.world, t);
    const lot = npc.mowLot;
    if (lot < 0) return;
    const m = npc.mover;
    const light = Math.abs(m.vx) > Math.abs(m.vz) ? m.vx > 0 : m.vz < 0;
    const n = this.cutDisc(m.x + Math.sin(m.yaw) * 0.15, m.z + Math.cos(m.yaw) * 0.15, 0.95, light, lot);
    if (n > 0 && Math.random() < 0.5) {
      const rx = Math.cos(m.yaw), rz = -Math.sin(m.yaw);
      this.clips.spawn(m.x + rx * 1.1, 0.3, m.z + rz * 1.1, rx * 4, 2, rz * 4, 0.33, 0.58, 0.2, 0.08, 0.8, 9);
    }
  }

  private assignCrew(i: number) {
    const c = this.crew[i], m = c.npc.mover;
    let best = -1, bestD = Infinity;
    this.world.lots.forEach((lot, k) => {
      const st = this.lots[k];
      if (st.status !== 'client' || !this.isActive(st) || st.crew >= 0 || !this.open(lot)) return;
      if (st.cut / lot.lawnCells.length > 0.25) return; // you've started it yourself
      const d = Math.hypot(lot.centre.x - m.x, lot.centre.z - m.z);
      if (d < bestD) { bestD = d; best = k; }
    });
    if (best < 0) {
      if (!c.npc.busy && Math.hypot(m.x - i * 3, m.z - 1.6) > 3) c.npc.go([...this.exitWps(m.x, m.z), { x: i * 3, z: 1.6 }]);
      return;
    }
    const lot = this.world.lots[best];
    c.lot = best;
    this.lots[best].crew = i;
    const exit = this.exitWps(m.x, m.z);
    const from = exit.length ? exit[exit.length - 1] : { x: m.x, z: m.z };
    c.npc.go([...exit, ...routeTo(from.x, from.z, lot), ...mowPlan(lot)], () => this.crewFinished(i, best));
  }

  /** Waypoints to get out of whatever yard (x, z) is in. */
  private exitWps(x: number, z: number) {
    const c = this.cellAt(x, z);
    const o = c >= 0 ? this.world.owner[c] : -1;
    return o >= 0 && Math.abs(z - this.world.lots[o].zc) > 6 ? leaveLot(x, z, this.world.lots[o]) : [];
  }

  private crewFinished(i: number, k: number) {
    const c = this.crew[i];
    c.lot = -1;
    const st = this.lots[k];
    st.crew = -1;
    if (this.isActive(st)) this.completeVisit(this.world.lots[k], i);
  }

  /** Morning: the rival may set off to sign one of your prospects. You can race them to the door. */
  private sendRival() {
    if (!this.rival.active || Math.random() > Math.min(0.8, 0.3 + this.day * 0.04)) return;
    const pool = this.world.lots.filter((l) => this.open(l) && this.lots[l.id].status === 'prospect');
    if (!pool.length) return;
    const lot = pool[Math.floor(Math.random() * pool.length)];
    this.rival.target = lot.id;
    const npc = this.rival.npc;
    npc.go(routeTo(npc.mover.x, npc.mover.z, lot), () => this.rivalArrives(lot));
    setTimeout(() => {
      if (this.phase === 'play') this.hud.toast(`🚩 ${RIVAL}'s mower is heading for #${lot.number} ${this.world.streets[lot.street].name}. Beat them to the door!`, 'bad', 4200);
    }, 4400);
  }

  private rivalArrives(lot: Lot) {
    const st = this.lots[lot.id];
    const npc = this.rival.npc;
    const home = () => {
      const exit = leaveLot(npc.mover.x, npc.mover.z, lot);
      npc.go([...exit, { x: CROSS_MID, z: lot.zc + 1.6 }, { x: CROSS_MID, z: RIVAL_HOME.z }, RIVAL_HOME]);
    };
    this.rival.target = -1;
    if (st.status === 'prospect' || st.status === 'declined') {
      st.status = 'rival';
      st.rivalDays = 6 + Math.floor(Math.random() * 5);
      this.sfx.rejected();
      this.hud.toast(`🚩 ${RIVAL} signed #${lot.number} ${cap(lot.owner)} for ${st.rivalDays} days`, 'bad', 3600);
      this.notes.push(`🚩 Lost #${lot.number} to ${RIVAL}.`);
      npc.go(mowPlan(lot), home);
    } else {
      if (st.status === 'job' || st.status === 'client') this.hud.toast(`😎 You beat ${RIVAL} to #${lot.number}!`, 'good');
      home();
    }
  }

  // ---------------------------------------------------------------- fuel
  private nearestPump() {
    let best = this.world.streets[0].pump, bd = Infinity;
    for (const s of this.world.streets) {
      if (!s.unlocked) continue;
      const d = Math.hypot(this.mover.x - s.pump.x, this.mover.z - s.pump.z);
      if (d < bd) { bd = d; best = s.pump; }
    }
    return { pump: best, d: bd };
  }

  /**
   * Fuel burn. Idling sips, driving costs more, the blades cost extra, and mowing in long grass
   * costs a little more again. Walking to the door with the mower parked and the blades off is by
   * far the cheapest way to get around.
   */
  private updateFuel(dt: number, frac: number, cutNow: number) {
    if (this.riding) {
      let burn = BURN.idle + frac * (this.boost ? BURN.boost : BURN.drive);
      if (this.blades) burn += BURN.blades + (cutNow ? BURN.cut : 0);
      this.fuel -= burn * dt;
    } else if (this.blades) {
      // parked with the blades spinning: the deck keeps draining
      this.fuel -= BURN.blades * dt;
    }
    this.fuel = Math.max(0, this.fuel);
    this.refueling = false;
    this.pourUpdate(dt);

    const { pump, d } = this.nearestPump();
    if (d < PUMP_R && this.fuel < this.fuelMax - 0.05) {
      if (this.money <= 0.01) {
        if (!this.pumpHinted) { this.pumpHinted = true; this.hud.toast('No money for gas! Mow a lawn first.', 'bad'); }
      } else {
        let add = Math.min(this.fuelMax - this.fuel, 40 * dt);
        if (add * FUEL_PRICE > this.money) add = this.money / FUEL_PRICE;
        this.fuel += add;
        this.money -= add * FUEL_PRICE;
        this.refueling = true;
        this.glugT -= dt;
        if (this.glugT <= 0) { this.glugT = 0.14; this.sfx.glug(); }
        if (Math.random() < 0.3) this.sparks.spawn(pump.x + (Math.random() - 0.5), 0.6, pump.z + (Math.random() - 0.5), 0, 1.5, 0, 1, 0.82, 0.25, 0.14, 0.5, 0);
      }
    } else this.pumpHinted = false;
    const f = this.fuel / this.fuelMax;
    if (f < 0.2 && !this.fuelWarned) {
      this.fuelWarned = true;
      this.sfx.deny();
      if (this.canFuel > 0.5) this.hud.toast('⛽ Low on gas! Park up and press G to pour the spare can in, or head to a pump.', 'bad', 4200);
      else this.hud.toast('⛽ Low on gas! Head to a pump (west end of each street)', 'bad');
    }
    if (f > 0.5) this.fuelWarned = false;
    // a dry tank with a can in the back isn't the end of the day any more
    if (this.fuel <= 0 && this.canFuel > 0.5) {
      this.fuel = 0;
      if (!this.canHinted) {
        this.canHinted = true;
        this.sfx.sputter();
        this.hud.toast('🛢️ Out of gas — but you have the spare can. Press G to pour it in!', 'bad', 5000);
      }
      if (!this.pouring) { this.mover.vx *= 1 - 6 * dt; this.mover.vz *= 1 - 6 * dt; }
      return;
    }
    if (this.fuel <= 0) {
      this.fuel = 0;
      this.phase = 'tow';
      this.towT = 2.4;
      this.sfx.sputter();
      this.sfx.drone(0, 0);
      this.hud.toast(`⛽ Out of gas! Towing you to the nearest pump (−$${TOW_FEE})`, 'bad', 3000);
    }
  }

  /** G: pour the spare can into the tank (takes a moment, and only works parked). */
  private startPour() {
    if (this.phase !== 'play') return;
    if (this.pouring > 0) return;
    if (this.canFuel <= 0.5) { this.hud.toast('The spare can is empty. Fill it at a pump by parking next to one.', 'bad', 2600); return; }
    if (this.fuel >= this.fuelMax - 1) { this.hud.toast('The tank is already full.', 'info', 1800); return; }
    if (this.mover.speed > 1.2) { this.hud.toast('Stop the mower before pouring fuel.', 'info', 1800); return; }
    if (!this.riding && Math.hypot(this.feet.x - this.mowerPark.x, this.feet.z - this.mowerPark.z) > 2.4) {
      this.hud.toast('Walk back to the mower to pour the can into it.', 'info', 2200);
      return;
    }
    this.pouring = CAN_POUR_TIME;
    this.sfx.pour();
    this.popups.spawn('pouring…', this.mover.x, 1.9, this.mover.z, '#ffd23a', 0.9, 1.2);
  }

  private pourUpdate(dt: number) {
    if (this.pouring <= 0) return;
    this.pouring -= dt;
    const room = this.fuelMax - this.fuel;
    const move = Math.min(room, this.canFuel, (this.fuelMax / CAN_POUR_TIME) * dt * 0.55);
    this.fuel += move;
    this.canFuel -= move;
    this.glugT -= dt;
    if (this.glugT <= 0) {
      this.glugT = 0.12;
      this.sfx.glug();
      this.sparks.spawn(this.mover.x + (Math.random() - 0.5) * 0.5, 0.9, this.mover.z + (Math.random() - 0.5) * 0.5, 0, 1.2, 0, 1, 0.85, 0.35, 0.12, 0.4, 0);
    }
    if (Math.random() < 0.5) {
      const p = this.model.pipeTip;
      this.sparks.spawn(this.mover.x + p.x * 0.4, 1.05, this.mover.z + 0.2, (Math.random() - 0.5) * 0.4, -2.5, (Math.random() - 0.5) * 0.4, 1, 0.8, 0.25, 0.1, 0.35, 9);
    }
    if (this.pouring <= 0 || room - move <= 0.02 || this.canFuel <= 0.02) {
      this.pouring = 0;
      if (this.canFuel <= 0.5) this.canFuel = 0;
      this.canHinted = false;
      this.sfx.cash();
      this.hud.toast(this.canFuel > 0.5 ? '🛢️ Topped up. Still some left in the can.' : '🛢️ Spare can empty — fill it up at a pump.', 'good', 2600);
    }
  }

  /** At a pump with the can empty and the tank full, the can refills for free as part of the stop. */
  private refillCanAtPump(dt: number) {
    const { d } = this.nearestPump();
    if (d >= PUMP_R) return;
    if (this.canFuel >= this.fuelMax * CAN_FRACTION - 0.5) return;
    this.canFuel = Math.min(this.fuelMax * CAN_FRACTION, this.canFuel + (this.fuelMax * CAN_FRACTION) / 6 * dt);
  }

  private updateTow(dt: number) {
    const m = this.mover;
    m.vx *= 1 - 3 * dt; m.vz *= 1 - 3 * dt;
    m.integrate(dt, this.world);
    this.cam.update(dt, m.x, m.z, m.vx, m.vz);
    this.towT -= dt;
    if (this.towT > 0) return;
    this.money = Math.max(0, this.money - TOW_FEE);
    this.fuel = this.fuelMax * 0.3;
    const { pump } = this.nearestPump();
    if (!this.riding) { this.riding = true; }
    m.place(pump.x + 0.2, pump.z, Math.PI / 2);
    this.mowerPark = { x: m.x, z: m.z, yaw: m.yaw };
    this.cam.snap(m.x, m.z);
    this.squash.jump(3);
    this.phase = 'play';
  }

  private placeAtPump() {
    this.riding = true;
    this.blades = true;
    this.pouring = 0;
    this.mover.place(PUMP.x + 0.2, PUMP.z, Math.PI / 2);
    this.mowerPark = { x: this.mover.x, z: this.mover.z, yaw: this.mover.yaw };
    this.feet.place(this.mover.x, this.mover.z, Math.PI / 2);
  }

  // ---------------------------------------------------------------- knocking and bookings
  private checkKnock() {
    const m = this.active;
    let inZone = -1;
    for (const lot of this.world.lots) if (Math.abs(m.x - lot.door.x) < 2 && Math.abs(m.z - lot.door.z) < 2 && Math.hypot(m.x - lot.door.x, m.z - lot.door.z) < 1.15) inZone = lot.id;
    if (inZone < 0) { this.knockLock = -1; return; }
    if (this.knockLock === inZone) return;
    this.knockLock = inZone;
    this.knock(this.world.lots[inZone]);
  }

  private knock(lot: Lot) {
    const st = this.lots[lot.id];
    const who = cap(lot.owner);
    if (st.status === 'job') { this.hud.toast(`${who}: "Well? The lawn won't mow itself!"`); return; }
    if (st.status === 'client') {
      if (!st.days.includes(this.weekday)) this.hud.toast(`${who}: "You're not booked today, dear. See you ${dayList(st.days)}!"`);
      else this.hud.toast(st.doneToday ? `${who}: "Looks great, see you ${dayList(st.days)}!"` : `${who}: "There's my lawn crew! The usual, please."`, st.doneToday ? 'good' : 'info');
      return;
    }
    if (st.status === 'rival') { this.hud.toast(`${who}: "Sorry, we signed with ${RIVAL}. Try again in ${st.rivalDays} day${st.rivalDays > 1 ? 's' : ''}."`, 'bad'); return; }
    // somebody who said no this morning gets one more go in the afternoon, for a price
    if (st.status === 'declined') {
      if (st.tries > 0 && this.hour < DAY_END - 1.25) {
        this.sfx.knock();
        this.phase = 'dialog';
        this.openPitch(lot);
        return;
      }
      this.hud.toast(`No answer at #${lot.number}. They already said no today.`);
      return;
    }
    this.sfx.knock();
    this.phase = 'dialog';
    if (this.hour > DAY_END - 1.25) {
      this.hud.dialog(`#${lot.number} · ${who}`, '"Bit late in the day for that, isn\'t it? Come back tomorrow."', [
        { label: 'OK', key: '⏎', primary: true, onPick: () => this.closeDialog() },
      ]);
      return;
    }
    this.openPitch(lot);
  }

  /** The pitch card: full price, a discount, or a haggle. */
  private openPitch(lot: Lot) {
    const st = this.lots[lot.id];
    if (st.status === 'prospect') { st.tries = 0; st.asked = 0; st.offer = null; }
    const who = cap(lot.owner);
    const offer = st.offer ??= this.makeOffer(lot);
    const due = this.dueTime(lot, offer.services);
    const svc = ['🌱 mow', offer.services.sweep && '🍂 clear leaves', offer.services.edge && '📏 edge the paths', offer.services.hedge && '✂️ trim hedges'].filter(Boolean).join(' · ');
    const load = offer.days.map((d) => {
      const n = this.lots.filter((l) => l.status === 'client' && l.days.includes(d)).length;
      return `${WEEKDAYS[d]} <small>(${n} booked)</small>`;
    }).join(', ');
    const mood = st.grumpy > 0.6 ? 'They look grumpy.' : st.grumpy < 0.25 ? 'They seem friendly.' : 'They look busy.';
    const sample = st.cut / Math.max(1, lot.lawnCells.length) > 0.5;
    const again = st.tries > 0;
    const body = `<i>*knock knock*</i> ${who} opens the door. ${mood}` +
      (again ? '<br><i>"You again? Fine — what is it?"</i>' : '') +
      (sample ? '<br>"Oh! Did you already do half my lawn?"' : '') +
      `<div class="offer"><div><b>📅 ${offer.days.length}× a week:</b> ${load}</div><div><b>Each visit:</b> ${svc}</div>` +
      `<div><b>Trial visit:</b> today, done by ${fmtHour(due)}</div>` +
      (again ? '<div class="haggle">They are already fed up. Haggle too often and they will show you the door.</div>' : '') + '</div>';
    const opts: DialogOption[] = [];
    const base = this.odds(st, true);
    const cheap = Math.round(offer.price * 0.75);
    const disc = this.odds(st, false);
    opts.push({ label: `Pitch $${offer.price}/visit`, sub: `${Math.round(base * 100)}% chance`, key: '1', primary: true, onPick: () => this.pitch(lot, offer, offer.price, base, due) });
    opts.push({ label: `Discount $${cheap}/visit`, sub: `${Math.round(disc * 100)}% chance`, key: '2', onPick: () => this.pitch(lot, offer, cheap, disc, due) });
    // once they've turned you down, you can keep pushing on price or on what the job includes
    if (st.tries > 0) {
      const less: (Offer & { blurb: string }) | null = this.cheaperJob(offer);
      if (less) {
        opts.push({
          label: `Haggle: $${less.price} for less`, sub: less.blurb, key: '3', onPick: () => this.haggle(lot, less, due),
        });
      }
      opts.push({ label: 'Sweeten the deal (+$10)', sub: `raise the odds, ${'$'}10 off the first visit`, key: '4', onPick: () => this.sweeten(lot) });
      opts.push({ label: 'Try again for full price', sub: `${Math.round(base * 100)}% chance`, key: '5', onPick: () => this.pitch(lot, offer, offer.price, base, due) });
    }
    opts.push({ label: again ? 'Give up' : 'Leave', key: 'Esc', onPick: () => this.retreat(lot) });
    this.hud.dialog(`#${lot.number} ${this.world.streets[lot.street].name} · ${who}`, body, opts);
  }

  /** Odds of a yes. `full` uses the asking price; otherwise the discounted one. */
  private odds(st: LotState, full: boolean) {
    const sample = st.cut > 0;
    const rookie = this.regulars ? 0 : 0.15;
    const base = clamp(0.4 + rookie + (this.rep - 3) * 0.12 - st.grumpy * 0.3 + (sample ? 0.25 : 0), 0.05, 0.95);
    return full ? base : clamp(base + 0.25, 0.05, 0.97);
  }

  /** A cheaper version of the same job: drop a service or a weekly visit. Null if there's nothing to drop. */
  private cheaperJob(offer: Offer): (Offer & { blurb: string; key: string }) | null {
    const drops: string[] = [];
    if (offer.services.hedge) drops.push('hedge');
    if (offer.services.edge) drops.push('edge');
    if (offer.services.sweep) drops.push('sweep');
    if (offer.days.length > 1) drops.push('visit');
    if (!drops.length) return null;
    const what = drops[0];
    const services = { ...offer.services };
    let days = offer.days;
    let price = offer.price;
    if (what === 'visit') { days = offer.days.slice(0, offer.days.length - 1); price = Math.round(price * 0.72); }
    else {
      (services as unknown as Record<string, boolean>)[what] = false;
      price = Math.round(price - (what === 'hedge' ? 12 : what === 'edge' ? 9 : 10));
    }
    const blurb = what === 'visit' ? `${days.length}× a week instead of ${offer.days.length}` : `no ${what === 'sweep' ? 'leaf clearing' : what === 'edge' ? 'edging' : 'hedge trimming'}`;
    return { price, days, services, blurb, key: what };
  }

  private haggle(lot: Lot, less: Offer & { blurb: string }, due: number) {
    const st = this.lots[lot.id];
    // dropping the price of the *whole* job reads as a real concession
    const chance = clamp(0.55 + (this.rep - 3) * 0.08 - st.grumpy * 0.15, 0.25, 0.92);
    if (Math.random() < chance) {
      this.sign(lot, less, less.price, due);
      this.hud.toast(`🤝 They took the smaller job: $${less.price}/visit, ${less.blurb}`, 'good', 4200);
    } else this.turnedDown(lot, 'haggle');
  }

  private sweeten(lot: Lot) {
    const st = this.lots[lot.id];
    if (this.money < 10) { this.sfx.deny(); this.hud.toast("You haven't got $10 to spare.", 'bad', 1800); return; }
    this.money -= 10;
    st.grumpy = Math.max(0, st.grumpy - 0.35);
    st.sweetened = true;
    this.sfx.hmm();
    this.closeDialog();
    this.phase = 'play';
    this.hud.toast('🍪 You offer to waive the first visit. They soften a little.', 'info', 2400);
    setTimeout(() => { if (this.phase === 'play' && st.status !== 'client') { st.status = 'prospect'; this.phase = 'dialog'; this.openPitch(lot); } }, 900);
  }

  private retreat(lot: Lot) {
    const st = this.lots[lot.id];
    if (st.tries > 0) st.status = 'declined';
    this.closeDialog();
  }

  /** They said no. Remember it so the next knock can haggle, and close the door after too many tries. */
  private turnedDown(lot: Lot, why: 'pitch' | 'haggle') {
    const st = this.lots[lot.id];
    st.tries++;
    st.grumpy = Math.min(1, st.grumpy + (why === 'haggle' ? 0.18 : 0.08));
    st.status = 'declined';
    this.sfx.rejected();
    this.closeDialog();
    const line = st.tries >= 3
      ? '"That\'s enough now. Goodbye." *door closes firmly*'
      : why === 'haggle'
        ? '"That is still too rich for my blood. Come back with a better offer."'
        : NO_THANKS[Math.floor(Math.random() * NO_THANKS.length)];
    this.hud.toast(`🚪 ${cap(lot.owner)}: ${line}`, 'bad', 3600);
    if (st.tries < 3) setTimeout(() => this.hud.toast('💬 Knock again to haggle — offer less, or drop a service.', 'info', 3400), 1400);
    else { st.grumpy = 1; this.rep = clamp(this.rep - 0.1, 0, 5); }
  }

  /** What this owner wants: how often, which weekdays, which services, and the going rate. */
  private makeOffer(lot: Lot): Offer {
    const r = Math.random();
    const freq = r < 0.45 ? 1 : r < 0.85 ? 2 : 3;
    const s = Math.floor(Math.random() * 7);
    const days = (freq === 1 ? [s] : freq === 2 ? [s, (s + 3 + Math.floor(Math.random() * 2)) % 7] : [s, (s + 2) % 7, (s + 4) % 7]).sort((a, b) => a - b);
    const services: Services = { sweep: Math.random() < 0.5, edge: Math.random() < 0.45, hedge: Math.random() < 0.4 };
    const area = lot.lawnCells.length * CELL * CELL;
    const raw = 8 + area * 0.075 + (services.sweep ? 9 : 0) + (services.edge ? lot.edgeCells.length * 0.06 : 0) + (services.hedge ? 10 : 0);
    const price = Math.round(raw * (0.85 + this.rep * 0.05) * (freq === 3 ? 0.9 : 1));
    return { price, days, services };
  }

  private dueTime(lot: Lot, sv: Services) {
    const area = lot.lawnCells.length * CELL * CELL;
    const extra = (sv.sweep ? 0.3 : 0) + (sv.edge ? 0.4 : 0) + (sv.hedge ? 0.4 : 0);
    return Math.min(DAY_END, Math.ceil((this.hour + 2 + area / 250 + extra) * 2) / 2);
  }

  private pitch(lot: Lot, offer: Offer, price: number, chance: number, due: number) {
    if (Math.random() < chance) this.sign(lot, offer, price, due);
    else this.turnedDown(lot, 'pitch');
  }

  /** Sign them up: the trial visit today, then the regular bookings. */
  private sign(lot: Lot, offer: Offer, price: number, due: number) {
    const st = this.lots[lot.id];
    this.closeDialog();
    st.status = 'job';
    st.pay = price;
    st.deadline = due;
    st.days = offer.days;
    st.services = offer.services;
    st.strikes = 0;
    st.good = 0;
    st.tries = 0;
    this.sfx.hired();
    this.squash.jump(3.5);
    const m = this.mover;
    this.sparks.burst(m.x, 1, m.z, 20, 4, 0.4, 1, 0.5, 0.25, 0.7, 6);
    this.hud.toast(`🤝 Hired! Trial visit by ${fmtHour(due)}, then every ${dayList(offer.days)} for $${price}`, 'good', 4200);
  }

  private closeDialog() {
    this.hud.close();
    this.phase = 'play';
    this.engine.resetClock();
  }

  private remaining(lot: Lot) {
    const st = this.lots[lot.id];
    return {
      lawn: st.cut / lot.lawnCells.length,
      leaves: st.services.sweep ? this.leaves.left(lot.id) : null,
      edge: st.services.edge ? (lot.edgeCells.length ? st.edgeCut / lot.edgeCells.length : 1) : null,
      hedges: st.services.hedge ? lot.hedges.filter((h) => h.shaggy).length : null,
    };
  }

  private checkJobs() {
    this.world.lots.forEach((lot, i) => {
      const st = this.lots[i];
      if (!this.isActive(st)) return;
      if (st.status === 'job' && this.hour > st.deadline) {
        st.status = 'declined';
        st.grumpy = Math.min(1, st.grumpy + 0.2);
        this.rep = clamp(this.rep - 0.4, 0, 5);
        this.sfx.rejected();
        this.hud.toast(`⌛ Too late! ${cap(lot.owner)} at #${lot.number} cancelled the trial`, 'bad', 3400);
        this.notes.push(`⌛ Missed the trial deadline at #${lot.number}.`);
        return;
      }
      if (st.crew >= 0) return; // crew are on it
      const r = this.remaining(lot);
      if (r.lawn >= 0.95 && (r.leaves === null || r.leaves <= 1) && (r.edge === null || r.edge >= 0.9) && (r.hedges === null || r.hedges === 0)) this.completeVisit(lot, -1);
    });
  }

  /** A visit is finished, by you (crew = -1) or a crew member: tidy up, get paid, update the books. */
  private completeVisit(lot: Lot, crew: number) {
    const st = this.lots[lot.id];
    let k = 0;
    for (const c of [...lot.lawnCells, ...lot.edgeCells]) {
      const r = this.grass.cutCell(c, (Math.floor(cellX(c)) & 1) === 0);
      if (r === 'lawn') st.cut++; else if (r === 'edge') st.edgeCut++;
      if (r && crew < 0 && k++ % 4 === 0) this.sparks.spawn(cellX(c), 0.2, cellZ(c), 0, 1.5 + Math.random() * 2, 0, 1, 0.9, 0.4, 0.18, 0.8, -0.5);
    }
    if (st.services.sweep || crew >= 0) for (const l of this.leaves.list) if (l.lot === lot.id) l.alive = false;
    if (st.services.hedge) for (const h of lot.hedges) if (h.shaggy) this.trim(h, false);
    st.crew = -1;
    const byYou = crew < 0;
    const early = this.hour <= st.deadline - (st.status === 'job' ? 1 : 4);
    const tip = byYou && early ? Math.round(st.pay * 0.2) : 0;
    const damage = st.flowers * 3 + (st.gnome ? 10 : 0);
    const total = Math.max(0, st.pay + tip - damage);
    const rating = byYou ? clamp(5 - Math.min(2, st.flowers * 0.25) - (st.gnome ? 1 : 0) - (early ? 0 : 0.5), 1, 5) : 4.3;
    this.rep = clamp(this.rep * 0.85 + rating * 0.15, 0, 5);
    this.money += total;
    this.earnedToday += total;
    this.mownToday++;
    st.doneToday = true;
    st.level = 0.08;
    this.week[`${this.weekday}:${lot.id}`] = 'done';
    if (++st.good >= 2 && st.strikes > 0) { st.strikes--; st.good = 0; }
    const firstTime = st.status === 'job';
    st.status = 'client';
    const extra = [tip ? `+$${tip} tip` : '', damage ? `−$${damage} damages` : ''].filter(Boolean).join(', ');
    if (byYou) {
      this.sfx.done();
      this.sfx.cash();
      this.cam.addTrauma(0.3);
      this.squash.jump(4);
      this.popups.spawn(`+$${total}`, this.mover.x, 2.2, this.mover.z, '#ffe066', 1.6, 1.6);
      for (let n = 0; n < 50; n++) {
        const c = lot.lawnCells[Math.floor(Math.random() * lot.lawnCells.length)];
        this.sparks.spawn(cellX(c), 0.2, cellZ(c), 0, 2 + Math.random() * 3, 0, 0.6, 1, 0.5, 0.25, 1 + Math.random(), -0.5);
      }
      this.hud.toast(`✨ #${lot.number} done! $${total}${extra ? ` (${extra})` : ''} · ${'★'.repeat(Math.round(rating))}`, 'big');
      if (firstTime) setTimeout(() => this.hud.toast(`📅 New regular! ${cap(lot.owner)}: every ${dayList(st.days)}`, 'good', 3600), 1600);
    } else {
      this.sfx.cash();
      this.hud.toast(`👷 ${this.crew[crew].name} finished #${lot.number}: +$${total}`, 'good');
    }
    this.notes.push(`✅ #${lot.number} ${cap(lot.owner)}${byYou ? '' : ` (by ${this.crew[crew].name})`}: $${total}${extra ? ` (${extra})` : ''}`);
    this.checkUnlocks();
  }

  // ---------------------------------------------------------------- bumps, gnomes
  private bump(impact: number, nx: number, nz: number) {
    this.bumpCd = 0.25;
    const k = Math.min(1, impact / 8);
    this.cam.addTrauma(0.1 + k * 0.3);
    this.sfx.bump(k);
    this.squash.squash(-(2 + k * 4));
    const l = Math.hypot(nx, nz) || 1;
    const cx = this.mover.x - (nx / l) * 0.8, cz = this.mover.z - (nz / l) * 0.8;
    for (let i = 0; i < 5 + k * 12; i++) {
      const a = Math.atan2(nz, nx) + (Math.random() - 0.5) * 2.2, s = 2 + Math.random() * 4 * k;
      this.sparks.spawn(cx, 0.4, cz, Math.cos(a) * s, 1 + Math.random() * 3, Math.sin(a) * s, 1, 0.85, 0.4, 0.12 + Math.random() * 0.08, 0.35, 10);
    }
    if (impact > 5.5 && Math.random() < 0.5) this.popups.spawn(['BONK!', 'CLUNK!', 'OOF!'][Math.floor(Math.random() * 3)], this.mover.x, 1.8, this.mover.z, '#ffe27a', 0.8, 0.9);
  }

  private buildGnomes() {
    const lam = (c: string) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, metalness: 0.02 });
    const ceramic = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.28, metalness: 0.05 });
    for (const lot of this.world.lots) for (const s of lot.gnomeSpots) {
      const g = new THREE.Group();
      // body: blue tunic, boots, a white beard and a pointed red hat, on a little base
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.06, 12), lam('#b9b2a4'));
      base.position.y = 0.03;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.19, 0.36, 12), lam('#2f6fb5'));
      body.position.y = 0.24;
      for (const x of [-0.08, 0.08]) {
        const boot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.14), lam('#3b2b20'));
        boot.position.set(x, 0.09, 0.04);
        g.add(boot);
      }
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), lam('#f0c19a'));
      head.position.y = 0.5;
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), lam('#e8a882'));
      nose.position.set(0, 0.49, 0.115);
      const beard = new THREE.Mesh(new THREE.ConeGeometry(0.115, 0.26, 10), ceramic);
      beard.position.set(0, 0.4, 0.06);
      beard.rotation.x = Math.PI;
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.135, 0.38, 12), new THREE.MeshStandardMaterial({ color: '#d23a2c', roughness: 0.35, metalness: 0.05 }));
      hat.position.y = 0.76;
      hat.rotation.z = 0.08;
      const hatTip = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 5), ceramic);
      hatTip.position.set(0.03, 0.95, 0);
      g.add(base, body, head, nose, beard, hat, hatTip);
      g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.world.scene.add(g);
      this.gnomes.push({ obj: g, hx: s.x, hz: s.z, x: s.x, z: s.z, vx: 0, vz: 0, spin: 0, tip: 0, knocked: false, lot: lot.id });
    }
    this.resetGnomes();
  }

  private resetGnomes() {
    for (const g of this.gnomes) {
      Object.assign(g, { x: g.hx, z: g.hz, vx: 0, vz: 0, spin: 0, tip: 0, knocked: false });
      g.obj.position.set(g.x, 0, g.z);
      g.obj.rotation.set(0, Math.random() * 6, 0);
    }
  }

  private updateGnomes(dt: number) {
    const m = this.active;
    for (const g of this.gnomes) {
      if (!g.knocked && this.phase === 'play' && Math.abs(g.x - m.x) < 2 && Math.abs(g.z - m.z) < 2) {
        const dx = g.x - m.x, dz = g.z - m.z, d = Math.hypot(dx, dz);
        if (d < m.o.radius + 0.25) {
          g.knocked = true;
          const sp = Math.max(3, m.speed * 1.4);
          g.vx = (dx / (d || 1)) * sp + m.vx * 0.5;
          g.vz = (dz / (d || 1)) * sp + m.vz * 0.5;
          g.spin = (Math.random() - 0.5) * 14;
          const st = this.lots[g.lot];
          st.gnome = true;
          st.grumpy = Math.min(1, st.grumpy + 0.15);
          this.sfx.gnome();
          this.cam.addTrauma(0.2);
          this.squash.squash(-3);
          this.popups.spawn(this.isActive(st) ? 'GNOME! −$10' : 'GNOME!', g.x, 1.4, g.z, '#ff8a7a', 1.1, 1);
        }
      }
      if (!g.knocked) continue;
      g.x += g.vx * dt; g.z += g.vz * dt;
      g.vx *= 1 - 2.5 * dt; g.vz *= 1 - 2.5 * dt; g.spin *= 1 - 2 * dt;
      g.tip = Math.min(Math.PI / 2, g.tip + dt * 7);
      g.obj.position.set(g.x, 0.12 * Math.sin(g.tip), g.z);
      g.obj.rotation.y += g.spin * dt;
      g.obj.rotation.x = g.tip;
    }
  }

  // ---------------------------------------------------------------- visuals
  private updateWeather(dt: number, live: boolean) {
    const w = this.phase === 'title' ? 'sunny' : this.today;
    const k = Math.min(1, dt * 0.8);
    this.wx.rain += ((w === 'rain' ? 1 : 0) - this.wx.rain) * k;
    this.wx.cloud += ((w === 'rain' ? 1 : w === 'cloudy' ? 0.6 : w === 'windy' ? 0.3 : 0) - this.wx.cloud) * k;
    this.wx.wind += ((w === 'windy' ? 2.6 : w === 'rain' ? 1.5 : 1) - this.wx.wind) * k;
    this.grass.wind.value = this.wx.wind;
    const m = this.mover;
    this.rain.update(dt, m.x, m.z, this.wx.rain, (x, z) => this.sparks.spawn(x, 0.05, z, 0, 0.8, 0, 0.75, 0.85, 1, 0.08, 0.25, 6));
    this.sfx.rain(live ? this.wx.rain : 0);
    if (this.phase === 'play' && w === 'windy') {
      this.windT -= dt;
      if (this.windT <= 0) {
        this.windT = 0.35;
        const open = this.world.lots.filter((l) => this.open(l));
        const lot = open[Math.floor(Math.random() * open.length)];
        this.leaves.drop(lot);
        // now and then a whole drift lifts off and swirls
        if (Math.random() < 0.5) {
          const c = lot.pavedCells[Math.floor(Math.random() * lot.pavedCells.length)];
          this.leaves.gust(cellX(c), cellZ(c), 5.5, 6.5, 3.2, lot.id);
        }
      }
    }
  }

  private buildMarkers() {
    const mk = (ch: string, bg: string, fg = '#fff', size = 72) => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d')!;
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.arc(64, 68, 54, 0, Math.PI * 2); g.fill();
      g.fillStyle = bg;
      g.beginPath(); g.arc(64, 62, 54, 0, Math.PI * 2); g.fill();
      g.lineWidth = 6; g.strokeStyle = '#fff'; g.stroke();
      g.fillStyle = fg;
      g.font = `900 ${size}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(ch, 64, 66);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    this.markerTex = {
      prospect: mk('!', '#f2a91e'), declined: mk('✕', '#8a8f98'), job: mk('$', '#24a35a'), due: mk('$', '#2b7de0'),
      done: mk('✓', '#24a35a'), booked: mk('📅', '#e8eef6', '#fff', 60), rival: mk('G', '#2b6fd6', '#9be15d'),
    };
    for (const lot of this.world.lots) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.markerTex.prospect, depthTest: false, transparent: true }));
      s.position.set(lot.door.x, 4.6, lot.door.z);
      s.scale.set(1.5, 1.5, 1);
      s.renderOrder = 30;
      this.world.scene.add(s);
      this.markers.push(s);
    }
  }

  private markerKey(st: LotState) {
    if (st.status === 'client') return st.doneToday ? 'done' : st.days.includes(this.weekday) ? 'due' : 'booked';
    return st.status;
  }

  private updateMarkers(t: number) {
    this.world.lots.forEach((lot, i) => {
      const s = this.markers[i];
      s.visible = this.open(lot);
      if (!s.visible) return;
      const key = this.markerKey(this.lots[i]);
      const mat = s.material;
      if (mat.map !== this.markerTex[key]) { mat.map = this.markerTex[key]; mat.needsUpdate = true; }
      const urgent = key === 'job' || key === 'due';
      const pulse = urgent ? 1 + Math.sin(t * 5 + i) * 0.1 : 1;
      const small = key === 'declined' || key === 'done' || key === 'booked' || key === 'rival';
      const sc = (small ? 1.1 : 1.5) * pulse;
      s.scale.set(sc, sc, 1);
      mat.opacity = key === 'declined' || key === 'booked' ? 0.6 : 1;
      s.position.set(lot.door.x, 4.6 + Math.sin(t * 2.2 + i) * 0.18, lot.door.z);
      const near = Math.hypot(this.active.x - lot.door.x, this.active.z - lot.door.z);
      if (this.phase !== 'title') mat.opacity *= clamp((near - 2) / 4, 0.15, 1);
    });
    for (const s of this.world.streets) {
      const p = s.pump;
      const pulse = 0.5 + 0.5 * Math.sin(t * (this.refueling ? 9 : 2.5));
      p.ringMat.opacity = s.unlocked ? 0.35 + pulse * 0.4 + (this.fuel / this.fuelMax < 0.2 ? 0.25 : 0) : 0.1;
      const rs = 1 + pulse * 0.06;
      p.ring.scale.set(rs, rs, rs);
    }
  }

  /** Houses and tree crowns between the camera and the mower go see-through. */
  private updateFades(dt: number) {
    const m = this.active, k = Math.min(1, dt * 8);
    const playing = this.phase !== 'title';
    for (const lot of this.world.lots) {
      const b = lot.houseBox;
      const hide = playing && m.x > b.minX - 1.5 && m.x < b.maxX + 1.5 && b.maxZ > m.z - 0.5 && b.minZ < m.z + 7;
      const target = hide ? 0.22 : 1;
      if (Math.abs(lot.fade - target) < 0.002) continue;
      lot.fade += (target - lot.fade) * k;
      for (const mat of lot.houseMats) mat.opacity = lot.fade;
    }
    for (const tr of this.world.trees) {
      const hide = playing && Math.abs(tr.x - m.x) < 2.8 && tr.z > m.z - 2.5 && tr.z < m.z + 6.5;
      const target = hide ? 0.25 : 1;
      if (Math.abs(tr.fade - target) < 0.002) continue;
      tr.fade += (target - tr.fade) * k;
      tr.mat.opacity = tr.fade;
      tr.mat.depthWrite = tr.fade > 0.95;
    }
  }

  private updateLighting() {
    const w = this.world, m = this.active;
    w.sun.position.set(m.x + 18, 32, m.z + 14);
    w.sun.target.position.set(m.x, 0, m.z);
    const h = this.phase === 'title' ? 10 : this.hour;
    const eve = clamp((h - 15) / 3, 0, 1), morn = clamp((10 - h) / 2, 0, 1);
    const cloud = this.wx.cloud;
    w.sun.color.setRGB(1, 0.96 - eve * 0.3 - morn * 0.06, 0.86 - eve * 0.5 - morn * 0.12);
    w.sun.intensity = (2.2 - eve * 0.7) * (1 - cloud * 0.6);
    w.hemi.intensity = (1.1 - eve * 0.35) * (1 - cloud * 0.15);
    const sky = this.tmp.set(0.62, 0.83, 0.94).lerp(new THREE.Vector3(0.95, 0.68, 0.5), eve * 0.75 * (1 - cloud * 0.6)).lerp(new THREE.Vector3(0.55, 0.6, 0.66), cloud * 0.8);
    // the panoramic sky dome sits under the scene background, and its tint follows the hour
    if (w.sky) {
      w.sky.position.set(this.engine.camera.position.x, 0, this.engine.camera.position.z);
      (w.sky.material as THREE.MeshBasicMaterial).color.setRGB(0.55 + eve * 0.5 + cloud * 0.35, 0.55 + eve * 0.35 + cloud * 0.35, 0.58 + cloud * 0.35);
    }
    (w.scene.fog as THREE.Fog).color.setRGB(sky.x, sky.y, sky.z, THREE.SRGBColorSpace);
  }

  // ---------------------------------------------------------------- HUD
  private pushHud() {
    const jobs: (JobLine & { d: number })[] = [];
    this.world.lots.forEach((lot, i) => {
      const st = this.lots[i];
      if (!this.isActive(st)) return;
      const r = this.remaining(lot);
      jobs.push({
        label: `#${lot.number} ${cap(lot.owner)}`,
        lawn: r.lawn, leaves: r.leaves, edge: r.edge, hedges: r.hedges,
        due: fmtHour(st.deadline),
        here: this.curLot === i,
        trial: st.status === 'job',
        crew: st.crew >= 0 ? this.crew[st.crew]?.name ?? null : null,
        d: Math.hypot(lot.centre.x - this.active.x, lot.centre.z - this.active.z) + (st.crew >= 0 ? 1000 : 0) - (st.status === 'job' ? 500 : 0),
      });
    });
    jobs.sort((a, b) => a.d - b.d);
    this.hud.update({
      regulars: this.regulars, money: this.money, dayLabel: `${WEEKDAYS[this.weekday]} · Wk ${this.weekNo}`, hour: this.hour, rep: this.rep,
      weather: WEATHER[this.today].icon, fuel: this.fuel, fuelMax: this.fuelMax, refueling: this.refueling,
      can: this.canFuel, blades: this.blades, riding: this.riding, jobs,
    });
  }

  private drawMinimap() {
    const cv = this.hud.minimap;
    const S = 1.2;
    const W = Math.round((MAX_X - MIN_X) * S), H = Math.round((MAX_Z - MIN_Z) * S);
    if (cv.width !== W) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    if (!g) return;
    const X = (x: number) => (x - MIN_X) * S, Z = (z: number) => (z - MIN_Z) * S;
    g.fillStyle = '#4d7a35';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#3a3c41';
    for (let i = 0; i < STREETS.length; i++) g.fillRect(0, Z(streetZ(i) - 4), X(CROSS_MID + 4), 8 * S);
    g.fillRect(X(CROSS_MID - 4), Z(-4), 8 * S, Z(streetZ(STREETS.length - 1) + 4) - Z(-4));
    const colors: Record<string, string> = { prospect: '#f2a91e', declined: '#8a8f98', job: '#2ecc71', due: '#3b8eea', done: '#1d6b3c', booked: '#9fb8d6', rival: '#2b6fd6' };
    this.world.lots.forEach((lot, i) => {
      const a = lot.side > 0 ? { z0: lot.zc + 6 } : { z0: lot.zc - 30 };
      g.fillStyle = colors[this.markerKey(this.lots[i])];
      g.globalAlpha = this.open(lot) ? 0.6 : 0.15;
      g.fillRect(X(lot.x0) + 1, Z(a.z0), 22 * S - 2, 24 * S);
      g.globalAlpha = 1;
      const b = lot.houseBox;
      g.fillStyle = '#2b2b30';
      g.fillRect(X(b.minX), Z(b.minZ), (b.maxX - b.minX) * S, (b.maxZ - b.minZ) * S);
    });
    for (const s of this.world.streets) {
      if (!s.unlocked) { g.fillStyle = 'rgba(20,20,25,0.45)'; g.fillRect(0, Z(s.zc - 33), W, 66 * S); continue; }
      g.fillStyle = '#ffd23a';
      g.beginPath(); g.arc(X(s.pump.x), Z(s.pump.z), 2.5, 0, Math.PI * 2); g.fill();
    }
    const dot = (mv: Mover, color: string, r: number) => { g.fillStyle = color; g.beginPath(); g.arc(X(mv.x), Z(mv.z), r, 0, Math.PI * 2); g.fill(); };
    for (const c of this.crew) dot(c.npc.mover, '#5dff9a', 2.6);
    if (this.rival.active) dot(this.rival.npc.mover, '#5aa0ff', 2.6);
    const m = this.active;
    if (!this.riding) {
      g.fillStyle = '#ffd23a';
      g.beginPath(); g.arc(X(this.mowerPark.x), Z(this.mowerPark.z), 2.4, 0, Math.PI * 2); g.fill();
    }
    dot(m, '#fff', this.riding ? 3.2 : 2.6);
    g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(X(m.x), Z(m.z)); g.lineTo(X(m.x) + Math.sin(m.yaw) * 7, Z(m.z) + Math.cos(m.yaw) * 7); g.stroke();
  }
}

/** Push two overlapping movers apart and bounce their velocities; returns the closing speed. */
function separate(a: Mover, b: Mover) {
  const dx = b.x - a.x, dz = b.z - a.z, R = a.o.radius + b.o.radius;
  const d2 = dx * dx + dz * dz;
  if (d2 >= R * R || d2 < 1e-6) return 0;
  const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, push = (R - d) / 2;
  a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
  const rv = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (rv >= 0) return 0;
  const j = -rv * 0.6;
  a.vx -= nx * j; a.vz -= nz * j; b.vx += nx * j; b.vz += nz * j;
  return -rv;
}
