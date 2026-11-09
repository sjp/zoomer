/**
 * Pure JS logic for the Night Train Dining Car (diningcar.ts): the layout of
 * the window, table and the things on it, the rail-joint jolt schedule, the
 * damped springs that let the wine and the lamp's fringe settle after each
 * jolt, the carriage's rock, and the schedule of lit stations and level
 * crossings passing the window with the light they throw on the table.
 *
 * The landscape outside reuses the Train Window's world (`train-sim.ts`):
 * the same focal length, layer depths and column tables, so positions here are
 * in its world units. Nothing here touches GL, so it is all unit tested.
 */
import { approach, clamp, smoothstep } from "../math";
import { createRng } from "../noise";
import { FOCAL, SWAY_AMP, swayOffset, V_MAX } from "../train/train-sim";
import type { Drink } from "./diningcar.meta";

// ---------------------------------------------------------------------------
// Layout (reference px, y up from the bottom of a 1080-high frame)
// ---------------------------------------------------------------------------

/** Back edge of the table, where the cloth meets the wall under the window. */
export const TABLE_Y = 250;
/** Bottom and top of the window glass. */
export const WIN_Y0 = 316;
export const WIN_Y1 = 960;
/** Corner radius of each pane and the width of its brass frame. */
export const WIN_RADIUS = 58;
export const FRAME_W = 16;
/** Half width of the panelled post between the two panes, behind the speaker. */
const POST_HALF = 72;
/** Where the lamp, vase and drink stand on the cloth (y of their bases). */
export const LAMP_BASE_Y = 214;
export const VASE_BASE_Y = 222;
export const VESSEL_BASE_Y = 150;
/** Lamp stem top, shade top and the bottom edge of the shade's fringe. */
export const SHADE_Y0 = 396;
export const SHADE_Y1 = 486;
export const SHADE_HALF0 = 78;
export const SHADE_HALF1 = 44;
export const FRINGE_LEN = 15;
/** Top of the upholstered seat backs at the frame's sides. */
export const SEAT_TOP = 700;

export interface DiningLayout {
  /** Frame width and centre, reference px. */
  readonly width: number;
  readonly cx: number;
  /** Left pane's left and right edges, then the right pane's. */
  readonly paneL0: number;
  readonly paneL1: number;
  readonly paneR0: number;
  readonly paneR1: number;
  /** Centres of the lamp, the bud vase and the drink. */
  readonly lampX: number;
  readonly vaseX: number;
  readonly vesselX: number;
  /** Width of the seat backs at each side, and of the gathered curtains at the panes' outer edges. */
  readonly seatW: number;
  readonly curtainW: number;
}

/**
 * The scene for a frame `refWidth` reference px wide: two panes either side
 * of a post at the centre (behind the speaker), the lamp just left of the
 * speaker, the vase further out and the drink on the right, all in the outer
 * thirds so the middle stays calm.
 */
export function diningLayout(refWidth: number): DiningLayout {
  const width = Math.max(1, refWidth);
  const cx = width / 2;
  const seatW = clamp(0.045 * width, 40, 110);
  const paneL0 = Math.min(Math.max(seatW + 50, 0.07 * width), cx - POST_HALF - 120);
  return {
    width,
    cx,
    paneL0,
    paneL1: cx - POST_HALF,
    paneR0: cx + POST_HALF,
    paneR1: width - paneL0,
    lampX: cx - Math.max(0.2 * width, SHADE_HALF0 + 110),
    vaseX: cx - Math.max(0.36 * width, SHADE_HALF0 + 190),
    vesselX: cx + Math.max(0.23 * width, 150),
    seatW,
    curtainW: clamp(0.085 * width, 70, 200),
  };
}

// ---------------------------------------------------------------------------
// The train
// ---------------------------------------------------------------------------

/**
 * Train speed at speed 1, world units per second: faster than the Train
 * Window's local, so the express's near poles pass at about 750 px/s at full
 * speed and the hills still barely move.
 */
export const EXPRESS_V = 6;
/** Converts the Train Window's position (which tops out at `V_MAX`) to the express's. */
export const POS_SCALE = EXPRESS_V / V_MAX;

/** Soft trackside poles: depth (world units) and screen spacing (reference px). */
export const POLE_Z = 7;
export const POLE_SPACING = 1800;

/** Vertical rock of the table at full speed, reference px, and its tilt (radians). */
export const ROCK_PX = 2.2;
export const ROCK_TILT = 0.0012;

/**
 * The carriage's slow rock at `time` seconds and speed `speed` (0..1): the
 * Train Window's sway, reused for the vertical offset (reference px) and, a
 * little later, the tilt (radians). Still when the train stands.
 */
export function rockAt(time: number, speed: number, out: { dy: number; tilt: number }) {
  const s = smoothstep(0, 0.25, speed);
  out.dy = (swayOffset(time, 1, 1) / SWAY_AMP) * ROCK_PX * s;
  out.tilt = (swayOffset(time * 0.8 + 2.1, 1, 1) / SWAY_AMP) * ROCK_TILT * s;
  return out;
}

