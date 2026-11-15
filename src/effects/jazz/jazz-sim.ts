/**
 * 90s Jazz's pattern: where the brush swashes, squiggles, Memphis shapes, paint
 * splatter and confetti go for a seed, scale and frame shape, and how the
 * pattern lives: painting itself on and off one element at a time, drifting
 * across the frame, or wobbling in place.
 *
 * Reference px: the frame is `REF_HEIGHT` tall and as wide as its aspect makes
 * it; y points down. A ref px is a px at 1080p, which is what the codec motion
 * limits are measured in.
 */
import { approach, clamp, smoothstep, wrap } from "../math";
import { capPatternSpeed, MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { createRng, hash32 } from "../noise";
import { MIN_SCALE } from "./jazz.meta";

export const REF_HEIGHT = 1080;

/** Colour roles: paper, swash, squiggle, then three accents. */
export const C_BG = 0;
export const C_SWASH = 1;
export const C_SQUIGGLE = 2;
const C_ACCENT = 3;
export const ROLE_COUNT = 6;

/** Paper, swash, squiggle, accents, per palette. */
export const PALETTES: Record<string, readonly string[]> = {
  classic: ["#fbfaf5", "#17a2a6", "#5a2d8c", "#38bdb8", "#7e46b0", "#c4c4c8"],
  hotpink: ["#fffdf8", "#f2287f", "#ffcf1a", "#ff6eb4", "#ffbf00", "#1d1b1f"],
  neon: ["#0a0a0f", "#14e0ff", "#ff2bd2", "#a8ff2a", "#45f0ff", "#ff5ae0"],
  pastel: ["#fbf2df", "#7fd3b4", "#a98bdb", "#f5ad8e", "#c3acec", "#a4e2cc"],
  primary: ["#fdfdfb", "#1e4fd6", "#e3241b", "#ffc917", "#e3241b", "#1e4fd6"],
};

/** Shader kinds: what one instance draws. */
const K_SWASH = 0;
const K_WAVE = 1;
const K_ZIG = 2;
export const K_DOT = 3;
const K_TRI = 4;
const K_DASH = 5;
const K_HALF = 6;
const K_GRID = 7;
const K_SQUARE = 8;
const K_RING_TRI = 9;
/** A splatter cluster: not a shader kind, it draws as several dots. */
export const K_SPLAT = 10;

/** Element groups, which the toggles and the paint schedule work by. */
export const G_SWASH = 0;
const G_SQUIGGLE = 1;
export const G_SHAPE = 2;
export const G_SPLAT = 3;
export const G_CONFETTI = 4;
const GROUP_COUNT = 5;
/** Back to front. */
const DRAW_ORDER = [G_SHAPE, G_SWASH, G_SQUIGGLE, G_SPLAT, G_CONFETTI] as const;

/** Bristle streaks across a swash; the shader draws the same number. */
export const BRISTLES = 14;
/**
 * The finest repeating feature at scale 1, ref px: the bristle streaks of the
 * narrowest swash. Squiggle waves and confetti are coarser.
 */
export const FINEST_PERIOD = (2 * 46) / BRISTLES;
/** Drift speed at rate 1, ref px a second, before the pattern-speed cap. */
const DRIFT_SPEED = 18;
/** Drift direction: down and to the right, gently. */
const DRIFT_DIR_X = Math.cos(0.45);
const DRIFT_DIR_Y = Math.sin(0.45);

/** Fixed per-role offsets, ref px: the print's colour layers slightly out of register. */
export const MISREGISTER: readonly (readonly [number, number])[] = [
  [0, 0],
  [1.4, -0.8],
  [-1.2, 1.0],
  [1.0, 1.3],
  [-1.3, -0.9],
  [1.1, 0.6],
];

/** Element states. */
const SHOWN = 0;
const ENTERING = 1;
const LEAVING = 2;
const GONE = 3;

/** Paint-schedule timings at rate 1, seconds. */
const PAINT_IN = 1.6;
const UNPAINT = 1.2;
const POP_IN = 0.45;
const SHRINK = 0.4;
/** Between one element leaving and its replacement starting. */
const SPAWN_DELAY = 0.6;
/**
 * The pause after one change finishes before the next starts, at rate 1. With
 * the change itself (a few seconds for a stroke) one element swaps every 4-7 s,
 * and something is painting most of the time.
 */
const EVENT_MIN = 1.5;
/** The first change comes sooner, so the painting shows straight away. */
const FIRST_EVENT_MIN = 1.2;
const FIRST_EVENT_MAX = 2.2;
/**
 * How likely each group is to be the next to change (swash, squiggle, shape,
 * splatter, confetti). Strokes painting on and off are the show; confetti is
 * most of the elements, so an even pick would mostly swap a tiny bit.
 */
const GROUP_PICK = [0.45, 0.33, 0.1, 0.04, 0.08];
const EVENT_MAX = 3;
/** Param changes crossfade over this long, seconds. */
const CROSSFADE = 1;
/** Toggled groups fade over this long, seconds. */
const TOGGLE_FADE = 1;

/** Pop overshoot: f(s) = s + c·s·(1 − s), peaking about 5% over 1. */
const POP_OVERSHOOT = 1.6;
/** Largest slopes of the eases, per unit progress, so steps can be capped. */
const SMOOTH_SLOPE = 1.5;
const POP_SLOPE = (() => {
  let max = 0;
  const n = 400;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(popEase((i + 1) / n) - popEase(i / n)) * n;
    max = Math.max(max, d);
  }
  return max * 1.02;
})();

