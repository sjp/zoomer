/**
 * Koi pond simulation, kept free of GL so it can be tested: fish steering
 * (wander, separation, edge avoidance and a soft push away from the centre
 * third), a chain spine per fish, the triangle strip each fish is drawn with, a
 * ring buffer of surface ripples, drifting lily pads and the pebble floor
 * texture. Positions are in reference px (a 1080px-tall frame, y down).
 * Everything is allocated up front; the per-frame functions allocate nothing.
 */
import { FADE_OUT, growLive, stepLife, trimLive } from "../fade";
import { clamp, smoothstep, wrap } from "../math";
import type { createNoise } from "../noise";
import { createRng, hash32 } from "../noise";

const TAU = Math.PI * 2;
const REF_HEIGHT = 1080;

// --- Fish -------------------------------------------------------------------

/** Points along each fish's spine, head first. */
export const SPINE_POINTS = 10;
/** Strip rows along the body: every spine point plus a Catmull-Rom midpoint between each pair. */
export const BODY_ROWS = 2 * (SPINE_POINTS - 1) + 1;
/** Strip rows of the tail fin, beyond the last spine point. */
const FIN_ROWS = 3;
export const ROWS = BODY_ROWS + FIN_ROWS;
/** Triangle-strip vertices per fish: a left and right vertex per row. */
export const VERTS_PER_FISH = ROWS * 2;
/** Floats per vertex: spine centre x, y; offset to the edge x, y (device px); u along, v across. */
export const VERTEX_FLOATS = 6;

/** Fraction of a fish's length taken by the spine; the tail fin makes up the rest. */
export const SPINE_FRACTION = 0.76;
/** Half-width of the body at its widest, as a fraction of the length. */
export const HALF_WIDTH = 0.12;
/** Tail fin rows: distance beyond the tail (fraction of length), half-width (of the widest), u. */
const FIN = [
  [0.07, 0.24, 1.17],
  [0.16, 0.42, 1.36],
  [0.24, 0.5, 1.5],
] as const;

/** Cruise speed in reference px/s at speed 1, for a fish of the default length. */
export const SWIM_PX = 42;
/** Fastest turn in radians per second at speed 1. */
const MAX_TURN = 0.9;
/** Edge avoidance starts this far (reference px) inside the frame. */
const EDGE_MARGIN = 150;
/** Fish heads never leave the frame by more than this (reference px). */
export const HARD_MARGIN = 40;
/** Seconds a fish takes to fade in when the count rises. */
const FADE_IN = 2;

/** Varieties, in the order the fragment shader's `variety` index expects. */
const VARIETIES = ["kohaku", "sanke", "showa", "ogon", "asagi"] as const;

/** Width profile of the body at `u` (0 at the nose, 1 at the tail), as a fraction of the widest. */
export function bodyProfile(u: number): number {
  if (u < 0.3) {
    const t = (0.3 - u) / 0.32;
    return Math.sqrt(Math.max(0, 1 - t * t));
  }
  return 1 - 0.85 * smoothstep(0.3, 1, u);
}

/** Per-frame inputs to `stepFish`; reuse one object rather than allocating per frame. */
export interface FishFrame {
  /** Frame width in reference px. */
  refWidth: number;
  count: number;
  /** Fish length in reference px. */
  size: number;
  speed: number;
}

interface FishState {
  readonly max: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly heading: Float64Array;
  readonly speed: Float64Array;
  /** 0 just under the surface .. 1 near the floor. */
  readonly depth: Float64Array;
  /** Fixed per fish: variety pick, pattern seed, size jitter, cruise jitter. */
  readonly pick: Float64Array;
  readonly seed: Float32Array;
  readonly sizeJitter: Float64Array;
  readonly cruise: Float64Array;
  readonly depthBase: Float64Array;
  readonly depthPhase: Float64Array;
  readonly tailPhase: Float64Array;
  readonly rippleCooldown: Float64Array;
  /** Spine points, `SPINE_POINTS` x, y pairs per fish. */
  readonly spine: Float64Array;
  /** Segment length the spine was last solved with, per fish. */
  readonly segment: Float64Array;
  readonly life: Float32Array;
  /** Fish simulated: the count plus any still fading out. */
  live: number;
  /** Unwrapped simulation clock (scaled by speed). */
  time: number;
}

