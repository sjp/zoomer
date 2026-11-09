/**
 * Bamboo grove's model, kept free of GL so it can be tested: the seeded stem
 * layout per depth layer (with an optional clear opening in the centre), the
 * leaf clusters on the stems, the sway (the shared lagged swell from `sway.ts`
 * plus a gust field travelling sideways through the grove) and the light presets.
 *
 * Coordinates: x is a fraction of the frame width, y a fraction of the frame
 * height from the top. Sizes in px are at 1080p (multiply by `Viewport.scale`).
 * Each stem is a bending beam rooted at `ground` (often below the frame) with a
 * virtual length `length` (heights); height along it is `t = (ground - y) / length`.
 */
import type { Rgb } from "../color";
import { glslFloat } from "../gl";
import { clamp, fract } from "../math";
import { createRng } from "../noise";
import { createSwell, swayAt, type Swell } from "../sway";
import { ribbonStrip } from "../sprites";

const TAU = Math.PI * 2;

/** The grove's swell: a 12 s main period, a 15 s partner and a faint 6.7 s ripple, repeating every 60 s at speed 1. */
export const BAMBOO_SWELL: Swell = createSwell(60, [
  { cycles: 5, amplitude: 1, offset: 0 },
  { cycles: 4, amplitude: 0.6, offset: 0.29 },
  { cycles: 9, amplitude: 0.2, offset: 0.63 },
]);

/** Largest sway at the top of a stem (t = 1), heights, at wind 1 before the layer's scale. */
export const SWAY_MAX = 0.12;
/** Seconds the top of a stem (t = 1) trails its base. */
const LAG = 1.8;
/** Seconds the swell takes to travel across the frame, so neighbours don't move in lockstep. */
const SWELL_TRAVEL = 2.5;
/** Share of the sway driven by gusts rather than the swell. */
const GUST_SHARE = 0.45;

/**
 * Gust waves: whole cycles per swell period (so the phase wraps seamlessly),
 * spatial waves across the frame width (the gust travels sideways, left to right)
 * and weight. Each wave is sharpened to a pulse; the sum is in [0, 1].
 */
const GUSTS = [
  { cycles: 4, waves: 0.55, offset: 0.1, weight: 0.65 },
  { cycles: 7, waves: 0.9, offset: 0.55, weight: 0.35 },
] as const;

/** Gust strength at `x` (fraction of the width) and swell `phase`, in [0, 1]. */
export function gustAt(x: number, phase: number): number {
  let g = 0;
  for (const w of GUSTS) {
    const a = 0.5 + 0.5 * Math.sin(TAU * fract(w.cycles * phase - w.waves * x + w.offset));
    g += w.weight * a * a * a;
  }
  return g;
}

/**
 * The sway driver of a stem at `x` with swell offset `stemPhase` (periods), read
 * `lag` seconds in the past: the swell mixed with the gust, in [-1, 1]. Gusts
 * only push one way (the wind blows left to right).
 */
export function swayDriver(phase: number, stemPhase: number, x: number, lag: number): number {
  const swell = swayAt(BAMBOO_SWELL, phase + stemPhase, lag);
  const gust = gustAt(x, phase - lag / BAMBOO_SWELL.period);
  return (1 - GUST_SHARE) * swell + GUST_SHARE * gust;
}

/**
 * Horizontal sway of a stem at height `t` (clamped to [0, 1]; 0 = root), in
 * heights: a bending beam, `amplitude * driver * t^2`, where the point at `t`
 * reads the driver `lag * t` seconds late. Zero at the root, bounded by
 * `amplitude t^2`, continuous in phase and t. The shader's twin is `stemSway`.
 */
export function stemSway(
  phase: number,
  stemPhase: number,
  x: number,
  lag: number,
  t: number,
  amplitude: number,
): number {
  const u = clamp(t, 0, 1);
  return amplitude * swayDriver(phase, stemPhase, x, lag * u) * u * u;
}

/** GLSL twins of `gustAt`, `swayDriver` and `stemSway`; needs `swayGlsl(BAMBOO_SWELL, "bamboo")`. */
export const BAMBOO_SWAY_GLSL = /* glsl */ `
float gustAt(float x, float phase) {
  float g = 0.0;
${GUSTS.map(
  (w) => `  {
    float a = 0.5 + 0.5 * sin(${glslFloat(TAU)} * fract(${glslFloat(w.cycles)} * phase - ${glslFloat(w.waves)} * x + ${glslFloat(w.offset)}));
    g += ${glslFloat(w.weight)} * a * a * a;
  }`,
).join("\n")}
  return g;
}
float swayDriver(float phase, float stemPhase, float x, float lag) {
  float swell = bambooAt(phase + stemPhase, lag);
  float gust = gustAt(x, phase - lag * ${glslFloat(1 / BAMBOO_SWELL.period)});
  return ${glslFloat(1 - GUST_SHARE)} * swell + ${glslFloat(GUST_SHARE)} * gust;
}
float stemSway(float phase, float stemPhase, float x, float lag, float t, float amplitude) {
  float u = clamp(t, 0.0, 1.0);
  return amplitude * swayDriver(phase, stemPhase, x, lag * u) * u * u;
}
`;

