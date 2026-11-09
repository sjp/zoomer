/**
 * Pure JS side of the Hourglass effect (hourglass.ts): the glass's profile and
 * its sand volumes, the run / settle / turn clock, the falling stream, and the
 * hourglass's layout in its corner.
 *
 * Screen units are "height units": x runs 0..aspect across the canvas and y
 * 0..1 from the bottom up, as in globe-sim.ts. The hourglass itself lives in
 * "glass units": centred on the neck, y along its axis, with the glass ends at
 * y = ±1. Each bulb is a body of revolution whose radius is `bulbRadius(h)` at
 * a distance h (0..1) from the neck.
 *
 * Every run starts with the full bulb at +y, on top. During the turn the
 * hourglass rotates by 180° so the full bulb (then at -y) ends on top; the
 * shape is point-symmetric, so the next run restarts in the same frame
 * without a visible jump.
 */
import type { HourglassFrame } from "./hourglass.meta";
import { DURATION_RANGE, SIZE_RANGE } from "./hourglass.meta";
import { lookup as lookupOr } from "../lookup";
import { clamp } from "../math";

/** Neck radius, bulb radius and the profile's arch frequency (glass units). */
export const NECK_R = 0.034;
export const BULB_R = 0.43;
export const BULB_K = 0.74 * Math.PI;
/** Sand clears the glass wall by this much (glass units). */
export const WALL = 0.016;

/** Turned end caps: from the glass end to this height, and their half-width. */
export const CAP_END = 1.16;
export const CAP_W = 0.62;
/** Posts' centres: two in front at ±POST_X, one behind at 0 (glass units). */
export const POST_X = 0.537;

/** Top sand level (from the neck) at the start of a run. */
export const FILL_H = 0.74;
/** The pile's slope (rise per unit radius) and the rounding of its top. */
export const PILE_SLOPE = 0.62;
export const PILE_ROUND = 0.07;
/** The funnel dip over the neck: depth and width (glass units). */
export const DIP_DEPTH = 0.07;
export const DIP_W = 0.12;

/** Glass unit at size 1 (height units). */
const HG_UNIT = 0.125;
/** Where the hourglass stands (height units), and the table's back edge. */
export const SEAT_Y = 0.07;
export const TABLE_BACK_Y = 0.16;
/** Gap from the frame edge to the turning hourglass (height units). */
const EDGE_MARGIN = 0.025;
/** Extra lift at the middle of the turn, for clearance (glass units). */
export const TURN_CLEAR = 0.06;
/** Shadow on the table: half-width and half-height (glass units). */
export const SHADOW_RX = 0.95;
export const SHADOW_RY = 0.13;
/** Slack around the box for the antialiased edges (height units). */
const BOX_PAD = 0.004;

/** Seconds the last sand takes to land, then to rest, before the turn; the turn's length. */
export const SETTLE_TIME = 1.2;
export const TURN_TIME = 1.5;
/** Fall acceleration in glass units/s^2: the stream's head reaches the bottom in about 0.35 s. */
const FALL_G = 16;

/** Samples in the volume tables. */
export const TABLE_N = 65;
/** Integration slices along a bulb. */
const SLICES = 256;

/** The bulb's radius at `h` (0 at the neck, 1 at the glass end). */
export function bulbRadius(h: number): number {
  const s = BULB_R * Math.sin(BULB_K * clamp(h, 0, 1));
  return Math.hypot(NECK_R, s);
}

/** The sand's radius inside the glass at `h`. */
export function sandRadius(h: number): number {
  return Math.max(bulbRadius(h) - WALL, 0);
}

/** Volume of a bulb from the neck up to level `h` (sand resting on the neck). */
export function topVolume(h: number): number {
  const top = clamp(h, 0, 1);
  if (top <= 0) {
    return 0;
  }
  const n = Math.max(8, Math.ceil(SLICES * top));
  const dh = top / n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const r = sandRadius((i + 0.5) * dh);
    v += r * r;
  }
  return Math.PI * v * dh;
}

