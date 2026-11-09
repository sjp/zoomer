/**
 * Pure logic for the Liquid Marble effect, shared by `marble.ts` and its tests:
 * the mathematical-marbling operations (Lu, Jaffer et al.) with their forward and
 * inverse maps, the stroke and drop scheduler, the bounded operation queue that
 * hands its oldest finished operations to the bake, and the uniform packing.
 *
 * Space: "units" are 1080p reference pixels divided by the pattern scale, with the
 * origin at the frame centre and y up. Every operation is a closed-form, invertible,
 * area-preserving map of the plane:
 *
 * - drop at c, radius r: p' = c + (p - c) sqrt(1 + r^2 / |p - c|^2). The disc of
 *   radius r around c is the new paint; everything else is pushed outward.
 * - comb (tine lines, `kind` = tine count >= 1; one tine is a stylus line): the
 *   tines are parallel lines through c + (j - h) s n (n the unit normal of the
 *   stroke direction d, s the spacing, h = (count - 1) / 2). A point at distance
 *   t from the nearest tine moves A e^(-t / lambda) along d. t depends only on the
 *   coordinate across d, which the move leaves alone, so the inverse subtracts the
 *   same shift.
 * - swirl at c: a rotation by A e^(-|p - c| / lambda), which keeps |p - c|, so the
 *   inverse turns back by the same angle.
 *
 * An operation in progress uses its eased progress e: a drop's area grows as e
 * (radius R sqrt(e)), a comb's shift and a swirl's angle as e A. At e = 0 each is
 * the identity, so starting one never jumps.
 */
import { createRng } from "../noise";
import { lookup } from "../lookup";

/** Operation kinds as packed for the shader; a comb's kind is its tine count (>= 1). */
export const KIND_DROP = 0;
export const KIND_SWIRL = -1;

export interface MarbleOp {
  /** `KIND_DROP`, `KIND_SWIRL`, or the tine count of a comb. */
  kind: number;
  /** Drop or swirl centre; a point on the middle tine of a comb. */
  x: number;
  y: number;
  /** Drop: final radius. Swirl: angle (rad). Comb: shift along the direction (units). */
  amount: number;
  /** Comb: unit stroke direction. */
  dx: number;
  dy: number;
  /** Swirl and comb: decay length lambda (units). */
  falloff: number;
  /** Comb: distance between tines (units). */
  spacing: number;
  /** Drop: palette index of its paint. */
  colour: number;
  /** Sim time the operation starts, and how long it takes (sim seconds). */
  start: number;
  duration: number;
}

/** Operations the shader holds; the queue never grows past this. */
export const MAX_OPS = 24;
/** Queue length at which the finished prefix is baked, rate-limited by `BAKE_MIN_INTERVAL`. */
export const BAKE_AT = 6;
/** Queue length at which the bake ignores the rate limit. */
export const BAKE_FORCE_AT = MAX_OPS - 3;
/** Real seconds between bakes, unless the queue is nearly full. */
export const BAKE_MIN_INTERVAL = 4;

export const STROKE_MODES = ["combs", "swirls", "mixed"] as const;
export type StrokeMode = (typeof STROKE_MODES)[number];

export interface MarblePalette {
  /** 3 to 6 opaque paint colours; the base stripes cycle through them in order. */
  colours: readonly string[];
}

export const MAX_COLOURS = 6;

export const PALETTES = {
  classic: { colours: ["#efe4cc", "#27346b", "#c8962e", "#efe4cc", "#a63a2c", "#3e5487"] },
  ocean: { colours: ["#f1e6c8", "#0f4c5c", "#2a9d9f", "#d4a73c", "#0a2a36"] },
  earth: { colours: ["#e3d5b8", "#5b3a29", "#a0673a", "#c9a66b", "#6b6b47", "#3a2f28"] },
  pastel: { colours: ["#f7f1e8", "#e8c4c4", "#c4d7e8", "#f2e2b8", "#cfc0e0", "#d9e8c4"] },
} as const satisfies Record<string, MarblePalette>;
export type MarblePaletteName = keyof typeof PALETTES;

/** The named palette, or Classic for an unknown name. */
export function marblePalette(name: string): MarblePalette {
  return lookup(PALETTES, name, "classic");
}

/** Smooth ease in and out of [0, 1], clamped. */
export function ease(p: number): number {
  const t = p <= 0 ? 0 : p >= 1 ? 1 : p;
  return t * t * (3 - 2 * t);
}

