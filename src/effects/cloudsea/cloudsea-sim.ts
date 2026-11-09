/**
 * Pure JS parts of the sea of clouds (cloudsea.ts): the dawn palette and its
 * clock, the camera and sun geometry, the billow noise texture with its gradient
 * channels, the peak column table and the foreground ledge profile. Nothing here
 * touches GL, so it is all unit tested.
 *
 * Screen units are "height units": the canvas is 1 tall and `aspect` wide, y up
 * from the bottom edge. The world has x right, y up and z away from the viewer,
 * with the camera `CAM_HEIGHT` above the cloud plane, looking level.
 */
import { hexToUnitRgb, type Rgb } from "../color";
import { sampleSky, type SkyKey, type SkyState } from "../horizon/horizon-sim";
import { approach, clamp, fract, smoothstep } from "../math";
import { createNoise, createRng, fbmPeriodic2 } from "../noise";
import { MAX_PEAKS } from "./cloudsea.meta";
import { lookup } from "../lookup";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Dawn palette
// ---------------------------------------------------------------------------

/** A dawn keyframe: the horizon sky's colours plus the cloud sea's and the peaks'. */
interface DawnKey extends SkyKey {
  /** Band between the horizon and the zenith (the pink of the Belt of Venus). */
  mid: Rgb;
  /** Cloud troughs, in shadow. `light` is the sunlit tops. */
  shade: Rgb;
  /** Far cloud sea, fading into the horizon. */
  haze: Rgb;
  /** Rock in shadow. */
  rock: Rgb;
  /** Height of the sun's centre above the cloud line, height units. */
  sunY: number;
}

const key = (
  hour: number,
  c: {
    zenith: string;
    mid: string;
    horizon: string;
    glow: string;
    light: string;
    shade: string;
    haze: string;
    rock: string;
  },
  glowStrength: number,
  sunY: number,
): DawnKey => ({
  hour,
  zenith: hexToUnitRgb(c.zenith),
  mid: hexToUnitRgb(c.mid),
  horizon: hexToUnitRgb(c.horizon),
  glow: hexToUnitRgb(c.glow),
  light: hexToUnitRgb(c.light),
  shade: hexToUnitRgb(c.shade),
  haze: hexToUnitRgb(c.haze),
  rock: hexToUnitRgb(c.rock),
  glowStrength,
  sunY,
});

/** Hours of the fixed `timeOfDay` options; "Cycle" swings between the first and last. */
export const DAWN_HOURS = { predawn: 5.3, sunrise: 6, golden: 6.9 } as const;

/** The dawn, in increasing hour order from pre-dawn to golden light. */
export const DAWN_KEYS: readonly DawnKey[] = [
  key(
    DAWN_HOURS.predawn,
    {
      zenith: "#141c44",
      mid: "#5a4272",
      horizon: "#c98692",
      glow: "#e89a96",
      light: "#a68cb0",
      shade: "#353a63",
      haze: "#a98aa6",
      rock: "#1f2340",
    },
    0.3,
    -0.09,
  ),
  key(
    5.65,
    {
      zenith: "#1e2d62",
      mid: "#7d5888",
      horizon: "#eb9c8c",
      glow: "#ffac88",
      light: "#e2a8aa",
      shade: "#454a78",
      haze: "#d7a0a2",
      rock: "#272a4a",
    },
    0.6,
    -0.035,
  ),
  key(
    DAWN_HOURS.sunrise,
    {
      zenith: "#284684",
      mid: "#b87690",
      horizon: "#ffbc8a",
      glow: "#ffcc8c",
      light: "#ffcfa6",
      shade: "#575c8c",
      haze: "#f0bea6",
      rock: "#2f3154",
    },
    0.95,
    0.012,
  ),
  key(
    6.45,
    {
      zenith: "#335ea4",
      mid: "#cf9ca2",
      horizon: "#ffd49e",
      glow: "#ffe0a4",
      light: "#ffe0b6",
      shade: "#6a76a4",
      haze: "#f4d6be",
      rock: "#383c60",
    },
    0.8,
    0.06,
  ),
  key(
    DAWN_HOURS.golden,
    {
      zenith: "#3c70bc",
      mid: "#dcbcb0",
      horizon: "#ffe2ae",
      glow: "#fff0c6",
      light: "#ffefcf",
      shade: "#7f8db6",
      haze: "#f8e4cc",
      rock: "#41486c",
    },
    0.65,
    0.11,
  ),
];

export interface DawnState extends SkyState {
  mid: Rgb;
  shade: Rgb;
  haze: Rgb;
  rock: Rgb;
  sunY: number;
}