/** Wobble: offset and breathing amplitudes; tips turn at most this far, ref px. */
const WOBBLE_SHIFT = 4;
const WOBBLE_TIP = 6;
const WOBBLE_BREATHE = 0.03;
/** Placement margin from the clear centre, ref px, for wobble and pop overshoot. */
const CLEAR_MARGIN = 12;
/** Drift: big elements fade out over this distance before they reach the centre. */
const DRIFT_FADE = 70;
/** Confetti and squiggles with `rnd` below this may sit in the centre. */
const CENTRE_SHARE = 0.25;

/** The speaker's area: an ellipse, ref px. */
export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface Element {
  group: number;
  kind: number;
  /** Centre and angle at rest (for drift, before the offset). */
  x: number;
  y: number;
  angle: number;
  /** cos and sin of `angle`, kept for placement, which samples the centreline a lot. */
  cos: number;
  sin: number;
  /** Quad half extents, ref px, unrotated. */
  hx: number;
  hy: number;
  /** Kind parameters (see the shader). */
  p0: number;
  p1: number;
  p2: number;
  p3: number;
  role: number;
  /** Bounding radius from the centre, ref px. */
  radius: number;
  /** Stroke half length and thickness about the centreline, for clearance; 0 for compact ones. */
  half: number;
  thick: number;
  /** 0..1, fixed per element: shader seed, centre allowance, splatter layout. */
  rnd: number;
  wobblePeriod: number;
  wobblePhase: number;
  state: number;
  /** Progress through the current transition, 0..1. */
  t: number;
}

interface Scene {
  elements: Element[];
  /** Laid out on a torus round the frame for Drift, with no clear centre. */
  uniform: boolean;
  seed: number;
  k: number;
  /** The placement region (the frame, or the drift torus). */
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Paint schedule. */
  clock: number;
  nextEvent: number;
  /** The next element to paint on, placed when its predecessor started leaving. */
  pending: Element | null;
  pendingDelay: number;
  rng: () => number;
}

export interface JazzParams {
  animation: string;
  speed: number;
  scale: number;
  confetti: boolean;
  shapes: boolean;
  splatter: boolean;
  seed: number;
}

export interface Jazz {
  width: number;
  height: number;
  clear: Ellipse;
  current: Scene | null;
  previous: Scene | null;
  /** Crossfade from `previous` to `current`, 0..1. */
  fade: number;
  groupAlpha: Float32Array;
  wobble: number;
  wobbleClock: number;
  driftX: number;
  driftY: number;
  /** Set by a resize: the next step rebuilds without a crossfade. */
  dirty: boolean;
  started: boolean;
}

/** Where one element is drawn this frame. */
export interface Pose {
  x: number;
  y: number;
  angle: number;
  pop: number;
  /**
   * How much of a stroke shows: below 1, painted from the start up to that share
   * of its length; 1, all of it; above 1, un-painted from the start up to
   * `reveal - 1` of its length.
   */
  reveal: number;
  alpha: number;
}

export const createPose = (): Pose => ({ x: 0, y: 0, angle: 0, pop: 1, reveal: 1, alpha: 1 });

function popEase(t: number): number {
  const s = smoothstep(0, 1, t);
  return s + POP_OVERSHOOT * s * (1 - s);
}

/** The schedule's rate for a speed: 1 at the default 0.5, 0 at 0. */
function rateFor(speed: number): number {
  return speed > 0 ? 0.25 + 1.5 * Math.min(1, speed) : 0;
}

/** Drift speed, ref px a second, capped so the finest feature stays under the pattern limit. */
export function driftSpeed(speed: number, k: number): number {
  return capPatternSpeed(DRIFT_SPEED * rateFor(speed), FINEST_PERIOD * k);
}

