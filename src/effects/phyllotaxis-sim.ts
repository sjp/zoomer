/**
 * Sunflower Spiral model: Vogel's phyllotaxis (seed n at angle n·φ, radius c·√age)
 * with continuous growth, plus the per-style looks and the head's place in the
 * frame. Pure functions and plain state, so they can be tested without WebGL.
 */
import type { Rgb } from "./color";
import { lookup } from "./lookup";
import { fract, smoothstep, wrap } from "./math";
import { hash32 } from "./noise";
import { MAX_SEEDS, type PhylloPositionId, type PhylloStyleId } from "./phyllotaxis.meta";

const TAU = Math.PI * 2;

/** The golden angle, π(3 − √5) radians (about 137.508°). */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Divergence angle in radians for an offset in degrees from the golden angle. */
export function divergence(offsetDeg: number): number {
  return GOLDEN_ANGLE + (offsetDeg * Math.PI) / 180;
}

/** Head rotation in radians per second at `spin` = 1. */
export const SPIN_RATE = 0.12;
/** Seconds for the shown seed count to ease most of the way to a new `seeds` value. */
export const COUNT_EASE = 0.5;
/** Ages (in seeds) over which a new seed grows in at the centre. */
export const FADE_IN = 3;
/** Fraction of the count (at least `FADE_OUT_MIN` seeds) over which seeds fade at the rim. */
export const FADE_OUT = 0.05;
export const FADE_OUT_MIN = 3;

/** Petals per row; the sunflower has a front and a back row. */
export const PETALS = 34;
/** Petal half-length as a fraction of the disc radius. */
export const PETAL_LENGTH = 0.34;
/** Petal sprites (two rows) plus the backing disc. */
export const MAX_PETAL_SPRITES = PETALS * 2 + 1;

/** Floats per seed instance: x, y, size, alpha; tone, hue, variation, 0; angle, flip. */
export const SEED_STRIDE = 10;
/** Floats per petal instance: x, y, half-length, alpha; r, g, b, kind; angle, flip. */
export const PETAL_STRIDE = 10;

export interface PhylloStyle {
  /** Shader branch, see `phyllotaxis.ts`. */
  shader: number;
  /** Disc radius relative to the layout's. */
  radius: number;
  /** Seed sprite half-length at the rim, in units of c (spacing ≈ 1.8c). */
  size: number;
  /** How much smaller seeds are at the centre: 0 = uniform, 1 = zero at the centre. */
  sizeGrow: number;
  /** Sprite half-width over half-length. */
  aspect: number;
  petals: boolean;
  /** Colour of the disc drawn under the seeds, or null for none. */
  backing: Rgb | null;
  top: Rgb;
  bottom: Rgb;
}

export const STYLES: Record<PhylloStyleId, PhylloStyle> = {
  sunflower: {
    shader: 0,
    radius: 1,
    size: 1.0,
    sizeGrow: 0.35,
    aspect: 0.62,
    petals: true,
    backing: [0.16, 0.1, 0.05],
    top: [0.56, 0.72, 0.85],
    bottom: [0.9, 0.87, 0.72],
  },
  pinecone: {
    shader: 1,
    radius: 1.25,
    size: 1.3,
    sizeGrow: 0.5,
    aspect: 0.85,
    petals: false,
    backing: [0.1, 0.06, 0.03],
    top: [0.17, 0.22, 0.16],
    bottom: [0.3, 0.24, 0.17],
  },
  succulent: {
    shader: 2,
    radius: 1.25,
    size: 1.8,
    sizeGrow: 0.6,
    aspect: 0.62,
    petals: false,
    backing: [0.22, 0.32, 0.25],
    top: [0.91, 0.88, 0.83],
    bottom: [0.77, 0.7, 0.63],
  },
  abstract: {
    shader: 3,
    radius: 1.25,
    size: 0.8,
    sizeGrow: 0.3,
    aspect: 1,
    petals: false,
    backing: null,
    top: [0.06, 0.07, 0.12],
    bottom: [0.12, 0.13, 0.22],
  },
};

/** The style for a select value, falling back to the sunflower for an unknown one. */
export function styleFor(id: string): PhylloStyle {
  return lookup(STYLES, id, "sunflower");
}

