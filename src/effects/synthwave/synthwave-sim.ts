/**
 * Synthwave's CPU side, kept free of GL and shaders so it can be tested: the
 * seeded mountain ridges, the sun's stripes, the per-row table the shader reads
 * and the mountains' highest reach.
 */
import type { Rgb } from "../color";
import { clamp, smoothstep } from "../math";
import { createRng } from "../noise";
import { capPatternSpeed } from "../motion-limits";

/** Points per mountain ridge (2^n + 1 for midpoint displacement). */
export const RIDGE_POINTS = 129;
/** Farthest grid depth drawn, in camera heights. */
export const Z_FAR = 30;
/** Ridge left edge and span, as fractions of the width. */
export const RIDGE_LEFT = -0.08;
export const RIDGE_SPAN = 1.16;
/** Max heights of the back and front ranges, as fractions of the height. */
export const BACK_HEIGHT = 0.16;
export const FRONT_HEIGHT = 0.09;
/** Width of the front range's edge line at 1080p. */
export const EDGE_WIDTH = 1.5;
export const SUN_STRIPES = 7;
/** Grid scroll in world units per second at speed 1. */
const SCROLL_PER_SPEED = 1.2;

/**
 * Grid scroll speed (world units per second) for the speed and cell size params.
 * Every horizontal line passes a screen point once per cell scrolled, whatever its
 * depth, so a small cell at a high speed would strobe; the line rate is capped at
 * MAX_PATTERN_HZ, which leaves the default (2.4 Hz) alone.
 */
export const gridScrollSpeed = (speed: number, cell: number) =>
  capPatternSpeed(speed * SCROLL_PER_SPEED, cell);

/** Length of [a, b] inside the pixel row centred on y. */
const overlap = (a: number, b: number, y: number) =>
  Math.max(0, Math.min(b, y + 0.5) - Math.max(a, y - 0.5));

/** Box-filtered coverage of a line of width w at signed distance d from the pixel centre. */
const lineCov = (d: number, w: number) =>
  clamp(Math.min(d + 0.5 * w, 0.5) - Math.max(d - 0.5 * w, -0.5), 0, 1);

/** Floats per row of the row texture: three RGBA texels (see uRows in the shader). */
export const ROW_FLOATS = 12;

/**
 * Fills `out` with a 0..1 ridge line using midpoint displacement, seeded so the
 * mountains are identical every time.
 */
export function generateRidge(out: Float32Array, seed: number, roughness: number): void {
  const rand = createRng(seed);
  const last = out.length - 1;
  out[0] = rand();
  out[last] = rand();
  let amp = 0.6;
  for (let step = last; step > 1; step >>= 1) {
    const half = step >> 1;
    for (let i = half; i < last; i += step) {
      out[i] = (out[i - half] + out[i + half]) / 2 + (rand() * 2 - 1) * amp;
    }
    amp *= roughness;
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= last; i++) {
    min = Math.min(min, out[i]);
    max = Math.max(max, out[i]);
  }
  const range = max - min || 1;
  for (let i = 0; i <= last; i++) {
    out[i] = (out[i] - min) / range;
  }
}

/** Ridge height scale at `x` (0..1 across the ridge): low in the middle so the sun stays visible. */
export const ridgeEnvelope = (x: number) => 0.2 + 0.8 * smoothstep(0.08, 0.42, Math.abs(x - 0.5));

/**
 * Ridge heights (0..1 of each layer's max height) with the low-middle envelope
 * baked in: row 0 is the back range, row 1 the front. Linear filtering between
 * texels gives the straight segments of the old 2D polyline; the shader reads
 * each segment's endpoints with texelFetch and interpolates them itself.
 */
const buildRidgeData = () => {
  const data = new Float32Array(RIDGE_POINTS * 2);
  const ridge = new Float32Array(RIDGE_POINTS);
  const last = RIDGE_POINTS - 1;
  // Seeds picked to stay close to the ridges of the earlier local PRNG.
  const rows: [number, number][] = [
    [150405, 0.55],
    [57466, 0.5],
  ];
  rows.forEach(([seed, roughness], row) => {
    generateRidge(ridge, seed, roughness);
    for (let i = 0; i <= last; i++) {
      data[row * RIDGE_POINTS + i] = ridge[i] * ridgeEnvelope(i / last);
    }
  });
  return data;
};

let ridgeData: Float32Array | undefined;
/** The ridges are deterministic, so build them once and reuse them across instances. */
export const getRidgeData = () => {
  ridgeData ??= buildRidgeData();
  return ridgeData;
};

