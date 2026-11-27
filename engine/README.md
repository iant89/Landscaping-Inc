# Engine

The movement and "game feel" core of Clean Sweep, pulled out so it can drive other games.
It depends only on `three`. Clean Sweep runs on it (`src/game/Game.ts`) and so does Landscaping Inc.
(`src/game.ts`), so it stays tested by real games. Copy the `engine/` folder into a new project, or
import from `engine/src`.

```bash
npm run dev          # (in this repo) play Landscaping Inc.
npm run build        # typecheck + production build
npm run engine:demo  # play the engine demo game (Orb Rush) with hot reload
npm run engine:build # build the demo into dist-demo/
```

`engine/demo/main.ts` (part of the vendored engine, not this game's source) is a complete small game
in about 230 lines — the best starting point for building something new on the engine.

## Why it feels fluid

Clean Sweep feels smooth because of a few small habits that work together. The engine keeps every one of them, with the same tuning numbers:

| Piece | What it does | Where |
|---|---|---|
| Clamped, frame-rate independent time | `dt` is capped at 50 ms. All smoothing uses `1 - exp(-rate·dt)`, so it feels the same at 30 or 144 fps | `Engine`, `math.ts` |
| Eased velocity | Velocity glides toward the stick instead of snapping: fast when you push (13/s), a bit slower when you let go (9/s) | `Mover` |
| Lean into acceleration | The body tilts as you speed up, brake or turn | `Mover.leanX/leanZ` |
| Smooth turning | The body turns to face its velocity at 14/s, and only when it's actually moving | `Mover` |
| Substepped, bouncy collision | Movement is split into steps of 0.2 units or less, so nothing tunnels through walls. A restitution of 1.15 makes walls kick you back slightly | `Mover.collide` |
| Squash & stretch spring | A spring (stiffness 170, damping 11) for impacts and pickups, plus a hop that squashes on landing | `Squash` |
| Leading camera | The camera looks 0.28 s ahead along your velocity and catches up at 6/s. It pulls back on portrait screens | `FollowCamera` |
| Trauma shake | Shake is `trauma²` and decays by itself, so small bumps barely register and big hits land hard | `FollowCamera.addTrauma` |
| FOV kick | The field of view widens by 7° while boosting | `FollowCamera` |
| Particles everywhere | GPU point sprites with gravity, floor bounce and attraction (dust gets sucked into you) | `Particles` |
| Synth audio | No sound files. Tones and noise, plus a motor drone whose pitch follows your speed | `Synth` |
| Pop-up text | "+5", "BONK!" and similar text pops in, drifts up and fades, anchored to a world point | `Popups` |
| Adaptive resolution | The pixel ratio drops automatically when frames stay slow | `Engine` |
| Clean canvas input | The browser context menu is suppressed on the canvas (capture phase), and right-drag is free for games to use | `Engine` |

## Minimal game

```ts
import { Engine, Input, Mover, Squash, FollowCamera, poseBody } from './engine/src';

const input = new Input();
const engine = new Engine(document.getElementById('app')!, { update });
const cam = new FollowCamera(engine.camera, {}, engine.syncProjection);
const sparks = engine.addParticles(500, true);
const mover = new Mover({ maxSpeed: 6 });
const squash = new Squash();
const world = { boxes: [{ minX: 4, maxX: 6, minZ: 4, maxZ: 6 }] };
// ...add your meshes to engine.scene: `root` (positioned/turned) containing `body` (squashed/leaned)

function update(dt: number) {
  const s = input.read();
  const hit = mover.update(dt, s.x, s.z, s.m, world, s.boost ? 1.5 : 1);
  if (hit.impact > 2.6) { cam.addTrauma(0.3); squash.squash(-5); sparks.burst(mover.x, 0.3, mover.z, 12, 4, 1, 0.9, 0.5, 0.2, 0.4); }
  squash.update(dt);
  poseBody(root, body, mover, squash);
  sparks.update(dt, mover.x, 0.3, mover.z);
  cam.update(dt, mover.x, mover.z, mover.vx, mover.vz, s.boost);
}
engine.start();
```

## Tuning

Every class takes a partial options object, and the defaults are Clean Sweep's values.

- **`Mover`**: `maxSpeed`, `accel`/`decel` (higher = tighter, lower = icier), `turnRate`, `lean`/`leanMax`, `restitution` (1 = slide along walls, 1.5 = pinball), `radius`.
- **`Squash`**: `stiffness`/`damping` (lower damping = more wobble), `limit`, `gravity` for hops.
- **`FollowCamera`**: `offset` (height and distance), `lead`, `followRate`, `fov`/`boostFov`, `traumaDecay`, `shakeMove`/`shakeRoll`.
- **`Engine`**: `shadows` (turn on PCFSoft shadow maps at construction; off by default, then set
  `castShadow`/`receiveShadow` on your meshes), `maxDt`, `adaptive`, `onBlur`, `fov`/`near`/`far`/`background`.

## Collision model

The world is flat (X/Z). Things that move are circles (`Mover`), and things that block are
axis-aligned boxes (`AABB[]`), plus an optional `TileGrid` for walls laid out on a grid. You can
change `world.boxes` at runtime, for example to remove a wall once a door opens.

## How Clean Sweep uses it

- `Engine` runs the frame loop. `engine.scene` is swapped to each building's scene when a level loads.
- `Mover` is the roomba. `Game` exposes `px`/`pz`/`vx`/`vz`/`yaw` as getters over it, and upgrades set `mover.o.maxSpeed`.
- Walls come from a `TileGrid` over the room grid. Furniture and secret doors are `boxes`, and secret doors are removed from the array when they open.
- `FollowCamera.track()` + `shake()` are called separately, so the battery-death zoom can move the camera in between.
- `Sfx extends Synth` adds the manor's sounds. Positional sounds pass an `AudioNode` as the last argument of `tone()`/`noise()`.
- `Popups` reuses the React popup layer with the `cs-popup` CSS class.

## Not included

These parts of Clean Sweep are game-specific and stay in `src/game/`: the dirt painting, the manor
builder, rooms and levels, saves, the shop, ghosts, cutscenes and the React HUD. They're worth
reading as examples, especially `world.ts` for procedural meshes and `dirt.ts` for painting into a
texture at runtime.