/**
 * The pile's surface height above the glass end at radius `rho`, for a pile
 * whose rounded apex is at `apex`. Can be negative (no sand there).
 */
export function pileSurface(apex: number, rho: number): number {
  return apex - PILE_SLOPE * (Math.hypot(rho, PILE_ROUND) - PILE_ROUND);
}

/** Radius of the pile's surface `depth` below its apex. */
export function pileRadiusAt(depth: number): number {
  if (depth <= 0) {
    return 0;
  }
  const t = depth / PILE_SLOPE + PILE_ROUND;
  return Math.sqrt(t * t - PILE_ROUND * PILE_ROUND);
}

/** Volume of a pile with its apex `apex` above the glass end, clipped by the glass. */
export function pileVolume(apex: number): number {
  const top = clamp(apex, 0, 1);
  if (top <= 0) {
    return 0;
  }
  const n = Math.max(8, Math.ceil(SLICES * top));
  const dc = top / n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const c = (i + 0.5) * dc;
    const r = Math.min(sandRadius(1 - c), pileRadiusAt(top - c));
    v += r * r;
  }
  return Math.PI * v * dc;
}

/** Area of the part of a disc of radius `r` with x < d. */
export function discArea(r: number, d: number): number {
  if (r <= 0) {
    return 0;
  }
  if (d >= r) {
    return Math.PI * r * r;
  }
  if (d <= -r) {
    return 0;
  }
  return r * r * Math.acos(-d / r) + d * Math.sqrt(r * r - d * d);
}

/**
 * Volume of the -y bulb's sand space below the plane `up · p = level`, where
 * `up` is the unit "up" direction in glass units (in the x, y plane).
 */
export function planeVolume(upX: number, upY: number, level: number): number {
  const dy = 1 / SLICES;
  let v = 0;
  for (let i = 0; i < SLICES; i++) {
    const y = -(i + 0.5) * dy;
    const r = sandRadius(-y);
    // Below the plane on this slice: upX * x < level - upY * y.
    const c = level - upY * y;
    if (Math.abs(upX) < 1e-6) {
      // A level plane: the share of the slice below it, so the volume stays continuous.
      const share =
        Math.abs(upY) < 1e-6 ? (c > 0 ? 1 : 0) : clamp(0.5 + c / (Math.abs(upY) * dy), 0, 1);
      v += Math.PI * r * r * share;
    } else {
      v += upX > 0 ? discArea(r, c / upX) : discArea(r, -c / upX);
    }
  }
  return v * dy;
}

interface SandTables {
  /** All the sand. */
  total: number;
  /**
   * Top level (from the neck) at volumes total * u^3, u = i / (TABLE_N - 1):
   * near empty, the levels grow like the cube root of the volume.
   */
  top: Float64Array;
  /** Pile apex (above the glass end) at the same volumes. */
  pile: Float64Array;
  /** The -y bulb's level, holding all the sand, at turn angles PI * i / (TABLE_N - 1). */
  turn: Float64Array;
}

/** Inverts a monotonic `volume(level)` on [lo, hi] by bisection. */
function invert(volume: (level: number) => number, target: number, lo: number, hi: number) {
  let a = lo;
  let b = hi;
  for (let k = 0; k < 40; k++) {
    const m = 0.5 * (a + b);
    if (volume(m) < target) {
      a = m;
    } else {
      b = m;
    }
  }
  return 0.5 * (a + b);
}