/** Length of fish `i` at depth `depth`: deeper fish look a little smaller. */
export function fishLength(s: FishState, i: number, size: number): number {
  return size * s.sizeJitter[i] * (1 - 0.15 * s.depth[i]);
}

/** Lays fish `i`'s spine out straight behind its head. */
export function straightenSpine(s: FishState, i: number, segment: number): void {
  const o = i * SPINE_POINTS * 2;
  const cx = Math.cos(s.heading[i]);
  const cy = Math.sin(s.heading[i]);
  for (let k = 0; k < SPINE_POINTS; k++) {
    s.spine[o + k * 2] = s.x[i] - cx * segment * k;
    s.spine[o + k * 2 + 1] = s.y[i] - cy * segment * k;
  }
  s.segment[i] = segment;
}

export function createFish(max: number, refWidth: number, seed = 0xc01): FishState {
  const rng = createRng(seed);
  const f64 = () => new Float64Array(max);
  const s: FishState = {
    max,
    x: f64(),
    y: f64(),
    heading: f64(),
    speed: f64(),
    depth: f64(),
    pick: f64(),
    seed: new Float32Array(max),
    sizeJitter: f64(),
    cruise: f64(),
    depthBase: f64(),
    depthPhase: f64(),
    tailPhase: f64(),
    rippleCooldown: f64(),
    spine: new Float64Array(max * SPINE_POINTS * 2),
    segment: f64(),
    life: new Float32Array(max),
    live: 0,
    time: 0,
  };
  for (let i = 0; i < max; i++) {
    // Start in the outer thirds, where they'll spend most of their time anyway.
    const side = i % 2 === 0 ? 0 : 2 / 3;
    s.x[i] = (side + rng() / 3) * refWidth;
    s.y[i] = EDGE_MARGIN + rng() * (REF_HEIGHT - 2 * EDGE_MARGIN);
    s.heading[i] = rng() * TAU;
    s.pick[i] = (i + rng() * 0.5) / max;
    s.seed[i] = (hash32(i * 7919 + seed) % 1000) / 37;
    s.sizeJitter[i] = 0.82 + rng() * 0.36;
    s.cruise[i] = 0.75 + rng() * 0.5;
    s.speed[i] = SWIM_PX * s.cruise[i];
    // Stratified (golden-ratio steps), so even a few fish span the depths.
    s.depthBase[i] = 0.1 + 0.8 * ((i * 0.618034 + rng() * 0.15) % 1);
    s.depthPhase[i] = rng() * TAU;
    s.depth[i] = s.depthBase[i];
    s.tailPhase[i] = rng() * TAU;
    s.rippleCooldown[i] = 4 + rng() * 10;
  }
  // Deterministic pattern order: shuffle the picks so neighbours differ.
  for (let i = max - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = s.pick[i];
    s.pick[i] = s.pick[j];
    s.pick[j] = t;
  }
  for (let i = 0; i < max; i++) {
    straightenSpine(s, i, 1);
  }
  return s;
}

/** Scales every fish's x (and spine) by `k`, keeping fish in place relative to a resized width. */
export function rescaleFish(s: FishState, k: number): void {
  for (let i = 0; i < s.max; i++) {
    s.x[i] *= k;
  }
  for (let j = 0; j < s.spine.length; j += 2) {
    s.spine[j] *= k;
  }
}

/** `a` wrapped into (-π, π]. */
export function wrapAngle(a: number): number {
  return a - TAU * Math.floor((a + Math.PI) / TAU);
}

/**
 * The fish's steering vector (unnormalised) into `out`: wander towards a slowly
 * drifting heading offset, separation from the other live fish, edge avoidance
 * and a soft push away from the centre third, horizontally.
 */