/** The clear centre for a `w` x `h` ref px frame: wide in landscape, higher and narrower in portrait. */
export function clearEllipse(w: number, h: number, out: Ellipse): Ellipse {
  out.cx = w / 2;
  if (w >= h) {
    out.cy = 0.54 * h;
    out.rx = 0.21 * w;
    out.ry = 0.4 * h;
  } else {
    out.cy = 0.46 * h;
    out.rx = 0.4 * w;
    out.ry = 0.26 * h;
  }
  return out;
}

/** The ellipse's normalised radius at a point: 1 on its edge. */
function ellipseNorm(c: Ellipse, x: number, y: number): number {
  return Math.hypot((x - c.cx) / c.rx, (y - c.cy) / c.ry);
}

/**
 * A lower bound on the distance from a point to the ellipse (negative inside):
 * scaling to the unit circle shrinks distances by at most 1 / min(rx, ry).
 */
function ellipseGap(c: Ellipse, x: number, y: number): number {
  return (ellipseNorm(c, x, y) - 1) * Math.min(c.rx, c.ry);
}

/** Samples along a stroke's centreline. */
const PATH_SAMPLES = 9;

/** A point on an element's centreline at s in -1..1 (its centre for compact ones), with offset. */
function pathPoint(el: Element, s: number, ox: number, oy: number, out: { x: number; y: number }) {
  const lx = s * el.half;
  const ly = el.half > 0 ? el.p0 * (1 - s * s) : 0;
  const c = el.cos;
  const n = el.sin;
  out.x = el.x + ox + lx * c - ly * n;
  out.y = el.y + oy + lx * n + ly * c;
  return out;
}

const scratch = { x: 0, y: 0 };
const scratchB = { x: 0, y: 0 };

/** How far the element (at an offset) keeps from the clear centre, ref px; negative when it enters. */
function clearance(el: Element, c: Ellipse, ox = 0, oy = 0): number {
  if (el.half <= 0) {
    return ellipseGap(c, el.x + ox, el.y + oy) - el.radius;
  }
  let min = Infinity;
  for (let i = 0; i < PATH_SAMPLES; i++) {
    const p = pathPoint(el, -1 + (2 * i) / (PATH_SAMPLES - 1), ox, oy, scratch);
    min = Math.min(min, ellipseGap(c, p.x, p.y) - el.thick);
  }
  return min;
}

/** Distance from a point to the element's centreline (or centre), less its thickness. */
function gapTo(el: Element, x: number, y: number): number {
  if (el.half <= 0) {
    return Math.hypot(x - el.x, y - el.y) - el.radius;
  }
  let min = Infinity;
  for (let i = 0; i < PATH_SAMPLES; i++) {
    const p = pathPoint(el, -1 + (2 * i) / (PATH_SAMPLES - 1), 0, 0, scratch);
    min = Math.min(min, Math.hypot(x - p.x, y - p.y));
  }
  return min - el.thick;
}

/** Gap between two elements' bodies, approximately. */
function gapBetween(a: Element, b: Element): number {
  if (a.half <= 0) {
    return gapTo(b, a.x, a.y) - a.radius;
  }
  let min = Infinity;
  const p = scratchB;
  for (let i = 0; i < PATH_SAMPLES; i++) {
    pathPoint(a, -1 + (2 * i) / (PATH_SAMPLES - 1), 0, 0, p);
    min = Math.min(min, gapTo(b, p.x, p.y) - a.thick);
  }
  return min;
}

/** Whether a big element (swash, shape, splatter) must stay out of the centre. */
function isBig(el: Element): boolean {
  return el.group === G_SWASH || el.group === G_SHAPE || el.group === G_SPLAT;
}

/** Whether an element may sit in the centre at all. */
function centreAllowed(el: Element): boolean {
  return !isBig(el) && el.rnd < CENTRE_SHARE;
}

const range = (rng: () => number, lo: number, hi: number) => lo + (hi - lo) * rng();

function blank(group: number, kind: number, rng: () => number): Element {
  return {
    group,
    kind,
    x: 0,
    y: 0,
    angle: rng() * Math.PI * 2,
    cos: 1,
    sin: 0,
    hx: 0,
    hy: 0,
    p0: 0,
    p1: 0,
    p2: 0,
    p3: 0,
    role: C_SWASH,
    radius: 0,
    half: 0,
    thick: 0,
    rnd: rng(),
    wobblePeriod: range(rng, 4, 10),
    wobblePhase: rng() * Math.PI * 2,
    state: SHOWN,
    t: 1,
  };
}