/** Builds the level tables: the top surface and pile apex by volume, and the turn's level by angle. */
export function createSandTables(): SandTables {
  const total = topVolume(FILL_H);
  const top = new Float64Array(TABLE_N);
  const pile = new Float64Array(TABLE_N);
  const turn = new Float64Array(TABLE_N);
  for (let i = 0; i < TABLE_N; i++) {
    const v = total * (i / (TABLE_N - 1)) ** 3;
    top[i] = i === 0 ? 0 : i === TABLE_N - 1 ? FILL_H : invert(topVolume, v, 0, 1);
    pile[i] = i === 0 ? 0 : invert(pileVolume, v, 0, 1);
    const a = (Math.PI * i) / (TABLE_N - 1);
    const ux = Math.sin(a);
    const uy = Math.cos(a);
    turn[i] = invert((l) => planeVolume(ux, uy, l), total, -1.5, 1.5);
  }
  return { total, top, pile, turn };
}

/** Linear lookup in a table sampled at u = 0..1. */
function lookup(table: Float64Array, u: number): number {
  const x = clamp(Number.isFinite(u) ? u : 0, 0, 1) * (table.length - 1);
  const i = Math.min(Math.floor(x), table.length - 2);
  const f = x - i;
  return table[i] + (table[i + 1] - table[i]) * f;
}

/** Top surface level (from the neck) holding `volume`. */
export function topLevel(t: SandTables, volume: number): number {
  return lookup(t.top, Math.cbrt(volume / t.total));
}

/** Pile apex height (above the glass end) holding `volume`. */
export function pileLevel(t: SandTables, volume: number): number {
  return lookup(t.pile, Math.cbrt(volume / t.total));
}

/** The full bulb's level along "up" at turn angle `angle` (0..PI). */
export function turnLevel(t: SandTables, angle: number): number {
  return lookup(t.turn, angle / Math.PI);
}

type Phase = "run" | "settle" | "turn";

interface HourglassClock {
  phase: Phase;
  /** Seconds into the current phase. */
  time: number;
  /** Share of the sand still in the top bulb (1 at a run's start). */
  top: number;
  /** Turns completed, to alternate the turning direction. */
  turns: number;
}

/** A clock part-way through a run, with `top` of the sand still to fall. */
export function createClock(top = 0.62): HourglassClock {
  // As if the run had started long enough ago for the stream to have landed.
  return { phase: "run", time: 10, top: clamp(top, 0, 1), turns: 0 };
}

/** Seconds per run for a `duration` param value. */
export function runSeconds(duration: number): number {
  const d = Number.isFinite(duration) ? duration : 120;
  return clamp(d, DURATION_RANGE[0], DURATION_RANGE[1]);
}

/** Advances the clock by `dt` seconds of a `duration`-second run. */
export function stepClock(c: HourglassClock, dt: number, duration: number): void {
  let left = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const run = runSeconds(duration);
  // Each pass ends a phase or uses up the time; the cap only guards against huge steps.
  for (let k = 0; k < 64 && left > 0; k++) {
    if (c.phase === "run") {
      const need = c.top * run;
      if (left < need) {
        c.top -= left / run;
        c.time += left;
        left = 0;
      } else {
        left -= need;
        c.top = 0;
        c.phase = "settle";
        c.time = 0;
      }
    } else {
      const length = c.phase === "settle" ? SETTLE_TIME : TURN_TIME;
      const need = length - c.time;
      if (left < need) {
        c.time += left;
        left = 0;
      } else {
        left -= need;
        c.time = 0;
        if (c.phase === "settle") {
          c.phase = "turn";
        } else {
          c.phase = "run";
          c.top = 1;
          c.turns++;
        }
      }
    }
  }
}

/** Smoothstep: the turn's ease, with zero speed at both ends. */
export function turnEase(u: number): number {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
}

/** How far the hourglass has turned (0..PI). */
export function turnAngle(c: HourglassClock): number {
  return c.phase === "turn" ? Math.PI * turnEase(c.time / TURN_TIME) : 0;
}

/** Turning direction for the current turn: alternates, so it doesn't always spin one way. */
export function turnDirection(c: HourglassClock): 1 | -1 {
  return c.turns % 2 === 0 ? 1 : -1;
}

