import * as THREE from 'three';
import { Engine, FollowCamera, Input, Mover, Particles, Popups, Squash, TouchStick, clamp, poseBody } from '../engine/src';
import {
  CELL, DAY_END, DAY_START, FUEL_PRICE, GH, GW, K_BED, K_LAWN, MAX_X, MAX_Z, MIN_X, MIN_Z, PUMP, PUMP_R, SEC_PER_HOUR,
  STREET_NAME, TOW_FEE, UPGRADES, UpKey, cellX, cellZ, fmtHour,
} from './config';
import { Flowers, Grass, Leaves } from './lawn';
import { MowerModel, buildMower } from './mower';
import { Hud, JobLine } from './hud';
import { Sfx } from './sfx';
import { Lot, World, buildWorld } from './world';

type Phase = 'title' | 'play' | 'dialog' | 'paused' | 'evening' | 'tow';
type Status = 'prospect' | 'declined' | 'job' | 'client';

interface LotState {
  status: Status;
  /** Hour the current job must be finished by. */
  deadline: number;
  /** Agreed price per mow. */
  pay: number;
  doneToday: boolean;
  /** 0..1: how hard this owner is to win over. Squashing their flowers makes it worse. */
  grumpy: number;
  flowers: number;
  gnome: boolean;
  cut: number;
}

interface Gnome { obj: THREE.Group; hx: number; hz: number; x: number; z: number; vx: number; vz: number; spin: number; tip: number; knocked: boolean; lot: number }

interface SaveFile {
  v: 1; money: number; rep: number; day: number; fuel: number; up: Record<UpKey, number>;
  lots: { status: Status; grumpy: number; pay: number }[];
}
const SAVE_KEY = 'li_save_v1';

const NO_THANKS = [
  '"We\'re fine, thanks. My nephew does it."', '"Not today, sweetie."', '"I\'ll think about it." *door closes*',
  '"Is this a timeshare thing? No."', '"We like it wild. For the bees."', '"Maybe tomorrow, I\'m on a call."',
];

const freshUp = (): Record<UpKey, number> => ({ deck: 0, engine: 0, tank: 0, bagger: 0 });

export class Game {
  engine: Engine;
  world: World;
  grass: Grass;
  flowers: Flowers;
  leaves: Leaves;
  model: MowerModel;
  /** Heavier than Clean Sweep's roomba: slower to get going, slower to turn. */
  mover = new Mover({ radius: 0.8, maxSpeed: 5.4, accel: 10, decel: 7, turnRate: 10 });
  squash = new Squash({ stiffness: 150, damping: 10 });
  cam: FollowCamera;
  controls: Input;
  sfx = new Sfx();
  popups: Popups;
  hud: Hud;
  clips: Particles;
  sparks: Particles;
  markers: THREE.Sprite[] = [];
  private markerTex: Record<string, THREE.Texture> = {};
  gnomes: Gnome[] = [];

  phase: Phase = 'title';
  money = 0;
  rep = 3;
  day = 1;
  hour = DAY_START;
  fuel = 100;
  up = freshUp();
  lots: LotState[] = [];
  earnedToday = 0;
  mownToday = 0;
  notes: string[] = [];

  curLot = -1;
  private knockLock = -1;
  private bumpCd = 0;
  private chopT = 0;
  private leafT = 0;
  private glugT = 0;
  private texT = 0;
  private hudT = 0;
  private mapT = 0;
  private checkT = 0;
  private towT = 0;
  private menuT = 0;
  private refueling = false;
  private fuelWarned = false;
  private pumpHinted = false;
  private boost = false;
  private tmp = new THREE.Vector3();

  get deckR() { return 0.95 * (1 + 0.18 * this.up.deck); }
  get speedMax() { return 5.4 * (1 + 0.12 * this.up.engine); }
  get fuelMax() { return 100 * (1 + 0.35 * this.up.tank); }
  get vacR() { return 1.1 * (1 + 0.3 * this.up.bagger); }

