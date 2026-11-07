/**
 * Pure logic for Station Ops (stationops.ts): the room's layout (the two oval
 * viewports, the consoles and their graph screens, the situation table), the
 * station outside (the docking ring, its pylons and beacons), and the schedules
 * of everything that changes: ships arriving and departing, the anomaly slowly
 * opening and closing, the console lights dimming and brightening, and the
 * red-alert pulse. Nothing here touches GL, so it is all unit tested.
 *
 * Layout units are "frame units": the origin at the frame's centre, y up, and
 * one unit the frame's height. The room is designed for 16:9 in "design units",
 * the same but with x squeezed by `layoutK` on narrower frames, so it keeps its
 * proportions; wider frames extend the outer walls.
 */
import { clamp, smoothstep } from "../math";
import { hash32 } from "../noise";
import type { OutsideId } from "./stationops.meta";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** The aspect the room is drawn for. */
export const DESIGN_ASPECT = 16 / 9;

/** How much design x is squeezed for a frame of `aspect`: 1 at 16:9 and wider. */
export function layoutK(aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DESIGN_ASPECT;
  return Math.min(1, a / DESIGN_ASPECT);
}

/** The viewports: centres at (±VIEW_X, VIEW_Y), radii VIEW_RX by VIEW_RY, in design units. */
export const VIEW_X = 0.6;
export const VIEW_Y = 0.1;
export const VIEW_RX = 0.24;
export const VIEW_RY = 0.215;
/** Width of the viewports' bronze frames, round the glass. */
export const FRAME_W = 0.032;

/** The consoles' inner ends (design |x|), and their top faces' front and back edges. */
export const CONSOLE_INNER = 0.3;
export const consoleFront = (u: number) => -0.35 + 0.02 * (u - CONSOLE_INNER);
export const consoleBack = (u: number) => -0.25 + 0.03 * (u - CONSOLE_INNER);

/** The situation table's top: an ellipse centred at (0, TABLE_Y), radii TABLE_RX by TABLE_RY. */
export const TABLE_Y = -0.5;
export const TABLE_RX = 0.36;
export const TABLE_RY = 0.11;

/** Live graph screens on the consoles' tops: |x| from and to, y from and to (design units). */
export const GRAPH_SPANS: readonly (readonly [number, number])[] = [
  [0.42, 0.53],
  [0.66, 0.77],
];
export const GRAPH_Y0 = -0.318;
export const GRAPH_Y1 = -0.27;
/** Graph screens in all: each span on both sides. */
export const GRAPH_COUNT = GRAPH_SPANS.length * 2;

/** The docking ring's far arc, seen from above it: an ellipse's centre and radii (design units). */
export const RING = [-0.45, -0.62, 0.9, 0.58] as const;

/** The top edge of the ring at design x, or NaN beyond it. */
export function ringTop(x: number): number {
  const u = (x - RING[0]) / RING[2];
  return Math.abs(u) < 1 ? RING[1] + RING[3] * Math.sqrt(1 - u * u) : Number.NaN;
}

/**
 * The docking pylons rising from the ring: each a quadratic curve (base,
 * control, tip) and its width at the base and the tip, in design units. The
 * nearer one sweeps up and over the left viewport; a farther, thinner one rises
 * by its inner edge.
 */
export const PYLONS: readonly (readonly number[])[] = [
  [-0.72, -0.075, -0.82, 0.2, -0.56, 0.27, 0.03, 0.008],
  [-0.44, -0.045, -0.4, 0.12, -0.47, 0.19, 0.016, 0.005],
];

/** The ship lanes' far end: below the left viewport, behind the ring (design units). */
export const DOCK = [-0.6, -0.14] as const;
/** Where ships enter or leave the view: off the left edge, high and low, and from above. */
export const ENTRIES: readonly (readonly [number, number])[] = [
  [-1.35, 0.24],
  [-1.3, -0.02],
  [-0.78, 0.72],
];

/** The outside view for a param value, defaulting to the station and stars. */
export const outsideId = (v: string): OutsideId =>
  v === "anomaly" || v === "planet" ? v : "station";

/** Where the anomaly opens, by outside view: centre (design units) and full radius (frame heights). */
export const ANOMALY_SITES: Readonly<Record<OutsideId, readonly [number, number, number]>> = {
  station: [0.64, 0.17, 0.075],
  anomaly: [0.6, 0.11, 0.165],
  planet: [0.68, 0.23, 0.06],
};