function steer(
  s: FishState,
  i: number,
  n: number,
  f: FishFrame,
  wander: number,
  out: Float64Array,
): void {
  const x = s.x[i];
  const y = s.y[i];
  const h = s.heading[i] + wander;
  let sx = Math.cos(h);
  let sy = Math.sin(h);

  // Separation: a fish length apart.
  const sep = f.size * 1.2;
  for (let j = 0; j < n; j++) {
    if (j === i || s.life[j] <= 0) {
      continue;
    }
    const dx = x - s.x[j];
    const dy = y - s.y[j];
    const d2 = dx * dx + dy * dy;
    if (d2 >= sep * sep || d2 < 1e-9) {
      continue;
    }
    const d = Math.sqrt(d2);
    const w = (1 - d / sep) * 2.5;
    sx += (dx / d) * w;
    sy += (dy / d) * w;
  }

  // Edges: quadratic push inside the margin.
  const right = f.refWidth;
  const m = EDGE_MARGIN;
  if (x < m) {
    sx += 4 * ((m - x) / m) ** 2;
  } else if (x > right - m) {
    sx -= 4 * ((x - (right - m)) / m) ** 2;
  }
  if (y < m) {
    sy += 4 * ((m - y) / m) ** 2;
  } else if (y > REF_HEIGHT - m) {
    sy -= 4 * ((y - (REF_HEIGHT - m)) / m) ** 2;
  }

  // Centre third: a soft horizontal push towards the nearer side.
  const cx = right * 0.5;
  const reach = right * 0.2;
  const dx = x - cx;
  const ax = Math.abs(dx);
  if (ax < reach) {
    sx += (dx < 0 ? -1 : 1) * 0.9 * (1 - ax / reach);
  }

  out[0] = sx;
  out[1] = sy;
}

const steerOut = new Float64Array(2);

/**
 * Advances the live fish by `dt` seconds of wall clock (motion scaled by
 * `f.speed`), re-solves their spines and fades them in or out with the count.
 * Calls `onSurface(x, y)` when a fish near the surface nudges it.
 */
export function stepFish(
  s: FishState,
  dt: number,
  f: FishFrame,
  noise: ReturnType<typeof createNoise>,
  rng: () => number,
  onSurface?: (x: number, y: number) => void,
): void {
  const target = clamp(Math.floor(f.count), 0, s.max);
  const n = (s.live = growLive(s.life, s.live, target));
  const speed = Math.max(0, f.speed);
  const sdt = dt * speed;
  s.time += sdt;
  const t = s.time;
  const size = Math.max(1, f.size);
  const sizeK = size / 120;

  for (let i = 0; i < n; i++) {
    stepLife(s.life, i, target, dt / FADE_IN, dt / FADE_OUT);
    // Depth: a slow swell between the surface and the floor.
    s.depth[i] = clamp(s.depthBase[i] + 0.3 * Math.sin(t * 0.05 + s.depthPhase[i]), 0, 1);

    const wander = 1.1 * noise.noise2(t * 0.08 + i * 3.1, i * 7.7);
    steer(s, i, n, f, wander, steerOut);
    const sx = steerOut[0];
    const sy = steerOut[1];
    const desire = Math.hypot(sx, sy);
    if (desire > 1e-9) {
      const delta = wrapAngle(Math.atan2(sy, sx) - s.heading[i]);
      const maxTurn = MAX_TURN * sdt;
      s.heading[i] = wrapAngle(s.heading[i] + clamp(delta, -maxTurn, maxTurn));
    }
    // Cruise, slowing a little in tight turns, eased so speed changes are gentle.
    const cruise = SWIM_PX * sizeK * s.cruise[i] * (0.85 + 0.3 * noise.noise2(t * 0.05, i * 13.3));
    const turning = desire > 1e-9 ? Math.abs(wrapAngle(Math.atan2(sy, sx) - s.heading[i])) : 0;
    const want = cruise * (1 - 0.35 * Math.min(1, turning / Math.PI));
    s.speed[i] += (want - s.speed[i]) * Math.min(1, sdt * 0.8);
    const v = s.speed[i];
    let x = s.x[i] + Math.cos(s.heading[i]) * v * sdt;
    let y = s.y[i] + Math.sin(s.heading[i]) * v * sdt;
    x = clamp(x, -HARD_MARGIN, f.refWidth + HARD_MARGIN);
    y = clamp(y, -HARD_MARGIN, REF_HEIGHT + HARD_MARGIN);
    s.x[i] = x;
    s.y[i] = y;

    // Tail beat: faster when swimming faster.
    s.tailPhase[i] += sdt * (1.6 + 2.2 * (v / Math.max(1e-6, SWIM_PX * sizeK)));
    if (s.tailPhase[i] > TAU * 1e3) {
      s.tailPhase[i] -= TAU * 1e3;
    }

    solveSpine(s, i, (fishLength(s, i, size) * SPINE_FRACTION) / (SPINE_POINTS - 1));

    // A fish near the surface now and then nudges it.
    s.rippleCooldown[i] -= sdt;
    if (onSurface && s.depth[i] < 0.12 && s.rippleCooldown[i] <= 0 && s.life[i] > 0.5) {
      s.rippleCooldown[i] = 6 + rng() * 14;
      onSurface(x + Math.cos(s.heading[i]) * size * 0.05, y + Math.sin(s.heading[i]) * size * 0.05);
    }
  }
  s.live = trimLive(s.life, s.live, target);
}