/** A swash `f` times its scale-1 size. */
function makeSwash(rng: () => number, f: number): Element {
  const el = blank(G_SWASH, K_SWASH, rng);
  const len = range(rng, 560, 880) * f;
  const hw = range(rng, 46, 66) * f;
  const bend = (rng() < 0.5 ? -1 : 1) * range(rng, 0.04, 0.12) * len;
  el.angle = range(rng, -0.6, 0.6) + (rng() < 0.3 ? Math.PI / 2 : 0) + (rng() < 0.5 ? Math.PI : 0);
  el.p0 = bend;
  el.p1 = hw;
  el.p2 = Math.floor(rng() * 256);
  el.p3 = range(rng, 0.6, 1);
  el.half = len / 2;
  el.thick = hw * 1.15;
  el.hx = len / 2;
  el.hy = Math.abs(bend) + el.thick;
  el.radius = Math.hypot(el.hx, el.hy);
  el.role = C_SWASH;
  return el;
}

/** A wave or zig-zag line. */
function setLine(el: Element, len: number, amp: number, wave: number, th: number, bend: number) {
  el.p0 = bend;
  el.p1 = amp;
  el.p2 = wave;
  el.p3 = th;
  el.half = len / 2;
  el.thick = amp * 1.2 + th;
  el.hx = len / 2 + th;
  el.hy = Math.abs(bend) + el.thick;
  el.radius = Math.hypot(el.hx, el.hy);
}

function makeSquiggle(rng: () => number, f: number): Element {
  const el = blank(G_SQUIGGLE, rng() < 0.5 ? K_WAVE : K_ZIG, rng);
  const len = range(rng, 320, 620) * f;
  setLine(
    el,
    len,
    range(rng, 14, 22) * f,
    range(rng, 52, 80) * f,
    range(rng, 4.5, 6) * f,
    (rng() < 0.5 ? -1 : 1) * range(rng, 0, 0.08) * len,
  );
  el.role = C_SQUIGGLE;
  return el;
}

const accent = (rng: () => number) => C_ACCENT + Math.floor(rng() * 3);

function makeShape(rng: () => number, f: number): Element {
  const pick = Math.floor(rng() * 5);
  const kind = [K_ZIG, K_HALF, K_GRID, K_SQUARE, K_RING_TRI][pick];
  const el = blank(G_SHAPE, kind, rng);
  el.role = rng() < 0.25 ? C_SQUIGGLE : accent(rng);
  if (kind === K_ZIG) {
    setLine(
      el,
      range(rng, 150, 220) * f,
      range(rng, 14, 20) * f,
      range(rng, 34, 44) * f,
      range(rng, 6, 8) * f,
      0,
    );
    // A band, compact as far as placement goes.
    el.half = 0;
  } else if (kind === K_HALF) {
    const r = range(rng, 40, 60) * f;
    el.p0 = r;
    el.hx = r;
    el.hy = r / 2;
  } else if (kind === K_GRID) {
    const nx = 3 + Math.floor(rng() * 3);
    const ny = 3 + Math.floor(rng() * 2);
    const g = range(rng, 18, 22) * f;
    const r = range(rng, 4, 5) * f;
    el.p0 = g;
    el.p1 = r;
    el.p2 = nx;
    el.p3 = ny;
    el.hx = ((nx - 1) * g) / 2 + r;
    el.hy = ((ny - 1) * g) / 2 + r;
  } else {
    const s = (kind === K_SQUARE ? range(rng, 28, 40) : range(rng, 34, 46)) * f;
    const t = 5 * f;
    el.p0 = s;
    el.p1 = t;
    el.hx = s + t;
    el.hy = s + t;
  }
  el.radius = Math.hypot(el.hx, el.hy);
  return el;
}

function makeSplat(rng: () => number, f: number): Element {
  const el = blank(G_SPLAT, K_SPLAT, rng);
  const r = range(rng, 40, 70) * f;
  el.p0 = r;
  el.p1 = 7 + Math.floor(rng() * 6);
  el.p2 = f;
  el.radius = r + 9 * f;
  el.role = C_SWASH;
  return el;
}

function makeConfetti(rng: () => number, f: number): Element {
  const pick = rng();
  const kind = pick < 0.3 ? K_DOT : pick < 0.55 ? K_TRI : pick < 0.8 ? K_DASH : K_WAVE;
  const el = blank(G_CONFETTI, kind, rng);
  el.role = accent(rng);
  if (kind === K_DOT) {
    const r = range(rng, 5, 8) * f;
    el.p0 = r;
    el.hx = r;
    el.hy = r;
  } else if (kind === K_TRI) {
    const r = range(rng, 8, 12) * f;
    el.p0 = r;
    el.hx = r;
    el.hy = r;
  } else if (kind === K_DASH) {
    const half = range(rng, 8, 14) * f;
    const w = range(rng, 3, 4) * f;
    el.p0 = half;
    el.p1 = w;
    el.hx = half + w;
    el.hy = w;
  } else {
    setLine(el, range(rng, 40, 60) * f, 5 * f, range(rng, 16, 20) * f, range(rng, 2.5, 3) * f, 0);
    el.half = 0;
  }
  el.radius = Math.hypot(el.hx, el.hy);
  return el;
}