/** Swell speed at `wind` (0..1): gusty days move faster. */
export function swaySpeed(wind: number): number {
  return 0.6 + 0.8 * clamp(Number.isFinite(wind) ? wind : 0, 0, 1);
}

// ---- Stems ----

/** Segments per stem strip, and the strip itself: (level, side) per vertex. */
export const SEGMENTS = 16;
export const STEM_STRIP: readonly number[] = ribbonStrip(SEGMENTS);
/** Strips run from just below the frame to just above it. */
export const STRIP_BOTTOM = 1.03;
export const STRIP_TOP = -0.04;

interface BambooLayer {
  /** Stems at density 1. */
  readonly count: number;
  /** Root y range (fraction of the height; below 1 is inside the frame) and virtual length (heights). */
  readonly ground: number;
  readonly length: number;
  /** Stem half width range, px at 1080p. */
  readonly widthMin: number;
  readonly widthMax: number;
  /** Node spacing range, heights. */
  readonly nodeMin: number;
  readonly nodeMax: number;
  /** Haze over the stems, 0..1 (scaled by the light's mist). */
  readonly fog: number;
  /** Edge softness, px at 1080p. */
  readonly blur: number;
  /** Sway multiplier: far stems move less on screen. */
  readonly sway: number;
  /** Back-lit rim strength. */
  readonly rim: number;
  /** Leaf clusters per stem (min, max) and leaf size relative to the nearest layer. */
  readonly clustersMin: number;
  readonly clustersMax: number;
  readonly leafScale: number;
}

/** Far to near. */
export const LAYERS: readonly BambooLayer[] = [
  {
    count: 18,
    ground: 0.8,
    length: 0.95,
    widthMin: 3,
    widthMax: 6,
    nodeMin: 0.055,
    nodeMax: 0.075,
    fog: 0.72,
    blur: 2.5,
    sway: 0.45,
    rim: 0.2,
    clustersMin: 1,
    clustersMax: 2,
    leafScale: 0.25,
  },
  {
    count: 13,
    ground: 0.9,
    length: 1.15,
    widthMin: 8,
    widthMax: 13,
    nodeMin: 0.09,
    nodeMax: 0.12,
    fog: 0.46,
    blur: 1.7,
    sway: 0.65,
    rim: 0.45,
    clustersMin: 1,
    clustersMax: 2,
    leafScale: 0.45,
  },
  {
    count: 8,
    ground: 1.04,
    length: 1.4,
    widthMin: 15,
    widthMax: 23,
    nodeMin: 0.15,
    nodeMax: 0.2,
    fog: 0.22,
    blur: 1.2,
    sway: 0.85,
    rim: 0.75,
    clustersMin: 1,
    clustersMax: 3,
    leafScale: 0.7,
  },
  {
    count: 4,
    ground: 1.18,
    length: 1.75,
    widthMin: 28,
    widthMax: 40,
    nodeMin: 0.24,
    nodeMax: 0.3,
    fog: 0.05,
    blur: 1,
    sway: 1,
    rim: 1,
    clustersMin: 1,
    clustersMax: 2,
    leafScale: 1,
  },
];

const DENSITY_MIN = 0.3;
export const DENSITY_MAX = 2;
export const MAX_STEMS = LAYERS.reduce((n, l) => n + Math.round(l.count * DENSITY_MAX), 0);

/** Floats per stem instance: (x, ground, length, half width), (phase, lag, sway, tone), (node spacing, node offset, fog, blur), (rim). */
export const STEM_ATTRIBUTES = [4, 4, 4, 1] as const;
export const STEM_FLOATS = STEM_ATTRIBUTES.reduce((a, b) => a + b, 0);

/** Stem centres stay this far inside the frame (fraction of the width). */
export const X_MARGIN = 0.005;
/** Half width of the clear centre opening, fraction of the width. */
export const OPENING_HALF = 0.15;
/** The aspect the opening is laid out for: px widths convert to width fractions at 16:9. */
export const REFERENCE_ASPECT = 16 / 9;