/** Eased progress of `op` at sim time `time`. */
function progress(op: MarbleOp, time: number): number {
  return op.duration > 0 ? ease((time - op.start) / op.duration) : time >= op.start ? 1 : 0;
}

/** True once `op` has finished at sim time `time`. */
export function isDone(op: MarbleOp, time: number): boolean {
  return time >= op.start + op.duration;
}

/** The operation's strength at eased progress `e`: a drop's radius, a swirl's angle, a comb's shift. */
function strength(op: MarbleOp, e: number): number {
  return op.kind === KIND_DROP ? op.amount * Math.sqrt(Math.max(e, 0)) : op.amount * e;
}

/** Distance from the point (x, y) to the nearest tine of a comb. */
export function tineDistance(op: MarbleOp, x: number, y: number): number {
  const across = (x - op.x) * -op.dy + (y - op.y) * op.dx;
  const h = (op.kind - 1) / 2;
  const j = Math.min(Math.max(Math.floor(across / op.spacing + h + 0.5), 0), op.kind - 1);
  return Math.abs(across - (j - h) * op.spacing);
}

/**
 * Applies `op` at eased progress `e` to (x, y), writing the moved point to `out`.
 * The forward map, used only by tests and to document the inverse.
 */
export function forward(op: MarbleOp, e: number, x: number, y: number, out: Float64Array): void {
  const s = strength(op, e);
  if (op.kind === KIND_DROP) {
    const dx = x - op.x;
    const dy = y - op.y;
    const d2 = dx * dx + dy * dy;
    const k = d2 > 0 ? Math.sqrt(1 + (s * s) / d2) : 1;
    out[0] = op.x + dx * k;
    out[1] = op.y + dy * k;
  } else if (op.kind === KIND_SWIRL) {
    rotateAbout(op, s, x, y, out);
  } else {
    const shift = s * Math.exp(-tineDistance(op, x, y) / op.falloff);
    out[0] = x + op.dx * shift;
    out[1] = y + op.dy * shift;
  }
}

/**
 * Undoes `op` at eased progress `e` for the point (x, y), writing where it came from
 * to `out`. Returns false for a point inside a drop's disc, which came from no
 * earlier point; `out` is then the drop centre, which every point of the disc's rim
 * came from. This is the shader's per-pixel step.
 */
export function inverse(op: MarbleOp, e: number, x: number, y: number, out: Float64Array): boolean {
  const s = strength(op, e);
  if (op.kind === KIND_DROP) {
    const dx = x - op.x;
    const dy = y - op.y;
    const d2 = dx * dx + dy * dy;
    const r2 = s * s;
    const k = d2 > r2 ? Math.sqrt(1 - r2 / d2) : 0;
    out[0] = op.x + dx * k;
    out[1] = op.y + dy * k;
    return d2 >= r2;
  }
  if (op.kind === KIND_SWIRL) {
    rotateAbout(op, -s, x, y, out);
  } else {
    const shift = s * Math.exp(-tineDistance(op, x, y) / op.falloff);
    out[0] = x - op.dx * shift;
    out[1] = y - op.dy * shift;
  }
  return true;
}

/** Rotates (x, y) about the swirl centre by `angle` e^(-r / lambda). */
function rotateAbout(op: MarbleOp, angle: number, x: number, y: number, out: Float64Array): void {
  const dx = x - op.x;
  const dy = y - op.y;
  const a = angle * Math.exp(-Math.hypot(dx, dy) / op.falloff);
  const c = Math.cos(a);
  const s = Math.sin(a);
  out[0] = op.x + c * dx - s * dy;
  out[1] = op.y + s * dx + c * dy;
}

/** Floats per packed operation: two vec4s. */
export const OP_FLOATS = 4;

/**
 * Packs `count` operations starting at `from` into the shader's two vec4 arrays:
 *
 * - a = (kind, x, y, strength), with a drop's strength squared (r^2);
 * - b = drop: (colour, 0, 0, 0); swirl: (1 / lambda, 0, 0, 0);
 *   comb: (dx, dy, 1 / lambda, spacing).
 */