/** Scale-1 counts for a 1920 x 1080 region. */
const COUNTS = [7, 6, 7, 4, 60];
const BASE_AREA = 1920 * 1080;
/** How far beyond the frame the drift torus reaches, ref px at scale 1: more than any element's radius. */
const DRIFT_PAD = 520;

interface PlaceContext {
  scene: Scene;
  clear: Ellipse;
  /** The scene's swashes, which squiggles and splatter attach to. */
  swashes: Element[];
}

/** Size factor for a spot: smaller towards the centre (in the static layout). */
function sizeAt(ctx: PlaceContext, x: number, y: number): number {
  const s = ctx.scene;
  if (s.uniform) {
    return s.k;
  }
  return s.k * (0.6 + 0.4 * smoothstep(1, 1.8, ellipseNorm(ctx.clear, x, y)));
}

function others(scene: Scene, group: number, skip: Element | null): Element[] {
  return scene.elements.filter((e) => e.group === group && e !== skip && e.state !== GONE);
}

/** One placement try for `group`; null when the spot is taken or not allowed. */
function attempt(ctx: PlaceContext, group: number, rng: () => number, skip: Element | null) {
  const swashes = ctx.swashes;
  const s = ctx.scene;
  let x = s.x0 + rng() * s.w;
  let y = s.y0 + rng() * s.h;
  const f = sizeAt(ctx, x, y);
  let el: Element;
  if (group === G_SWASH) {
    el = makeSwash(rng, f);
  } else if (group === G_SQUIGGLE) {
    el = makeSquiggle(rng, f);
    // Most squiggles ride along or across a swash, as on the cup.
    if (swashes.length > 0 && rng() < 0.65) {
      const host = swashes[Math.floor(rng() * swashes.length)];
      const along = range(rng, -0.4, 0.4) * host.half;
      const across = range(rng, -0.6, 0.6) * host.p1;
      const c = Math.cos(host.angle);
      const n = Math.sin(host.angle);
      x = host.x + along * c - across * n;
      y = host.y + along * n + across * c;
      el.angle = host.angle + range(rng, -0.3, 0.3);
    }
  } else if (group === G_SHAPE) {
    el = makeShape(rng, f);
  } else if (group === G_SPLAT) {
    el = makeSplat(rng, f);
    // Near a swash's tail, in its colour.
    if (swashes.length > 0) {
      const host = swashes[Math.floor(rng() * swashes.length)];
      const tail = pathPoint(host, 1, 0, 0, { x: 0, y: 0 });
      const reach = host.p1 + el.p0 * range(rng, 0.6, 1.2);
      x = tail.x + Math.cos(host.angle) * reach;
      y = tail.y + Math.sin(host.angle) * reach;
      el.angle = host.angle;
    }
  } else {
    el = makeConfetti(rng, f);
  }
  el.x = x;
  el.y = y;
  el.cos = Math.cos(el.angle);
  el.sin = Math.sin(el.angle);

  if (!s.uniform) {
    const room = clearance(el, ctx.clear);
    const margin = CLEAR_MARGIN + 0.1 * (el.half > 0 ? 0 : el.radius);
    if (room < margin) {
      if (!centreAllowed(el)) {
        return null;
      }
      // The odd short squiggle and a little confetti stay in the middle.
      if (group === G_SQUIGGLE) {
        el.half *= 0.5;
        el.hx = el.half + el.p3;
        el.radius = Math.hypot(el.hx, el.hy);
      }
    } else if (group === G_CONFETTI && rng() > 0.35 + 0.65 * smoothstep(0, 220, room)) {
      return null;
    }
  }
  for (const o of s.elements) {
    if (o === skip || o === el || o.state === GONE) {
      continue;
    }
    if (!spaced(el, o)) {
      return null;
    }
  }
  return el;
}

