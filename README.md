# Landscaping Inc.

A browser game about building a lawn-care business one house at a time. Drive your riding mower up and
down Maple Street, knock on doors, win customers and keep their lawns perfect.

**How it plays**

- **Knock** by driving up to a front door marked **!**. Pitch full price or offer a discount, which raises
  your chances. Your reputation, the owner's mood, and whether you've already mown half their lawn as a
  free sample all count.
- **Do the job** before it's due: mow the lawn (you'll leave real mow stripes) and vacuum the leaves off
  the sidewalk, path and driveway. Finishing early earns a tip. Squashed flowers and gnomes you've hit
  come out of your pay.
- **Regulars:** every finished first job turns into a customer who wants a mow every day. Miss them and
  they get grumpy, and some will find another landscaper.
- **Fuel:** refuel at your truck at the west end of the street. Run dry and you'll be towed back for $25.
- **Evenings:** see the day's takings and spend them on a wider deck, a faster engine, a bigger tank or a
  stronger leaf vac.

Controls: WASD / arrow keys to drive, Shift for full throttle, Esc to pause, M to mute. On touch screens,
drag anywhere to steer and hold ⚡ for full throttle.

## Development

```bash
npm install
npm run dev      # play locally with hot reload
npm run build    # typecheck + production build into dist/
```

Pushing to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`). Turn it on once in the
repository settings under **Pages → Source: GitHub Actions**.

## Code layout

| File | What it does |
|---|---|
| `src/game.ts` | Game state, the day cycle, driving, mowing, knocking, jobs, fuel, HUD wiring |
| `src/world.ts` | Builds the street: lots, houses, trees, the truck, collision boxes, and a grid classifying every 0.5 m cell as lawn / flower bed / paving |
| `src/lawn.ts` | Instanced grass tufts that shrink when cut, mow stripes painted into the ground texture, flowers, leaves |
| `src/mower.ts` | The riding mower model |
| `src/hud.ts`, `src/style.css` | DOM HUD, dialogs, end-of-day shop |
| `src/sfx.ts` | Sound effects (procedural, no audio files) |
| `src/config.ts` | Layout constants, day length, prices, upgrades |
| `engine/` | The movement and game-feel engine from [Clean Sweep](https://github.com/iant89/Clean-Sweep); see `engine/README.md` |

The engine is a copy of Clean Sweep's, so fixes don't sync between the two repos automatically. The
folder is self-contained, so copying it across works.

`window.game` exposes the running game in the browser console for debugging.