/**
 * Follows the head with the spine as a chain: each point is pulled to exactly
 * `segment` from the one before it, along the line between them. A point on top
 * of its predecessor goes straight back along the heading, so a stationary fish
 * never produces NaN.
 */
export function solveSpine(s: FishState, i: number, segment: number): void {
  const sp = s.spine;
  const o = i * SPINE_POINTS * 2;
  sp[o] = s.x[i];
  sp[o + 1] = s.y[i];
  const bx = -Math.cos(s.heading[i]);
  const by = -Math.sin(s.heading[i]);
  for (let k = 1; k < SPINE_POINTS; k++) {
    const p = o + k * 2;
    const dx = sp[p] - sp[p - 2];
    const dy = sp[p + 1] - sp[p - 1];
    const d = Math.hypot(dx, dy);
    if (d > 1e-6) {
      sp[p] = sp[p - 2] + (dx / d) * segment;
      sp[p + 1] = sp[p - 1] + (dy / d) * segment;
    } else {
      sp[p] = sp[p - 2] + bx * segment;
      sp[p + 1] = sp[p - 1] + by * segment;
    }
  }
  s.segment[i] = segment;
}

/** Scratch for `writeFishStrip`: swept spine points, row centres and row normals. */
interface StripScratch {
  readonly points: Float64Array;
  readonly rows: Float64Array;
  readonly normals: Float64Array;
}

export function createStripScratch(): StripScratch {
  return {
    points: new Float64Array(SPINE_POINTS * 2),
    rows: new Float64Array(ROWS * 2),
    normals: new Float64Array(ROWS * 2),
  };
}

/** Half-width of strip row `r` as a fraction of the widest, and its `u`. */
function rowShape(r: number): [halfWidth: number, u: number] {
  if (r < BODY_ROWS) {
    const u = r / (BODY_ROWS - 1);
    // The nose row is kept a little wide so its triangles never collapse.
    return [Math.max(0.2, bodyProfile(u)), u];
  }
  const fin = FIN[r - BODY_ROWS];
  return [fin[1], fin[2]];
}

const ROW_HALF = new Float64Array(ROWS);
const ROW_U = new Float64Array(ROWS);
for (let r = 0; r < ROWS; r++) {
  [ROW_HALF[r], ROW_U[r]] = rowShape(r);
}

/**
 * Writes fish `i`'s triangle strip (`VERTS_PER_FISH` vertices of
 * `VERTEX_FLOATS`) into `out` from float `base`, in device px (`scale` per
 * reference px). The spine gets a sinusoidal sweep that grows towards the tail,
 * proportional to `sweep` (0..1, from the swimming speed), and the tail fin
 * swings with it. Vertices alternate left (v = -1) and right (v = +1).
 */