export const createDawnState = (): DawnState => ({
  zenith: [0, 0, 0],
  mid: [0, 0, 0],
  horizon: [0, 0, 0],
  glow: [0, 0, 0],
  light: [0, 0, 0],
  shade: [0, 0, 0],
  haze: [0, 0, 0],
  rock: [0, 0, 0],
  glowStrength: 0,
  sunY: 0,
});

const lerpInto = (out: Rgb, a: Rgb, b: Rgb, t: number) => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
};

/**
 * The dawn at `hour`, clamped to the keys' range, into `out`. The sky colours
 * come from `sampleSky` over the dawn keys; the extra cloud and rock colours ease
 * between the same keys with the same smoothstep. Allocates nothing.
 */
export function sampleDawn(hour: number, out: DawnState, keys: readonly DawnKey[] = DAWN_KEYS) {
  const h = clamp(hour, keys[0].hour, keys[keys.length - 1].hour);
  sampleSky(h / 24, out, keys);
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].hour <= h) {
    i++;
  }
  const a = keys[i];
  const b = keys[Math.min(i + 1, keys.length - 1)];
  const t = b.hour > a.hour ? smoothstep(0, 1, (h - a.hour) / (b.hour - a.hour)) : 0;
  lerpInto(out.mid, a.mid, b.mid, t);
  lerpInto(out.shade, a.shade, b.shade, t);
  lerpInto(out.haze, a.haze, b.haze, t);
  lerpInto(out.rock, a.rock, b.rock, t);
  out.sunY = a.sunY + (b.sunY - a.sunY) * t;
  return out;
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** Hours per second a fixed time of day eases toward a newly picked one. */
const HOUR_EASE = 0.5;

/**
 * Hour of the "Cycle" loop at `phase` (cycles; any number): pre-dawn at whole
 * numbers, golden at halves, easing in and out at both ends with a cosine. The
 * same at phases 0 and 1, so the loop has no seam.
 */
export function cycleHour(phase: number): number {
  const s = 0.5 - 0.5 * Math.cos(TAU * fract(phase));
  return DAWN_HOURS.predawn + (DAWN_HOURS.golden - DAWN_HOURS.predawn) * s;
}

/** The phase on the brightening half of the loop where `cycleHour` is `hour` (clamped). */
export function cyclePhaseFor(hour: number): number {
  const s = clamp((hour - DAWN_HOURS.predawn) / (DAWN_HOURS.golden - DAWN_HOURS.predawn), 0, 1);
  return Math.acos(1 - 2 * s) / TAU;
}

/** The fixed hour for a `timeOfDay` value; unknown values fall back to sunrise. */
export const fixedHour = (time: string): number => lookup(DAWN_HOURS, time, "sunrise");

interface DawnClock {
  readonly hour: number;
  /** Advances by `dt` seconds and returns the hour. */
  step: (dt: number, time: string, cycleMins: number) => number;
}

/**
 * The dawn clock. A fixed time of day eases toward its hour at `HOUR_EASE`, so
 * picking another one glides rather than jumps. "Cycle" picks up from the current
 * hour (on the brightening half) and loops; its phase stays unwrapped in float64.
 */
export function createDawnClock(initialHour: number = DAWN_HOURS.sunrise): DawnClock {
  let hour = initialHour;
  let phase = 0;
  let cycling = false;
  return {
    get hour() {
      return hour;
    },
    step(dt, time, cycleMins) {
      if (time === "cycle") {
        if (!cycling) {
          phase = cyclePhaseFor(hour);
        }
        cycling = true;
        phase += dt / (Math.max(cycleMins, 0.1) * 60);
        hour = cycleHour(phase);
      } else {
        cycling = false;
        hour = approach(hour, fixedHour(time), HOUR_EASE * Math.max(dt, 0));
      }
      return hour;
    },
  };
}

// ---------------------------------------------------------------------------
// Camera and sun
// ---------------------------------------------------------------------------

/** Focal length, height units: about a 45° vertical field of view. */
export const FOCAL = 1.2;
/** Camera height above the cloud plane, world units. */
export const CAM_HEIGHT = 1;
/** Sun centre across the frame (fraction of the width) and its disc radius (height units). */
export const SUN_X = 0.76;
export const SUN_RADIUS = 0.026;
/** Lowest elevation (direction y) the cloud shading's light takes, so tops stay modelled before sunrise. */
const MIN_LIGHT_Y = 0.05;

/**
 * World distance to the cloud plane seen at screen height `y` with the cloud line
 * (horizon) at `line`, both height units; Infinity at or above the line.
 */
export function planeDistance(y: number, line: number): number {
  const below = line - y;
  return below > 0 ? (FOCAL * CAM_HEIGHT) / below : Infinity;
}

