# Landscaping Inc.

A browser game about building a lawn-care business one house at a time. Drive your riding mower around the
neighbourhood, knock on doors, win customers, keep to their schedules and keep their lawns perfect.

**How it plays**

- **Knock** by driving up to a front door marked **!**. Each owner tells you what they want: how many
  cuts a week (1–3, on set weekdays) and which services (mowing always, plus 🍂 leaf clearing,
  📏 edging and ✂️ hedge trimming for some). The offer shows how busy those days already are. Pitch
  full price or offer a discount to raise your odds. The discounted price is what they'll pay every visit.
- **Trial visit:** get hired and you do a trial visit that day, before the deadline. Finish it and they
  become a regular, booked on their days.
- **The schedule** (📅 button or C) shows the week: who's booked each day, what's done ✓ and what was
  missed ✕. A missed booking is a strike, and two strikes lose the customer. Two good visits in a row
  wipe a strike.
- **Grass grows**: lawns don't reset overnight. They grow a little each night, faster after rain, so a
  customer you skip gets shaggier. Mown lawns keep their stripes for a day or two.
- **Edging** means driving the borders where grass creeps over the paving. **Hedges** are trimmed by
  brushing along them, and they grow shaggy again after about a week.
- **Weather** comes with a 4-day forecast. Rain makes the mower slide (Turf Tires help) and makes grass
  shoot up. Wind keeps blowing leaves onto driveways.
- **Green Giant Lawns** shows up from day 3. Their blue mower heads for one of your prospects; get
  hired there first and they turn back. They also poach customers you let down.
- **Crew** (from the evening shop) drive their own mowers to your booked lawns and mow them. They
  cost a hire fee plus a daily wage.
- **More streets:** Oak Avenue opens at 3 regulars and ★3.5, Birch Lane at 7 regulars and ★4.0.
  Each street has a gas station at its west end. Get there via the cross road at the east end.
- Finishing early earns a tip. Squashed flowers and gnomes you've hit come out of your pay. Run out of
  gas and you'll be towed for $25.

Controls: WASD / arrow keys to drive, Shift for full throttle, C for the schedule, Esc to pause, M to mute. On touch screens,
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
| `src/game.ts` | Game state, the day/week cycle, schedules and strikes, driving, mowing, knocking, crew, rival, fuel, weather, HUD wiring |
| `src/npc.ts` | AI mowers (crew and rival): route planning along the roads and lane-by-lane mowing of a lot |
| `src/weather.ts` | Weather types, the forecast roll, and rain effects |
| `src/world.ts` | Builds the three streets: lots, houses, hedges, trees, truck, gas stations, barriers, collision boxes, and a grid classifying every 0.5 m cell as lawn / flower bed / paving / edge |
| `src/lawn.ts` | Instanced grass tufts that grow and get cut, edge creep, mow stripes painted into per-street ground textures, flowers, leaves |
| `src/mower.ts` | The riding mower model |
| `src/hud.ts`, `src/style.css` | DOM HUD, dialogs, end-of-day shop |
| `src/sfx.ts` | Sound effects (procedural, no audio files) |
| `src/config.ts` | Layout constants, day length, prices, upgrades |
| `engine/` | The movement and game-feel engine from [Clean Sweep](https://github.com/iant89/Clean-Sweep); see `engine/README.md` |

The engine is a copy of Clean Sweep's, so fixes don't sync between the two repos automatically. The
folder is self-contained, so copying it across works.

`window.game` exposes the running game in the browser console for debugging.