  constructor(container: HTMLElement) {
    this.engine = new Engine(container, {
      update: this.frame,
      adaptive: () => this.phase === 'play',
      onBlur: () => { this.controls.clear(); if (this.phase === 'play') this.pause(); },
      fov: 50, near: 0.1, far: 200,
    });
    const r = this.engine.renderer;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.world = buildWorld(7);
    if (this.engine.isTouch) this.world.sun.shadow.mapSize.set(1024, 1024);
    this.engine.scene = this.world.scene;
    this.grass = new Grass(this.world);
    this.flowers = new Flowers(this.world);
    this.leaves = new Leaves(this.world);
    this.clips = this.engine.addParticles(900, false);
    this.sparks = this.engine.addParticles(600, true);
    this.model = buildMower();
    this.world.scene.add(this.model.root);
    this.cam = new FollowCamera(this.engine.camera, { offset: new THREE.Vector3(0, 14.5, 7.5), boostFov: 6 }, this.engine.syncProjection);
    this.controls = new Input({ capture: () => this.phase === 'play', onKey: this.onKey });
    new TouchStick(container, this.controls);
    this.popups = new Popups(container);
    this.hud = new Hud(container, this.engine.isTouch, (b) => this.controls.setBoost(b), () => this.pause());
    container.addEventListener('pointerdown', () => this.sfx.unlock());
    this.buildMarkers();
    this.buildGnomes();
    this.lots = this.world.lots.map(() => this.freshLot());
    this.leaves.scatter(this.world);
    this.placeAtPump();
    this.showTitle();
    this.engine.start();
  }

  private freshLot(): LotState {
    return { status: 'prospect', deadline: DAY_END, pay: 0, doneToday: false, grumpy: Math.random() * 0.6, flowers: 0, gnome: false, cut: 0 };
  }

  // ================================================================ flow
  private showTitle() {
    this.phase = 'title';
    this.hud.setPlaying(false);
    this.hud.title(!!this.readSave(), () => this.newGame(), () => this.continueGame());
  }

  private newGame() {
    this.sfx.unlock();
    this.money = 30; this.rep = 3; this.day = 1; this.up = freshUp(); this.fuel = this.fuelMax;
    this.lots = this.world.lots.map(() => this.freshLot());
    this.startDay();
    setTimeout(() => this.hud.toast('Drive to a front door marked <b>!</b> to knock and offer your services', 'info', 4200), 1800);
  }

  private continueGame() {
    const s = this.readSave();
    if (!s) return this.newGame();
    this.sfx.unlock();
    this.money = s.money; this.rep = s.rep; this.day = s.day; this.up = { ...freshUp(), ...s.up };
    this.fuel = Math.min(this.fuelMax, s.fuel);
    this.lots = this.world.lots.map((_, i) => ({ ...this.freshLot(), ...(s.lots[i] ?? {}) }));
    this.startDay();
  }

  private startDay() {
    this.hour = DAY_START;
    this.grass.regrowAll();
    this.flowers.restoreAll();
    this.leaves.scatter(this.world);
    this.resetGnomes();
    let regulars = 0;
    this.lots.forEach((st) => {
      if (st.status === 'declined' || st.status === 'job') st.status = 'prospect';
      if (st.status === 'client') { regulars++; st.deadline = DAY_END; }
      st.doneToday = false; st.flowers = 0; st.gnome = false; st.cut = 0;
    });
    this.earnedToday = 0; this.mownToday = 0; this.notes = [];
    this.placeAtPump();
    this.squash.reset();
    this.cam.snap(this.mover.x, this.mover.z);
    this.hud.close();
    this.hud.setPlaying(true);
    this.phase = 'play';
    this.engine.resetClock();
    this.sfx.morning();
    this.hud.toast(`☀️ Day ${this.day} on ${STREET_NAME}${regulars ? ` · ${regulars} regular${regulars > 1 ? 's' : ''} waiting` : ''}`, 'big');
    this.save();
    this.pushHud();
  }

  private endDay() {
    this.phase = 'evening';
    this.hud.setPlaying(false);
    this.sfx.drone(0, 0);
    this.sfx.evening();
    this.lots.forEach((st, i) => {
      if (st.status !== 'client' || st.doneToday) return;
      const lot = this.world.lots[i];
      this.rep = clamp(this.rep - 0.35, 0, 5);
      if (Math.random() < 0.4) {
        st.status = 'prospect';
        st.grumpy = Math.min(1, st.grumpy + 0.3);
        this.notes.push(`😠 ${cap(lot.owner)} (#${lot.number}) waited all day and found another landscaper.`);
      } else this.notes.push(`😒 ${cap(lot.owner)} (#${lot.number}) wasn't mown today. They're not happy.`);
    });
    this.day++;
    this.save();
    this.showEvening();
  }