/** The planet below the right viewport: centre (design units) and radius (frame heights). */
export const PLANET = [0.74, -0.31, 0.32] as const;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OpsLayout {
  aspect: number;
  /** Design-to-frame squeeze of x. */
  k: number;
  /** The live graph screens, in frame units. */
  graphs: Rect[];
  /** The station's beacons (frame units): the pylons' tips and a light on the ring. */
  beacons: [number, number][];
}

/** The room's live parts for a frame of `aspect`. */
export function opsLayout(aspect: number): OpsLayout {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DESIGN_ASPECT;
  const k = layoutK(a);
  const graphs: Rect[] = [];
  for (const side of [-1, 1]) {
    for (const [u0, u1] of GRAPH_SPANS) {
      const xa = side * u0 * k;
      const xb = side * u1 * k;
      graphs.push({ x0: Math.min(xa, xb), y0: GRAPH_Y0, x1: Math.max(xa, xb), y1: GRAPH_Y1 });
    }
  }
  const beacons: [number, number][] = PYLONS.map((p) => [p[4] * k, p[5] + 0.004]);
  beacons.push([-0.52 * k, ringTop(-0.52) + 0.003]);
  return { aspect: a, k, graphs, beacons };
}

/**
 * Signed distance-like measure to the nearer viewport's glass at design point
 * (x, y): negative inside, about the distance outside.
 */
