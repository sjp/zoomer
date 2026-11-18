/**
 * Eye Wall's pure logic: the packed layout of eyes, the slowly drifting point
 * they all watch, each eye's lagging gaze, its own blink schedule, and the
 * scheduler of the rare synchronised events (a blink spreading out from the
 * middle, every eye blinking at once, every eye turning to look straight out).
 *
 * Positions are in frame heights from the middle of the frame, y down, so the
 * layout doesn't depend on the frame's shape: a wider frame shows more of the
 * same wall. Each eye sits in an elliptical socket `r` wide either side of its
 * centre and `SOCKET_ASPECT * r` tall either side; no two sockets overlap.
 *
 * Pupil offsets are normalised to the iris's travel ellipse: the unit disc maps
 * onto it, so (1, 0) is as far towards the outer corner as the iris goes.
 */
import { clamp, smoothstep } from "../math";
import { createRng, hash32 } from "../noise";

/** A socket's height over its width. */
export const SOCKET_ASPECT = 0.62;
/** The eye's opening (almond) within its socket, in socket radii: half-width, upper and lower height. */
export const ALMOND_HALF_WIDTH = 0.86;
export const ALMOND_UPPER = 0.34;
export const ALMOND_LOWER = 0.25;
/** The iris's radius, and its travel ellipse's half-width and half-height, in socket radii. */
export const IRIS_RADIUS = 0.36;
export const IRIS_TRAVEL_X = 0.42;
export const IRIS_TRAVEL_Y = 0.1;
/**
 * The almond's area per radius², for brightness budgets: its lids are
 * `(1 - x²)^0.75` and `1 - x²` curves, whose areas this rounds up.
 */
const ALMOND_AREA = (ALMOND_UPPER * 1.47 + ALMOND_LOWER * (4 / 3)) * ALMOND_HALF_WIDTH;

/** Half-width and half-height of the laid-out wall, in frame heights: wide enough for 3.6:1. */
const SPAN_X = 1.8;
const SPAN_Y = 0.56;
/** The size classes' socket radii, frame heights, largest first. */
const CLASS_R = [0.1, 0.072, 0.05, 0.034] as const;
/** Darts thrown for each class in turn, largest first; most late ones miss. */
const CLASS_DARTS = [500, 1500, 4000, 10000] as const;
/** Clear space between sockets, frame heights (in the socket-round space). */
const GAP = 0.006;
/** Eyes shrink to this share of their class size towards the far edges. */
const EDGE_SHRINK = 0.6;
/** The most eyes a layout holds. */
export const MAX_EYES = 800;
/** The share of the layout shown at a density of 0; 1 shows it all. */
const MIN_SHARE = 0.15;

/** Speaker's distance in front of the wall, frame heights: how far the eyes turn to look at them. */
const SPEAKER_DEPTH = 0.55;
/** The sine of the gaze angle that takes the pupil to the edge of its travel. */
const SIN_FULL_TRAVEL = 0.8;
/** Per-eye aiming error, in travel units, either way. */
const AIM_ERROR = 0.12;
/** Per-eye gaze lag (time constant), seconds. */
export const MIN_LAG = 0.3;
const MAX_LAG = 0.7;
/** Fastest a pupil moves, travel units per second. */
export const MAX_PUPIL_SPEED = 1.5;
/** Pupil radius over iris radius, mid-range, and how much it varies per eye. */
const PUPIL = 0.36;
const PUPIL_SPREAD = 0.08;
/** Extra pupil radius, as a share, while the eyes look straight out. */
const LOOK_DILATION = 0.25;

/** Blink timing, seconds: lid closes, holds shut, reopens. */
const BLINK_CLOSE = 0.12;
const BLINK_HOLD = 0.05;
const BLINK_OPEN = 0.2;
export const BLINK_TOTAL = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;
/** Gaps between an eye's blinks at a blink rate of 1x, seconds. */
export const BLINK_GAP_MIN = 30;
export const BLINK_GAP_MAX = 120;
/** Chance a blink comes as a pair, and the pause between the two. */
const DOUBLE_CHANCE = 0.2;
const DOUBLE_PAUSE = 0.15;
/** Seconds an eye takes to appear (fade in, then open) or go (close, then fade). */
const EYE_FADE = 1.2;