export interface HeadLayout {
  /** Disc centre and radius, reference px (1080 high, y down). */
  cx: number;
  cy: number;
  radius: number;
}

/**
 * Where the head sits for a reference width (height 1080), before the style's
 * radius. An unknown position falls back to the bottom right.
 */
export function headLayout(
  position: PhylloPositionId | (string & {}),
  refWidth: number,
  out: HeadLayout,
): HeadLayout {
  const h = 1080;
  if (position === "side") {
    out.radius = 0.4 * h;
    out.cx = refWidth + 0.05 * h;
    out.cy = 0.5 * h;
  } else {
    out.radius = 0.3 * h;
    out.cx = position === "bottomLeft" ? 0.2 * h : refWidth - 0.2 * h;
    out.cy = 0.82 * h;
  }
  return out;
}

/** Vogel's model: seed `index` sits at angle index·φ and radius c·√index. */
export function vogelPoint(index: number, phi: number, c: number, out: [number, number]) {
  const r = c * Math.sqrt(index);
  const a = index * phi;
  out[0] = r * Math.cos(a);
  out[1] = r * Math.sin(a);
  return out;
}

export interface Head {
  /** Growth index s(t), unwrapped float64: seeds born so far. */
  s: number;
  /** s·φ accumulated with the φ of each step, wrapped to [0, 2π). */
  phase: number;
  /** Whole-head rotation, wrapped to [0, 2π). */
  rot: number;
  /** Seed count, eased towards the `seeds` param. */
  count: number;
  /** Seconds, unwrapped float64 (CPU only). */
  time: number;
}

export function createHead(count: number): Head {
  return { s: 0, phase: 0, rot: 0, count, time: 0 };
}

/** Advances growth, rotation and the eased count. `growth` is seeds per second. */
export function stepHead(
  h: Head,
  dt: number,
  growth: number,
  spin: number,
  phi: number,
  targetCount: number,
) {
  const ds = growth * dt;
  h.s += ds;
  h.phase = wrap(h.phase + ds * phi, 0, TAU);
  h.rot = wrap(h.rot + spin * SPIN_RATE * dt, 0, TAU);
  h.time += dt;
  const k = 1 - Math.exp(-dt / COUNT_EASE);
  h.count += (targetCount - h.count) * k;
  if (Math.abs(targetCount - h.count) < 0.01) {
    h.count = targetCount;
  }
}

/** Seeds currently shown: every j with age j + fract(s) below the count. */
export function seedCount(h: Head): number {
  return Math.max(0, Math.min(MAX_SEEDS, Math.ceil(h.count - fract(h.s))));
}

export interface SeedPoint {
  /** Birth number n: fixed for a seed, so its angle never changes. */
  birth: number;
  /** Seeds born since, s − n. */
  age: number;
  /** Polar angle in radians, including the head's rotation. */
  angle: number;
  /** Radius as a fraction of the disc radius, √(age / count). */
  rho: number;
  /** 0..1: fades in at the centre and out at the rim. */
  alpha: number;
}

/**
 * The j-th youngest seed. Its angle is n·φ (taken as phase − age·φ, so φ only
 * multiplies small ages and a change of φ stays bounded) and its radius grows
 * with √age, so as s advances each seed only drifts outward.
 */
export function seedAt(h: Head, j: number, phi: number, out: SeedPoint): SeedPoint {
  const f = fract(h.s);
  const age = j + f;
  out.birth = Math.floor(h.s) - j;
  out.age = age;
  out.angle = h.phase - age * phi + h.rot;
  out.rho = Math.sqrt(age / h.count);
  const fadeOut = Math.max(FADE_OUT_MIN, FADE_OUT * h.count);
  out.alpha = smoothstep(0, FADE_IN, age) * (1 - smoothstep(h.count - fadeOut, h.count, age));
  return out;
}

/**
 * Abstract-style hue in [0, 1): constant along each of the 34 spirals (birth
 * numbers 34 apart) and stepping by 1/34 to the neighbouring spiral (21 apart,
 * as 13 · 21 ≡ 1 mod 34), so that family stands out as a rainbow.
 */
