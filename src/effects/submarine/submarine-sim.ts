/**
 * Pure logic for the Submarine Viewport (submarine.ts): the salon's layout
 * (the viewport, the gauges, the lamp, pipes and chair), the vessel's depth as
 * a pure function of time, the water's colour and which kinds of sea life show
 * at each depth, the gauges' needles, and the schedule of whales gliding past.
 * Nothing here touches GL, so it is all unit tested.
 *
 * Layout units are reference px: y up from the bottom of a 1080-high frame.
 * "Glass units" put the viewport's centre at 0 and its glass rim at radius 1.
 */
import { approach, clamp, smoothstep } from "../math";
import { createRng } from "../noise";
import type { DepthMode } from "./submarine.meta";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Glass radius, the brass ring's width round it, and the glass centre's height. */
export const GLASS_R = 380;
export const RING_W = 62;
export const GLASS_Y = 548;
/** The viewport sits this share of the frame width away from the gauges' side. */
export const GLASS_SHIFT = 0.06;
/** Radius (glass units) of the thin inner ring; the struts run from it out to the rim. */
export const INNER_RING = 0.68;
/** Struts round the outer band of the glass. */
export const STRUTS = 8;
/** Half width of a strut and of the inner ring, reference px. */
export const STRUT_HALF = 9;
export const INNER_HALF = 6;
/** Height of the depth dial's centre; the pressure gauge sits below it, then the lamp's shelf. */
export const DEPTH_DIAL_Y = 740;
export const DIAL_GAP = 64;
export const SHELF_Y = 196;
/** Lamp: shade centre height above the shelf, shade half width and height. */
export const LAMP_SHADE_Y = 112;
export const LAMP_SHADE_HALF = 38;
export const LAMP_SHADE_H = 46;
/** The pipe along the top of the wall: its centre height and radius. */
export const TOP_PIPE_Y = 1046;
export const PIPE_R = 13;
/** Top of the leather chair back in the far bottom corner, and its corner radius. */
export const CHAIR_TOP = 214;
export const CHAIR_ROUND = 90;

export interface SubLayout {
  /** Frame width, reference px. */
  readonly width: number;
  /** -1 with the gauges on the left, +1 on the right. */
  readonly dir: number;
  /** Glass centre. */
  readonly cx: number;
  readonly cy: number;
  /** Distance from the gauges' frame edge to the ring's outer edge. */
  readonly band: number;
  /** Depth dial and pressure gauge: centre x, y and face radius. */
  readonly depthX: number;
  readonly depthY: number;
  readonly depthR: number;
  readonly pressX: number;
  readonly pressY: number;
  readonly pressR: number;
  /** The lamp's x (on the shelf) and its shade's centre height. */
  readonly lampX: number;
  readonly lampY: number;
  /** The shelf's inner end (its outer end is the frame edge). */
  readonly shelfEnd: number;
  /** The two upright pipes on the gauges' side. */
  readonly pipeA: number;
  readonly pipeB: number;
  /** Where the chair back starts, counting in from the far edge (reference px). */
  readonly chairW: number;
}

/** x of a point `e` in from the frame edge on the side `dir` points to. */
const fromEdge = (width: number, dir: number, e: number): number => (dir < 0 ? e : width - e);

/**
 * The salon for a frame `refWidth` reference px wide with the gauges on
 * `side`: the viewport a little off centre away from the gauges (so the
 * speaker sits against the water, not the brass), the two dials stacked in
 * the band of wall beside it, the lamp on a shelf below them and the pipes at
 * the edge, and a chair's back in the far bottom corner.
 */
export function submarineLayout(refWidth: number, side: string): SubLayout {
  const width = Number.isFinite(refWidth) ? Math.max(1, refWidth) : 1920;
  const dir = side === "right" ? 1 : -1;
  const shift = Math.min(GLASS_SHIFT * width, 0.4 * GLASS_R);
  const cx = width / 2 - dir * shift;
  // The band between the gauges' edge and the ring, the same on either side.
  const span = Math.max(1, width / 2 + shift - GLASS_R - RING_W);
  const depthR = clamp(0.3 * span, 36, 104);
  const pressR = 0.72 * depthR;
  const col = 0.54 * span;
  const depthY = DEPTH_DIAL_Y;
  const pressY = depthY - depthR - DIAL_GAP - pressR;
  return {
    width,
    dir,
    cx,
    cy: GLASS_Y,
    band: span,
    depthX: fromEdge(width, dir, col),
    depthY,
    depthR,
    pressX: fromEdge(width, dir, col),
    pressY,
    pressR,
    lampX: fromEdge(width, dir, Math.min(0.66 * span, span - 64)),
    lampY: SHELF_Y + LAMP_SHADE_Y,
    shelfEnd: fromEdge(width, dir, Math.max(span - 16, 0.5 * span)),
    pipeA: fromEdge(width, dir, 0.1 * span),
    pipeB: fromEdge(width, dir, 0.18 * span),
    chairW: clamp(0.2 * width, 220, 420),
  };
}

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

