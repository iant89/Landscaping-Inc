/**
 * Orb Rush: a ~200-line starter game built only on the engine. Drive the bot around the arena,
 * hoover up orbs before the clock runs out, chain pickups for a combo. Copy this file as the
 * starting point for your own game.
 */
import * as THREE from 'three';
import {
  AABB, CollisionWorld, Engine, FollowCamera, Input, Mover, Popups, Squash, Synth, TouchStick,
  blobTexture, makeRng, poseBody,
} from '../src';

const TILE = 2, COLS = 20, ROWS = 16;
const ROUND = 60;

const app = document.getElementById('app')!;
const hud = document.getElementById('hud')!;
const msg = document.getElementById('msg')!;

// ---------------------------------------------------------------- core systems
let state: 'title' | 'playing' | 'over' = 'title';
const sfx = new Synth('orbrush_muted');
const input = new Input({
  capture: () => state === 'playing',
  onKey: (code) => {
    sfx.unlock();
    if (code === 'KeyM') sfx.setMuted(!sfx.muted);
    if (state !== 'playing' && (code === 'Enter' || code === 'Space')) start();
  },
});
const engine = new Engine(app, {
  update,
  background: 0x0d0b16,
  adaptive: () => state === 'playing',
  onBlur: () => input.clear(),
});
const { scene, camera } = engine;
const cam = new FollowCamera(camera, {}, engine.syncProjection);
const dust = engine.addParticles(600, false);
const glow = engine.addParticles(600, true);
const popups = new Popups(app);
new TouchStick(app, input);
app.addEventListener('pointerdown', () => { sfx.unlock(); if (state !== 'playing') start(); });