export function writeFishStrip(
  s: FishState,
  i: number,
  length: number,
  sweep: number,
  scale: number,
  out: Float32Array,
  base: number,
  scratch: StripScratch,
): void {
  const { points, rows, normals } = scratch;
  const sp = s.spine;
  const o = i * SPINE_POINTS * 2;
  const phase = s.tailPhase[i];
  const amp = length * 0.045 * sweep;

  // 1. Spine with the lateral sweep, perpendicular to each segment.
  for (let k = 0; k < SPINE_POINTS; k++) {
    const p = o + k * 2;
    const a = k === 0 ? p : p - 2;
    const b = k === 0 ? p + 2 : p;
    let tx = sp[a] - sp[b];
    let ty = sp[a + 1] - sp[b + 1];
    const tl = Math.hypot(tx, ty);
    if (tl > 1e-9) {
      tx /= tl;
      ty /= tl;
    } else {
      tx = Math.cos(s.heading[i]);
      ty = Math.sin(s.heading[i]);
    }
    const along = k / (SPINE_POINTS - 1);
    const off = amp * (0.15 + along * along) * Math.sin(phase - along * 2.6);
    points[k * 2] = sp[p] - ty * off;
    points[k * 2 + 1] = sp[p + 1] + tx * off;
  }

  // 2. Row centres: spine points with Catmull-Rom midpoints between them.
  for (let k = 0; k < SPINE_POINTS; k++) {
    rows[k * 4] = points[k * 2];
    rows[k * 4 + 1] = points[k * 2 + 1];
    if (k === SPINE_POINTS - 1) {
      break;
    }
    const k0 = Math.max(0, k - 1) * 2;
    const k3 = Math.min(SPINE_POINTS - 1, k + 2) * 2;
    const k1 = k * 2;
    const k2 = k1 + 2;
    for (let c = 0; c < 2; c++) {
      rows[k * 4 + 2 + c] =
        (-points[k0 + c] + 9 * points[k1 + c] + 9 * points[k2 + c] - points[k3 + c]) / 16;
    }
  }

  // 3. Tail fin rows: straight on from the last segment, swinging with the sweep.
  const last = (BODY_ROWS - 1) * 2;
  let dx = rows[last] - rows[last - 2];
  let dy = rows[last + 1] - rows[last - 1];
  const dl = Math.hypot(dx, dy);
  if (dl > 1e-9) {
    dx /= dl;
    dy /= dl;
  } else {
    dx = -Math.cos(s.heading[i]);
    dy = -Math.sin(s.heading[i]);
  }
  const swing = 0.45 * sweep * Math.sin(phase - 3.1);
  const cs = Math.cos(swing);
  const sn = Math.sin(swing);
  const fx = dx * cs - dy * sn;
  const fy = dx * sn + dy * cs;
  for (let r = 0; r < FIN_ROWS; r++) {
    const d = FIN[r][0] * length;
    rows[last + 2 + r * 2] = rows[last] + fx * d;
    rows[last + 3 + r * 2] = rows[last + 1] + fy * d;
  }

  // 4. Normals from central differences of the row centres.
  for (let r = 0; r < ROWS; r++) {
    const a = Math.max(0, r - 1) * 2;
    const b = Math.min(ROWS - 1, r + 1) * 2;
    let tx = rows[a] - rows[b];
    let ty = rows[a + 1] - rows[b + 1];
    const tl = Math.hypot(tx, ty);
    if (tl > 1e-9) {
      tx /= tl;
      ty /= tl;
    } else {
      tx = Math.cos(s.heading[i]);
      ty = Math.sin(s.heading[i]);
    }
    // Left of the swimming direction (y down).
    normals[r * 2] = ty;
    normals[r * 2 + 1] = -tx;
  }

  // 5. Vertices.
  const half = length * HALF_WIDTH * scale;
  let w = base;
  for (let r = 0; r < ROWS; r++) {
    const cx = rows[r * 2] * scale;
    const cy = rows[r * 2 + 1] * scale;
    const nx = normals[r * 2] * ROW_HALF[r] * half;
    const ny = normals[r * 2 + 1] * ROW_HALF[r] * half;
    const u = ROW_U[r];
    for (let side = -1; side <= 1; side += 2) {
      out[w] = cx;
      out[w + 1] = cy;
      out[w + 2] = nx * -side;
      out[w + 3] = ny * -side;
      out[w + 4] = u;
      out[w + 5] = side;
      w += VERTEX_FLOATS;
    }
  }
}