export function packOps(
  ops: readonly MarbleOp[],
  from: number,
  count: number,
  time: number,
  a: Float32Array,
  b: Float32Array,
): void {
  for (let i = 0; i < count; i++) {
    const op = ops[from + i];
    const s = strength(op, progress(op, time));
    const o = i * OP_FLOATS;
    a[o] = op.kind;
    a[o + 1] = op.x;
    a[o + 2] = op.y;
    a[o + 3] = op.kind === KIND_DROP ? s * s : s;
    if (op.kind === KIND_DROP) {
      b[o] = op.colour;
      b[o + 1] = 0;
      b[o + 2] = 0;
    } else if (op.kind === KIND_SWIRL) {
      b[o] = 1 / op.falloff;
      b[o + 1] = 0;
      b[o + 2] = 0;
    } else {
      b[o] = op.dx;
      b[o + 1] = op.dy;
      b[o + 2] = 1 / op.falloff;
    }
    b[o + 3] = op.kind >= 1 ? op.spacing : 0;
  }
}

/** Seconds (sim time) a drop takes to spread. */
const DROP_DURATION = 2.5;
/** Width of the initial stripes, in units. */
export const STRIPE_WIDTH = 64;

interface MarbleSettings {
  /** Sim seconds per real second. */
  speed: number;
  /** Drop bursts per minute of sim time; 0 for none. */
  drops: number;
  strokes: string;
}

/** Half extents of the visible frame, in units. */
export interface Extent {
  hx: number;
  hy: number;
}

export interface MarbleSim {
  readonly seed: number;
  /** Palette size the drop colours are picked from. */
  readonly colours: number;
  /** The live operations, oldest first; the baked prefix has been removed. */
  readonly ops: readonly MarbleOp[];
  /** Sim time in seconds (float64, unwrapped; only relative values reach the GPU). */
  readonly time: number;
  /** Bakes committed so far. */
  readonly bakes: number;
  /** Advances by `dt` real seconds, starting strokes and drops when they are due and fit. */
  step: (dt: number, settings: MarbleSettings, extent: Extent) => void;
  /** How many of the oldest operations to bake now, or 0 when no bake is due. */
  bakeCount: () => number;
  /** Forgets the oldest `k` operations, which the caller has baked into its base. */
  commitBake: (k: number) => void;
}

interface MarbleOptions {
  seed: number;
  /** Palette size (3 to 6). */
  colours: number;
  /** Visible half extents, for placing the starting rings. */
  extent: Extent;
}

/**
 * Creates the scheduler. It starts with a few finished ring drops on the stripes,
 * then alternates strokes with pauses, and drops bursts of fresh paint at the
 * `drops` rate. New operations wait while the queue is full, so it never holds more
 * than `MAX_OPS`.
 */