/** Whether a new element keeps a pattern-like distance from an existing one. */
function spaced(el: Element, o: Element): boolean {
  const g = el.group;
  const og = o.group;
  if (g === G_SWASH && og === G_SWASH) {
    return gapBetween(el, o) > 0.1 * (el.thick + o.thick);
  }
  if (g === G_SWASH && (og === G_SHAPE || og === G_SPLAT)) {
    return gapBetween(o, el) > 0;
  }
  if ((g === G_SHAPE || g === G_SPLAT) && (og === G_SWASH || og === G_SHAPE || og === G_SPLAT)) {
    return gapBetween(el, o) > (g === G_SPLAT && og === G_SWASH ? -0.5 * el.radius : 6);
  }
  if (g === G_SQUIGGLE && og === G_SQUIGGLE) {
    return gapBetween(el, o) > 0;
  }
  if (g === G_SQUIGGLE && og === G_SHAPE) {
    return gapBetween(o, el) > 0;
  }
  if (g === G_CONFETTI) {
    if (og === G_SHAPE || og === G_SPLAT) {
      return gapBetween(el, o) > 0;
    }
    if (og === G_CONFETTI) {
      return Math.hypot(el.x - o.x, el.y - o.y) > 2.5 * (el.radius + o.radius);
    }
  }
  return true;
}

function place(ctx: PlaceContext, group: number, rng: () => number, skip: Element | null) {
  ctx.swashes = others(ctx.scene, G_SWASH, null);
  for (let i = 0; i < 60; i++) {
    const el = attempt(ctx, group, rng, skip);
    if (el) {
      return el;
    }
  }
  return null;
}

function buildScene(jazz: Jazz, seed: number, k: number, uniform: boolean): Scene {
  const pad = uniform ? DRIFT_PAD * k : 0;
  const scene: Scene = {
    elements: [],
    uniform,
    seed,
    k,
    x0: -pad,
    y0: -pad,
    w: jazz.width + 2 * pad,
    h: jazz.height + 2 * pad,
    clock: 0,
    nextEvent: EVENT_MIN,
    pending: null,
    pendingDelay: 0,
    rng: createRng(hash32(Math.round(seed) * 7919 + 101)),
  };
  const rng = createRng(hash32(Math.round(seed) + 1));
  const ctx: PlaceContext = { scene, clear: jazz.clear, swashes: [] };
  const area = (scene.w * scene.h) / BASE_AREA / (k * k);
  for (let g = 0; g < GROUP_COUNT; g++) {
    const n = Math.max(1, Math.round(COUNTS[g] * area));
    for (let i = 0; i < n; i++) {
      const el = place(ctx, g, rng, null);
      if (el) {
        scene.elements.push(el);
      }
    }
  }
  scene.nextEvent = range(scene.rng, FIRST_EVENT_MIN, FIRST_EVENT_MAX);
  return scene;
}

export function createJazz(): Jazz {
  return {
    width: 1,
    height: 1,
    clear: { cx: 0, cy: 0, rx: 1, ry: 1 },
    current: null,
    previous: null,
    fade: 1,
    groupAlpha: new Float32Array(GROUP_COUNT).fill(1),
    wobble: 0,
    wobbleClock: 0,
    driftX: 0,
    driftY: 0,
    dirty: true,
    started: false,
  };
}

/** Lays the pattern out again for a `width` x `height` ref px frame, at the next step, without a crossfade. */
export function resizeJazz(jazz: Jazz, width: number, height: number): void {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  if (w === jazz.width && h === jazz.height && jazz.current) {
    return;
  }
  jazz.width = w;
  jazz.height = h;
  clearEllipse(w, h, jazz.clear);
  jazz.dirty = true;
}

function groupOn(p: JazzParams, g: number): boolean {
  return g === G_SHAPE
    ? p.shapes
    : g === G_SPLAT
      ? p.splatter
      : g === G_CONFETTI
        ? p.confetti
        : true;
}

/** The scale param as a size factor. */
const scaleOf = (p: JazzParams) => clamp(Number.isFinite(p.scale) ? p.scale : 1, MIN_SCALE, 1);
const seedOf = (p: JazzParams) => (Number.isFinite(p.seed) ? Math.round(p.seed) : 0);

/** The extent a transition moves an element's edge or tip over, ref px per unit progress. */
function travel(el: Element): number {
  if (el.half > 0) {
    // The paint-on or un-paint cut-off runs the stroke's length.
    return 2 * el.half * SMOOTH_SLOPE;
  }
  return el.radius * (el.state === ENTERING ? POP_SLOPE : SMOOTH_SLOPE);
}

function duration(el: Element): number {
  if (el.half > 0) {
    return el.state === ENTERING ? PAINT_IN : UNPAINT;
  }
  return el.state === ENTERING ? POP_IN : SHRINK;
}

