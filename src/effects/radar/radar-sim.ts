/**
 * Pure JS logic for the weather radar (radar.ts): the radar colour scale and its
 * soft quantisation, the storm-cell lifecycles, the sweep and front clocks, the
 * procedural terrain behind the "Coast", "Islands" and "Inland" maps, the made-up
 * place labels and the timestamp text. Nothing here touches GL.
 *
 * Coordinates are in "q" units: canvas pixels divided by the canvas height, origin
 * top-left, y down. So y runs 0..1 and x runs 0..aspect.
 */
import { hexToRgb } from "../color";
import { clamp, fract, smoothstep, wrap } from "../math";
import { createNoise, createRng, fbm2, hash32 } from "../noise";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Radar centre: x as a fraction of the width, y as a fraction of the height. */
const CENTRE_X = 0.24;
const CENTRE_Y = 0.55;
/** Radar range in q units (canvas heights); rain fades out past it. */
export const RANGE = 1.15;
/** Range rings inside the range circle (the circle itself is the last). */
export const RING_COUNT = 4;

/** Radar centre in q units for a canvas of this aspect, written into `out` as [x, y]. */
export function radarCentre(aspect: number, out: [number, number]): [number, number] {
  out[0] = CENTRE_X * aspect;
  out[1] = CENTRE_Y;
  return out;
}

// ---------------------------------------------------------------------------
// Wind, sweep and front clocks
// ---------------------------------------------------------------------------

/** Wind speed in q units per second at `speed` 1: a front crosses a 16:9 screen in a few minutes. */
export const WIND_SPEED = 0.016;
/** Unit wind direction in q space (towards the east-north-east; y is down). */
export const WIND_X = Math.cos(-0.28);
export const WIND_Y = Math.sin(-0.28);

/**
 * Seconds per turn of the sweep. The thin bright line's tip, at RANGE from the
 * centre, then moves about 9 px per frame at 1080p30, inside the codec limit
 * (MAX_FEATURE_PX_PER_FRAME in motion-limits.ts).
 */
export const SWEEP_PERIOD = 28;

/**
 * Advances the sweep angle (radians, clockwise on screen) by `dt` seconds,
 * wrapped to [0, 2 pi). The wrap subtracts exactly one turn, so the line's
 * direction never jumps.
 */
export function advanceSweep(angle: number, dt: number): number {
  return wrap(angle + (dt * TAU) / SWEEP_PERIOD, 0, TAU);
}

/** Front band: how far rain reaches ahead of the front line and trails behind it, in q units. */
export const FRONT_AHEAD = 0.12;
export const FRONT_BEHIND = 0.38;
/** Extra margin for the front's wiggle, in q units. */
const FRONT_WIGGLE = 0.2;

/**
 * The range of the along-wind coordinate s = dot(q, wind) that the canvas covers,
 * written into `out` as [min, max].
 */
export function windSpan(aspect: number, out: [number, number]): [number, number] {
  // Corners (0,0), (aspect,0), (0,1), (aspect,1).
  const a = aspect * WIND_X;
  const b = WIND_Y;
  out[0] = Math.min(0, a, b, a + b);
  out[1] = Math.max(0, a, b, a + b);
  return out;
}

/**
 * The front line's along-wind position for a total travel `travel` (q units,
 * unwrapped float64), over a canvas covering s in [sMin, sMax]. It runs from
 * where its rain is wholly upwind of the canvas to where it is wholly downwind,
 * then wraps, so the wrap is never on screen.
 */
export function frontPosition(travel: number, sMin: number, sMax: number): number {
  const lo = sMin - FRONT_AHEAD * 3 - FRONT_WIGGLE;
  const hi = sMax + FRONT_BEHIND * 3 + FRONT_WIGGLE;
  return wrap(lo + travel, lo, hi - lo);
}

// ---------------------------------------------------------------------------
// Storm cells
// ---------------------------------------------------------------------------

/** Storm cells alive at once (each slot respawns when its cell dies). */
export const MAX_CELLS = 10;
/** Cell lifetimes in weather seconds. */
const CELL_LIFE_MIN = 45;
const CELL_LIFE_MAX = 90;
/** Cell core radius in q units, and peak intensity. */
const CELL_RADIUS_MIN = 0.04;
const CELL_RADIUS_MAX = 0.09;
const CELL_PEAK_MIN = 0.65;
const CELL_PEAK_MAX = 1.15;

/** A cell's intensity envelope over its life, `age` in [0, 1]: 0 at birth and death, 1 mid-life. */
export function cellEnvelope(age: number): number {
  const s = Math.sin(Math.PI * clamp(age, 0, 1));
  return s * s;
}

