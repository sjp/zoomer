/**
 * Falling leaves' simulation and shapes, kept free of GL so they can be tested:
 * leaf and petal outlines as triangle strips, the pendulum flutter, the wind gust
 * curve, and three depth layers of pieces falling, tumbling and wrapping once
 * fully off-screen. Positions are in reference units (1 = 1080 device-independent
 * pixels).
 */
import type { Rgb } from "../color";
import { FADE_OUT, growLive, stepLife, trimLive } from "../fade";
import { clamp, smoothstep } from "../math";
import { createNoise, createRng, type Noise } from "../noise";

/** Reference fall speed in px/s at 1080p for the middle layer at a speed of 1. */
const FALL_PX = 55;
/** Reference horizontal drift in px/s at 1080p for a wind (or full gust) of 1. */
const WIND_PX = 110;
/** Reference sway amplitude in px at 1080p for the middle layer. */
const SWAY_PX = 38;
/** Seconds a piece takes to fade in when the count is raised. */
const FADE_IN = 1.5;
/** Floats per piece instance: x, y, radius, opacity; r, g, b, softness; angle, flip. */
export const PIECE_FLOATS = 10;
const TAU = Math.PI * 2;

/**
 * Per depth layer (far, mid, near): size, fall pace, opacity, haze (how far the
 * colour fades towards the background), edge softness in radii (the far blur),
 * how much the wind moves it, and its share of the count.
 */
const LAYERS = [
  { size: 0.55, pace: 0.6, alpha: 0.75, haze: 0.45, soft: 0.35, wind: 0.6, share: 0.45 },
  { size: 1, pace: 0.85, alpha: 0.95, haze: 0.15, soft: 0.08, wind: 0.8, share: 0.35 },
  { size: 1.7, pace: 1.2, alpha: 1, haze: 0, soft: 0.03, wind: 1, share: 0.2 },
] as const;

// --- Shapes -----------------------------------------------------------------

/** Indices into `SHAPES`. */
export const SHAPE_OVAL = 0;
const SHAPE_MAPLE = 1;
export const SHAPE_PETAL = 2;
export const SHAPE_ROUND_PETAL = 3;

/** Rim points per outline. Multiples of 8 sample the maple's lobe tips exactly. */
export const OUTLINE_POINTS = 72;

/**
 * Turns a closed outline that is star-shaped about the origin (every ray from the
 * origin crosses it once) into one triangle strip: rim 0, centre, rim 1, centre,
 * ..., rim 0. Every other triangle is degenerate (two centre corners), and the
 * rest fan out from the centre without overlapping, so no fragment is shaded
 * twice. `2n + 1` vertices for `n` rim points. The centre is the only vertex at
 * the origin, which lets the vertex shader tell centre from rim.
 */
export function fanStrip(outline: readonly number[]): number[] {
  const n = outline.length / 2;
  const out = [outline[0], outline[1]];
  for (let k = 1; k <= n; k++) {
    const j = (k % n) * 2;
    out.push(0, 0, outline[j], outline[j + 1]);
  }
  return out;
}

/** Samples `r(θ)` at `OUTLINE_POINTS` angles from +x, scaled so the largest radius is 1. */
function polarOutline(r: (theta: number) => number): number[] {
  const radii: number[] = [];
  for (let k = 0; k < OUTLINE_POINTS; k++) {
    radii.push(r((k * TAU) / OUTLINE_POINTS));
  }
  const max = Math.max(...radii);
  const out: number[] = [];
  radii.forEach((radius, k) => {
    const a = (k * TAU) / OUTLINE_POINTS;
    out.push((Math.cos(a) * radius) / max, (Math.sin(a) * radius) / max);
  });
  return out;
}