function stepScene(
  jazz: Jazz,
  scene: Scene,
  dt: number,
  rate: number,
  p: JazzParams,
  live: boolean,
) {
  const dTau = dt * rate;
  let moving = 0;
  let removed = false;
  for (const el of scene.elements) {
    if (el.state !== ENTERING && el.state !== LEAVING) {
      continue;
    }
    let dp = dTau / duration(el);
    const ext = travel(el);
    if (ext > 0) {
      // No edge or tip moves faster than the codec limit at 30 fps.
      dp = Math.min(dp, (MAX_FEATURE_PX_PER_FRAME * dt * 30) / ext);
    }
    el.t = Math.min(1, el.t + dp);
    if (el.t >= 1) {
      if (el.state === LEAVING) {
        el.state = GONE;
        removed = true;
      } else {
        el.state = SHOWN;
      }
    } else {
      moving++;
    }
  }
  if (removed) {
    scene.elements = scene.elements.filter((e) => e.state !== GONE);
  }
  if (!live) {
    return;
  }
  if (scene.pending) {
    scene.pendingDelay -= dTau;
    if (scene.pendingDelay <= 0) {
      const el = scene.pending;
      scene.pending = null;
      el.state = ENTERING;
      el.t = 0;
      scene.elements.push(el);
    }
    return;
  }
  if (p.animation !== "paint" || rate <= 0) {
    return;
  }
  // The pause only counts once nothing is changing.
  if (moving > 0) {
    return;
  }
  scene.clock += dTau;
  if (scene.clock < scene.nextEvent) {
    return;
  }
  scene.nextEvent = scene.clock + range(scene.rng, EVENT_MIN, EVENT_MAX);
  const candidates = scene.elements.filter((e) => e.state === SHOWN && groupOn(p, e.group));
  if (candidates.length === 0) {
    return;
  }
  const el = pickWeighted(candidates, scene.rng);
  // Find the replacement's spot first, so the pattern never thins out.
  const next = place({ scene, clear: jazz.clear, swashes: [] }, el.group, scene.rng, el);
  if (!next) {
    return;
  }
  el.state = LEAVING;
  el.t = 0;
  scene.pending = next;
  scene.pendingDelay = SPAWN_DELAY;
}

/** One of `candidates`, by `GROUP_PICK` across the groups present, then evenly within the group. */
function pickWeighted(candidates: readonly Element[], rng: () => number): Element {
  let total = 0;
  const present = [0, 0, 0, 0, 0];
  for (const e of candidates) {
    present[e.group]++;
  }
  for (let g = 0; g < GROUP_COUNT; g++) {
    total += present[g] > 0 ? GROUP_PICK[g] : 0;
  }
  let r = rng() * total;
  let group = candidates[0].group;
  for (let g = 0; g < GROUP_COUNT; g++) {
    if (present[g] > 0) {
      group = g;
      r -= GROUP_PICK[g];
      if (r < 0) {
        break;
      }
    }
  }
  const pool = candidates.filter((e) => e.group === group);
  return pool[Math.floor(rng() * pool.length)];
}

/** Advances the pattern by `dt` seconds. */
export function stepJazz(jazz: Jazz, dt: number, p: JazzParams): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const rate = rateFor(Number.isFinite(p.speed) ? p.speed : 0);
  const k = scaleOf(p);
  const seed = seedOf(p);
  const uniform = p.animation === "drift";
  let cur = jazz.current;
  if (jazz.dirty || !cur) {
    cur = buildScene(jazz, seed, k, uniform);
    jazz.previous = null;
    jazz.fade = 1;
    jazz.dirty = false;
  } else if (cur.seed !== seed || cur.k !== k || cur.uniform !== uniform) {
    jazz.previous = cur;
    cur = buildScene(jazz, seed, k, uniform);
    jazz.fade = 0;
  }
  jazz.current = cur;
  const wobbleTarget = p.animation === "wobble" ? 1 : 0;
  for (let g = 0; g < GROUP_COUNT; g++) {
    const target = groupOn(p, g) ? 1 : 0;
    jazz.groupAlpha[g] = jazz.started
      ? approach(jazz.groupAlpha[g], target, step / TOGGLE_FADE)
      : target;
  }
  jazz.wobble = jazz.started ? approach(jazz.wobble, wobbleTarget, step) : wobbleTarget;
  jazz.started = true;
  jazz.fade = Math.min(1, jazz.fade + step / CROSSFADE);
  if (jazz.fade >= 1) {
    jazz.previous = null;
  }
  jazz.wobbleClock += step * rate;
  // Drift keeps going under a fading-out drift layout, so it doesn't stop dead.
  if (uniform || jazz.previous?.uniform === true) {
    const v = driftSpeed(p.speed, k) * step;
    jazz.driftX += DRIFT_DIR_X * v;
    jazz.driftY += DRIFT_DIR_Y * v;
  }
  // Transitions still finish in the other modes (at least at rate 1) unless the speed is 0.
  const finish = p.animation === "paint" ? rate : rate > 0 ? Math.max(rate, 1) : 0;
  stepScene(jazz, cur, step, finish, p, true);
  if (jazz.previous) {
    stepScene(jazz, jazz.previous, step, finish, p, false);
  }
}