/**
 * The light direction for the cloud shading, normalised, into `out`: toward the
 * sun at `SUN_X` across a canvas `aspect` wide, `sunY` above the cloud line, with
 * its elevation held at a small minimum.
 */
export function sunDirection(aspect: number, sunY: number, out: [number, number, number]) {
  const x = (SUN_X - 0.5) * aspect;
  const y = Math.max(sunY, MIN_LIGHT_Y * FOCAL);
  const len = Math.hypot(x, y, FOCAL);
  out[0] = x / len;
  out[1] = y / len;
  out[2] = FOCAL / len;
  return out;
}

// ---------------------------------------------------------------------------
// Billow texture
// ---------------------------------------------------------------------------

/** Lattice cells across the billow tile at its first octave. */
export const BILLOW_CELLS = 4;
const BILLOW_OCTAVES = 3;

interface BillowTexture {
  /** RGBA8 texels: height, d/du and d/dv, each mapped from -1..1 to 0..255; alpha 255. */
  data: Uint8Array;
  /** Decoded gradient times this is the gradient of the decoded height, per tile. */
  slopeScale: number;
}

/**
 * A seamlessly tiling `size`² RGBA8 texture of a three-octave periodic fBm height
 * field and its gradient, by central differences in float. Height and gradient
 * are each normalised to use the full byte range, so one fetch gives the height
 * and the normal of one octave of the cloud tops. Deterministic for a seed.
 */
export function buildBillowTexture(size: number, seed: number): BillowTexture {
  const noise = createNoise(seed);
  const height = (u: number, v: number) =>
    fbmPeriodic2(noise, u * BILLOW_CELLS, v * BILLOW_CELLS, BILLOW_CELLS, BILLOW_OCTAVES);
  const e = 0.25 / size;
  const n = size * size;
  const h = new Float32Array(n);
  const gu = new Float32Array(n);
  const gv = new Float32Array(n);
  let hMax = 1e-9;
  let gMax = 1e-9;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Texel centres, as a linearly filtered fetch sees them.
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const i = y * size + x;
      h[i] = height(u, v);
      gu[i] = (height(u + e, v) - height(u - e, v)) / (2 * e);
      gv[i] = (height(u, v + e) - height(u, v - e)) / (2 * e);
      hMax = Math.max(hMax, Math.abs(h[i]));
      gMax = Math.max(gMax, Math.abs(gu[i]), Math.abs(gv[i]));
    }
  }
  const byte = (t: number) => clamp(Math.round((0.5 + 0.5 * t) * 255), 0, 255);
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = byte(h[i] / hMax);
    data[i * 4 + 1] = byte(gu[i] / gMax);
    data[i * 4 + 2] = byte(gv[i] / gMax);
    data[i * 4 + 3] = 255;
  }
  return { data, slopeScale: gMax / hMax };
}

// ---------------------------------------------------------------------------
// Peaks
// ---------------------------------------------------------------------------

/** Columns of the peak table across the width. */
export const PEAK_COLUMNS = 512;
/** Floats per column: height above the cloud line, offset from the crest, haze, unused. */
export const PEAK_FLOATS = 4;
/** Height stored where there is no peak: just under the cloud line. */
export const NO_PEAK = -0.04;
/** The peaks stay out of [CENTRE_LO, CENTRE_HI] of the width, where the speaker sits. */
export const CENTRE_LO = 1 / 3;
export const CENTRE_HI = 2 / 3;
/** Where the side bands fade out, short of the centre third. */
const BAND_FADE = 0.06;

interface PeakSpec {
  /** Crest across the frame, fraction of the width. */
  x: number;
  /** Summit above the cloud line, height units. */
  height: number;
  /** Half-width of the base at the cloud line, left and right of the crest, height units. */
  left: number;
  right: number;
  /** How far the rock fades toward the sky (0 nearest). */
  haze: number;
  /** Seed of its rough skyline. */
  seed: number;
}

/** Clamps a `peaks` param to a whole number of peaks. */
export const peakCount = (peaks: number) =>
  clamp(Math.round(Number.isFinite(peaks) ? peaks : 0), 0, MAX_PEAKS);

/**
 * Lays out `count` peaks for `seed`, alternating sides from a random first side:
 * the first is the tallest and nearest, the rest smaller and hazier. Each side
 * holds two slots, the outer one near the edge. Crests stay inside the side bands.
 */