export type OpeningId = "centre" | "none";

/** Stems in a layer at `density` (clamped); at least 1. */
export function layerCount(layer: BambooLayer, density: number): number {
  const d = clamp(Number.isFinite(density) ? density : 1, DENSITY_MIN, DENSITY_MAX);
  return Math.max(1, Math.round(layer.count * d));
}

/**
 * Largest sideways reach of a stem in the frame, heights: its sway at the top of
 * its strip at wind 1, for a stem rooted at `ground` with `length` and sway
 * multiplier `sway` (the sway driver is within [-1, 1]).
 */
function maxReach(ground: number, length: number, sway: number): number {
  const t = clamp((ground - STRIP_TOP) / length, 0, 1);
  return SWAY_MAX * sway * t * t;
}

/**
 * Half the band (fraction of the width) a stem of `halfWidth` px can cover at the
 * reference aspect, swaying at full wind: its half width (with the node bulge)
 * plus its reach.
 */
export function stemClearance(
  ground: number,
  length: number,
  sway: number,
  halfWidth: number,
): number {
  return ((halfWidth * 1.08) / 1080 + maxReach(ground, length, sway)) / REFERENCE_ASPECT;
}

/** Relative stem density at `x`: highest at the edges. */
function edgeWeight(x: number): number {
  return 0.25 + 0.75 * Math.abs(2 * x - 1);
}

export interface StemLayout {
  /** Stems per layer and the index each layer starts at (far layers first). */
  readonly counts: readonly number[];
  readonly starts: readonly number[];
  readonly total: number;
}

/**
 * Fills `out` (`STEM_FLOATS` per stem, layer by layer, far first, thin to wide
 * within a layer) with a seeded layout at `density`. Rejection sampling keeps
 * stems towards the edges and, with the "centre" opening, keeps every stem's
 * whole swaying band out of the central `OPENING_HALF`. Deterministic per
 * (seed, density, opening).
 */
export function buildStems(
  seed: number,
  density: number,
  opening: OpeningId,
  out: Float32Array,
): StemLayout {
  const counts: number[] = [];
  const starts: number[] = [];
  const order: number[] = [];
  const tmp = new Float32Array(STEM_FLOATS);
  let n = 0;
  for (let l = 0; l < LAYERS.length; l++) {
    const layer = LAYERS[l];
    const rng = createRng(Math.floor(seed) * 7919 + l * 104729 + 96);
    const want = Math.max(
      0,
      Math.min(layerCount(layer, density), Math.floor(out.length / STEM_FLOATS) - n),
    );
    starts.push(n);
    counts.push(want);
    for (let k = 0; k < want; k++) {
      const hw = layer.widthMin + (layer.widthMax - layer.widthMin) * rng();
      const ground = layer.ground + 0.03 * (rng() - 0.5);
      const length = layer.length * (0.92 + 0.16 * rng());
      const sway = layer.sway * (0.85 + 0.3 * rng());
      const clear =
        opening === "centre" ? OPENING_HALF + stemClearance(ground, length, sway, hw) : 0;
      // Rejection sampling; the fallback is a spot near an edge, which is always clear.
      let x = -1;
      for (let tries = 0; tries < 64 && x < 0; tries++) {
        const c = X_MARGIN + (1 - 2 * X_MARGIN) * rng();
        if (Math.abs(c - 0.5) >= clear && rng() < edgeWeight(c)) {
          x = c;
        }
      }
      if (x < 0) {
        const e = X_MARGIN + 0.08 * rng();
        x = rng() < 0.5 ? e : 1 - e;
      }
      const o = (n + k) * STEM_FLOATS;
      out[o] = x;
      out[o + 1] = ground;
      out[o + 2] = length;
      out[o + 3] = hw;
      out[o + 4] = (x * SWELL_TRAVEL + 0.35 * rng()) / BAMBOO_SWELL.period;
      out[o + 5] = LAG * (0.85 + 0.3 * rng());
      out[o + 6] = sway;
      out[o + 7] = rng();
      out[o + 8] = layer.nodeMin + (layer.nodeMax - layer.nodeMin) * rng();
      out[o + 9] = rng();
      out[o + 10] = layer.fog;
      out[o + 11] = layer.blur;
      out[o + 12] = layer.rim;
    }
    // Thin (further) stems first within the layer, so it draws far to near.
    order.length = 0;
    for (let k = 0; k < want; k++) {
      order.push(k);
    }
    const first = n;
    order.sort((a, b) => out[(first + a) * STEM_FLOATS + 3] - out[(first + b) * STEM_FLOATS + 3]);
    const block = out.slice(n * STEM_FLOATS, (n + want) * STEM_FLOATS);
    for (let k = 0; k < want; k++) {
      tmp.set(block.subarray(order[k] * STEM_FLOATS, (order[k] + 1) * STEM_FLOATS));
      out.set(tmp, (n + k) * STEM_FLOATS);
    }
    n += want;
  }
  return { counts, starts, total: n };
}

