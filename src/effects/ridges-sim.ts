/**
 * Pure JS parts of the misty ridges effect (ridges.ts): the palettes, the layer
 * layout, the periodic ridge-profile table, the fog density curve and the bird
 * flock. Nothing here touches GL, so it is all unit tested.
 *
 * Units: "height units", where the canvas is 1 tall and `aspect` wide, with y up
 * from the bottom edge (matching `gl_FragCoord / height`). Layer 0 is the nearest.
 */
import { hexToUnitRgb, type Rgb } from "./color";
import { clamp, wrap } from "./math";
import { createNoise, MAX_PERIOD, type Noise } from "./noise";
import { MIN_LAYERS, MAX_LAYERS } from "./ridges.meta";

/**
 * Width of one period of the ridge table, in height units: wider than any
 * common screen (16:9 is 1.78), so the pan can wrap without a visible repeat.
 */
export const SPAN = 4;
/** Columns per period. 2048 is the smallest MAX_TEXTURE_SIZE WebGL2 guarantees. */
export const COLUMNS = 2048;
/** Floats per layer and per fog band in the shader's uniform arrays. */
export const LAYER_FLOATS = 4;

/** Base line (lowest valley) of the nearest and farthest layers. */
const FRONT_BASE = 0.05;
const BACK_BASE = 0.42;
/** Peak height above the base line, nearest and farthest. */
const FRONT_AMP = 0.3;
const BACK_AMP = 0.15;
/** Typical distance between peaks, nearest and farthest. */
const FRONT_WAVELENGTH = 0.8;
const BACK_WAVELENGTH = 0.3;
const OCTAVES = 5;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

export interface RidgePalette {
  skyTop: Rgb;
  skyHorizon: Rgb;
  /** Fog, and what distant ridges fade into. */
  fog: Rgb;
  /** Nearest ridge. */
  ink: Rgb;
  /** Sun or moon disc. */
  sun: Rgb;
  /** Disc radius (height units). */
  sunRadius: number;
  /** Disc opacity through the haze. */
  sunStrength: number;
}

const palette = (
  skyTop: string,
  skyHorizon: string,
  fog: string,
  ink: string,
  sun: string,
  sunRadius: number,
  sunStrength: number,
): RidgePalette => ({
  skyTop: hexToUnitRgb(skyTop),
  skyHorizon: hexToUnitRgb(skyHorizon),
  fog: hexToUnitRgb(fog),
  ink: hexToUnitRgb(ink),
  sun: hexToUnitRgb(sun),
  sunRadius,
  sunStrength,
});

export const PALETTES = {
  ink: palette("#d3d0c6", "#efece4", "#e9e6dd", "#202327", "#fbf8f0", 0.055, 0.55),
  blue: palette("#1f2c4a", "#7586aa", "#8798bb", "#101829", "#e6ecf7", 0.04, 0.8),
  jade: palette("#a4c3b4", "#e0ebe3", "#d4e4da", "#1b382f", "#f7fbf3", 0.055, 0.5),
  dawn: palette("#7c83ad", "#efc4ac", "#e4c1b7", "#2a2237", "#fff0da", 0.06, 0.7),
} as const satisfies Record<string, RidgePalette>;

export type PaletteId = keyof typeof PALETTES;