export function layoutPeaks(count: number, seed: number): PeakSpec[] {
  const rand = createRng(Math.floor(seed) * 7919 + 101);
  const first = rand() < 0.5 ? 0 : 1;
  const n = peakCount(count);
  const out: PeakSpec[] = [];
  for (let i = 0; i < n; i++) {
    const right = (first + i) % 2 === 1;
    const slot = Math.floor(i / 2);
    // Outer slot near the edge, inner slot toward the centre.
    const from = slot === 0 ? 0.06 : 0.17;
    const span = slot === 0 ? 0.08 : 0.07;
    const d = from + rand() * span;
    const height = i === 0 ? 0.17 + rand() * 0.06 : 0.07 + rand() * 0.07;
    const spread = 1.4 + rand() * 0.5;
    const skew = 0.8 + rand() * 0.4;
    out.push({
      x: right ? 1 - d : d,
      height,
      left: height * spread * skew,
      right: (height * spread) / skew,
      haze: i === 0 ? 0.12 + rand() * 0.08 : 0.32 + rand() * 0.25,
      seed: Math.floor(rand() * 1e6),
    });
  }
  return out;
}

/** 1 in the side bands, easing to 0 before the centre third. */
export function sideEnvelope(x: number): number {
  return Math.max(
    1 - smoothstep(CENTRE_LO - BAND_FADE, CENTRE_LO, x),
    smoothstep(CENTRE_HI, CENTRE_HI + BAND_FADE, x),
  );
}

/**
 * Fills `out` (`PEAK_COLUMNS * PEAK_FLOATS` floats) with the skyline of `peaks`
 * on a canvas `aspect` wide, column c at x = (c + 0.5) / PEAK_COLUMNS of the
 * width: per column the tallest peak's height above the cloud line (or
 * `NO_PEAK`), the offset from its crest (height units, + right) and its haze.
 * Each peak is a concave cone, roughened by two octaves of noise that fade toward
 * the base, and the side envelope sinks everything before the centre third.
 */
export function fillPeakTable(out: Float32Array, peaks: readonly PeakSpec[], aspect: number) {
  const noises = peaks.map((p) => createNoise(p.seed));
  for (let c = 0; c < PEAK_COLUMNS; c++) {
    const x = (c + 0.5) / PEAK_COLUMNS;
    const xh = x * aspect;
    let best = NO_PEAK;
    let offset = 0;
    let haze = 0;
    for (let k = 0; k < peaks.length; k++) {
      const p = peaks[k];
      const dx = xh - p.x * aspect;
      const d = Math.abs(dx) / (dx < 0 ? p.left : p.right);
      if (d >= 1.2) {
        continue;
      }
      const fall = Math.max(0, 1 - d);
      const rough = 0.09 * noises[k].noise2(xh * 14, 0.5) + 0.04 * noises[k].noise2(xh * 37, 3.5);
      const h = p.height * (fall ** 1.35 + rough * Math.min(fall * 3, 1)) - 0.02 * (1 - fall);
      if (h > best) {
        best = h;
        offset = dx;
        haze = p.haze;
      }
    }
    const env = sideEnvelope(x);
    const o = c * PEAK_FLOATS;
    out[o] = best > NO_PEAK ? NO_PEAK + (best - NO_PEAK) * env : NO_PEAK;
    out[o + 1] = offset;
    out[o + 2] = haze;
    out[o + 3] = 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ledge
// ---------------------------------------------------------------------------

/** Columns of the ledge profile, across its width. */
export const LEDGE_COLUMNS = 256;
/** Ledge width (height units, before narrowing on tall screens) and its highest point. */
const LEDGE_WIDTH = 0.55;
export const LEDGE_TOP = 0.2;

/** Ledge width on a canvas `aspect` wide: kept within the left 30% of the frame. */
export const ledgeWidth = (aspect: number) => Math.min(LEDGE_WIDTH, aspect * 0.3);

/**
 * Fills `out` (`LEDGE_COLUMNS` floats) with a rocky ledge rising from the bottom
 * left corner: heights (height units above the bottom edge) at u = column /
 * (LEDGE_COLUMNS - 1) of its width, falling to 0 at its tip with a jagged,
 * blocky top. Deterministic for a seed.
 */
export function buildLedge(out: Float32Array, seed: number) {
  const noise = createNoise(Math.floor(seed) * 31 + 7);
  const rand = createRng(Math.floor(seed) * 17 + 3);
  const lip = 0.62 + rand() * 0.12;
  for (let c = 0; c < LEDGE_COLUMNS; c++) {
    const u = c / (LEDGE_COLUMNS - 1);
    const body = (1 - 0.45 * u) * (1 - smoothstep(lip, 1, u));
    // Blocky rock: noise stepped into small ledges, then softened a little.
    const n = noise.noise2(u * 9, 0.3);
    const step = Math.round(n * 4) / 4;
    const rough = 0.12 * (0.6 * step + 0.4 * n) + 0.04 * noise.noise2(u * 31, 2.1);
    out[c] = Math.max(0, LEDGE_TOP * body * (1 + rough));
  }
  out[LEDGE_COLUMNS - 1] = 0;
  return out;
}