export function viewportDistance(x: number, y: number): number {
  const qx = (Math.abs(x) - VIEW_X) / VIEW_RX;
  const qy = (y - VIEW_Y) / VIEW_RY;
  return (Math.hypot(qx, qy) - 1) * Math.min(VIEW_RX, VIEW_RY);
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** A uniform 0..1 for slot `slot` of the event stream `salt`. */
function slotRandom(seed: number, salt: number, slot: number, k = 0): number {
  return (
    hash32(
      hash32(Math.floor(seed) * 8 + salt) ^ Math.imul(slot + 1, 0x9e3779b1) ^ (k * 0x85ebca6b),
    ) / 4294967296
  );
}

/** Smootherstep: 0 at 0, 1 at 1, with zero slope and curvature at both ends. */
export function smoother(x: number): number {
  const u = clamp(x, 0, 1);
  return u * u * u * (u * (u * 6 - 15) + 10);
}

/** When an event happens in a slot, and which slot. */
export interface Scheduled {
  /** How far through the event `t` is (0..1), or -1 between events. */
  phase: number;
  slot: number;
}

/**
 * One event `length` s long in each `gap` s slot, starting at a seeded moment
 * at least `lead` s into its slot. Events therefore never overlap, are always
 * at least `lead` s apart, and the first comes no sooner than `lead` s in.
 */
export function scheduled(
  t: number,
  seed: number,
  salt: number,
  gap: number,
  length: number,
  lead: number,
  out: Scheduled,
): Scheduled {
  out.phase = -1;
  out.slot = 0;
  if (!(t > 0) || !(gap > length + lead)) {
    return out;
  }
  const slot = Math.floor(t / gap);
  out.slot = slot;
  const start = slot * gap + lead + slotRandom(seed, salt, slot) * (gap - length - lead);
  const u = (t - start) / length;
  out.phase = u >= 0 && u <= 1 ? u : -1;
  return out;
}

export const createScheduled = (): Scheduled => ({ phase: -1, slot: 0 });

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

/** Camera focal length for the ships outside, in frame heights. */
export const FOCAL = 1.8;
/** Depth of the station's ring and pylons; ships farther than this pass behind them. */
export const STATION_Z = 20;
/** Depth where a lane starts (off-screen, close by) and ends (at the dock). */
export const ENTRY_Z = 4.5;
export const DOCK_Z = 24;
/** The ships, in the order the ship shader numbers them, and their sizes. */
export const SHIP_NAMES = ["runabout", "freighter", "cruiser"] as const;
export const SHIP_SCALES: readonly number[] = [0.42, 0.72, 0.95];
/** Radius of the sphere every ship (at scale 1) fits inside. */
export const SHIP_RADIUS = 0.7;

/** Seconds between passes, per traffic setting ("off" or unknown: none), and how long each takes. */
export const QUIET_GAP = 150;
export const BUSY_GAP = 70;
export const trafficGap = (traffic: string) =>
  traffic === "busy" ? BUSY_GAP : traffic === "quiet" ? QUIET_GAP : 0;
export const PASS_LENGTH = 40;
/** Seconds of quiet at least before each pass (and at the start). */
export const TRAFFIC_LEAD = 12;
const TRAFFIC_SALT = 1;

/** A ship arriving or departing; `kind` is -1 when none is in view. */
export interface ShipPass {
  kind: number;
  /** Centre in view space (eye at the origin looking along +z, frame-height units at z = FOCAL). */
  x: number;
  y: number;
  z: number;
  scale: number;
  /** Turn about the vertical: 0 faces the viewer, +π/2 points to +x. */
  yaw: number;
  arriving: boolean;
}

export const createShipPass = (): ShipPass => ({
  kind: -1,
  x: 0,
  y: 0,
  z: 1,
  scale: 1,
  yaw: 0,
  arriving: true,
});

const passSched = createScheduled();

/**
 * The ship in view at `t`, for traffic `traffic`, written into `out`. An
 * arriving ship comes in from off the left edge or from above, slowing as it
 * nears the dock behind the ring; a departing one leaves the same way,
 * gathering speed. At both ends of a pass the ship is out of sight. `k` is the
 * layout's design-to-frame squeeze. Allocates nothing.
 */
export function shipAt(
  t: number,
  seed: number,
  traffic: string,
  k: number,
  out: ShipPass,
): ShipPass {
  out.kind = -1;
  const gap = trafficGap(traffic);
  if (gap <= 0) {
    return out;
  }
  const s = scheduled(t, seed, TRAFFIC_SALT, gap, PASS_LENGTH, TRAFFIC_LEAD, passSched);
  if (s.phase < 0) {
    return out;
  }
  const kind = Math.min(
    SHIP_NAMES.length - 1,
    Math.floor(slotRandom(seed, TRAFFIC_SALT, s.slot, 1) * SHIP_NAMES.length),
  );
  const arriving = slotRandom(seed, TRAFFIC_SALT, s.slot, 2) < 0.5;
  const entry =
    ENTRIES[
      Math.min(ENTRIES.length - 1, Math.floor(slotRandom(seed, TRAFFIC_SALT, s.slot, 3) * 3))
    ];
  const lane = (slotRandom(seed, TRAFFIC_SALT, s.slot, 4) - 0.5) * 0.12;
  // Along the lane from the entry (0) to the dock (1).
  const u = s.phase;
  const along = arriving ? 1 - (1 - u) * (1 - u) : 1 - u * u;
  const ex = (entry[0] * k * ENTRY_Z) / FOCAL;
  const ey = ((entry[1] + lane) * ENTRY_Z) / FOCAL;
  const dx = (DOCK[0] * k * DOCK_Z) / FOCAL;
  const dy = (DOCK[1] * DOCK_Z) / FOCAL;
  out.kind = kind;
  out.arriving = arriving;
  out.x = ex + (dx - ex) * along;
  out.y = ey + (dy - ey) * along;
  out.z = ENTRY_Z + (DOCK_Z - ENTRY_Z) * along;
  out.scale = SHIP_SCALES[kind];
  // Bow along the direction of travel.
  const vx = arriving ? dx - ex : ex - dx;
  const vz = arriving ? DOCK_Z - ENTRY_Z : ENTRY_Z - DOCK_Z;
  out.yaw = Math.atan2(vx, -vz);
  return out;
}

/** Where a view-space point appears in the frame (frame units). */
export function project(x: number, y: number, z: number, out: Float64Array): Float64Array {
  const zz = Math.max(z, 1e-6);
  out[0] = (x * FOCAL) / zz;
  out[1] = (y * FOCAL) / zz;
  return out;
}

// ---------------------------------------------------------------------------
// The anomaly
// ---------------------------------------------------------------------------

/** Seconds between openings, per outside view: rare, a little less so when it's nearby. */
export const ANOMALY_GAP: Readonly<Record<OutsideId, number>> = {
  station: 420,
  anomaly: 240,
  planet: 420,
};
/** Seconds opening, held open and closing. */
export const ANOMALY_OPEN = 12;
export const ANOMALY_HOLD = 26;
export const ANOMALY_CLOSE = 12;
export const ANOMALY_LENGTH = ANOMALY_OPEN + ANOMALY_HOLD + ANOMALY_CLOSE;
/** Seconds of quiet at least before each opening (and at the start). */
export const ANOMALY_LEAD = 45;
/** Seconds per turn of the swirl. */
export const ANOMALY_SPIN = 40;
const ANOMALY_SALT = 2;

const anomalySched = createScheduled();

/** How open the anomaly is at `t` (0..1): eased open, held, eased closed. */
export function anomalyOpen(t: number, seed: number, outside: string, enabled: boolean): number {
  if (!enabled) {
    return 0;
  }
  const s = scheduled(
    t,
    seed,
    ANOMALY_SALT,
    ANOMALY_GAP[outsideId(outside)],
    ANOMALY_LENGTH,
    ANOMALY_LEAD,
    anomalySched,
  );
  if (s.phase < 0) {
    return 0;
  }
  const e = s.phase * ANOMALY_LENGTH;
  if (e < ANOMALY_OPEN) {
    return smoother(e / ANOMALY_OPEN);
  }
  if (e < ANOMALY_OPEN + ANOMALY_HOLD) {
    return 1;
  }
  return 1 - smoother((e - ANOMALY_OPEN - ANOMALY_HOLD) / ANOMALY_CLOSE);
}

// ---------------------------------------------------------------------------
// Console lights
// ---------------------------------------------------------------------------

/** Console light cells: the room tags each glowing panel with one of these. */
export const CELL_COUNT = 256;
/** Seconds per cell slot at most; each cell's is between 55% and 100% of it. */
export const CELL_SLOT = 14;
/** Seconds a cell takes to dim or brighten: never a sudden change. */
export const CELL_RAMP = 1;
/** Chance of a change in a cell's slot. */
const CELL_RATE = 0.4;
/** A cell's level when dimmed and when brightened. */
export const CELL_DIM = 0.3;
export const CELL_BRIGHT = 1.25;
const CELL_SALT = 3;
/** A cell that never changes, for the calm light behind the speaker, and its level. */
export const STEADY_CELL = CELL_COUNT - 1;
export const STEADY_LEVEL = 0.85;

/** Cell `id`'s resting level for `seed`: 0.7..1. */
export function cellBase(id: number, seed: number): number {
  return 0.7 + 0.3 * slotRandom(seed, CELL_SALT, id, 7);
}

/**
 * Cell `id`'s brightness at `t`: its resting level, now and then easing down
 * (or up) for a few seconds and back. Each change ramps over `CELL_RAMP` s.
 */
export function cellLevel(id: number, t: number, seed: number): number {
  if (id === STEADY_CELL) {
    return STEADY_LEVEL;
  }
  const base = cellBase(id, seed);
  if (!(t > 0)) {
    return base;
  }
  const len = CELL_SLOT * (0.55 + 0.45 * slotRandom(seed, CELL_SALT, id, 8));
  const slot = Math.floor(t / len);
  const key = id * 4096 + slot;
  if (slotRandom(seed, CELL_SALT + 1, key) >= CELL_RATE) {
    return base;
  }
  const dur = 2 * CELL_RAMP + (len - 2 * CELL_RAMP) * 0.5 * slotRandom(seed, CELL_SALT + 1, key, 1);
  const start = slot * len + (len - dur) * slotRandom(seed, CELL_SALT + 1, key, 2);
  const w =
    smoothstep(start, start + CELL_RAMP, t) *
    (1 - smoothstep(start + dur - CELL_RAMP, start + dur, t));
  const to = slotRandom(seed, CELL_SALT + 1, key, 3) < 0.7 ? CELL_DIM : CELL_BRIGHT;
  return base + (to - base) * w;
}

/** Fills `out` (CELL_COUNT bytes) with every cell's level at `t`, scaled so 255 is CELL_BRIGHT. */
export function fillCellLevels(t: number, seed: number, out: Uint8Array): Uint8Array {
  const n = Math.min(out.length, CELL_COUNT);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round((clamp(cellLevel(i, t, seed), 0, CELL_BRIGHT) / CELL_BRIGHT) * 255);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

/** Seconds to fade fully from one lighting to another. */
export const LIGHTING_FADE = 1.5;
/** Seconds per red-alert pulse: slow and smooth, never a flash. */
export const ALERT_PERIOD = 4;

/** The red-alert pulse at `t`, 0..1, easing up and down once per period. */
export function alertPulse(t: number): number {
  const x = Number.isFinite(t) ? t : 0;
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / ALERT_PERIOD);
}

/** How far each lighting is towards the night shift's dimness and red alert's redness. */
export function lightingTargets(id: string, out: Float64Array): Float64Array {
  out[0] = id === "night" ? 1 : 0;
  out[1] = id === "red" ? 1 : 0;
  return out;
}

/** Seconds per beacon pulse on the station outside. */
export const BEACON_PERIOD = 3.2;