/** The palette for a select value; unknown values fall back to ink wash. */
export function paletteFor(id: string): RidgePalette {
  return Object.hasOwn(PALETTES, id) ? PALETTES[id as PaletteId] : PALETTES.ink;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** Clamps a `layers` param to a whole number of layers. */
export const layerCount = (layers: number) =>
  clamp(Math.round(Number.isFinite(layers) ? layers : MIN_LAYERS), MIN_LAYERS, MAX_LAYERS);

/** Layer `i` of `n` as a depth: 0 nearest, 1 farthest. */
export const layerDepth = (i: number, n: number) => (n > 1 ? i / (n - 1) : 0);

export interface LayerShape {
  /** Height of the layer's lowest valley. */
  base: number;
  /** Height of its highest peak above `base`. */
  amp: number;
  /** Typical peak spacing (height units). */
  wavelength: number;
  /** How far its colour has faded from ink toward the fog colour (0 nearest). */
  haze: number;
}

/** Shape of layer `i` (0 = nearest) of `n`: farther layers sit higher, lower and tighter. */
export function layerShape(i: number, n: number): LayerShape {
  const d = layerDepth(i, n);
  return {
    base: mix(FRONT_BASE, BACK_BASE, d ** 0.85),
    amp: mix(FRONT_AMP, BACK_AMP, d),
    wavelength: mix(FRONT_WAVELENGTH, BACK_WAVELENGTH, d),
    haze: i === 0 ? 0 : mix(0.3, 0.84, d ** 0.8),
  };
}

/**
 * Raw ridge value of a profile at `u` (fraction of the period), roughly 0..1:
 * `OCTAVES` of periodic gradient noise with `p0` lattice cells per period at the
 * first octave, each octave blended from plain fBm (`peaks` 0, rolling) to
 * squared ridged noise (`peaks` 1, sharp crests). Periodic in `u` with period 1.
 */
export function ridgeRaw(noise: Noise, u: number, p0: number, peaks: number): number {
  const k = clamp(peaks, 0, 1);
  const gain = 0.42 + 0.14 * k;
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let p = p0;
  for (let o = 0; o < OCTAVES && p <= MAX_PERIOD; o++) {
    const n = noise.periodic2(u * p, 0.37 + o * 17.3, p, MAX_PERIOD);
    const ridged = (1 - Math.abs(n)) ** 2;
    sum += amp * mix(0.5 + 0.5 * n, ridged, k);
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Lattice cells per period at a layer's first octave: whole, so the profile tiles. */
export const latticePeriod = (wavelength: number) =>
  clamp(Math.round(SPAN / wavelength), 1, MAX_PERIOD);

/**
 * Fills `out` (`MAX_LAYERS * COLUMNS` floats, row = layer, nearest first) with
 * `count` ridge profiles for `seed`: absolute heights, column c at u = c / COLUMNS
 * of the period (so the table wraps with REPEAT). Each row is normalised to fill
 * its layer's band [base, base + amp] exactly, then raised to a power that
 * narrows the peaks as `peaks` grows. Unused rows are zeroed. Deterministic.
 */
export function fillRidgeTable(
  out: Float32Array,
  count: number,
  seed: number,
  peaks: number,
): void {
  out.fill(0);
  const n = layerCount(count);
  const k = clamp(peaks, 0, 1);
  const power = 1 + 0.8 * k;
  for (let i = 0; i < n; i++) {
    const shape = layerShape(i, n);
    const noise = createNoise(Math.floor(seed) * 7919 + i * 104729 + 13);
    const p0 = latticePeriod(shape.wavelength);
    const row = i * COLUMNS;
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < COLUMNS; c++) {
      const v = ridgeRaw(noise, c / COLUMNS, p0, k);
      out[row + c] = v;
      lo = Math.min(lo, out[row + c]);
      hi = Math.max(hi, out[row + c]);
    }
    const inv = hi > lo ? 1 / (hi - lo) : 0;
    for (let c = 0; c < COLUMNS; c++) {
      // Clamped so a rounding error can never put a negative base under the fractional power (NaN).
      const t = clamp((out[row + c] - lo) * inv, 0, 1);
      out[row + c] = shape.base + shape.amp * t ** power;
    }
  }
}

/** Height of table row `layer` at x (height units, any value), linearly interpolated like the GPU. */
export function ridgeHeightAt(table: Float32Array, layer: number, x: number): number {
  const t = wrap(x / SPAN, 0, 1) * COLUMNS;
  const i = Math.floor(t);
  const j = (i + 1) % COLUMNS;
  const row = layer * COLUMNS;
  return table[row + i] + (table[row + j] - table[row + i]) * (t - i);
}

// ---------------------------------------------------------------------------
// Fog
// ---------------------------------------------------------------------------

/**
 * Fog density against `t`, the height above the band's floor in units of its
 * thickness: 1 at and below the floor (fog pools in the valleys), easing to 0 at
 * the top. Continuous with a continuous slope; the shader has the same curve.
 */
export function fogDensity(t: number): number {
  if (!(t > 0)) return 1;
  if (t >= 1) return 0;
  return 1 - t * t * (3 - 2 * t);
}

/** Fraction of a layer's relief the fog floor sits above its base line. */
export const FOG_FLOOR = 0.3;
/** Thickness of the farthest band, which fogs the sky over the last ridge. */
const BACK_FOG_THICKNESS = 0.14;
/**
 * Band thickness as a multiple of the gap to the next layer's floor. Below 2, so
 * no more than two bands' fading parts overlap any height.
 */
const FOG_OVERLAP = 1.4;

/**
 * Fills the static parts of the shader's per-layer and per-band uniforms for
 * `count` layers (`MAX_LAYERS * LAYER_FLOATS` each; unused entries zeroed):
 *
 * - layers: [x offset (per frame), table row v, haze, 0];
 * - bands: [fog floor height, 1 / thickness, noise u offset (per frame), noise v offset (per frame)].
 *
 * Band k lies over layer k, in front of every farther layer.
 */
export function fillLayout(layers: Float32Array, bands: Float32Array, count: number): void {
  layers.fill(0);
  bands.fill(0);
  const n = layerCount(count);
  const floor = (i: number) => {
    const s = layerShape(i, n);
    return s.base + s.amp * FOG_FLOOR;
  };
  for (let i = 0; i < n; i++) {
    const o = i * LAYER_FLOATS;
    layers[o + 1] = (i + 0.5) / MAX_LAYERS;
    layers[o + 2] = layerShape(i, n).haze;
    const f = floor(i);
    const thickness = i + 1 < n ? (floor(i + 1) - f) * FOG_OVERLAP : BACK_FOG_THICKNESS;
    bands[o] = f;
    bands[o + 1] = 1 / thickness;
  }
}

/** Pan speed of the nearest layer per unit of the `pan` param, height units per second. */
export const PAN_SPEED = 0.008;
/** Fog drift speed per unit of the `drift` param, height units per second. */
export const DRIFT_SPEED = 0.012;

/** Pan speed of layer `i` of `n` relative to the nearest: farther layers move less. */
export const parallax = (i: number, n: number) => mix(1, 0.15, layerDepth(i, n));

/**
 * Fog drift speed of band `i` of `n` relative to `DRIFT_SPEED`: nearer bands move
 * faster, and each differs a little so the bands slide past each other.
 */
export const bandSpeed = (i: number, n: number) =>
  (1.5 - 0.8 * layerDepth(i, n)) * (i % 2 === 0 ? 1 : 0.8);

// ---------------------------------------------------------------------------
// Birds
// ---------------------------------------------------------------------------

export const MAX_BIRDS = 7;
/** Floats per bird instance: centre x, centre y (px, y up), half-span (px), wing lift. */
export const BIRD_FLOATS = 4;
/** Half-span of a bird at 1080p, px. */
const BIRD_SPAN = 7;
/** Flight speed, height units per second. */
const BIRD_SPEED_MIN = 0.035;
const BIRD_SPEED_MAX = 0.055;
/** Wing beats per second. */
const BEAT_HZ = 2.2;
/** Seconds between one flock leaving and the next arriving. */
const WAIT_MIN = 18;
const WAIT_MAX = 45;
/** Margin past the screen edge where flocks start and end, height units. */
const EDGE = 0.06;

export interface Flock {
  /** Birds in the current flock; 0 between flocks. */
  count: number;
  /** Seconds until the next flock while `count` is 0. */
  wait: number;
  /** +1 flying right, -1 left. */
  dir: number;
  speed: number;
  /** Leader position, height units. */
  x: number;
  y: number;
  /** Formation offsets (behind the leader, and up), size, wing phase and glide phase per bird. */
  readonly back: Float64Array;
  readonly up: Float64Array;
  readonly size: Float64Array;
  readonly beat: Float64Array;
  readonly glide: Float64Array;
  /** Seconds since the flock appeared, unwrapped. */
  time: number;
}

export function createFlock(firstWait = 6): Flock {
  return {
    count: 0,
    wait: firstWait,
    dir: 1,
    speed: BIRD_SPEED_MIN,
    x: 0,
    y: 0,
    back: new Float64Array(MAX_BIRDS),
    up: new Float64Array(MAX_BIRDS),
    size: new Float64Array(MAX_BIRDS),
    beat: new Float64Array(MAX_BIRDS),
    glide: new Float64Array(MAX_BIRDS),
    time: 0,
  };
}

/** Sends in a loose V of 3..MAX_BIRDS birds from a random side, high in the sky. */
function launch(f: Flock, aspect: number, rand: () => number): void {
  f.count = 3 + Math.floor(rand() * (MAX_BIRDS - 2));
  f.dir = rand() < 0.5 ? 1 : -1;
  f.speed = mix(BIRD_SPEED_MIN, BIRD_SPEED_MAX, rand());
  f.x = f.dir > 0 ? -EDGE : aspect + EDGE;
  f.y = 0.7 + rand() * 0.18;
  f.time = 0;
  for (let b = 0; b < f.count; b++) {
    const rank = Math.ceil(b / 2);
    const side = b % 2 === 0 ? 1 : -1;
    f.back[b] = rank * (0.03 + rand() * 0.012);
    f.up[b] = side * rank * (0.016 + rand() * 0.008);
    f.size[b] = 0.8 + rand() * 0.4;
    f.beat[b] = rand();
    f.glide[b] = rand() * Math.PI * 2;
  }
}

/** Distance the last bird trails the leader, height units. */
const trail = (f: Flock) => {
  let max = 0;
  for (let b = 0; b < f.count; b++) max = Math.max(max, f.back[b]);
  return max;
};

/**
 * Advances the flock by `dt` seconds on a canvas `aspect` wide: counts down to
 * the next flock, flies the current one across, and retires it once its last
 * bird is past the far edge.
 */
export function stepFlock(f: Flock, dt: number, aspect: number, rand: () => number): void {
  if (f.count === 0) {
    f.wait -= dt;
    if (f.wait <= 0) launch(f, aspect, rand);
    return;
  }
  f.time += dt;
  f.x += f.dir * f.speed * dt;
  const tail = f.x - f.dir * trail(f);
  if ((f.dir > 0 && tail > aspect + EDGE) || (f.dir < 0 && tail < -EDGE)) {
    f.count = 0;
    f.wait = mix(WAIT_MIN, WAIT_MAX, rand());
  }
}

/**
 * Writes the flock's birds as instances into `out` (`BIRD_FLOATS` each) for a
 * canvas `height` px tall at `scale`, and returns how many. Wing lift beats
 * between raised and lowered, easing into short glides now and then.
 */
export function writeBirds(f: Flock, out: Float32Array, height: number, scale: number): number {
  for (let b = 0; b < f.count; b++) {
    const t = f.time;
    const glide = 0.5 + 0.5 * Math.sin(0.6 * t + f.glide[b]);
    const flap = Math.sin(Math.PI * 2 * (BEAT_HZ * t + f.beat[b]));
    const o = b * BIRD_FLOATS;
    out[o] = (f.x - f.dir * f.back[b]) * height;
    out[o + 1] = (f.y + f.up[b] + 0.004 * Math.sin(1.3 * t + f.glide[b])) * height;
    out[o + 2] = BIRD_SPAN * f.size[b] * scale;
    out[o + 3] = 0.25 + 0.45 * flap * (1 - 0.8 * glide);
  }
  return f.count;
}