  private showEvening() {
    this.hud.evening({
      day: this.day - 1, earned: this.earnedToday, jobs: this.mownToday, lines: this.notes, money: this.money, rep: this.rep, up: this.up,
      onBuy: (k) => this.buy(k),
      onNext: () => this.startDay(),
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

  pause() {
    if (this.phase !== 'play') return;
    this.phase = 'paused';
    this.sfx.drone(0, 0);
    this.hud.pause(() => this.resume(), () => { this.sfx.setMuted(!this.sfx.muted); this.phase = 'play'; this.pause(); }, this.sfx.muted, () => { this.save(); this.showTitle(); });
  }

  private resume() { if (this.phase === 'paused') { this.hud.close(); this.phase = 'play'; this.engine.resetClock(); } }

  private onKey = (code: string, e: KeyboardEvent) => {
    this.sfx.unlock();
    if (this.hud.overlayOpen && this.hud.key(code)) { e.preventDefault(); return; }
    if (code === 'KeyM') this.sfx.setMuted(!this.sfx.muted);
    if (this.phase === 'play' && (code === 'Escape' || code === 'KeyP')) this.pause();
  };

  // ================================================================ save
  private save() {
    const s: SaveFile = {
      v: 1, money: this.money, rep: this.rep, day: this.day, fuel: this.fuel, up: this.up,
      lots: this.lots.map((l) => ({ status: l.status === 'client' ? 'client' : 'prospect', grumpy: l.grumpy, pay: l.pay })),
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
  }

  private readSave(): SaveFile | null {
    try {
      const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as SaveFile | null;
      return s && s.v === 1 ? s : null;
    } catch { return null; }
  }

  // ================================================================ frame
  private frame = (dt: number, t: number) => {
    this.grass.update(dt, t);
    switch (this.phase) {
      case 'title': this.updateTitle(dt); break;
      case 'play': this.play(dt); break;
      case 'dialog': this.mover.vx *= 0.8; this.mover.vz *= 0.8; this.cam.update(dt, this.mover.x, this.mover.z); break;
      case 'tow': this.updateTow(dt); break;
      default: break;
    }
    const live = this.phase === 'play' || this.phase === 'dialog' || this.phase === 'tow';
    if (live) this.squash.update(dt);
    poseBody(this.model.root, this.model.body, this.mover, this.squash);
    this.animateMower(dt, t, live);
    this.updateGnomes(dt);
    this.updateMarkers(t);
    this.updateFades(dt);
    this.updateLighting();
    this.leaves.sync(t);
    this.clips.update(dt, this.mover.x, 0.4, this.mover.z);
    this.sparks.update(dt, this.mover.x, 0.4, this.mover.z);
    this.popups.update(dt, this.engine.camera);
    this.texT -= dt;
    if (this.texT <= 0) { this.texT = 0.08; this.grass.flush(); }
    this.hudT -= dt;
    if (this.hudT <= 0 && live) { this.hudT = 0.1; this.pushHud(); }
    this.mapT -= dt;
    if (this.mapT <= 0) { this.mapT = 0.2; this.drawMinimap(); }
  };

  private updateTitle(dt: number) {
    this.menuT += dt;
    const a = this.menuT * 0.06;
    const cam = this.engine.camera;
    cam.position.set(44 + Math.sin(a) * 46, 32, Math.cos(a) * 46);
    cam.lookAt(44, 0, 0);
  }

  private play(dt: number) {
    this.hour += dt / SEC_PER_HOUR;
    if (this.hour >= DAY_END) { this.hour = DAY_END; this.endDay(); return; }

    const inp = this.controls.read();
    this.boost = inp.boost && inp.m > 0.1;
    const m = this.mover;
    m.o.maxSpeed = this.speedMax;
    const hit = m.update(dt, inp.x, inp.z, inp.m, this.world, this.boost ? 1.35 : 1);
    this.bumpCd -= dt;
    if (hit.impact > 2.4 && this.bumpCd <= 0) this.bump(hit.impact, hit.nx, hit.nz);
    const frac = Math.min(1, m.speed / this.speedMax);

    const cutNow = this.cutAround(dt);
    this.squashFlowers();
    this.vacuumLeaves(dt);
    this.updateFuel(dt, frac, cutNow);
    if (this.phase !== 'play') return;

    const cell = this.cellAt(m.x, m.z);
    this.curLot = cell >= 0 ? this.world.owner[cell] : -1;
    this.checkKnock();
    this.checkT -= dt;
    if (this.checkT <= 0) { this.checkT = 0.2; this.checkJobs(); }

    this.sfx.drone(0.45 + frac * 0.4 + Math.min(0.3, cutNow * 0.05), frac * (this.boost ? 1.3 : 1) + Math.min(0.5, cutNow * 0.06));
    this.cam.update(dt, m.x, m.z, m.vx, m.vz, this.boost);
  }

  private cellAt(x: number, z: number) {
    const gx = Math.floor((x - MIN_X) / CELL), gz = Math.floor((z - MIN_Z) / CELL);
    return gx < 0 || gz < 0 || gx >= GW || gz >= GH ? -1 : gz * GW + gx;
  }

  // ---------------------------------------------------------------- mowing
  /** Cut every lawn cell under the deck; returns how many were cut this frame. */
  private cutAround(dt: number) {
    const m = this.mover, R = this.deckR;
    const fx = Math.sin(m.yaw), fz = Math.cos(m.yaw);
    const cx = m.x + fx * 0.15, cz = m.z + fz * 0.15;
    // stripe shade from the dominant direction of travel, like a real roller mower
    const light = Math.abs(m.vx) > Math.abs(m.vz) ? m.vx > 0 : m.vz < 0;
    let n = 0;
    const g0x = Math.floor((cx - R - MIN_X) / CELL), g1x = Math.floor((cx + R - MIN_X) / CELL);
    const g0z = Math.floor((cz - R - MIN_Z) / CELL), g1z = Math.floor((cz + R - MIN_Z) / CELL);
    for (let gz = g0z; gz <= g1z; gz++) for (let gx = g0x; gx <= g1x; gx++) {
      const c = gz * GW + gx;
      if (this.world.kind[c] !== K_LAWN || this.grass.isCut(c)) continue;
      if (Math.hypot(cellX(c) - cx, cellZ(c) - cz) > R) continue;
      if (this.grass.cutCell(c, light)) { n++; this.lots[this.world.owner[c]].cut++; }
    }
    if (n > 0) {
      // clippings blast out of the side chute
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
    const m = this.mover;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const c = this.cellAt(m.x + dx * 0.55, m.z + dz * 0.55);
      if (c < 0 || this.world.kind[c] !== K_BED) continue;
      if (!this.flowers.squash(c)) continue;
      const st = this.lots[this.world.owner[c]];
      st.flowers++;
      st.grumpy = Math.min(1, st.grumpy + 0.03);
      this.sfx.crunch();
      this.cam.addTrauma(0.08);
      const active = st.status === 'job' || (st.status === 'client' && !st.doneToday);
      this.popups.spawn(active ? '−$3' : 'oops!', cellX(c), 1, cellZ(c), '#ff8a7a', 0.8, 0.8);
      for (let k = 0; k < 5; k++) this.clips.spawn(cellX(c), 0.3, cellZ(c), (Math.random() - 0.5) * 3, 2 + Math.random() * 2, (Math.random() - 0.5) * 3, 1, 0.45, 0.65, 0.09, 0.7, 9);
    }
  }

  private vacuumLeaves(dt: number) {
    const m = this.mover, R = this.vacR;
    for (const l of this.leaves.list) {
      if (!l.alive) continue;
      const dx = m.x - l.x, dz = m.z - l.z, d = Math.hypot(dx, dz);
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

  // ---------------------------------------------------------------- fuel
  private updateFuel(dt: number, frac: number, cutNow: number) {
    const m = this.mover;
    this.fuel -= (0.25 + frac * (this.boost ? 1.7 : 0.95) + (cutNow ? 0.3 : 0)) * dt;
    this.refueling = false;
    if (Math.hypot(m.x - PUMP.x, m.z - PUMP.z) < PUMP_R && this.fuel < this.fuelMax - 0.05) {
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
        if (Math.random() < 0.3) this.sparks.spawn(PUMP.x + (Math.random() - 0.5), 0.6, PUMP.z + (Math.random() - 0.5), 0, 1.5, 0, 1, 0.82, 0.25, 0.14, 0.5, 0);
      }
    } else this.pumpHinted = false;
    const f = this.fuel / this.fuelMax;
    if (f < 0.2 && !this.fuelWarned) { this.fuelWarned = true; this.sfx.deny(); this.hud.toast('⛽ Low on gas! Head back to the truck (west end of the street)', 'bad'); }
    if (f > 0.5) this.fuelWarned = false;
    if (this.fuel <= 0) {
      this.fuel = 0;
      this.phase = 'tow';
      this.towT = 2.4;
      this.sfx.sputter();
      this.sfx.drone(0, 0);
      this.hud.toast(`⛽ Out of gas! Towing you back to the truck (−$${TOW_FEE})`, 'bad', 3000);
    }
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
    this.placeAtPump();
    this.cam.snap(m.x, m.z);
    this.squash.jump(3);
    this.phase = 'play';
  }

  private placeAtPump() {
    this.mover.place(PUMP.x + 0.2, PUMP.z, Math.PI / 2);
  }

  // ---------------------------------------------------------------- knocking and jobs
  private checkKnock() {
    const m = this.mover;
    let inZone = -1;
    for (const lot of this.world.lots) if (Math.hypot(m.x - lot.door.x, m.z - lot.door.z) < 1.15) inZone = lot.id;
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
      this.hud.toast(st.doneToday ? `${who}: "Looks great, see you tomorrow!"` : `${who}: "There's my lawn guy! Same as usual, please."`, st.doneToday ? 'good' : 'info');
      return;
    }
    if (st.status === 'declined') { this.hud.toast(`No answer at #${lot.number}. They already said no today.`); return; }
    this.sfx.knock();
    this.phase = 'dialog';
    if (this.hour > DAY_END - 1.25) {
      this.hud.dialog(`#${lot.number} · ${who}`, '"Bit late in the day for that, isn\'t it? Come back tomorrow."', [
        { label: 'OK', key: '⏎', primary: true, onPick: () => this.closeDialog() },
      ]);
      return;
    }
    const pay = this.offerPrice(lot);
    const cheap = Math.round(pay * 0.75);
    const sample = st.cut / Math.max(1, lot.lawnCells.length) > 0.5;
    // a brand-new business gets some sympathy until it lands its first regular
    const rookie = this.lots.some((l) => l.status === 'client') ? 0 : 0.15;
    const base = clamp(0.4 + rookie + (this.rep - 3) * 0.12 - st.grumpy * 0.3 + (sample ? 0.25 : 0), 0.05, 0.95);
    const disc = clamp(base + 0.25, 0.05, 0.97);
    const due = this.dueTime(lot);
    const mood = st.grumpy > 0.6 ? 'They look grumpy.' : st.grumpy < 0.25 ? 'They seem friendly.' : 'They look busy.';
    const body = `<i>*knock knock*</i> ${who} opens the door. ${mood}` +
      (sample ? '<br>"Oh! Did you already do half my lawn?"' : '') +
      `<br>Job: mow the lawn + clear the leaves, done by <b>${fmtHour(due)}</b>.`;
    this.hud.dialog(`#${lot.number} ${STREET_NAME} · ${who}`, body, [
      { label: `Pitch $${pay}`, sub: `${Math.round(base * 100)}% chance`, key: '1', primary: true, onPick: () => this.pitch(lot, pay, base, due) },
      { label: `Discount $${cheap}`, sub: `${Math.round(disc * 100)}% chance`, key: '2', onPick: () => this.pitch(lot, cheap, disc, due) },
      { label: 'Leave', key: 'Esc', onPick: () => this.closeDialog() },
    ]);
  }

  private offerPrice(lot: Lot) {
    const area = lot.lawnCells.length * CELL * CELL;
    return Math.round((8 + area * 0.09 + this.leaves.total(lot.id) * 0.3) * (0.85 + this.rep * 0.05));
  }

  private dueTime(lot: Lot) {
    const area = lot.lawnCells.length * CELL * CELL;
    return Math.min(DAY_END, Math.ceil((this.hour + 2 + area / 250) * 2) / 2);
  }

  private pitch(lot: Lot, price: number, chance: number, due: number) {
    const st = this.lots[lot.id];
    this.closeDialog();
    if (Math.random() < chance) {
      st.status = 'job';
      st.pay = price;
      st.deadline = due;
      this.sfx.hired();
      this.squash.jump(3.5);
      this.sparks.burst(this.mover.x, 1, this.mover.z, 20, 4, 0.4, 1, 0.5, 0.25, 0.7, 6);
      this.hud.toast(`🤝 Hired! Mow #${lot.number} and clear the leaves by ${fmtHour(due)} for $${price}`, 'good', 3600);
    } else {
      st.status = 'declined';
      this.sfx.rejected();
      this.hud.toast(`🚪 ${cap(lot.owner)}: ${NO_THANKS[Math.floor(Math.random() * NO_THANKS.length)]}`, 'bad', 3200);
    }
  }

  private closeDialog() {
    this.hud.close();
    this.phase = 'play';
    this.engine.resetClock();
  }

  private checkJobs() {
    this.world.lots.forEach((lot, i) => {
      const st = this.lots[i];
      const active = st.status === 'job' || (st.status === 'client' && !st.doneToday);
      if (!active) return;
      if (st.status === 'job' && this.hour > st.deadline) {
        st.status = 'declined';
        st.grumpy = Math.min(1, st.grumpy + 0.2);
        this.rep = clamp(this.rep - 0.4, 0, 5);
        this.sfx.rejected();
        this.hud.toast(`⌛ Too late! ${cap(lot.owner)} at #${lot.number} cancelled the job`, 'bad', 3400);
        this.notes.push(`⌛ Missed the deadline at #${lot.number}.`);
        return;
      }
      if (st.cut / lot.lawnCells.length >= 0.95 && this.leaves.left(i) <= 1) this.completeJob(lot);
    });
  }

  private completeJob(lot: Lot) {
    const st = this.lots[lot.id];
    // tidy up the last stragglers so the lawn looks perfect
    let k = 0;
    for (const c of lot.lawnCells) {
      if (this.grass.cutCell(c, (Math.floor(cellX(c)) & 1) === 0)) {
        st.cut++;
        if (k++ % 3 === 0) this.sparks.spawn(cellX(c), 0.2, cellZ(c), 0, 1.5 + Math.random() * 2, 0, 1, 0.9, 0.4, 0.18, 0.8, -0.5);
      }
    }
    for (const l of this.leaves.list) if (l.lot === lot.id) l.alive = false;
    const early = this.hour <= st.deadline - 1;
    const tip = early ? Math.round(st.pay * 0.2) : 0;
    const damage = st.flowers * 3 + (st.gnome ? 10 : 0);
    const total = Math.max(0, st.pay + tip - damage);
    const rating = clamp(5 - Math.min(2, st.flowers * 0.25) - (st.gnome ? 1 : 0) - (early ? 0 : 0.5), 1, 5);
    this.rep = clamp(this.rep * 0.8 + rating * 0.2, 0, 5);
    this.money += total;
    this.earnedToday += total;
    this.mownToday++;
    st.doneToday = true;
    const firstTime = st.status === 'job';
    st.status = 'client';
    this.sfx.done();
    this.sfx.cash();
    this.cam.addTrauma(0.3);
    this.squash.jump(4);
    this.popups.spawn(`+$${total}`, this.mover.x, 2.2, this.mover.z, '#ffe066', 1.6, 1.6);
    for (let n = 0; n < 60; n++) {
      const c = lot.lawnCells[Math.floor(Math.random() * lot.lawnCells.length)];
      this.sparks.spawn(cellX(c), 0.2, cellZ(c), 0, 2 + Math.random() * 3, 0, 0.6, 1, 0.5, 0.25, 1 + Math.random(), -0.5);
    }
    const extra = [tip ? `+$${tip} tip` : '', damage ? `−$${damage} damages` : ''].filter(Boolean).join(', ');
    this.hud.toast(`✨ #${lot.number} done! $${total}${extra ? ` (${extra})` : ''} · ${'★'.repeat(Math.round(rating))}`, 'big');
    if (firstTime) setTimeout(() => this.hud.toast(`🔁 New regular! ${cap(lot.owner)} will want a mow every day.`, 'good', 3200), 1600);
    this.notes.push(`✅ #${lot.number} ${cap(lot.owner)}: $${total}${extra ? ` (${extra})` : ''}`);
  }

  // ---------------------------------------------------------------- bumps, gnomes
  private bump(impact: number, nx: number, nz: number) {
    this.bumpCd = 0.25;
    const k = Math.min(1, impact / 8);
    this.cam.addTrauma(0.1 + k * 0.3);
    this.sfx.bump(k);
    this.squash.squash(-(2 + k * 4));
    const cx = this.mover.x - nx * 0.8, cz = this.mover.z - nz * 0.8;
    for (let i = 0; i < 5 + k * 12; i++) {
      const a = Math.atan2(nz, nx) + (Math.random() - 0.5) * 2.2, s = 2 + Math.random() * 4 * k;
      this.sparks.spawn(cx, 0.4, cz, Math.cos(a) * s, 1 + Math.random() * 3, Math.sin(a) * s, 1, 0.85, 0.4, 0.12 + Math.random() * 0.08, 0.35, 10);
    }
    if (impact > 5.5 && Math.random() < 0.5) this.popups.spawn(['BONK!', 'CLUNK!', 'OOF!'][Math.floor(Math.random() * 3)], this.mover.x, 1.8, this.mover.z, '#ffe27a', 0.8, 0.9);
  }

  private buildGnomes() {
    const lam = (c: string) => new THREE.MeshLambertMaterial({ color: c });
    for (const lot of this.world.lots) for (const s of lot.gnomeSpots) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 0.4, 10), lam('#2f6fb5'));
      body.position.y = 0.2;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), lam('#f0c19a'));
      head.position.y = 0.5;
      const beard = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.22, 8), lam('#f4f4f4'));
      beard.position.set(0, 0.4, 0.08);
      beard.rotation.x = Math.PI;
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.35, 10), lam('#d23a2c'));
      hat.position.y = 0.75;
      g.add(body, head, beard, hat);
      g.traverse((o) => { o.castShadow = true; });
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
    const m = this.mover;
    for (const g of this.gnomes) {
      if (!g.knocked && this.phase === 'play') {
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
          const active = st.status === 'job' || (st.status === 'client' && !st.doneToday);
          this.popups.spawn(active ? 'GNOME! −$10' : 'GNOME!', g.x, 1.4, g.z, '#ff8a7a', 1.1, 1);
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
  private animateMower(dt: number, t: number, live: boolean) {
    const md = this.model, m = this.mover;
    const fwd = m.vx * Math.sin(m.yaw) + m.vz * Math.cos(m.yaw);
    md.wheels.forEach((w, i) => { w.rotation.x += (fwd * dt) / (i < 2 ? 0.26 : 0.38); });
    const running = live && this.phase !== 'tow';
    md.blade.rotation.y += dt * (running ? 45 : 2);
    md.body.position.y = running ? Math.sin(t * 70) * 0.012 : 0;
  }

  private buildMarkers() {
    const mk = (ch: string, bg: string, fg = '#fff') => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d')!;
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath(); g.arc(64, 68, 54, 0, Math.PI * 2); g.fill();
      g.fillStyle = bg;
      g.beginPath(); g.arc(64, 62, 54, 0, Math.PI * 2); g.fill();
      g.lineWidth = 6; g.strokeStyle = '#fff'; g.stroke();
      g.fillStyle = fg;
      g.font = '900 72px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(ch, 64, 66);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    this.markerTex = { prospect: mk('!', '#f2a91e'), declined: mk('✕', '#8a8f98'), job: mk('$', '#24a35a'), client: mk('$', '#2b7de0'), done: mk('✓', '#24a35a') };
    for (const lot of this.world.lots) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.markerTex.prospect, depthTest: false, transparent: true }));
      s.position.set(lot.door.x, 4.6, lot.door.z);
      s.scale.set(1.5, 1.5, 1);
      s.renderOrder = 30;
      this.world.scene.add(s);
      this.markers.push(s);
    }
  }

  private updateMarkers(t: number) {
    this.world.lots.forEach((lot, i) => {
      const st = this.lots[i], s = this.markers[i];
      const key = st.status === 'client' ? (st.doneToday ? 'done' : 'client') : st.status;
      const mat = s.material;
      if (mat.map !== this.markerTex[key]) { mat.map = this.markerTex[key]; mat.needsUpdate = true; }
      const urgent = key === 'job' || key === 'client';
      const pulse = urgent ? 1 + Math.sin(t * 5 + i) * 0.1 : 1;
      const sc = (key === 'declined' || key === 'done' ? 1.1 : 1.5) * pulse;
      s.scale.set(sc, sc, 1);
      mat.opacity = key === 'declined' ? 0.55 : 1;
      s.position.set(lot.door.x, 4.6 + Math.sin(t * 2.2 + i) * 0.18, lot.door.z);
      // fade out when you're close, so it never covers the mower
      const near = Math.hypot(this.mover.x - lot.door.x, this.mover.z - lot.door.z);
      if (this.phase !== 'title') mat.opacity *= clamp((near - 2) / 4, 0.15, 1);
    });
    const p = this.world.pump;
    const pulse = 0.5 + 0.5 * Math.sin(t * (this.refueling ? 9 : 2.5));
    p.ringMat.opacity = 0.35 + pulse * 0.4 + (this.fuel / this.fuelMax < 0.2 ? 0.25 : 0);
    const rs = 1 + pulse * 0.06;
    p.ring.scale.set(rs, rs, rs);
  }

  /** Houses and tree crowns between the camera and the mower go see-through. */
  private updateFades(dt: number) {
    const m = this.mover, k = Math.min(1, dt * 8);
    const playing = this.phase !== 'title';
    for (const lot of this.world.lots) {
      const b = lot.houseBox;
      const hide = playing && m.x > b.minX - 1.5 && m.x < b.maxX + 1.5 && b.maxZ > m.z - 0.5 && b.minZ < m.z + 7;
      lot.fade += ((hide ? 0.22 : 1) - lot.fade) * k;
      for (const mat of lot.houseMats) mat.opacity = lot.fade;
    }
    for (const tr of this.world.trees) {
      const hide = playing && Math.abs(tr.x - m.x) < 2.8 && tr.z > m.z - 2.5 && tr.z < m.z + 6.5;
      tr.fade += ((hide ? 0.25 : 1) - tr.fade) * k;
      tr.mat.opacity = tr.fade;
      tr.mat.depthWrite = tr.fade > 0.95;
    }
  }

  private updateLighting() {
    const w = this.world, m = this.mover;
    w.sun.position.set(m.x + 18, 32, m.z + 14);
    w.sun.target.position.set(m.x, 0, m.z);
    const h = this.phase === 'title' ? 10 : this.hour;
    const eve = clamp((h - 15) / 3, 0, 1), morn = clamp((10 - h) / 2, 0, 1);
    w.sun.color.setRGB(1, 0.96 - eve * 0.3 - morn * 0.06, 0.86 - eve * 0.5 - morn * 0.12);
    w.sun.intensity = 2.2 - eve * 0.7;
    w.hemi.intensity = 1.1 - eve * 0.35;
    const sky = this.tmp.set(0.62, 0.83, 0.94).lerp(new THREE.Vector3(0.95, 0.68, 0.5), eve * 0.75);
    (w.scene.background as THREE.Color).setRGB(sky.x, sky.y, sky.z, THREE.SRGBColorSpace);
    (w.scene.fog as THREE.Fog).color.setRGB(sky.x, sky.y, sky.z, THREE.SRGBColorSpace);
  }

  // ---------------------------------------------------------------- HUD
  private pushHud() {
    const jobs: JobLine[] = [];
    this.world.lots.forEach((lot, i) => {
      const st = this.lots[i];
      if (!(st.status === 'job' || (st.status === 'client' && !st.doneToday))) return;
      jobs.push({
        label: `#${lot.number} ${cap(lot.owner)}`,
        lawn: st.cut / lot.lawnCells.length,
        leaves: this.leaves.left(i),
        due: fmtHour(st.deadline),
        here: this.curLot === i,
        client: st.status === 'client',
      });
    });
    const regulars = this.lots.filter((l) => l.status === 'client').length;
    this.hud.update({ regulars, money: this.money, day: this.day, hour: this.hour, rep: this.rep, fuel: this.fuel, fuelMax: this.fuelMax, refueling: this.refueling, jobs });
  }

  private drawMinimap() {
    const cv = this.hud.minimap;
    const S = 2;
    const W = (MAX_X - MIN_X) * S, H = (MAX_Z - MIN_Z) * S;
    if (cv.width !== W) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    if (!g) return;
    const X = (x: number) => (x - MIN_X) * S, Z = (z: number) => (z - MIN_Z) * S;
    g.fillStyle = '#4d7a35';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#3a3c41';
    g.fillRect(0, Z(-4), W, 8 * S);
    const colors: Record<string, string> = { prospect: '#f2a91e', declined: '#8a8f98', job: '#2ecc71', client: '#3b8eea', done: '#1d6b3c' };
    this.world.lots.forEach((lot, i) => {
      const st = this.lots[i];
      const key = st.status === 'client' && st.doneToday ? 'done' : st.status;
      const a = lot.side > 0 ? { z0: 6, z1: 30 } : { z0: -30, z1: -6 };
      g.fillStyle = colors[key];
      g.globalAlpha = 0.55;
      g.fillRect(X(lot.x0) + 1, Z(a.z0), 22 * S - 2, 24 * S);
      g.globalAlpha = 1;
      const b = lot.houseBox;
      g.fillStyle = '#2b2b30';
      g.fillRect(X(b.minX), Z(b.minZ), (b.maxX - b.minX) * S, (b.maxZ - b.minZ) * S);
    });
    g.fillStyle = '#ffd23a';
    g.beginPath(); g.arc(X(PUMP.x), Z(PUMP.z), 3, 0, Math.PI * 2); g.fill();
    const m = this.mover;
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(X(m.x), Z(m.z), 3.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(X(m.x), Z(m.z)); g.lineTo(X(m.x) + Math.sin(m.yaw) * 7, Z(m.z) + Math.cos(m.yaw) * 7); g.stroke();
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