let ridgeMaxStep: [number, number] | undefined;
/** Largest height change between neighbouring ridge points, per row (0..1 units). */
const getRidgeMaxStep = (): [number, number] => {
  const rowMaxStep = (row: number) => {
    const data = getRidgeData();
    let max = 0;
    for (let i = 1; i < RIDGE_POINTS; i++) {
      const at = row * RIDGE_POINTS + i;
      max = Math.max(max, Math.abs(data[at] - data[at - 1]));
    }
    return max;
  };
  ridgeMaxStep ??= [rowMaxStep(0), rowMaxStep(1)];
  return ridgeMaxStep;
};

/**
 * Fills `gaps` with the sun's SUN_STRIPES cut-out stripes as [start, end] y spans,
 * clipped to the disc's drawn span [sunY - r, sunClip], as `fillRows` needs. The
 * gaps drift down with `phase` (0..1) and widen toward the bottom of the sun; with
 * `stripes` off they are empty.
 */
export function sunGaps(
  gaps: Float64Array,
  sunY: number,
  r: number,
  phase: number,
  stripes: boolean,
  sunClip: number,
): void {
  const sunTop = sunY - r;
  const regionTop = sunY - r * 0.15;
  const regionH = sunY + r - regionTop;
  const maxGap = (regionH / SUN_STRIPES) * 0.75;
  for (let i = 0; i < SUN_STRIPES; i++) {
    const u = (i + phase) / SUN_STRIPES;
    const centre = regionTop + u * regionH;
    const gap = stripes ? maxGap * u * u * 0.4 + maxGap * u * 0.6 : 0;
    gaps[i * 2] = Math.max(centre - gap / 2, sunTop);
    gaps[i * 2 + 1] = Math.min(centre + gap / 2, sunClip);
  }
}

/** Everything `fillRows` reads besides the palette, in canvas pixels (y down). */
interface RowScene {
  height: number;
  /** Horizon y. */
  hy: number;
  /** Camera height: distance from the unswayed horizon to the bottom edge. */
  k: number;
  /** Top of the sun disc, and the lowest y it is drawn to. */
  sunTop: number;
  sunClip: number;
  /** Stripe gaps from `sunGaps`. */
  gaps: Float64Array;
  /** Scanline period in rows, or 0 for none. */
  scanPeriod: number;
  /** Glow and core width of the grid lines, and the glow's alpha. */
  glowW: number;
  coreW: number;
  glowA: number;
  /** Grid cell size and scroll (0..cell), in world units. */
  cell: number;
  scroll: number;
}

export const createRowScene = (): RowScene => ({
  height: 1,
  hy: 0,
  k: 1,
  sunTop: 0,
  sunClip: 0,
  gaps: new Float64Array(SUN_STRIPES * 2),
  scanPeriod: 0,
  glowW: 1,
  coreW: 1,
  glowA: 0,
  cell: 1,
  scroll: 0,
});

/** The palette colours `fillRows` reads. */
export interface RowColors {
  skyTop: Rgb;
  skyMid: Rgb;
  skyBottom: Rgb;
  grid: Rgb;
  core: Rgb;
  haze: Rgb;
}

/**
 * Fills `rows` (`n * ROW_FLOATS` floats, bottom row first: gl_FragCoord.y = r + 0.5)
 * with the per-row values the shader reads from uRows: sky colour and sun stripe
 * coverage, haze and scanlines as `col * a + rgb`, and the horizontal grid lines'
 * additive colour with the vertical lines' row mask.
 */