// ---- Leaves ----

/** Clusters: one twig plus this many leaves. */
const LEAVES_MIN = 4;
const LEAVES_MAX = 7;
/** Cluster heights in the frame (fraction of the height from the top). */
export const CLUSTER_TOP = -0.04;
const CLUSTER_BOTTOM = 0.48;
export const MAX_LEAVES = LAYERS.reduce(
  (n, l) => n + Math.round(l.count * DENSITY_MAX) * l.clustersMax * (LEAVES_MAX + 1),
  0,
);
/**
 * Floats per leaf instance: the stem's (x, ground, length, attach y), its (phase,
 * lag, sway) plus the twig's x offset (px at 1080p), the twig's y offset (px),
 * leaf angle (radians, 0 = pointing right, y down), length (px) and half width
 * (px), and (flutter phase, flutter cycles per swell period, tone, kind: 0 leaf,
 * 1 twig).
 */
export const LEAF_ATTRIBUTES = [4, 4, 4, 4] as const;
export const LEAF_FLOATS = LEAF_ATTRIBUTES.reduce((a, b) => a + b, 0);
/** Flutter cycles per swell period (whole, so the phase wraps seamlessly): 0.4 to 0.8 Hz. */
export const FLUTTER_MIN = 24;
export const FLUTTER_MAX = 48;

export interface LeafLayout {
  /** Leaf instances per layer and the index each layer starts at (far first). */
  readonly counts: readonly number[];
  readonly starts: readonly number[];
  readonly total: number;
}

/**
 * Fills `out` with leaf clusters on the stems in `stems` (as laid out by
 * `buildStems`): per cluster a twig angled up and out from the stem, and a fan
 * of narrow leaves drooping from its end. Clusters sit in the upper part of the
 * frame, above each stem's root. Deterministic per (seed, layout).
 */
export function buildLeaves(
  seed: number,
  stems: Float32Array,
  layout: StemLayout,
  out: Float32Array,
): LeafLayout {
  const counts: number[] = [];
  const starts: number[] = [];
  const cap = Math.floor(out.length / LEAF_FLOATS);
  const rng = createRng(Math.floor(seed) * 31337 + 960);
  let n = 0;
  for (let l = 0; l < LAYERS.length; l++) {
    const layer = LAYERS[l];
    starts.push(n);
    const s = layer.leafScale;
    for (let k = 0; k < layout.counts[l]; k++) {
      const so = (layout.starts[l] + k) * STEM_FLOATS;
      const x = stems[so];
      const ground = stems[so + 1];
      const bottom = Math.min(CLUSTER_BOTTOM, ground - 0.15);
      const clusters =
        layer.clustersMin + Math.floor(rng() * (layer.clustersMax - layer.clustersMin + 1));
      for (let c = 0; c < clusters; c++) {
        const leaves = LEAVES_MIN + Math.floor(rng() * (LEAVES_MAX - LEAVES_MIN + 1));
        if (n + leaves + 1 > cap) {
          break;
        }
        const attach = CLUSTER_TOP + (bottom - CLUSTER_TOP) * ((c + rng()) / clusters);
        // Twigs mostly reach towards the frame's edge, away from the opening.
        const side = rng() < (x < 0.5 ? 0.3 : 0.7) ? 1 : -1;
        const twigAngle = -(0.35 + 0.45 * rng());
        const twigLen = s * (30 + 30 * rng());
        const tx = side * Math.cos(twigAngle) * twigLen;
        const ty = Math.sin(twigAngle) * twigLen;
        const tone = rng();
        const write = (
          index: number,
          dx: number,
          dy: number,
          angle: number,
          len: number,
          hw: number,
          kind: number,
        ) => {
          const o = index * LEAF_FLOATS;
          out[o] = x;
          out[o + 1] = ground;
          out[o + 2] = stems[so + 2];
          out[o + 3] = attach;
          out[o + 4] = stems[so + 4];
          out[o + 5] = stems[so + 5];
          out[o + 6] = stems[so + 6];
          out[o + 7] = dx;
          out[o + 8] = dy;
          out[o + 9] = angle;
          out[o + 10] = len;
          out[o + 11] = hw;
          out[o + 12] = rng();
          out[o + 13] = FLUTTER_MIN + Math.floor(rng() * (FLUTTER_MAX - FLUTTER_MIN + 1));
          out[o + 14] = clamp(tone + 0.25 * (rng() - 0.5), 0, 1);
          out[o + 15] = kind;
        };
        // The twig, from the stem to the fan.
        const twigDir = side > 0 ? twigAngle : Math.PI - twigAngle;
        write(n++, 0, 0, twigDir, twigLen, Math.max(0.6, 1.4 * s), 1);
        for (let i = 0; i < leaves; i++) {
          // Droop down and out from the twig's end, a few back over the stem.
          const dir = rng() < 0.8 ? side : -side;
          const droop = 0.25 + rng();
          const angle = dir > 0 ? droop : Math.PI - droop;
          const len = s * (55 + 35 * rng());
          write(n++, tx, ty, angle, len, len * (0.07 + 0.03 * rng()), 0);
        }
      }
    }
    counts.push(n - starts[l]);
  }
  return { counts, starts, total: n };
}