/** Index of the variety fish `i` wears under the `varieties` param. */
export function varietyOf(s: FishState, i: number, varieties: string): number {
  switch (varieties) {
    case "kohaku":
      return 0;
    case "showa":
      return 2;
    case "ogon":
      return 3;
    default:
      return Math.min(VARIETIES.length - 1, Math.floor(s.pick[i] * VARIETIES.length));
  }
}

/**
 * Writes the indices of the first `n` fish into `order`, deepest first, for
 * painter's order. Insertion sort: the order barely changes between frames.
 */
export function sortByDepth(s: FishState, n: number, order: Int32Array): void {
  for (let i = 0; i < n; i++) {
    order[i] = i;
  }
  for (let i = 1; i < n; i++) {
    const v = order[i];
    const d = s.depth[v];
    let j = i - 1;
    while (j >= 0 && s.depth[order[j]] < d) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = v;
  }
}

// --- Ripples ----------------------------------------------------------------

/** Most rings alive at once; the shader loops over this many. */
export const MAX_RIPPLES = 8;
/** Seconds a ring lives. */
export const RIPPLE_LIFE = 4.5;
/** Ring growth in reference px per second. */
const RIPPLE_SPEED = 55;

interface Ripples {
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Start time on the ripple clock; -Infinity for an empty slot. */
  readonly start: Float64Array;
  /** Next slot to write: the oldest event once the buffer is full. */
  next: number;
  /** Unwrapped wall clock. */
  time: number;
}

export function createRipples(max = MAX_RIPPLES): Ripples {
  return {
    x: new Float64Array(max),
    y: new Float64Array(max),
    start: new Float64Array(max).fill(Number.NEGATIVE_INFINITY),
    next: 0,
    time: 0,
  };
}

/** Starts a ring at (x, y) now, overwriting the oldest event. */
export function spawnRipple(r: Ripples, x: number, y: number): void {
  const i = r.next;
  r.x[i] = x;
  r.y[i] = y;
  r.start[i] = r.time;
  r.next = (i + 1) % r.x.length;
}

/** Age of slot `i` in seconds, or -1 when it is empty or has expired. */
export function rippleAge(r: Ripples, i: number): number {
  const age = r.time - r.start[i];
  return age >= 0 && age < RIPPLE_LIFE ? age : -1;
}

/**
 * Writes one `vec4` per slot into `out` (device px): centre x, y, radius and
 * signed amplitude, which is 0 for empty or expired slots. Ages, not times, are
 * uploaded, so the shader never sees an unbounded clock.
 */
export function writeRipples(r: Ripples, scale: number, strength: number, out: Float32Array): void {
  for (let i = 0; i < r.x.length; i++) {
    const age = rippleAge(r, i);
    const o = i * 4;
    if (age < 0 || !(strength > 0)) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      continue;
    }
    const k = age / RIPPLE_LIFE;
    const fadeIn = Math.min(1, age / 0.3);
    out[o] = r.x[i] * scale;
    out[o + 1] = r.y[i] * scale;
    out[o + 2] = (6 + age * RIPPLE_SPEED) * scale;
    out[o + 3] = strength * fadeIn * (1 - k) * (1 - k);
  }
}

// --- Lily pads --------------------------------------------------------------

/** Notch half-angle of a lily pad, in radians. */
export const NOTCH = 0.2;

/**
 * A notched disc (apothem-free: radius 1) as a closed outline, star-shaped about
 * the origin: the rim from +NOTCH round to -NOTCH, then a point near the centre.
 */
export function padOutline(points = 40): number[] {
  const out: number[] = [];
  const span = TAU - 2 * NOTCH;
  for (let k = 0; k <= points; k++) {
    const a = NOTCH + (span * k) / points;
    out.push(Math.cos(a), Math.sin(a));
  }
  out.push(0.06, 0);
  return out;
}

interface Pads {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly r: Float64Array;
  readonly angle: Float64Array;
  readonly spin: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  /** Flower: 0 for none, else its size relative to the pad. */
  readonly flower: Float64Array;
  readonly shade: Float64Array;
  readonly life: Float32Array;
  live: number;
}