// ---------------------------------------------------------------------------
// Rail-joint jolts
// ---------------------------------------------------------------------------

/** Distance between rail joints, world units: a jolt every 1.5 s at the default speed. */
export const RAIL_LEN = 3.6;
/** Jolts never come closer together than this, seconds, however fast the train. */
export const MIN_JOLT_GAP = 1;
/** Relative jitter of each rail length and of the minimum gap. */
export const JOLT_JITTER = 0.08;

interface Jolts {
  readonly rng: () => number;
  /** Distance to the next joint, world units. */
  until: number;
  /** Seconds since the last jolt, and the hold (at least `MIN_JOLT_GAP`) before the next may come. */
  since: number;
  hold: number;
}

export function createJolts(seed: number): Jolts {
  const rng = createRng(Math.floor(seed) * 4099 + 17);
  return { rng, until: RAIL_LEN * (0.3 + 0.7 * rng()), since: 0, hold: MIN_JOLT_GAP };
}

/**
 * Advances the jolts by `dt` seconds at velocity `v` (world units per
 * second) and returns true when a wheel crosses a rail joint this step. Joints
 * come every `RAIL_LEN` (jittered) of travel, but never sooner than the hold
 * after the last jolt: a faster train just meets them at the minimum gap.
 */
export function stepJolts(j: Jolts, dt: number, v: number): boolean {
  const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  j.since += step;
  j.until -= Math.abs(v) * step;
  if (j.until > 0 || j.since < j.hold) {
    return false;
  }
  j.until = RAIL_LEN * (1 + JOLT_JITTER * (2 * j.rng() - 1));
  j.hold = MIN_JOLT_GAP * (1 + JOLT_JITTER * j.rng());
  j.since = 0;
  return true;
}

// ---------------------------------------------------------------------------
// Springs
// ---------------------------------------------------------------------------

interface Spring {
  /** Displacement and velocity. */
  x: number;
  v: number;
}

export const createSpring = (): Spring => ({ x: 0, v: 0 });

const SPRING_STEP = 1 / 120;

/**
 * Advances a damped spring towards `target` by `dt` seconds (capped at 0.1 s)
 * with semi-implicit Euler substeps, at `hz` with damping ratio `damping`,
 * and bounds it to `target +- max`. Returns the displacement.
 */
export function stepSpring(
  s: Spring,
  dt: number,
  hz: number,
  damping: number,
  max: number,
  target = 0,
): number {
  const total = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  const steps = Math.max(1, Math.ceil(total / SPRING_STEP));
  const h = total / steps;
  const w = 2 * Math.PI * hz;
  let x = s.x - target;
  let v = s.v;
  for (let i = 0; i < steps; i++) {
    v += (-w * w * x - 2 * damping * w * v) * h;
    x += v * h;
  }
  if (x > max || x < -max) {
    x = clamp(x, -max, max);
    v = 0;
  }
  s.x = x + target;
  s.v = v;
  return s.x;
}

/** The wine's tilt relative to the glass (radians): a few sloshes, settled within about 2 s. */
export const LIQUID_HZ = 1.8;
export const LIQUID_DAMPING = 0.14;
export const LIQUID_MAX = 0.16;
/** Angular velocity one jolt gives it, radians per second. */
export const LIQUID_KICK = 0.6;
/** The fringe's swing (radians), looser and slower. */
export const FRINGE_HZ = 1.3;
export const FRINGE_DAMPING = 0.2;
export const FRINGE_MAX = 0.3;
export const FRINGE_KICK = 0.9;
/** The table's vertical bump on a jolt, reference px. */
export const BUMP_HZ = 5;
export const BUMP_DAMPING = 0.45;
export const BUMP_MAX = 3;
export const BUMP_KICK = 60;

// ---------------------------------------------------------------------------
// Stations and level crossings
// ---------------------------------------------------------------------------

/** Depth of the platform and its lamps, and of the buildings behind, world units. */
export const STATION_Z = 10;
export const BUILDING_Z = 17;
/** Platform length and lamp spacing (world units) for a station; a crossing has two lamps. */
const STATION_LEN = 48;
const STATION_LAMP_GAP = 8;
const CROSSING_LEN = 5;
/** Gap from one lit place to the next, world units: about a minute at full `stations` and default speed, ten at the least. */
const MIN_STATION_GAP = 150;
const MAX_STATION_GAP = 1450;
/** Share of lit places that are level crossings rather than stations. */
const CROSSING_SHARE = 0.4;
/** Seconds for the station's light on the table to come up or fade: never a flash. */
export const STATION_RAMP = 1.6;
/** Peak light on the table: a station, and a crossing's two lamps. */
const STATION_LIGHT = 1;
const CROSSING_LIGHT = 0.45;

/** Mean gap between lit places for `stations` (0..1); infinite at 0. */
export function stationGap(stations: number): number {
  const s = clamp(stations, 0, 1);
  if (s <= 0) {
    return Infinity;
  }
  return MIN_STATION_GAP + (MAX_STATION_GAP - MIN_STATION_GAP) * (1 - s) ** 2;
}