/** Depth (0 at the surface's shallows, 1 the abyss) held by each fixed setting. */
export const FIXED_DEPTH: Readonly<Record<Exclude<DepthMode, "descend">, number>> = {
  shallows: 0.1,
  twilight: 0.5,
  abyss: 0.95,
};

/** The descend cycle: seconds in the shallows, sinking, in the abyss and surfacing. */
export const HOLD_TOP = 90;
export const SINK_TIME = 720;
export const HOLD_BOTTOM = 150;
export const RISE_TIME = 240;
export const DESCEND_PERIOD = HOLD_TOP + SINK_TIME + HOLD_BOTTOM + RISE_TIME;
/** Shallowest and deepest points of the cycle. */
export const CYCLE_TOP = 0.04;
export const CYCLE_BOTTOM = 1;

/**
 * The vessel's depth (0..1) at `time` seconds for a `depth` setting: a fixed
 * level, or for "descend" a cycle that idles in the shallows, sinks to the
 * abyss over twelve minutes, lingers there and surfaces slowly, then repeats.
 * Continuous and periodic in time.
 */
export function depthAt(mode: string, time: number): number {
  if (mode === "shallows" || mode === "twilight" || mode === "abyss") {
    return FIXED_DEPTH[mode];
  }
  const t = Number.isFinite(time) ? time : 0;
  const u = t - Math.floor(t / DESCEND_PERIOD) * DESCEND_PERIOD;
  const span = CYCLE_BOTTOM - CYCLE_TOP;
  if (u < HOLD_TOP) {
    return CYCLE_TOP;
  }
  if (u < HOLD_TOP + SINK_TIME) {
    return CYCLE_TOP + span * smoothstep(HOLD_TOP, HOLD_TOP + SINK_TIME, u);
  }
  const rise = HOLD_TOP + SINK_TIME + HOLD_BOTTOM;
  if (u < rise) {
    return CYCLE_BOTTOM;
  }
  return CYCLE_BOTTOM - span * smoothstep(rise, DESCEND_PERIOD, u);
}

/** Seconds a change of the depth setting takes to sweep the whole range, so it never cuts. */
export const DEPTH_EASE = 15;

/** Eases the shown depth toward the setting's, at most 1 / DEPTH_EASE per second. */
export function easeDepth(current: number, target: number, dt: number): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt / DEPTH_EASE : 0;
  return approach(current, target, step);
}

/** Fastest the cycle sinks, depth per second (the smoothstep's peak slope). */
export const PEAK_SINK = (1.5 * (CYCLE_BOTTOM - CYCLE_TOP)) / SINK_TIME;

// ---------------------------------------------------------------------------
// Water and life by depth
// ---------------------------------------------------------------------------

export interface Zones {
  /** Sunlit shallows: shafts, caustics, the sea floor and fish shoals. */
  shallows: number;
  /** Jellyfish: from the twilight zone down. */
  jellies: number;
  /** The abyss: bioluminescence and the vessel's own lamp. */
  abyss: number;
}

export function createZones(): Zones {
  return { shallows: 1, jellies: 0, abyss: 0 };
}

/** How much each depth band's look and life shows at depth `d`. */
export function zonesAt(d: number, out: Zones): Zones {
  out.shallows = 1 - smoothstep(0.14, 0.42, d);
  out.jellies = smoothstep(0.25, 0.5, d);
  out.abyss = smoothstep(0.62, 0.92, d);
  return out;
}

/** Water colour (linear-ish display RGB) near the surface and deep below, at three depths. */
export const WATER_TOP: readonly (readonly [number, number, number])[] = [
  [0.16, 0.5, 0.52],
  [0.03, 0.12, 0.27],
  [0.006, 0.014, 0.03],
];
export const WATER_DEEP: readonly (readonly [number, number, number])[] = [
  [0.035, 0.22, 0.3],
  [0.01, 0.045, 0.12],
  [0.002, 0.005, 0.012],
];

/** The water's top and bottom colours at depth `d`, eased between the three stops. */
export function waterAt(d: number, top: number[], deep: number[]): void {
  const x = clamp(Number.isFinite(d) ? d : 0, 0, 1) * 2;
  const i = Math.min(1, Math.floor(x));
  const k = smoothstep(0, 1, x - i);
  for (let c = 0; c < 3; c++) {
    top[c] = WATER_TOP[i][c] + (WATER_TOP[i + 1][c] - WATER_TOP[i][c]) * k;
    deep[c] = WATER_DEEP[i][c] + (WATER_DEEP[i + 1][c] - WATER_DEEP[i][c]) * k;
  }
}

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