/** A hash of (seed, slot, cycle, salt) to [0, 1). */
function cellRandom(seed: number, slot: number, cycle: number, salt: number): number {
  const h = hash32(hash32(hash32(seed * 977 + slot) + cycle) + salt);
  return h / 4294967296;
}

/**
 * Writes the storm cells at weather time `t` (seconds, unwrapped) into `out`, four
 * floats per cell: centre x and y (q units), radius, and intensity. Each slot runs
 * back-to-back lifetimes of its own length, offset in phase, each at a fresh
 * seeded position upwind of where it drifts. Allocates nothing.
 */
export function writeStormCells(out: Float32Array, t: number, seed: number, aspect: number): void {
  for (let i = 0; i < MAX_CELLS; i++) {
    const life = CELL_LIFE_MIN + (CELL_LIFE_MAX - CELL_LIFE_MIN) * cellRandom(seed, i, -1, 1);
    const phase = cellRandom(seed, i, -1, 2);
    const u = t / life + phase;
    const cycle = Math.floor(u);
    const age = u - cycle;
    const env = cellEnvelope(age);
    const drift = life * WIND_SPEED;
    // Born so that the middle of the cell's path lands on the canvas.
    const x0 = (aspect + 0.3) * cellRandom(seed, i, cycle, 3) - 0.15 - 0.5 * drift * WIND_X;
    const y0 = 1.2 * cellRandom(seed, i, cycle, 4) - 0.1 - 0.5 * drift * WIND_Y;
    const travel = age * drift;
    const o = i * 4;
    out[o] = x0 + travel * WIND_X;
    out[o + 1] = y0 + travel * WIND_Y;
    const r = CELL_RADIUS_MIN + (CELL_RADIUS_MAX - CELL_RADIUS_MIN) * cellRandom(seed, i, cycle, 5);
    out[o + 2] = r * (0.6 + 0.4 * env);
    out[o + 3] =
      env * (CELL_PEAK_MIN + (CELL_PEAK_MAX - CELL_PEAK_MIN) * cellRandom(seed, i, cycle, 6));
  }
}

// ---------------------------------------------------------------------------
// Colour scale
// ---------------------------------------------------------------------------

/** Intensity thresholds of the colour steps (light rain up to the heaviest cores). */
export const LEVEL_THRESHOLDS = [0.14, 0.28, 0.42, 0.56, 0.7, 0.84] as const;
export const LEVEL_COUNT = LEVEL_THRESHOLDS.length;
/** Half-width of each step's soft edge, in intensity. */
const LEVEL_EDGE = 0.012;

/**
 * The soft-quantised radar level of an intensity: 0 (no echo) up to LEVEL_COUNT,
 * flat on each step with a short smooth ramp at each threshold. Monotonic.
 */
export function rainLevel(intensity: number): number {
  let l = 0;
  for (let k = 0; k < LEVEL_COUNT; k++) {
    const t = LEVEL_THRESHOLDS[k];
    l += smoothstep(t - LEVEL_EDGE, t + LEVEL_EDGE, intensity);
  }
  return l;
}

interface RadarPalette {
  /** Step colours, light rain first. */
  steps: readonly string[];
  /** Step opacities over the map, light rain first. */
  alpha: readonly number[];
  sea: string;
  land: string;
  coast: string;
  grid: string;
  ring: string;
  text: string;
  sweep: string;
}

const BLUE_MAP = {
  sea: "#0a131d",
  land: "#18222a",
  coast: "#3d5260",
  grid: "#22303c",
  ring: "#4d6b7a",
  text: "#8ea2ae",
};

export const PALETTES: Record<string, RadarPalette> = {
  classic: {
    steps: ["#4fc85e", "#2a9d48", "#1b7136", "#ead34a", "#f0932f", "#e2413a"],
    alpha: [0.5, 0.68, 0.8, 0.86, 0.9, 0.92],
    ...BLUE_MAP,
    sweep: "#86f0a8",
  },
  muted: {
    steps: ["#6e9c78", "#558a64", "#406f52", "#c4b36e", "#c68b5d", "#b6625b"],
    alpha: [0.45, 0.6, 0.72, 0.8, 0.84, 0.86],
    ...BLUE_MAP,
    sweep: "#a9c4cc",
  },
  mono: {
    steps: ["#1d5527", "#2a7a37", "#3a9e49", "#58c262", "#86df8a", "#c8f7c8"],
    alpha: [0.6, 0.72, 0.82, 0.88, 0.92, 0.95],
    sea: "#020805",
    land: "#08140b",
    coast: "#1f5229",
    grid: "#0f2a15",
    ring: "#2d7a3c",
    text: "#58b468",
    sweep: "#5cff7a",
  },
};