/** Blend from the pile's shape to a level surface during the turn (0..1). */
export function turnBlend(c: HourglassClock): number {
  if (c.phase !== "turn") {
    return 0;
  }
  const u = clamp(c.time / (0.4 * TURN_TIME), 0, 1);
  return u * u * (3 - 2 * u);
}

/** Sand volumes in the top (+y) and bottom (-y) bulbs. */
export function topSand(c: HourglassClock, t: SandTables): number {
  return c.phase === "run" ? c.top * t.total : 0;
}

export function bottomSand(c: HourglassClock, t: SandTables): number {
  return t.total - topSand(c, t);
}

/**
 * The falling stream's span, as distances below the neck (glass units),
 * written to `out` (upper end, lower end). Empty (equal ends) when no sand is
 * falling. `apex` is the pile's apex height above the glass end.
 */
export function streamSpan(c: HourglassClock, apex: number, out: Float64Array | number[]): void {
  const land = Math.max(1 - apex, 0);
  let upper = 0;
  let lower = 0;
  if (c.phase === "run") {
    lower = Math.min(land, 0.5 * FALL_G * c.time * c.time);
  } else if (c.phase === "settle") {
    upper = Math.min(land, 0.5 * FALL_G * c.time * c.time);
    lower = land;
  }
  out[0] = upper;
  out[1] = Math.max(upper, lower);
}

interface HourglassLayout {
  /** Outer direction: +1 in the bottom-right corner, -1 bottom-left. */
  side: 1 | -1;
  /** Glass unit (height units). */
  unit: number;
  /** Centre at rest (height units). */
  cx: number;
  cy: number;
  /** Pass bounds over the whole turn: x0, y0, x1, y1 (height units). */
  box: [number, number, number, number];
}

export const createLayout = (): HourglassLayout => ({
  side: 1,
  unit: HG_UNIT,
  cx: 0,
  cy: 0,
  box: [0, 0, 0, 0],
});

/** Half-diagonal of the frame's outline (glass units): its reach at any angle. */
export const REACH = Math.hypot(CAP_W, CAP_END);

/** The glass unit (height units) for a `size` param value. */
export function glassUnit(size: number): number {
  const s = Number.isFinite(size) ? size : 1;
  return HG_UNIT * clamp(s, SIZE_RANGE[0], SIZE_RANGE[1]);
}

/** Lays the hourglass out in its corner of an `aspect`-wide frame. */
export function hourglassLayout(
  aspect: number,
  position: string,
  size: number,
  out: HourglassLayout,
): HourglassLayout {
  const side = position === "left" ? -1 : 1;
  const u = glassUnit(size);
  const edge = EDGE_MARGIN + REACH * u;
  const a = Math.max(Number.isFinite(aspect) ? aspect : 1, 2 * edge);
  out.side = side;
  out.unit = u;
  out.cx = side > 0 ? a - edge : edge;
  out.cy = SEAT_Y + CAP_END * u;
  const half = Math.max(REACH, SHADOW_RX) * u + BOX_PAD;
  out.box[0] = out.cx - half;
  out.box[1] = SEAT_Y - SHADOW_RY * u - BOX_PAD;
  out.box[2] = out.cx + half;
  out.box[3] = SEAT_Y + (TURN_CLEAR + 2 * REACH) * u + BOX_PAD;
  return out;
}

/** How far the hourglass is lifted (glass units) at turn angle `angle`, so it clears the table. */
export function turnLift(angle: number): number {
  const s = Math.abs(Math.sin(angle));
  const c = Math.abs(Math.cos(angle));
  return CAP_W * s + CAP_END * c - CAP_END + TURN_CLEAR * s;
}

/** The frame shader's branch for a select value; unknown values fall back to walnut. */
export const FRAMES: Readonly<Record<HourglassFrame, number>> = {
  walnut: 0,
  brass: 1,
  none: 2,
};

export function frameKind(id: string): number {
  return lookupOr(FRAMES, id, "walnut");
}