/** Synchronised events. */
export const EVENT_NONE = 0;
export const EVENT_WAVE = 1;
export const EVENT_ALL = 2;
export const EVENT_LOOK = 3;
/** Shortest gap between events at an events setting of 1, seconds; and how much longer it may be. */
export const MIN_EVENT_GAP = 20;
const EVENT_GAP_SPREAD = 25;
/** The first event comes a little sooner. */
const FIRST_EVENT = [8, 20] as const;
/** The wave blink's spread from the middle to the corners, seconds. */
const WAVE_SPREAD = 1.5;
/**
 * The all-at-once blink's starts are spread over this many seconds: still one
 * blink to the eye, but the frame darkens over a few frames, not one.
 */
const ALL_SPREAD = 0.3;
/** Look at you: ease in, hold, ease back, seconds. */
const LOOK_IN = [1, 2] as const;
const LOOK_HOLD = [3, 5] as const;
const LOOK_OUT = [2, 3] as const;

const lerp = (range: readonly [number, number], u: number) => range[0] + (range[1] - range[0]) * u;
const unit = (h: number) => h / 4294967296;
const finite = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);

/** Mixes a seed, an index and a salt into a 32-bit hash. */
function mix(seed: number, i: number, salt: number): number {
  return hash32(hash32(seed ^ salt) + Math.imul(i, 0x9e3779b1));
}

interface Layout {
  /** The variation it was laid out from. */
  seed: number;
  count: number;
  /** Socket centres and radii, frame heights from the middle, y down. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly r: Float32Array;
  /** Per-eye constants: gaze lag (s), aim error (travel units), pupil size, two 0..1 variants. */
  readonly lag: Float32Array;
  readonly errX: Float32Array;
  readonly errY: Float32Array;
  readonly pupil: Float32Array;
  /** Picks the iris colour from the palette. */
  readonly pick: Float32Array;
  /** Varies the iris's streaks and the sclera's veins. */
  readonly variant: Float32Array;
  /** Delay of this eye's blink in an all-at-once event, seconds. */
  readonly allDelay: Float32Array;
}

export function createLayout(): Layout {
  const f = () => new Float32Array(MAX_EYES);
  return {
    seed: Number.NaN,
    count: 0,
    x: f(),
    y: f(),
    r: f(),
    lag: f(),
    errX: f(),
    errY: f(),
    pupil: f(),
    pick: f(),
    variant: f(),
    allDelay: f(),
  };
}

/** Sizes shrink from the middle out, so the outer thirds hold the big eyes and the edges small ones. */
const sizeScale = (x: number, y: number) =>
  1 - (1 - EDGE_SHRINK) * smoothstep(0.45, 1.0, Math.hypot(x, y));

/**
 * Lays out the wall for `seed`: seeded darts thrown in a fixed order, a batch
 * for each size class from the largest down, each accepted if its socket fits
 * without touching an earlier one. The big eyes go in first and the smaller
 * ones fill the gaps between them. Eye `i` is always the same eye for a seed,
 * so showing the first `n` is prefix-stable.
 */
