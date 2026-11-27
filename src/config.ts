/** World layout: one street running east-west, lots on both sides. 1 unit ≈ 1 metre. */
export const LOT_W = 22;
export const LOTS_PER_SIDE = 4;
export const STREET_END = LOTS_PER_SIDE * LOT_W;

/** Grass is tracked on a grid of CELL x CELL squares covering the whole world. */
export const CELL = 0.5;
export const MIN_X = -26;
export const MAX_X = STREET_END + 12;
export const MIN_Z = -36;
export const MAX_Z = 36;
export const GW = Math.round((MAX_X - MIN_X) / CELL);
export const GH = Math.round((MAX_Z - MIN_Z) / CELL);

/** Distances from the road's centre line (local "d" in a lot). */
export const ROAD = 4; // road is |z| < 4
export const WALK = 6; // sidewalk is 4 <= |z| < 6
export const HOUSE_D0 = 18; // house front wall
export const HOUSE_D1 = 28; // house back wall
export const LOT_D1 = 30; // back fence

/** Ground texture resolution (pixels per world unit). */
export const PX = 10;

/** The working day, in hours, and how many real seconds each hour lasts. */
export const DAY_START = 8;
export const DAY_END = 18;
export const SEC_PER_HOUR = 24;

/** Where your truck's fuel pump ring sits (and where each morning starts). */
export const PUMP = { x: -5, z: -1.8 };
export const PUMP_R = 1.5;
export const FUEL_PRICE = 0.15; // $ per unit of fuel
export const TOW_FEE = 25;

export const STREET_NAME = 'Maple Street';

/** Cell kinds. */
export const K_NONE = 0;
export const K_LAWN = 1;
export const K_BED = 2;
export const K_PAVED = 3;

export type UpKey = 'deck' | 'engine' | 'tank' | 'bagger';
export interface UpgradeDef { key: UpKey; name: string; desc: string; icon: string; costs: number[] }
export const UPGRADES: UpgradeDef[] = [
  { key: 'deck', name: 'Wide Deck', desc: '+18% cutting width', icon: '🌀', costs: [60, 120, 220, 380] },
  { key: 'engine', name: 'V-Twin Engine', desc: '+12% top speed', icon: '⚙️', costs: [50, 110, 200, 340] },
  { key: 'tank', name: 'Big Tank', desc: '+35% fuel capacity', icon: '⛽', costs: [40, 90, 160, 260] },
  { key: 'bagger', name: 'Leaf Vac', desc: '+30% leaf pickup range', icon: '🍂', costs: [40, 90, 160, 260] },
];

export const OWNERS = [
  'the Garcias', 'Mr. Okafor', 'Mrs. Lindqvist', 'the Nguyens', 'Dr. Patel', 'Ms. Romano',
  'the Hendersons', 'Mr. Kowalski', 'Grandma Rose', 'the Tanakas', 'Mrs. Dubois', 'Mr. Abernathy',
];

export function fmtHour(h: number) {
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60 / 15) * 15;
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

export const cellIndex = (x: number, z: number) => {
  const gx = Math.floor((x - MIN_X) / CELL), gz = Math.floor((z - MIN_Z) / CELL);
  if (gx < 0 || gz < 0 || gx >= GW || gz >= GH) return -1;
  return gz * GW + gx;
};
export const cellX = (i: number) => MIN_X + ((i % GW) + 0.5) * CELL;
export const cellZ = (i: number) => MIN_Z + (Math.floor(i / GW) + 0.5) * CELL;