export function createMarble(o: MarbleOptions): MarbleSim {
  const seed = Number.isFinite(o.seed) ? Math.floor(o.seed) : 0;
  const colours = Math.min(Math.max(Math.floor(o.colours), 1), MAX_COLOURS);
  const rng = createRng(seed ^ 0x6d61726b);
  const range = (lo: number, hi: number) => lo + (hi - lo) * rng();
  const ops: MarbleOp[] = [];
  let time = 0;
  let sinceBake = 0;
  let bakes = 0;
  let nextStroke = 1.5;
  let strokeEnd = 0;
  let combSign = 1;
  let combAxis = 0;
  let lastColour = -1;
  /** Fraction of the way to the next burst; a burst fires at 1. */
  let burstClock = 0.6;
  /** Start times of drops in the current burst that haven't started yet. */
  const pending: number[] = [];

  function pickColour(): number {
    let c = Math.floor(rng() * colours);
    if (colours > 1 && c === lastColour) {
      c = (c + 1 + Math.floor(rng() * (colours - 1))) % colours;
    }
    lastColour = c;
    return c;
  }

  function op(partial: Partial<MarbleOp> & { kind: number; duration: number }): MarbleOp {
    return {
      x: 0,
      y: 0,
      amount: 0,
      dx: 1,
      dy: 0,
      falloff: 1,
      spacing: 1,
      colour: 0,
      start: time,
      ...partial,
    };
  }

  function drop(x: number, y: number, radius: number, start: number, duration: number): MarbleOp {
    return op({ kind: KIND_DROP, x, y, amount: radius, colour: pickColour(), start, duration });
  }

  // Starting rings: drops landing on the same spot push the earlier ones into rings.
  {
    const { hx, hy } = o.extent;
    const centres = 3 + Math.floor(rng() * 2);
    for (let c = 0; c < centres; c++) {
      const x = range(-0.85, 0.85) * hx;
      const y = range(-0.8, 0.8) * hy;
      const rings = 3;
      for (let r = 0; r < rings; r++) {
        ops.push(drop(x, y, range(26, 44), -1, 0));
      }
    }
  }

  function startStroke(mode: string, ext: Extent): MarbleOp {
    const u = rng();
    const kind =
      mode === "combs"
        ? u < 0.6
          ? "comb"
          : "line"
        : mode === "swirls"
          ? u < 0.75
            ? "swirl"
            : "line"
          : u < 0.35
            ? "comb"
            : u < 0.65
              ? "line"
              : "swirl";
    if (kind === "swirl") {
      return op({
        kind: KIND_SWIRL,
        x: range(-0.8, 0.8) * ext.hx,
        y: range(-0.75, 0.75) * ext.hy,
        amount: (rng() < 0.5 ? -1 : 1) * range(1.8, 3.4),
        falloff: range(70, 160),
        duration: range(8, 12),
      });
    }
    if (kind === "line") {
      const a = rng() * Math.PI;
      return op({
        kind: 1,
        x: range(-0.6, 0.6) * ext.hx,
        y: range(-0.6, 0.6) * ext.hy,
        amount: (rng() < 0.5 ? -1 : 1) * range(120, 240),
        dx: Math.cos(a),
        dy: Math.sin(a),
        falloff: range(18, 40),
        duration: range(6, 9),
      });
    }
    // A comb across the whole frame, alternating direction like a traditional gel-git.
    combAxis = rng() < 0.7 ? combAxis : 1 - combAxis;
    combSign = -combSign;
    const a = (combAxis === 0 ? 0 : Math.PI / 2) + range(-0.15, 0.15);
    const dx = Math.cos(a) * combSign;
    const dy = Math.sin(a) * combSign;
    const spacing = range(50, 90);
    const across = Math.abs(-dy * ext.hx) + Math.abs(dx * ext.hy);
    const tines = Math.min(2 * Math.ceil(across / spacing) + 1, 255);
    return op({
      kind: tines,
      x: range(-0.5, 0.5) * spacing,
      y: range(-0.5, 0.5) * spacing,
      amount: range(70, 150),
      dx,
      dy,
      falloff: spacing * range(0.12, 0.22),
      spacing,
      duration: range(9, 12),
    });
  }

  return {
    seed,
    colours,
    ops,
    get time() {
      return time;
    },
    get bakes() {
      return bakes;
    },
    step(dt, settings, ext) {
      const real = Number.isFinite(dt) && dt > 0 ? dt : 0;
      sinceBake += real;
      const speed = Number.isFinite(settings.speed) ? Math.max(settings.speed, 0) : 1;
      time += real * speed;

      if (time >= nextStroke && time >= strokeEnd && ops.length < MAX_OPS) {
        const s = startStroke(settings.strokes, ext);
        ops.push(s);
        strokeEnd = s.start + s.duration;
        nextStroke = strokeEnd + range(2, 4);
      }

      const rate = Number.isFinite(settings.drops) ? Math.max(settings.drops, 0) : 0;
      burstClock += (real * speed * rate) / 60;
      if (burstClock >= 1 && pending.length === 0) {
        burstClock = range(-0.25, 0.1);
        let t = time;
        const n = 2 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          pending.push(t);
          t += range(0.5, 1.2);
        }
      }
      while (pending.length > 0 && pending[0] <= time && ops.length < MAX_OPS) {
        pending.shift();
        ops.push(
          drop(
            range(-0.9, 0.9) * ext.hx,
            range(-0.9, 0.9) * ext.hy,
            range(40, 110),
            time,
            DROP_DURATION,
          ),
        );
      }
    },
    bakeCount() {
      const n = ops.length;
      if (n < BAKE_AT || (n < BAKE_FORCE_AT && sinceBake < BAKE_MIN_INTERVAL)) {
        return 0;
      }
      let k = 0;
      while (k < n && isDone(ops[k], time)) {
        k++;
      }
      return k;
    },
    commitBake(k) {
      const n = Math.min(Math.max(Math.floor(k), 0), ops.length);
      if (n === 0) {
        return;
      }
      ops.splice(0, n);
      sinceBake = 0;
      bakes++;
    },
  };
}