interface Stations {
  readonly rng: () => number;
  /** World x of the current or next lit place's first lamp; NaN until placed. */
  at: number;
  /** Its length (world units) and kind: 0 a station, 1 a level crossing. */
  len: number;
  kind: number;
  /** The light it throws on the table, 0..1 before shaping, and the screen x it comes from. */
  light: number;
  lightX: number;
}

export function createStations(seed: number): Stations {
  return {
    rng: createRng(Math.floor(seed) * 6007 + 29),
    at: Number.NaN,
    len: 0,
    kind: 0,
    light: 0,
    lightX: 0,
  };
}

function place(st: Stations, from: number, gap: number) {
  st.at = from + gap;
  st.kind = st.rng() < CROSSING_SHARE ? 1 : 0;
  st.len = st.kind === 1 ? CROSSING_LEN : STATION_LEN;
}

/** Half the view's width at depth `z`, world units, plus a margin for the lamps' glow. */
const halfView = (cx: number, z: number) => ((cx + 200) * z) / FOCAL;

/**
 * Advances the lit places for train position `pos` (world units), `stations`
 * (0..1) and a view `cx` reference px either side of its centre: places the
 * next one ahead once the last has gone (the first comes sooner, so it shows
 * up within a minute or two), and eases the table light towards the share of
 * a lit place in view over `STATION_RAMP` seconds. Returns the light, 0..1.
 */
export function stepStations(
  st: Stations,
  dt: number,
  pos: number,
  stations: number,
  cx: number,
): number {
  const gap = stationGap(stations);
  const hw = halfView(cx, STATION_Z);
  if (!Number.isFinite(gap)) {
    // None wanted: let any in view pass, but place no more.
    if (!Number.isNaN(st.at) && st.at + st.len < pos - hw) {
      st.at = Number.NaN;
    }
  } else if (Number.isNaN(st.at)) {
    place(st, pos + hw, gap * (0.12 + 0.3 * st.rng()));
  } else if (st.at + st.len < pos - hw) {
    place(st, Math.max(st.at + st.len, pos + hw), gap * (0.7 + 0.6 * st.rng()));
  }
  let target = 0;
  if (!Number.isNaN(st.at)) {
    const k = FOCAL / STATION_Z;
    const x0 = cx + (st.at - pos) * k;
    const x1 = cx + (st.at + st.len - pos) * k;
    const lo = Math.max(x0, 0);
    const hi = Math.min(x1, 2 * cx);
    if (hi > lo) {
      target = st.kind === 1 ? CROSSING_LIGHT : STATION_LIGHT;
      st.lightX = clamp((lo + hi) / 2, 0.2 * cx, 1.8 * cx);
    }
  }
  const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  st.light = approach(st.light, target, step / STATION_RAMP);
  return st.light;
}

/** The light on the table, shaped so it eases in and out: 0..1. */
export const stationGlow = (light: number) => smoothstep(0, 1, light);

/** Floats per lit place in view: first lamp x, lamp spacing, lamp count, kind; building x, half width, lit windows, platform end x. */
export const STATION_FLOATS = 8;

/**
 * Projects the current lit place for `pos` into screen space (reference px)
 * for a view centred on `cx`. Writes `STATION_FLOATS` values; a lamp count of
 * 0 means none is placed.
 */
export function viewStation(st: Stations, pos: number, cx: number, out: Float32Array): void {
  out.fill(0);
  if (Number.isNaN(st.at)) {
    return;
  }
  const k = FOCAL / STATION_Z;
  const kb = FOCAL / BUILDING_Z;
  const station = st.kind === 0;
  out[0] = cx + (st.at - pos) * k;
  out[1] = (station ? STATION_LAMP_GAP : CROSSING_LEN) * k;
  out[2] = station ? Math.round(STATION_LEN / STATION_LAMP_GAP) + 1 : 2;
  out[3] = st.kind;
  out[4] = cx + (st.at + st.len / 2 - pos) * kb;
  out[5] = (station ? 11 : 3.2) * kb;
  out[6] = station ? 5 : 1;
  out[7] = station ? cx + (st.at + st.len - pos) * k : out[0];
}

// ---------------------------------------------------------------------------
// Drinks
// ---------------------------------------------------------------------------

interface DrinkLook {
  /** 0 a wine glass, 1 a tea glass in a brass holder. */
  readonly vessel: number;
  readonly rgb: readonly [number, number, number];
  /** Opacity of the liquid. */
  readonly alpha: number;
  /** Fill level, reference px above the vessel's base. */
  readonly level: number;
}

const DRINKS: Readonly<Record<Drink, DrinkLook>> = {
  red: { vessel: 0, rgb: [0.34, 0.015, 0.05], alpha: 0.9, level: 128 },
  white: { vessel: 0, rgb: [0.86, 0.7, 0.32], alpha: 0.42, level: 128 },
  tea: { vessel: 1, rgb: [0.5, 0.2, 0.05], alpha: 0.85, level: 112 },
};

export const drinkLook = (drink: string): DrinkLook =>
  drink === "white" || drink === "tea" ? DRINKS[drink] : DRINKS.red;