// ---------------------------------------------------------------- arena
scene.fog = new THREE.Fog(0x0d0b16, 26, 58);
scene.add(new THREE.HemisphereLight(0xb8b0ff, 0x302040, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(10, 20, 8);
scene.add(sun);

const rng = makeRng(7);
const solid = new Uint8Array(COLS * ROWS);
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  const edge = r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1;
  const pillar = c % 5 === 0 && r % 5 === 0 && !edge && rng() < 0.8;
  solid[r * COLS + c] = edge || pillar ? 1 : 0;
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(COLS * TILE, ROWS * TILE), new THREE.MeshStandardMaterial({ color: 0x2a2440, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
floor.position.set((COLS * TILE) / 2, 0, (ROWS * TILE) / 2);
scene.add(floor);
const wallGeo = new THREE.BoxGeometry(TILE, 2, TILE);
const wallMat = new THREE.MeshStandardMaterial({ color: 0x5a4a8a, roughness: 0.6 });
for (let i = 0; i < solid.length; i++) if (solid[i]) {
  const m = new THREE.Mesh(wallGeo, wallMat);
  m.position.set((i % COLS + 0.5) * TILE, 1, (Math.floor(i / COLS) + 0.5) * TILE);
  scene.add(m);
}

// loose crates: plain AABBs the mover bounces off
const boxes: AABB[] = [];
const crateMat = new THREE.MeshStandardMaterial({ color: 0xc08040, roughness: 0.7 });
for (let n = 0; n < 10; n++) {
  const x = 4 + rng() * (COLS * TILE - 8), z = 4 + rng() * (ROWS * TILE - 8), w = 1 + rng() * 1.5, d = 1 + rng() * 1.5;
  if (Math.hypot(x - COLS, z - ROWS) < 4) continue; // keep the spawn clear
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, d), crateMat);
  m.position.set(x, 0.45, z);
  scene.add(m);
  boxes.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
}
const world: CollisionWorld = { boxes, grid: { cols: COLS, rows: ROWS, tile: TILE, solid: (c, r) => solid[r * COLS + c] === 1 } };

// ---------------------------------------------------------------- player
const mover = new Mover({ radius: 0.55, maxSpeed: 6.5 });
const squash = new Squash();
const root = new THREE.Group();
const body = new THREE.Group();
const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.58, 0.3, 32), new THREE.MeshStandardMaterial({ color: 0xe8ecf4, metalness: 0.3, roughness: 0.35 }));
shell.position.y = 0.2;
const eyeMat = new THREE.MeshBasicMaterial({ color: 0x7ff6ff });
const eyes = [-0.16, 0.16].map((x) => { const e = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.12), eyeMat); e.position.set(x, 0.38, 0.38); return e; });
const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: blobTexture('rgba(120,240,255,0.6)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
halo.scale.set(2.2, 2.2, 1);
halo.position.y = 0.05;
body.add(shell, ...eyes);
root.add(body, halo);
scene.add(root);
const headlight = new THREE.PointLight(0x7ff6ff, 8, 8);
headlight.position.y = 1;
root.add(headlight);

// ---------------------------------------------------------------- orbs
interface Orb { mesh: THREE.Mesh; x: number; z: number; phase: number }
const orbs: Orb[] = [];
const orbGeo = new THREE.IcosahedronGeometry(0.25, 1);
const orbMat = new THREE.MeshStandardMaterial({ color: 0xffc43a, emissive: 0x8a5000, roughness: 0.3 });
function spawnOrb() {
  for (let k = 0; k < 50; k++) {
    const x = TILE + Math.random() * (COLS - 2) * TILE, z = TILE + Math.random() * (ROWS - 2) * TILE;
    if (solid[Math.floor(z / TILE) * COLS + Math.floor(x / TILE)]) continue;
    if (boxes.some((b) => x > b.minX - 0.5 && x < b.maxX + 0.5 && z > b.minZ - 0.5 && z < b.maxZ + 0.5)) continue;
    const mesh = new THREE.Mesh(orbGeo, orbMat);
    scene.add(mesh);
    orbs.push({ mesh, x, z, phase: Math.random() * 6 });
    return;
  }
}

// ---------------------------------------------------------------- game state
let score = 0, timeLeft = ROUND, combo = 1, comboT = 0, bumpCd = 0, blinkT = 2;

function start() {
  sfx.unlock();
  for (const o of orbs) scene.remove(o.mesh);
  orbs.length = 0;
  for (let i = 0; i < 14; i++) spawnOrb();
  score = 0; timeLeft = ROUND; combo = 1; comboT = 0;
  mover.place(COLS, ROWS, Math.PI);
  squash.reset();
  squash.jump(4); // little boot-up hop
  cam.snap(mover.x, mover.z);
  popups.clear();
  state = 'playing';
  msg.style.display = 'none';
  engine.resetClock();
}

function gameOver() {
  state = 'over';
  sfx.drone(0, 0);
  sfx.fail();
  cam.addTrauma(0.4);
  msg.innerHTML = `<h1>Time!</h1><p>Score ${score}</p><p class="small">Press Enter or tap to play again</p>`;
  msg.style.display = 'flex';
}

// ---------------------------------------------------------------- frame
function update(dt: number, t: number) {
  if (state === 'playing') play(dt);
  else {
    // idle: slow orbit for the title screen
    const a = t * 0.08;
    camera.position.set(COLS + Math.sin(a) * 30, 26, ROWS + Math.cos(a) * 30);
    camera.lookAt(COLS, 0, ROWS);
    cam.shake(dt);
  }
  squash.update(dt);
  poseBody(root, body, mover, squash);
  blinkT -= dt;
  if (blinkT < 0) blinkT = 2 + Math.random() * 3;
  eyes.forEach((e) => (e.scale.z = blinkT < 0.12 ? 0.15 : 1));
  for (const o of orbs) {
    o.mesh.position.set(o.x, 0.5 + Math.sin(t * 4 + o.phase) * 0.12, o.z);
    o.mesh.rotation.y = t * 3 + o.phase;
  }
  dust.update(dt, mover.x, 0.25, mover.z);
  glow.update(dt, mover.x, 0.3, mover.z);
  popups.update(dt, camera);
}

function play(dt: number) {
  timeLeft -= dt;
  if (timeLeft <= 0) { timeLeft = 0; gameOver(); return; }

  const stick = input.read();
  const boost = stick.boost && stick.m > 0.1;
  const hit = mover.update(dt, stick.x, stick.z, stick.m, world, boost ? 1.5 : 1);

  // bump: shake, squash, sparks, a thud scaled by how hard you hit
  bumpCd -= dt;
  if (hit.impact > 2.6 && bumpCd <= 0) {
    bumpCd = 0.22;
    const k = Math.min(1, hit.impact / 9);
    cam.addTrauma(0.12 + k * 0.35);
    sfx.bump(k);
    squash.squash(-(2 + k * 5));
    const cx = mover.x - hit.nx * 0.55, cz = mover.z - hit.nz * 0.55;
    for (let i = 0; i < 6 + k * 14; i++) {
      const a = Math.atan2(hit.nz, hit.nx) + (Math.random() - 0.5) * 2.2, s = 3 + Math.random() * 5 * k;
      glow.spawn(cx, 0.25, cz, Math.cos(a) * s, 1 + Math.random() * 3, Math.sin(a) * s, 1, 0.85, 0.4, 0.14 + Math.random() * 0.1, 0.35, 10);
    }
    dust.burst(cx, 0.15, cz, 5, 2, 0.5, 0.45, 0.4, 0.25, 0.6, 2);
    if (hit.impact > 6 && Math.random() < 0.5) popups.spawn(['BONK!', 'OOF!', 'CLUNK!'][Math.floor(Math.random() * 3)], mover.x, 1.2, mover.z, '#ffe27a', 0.8, 0.9);
  }

  // orbs drift toward you when close, then get collected
  comboT -= dt;
  if (comboT <= 0) combo = 1;
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i];
    const dx = mover.x - o.x, dz = mover.z - o.z, d = Math.hypot(dx, dz);
    if (d < 2.4 && d > 0.01) {
      const pull = (2.4 - d) * 9 * dt;
      o.x += (dx / d) * Math.min(d, pull); o.z += (dz / d) * Math.min(d, pull);
    }
    if (d < 0.9) {
      scene.remove(o.mesh);
      orbs.splice(i, 1);
      if (comboT > 0 && combo < 5) { combo++; sfx.combo(combo); popups.spawn(`COMBO x${combo}!`, mover.x, 1.6, mover.z, '#7df9ff', 1, 1.3); }
      comboT = 1.6;
      const pts = 10 * combo;
      score += pts;
      sfx.pickup();
      popups.spawn(`+${pts}`, o.x, 1.2, o.z, '#ffd84d', 0.9);
      glow.burst(o.x, 0.5, o.z, 16, 4, 1, 0.8, 0.25, 0.22, 0.6, 8);
      squash.squash(2.5);
      spawnOrb();
    }
  }

  // boost trail, motor sound, halo colour
  if (boost && Math.random() < 0.6) {
    const a = mover.yaw + Math.PI + (Math.random() - 0.5) * 0.8;
    glow.spawn(mover.x + Math.sin(a) * 0.5, 0.15, mover.z + Math.cos(a) * 0.5, Math.sin(a) * 2, 0.3, Math.cos(a) * 2, 0.4, 0.8, 1, 0.16, 0.3, 0);
  }
  const frac = Math.min(1, mover.speed / mover.o.maxSpeed);
  sfx.drone(0.55 + frac * 0.45, frac * (boost ? 1.4 : 1));
  cam.update(dt, mover.x, mover.z, mover.vx, mover.vz, boost);
  hud.textContent = `⏱ ${Math.ceil(timeLeft)}   ★ ${score}   ${combo > 1 ? `x${combo}` : ''}`;
}

engine.start();