export function layOut(layout: Layout, seed: number): void {
  layout.seed = Math.floor(finite(seed, 0));
  const s = hash32(layout.seed ^ 0x2545f491);
  // A grid over the wall in socket-round space (y divided by the aspect), cells
  // wide enough that touching sockets are always in neighbouring cells.
  const cell = 2 * CLASS_R[0] + GAP;
  const spanY = SPAN_Y / SOCKET_ASPECT;
  const cols = Math.ceil((2 * SPAN_X) / cell);
  const rows = Math.ceil((2 * spanY) / cell);
  const grid: number[][] = Array.from({ length: cols * rows }, () => []);
  let n = 0;
  let k = 0;
  for (let c = 0; c < CLASS_R.length; c++) {
    const end = k + CLASS_DARTS[c];
    for (; k < end && n < MAX_EYES; k++) {
      let h = mix(s, k, 0x68e31da4);
      const x = (unit(h) * 2 - 1) * SPAN_X;
      h = hash32(h);
      const y = (unit(h) * 2 - 1) * SPAN_Y;
      h = hash32(h);
      const r = CLASS_R[c] * sizeScale(x, y) * (0.92 + 0.16 * unit(h));
      const gx = Math.min(cols - 1, Math.floor((x + SPAN_X) / cell));
      const gy = Math.min(rows - 1, Math.floor((y / SOCKET_ASPECT + spanY) / cell));
      if (!fits(layout, grid, cols, rows, gx, gy, x, y, r)) {
        continue;
      }
      place(layout, s, n, x, y, r);
      grid[gy * cols + gx].push(n);
      n++;
    }
  }
  layout.count = n;
}

/** Whether a socket at (x, y) of radius r keeps its gap from every socket in the 3 x 3 cells round (gx, gy). */
function fits(
  layout: Layout,
  grid: readonly (readonly number[])[],
  cols: number,
  rows: number,
  gx: number,
  gy: number,
  x: number,
  y: number,
  r: number,
): boolean {
  const { x: xs, y: ys, r: rs } = layout;
  for (let cy = Math.max(0, gy - 1); cy <= Math.min(rows - 1, gy + 1); cy++) {
    for (let cx = Math.max(0, gx - 1); cx <= Math.min(cols - 1, gx + 1); cx++) {
      for (const j of grid[cy * cols + cx]) {
        if (Math.hypot(x - xs[j], (y - ys[j]) / SOCKET_ASPECT) < r + rs[j] + GAP) {
          return false;
        }
      }
    }
  }
  return true;
}

/** Places eye `n` at (x, y), radius r, with its per-eye constants. */
function place(layout: Layout, s: number, n: number, x: number, y: number, r: number): void {
  layout.x[n] = x;
  layout.y[n] = y;
  layout.r[n] = r;
  let e = mix(s, n, 0x1b873593);
  layout.lag[n] = MIN_LAG + (MAX_LAG - MIN_LAG) * unit(e);
  e = hash32(e);
  layout.errX[n] = (unit(e) * 2 - 1) * AIM_ERROR;
  e = hash32(e);
  layout.errY[n] = (unit(e) * 2 - 1) * AIM_ERROR;
  e = hash32(e);
  layout.pupil[n] = PUPIL + (unit(e) - 0.5) * PUPIL_SPREAD;
  e = hash32(e);
  layout.pick[n] = unit(e);
  e = hash32(e);
  layout.variant[n] = unit(e);
  e = hash32(e);
  layout.allDelay[n] = unit(e) * ALL_SPREAD;
}

/** How many of the layout's eyes a density shows: always a prefix. */
export function densityCount(count: number, density: number): number {
  const d = clamp(finite(density, 1), 0, 1);
  return Math.round(count * (MIN_SHARE + (1 - MIN_SHARE) * d));
}