/** Pads spread over the frame, mostly away from the centre third. */
export function createPads(max: number, refWidth: number, seed = 0x11d): Pads {
  const rng = createRng(seed);
  const f64 = () => new Float64Array(max);
  const p: Pads = {
    x: f64(),
    y: f64(),
    r: f64(),
    angle: f64(),
    spin: f64(),
    vx: f64(),
    vy: f64(),
    flower: f64(),
    shade: f64(),
    life: new Float32Array(max),
    live: 0,
  };
  for (let i = 0; i < max; i++) {
    // Stratified across the outer thirds, alternating sides.
    const u = (Math.floor(i / 2) + rng()) / Math.ceil(max / 2);
    const side = i % 2 === 0 ? 0 : 2 / 3;
    p.x[i] = (side + (i % 2 === 0 ? u : 1 - u) / 3) * refWidth;
    p.y[i] = rng() * REF_HEIGHT;
    p.r[i] = 34 + rng() * 40;
    p.angle[i] = rng() * TAU;
    p.spin[i] = (0.01 + rng() * 0.025) * (rng() < 0.5 ? -1 : 1);
    p.vx[i] = (rng() - 0.5) * 3;
    p.vy[i] = (rng() - 0.5) * 3;
    p.flower[i] = rng() < 0.35 ? 0.34 + rng() * 0.12 : 0;
    p.shade[i] = 0.85 + rng() * 0.3;
  }
  return p;
}

export function rescalePads(p: Pads, k: number): void {
  for (let i = 0; i < p.x.length; i++) {
    p.x[i] *= k;
  }
}

/** Drifts and turns the live pads, wrapping them round the padded frame, and fades them with the count. */
export function stepPads(p: Pads, dt: number, count: number, refWidth: number): void {
  const target = clamp(Math.floor(count), 0, p.x.length);
  const n = (p.live = growLive(p.life, p.live, target));
  for (let i = 0; i < n; i++) {
    stepLife(p.life, i, target, dt / FADE_IN, dt / FADE_OUT);
    const m = p.r[i] * 1.6;
    p.x[i] = wrap(p.x[i] + p.vx[i] * dt, -m, refWidth + 2 * m);
    p.y[i] = wrap(p.y[i] + p.vy[i] * dt, -m, REF_HEIGHT + 2 * m);
    p.angle[i] = wrap(p.angle[i] + p.spin[i] * dt, 0, TAU);
  }
  p.live = trimLive(p.life, p.live, target);
}

// --- Pebble floor -----------------------------------------------------------

/**
 * A seamlessly tiling `size` x `size` R8 texture of rounded pebbles: a jittered
 * `cells` x `cells` Voronoi grid where each pebble is a dome of its own
 * brightness and the gaps between them are dark. Row-major, one byte per texel.
 */
export function buildPebbleTexture(size: number, cells: number, seed = 0x9eb): Uint8Array {
  const rng = createRng(seed);
  const n = cells * cells;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const tone = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    px[c] = 0.15 + rng() * 0.7;
    py[c] = 0.15 + rng() * 0.7;
    tone[c] = 0.45 + rng() * 0.55;
  }
  const data = new Uint8Array(size * size);
  const k = cells / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x + 0.5) * k;
      const gy = (y + 0.5) * k;
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      let f1 = Infinity;
      let f2 = Infinity;
      let best = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const ix = cx + ox;
          const iy = cy + oy;
          const c = (((iy % cells) + cells) % cells) * cells + (((ix % cells) + cells) % cells);
          const dx = ix + px[c] - gx;
          const dy = iy + py[c] - gy;
          const d = Math.hypot(dx, dy);
          if (d < f1) {
            f2 = f1;
            f1 = d;
            best = c;
          } else if (d < f2) {
            f2 = d;
          }
        }
      }
      // Distance to the cell border is about (f2 - f1) / 2: domes, dark grout.
      const edge = smoothstep(0, 0.22, (f2 - f1) * 0.5);
      const dome = Math.sqrt(edge);
      const v = tone[best] * (0.25 + 0.75 * dome) * (0.9 + 0.1 * (1 - f1));
      data[y * size + x] = clamp(Math.round(v * 255), 0, 255);
    }
  }
  return data;
}