/** Entries in the colour-scale lookup texture, indexed by intensity 0..1. */
export const SCALE_SIZE = 256;

/**
 * Fills `out` (SCALE_SIZE RGBA8 texels) with the palette's colour scale: entry j
 * is the colour and opacity of intensity j / (SCALE_SIZE - 1), blended across each
 * step's soft edge. Below the first step it is transparent (with the first step's
 * colour, so filtering never darkens the edge).
 */
export function buildColourScale(palette: RadarPalette, out: Uint8Array): Uint8Array {
  const steps = palette.steps.map(hexToRgb);
  for (let j = 0; j < SCALE_SIZE; j++) {
    const l = rainLevel(j / (SCALE_SIZE - 1));
    // Level l in [k, k + 1] blends step k - 1 (or nothing, for k = 0) into step k.
    const k = Math.min(LEVEL_COUNT - 1, Math.floor(l));
    const t = Math.min(1, l - k);
    const a = steps[Math.max(0, k - 1)];
    const b = steps[k];
    const ca = k === 0 ? 1 : t;
    const alo = k === 0 ? 0 : palette.alpha[k - 1];
    const o = j * 4;
    for (let c = 0; c < 3; c++) {
      out[o + c] = Math.round(a[c] + (b[c] - a[c]) * ca);
    }
    out[o + 3] = Math.round(255 * (alo + (palette.alpha[k] - alo) * t));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

export type TerrainRegion = "coast" | "islands" | "inland";

/** The terrain field covers x in [0, TERRAIN_SPAN] and y in [0, 1], in q units. */
export const TERRAIN_SPAN = 2.4;
export const TERRAIN_ROWS = 128;
export const TERRAIN_COLS = Math.round(TERRAIN_SPAN * TERRAIN_ROWS);

/**
 * Builds the height field for a procedural region into `out` (TERRAIN_COLS x
 * TERRAIN_ROWS floats, row 0 at the top): positive on land, negative on water,
 * roughly in [-1, 1]. Deterministic per region and seed.
 */
export function buildTerrain(region: TerrainRegion, seed: number, out: Float32Array): Float32Array {
  const noise = createNoise(seed * 7 + 3);
  const noiseB = createNoise(seed * 7 + 5);
  for (let r = 0; r < TERRAIN_ROWS; r++) {
    const y = (r + 0.5) / TERRAIN_ROWS;
    for (let c = 0; c < TERRAIN_COLS; c++) {
      const x = (c + 0.5) / TERRAIN_ROWS;
      const n = fbm2(noise, x * 1.7, y * 1.7, 5);
      let h: number;
      if (region === "coast") {
        // Land to the west (where the radar sits), sea to the east, with headlands and islets.
        h = 0.8 * (1.15 - x + 0.3 * (y - 0.5)) + 0.75 * n;
      } else if (region === "islands") {
        h = 0.9 * fbm2(noise, x * 2.3, y * 2.3, 5) + 0.35 * fbm2(noiseB, x * 0.6, y * 0.6, 2) - 0.2;
      } else {
        // All land, with a few lakes and a river or two.
        const lakes = n + 0.42;
        const river = (Math.abs(fbm2(noiseB, x * 0.8, y * 0.8, 3)) - 0.018) * 8;
        h = Math.min(lakes, river);
      }
      out[r * TERRAIN_COLS + c] = h;
    }
  }
  return out;
}

/** Bilinear sample of a terrain field at q-space (x, y), clamped to its edges like the GPU's. */
export function sampleTerrain(terrain: Float32Array, x: number, y: number): number {
  const fx = clamp(x * TERRAIN_ROWS - 0.5, 0, TERRAIN_COLS - 1);
  const fy = clamp(y * TERRAIN_ROWS - 0.5, 0, TERRAIN_ROWS - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(TERRAIN_COLS - 1, x0 + 1);
  const y1 = Math.min(TERRAIN_ROWS - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = terrain[y0 * TERRAIN_COLS + x0];
  const b = terrain[y0 * TERRAIN_COLS + x1];
  const c = terrain[y1 * TERRAIN_COLS + x0];
  const d = terrain[y1 * TERRAIN_COLS + x1];
  return a + (b - a) * tx + (c - a + (d - c - (b - a)) * tx) * ty;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Made-up place names. */
export const PLACE_NAMES = [
  "Ashwick",
  "Brannoch",
  "Corrow Point",
  "Dunmere",
  "Eskerby",
  "Fallowgate",
  "Glenhallow",
  "Harrowmoor",
  "Iverholt",
  "Kelsmouth",
  "Lowmarsh",
  "Merrowby",
  "Northcastle",
  "Pellridge",
  "Quarley",
  "Ravensholm",
  "Saltcombe",
  "Thornwick",
  "Upper Wyle",
  "Westfold",
] as const;

interface PlaceLabel {
  name: string;
  /** Marker position in q units. */
  x: number;
  y: number;
}

/** Labels per map. */
export const LABEL_COUNT = 5;
/** Height above sea level (terrain units) a label marker needs: well inland of the coast. */
export const LABEL_MIN_HEIGHT = 0.08;
/** Room right of the marker for the name, and the least spacing between markers, in q units. */
export const LABEL_WIDTH = 0.22;
const LABEL_SPACING = 0.2;

/** Whether q-space x is in the middle third of the canvas, where the speaker sits. */
export const inSpeakerZone = (x: number, aspect: number) =>
  x > aspect / 3 - 0.04 && x < (2 * aspect) / 3 + 0.04;

/**
 * Chooses up to LABEL_COUNT made-up places on land, deterministically per seed:
 * clear of the middle third (where the speaker sits), the radar centre, the
 * timestamp corner (top right) and each other, with room for the name on the right.
 */
export function placeLabels(terrain: Float32Array, aspect: number, seed: number): PlaceLabel[] {
  const rng = createRng(seed * 31 + 11);
  const names: string[] = [...PLACE_NAMES];
  const labels: PlaceLabel[] = [];
  const cx = CENTRE_X * aspect;
  for (let tries = 0; tries < 400 && labels.length < LABEL_COUNT; tries++) {
    const x = 0.05 + rng() * Math.max(0, aspect - LABEL_WIDTH - 0.1);
    const y = 0.08 + rng() * 0.84;
    if (inSpeakerZone(x, aspect) || inSpeakerZone(x + LABEL_WIDTH, aspect)) {
      continue;
    }
    if (x + LABEL_WIDTH > aspect - 0.4 && y < 0.12) {
      continue;
    }
    if (Math.hypot(x - cx, y - CENTRE_Y) < 0.12) {
      continue;
    }
    if (sampleTerrain(terrain, x, y) < LABEL_MIN_HEIGHT) {
      continue;
    }
    let clear = true;
    for (const l of labels) {
      if (Math.abs(l.y - y) < 0.06 && Math.abs(l.x - x) < LABEL_WIDTH + 0.02) {
        clear = false;
      }
      if (Math.hypot(l.x - x, l.y - y) < LABEL_SPACING) {
        clear = false;
      }
    }
    if (!clear) {
      continue;
    }
    const pick = Math.floor(rng() * names.length);
    labels.push({ name: names[pick], x, y });
    names.splice(pick, 1);
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const pad2 = (n: number) => (n < 10 ? `0${String(n)}` : String(n));

/** The timestamp text for a local date, e.g. "TUE 03 NOV  14:05". */
export function formatStamp(date: Date): string {
  return `${DAYS[date.getDay()]} ${pad2(date.getDate())} ${MONTHS[date.getMonth()]}  ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Noise drift
// ---------------------------------------------------------------------------

/** The rain noise tile spans this many q units; its octaves have these lattice periods. */
export const NOISE_TILE = 3;
export const NOISE_PERIODS = [4, 8, 16, 32] as const;
/**
 * Drift speed relative to the wind of each octave, then of the slow coverage
 * field that makes rain areas grow and decay, so the pattern evolves as it moves.
 */
const OCTAVE_DRIFT = [1, 1.12, 0.9, 1.25, 0.55] as const;
/** Sideways drift of each, as a fraction of the wind speed. */
const OCTAVE_SIDE = [0.06, -0.1, 0.14, -0.05, 0.25] as const;
/** Offset pairs: one per octave plus the coverage field. */
export const OFFSET_PAIRS = OCTAVE_DRIFT.length;

/**
 * Advances the noise offsets (texture units, OFFSET_PAIRS pairs, each in [0, 1))
 * by `d` q units of wind travel. The tile repeats every texture unit, so wrapping
 * each offset is seamless.
 */
export function advanceOffsets(offsets: Float32Array | number[], d: number): void {
  const k = d / NOISE_TILE;
  for (let i = 0; i < OFFSET_PAIRS; i++) {
    const along = k * OCTAVE_DRIFT[i];
    const side = k * OCTAVE_SIDE[i];
    offsets[i * 2] = fract(offsets[i * 2] + along * WIND_X - side * WIND_Y);
    offsets[i * 2 + 1] = fract(offsets[i * 2 + 1] + along * WIND_Y + side * WIND_X);
  }
}