/** Flutter angle (radians) of a leaf at swell `phase`, scaled by `strength`. Periodic in phase. */
export function flutterAngle(
  phase: number,
  leafPhase: number,
  cycles: number,
  strength: number,
): number {
  return strength * Math.sin(TAU * fract(cycles * phase + leafPhase));
}

/** Leaf flutter amplitude (radians) at `wind` and gust `g`. */
export function flutterStrength(wind: number, g: number): number {
  return 0.04 + 0.22 * clamp(wind, 0, 1) * (0.5 + g);
}

// ---- Light ----

export type LightId = "morning" | "midday" | "misty";

interface BambooLight {
  /** Haze: top of the frame, middle, ground. */
  readonly top: Rgb;
  readonly mid: Rgb;
  readonly ground: Rgb;
  /** Back light colour, its centre (x fraction of the width, y of the height), radius (heights) and strength. */
  readonly light: Rgb;
  readonly lightX: number;
  readonly lightY: number;
  readonly radius: number;
  readonly glow: number;
  /** Light shafts' strength. */
  readonly shafts: number;
  /** Haze multiplier over the layers' fog. */
  readonly mist: number;
  /** Stem colours: fresh lime, deep olive, the pale node ring. */
  readonly lime: Rgb;
  readonly olive: Rgb;
  readonly ring: Rgb;
  /** Leaf colours: shaded and back-lit. */
  readonly leaf: Rgb;
  readonly leafLit: Rgb;
}

export const LIGHTS: Readonly<Record<LightId, BambooLight>> = {
  morning: {
    top: [0.62, 0.68, 0.38],
    mid: [0.3, 0.4, 0.2],
    ground: [0.08, 0.11, 0.05],
    light: [1, 0.86, 0.55],
    lightX: 0.5,
    lightY: 0.18,
    radius: 0.45,
    glow: 0.85,
    shafts: 0.8,
    mist: 1,
    lime: [0.42, 0.55, 0.14],
    olive: [0.14, 0.19, 0.06],
    ring: [0.72, 0.74, 0.5],
    leaf: [0.16, 0.26, 0.07],
    leafLit: [0.55, 0.68, 0.18],
  },
  midday: {
    top: [0.72, 0.84, 0.5],
    mid: [0.36, 0.52, 0.24],
    ground: [0.09, 0.14, 0.06],
    light: [0.96, 1, 0.82],
    lightX: 0.5,
    lightY: 0.02,
    radius: 0.5,
    glow: 0.7,
    shafts: 0.5,
    mist: 0.85,
    lime: [0.45, 0.62, 0.16],
    olive: [0.15, 0.22, 0.07],
    ring: [0.78, 0.82, 0.58],
    leaf: [0.17, 0.3, 0.08],
    leafLit: [0.55, 0.78, 0.2],
  },
  misty: {
    top: [0.7, 0.76, 0.66],
    mid: [0.46, 0.54, 0.44],
    ground: [0.2, 0.24, 0.17],
    light: [0.94, 0.96, 0.88],
    lightX: 0.5,
    lightY: 0.22,
    radius: 0.65,
    glow: 0.5,
    shafts: 0.35,
    mist: 1.3,
    lime: [0.36, 0.46, 0.16],
    olive: [0.14, 0.18, 0.08],
    ring: [0.68, 0.7, 0.56],
    leaf: [0.18, 0.25, 0.1],
    leafLit: [0.45, 0.56, 0.24],
  },
};