/** Needle angle (radians, counter-clockwise from +x) at the bottom of a dial's scale, and the scale's sweep. */
export const DIAL_START = (5 * Math.PI) / 4;
export const DIAL_SWEEP = (3 * Math.PI) / 2;

/** The needle angle for a reading of 0..1 (clamped) on a dial's scale. */
export function needleAngle(reading: number): number {
  return DIAL_START - DIAL_SWEEP * clamp(Number.isFinite(reading) ? reading : 0, 0, 1);
}

/** How far the wander moves the pressure and depth needles, as shares of their scales. */
export const PRESSURE_WANDER = 0.08;
export const DEPTH_WANDER = 0.012;

/** The pressure gauge's reading (0..1): rising with depth, plus its wander. */
export function pressureReading(d: number, wander: number): number {
  return clamp(0.12 + 0.72 * d + PRESSURE_WANDER * wander, 0, 1);
}

/** The depth dial's reading (0..1): the depth itself, trembling very slightly. */
export function depthReading(d: number, wander: number): number {
  return clamp(d + DEPTH_WANDER * wander, 0, 1);
}

// ---------------------------------------------------------------------------
// Whales
// ---------------------------------------------------------------------------

/** Seconds a whale takes to cross, and the least quiet time between two passes. */
export const WHALE_MIN_TIME = 20;
export const WHALE_MAX_TIME = 40;
export const WHALE_MIN_GAP = 75;
export const WHALE_GAP_SPREAD = 150;
/** The first whale comes within this window (s) after the scene starts. */
export const WHALE_FIRST_MIN = 20;
export const WHALE_FIRST_SPREAD = 50;
/** Whale length (glass units) at size 1, and the seconds of one stroke of its tail. */
export const WHALE_LEN = 1.9;
export const WHALE_STROKE = 7;

export interface WhalePass {
  /** Start time (s) and seconds to cross. */
  start: number;
  duration: number;
  /** +1 swimming right, -1 left. */
  dir: number;
  /** Height of its path (glass units), size, and how far the water fogs it (0..1). */
  y: number;
  size: number;
  fog: number;
}

export interface WhaleSchedule {
  readonly rng: () => number;
  /** The current or next pass. */
  readonly pass: WhalePass;
  /** Passes made so far, counting the first. */
  count: number;
}

function planPass(rng: () => number, p: WhalePass, start: number): void {
  p.start = start;
  p.duration = WHALE_MIN_TIME + (WHALE_MAX_TIME - WHALE_MIN_TIME) * rng();
  p.dir = rng() < 0.5 ? -1 : 1;
  p.y = -0.45 + 0.75 * rng();
  p.size = 0.85 + 0.35 * rng();
  p.fog = 0.25 + 0.35 * rng();
}

export function createWhales(seed: number): WhaleSchedule {
  const rng = createRng(Math.floor(Number.isFinite(seed) ? seed : 0) * 7919 + 211);
  const pass: WhalePass = { start: 0, duration: 0, dir: 1, y: 0, size: 1, fog: 0 };
  planPass(rng, pass, WHALE_FIRST_MIN + WHALE_FIRST_SPREAD * rng());
  return { rng, pass, count: 1 };
}

/**
 * Brings the schedule up to `time` seconds: once a pass has finished, plans
 * the next to start at least WHALE_MIN_GAP later. Returns the current or next
 * pass. Allocates nothing.
 */
export function stepWhales(s: WhaleSchedule, time: number): WhalePass {
  const p = s.pass;
  while (Number.isFinite(time) && time >= p.start + p.duration) {
    planPass(s.rng, p, p.start + p.duration + WHALE_MIN_GAP + WHALE_GAP_SPREAD * s.rng());
    s.count++;
  }
  return p;
}

/** How far through pass `p` the time is, 0..1, or -1 outside it. */
export function whaleProgress(p: WhalePass, time: number): number {
  const u = (time - p.start) / p.duration;
  return u >= 0 && u <= 1 ? u : -1;
}

/**
 * The whale's centre x (glass units) at progress `u`: from fully off the
 * glass on one side to fully off on the other, so it never pops in or out.
 */
export function whaleX(p: WhalePass, u: number): number {
  const reach = 1.1 + 0.5 * WHALE_LEN * p.size;
  return p.dir * reach * (2 * clamp(u, 0, 1) - 1);
}

/** The tail stroke's phase (radians) at `time`, kept small for the GPU. */
export function strokePhase(time: number): number {
  const x = time / WHALE_STROKE;
  return (x - Math.floor(x)) * TAU;
}