export function spiralHue(birth: number): number {
  const m = (((birth * 13) % 34) + 34) % 34;
  return m / 34;
}

/** Per-seed variation in [0, 1), from its birth number. */
export function seedVariation(birth: number): number {
  return hash32(birth) / 4294967296;
}

const point: SeedPoint = { birth: 0, age: 0, angle: 0, rho: 0, alpha: 0 };

/**
 * Writes the shown seeds, outermost first (inner ones then draw on top, as the
 * younger scales and leaves do), in device px. Returns the instance count.
 */
export function writeSeeds(
  h: Head,
  phi: number,
  style: PhylloStyle,
  layout: HeadLayout,
  scale: number,
  out: Float32Array,
  stride: number,
): number {
  const n = seedCount(h);
  const radius = layout.radius * style.radius * scale;
  const cx = layout.cx * scale;
  const cy = layout.cy * scale;
  const c = radius / Math.sqrt(h.count);
  for (let i = 0; i < n; i++) {
    const p = seedAt(h, n - 1 - i, phi, point);
    const r = radius * p.rho;
    const grow = Math.sqrt(smoothstep(0, FADE_IN, p.age));
    const o = i * stride;
    out[o] = cx + r * Math.cos(p.angle);
    out[o + 1] = cy + r * Math.sin(p.angle);
    out[o + 2] = c * style.size * (1 - style.sizeGrow + style.sizeGrow * p.rho) * grow;
    out[o + 3] = p.alpha;
    out[o + 4] = p.rho;
    out[o + 5] = spiralHue(p.birth);
    out[o + 6] = seedVariation(p.birth);
    out[o + 7] = 0;
    out[o + 8] = p.angle;
    out[o + 9] = 1;
  }
  return n;
}

const FRONT_PETAL: Rgb = [0.98, 0.75, 0.12];
const BACK_PETAL: Rgb = [0.86, 0.55, 0.08];

/**
 * Writes the sunflower's two petal rows (back row first) and then the backing
 * disc, in device px. Returns the instance count (0 when the style has neither).
 */
export function writePetals(
  h: Head,
  style: PhylloStyle,
  layout: HeadLayout,
  scale: number,
  out: Float32Array,
  stride: number,
): number {
  const radius = layout.radius * style.radius * scale;
  const cx = layout.cx * scale;
  const cy = layout.cy * scale;
  let k = 0;
  if (style.petals) {
    for (let row = 0; row < 2; row++) {
      const back = row === 0;
      const color = back ? BACK_PETAL : FRONT_PETAL;
      const len = radius * PETAL_LENGTH * (back ? 1.1 : 1);
      for (let i = 0; i < PETALS; i++) {
        const id = i + row * PETALS;
        // Desynchronised by the golden angle, slow and small: the petals sway, not flap.
        const sway = 0.045 * Math.sin(0.45 * h.time + id * GOLDEN_ANGLE);
        const breathe = 1 + 0.03 * Math.sin(0.3 * h.time + id * 1.7);
        const a = h.rot + ((i + (back ? 0.5 : 0)) * TAU) / PETALS + sway;
        const l = len * breathe;
        const r = radius + 0.8 * l;
        const shade = 0.9 + 0.1 * seedVariation(id + 7919);
        const o = k * stride;
        out[o] = cx + r * Math.cos(a);
        out[o + 1] = cy + r * Math.sin(a);
        out[o + 2] = l;
        out[o + 3] = 1;
        out[o + 4] = color[0] * shade;
        out[o + 5] = color[1] * shade;
        out[o + 6] = color[2] * shade;
        out[o + 7] = 0;
        out[o + 8] = a;
        out[o + 9] = 1;
        k++;
      }
    }
  }
  if (style.backing) {
    const o = k * stride;
    out[o] = cx;
    out[o + 1] = cy;
    out[o + 2] = radius * 1.02;
    out[o + 3] = 1;
    out[o + 4] = style.backing[0];
    out[o + 5] = style.backing[1];
    out[o + 6] = style.backing[2];
    out[o + 7] = 1;
    out[o + 8] = 0;
    out[o + 9] = 1;
    k++;
  }
  return k;
}