/** Fills `pose` with where `el` of `scene` is drawn this frame; false when it's invisible. */
function poseOf(jazz: Jazz, scene: Scene, el: Element, sceneAlpha: number, pose: Pose): boolean {
  let alpha = sceneAlpha * jazz.groupAlpha[el.group];
  let pop = 1;
  let reveal = 1;
  if (el.state === ENTERING) {
    if (el.half > 0) {
      reveal = smoothstep(0, 1, el.t);
    } else {
      pop = popEase(el.t);
      alpha *= Math.min(1, el.t * 4);
    }
  } else if (el.state === LEAVING) {
    if (el.half > 0) {
      // Un-paints from the start, so the tail goes last, as it came.
      reveal = 1 + smoothstep(0, 1, el.t);
    } else {
      pop = 1 - smoothstep(0, 1, el.t);
    }
  } else if (el.state === GONE) {
    return false;
  }
  let x = el.x;
  let y = el.y;
  let angle = el.angle;
  const wob = jazz.wobble;
  if (wob > 0) {
    const ph = (2 * Math.PI * jazz.wobbleClock) / el.wobblePeriod + el.wobblePhase;
    x += wob * WOBBLE_SHIFT * Math.sin(ph);
    y += wob * WOBBLE_SHIFT * Math.cos(0.8 * ph + 1.7 * el.wobblePhase);
    const reach = Math.max(el.hx, el.hy, 1);
    angle += wob * Math.min(0.06, WOBBLE_TIP / reach) * Math.sin(0.7 * ph + 2 * el.wobblePhase);
    if (el.half <= 0) {
      pop *= 1 + wob * WOBBLE_BREATHE * Math.sin(1.3 * ph);
    }
  }
  if (scene.uniform) {
    x = wrap(x + jazz.driftX, scene.x0, scene.w);
    y = wrap(y + jazz.driftY, scene.y0, scene.h);
    // The centre stays clear while the pattern moves under it.
    if (!centreAllowed(el)) {
      const dx = x - el.x;
      const dy = y - el.y;
      alpha *= smoothstep(0, DRIFT_FADE, clearance(el, jazz.clear, dx, dy));
    }
  }
  pose.x = x;
  pose.y = y;
  pose.angle = angle;
  pose.pop = pop;
  pose.reveal = reveal;
  pose.alpha = alpha;
  return alpha > 0.002 && pop > 0.002 && reveal > 0 && reveal < 2;
}

/** Calls `visit` with each visible element and its pose, back to front. */
export function forEachVisible(
  jazz: Jazz,
  pose: Pose,
  visit: (el: Element, pose: Pose) => void,
): void {
  const cur = jazz.current;
  if (!cur) {
    return;
  }
  const prev = jazz.previous;
  const fade = smoothstep(0, 1, jazz.fade);
  for (const g of DRAW_ORDER) {
    if (prev) {
      for (const el of prev.elements) {
        if (el.group === g && poseOf(jazz, prev, el, 1 - fade, pose)) {
          visit(el, pose);
        }
      }
    }
    for (const el of cur.elements) {
      if (el.group === g && poseOf(jazz, cur, el, fade, pose)) {
        visit(el, pose);
      }
    }
  }
}

/** The current layout's elements still on show or changing (not counting a fading previous one). */
export function liveElements(jazz: Jazz): readonly Element[] {
  return jazz.current?.elements ?? [];
}

export const isChanging = (el: Element) => el.state === ENTERING || el.state === LEAVING;

/** A splatter droplet: offset along and across the cluster's direction, and radius, ref px. */
export function splatDroplet(el: Element, i: number, out: { x: number; y: number; r: number }) {
  const h = hash32(Math.floor(el.rnd * 1e6) * 31 + i);
  const a = (h & 0xffff) / 65536;
  const b = (h >>> 16) / 65536;
  const f = el.p2;
  // The first few drops are big and near; the rest small, flung further along.
  const big = i < 3;
  const dist = el.p0 * (big ? 0.15 + 0.35 * a : 0.3 + 0.7 * a);
  const spread = (b - 0.5) * (big ? 2.4 : 1.4);
  out.x = Math.cos(spread) * dist;
  out.y = Math.sin(spread) * dist;
  out.r = (big ? 6 + 3 * b : 2.5 + 3 * a * b) * f;
  return out;
}