export function fillRows(rows: Float32Array, n: number, s: RowScene, c: RowColors): void {
  const { height, hy, k, sunTop, sunClip, gaps, scanPeriod, glowW, coreW, glowA, cell } = s;
  // Horizontal lines sit at Z_FAR - ((Z_FAR + scroll) % cell) - m * cell.
  const zTop = Z_FAR - ((Z_FAR + s.scroll) % cell);
  const zPhase = zTop % cell;
  const zMax = zTop + cell / 2;
  const yFar = hy + k / Z_FAR;
  const scanThick = Math.max(1, Math.round(scanPeriod / 2));
  const hazeH = height * 0.07;
  const groundH = height - hy;
  const { skyTop, skyMid, skyBottom, grid, core, haze } = c;
  for (let row = 0; row < n; row++) {
    const y = height - row - 0.5;
    const o = row * ROW_FLOATS;

    // Sky gradient and sun stripe coverage.
    const t = clamp(y / hy, 0, 1);
    const lo = t < 0.55 ? skyTop : skyMid;
    const hi = t < 0.55 ? skyMid : skyBottom;
    const u = t < 0.55 ? t / 0.55 : (t - 0.55) / 0.45;
    rows[o] = lo[0] + (hi[0] - lo[0]) * u;
    rows[o + 1] = lo[1] + (hi[1] - lo[1]) * u;
    rows[o + 2] = lo[2] + (hi[2] - lo[2]) * u;
    let cy = 0;
    if (y < sunClip + 1) {
      cy = overlap(sunTop, sunClip, y);
      for (let i = 0; i < SUN_STRIPES * 2; i += 2) {
        cy -= overlap(gaps[i], gaps[i + 1], y);
      }
    }
    rows[o + 3] = clamp(cy, 0, 1);

    // Haze, then scanlines: (mix(col, haze, h)) * scan = col * a + rgb.
    const h = 0.45 * Math.max(0, 1 - Math.abs(y - hy) / hazeH);
    const scan = scanPeriod > 0 && Math.floor(y) % scanPeriod < scanThick ? 0.84 : 1;
    rows[o + 4] = haze[0] * h * scan;
    rows[o + 5] = haze[1] * h * scan;
    rows[o + 6] = haze[2] * h * scan;
    rows[o + 7] = (1 - h) * scan;

    // Horizontal grid lines at evenly spaced depths. Separate strokes in 2D, so they add.
    const dy = y - hy;
    let hg = 0;
    let hc = 0;
    let vmask = 0;
    if (dy > 0) {
      const tv = dy / groundH;
      const fv = tv < 0.08 ? (tv / 0.08) * 0.25 : Math.min(1, 0.25 + ((tv - 0.08) / 0.22) * 0.75);
      vmask = clamp(y + 0.5 - yFar, 0, 1) * fv;
      const z = k / dy;
      const j0 = Math.floor((z - zPhase) / cell);
      for (let j = j0 - 2; j <= j0 + 2; j++) {
        const zj = zPhase + j * cell;
        if (zj <= 0 || zj >= zMax) {
          continue;
        }
        const yj = hy + k / zj;
        const th = clamp(1.2 / zj, 0.35, 1.8);
        const fade = smoothstep(0, 0.3, (yj - hy) / groundH);
        hg += fade * lineCov(y - yj, glowW * th);
        hc += fade * lineCov(y - yj, coreW * th);
      }
      // Where lines crowd closer than a pixel, fade to their average coverage.
      const spacingH = (k * cell) / (z * z);
      const thz = clamp(1.2 / z, 0.35, 1.8);
      const avgH = ((smoothstep(0, 0.3, tv) * thz) / spacingH) * clamp((zMax - z) / cell, 0, 1);
      const mg = smoothstep(3, 4, (glowW * thz + 1) / spacingH);
      const mc = smoothstep(3, 4, (coreW * thz + 1) / spacingH);
      hg = (hg + (avgH * glowW - hg) * mg) * glowA;
      hc = (hc + (avgH * coreW - hc) * mc) * 0.9;
    }
    rows[o + 8] = grid[0] * hg + core[0] * hc;
    rows[o + 9] = grid[1] * hg + core[1] * hc;
    rows[o + 10] = grid[2] * hg + core[2] * hc;
    rows[o + 11] = vmask;
  }
}

/**
 * Highest y (canvas pixels, y down) either ridge can affect, for a horizon at `hy`:
 * its peak, plus how far the anti-aliasing (and the front edge line) reaches up a
 * steep slope, plus a little slack for half-float rounding. The shader skips the
 * mountains above it.
 */
export function mountainTop(hy: number, width: number, height: number, scale: number): number {
  const [backStep, frontStep] = getRidgeMaxStep();
  const ridgeSpan = RIDGE_SPAN * width;
  const backH = BACK_HEIGHT * height;
  const frontH = FRONT_HEIGHT * height;
  const edgeWidth = EDGE_WIDTH * scale;
  const backS = (backStep * backH * (RIDGE_POINTS - 1)) / ridgeSpan;
  const frontS = (frontStep * frontH * (RIDGE_POINTS - 1)) / ridgeSpan;
  return (
    hy +
    1 -
    Math.max(
      backH + 0.5 * Math.sqrt(1 + backS * backS),
      frontH + (0.5 * edgeWidth + 0.5) * Math.sqrt(1 + frontS * frontS),
    ) -
    2
  );
}