/** Angular distance from `a` to `b`, in [0, π]. */
const angleTo = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** A thin stem spike pointing down the -y axis (the leaf's tip is at +y). */
const stem = (theta: number, length: number) =>
  length * Math.max(0, 1 - angleTo(theta, -Math.PI / 2) / 0.09);

/**
 * Outlines in unit space, tip towards +y, stem towards -y. Leaves and petals are
 * symmetric about the y axis, so a negative flip only mirrors them.
 */
export function leafOutline(shape: number): number[] {
  switch (shape) {
    case SHAPE_MAPLE: {
      // Five pointed lobes (top, two sides, two small lower ones) and a stem.
      const lobes = [
        [90, 1],
        [35, 0.82],
        [145, 0.82],
        [-20, 0.5],
        [200, 0.5],
      ].map(([deg, len]) => [(deg * Math.PI) / 180, len]);
      return polarOutline((t) => {
        let r = 0.3;
        for (const [a, len] of lobes) {
          const d = angleTo(t, a);
          r = Math.max(r, len * Math.pow(Math.max(0, 1 - d / 0.62), 1.4));
        }
        return Math.max(r, stem(t, 0.62));
      });
    }
    case SHAPE_PETAL: {
      // A teardrop narrowing to the base, with a notch at the tip.
      return polarOutline((t) => {
        const c = Math.cos(t);
        const s = Math.sin(t);
        const taper = 0.55 + 0.45 * (0.5 + 0.5 * s);
        const ellipse = 1 / Math.hypot(c / (0.62 * taper), s);
        const notch = 1 - 0.28 * Math.exp(-((angleTo(t, Math.PI / 2) / 0.16) ** 2));
        return ellipse * notch;
      });
    }
    case SHAPE_ROUND_PETAL: {
      // A rounder petal with a shallow notch.
      return polarOutline((t) => {
        const c = Math.cos(t);
        const s = Math.sin(t);
        const ellipse = 1 / Math.hypot(c / 0.8, s);
        const notch = 1 - 0.16 * Math.exp(-((angleTo(t, Math.PI / 2) / 0.2) ** 2));
        return ellipse * notch * (0.85 + 0.15 * (0.5 + 0.5 * s));
      });
    }
    default: {
      // A pointed oval leaf with a short stem.
      return polarOutline((t) => {
        const c = Math.cos(t);
        const s = Math.sin(t);
        const ellipse = 1 / Math.hypot(c / 0.4, s);
        // Pointed tips: the radius bulges a little towards the long axis.
        return Math.max(ellipse * (1 + 0.12 * Math.pow(Math.abs(s), 12)), stem(t, 1.15));
      });
    }
  }
}

/** The triangle strips for every shape, in `SHAPE_*` order. */
export const SHAPES: readonly (readonly number[])[] = [
  SHAPE_OVAL,
  SHAPE_MAPLE,
  SHAPE_PETAL,
  SHAPE_ROUND_PETAL,
].map((s) => fanStrip(leafOutline(s)));

// --- Seasons ----------------------------------------------------------------

export interface Season {
  /** Shapes (indices into `SHAPES`) the pieces are drawn from. */
  shapes: readonly number[];
  /** Whether the shapes have a midrib. */
  vein: boolean;
  /** Piece colours, 0..1. */
  palette: readonly Rgb[];
  /** Brightness of a piece's back face relative to its front. */
  backShade: number;
  /** Size and count relative to the params: blossom is smaller and more numerous. */
  sizeMul: number;
  countMul: number;
  /** Default background gradient (hex), used unless custom colours are on. */
  top: string;
  bottom: string;
  /** Out-of-focus foliage blob colours, 0..1. */
  foliage: readonly Rgb[];
}

const hex = (h: string): Rgb => {
  const n = Number.parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const SEASONS: Readonly<Record<string, Season>> = {
  autumn: {
    shapes: [SHAPE_OVAL, SHAPE_MAPLE],
    vein: true,
    palette: ["#b5301c", "#d65a24", "#e8912b", "#efbf45", "#8c4a26", "#a33a24"].map((v) => hex(v)),
    backShade: 0.78,
    sizeMul: 1,
    countMul: 1,
    top: "#f1d7ae",
    bottom: "#b9774a",
    foliage: ["#8f3b1a", "#c2682a", "#6b3a1c"].map((v) => hex(v)),
  },
  blossom: {
    shapes: [SHAPE_PETAL, SHAPE_ROUND_PETAL],
    vein: false,
    palette: ["#fbd5e0", "#f6b9cb", "#fde9ef", "#efa5bb", "#fff6f8"].map((v) => hex(v)),
    backShade: 0.93,
    sizeMul: 0.6,
    countMul: 1.5,
    top: "#a9cbe8",
    bottom: "#f3d9e2",
    foliage: ["#f2b6c8", "#e795ad", "#fbd9e3"].map((v) => hex(v)),
  },
};

// --- Motion -----------------------------------------------------------------

/**
 * Pendulum flutter at phase `psi`: the sideways offset in [-1, 1] (in sway
 * amplitudes). A swinging leaf spends longer at the ends of its arc.
 */
export const swayOffset = (psi: number) => Math.sin(psi);

/**
 * The tilt that goes with the swing, in [-1, 1] (scaled to radians by the caller):
 * the leaf leans into the direction it is moving, most at the bottom of the arc.
 */
export const swayTilt = (psi: number) => Math.cos(psi);

/**
 * Fall speed relative to the mean at phase `psi`, in [0.55, 1.45] with mean 1:
 * fastest through the bottom of the swing, slowest as it turns at either end.
 */
export const fallFactor = (psi: number) => {
  const c = Math.cos(psi);
  return 0.55 + 0.9 * c * c;
};

/**
 * The gust curve at `time` seconds, in [0, 1]: mostly calm, with a smooth gust
 * every few tens of seconds.
 */
export function gustAt(noise: Noise, time: number): number {
  const n = noise.noise2(time * 0.035, 0.5) * 0.75 + noise.noise2(time * 0.11, 7.3) * 0.25;
  const s = clamp(0.45 + 0.65 * n, 0, 1);
  return s * s;
}

// --- Simulation -------------------------------------------------------------

/** Per-frame inputs to `step`; reuse one object rather than allocating per frame. */
export interface PieceFrame {
  /** Screen width in reference px, and device px per reference px. */
  refWidth: number;
  scale: number;
  season: Season;
  /** Params: see leaves.ts. */
  count: number;
  size: number;
  speed: number;
  wind: number;
  gusts: number;
  /** Background colours at the top and bottom of the frame, for depth haze. */
  hazeTop: Rgb;
  hazeBottom: Rgb;
}

interface Pieces {
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly layer: Uint8Array;
  readonly life: Float32Array;
  /** 1 for a piece waiting for its `PieceOptions.spawn` call to succeed (never set without one). */
  readonly parked: Uint8Array;
  /** Pieces simulated: the count plus any still fading out after it dropped. */
  readonly live: number;
  /**
   * Draw groups from the last `step`, back to front: group `g` draws
   * `groupCount[g]` instances from `groupFirst[g]` with shape `groupShape[g]`.
   */
  readonly groups: number;
  readonly groupFirst: Int32Array;
  readonly groupCount: Int32Array;
  readonly groupShape: Int32Array;
  /** The latest gust strength, in [0, 1]. */
  readonly gust: number;
  /** Scales x positions by `k`, keeping pieces in place relative to a resized width. */
  rescaleX: (k: number) => void;
  /**
   * Advances `dt` seconds and writes the visible pieces to `data`, far layer
   * first, PIECE_FLOATS at `stride` floats apart. Returns how many.
   */
  step: (dt: number, f: PieceFrame, data: Float32Array, stride: number) => number;
}

/** A start position in reference units, written by a `PieceOptions.spawn` callback. */
export interface SpawnPoint {
  x: number;
  y: number;
}

interface PieceOptions {
  /**
   * Gives pieces a source. Called for a piece that needs a start: every piece at
   * first, and each one that falls off the bottom. Write a position (reference
   * units) to `out` and return true to start the piece there (drawn exactly at
   * that point, its sway included), or return false to park it: hidden and still
   * until a later step's call succeeds. Only pieces within the count are offered.
   * Without it, pieces start anywhere and respawn at random above the top.
   */
  spawn?: (out: SpawnPoint, layer: number) => boolean;
}

/** Wrap margin of a layer: its largest radius plus sway, so the jump is never visible. */
export const layerMargin = (layer: number, size: number) => {
  const L = LAYERS[layer];
  return (size * L.size * 1.3 + SWAY_PX * (0.4 + 0.6 * L.size)) * 1.2;
};

/** Most groups a step can produce: every layer times every shape of a season. */
const MAX_GROUPS = LAYERS.length * 4;

export function createPieces(
  max: number,
  initialWidth: number,
  seed = 0x1eaf,
  options: PieceOptions = {},
): Pieces {
  const rng = createRng(seed);
  const spawn = options.spawn;
  const point: SpawnPoint = { x: 0, y: 0 };
  // With a source, every piece waits for its first spawn.
  const parked = new Uint8Array(max).fill(spawn ? 1 : 0);
  const noise = createNoise(seed);

  const xs = new Float32Array(max);
  const ys = new Float32Array(max);
  const layer = new Uint8Array(max);
  const shapePick = new Float32Array(max);
  const colorPick = new Float32Array(max);
  const shade = new Float32Array(max);
  const sizeJitter = new Float32Array(max);
  const paceJitter = new Float32Array(max);
  const swayRate = new Float32Array(max);
  const swayPhase = new Float32Array(max);
  const swayAmp = new Float32Array(max);
  const spinRate = new Float32Array(max);
  const spinPhase = new Float32Array(max);
  const flipRate = new Float32Array(max);
  const flipPhase = new Float32Array(max);
  const life = new Float32Array(max);
  const groupFirst = new Int32Array(MAX_GROUPS);
  const groupCount = new Int32Array(MAX_GROUPS);
  const groupShape = new Int32Array(MAX_GROUPS);

  // Kept unwrapped (float64) so phases never jump.
  let time = 0;
  let live = 0;
  let groups = 0;
  let gust = 0;

  // Interleave layers by index so any count keeps the same proportions.
  const pattern: number[] = [];
  for (let l = 0; l < LAYERS.length; l++) {
    for (let k = 0; k < Math.round(LAYERS[l].share * 40); k++) {
      pattern.push(l);
    }
  }
  for (let i = pattern.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pattern[i], pattern[j]] = [pattern[j], pattern[i]];
  }

  for (let i = 0; i < max; i++) {
    layer[i] = pattern[i % pattern.length];
    xs[i] = rng() * initialWidth;
    ys[i] = rng() * 1080;
    shapePick[i] = rng();
    colorPick[i] = rng();
    shade[i] = 0.85 + rng() * 0.25;
    sizeJitter[i] = 0.75 + rng() * 0.5;
    paceJitter[i] = 0.8 + rng() * 0.4;
    // A slow pendulum: one swing every 2.5 to 6 seconds.
    swayRate[i] = TAU * (0.17 + rng() * 0.23);
    swayPhase[i] = rng() * TAU;
    swayAmp[i] = 0.6 + rng() * 0.6;
    spinRate[i] = (0.15 + rng() * 0.5) * (rng() < 0.5 ? -1 : 1);
    spinPhase[i] = rng() * TAU;
    flipRate[i] = 0.5 + rng() * 1.1;
    flipPhase[i] = rng() * TAU;
  }

  return {
    xs,
    ys,
    layer,
    life,
    parked,
    groupFirst,
    groupCount,
    groupShape,
    get live() {
      return live;
    },
    get groups() {
      return groups;
    },
    get gust() {
      return gust;
    },
    rescaleX(k) {
      for (let i = 0; i < max; i++) {
        xs[i] *= k;
      }
    },
    step(dt, f, data, stride) {
      time += dt;
      const { refWidth, scale, season } = f;
      const target = Math.min(Math.floor(f.count * season.countMul), max);
      const n = (live = growLive(life, live, target));
      const fadeStep = dt / FADE_IN;
      const outStep = dt / FADE_OUT;

      gust = gustAt(noise, time);
      // Gusts blow the way the mean wind does (rightwards in still air).
      const dir = f.wind < 0 ? -1 : 1;
      const windPx = (f.wind + dir * f.gusts * gust) * WIND_PX;
      const fallPx = f.speed * FALL_PX;
      const size = f.size * season.sizeMul;
      const shapes = season.shapes;
      const palette = season.palette;
      const top = f.hazeTop;
      const bottom = f.hazeBottom;
      // Gusts make the pieces flutter a little faster.
      const flutter = 1 + 0.5 * f.gusts * gust;

      let visible = 0;
      groups = 0;
      for (let l = 0; l < LAYERS.length; l++) {
        const L = LAYERS[l];
        const margin = layerMargin(l, size);
        const spanX = refWidth + margin * 2;
        const spanY = 1080 + margin * 2;
        const ampLayer = SWAY_PX * (0.4 + 0.6 * L.size);
        const vxLayer = windPx * L.wind;
        const radiusLayer = size * L.size * scale;

        for (let s = 0; s < shapes.length; s++) {
          const first = visible;
          for (let i = 0; i < n; i++) {
            if (layer[i] !== l || Math.floor(shapePick[i] * shapes.length) !== s) {
              continue;
            }

            const psi = swayPhase[i] + time * swayRate[i];
            const swayPx = swayOffset(psi) * ampLayer * swayAmp[i];
            let x: number;
            let y: number;
            if (parked[i]) {
              if (i >= target || spawn?.(point, l) !== true) {
                stepLife(life, i, target, fadeStep, outStep);
                continue;
              }
              // Start drawn exactly at the spawn point.
              parked[i] = 0;
              x = point.x - swayPx;
              y = point.y;
            } else {
              x = xs[i] + vxLayer * dt;
              y = ys[i] + fallPx * L.pace * paceJitter[i] * fallFactor(psi) * dt;
              if (x < -margin) {
                x += spanX;
              } else if (x > refWidth + margin) {
                x -= spanX;
              }
              if (y > 1080 + margin) {
                if (!spawn) {
                  // Respawn above the top at a new position across the padded width.
                  y -= spanY;
                  x = -margin + rng() * spanX;
                } else if (i < target && spawn(point, l)) {
                  x = point.x - swayPx;
                  y = point.y;
                } else {
                  parked[i] = 1;
                  stepLife(life, i, target, fadeStep, outStep);
                  continue;
                }
              } else if (y < -margin) {
                y += spanY;
              }
            }
            xs[i] = x;
            ys[i] = y;

            const life01 = stepLife(life, i, target, fadeStep, outStep);
            const alpha = L.alpha * life01 * life01;
            if (alpha <= 0.003) {
              continue;
            }

            // Tumbling: the flip narrows the piece as it turns edge-on, and its
            // shading follows how squarely it faces the light.
            const flipAngle = flipPhase[i] + time * flipRate[i] * flutter;
            const c = Math.cos(flipAngle);
            const facing = Math.abs(c);
            const flip = c < 0 ? Math.min(c, -0.06) : Math.max(c, 0.06);
            const light =
              (0.5 + 0.5 * facing + 0.15 * smoothstep(0.85, 1, facing)) *
              (c < 0 ? season.backShade : 1) *
              shade[i];
            const rgb = palette[Math.floor(colorPick[i] * palette.length)];
            const v = clamp(y / 1080, 0, 1);
            const haze = L.haze;
            const o = visible * stride;
            data[o] = (x + swayPx) * scale;
            data[o + 1] = y * scale;
            data[o + 2] = radiusLayer * sizeJitter[i];
            data[o + 3] = Math.min(1, alpha);
            for (let k = 0; k < 3; k++) {
              const lit = Math.min(1, rgb[k] * light);
              const h = top[k] + (bottom[k] - top[k]) * v;
              data[o + 4 + k] = lit + (h - lit) * haze;
            }
            data[o + 7] = L.soft;
            data[o + 8] = spinPhase[i] + time * spinRate[i] + 0.45 * swayTilt(psi);
            data[o + 9] = flip;
            visible++;
          }
          if (visible > first) {
            groupFirst[groups] = first;
            groupCount[groups] = visible - first;
            groupShape[groups] = shapes[s];
            groups++;
          }
        }
      }

      live = trimLive(life, live, target);
      return visible;
    },
  };
}

// --- Foliage ----------------------------------------------------------------

/** Floats per foliage blob instance: x, y, radius, opacity; r, g, b. */
export const BLOB_FLOATS = 7;

/**
 * Out-of-focus foliage blobs framing the speaker: side (0 = measured from the
 * left edge, 1 = from the right), x as a fraction of the width in from that
 * edge, y as a fraction of the height, radius in reference px, colour index.
 */
const BLOBS = [
  [0, 0.02, 0.08, 300, 0],
  [0, 0.1, -0.04, 240, 1],
  [0, -0.01, 0.42, 260, 2],
  [0, 0.04, 0.85, 220, 1],
  [1, 0.02, 0.1, 320, 2],
  [1, 0.12, -0.05, 230, 0],
  [1, 0, 0.5, 250, 1],
  [1, 0.05, 0.9, 210, 0],
  [0, 0.3, -0.12, 200, 1],
  [1, 0.3, -0.12, 190, 2],
] as const;
export const MAX_BLOBS = BLOBS.length;

/**
 * Writes the foliage blobs at `amount` (0..1) to `data`, swaying slowly with
 * `time` and leaning with the wind. Returns how many.
 */
export function writeFoliage(
  data: Float32Array,
  stride: number,
  time: number,
  amount: number,
  windLean: number,
  refWidth: number,
  scale: number,
  season: Season,
): number {
  if (!(amount > 0)) {
    return 0;
  }
  const colors = season.foliage;
  for (let b = 0; b < BLOBS.length; b++) {
    const [side, fx, fy, r, c] = BLOBS[b];
    const x0 = side === 1 ? refWidth * (1 - fx) : refWidth * fx;
    const sway = Math.sin(time * (0.11 + b * 0.013) + b * 1.7);
    const o = b * stride;
    data[o] = (x0 + sway * 14 + windLean * 18) * scale;
    data[o + 1] = (fy * 1080 + Math.cos(time * 0.09 + b) * 8) * scale;
    data[o + 2] = r * (0.8 + 0.2 * amount) * scale;
    data[o + 3] = Math.min(1, amount) * 0.7;
    const rgb = colors[c % colors.length];
    data[o + 4] = rgb[0];
    data[o + 5] = rgb[1];
    data[o + 6] = rgb[2];
  }
  return BLOBS.length;
}
