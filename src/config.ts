/** World layout: parallel streets running east-west, lots on both sides, joined by a cross road at the east end. */
export const LOT_W = 22;
export const LOTS_PER_SIDE = 4;
export const STREET_END = LOTS_PER_SIDE * LOT_W;
/** Distance between street centre lines; each street owns a 66-unit band of the world. */
export const STREET_GAP = 66;
export const BAND = STREET_GAP / 2;

export interface StreetDef { name: string; need: { regulars: number; rep: number } }
export const STREETS: StreetDef[] = [
  { name: 'Maple Street', need: { regulars: 0, rep: 0 } },
  { name: 'Oak Avenue', need: { regulars: 3, rep: 3.5 } },
  { name: 'Birch Lane', need: { regulars: 7, rep: 4.0 } },
];
export const streetZ = (i: number) => i * STREET_GAP;
/** Nearest street to a world z. */
export const streetAt = (z: number) => Math.max(0, Math.min(STREETS.length - 1, Math.round(z / STREET_GAP)));

/** North-south cross road joining the street ends. */
export const CROSS_X0 = STREET_END + 2;
export const CROSS_X1 = STREET_END + 10;
export const CROSS_MID = (CROSS_X0 + CROSS_X1) / 2;

/** Grass is tracked on a grid of CELL x CELL squares covering the whole world. */
export const CELL = 0.5;
export const MIN_X = -26;
export const MAX_X = STREET_END + 12;
export const MIN_Z = -BAND;
export const MAX_Z = streetZ(STREETS.length - 1) + BAND;
export const GW = Math.round((MAX_X - MIN_X) / CELL);
export const GH = Math.round((MAX_Z - MIN_Z) / CELL);

/** Distances from a road's centre line (local "d" in a lot). */
export const ROAD = 4;
export const WALK = 6;
export const HOUSE_D0 = 18;
export const HOUSE_D1 = 28;
export const LOT_D1 = 30;
/** Side hedges between lots run from here back to the fence. */
export const HEDGE_D0 = 19;

/** Ground texture resolution (pixels per world unit). */
export const PX = 8;

/** The working day, in hours, and how many real seconds each hour lasts. */
export const DAY_START = 8;
export const DAY_END = 18;
export const SEC_PER_HOUR = 27;
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Your truck's fuel ring on Maple Street (and where each morning starts). */
export const PUMP = { x: -5, z: -1.8 };
export const PUMP_R = 1.5;
export const FUEL_PRICE = 0.15;
export const TOW_FEE = 25;

/** Crew. */
export const HELPER_COST = [150, 250, 400];
export const HELPER_WAGE = 25;
export const HELPER_NAMES = ['Sam', 'Priya', 'Diego'];

/** A missed booked visit is a strike; this many and the customer leaves. */
export const MAX_STRIKES = 2;

/** Cell kinds. */
export const K_NONE = 0;
export const K_LAWN = 1;
export const K_BED = 2;
export const K_PAVED = 3;

export type UpKey = 'deck' | 'engine' | 'tank' | 'bagger' | 'tires';
export interface UpgradeDef { key: UpKey; name: string; desc: string; icon: string; costs: number[] }
export const UPGRADES: UpgradeDef[] = [
  { key: 'deck', name: 'Wide Deck', desc: '+18% cutting width', icon: '🌀', costs: [60, 120, 220, 380] },
  { key: 'engine', name: 'V-Twin Engine', desc: '+12% top speed', icon: '⚙️', costs: [50, 110, 200, 340] },
  { key: 'tank', name: 'Big Tank', desc: '+35% fuel capacity', icon: '⛽', costs: [40, 90, 160, 260] },
  { key: 'bagger', name: 'Leaf Vac', desc: '+30% leaf pickup range', icon: '🍂', costs: [40, 90, 160, 260] },
  { key: 'tires', name: 'Turf Tires', desc: 'Better grip in the rain', icon: '🛞', costs: [50, 110, 200] },
];

export const OWNERS = [
  'the Garcias', 'Mr. Okafor', 'Mrs. Lindqvist', 'the Nguyens', 'Dr. Patel', 'Ms. Romano',
  'the Hendersons', 'Mr. Kowalski', 'Grandma Rose', 'the Tanakas', 'Mrs. Dubois', 'Mr. Abernathy',
  'the Morales', 'Mr. Brennan', 'Ms. Achebe', 'the Johanssons', 'Mrs. Kim', 'Mr. Fitzgerald',
  'the Castellanos', 'Dr. Weiss', 'Ms. Haddad', 'the O\'Briens', 'Mr. Silva', 'Auntie Mae',
];

export function fmtHour(h: number) {
  const hh = Math.floor(h), mm = Math.floor(((h - hh) * 60) / 15) * 15;
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