/** The eye-free oval round the speaker, frame heights from the middle, y down. */
interface Clearing {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * The clearing for an amount 0..1 and a frame `halfWidth` frame heights across
 * each side of the middle: centred a little below the middle (head and
 * shoulders), reaching the bottom of the frame at about 0.5. Empty at 0.
 */
export function clearingOval(amount: number, halfWidth: number, out: Clearing): Clearing {
  const a = clamp(finite(amount, 0), 0, 1);
  out.cx = 0;
  out.cy = 0.06;
  out.rx = a * 0.6 * halfWidth;
  out.ry = a * 0.75;
  return out;
}

/**
 * Whether socket (x, y, r) lies wholly outside the clearing. In the oval's own
 * units (the oval a unit circle) the socket fits in a circle as wide as its
 * longer semi-axis there, which must clear the unit circle.
 */
function outsideClearing(c: Clearing, x: number, y: number, r: number): boolean {
  if (!(c.rx > 0 && c.ry > 0)) {
    return true;
  }
  const reach = Math.max(r / c.rx, (SOCKET_ASPECT * r) / c.ry);
  return Math.hypot((x - c.cx) / c.rx, (y - c.cy) / c.ry) >= 1 + reach;
}

/** Whether socket (x, y, r) shows at all in a frame `halfWidth` frame heights each side. */
export function inFrame(x: number, y: number, r: number, halfWidth: number): boolean {
  return Math.abs(x) - r < halfWidth && Math.abs(y) - SOCKET_ASPECT * r < 0.5;
}

/**
 * The point every eye watches, frame heights from the middle, y down: a slow
 * seeded drift (periods of half a minute and more) inside the middle third of
 * a frame `halfWidth` frame heights each side, a little above the middle where
 * the speaker's face usually is.
 */
export function gazeTarget(
  seed: number,
  t: number,
  halfWidth: number,
  out: { x: number; y: number },
) {
  let h = hash32(Math.floor(finite(seed, 0)) ^ 0x7f4a7c15);
  const p1 = unit(h) * 2 * Math.PI;
  h = hash32(h);
  const p2 = unit(h) * 2 * Math.PI;
  h = hash32(h);
  const p3 = unit(h) * 2 * Math.PI;
  h = hash32(h);
  const p4 = unit(h) * 2 * Math.PI;
  const tau = 2 * Math.PI * finite(t, 0);
  const sx = 0.6 * Math.sin(tau / 29 + p1) + 0.4 * Math.sin(tau / 47 + p2);
  const sy = 0.6 * Math.sin(tau / 37 + p3) + 0.4 * Math.sin(tau / 61 + p4);
  out.x = (halfWidth / 3) * 0.85 * sx;
  out.y = -0.03 + 0.11 * sy;
  return out;
}

/** The lid's closure 0 (open) .. 1 (shut), `t` seconds into a blink; 0 before it starts. */
export function blinkClosure(t: number): number {
  if (!(t > 0) || t >= BLINK_TOTAL) {
    return 0;
  }
  if (t < BLINK_CLOSE) {
    return smoothstep(0, BLINK_CLOSE, t);
  }
  if (t < BLINK_CLOSE + BLINK_HOLD) {
    return 1;
  }
  return 1 - smoothstep(BLINK_CLOSE + BLINK_HOLD, BLINK_TOTAL, t);
}

interface Events {
  kind: number;
  /** Seconds into the event under way, and its length. */
  t: number;
  duration: number;
  /** Look at you: ease in and hold, seconds (the rest eases back). */
  lookIn: number;
  hold: number;
  /** Progress towards the next event, and the progress that starts it. */
  wait: number;
  due: number;
  /** Events started so far. */
  serial: number;
  rng: () => number;
}

/** How far the eyes have turned to look straight out, 0..1 (eased). */
function lookAmount(ev: Events): number {
  if (ev.kind !== EVENT_LOOK) {
    return 0;
  }
  if (ev.t < ev.lookIn) {
    return smoothstep(0, ev.lookIn, ev.t);
  }
  const back = ev.lookIn + ev.hold;
  return ev.t < back ? 1 : 1 - smoothstep(back, ev.duration, ev.t);
}

function createEvents(seed: number): Events {
  const rng = createRng(hash32(Math.floor(finite(seed, 0)) ^ 0x3c6ef372));
  return {
    kind: EVENT_NONE,
    t: 0,
    duration: 0,
    lookIn: 0,
    hold: 0,
    wait: 0,
    due: lerp(FIRST_EVENT, rng()),
    serial: 0,
    rng,
  };
}

/** Starts an event of `kind`, its timings drawn and latched now. */
export function startEvent(ev: Events, kind: number): void {
  ev.kind = kind;
  ev.t = 0;
  ev.serial++;
  if (kind === EVENT_LOOK) {
    ev.lookIn = lerp(LOOK_IN, ev.rng());
    ev.hold = lerp(LOOK_HOLD, ev.rng());
    ev.duration = ev.lookIn + ev.hold + lerp(LOOK_OUT, ev.rng());
  } else {
    ev.duration = (kind === EVENT_WAVE ? WAVE_SPREAD : ALL_SPREAD) + BLINK_TOTAL;
  }
}

/**
 * Runs the event scheduler for `dt` seconds: the event under way plays out,
 * then the next waits at a rate set by `amount` (0 never starts one; 1 leaves
 * at least `MIN_EVENT_GAP` seconds between them). One event at a time.
 */
export function advanceEvents(ev: Events, dt: number, amount: number): void {
  const step = Math.max(0, finite(dt, 0));
  if (ev.kind !== EVENT_NONE) {
    ev.t += step;
    if (ev.t >= ev.duration) {
      ev.kind = EVENT_NONE;
      ev.wait = 0;
      ev.due = MIN_EVENT_GAP + EVENT_GAP_SPREAD * ev.rng();
    }
    return;
  }
  ev.wait += step * clamp(finite(amount, 0), 0, 1);
  if (ev.wait >= ev.due) {
    const k = ev.rng();
    startEvent(ev, k < 0.35 ? EVENT_WAVE : k < 0.65 ? EVENT_ALL : EVENT_LOOK);
  }
}

/** Params the wall steps with. */
export interface WallParams {
  density: number;
  clearing: number;
  /** Blink rate 0..1; 0.5 is one blink every 30-120 s. */
  blink: number;
  events: number;
  seed: number;
  /** The frame's half-width in frame heights (aspect / 2). */
  halfWidth: number;
}

export interface Wall {
  layout: Layout;
  events: Events;
  /** Seconds since start, unwrapped. */
  time: number;
  /** Each eye's fade, 0..1: the first half fades the socket in, the second opens the eye. */
  readonly life: Float32Array;
  /** Pupil offsets, travel units. */
  readonly px: Float32Array;
  readonly py: Float32Array;
  /** Seconds into the eye's blink (negative: the pause before the second of a pair). */
  readonly blinkT: Float32Array;
  readonly blinking: Uint8Array;
  readonly pair: Uint8Array;
  /** Progress towards the next blink, and the progress (latched per blink) that starts it. */
  readonly wait: Float32Array;
  readonly due: Float32Array;
  /** Blinks so far, which seed the next one's gap. */
  readonly blinks: Uint32Array;
  /** Whether the eye has had its blink in the current event, and which event that is. */
  readonly eventBlinked: Uint8Array;
  eventSerial: number;
  /** Look-at-you amount this step. */
  look: number;
  /** The clearing this step (scratch). */
  readonly clearing: Clearing;
  readonly target: { x: number; y: number };
}

export function createWall(seed: number): Wall {
  const layout = createLayout();
  const wall: Wall = {
    layout,
    events: createEvents(seed),
    time: 0,
    life: new Float32Array(MAX_EYES),
    px: new Float32Array(MAX_EYES),
    py: new Float32Array(MAX_EYES),
    blinkT: new Float32Array(MAX_EYES),
    blinking: new Uint8Array(MAX_EYES),
    pair: new Uint8Array(MAX_EYES),
    wait: new Float32Array(MAX_EYES),
    due: new Float32Array(MAX_EYES),
    blinks: new Uint32Array(MAX_EYES),
    eventBlinked: new Uint8Array(MAX_EYES),
    eventSerial: 0,
    look: 0,
    clearing: { cx: 0, cy: 0, rx: 0, ry: 0 },
    target: { x: 0, y: 0 },
  };
  resetEyes(wall, seed);
  return wall;
}

/** The gap before an eye's next blink, at 1x, from its blink count: latched per blink. */
function blinkGap(layoutSeed: number, i: number, blinks: number): number {
  const h = mix(hash32(layoutSeed ^ 0x51ed270b), i, blinks);
  return BLINK_GAP_MIN + (BLINK_GAP_MAX - BLINK_GAP_MIN) * unit(h);
}

/** Lays the wall out for `seed` and starts every eye gone, part-way to its first blink. */
function resetEyes(wall: Wall, seed: number): void {
  const { layout } = wall;
  layOut(layout, seed);
  const s = layout.seed;
  for (let i = 0; i < layout.count; i++) {
    wall.life[i] = 0;
    wall.px[i] = 0;
    wall.py[i] = 0;
    wall.blinkT[i] = 0;
    wall.blinking[i] = 0;
    wall.pair[i] = 0;
    wall.blinks[i] = 0;
    wall.eventBlinked[i] = 0;
    wall.due[i] = blinkGap(s, i, 0);
    wall.wait[i] = wall.due[i] * unit(mix(hash32(s), i, 0x2f6b4c1d));
  }
}

function startBlink(wall: Wall, i: number, pairs: boolean): void {
  const n = ++wall.blinks[i];
  wall.blinking[i] = 1;
  wall.blinkT[i] = 0;
  wall.pair[i] = pairs && unit(mix(hash32(wall.layout.seed), i, n)) < DOUBLE_CHANCE ? 1 : 0;
}

/** Eye `i`'s lid closure this step, 0..1, from its blink alone. */
export function eyeClosure(wall: Wall, i: number): number {
  return wall.blinking[i] === 1 ? blinkClosure(wall.blinkT[i]) : 0;
}

/** Eye `i`'s pupil radius over its iris radius this step. */
export function eyePupil(wall: Wall, i: number): number {
  return wall.layout.pupil[i] * (1 + LOOK_DILATION * wall.look);
}

/**
 * For an eye's fade `life`: how far its socket has faded in (0..1), and how
 * open its lid may be (0..1). An appearing eye fades in shut, then opens.
 */
export const eyeAlpha = (life: number) => clamp(life * 2, 0, 1);
export const eyeFadeOpen = (life: number) => clamp(life * 2 - 1, 0, 1);

/**
 * Whether eye `i` is wanted with these params: among the first `densityCount`,
 * in the frame, clear of the speaker's oval, and the wall not changing variation.
 */
function wanted(
  wall: Wall,
  i: number,
  shown: number,
  halfWidth: number,
  reseeding: boolean,
): boolean {
  const { layout } = wall;
  const x = layout.x[i];
  const y = layout.y[i];
  const r = layout.r[i];
  return (
    !reseeding &&
    i < shown &&
    inFrame(x, y, r, halfWidth) &&
    outsideClearing(wall.clearing, x, y, r)
  );
}

/**
 * Steps the wall by `dt` seconds. A variation change closes and fades every eye
 * out, then lays the new wall out and opens its eyes.
 */
export function stepWall(wall: Wall, dt: number, p: WallParams): void {
  const step = Math.max(0, finite(dt, 0));
  const halfWidth = Math.max(0.05, finite(p.halfWidth, 16 / 18));
  wall.time += step;
  const { layout, events } = wall;
  let reseeding = Math.floor(finite(p.seed, 0)) !== layout.seed;
  if (reseeding) {
    let any = false;
    for (let i = 0; i < layout.count && !any; i++) {
      any = wall.life[i] > 0;
    }
    if (!any) {
      resetEyes(wall, Math.floor(finite(p.seed, 0)));
      reseeding = false;
    }
  }

  advanceEvents(events, step, p.events);
  if (events.serial !== wall.eventSerial) {
    // A new event: every eye is due its blink in it.
    wall.eventSerial = events.serial;
    wall.eventBlinked.fill(0, 0, layout.count);
  }
  wall.look = lookAmount(events);
  const eventBlink = events.kind === EVENT_WAVE || events.kind === EVENT_ALL;
  // The wave reaches the frame's corners as it ends.
  const waveReach = Math.hypot(halfWidth, 0.5);

  clearingOval(p.clearing, halfWidth, wall.clearing);
  const target = gazeTarget(layout.seed, wall.time, halfWidth, wall.target);
  const shown = densityCount(layout.count, p.density);
  const fade = step / EYE_FADE;
  const rate = clamp(finite(p.blink, 0), 0, 1) * 2;
  const pupilStep = MAX_PUPIL_SPEED * step;
  const keep = 1 - wall.look;

  for (let i = 0; i < layout.count; i++) {
    const want = wanted(wall, i, shown, halfWidth, reseeding);
    const life = clamp(wall.life[i] + (want ? fade : -fade), 0, 1);
    wall.life[i] = life;
    if (life === 0 && !want) {
      continue;
    }
    const x = layout.x[i];
    const y = layout.y[i];

    // Blinks: the eye's own schedule, and its turn in a synchronised blink.
    if (wall.blinking[i] === 1) {
      const t = wall.blinkT[i] + step;
      if (t < BLINK_TOTAL) {
        wall.blinkT[i] = t;
      } else if (wall.pair[i] === 1) {
        wall.pair[i] = 0;
        wall.blinkT[i] = -DOUBLE_PAUSE;
      } else {
        wall.blinking[i] = 0;
        wall.wait[i] = 0;
        wall.due[i] = blinkGap(layout.seed, i, wall.blinks[i]);
      }
    } else {
      wall.wait[i] += step * rate;
      if (wall.wait[i] >= wall.due[i]) {
        startBlink(wall, i, true);
      }
    }
    if (eventBlink && wall.eventBlinked[i] === 0) {
      const delay =
        events.kind === EVENT_WAVE
          ? WAVE_SPREAD * Math.min(1, Math.hypot(x, y) / waveReach)
          : layout.allDelay[i];
      if (events.t >= delay) {
        wall.eventBlinked[i] = 1;
        if (wall.blinking[i] === 0) {
          startBlink(wall, i, false);
        }
      }
    }

    // Gaze: towards the target, as if it stood SPEAKER_DEPTH in front of the
    // wall, with the eye's own error; straight out while looking at you.
    const dx = target.x - x;
    const dy = target.y - y;
    const k = 1 / (SIN_FULL_TRAVEL * Math.hypot(dx, dy, SPEAKER_DEPTH));
    let gx = dx * k + layout.errX[i];
    let gy = dy * k + layout.errY[i];
    const gl = Math.hypot(gx, gy);
    if (gl > 1) {
      gx /= gl;
      gy /= gl;
    }
    gx *= keep;
    gy *= keep;
    const a = 1 - Math.exp(-step / layout.lag[i]);
    let mx = (gx - wall.px[i]) * a;
    let my = (gy - wall.py[i]) * a;
    const m = Math.hypot(mx, my);
    if (m > pupilStep) {
      mx *= pupilStep / m;
      my *= pupilStep / m;
    }
    let ox = wall.px[i] + mx;
    let oy = wall.py[i] + my;
    const ol = Math.hypot(ox, oy);
    if (ol > 1) {
      ox /= ol;
      oy /= ol;
    }
    wall.px[i] = ox;
    wall.py[i] = oy;
  }
}

/**
 * The share of a frame `halfWidth` frame heights each side covered by open
 * eyeball (sclera and iris, not lid) this step: what a blink takes away.
 */
export function openEyeShare(wall: Wall, halfWidth: number): number {
  const { layout } = wall;
  let area = 0;
  for (let i = 0; i < layout.count; i++) {
    const life = wall.life[i];
    const r = layout.r[i];
    if (life === 0 || !inFrame(layout.x[i], layout.y[i], r, halfWidth)) {
      continue;
    }
    const open = Math.min(1 - eyeClosure(wall, i), eyeFadeOpen(life));
    area += ALMOND_AREA * r * r * open;
  }
  return area / (2 * halfWidth);
}
