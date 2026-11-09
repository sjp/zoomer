import { hexToUnitRgb, mixRgb, type Rgb } from "../color";
import {
  beginFrame,
  createColumnTable,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  resetUnpackState,
  updateDataTexture,
  withScope,
  scopedProgram,
  createRenderTarget,
  floatRenderable,
  type RenderTarget,
} from "../gl";
import { synthwaveMeta } from "./synthwave.meta";
import { defineEffect } from "../types";
import { clamp, smoothstep } from "../math";
import { createRng } from "../noise";
import { createChangeKey } from "../change-key";

/** Points per mountain ridge (2^n + 1 for midpoint displacement). */
export const RIDGE_POINTS = 129;
/** Farthest grid depth drawn, in camera heights. */
const Z_FAR = 30;
/** Depth used to decide how many vertical lines can be visible at the sides. */
const Z_VISIBLE = 14;
const MAX_VERTICAL_LINES = 400;
/** Ridge left edge and span, as fractions of the width. */
export const RIDGE_LEFT = -0.08;
export const RIDGE_SPAN = 1.16;
/** Max heights of the back and front ranges, as fractions of the height. */
export const BACK_HEIGHT = 0.16;
export const FRONT_HEIGHT = 0.09;
/** Width of the front range's edge line at 1080p. */
export const EDGE_WIDTH = 1.5;
const SUN_STRIPES = 7;
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [1, 1, 1];

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
export const buildRidgeData = () => {
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

/*
 * Everything is computed in canvas pixel coordinates with y down, matching the
 * old 2D renderer, and layered in the same order: sky, sun glow, sun, mountains,
 * ground, additive grid, horizon haze, scanlines.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 uResolution;
/** Horizon y and vanishing point x. */
uniform vec2 uHorizon;
uniform float uCamX;
/**
 * Everything that depends only on the row, computed on the CPU each frame. Row r
 * is gl_FragCoord.y = r + 0.5 and holds three texels:
 * 0: sky gradient colour, sun stripe coverage;
 * 1: haze and scanlines folded into col * a + rgb;
 * 2: horizontal grid lines' additive colour, vertical lines' row mask.
 */
uniform sampler2D uRows;
/** Sun centre x, centre y and radius. */
uniform vec3 uSun;
/** Lowest y the sun disc is drawn to. */
uniform float uSunClip;
uniform vec3 uSunTop;
uniform vec3 uSunBottom;
uniform vec3 uSunGlowColor;
uniform float uSunGlow;
uniform sampler2D uRidge;
/** Ridge left edge x and span in pixels. */
uniform vec2 uRidgeSpan;
/** Parallax x shift of the back and front ranges. */
uniform vec2 uRidgeShift;
/** Max height in pixels of the back and front ranges. */
uniform vec2 uRidgeHeight;
uniform float uMountains;
/** Rows above this y can't be touched by either range (incl. AA and the edge line). */
uniform float uMountainTop;
uniform vec3 uBackColor;
uniform vec3 uGround;
uniform vec3 uGrid;
/** Vertical line glow and core colours, premultiplied by their alphas. */
uniform vec3 uVGlow;
uniform vec3 uVCore;
uniform float uEdgeWidth;
/** Glow and core width of the grid lines. */
uniform vec2 uLine;
uniform float uCell;
uniform float uInvCell;
/** Vertical lines run from index -uLines to uLines. */
uniform float uLines;

out vec4 outColor;

const int RIDGE_LAST = ${String(RIDGE_POINTS - 1)};
const float RIDGE_SEGMENTS = ${glslFloat(RIDGE_POINTS - 1)};
${DITHER_GLSL}
/** Box-filtered coverage of a line of width w at signed distance d from the pixel centre. */
float lineCov(float d, float w) {
  return clamp(min(d + 0.5 * w, 0.5) - max(d - 0.5 * w, -0.5), 0.0, 1.0);
}

/**
 * Signed distance below a ridge edge in pixels, positive inside the mountain.
 * The ridge is piecewise linear between texels, so fetch the enclosing
 * segment's endpoints (clamped at the ends, like CLAMP_TO_EDGE) and take the
 * height and slope straight from it.
 */
float ridgeDist(vec2 p, float shift, int row, float maxH) {
  float tx = (p.x - shift - uRidgeSpan.x) / uRidgeSpan.y * RIDGE_SEGMENTS;
  float fi = floor(tx);
  int i = int(fi);
  float a = texelFetch(uRidge, ivec2(clamp(i, 0, RIDGE_LAST), row), 0).r;
  float b = texelFetch(uRidge, ivec2(clamp(i + 1, 0, RIDGE_LAST), row), 0).r;
  float y = uHorizon.x + 1.0 - mix(a, b, tx - fi) * maxH;
  // Change in y over one pixel.
  float s = (a - b) * maxH * RIDGE_SEGMENTS / uRidgeSpan.y;
  return (p.y - y) * inversesqrt(1.0 + s * s);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  int row = int(gl_FragCoord.y);
  float hy = uHorizon.x;
  float vpx = uHorizon.y;

  vec3 col;
  if (p.y >= hy + 0.5) {
    // The ground fully covers everything drawn before it here.
    col = uGround;
  } else {
    // Sky gradient.
    vec4 sky = texelFetch(uRows, ivec2(0, row), 0);
    col = sky.rgb;

    float r = uSun.z;
    vec2 sd = p - uSun.xy;
    float dist = length(sd);

    // Sun glow: radial gradient from 0.6r to 2.2r (zero beyond).
    if (dist < 2.2 * r) {
      float gt = (dist - 0.6 * r) / (1.6 * r);
      float ga = gt < 0.4
        ? mix(0.55, 0.18, clamp(gt / 0.4, 0.0, 1.0))
        : mix(0.18, 0.0, clamp((gt - 0.4) / 0.6, 0.0, 1.0));
      col = mix(col, uSunGlowColor, ga * uSunGlow * step(p.y, hy));
    }

    // Sun disc with stripe gaps cut out (zero coverage outside r + 0.5 and the clip).
    if (dist < r + 1.0 && p.y < uSunClip + 1.0) {
      float top = uSun.y - r;
      float cc = clamp(r - dist + 0.5, 0.0, 1.0);
      vec3 sunCol = mix(uSunTop, uSunBottom, clamp((p.y - top) / (2.0 * r), 0.0, 1.0));
      col = mix(col, sunCol, sky.a * cc);
    }

    // Mountains, only in the rows they can reach.
    if (uMountains > 0.5 && p.y > uMountainTop) {
      float db = ridgeDist(p, uRidgeShift.x, 0, uRidgeHeight.x);
      col = mix(col, uBackColor, clamp(db + 0.5, 0.0, 1.0));
      float df = ridgeDist(p, uRidgeShift.y, 1, uRidgeHeight.y);
      col = mix(col, uGround, clamp(df + 0.5, 0.0, 1.0));
      col = mix(col, uGrid, 0.35 * lineCov(df, uEdgeWidth));
    }

    // Ground.
    col = mix(col, uGround, clamp(p.y + 0.5 - hy, 0.0, 1.0));
  }

  float dy = p.y - hy;
  if (dy > 0.0) {
    float glowW = uLine.x;
    float coreW = uLine.y;

    // Vertical lines converge on the vanishing point. One stroked path in 2D, so
    // overlapping lines union rather than add.
    float px = p.x - vpx;
    float xp = px / dy;
    float q = (xp + uCamX) * uInvCell;
    float i0 = floor(q);
    float vg = 0.0;
    float vc = 0.0;
    for (int o = 0; o < 2; o++) {
      float i = i0 + float(o);
      if (abs(i) > uLines) continue;
      float xi = i * uCell - uCamX;
      float d = (px - xi * dy) * inversesqrt(1.0 + xi * xi);
      vg += lineCov(d, glowW);
      vc += lineCov(d, coreW);
    }
    vg = min(vg, 1.0);
    vc = min(vc, 1.0);
    // Where lines crowd closer than a pixel, fade to their average coverage. The
    // core is thinner than the glow, so neither fades where the glow doesn't.
    float stretch = sqrt(1.0 + xp * xp);
    float spacingV = uCell * dy;
    if (glowW * stretch + 1.0 > spacingV) {
      float inRange = step(abs(q), uLines + 0.5);
      float invSpacing = 1.0 / spacingV;
      vg = mix(vg, min(1.0, glowW * stretch * invSpacing) * inRange,
        smoothstep(1.0, 2.0, (glowW * stretch + 1.0) * invSpacing));
      vc = mix(vc, min(1.0, coreW * stretch * invSpacing) * inRange,
        smoothstep(1.0, 2.0, (coreW * stretch + 1.0) * invSpacing));
    }
    // Horizontal lines depend only on the row.
    vec4 h = texelFetch(uRows, ivec2(2, row), 0);
    col = min(col + (uVGlow * vg + uVCore * vc) * h.a + h.rgb, vec3(1.0));
  }

  // Haze band hugging the horizon, then CRT scanlines. Sub-LSB dither keeps the
  // tall, dark sky and haze gradients from banding into strips at 4K.
  vec4 post = texelFetch(uRows, ivec2(1, row), 0);
  outColor = vec4(clamp(col * post.a + post.rgb + dither8(gl_FragCoord.xy), 0.0, 1.0), 1.0);
}
`;

let ridgeData: Float32Array | undefined;
/** The ridges are deterministic, so build them once and reuse them across instances. */
export const getRidgeData = () => {
  ridgeData ??= buildRidgeData();
  return ridgeData;
};

let ridgeMaxStep: [number, number] | undefined;
/** Largest height change between neighbouring ridge points, per row (0..1 units). */
export const getRidgeMaxStep = (): [number, number] => {
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

interface Palette {
  skyTopHex: string;
  skyBottomHex: string;
  gridHex: string;
  sunTopHex: string;
  sunBottomHex: string;
  skyTop: Rgb;
  skyMid: Rgb;
  skyBottom: Rgb;
  sunTop: Rgb;
  sunBottom: Rgb;
  sunGlow: Rgb;
  backColor: Rgb;
  ground: Rgb;
  grid: Rgb;
  core: Rgb;
  haze: Rgb;
}

const buildPalette = (
  skyTopHex: string,
  skyBottomHex: string,
  gridHex: string,
  sunTopHex: string,
  sunBottomHex: string,
): Palette => {
  const skyTop = hexToUnitRgb(skyTopHex);
  const skyBottom = hexToUnitRgb(skyBottomHex);
  const grid = hexToUnitRgb(gridHex);
  const sunTop = hexToUnitRgb(sunTopHex);
  const sunBottom = hexToUnitRgb(sunBottomHex);
  const haze = mixRgb(skyBottom, grid, 0.35);
  const ground = mixRgb(skyTop, BLACK, 0.4);
  return {
    skyTopHex,
    skyBottomHex,
    gridHex,
    sunTopHex,
    sunBottomHex,
    skyTop,
    skyMid: mixRgb(skyTop, skyBottom, 0.45),
    skyBottom,
    sunTop,
    sunBottom,
    sunGlow: mixRgb(sunTop, sunBottom, 0.6),
    backColor: mixRgb(ground, haze, 0.35),
    ground,
    grid,
    core: mixRgb(grid, WHITE, 0.35),
    haze,
  };
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
export interface RowScene {
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
export type RowColors = Pick<Palette, "skyTop" | "skyMid" | "skyBottom" | "grid" | "core" | "haze">;

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
 * \`fillRows\` on the GPU: one fragment per texel of the 3 x n row table, so the
 * table is rebuilt every frame without CPU work or an upload. Texel 0 is the sky
 * colour and sun stripe coverage, 1 the haze and scanlines, 2 the horizontal
 * grid lines and the vertical lines' mask. Depths that need float64 (the
 * scroll's wrap) come from the CPU.
 */
const ROWS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Canvas height, horizon y, camera height, scanline period (0: none). */
uniform vec4 uFrame;
/** Sun disc top and clip, scanline thickness in rows. */
uniform vec3 uSunSpan;
uniform vec2 uGaps[${String(SUN_STRIPES)}];
/** Glow width, core width, glow alpha, cell size. */
uniform vec4 uLine;
/** Depth of the first line's phase, the farthest line drawn, and the far plane's y. */
uniform vec3 uDepth;
uniform vec3 uSkyTop;
uniform vec3 uSkyMid;
uniform vec3 uSkyBottom;
uniform vec3 uGridColor;
uniform vec3 uCoreColor;
uniform vec3 uHaze;
out vec4 outColor;

float overlap(float a, float b, float y) {
  return max(0.0, min(b, y + 0.5) - max(a, y - 0.5));
}
float lineCov(float d, float w) {
  return clamp(min(d + 0.5 * w, 0.5) - max(d - 0.5 * w, -0.5), 0.0, 1.0);
}

void main() {
  int texel = int(gl_FragCoord.x);
  float height = uFrame.x;
  float hy = uFrame.y;
  float k = uFrame.z;
  float y = height - gl_FragCoord.y;
  if (texel == 0) {
    float t = clamp(y / hy, 0.0, 1.0);
    vec3 lo = t < 0.55 ? uSkyTop : uSkyMid;
    vec3 hi = t < 0.55 ? uSkyMid : uSkyBottom;
    float u = t < 0.55 ? t / 0.55 : (t - 0.55) / 0.45;
    float cy = 0.0;
    if (y < uSunSpan.y + 1.0) {
      cy = overlap(uSunSpan.x, uSunSpan.y, y);
      for (int i = 0; i < ${String(SUN_STRIPES)}; i++) {
        cy -= overlap(uGaps[i].x, uGaps[i].y, y);
      }
    }
    outColor = vec4(lo + (hi - lo) * u, clamp(cy, 0.0, 1.0));
  } else if (texel == 1) {
    float h = 0.45 * max(0.0, 1.0 - abs(y - hy) / (height * 0.07));
    float scan = uFrame.w > 0.0 && mod(floor(y), uFrame.w) < uSunSpan.z ? 0.84 : 1.0;
    outColor = vec4(uHaze * (h * scan), (1.0 - h) * scan);
  } else {
    float glowW = uLine.x;
    float coreW = uLine.y;
    float cell = uLine.w;
    float zPhase = uDepth.x;
    float zMax = uDepth.y;
    float dy = y - hy;
    float hg = 0.0;
    float hc = 0.0;
    float vmask = 0.0;
    if (dy > 0.0) {
      float groundH = height - hy;
      float tv = dy / groundH;
      float fv = tv < 0.08 ? (tv / 0.08) * 0.25 : min(1.0, 0.25 + ((tv - 0.08) / 0.22) * 0.75);
      vmask = clamp(y + 0.5 - uDepth.z, 0.0, 1.0) * fv;
      float z = k / dy;
      float j0 = floor((z - zPhase) / cell);
      for (int j = -2; j <= 2; j++) {
        float zj = zPhase + (j0 + float(j)) * cell;
        if (zj <= 0.0 || zj >= zMax) {
          continue;
        }
        float yj = hy + k / zj;
        float th = clamp(1.2 / zj, 0.35, 1.8);
        float fade = smoothstep(0.0, 0.3, (yj - hy) / groundH);
        hg += fade * lineCov(y - yj, glowW * th);
        hc += fade * lineCov(y - yj, coreW * th);
      }
      float spacingH = (k * cell) / (z * z);
      float thz = clamp(1.2 / z, 0.35, 1.8);
      float avgH = ((smoothstep(0.0, 0.3, tv) * thz) / spacingH) * clamp((zMax - z) / cell, 0.0, 1.0);
      float mg = smoothstep(3.0, 4.0, (glowW * thz + 1.0) / spacingH);
      float mc = smoothstep(3.0, 4.0, (coreW * thz + 1.0) / spacingH);
      hg = (hg + (avgH * glowW - hg) * mg) * uLine.z;
      hc = (hc + (avgH * coreW - hc) * mc) * 0.9;
    }
    outColor = vec4(uGridColor * hg + uCoreColor * hc, vmask);
  }
}
`;

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

/**
 * Retro 80s horizon: gradient sky, striped sun, mountain silhouettes and a neon
 * perspective grid rolling toward the viewer, drawn by one WebGL2 fragment shader
 * with analytically anti-aliased lines.
 */
export const synthwave = defineEffect(synthwaveMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ridge = scope.own(
        createColumnTable(gl, RIDGE_POINTS, 1, { rows: 2, data: getRidgeData() }),
      );
      const u = createUniforms(gl, program, [
        "uResolution",
        "uHorizon",
        "uCamX",
        "uRows",
        "uSun",
        "uSunClip",
        "uSunTop",
        "uSunBottom",
        "uSunGlowColor",
        "uSunGlow",
        "uRidge",
        "uRidgeSpan",
        "uRidgeShift",
        "uRidgeHeight",
        "uMountains",
        "uMountainTop",
        "uBackColor",
        "uGround",
        "uGrid",
        "uVGlow",
        "uVCore",
        "uEdgeWidth",
        "uLine",
        "uCell",
        "uInvCell",
        "uLines",
      ]);
      // Uniforms live in the program, so constant ones are set once (or on change).
      gl.useProgram(program);
      u.i1("uRidge", 0);
      u.i1("uRows", 1);
      gl.useProgram(null);

      /*
       * Per-row values (sky gradient, sun stripes, horizontal grid lines, haze,
       * scanlines) are the same across each row, so they are computed once per row
       * here rather than once per pixel, and uploaded as a tiny half-float texture
       * (texelFetch needs no float filtering, and 16 bits are plenty for colours and
       * coverages). They are rebuilt only when an input changes, so a static scene
       * (speed 0, sway 0) does no CPU work or uploads for them.
       */
      const rowTex = scope.add(gl.createTexture(), (t) => {
        gl.deleteTexture(t);
      });
      gl.bindTexture(gl.TEXTURE_2D, rowTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      let rows = new Float32Array(0);
      /** Rows allocated in rowTex; 0 forces (re)allocation. */
      let rowCount = 0;
      /*
       * Where a half-float target is renderable, the table is drawn on the GPU
       * instead (`ROWS_FRAGMENT`), which costs no CPU time and no upload even
       * while the camera sways and the grid scrolls. `rowTex` is the fallback.
       */
      let rowsOnGpu = floatRenderable(gl, gl.RGBA16F);
      const rowsProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, ROWS_FRAGMENT);
      const ru = createUniforms(gl, rowsProgram, [
        "uFrame",
        "uSunSpan",
        "uGaps",
        "uLine",
        "uDepth",
        "uSkyTop",
        "uSkyMid",
        "uSkyBottom",
        "uGridColor",
        "uCoreColor",
        "uHaze",
      ]);
      const gaps32 = new Float32Array(SUN_STRIPES * 2);
      let rowTarget: RenderTarget | null = null;
      scope.defer(() => {
        rowTarget?.dispose();
      });
      /** Every input of the row table besides the palette. */
      const rowInputs = createChangeKey(13);

      const scene = createRowScene();
      let palette: Palette | undefined;

      let width = 1;
      let height = 1;
      let scale = 1;
      /** Grid scroll in world units, kept wrapped to one cell. */
      let scroll = 0;
      /** Sun stripe drift phase, 0..1. */
      let stripePhase = 0;
      /** Seconds for the camera sway, in float64; only its sines reach the GPU. */
      let time = 0;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const cell = p.gridSize;
          scroll = (scroll + dt * p.speed * 1.2) % cell;
          stripePhase = (stripePhase + dt * p.speed * 0.06) % 1;
          time += dt;

          gl.useProgram(program);

          // Colours only change when the params do, so parse, mix and upload them once.
          if (
            palette?.skyTopHex !== p.skyTop ||
            palette.skyBottomHex !== p.skyBottom ||
            palette.gridHex !== p.gridColor ||
            palette.sunTopHex !== p.sunTop ||
            palette.sunBottomHex !== p.sunBottom
          ) {
            palette = buildPalette(p.skyTop, p.skyBottom, p.gridColor, p.sunTop, p.sunBottom);
            const pc = palette;
            u.v3("uSunTop", pc.sunTop);
            u.v3("uSunBottom", pc.sunBottom);
            u.v3("uSunGlowColor", pc.sunGlow);
            u.v3("uBackColor", pc.backColor);
            u.v3("uGround", pc.ground);
            u.v3("uGrid", pc.grid);
            u.f3("uVCore", pc.core[0] * 0.9, pc.core[1] * 0.9, pc.core[2] * 0.9);
            rowInputs.invalidate();
          }
          const c = palette;

          // Camera: gentle vertical bob and sideways drift.
          const baseHorizon = height * (1 - p.horizon);
          const hy = baseHorizon + Math.sin(time * 0.37) * 10 * scale * p.sway;
          const camX = Math.sin(time * 0.23) * 0.6 * p.sway;
          const vpx = width / 2;
          const k = height - baseHorizon;

          const r = p.sunSize * height;
          const sunY = hy - r * 0.45;
          scene.sunTop = sunY - r;
          scene.sunClip = Math.min(sunY + r, hy + 1);
          sunGaps(scene.gaps, sunY, r, stripePhase, p.sunStripes, scene.sunClip);

          const halfWorld = ((width / 2) * Z_VISIBLE) / k + Math.abs(camX);
          const lines = Math.min(MAX_VERTICAL_LINES, Math.ceil(halfWorld / cell));
          const scanPeriod = p.scanlines ? Math.max(2, Math.round(4 * scale)) : 0;
          const glowW = (2 + 10 * p.gridGlow) * scale;
          const coreW = 1.6 * scale;
          const glowA = 0.22 * p.gridGlow;

          // Per-row values, bottom row first (gl_FragCoord.y = r + 0.5).
          const n = Math.max(1, Math.ceil(height));
          if (rowsOnGpu && rowTarget?.height !== n) {
            rowTarget?.dispose();
            rowTarget = createRenderTarget(gl, 3, n, gl.RGBA16F, { filter: gl.NEAREST });
            rowsOnGpu = rowTarget !== null;
          }
          if (!rowsOnGpu && n !== rowCount) {
            rows = new Float32Array(n * ROW_FLOATS);
            rowCount = 0;
          }
          // Everything the rows are built from (the derived values above follow from these).
          rowInputs.set(0, n);
          rowInputs.set(1, height);
          rowInputs.set(2, hy);
          rowInputs.set(3, k);
          rowInputs.set(4, r);
          rowInputs.set(5, stripePhase);
          rowInputs.set(6, p.sunStripes ? 1 : 0);
          rowInputs.set(7, scanPeriod);
          rowInputs.set(8, p.gridGlow);
          rowInputs.set(9, p.horizon);
          rowInputs.set(10, cell);
          rowInputs.set(11, scroll);
          rowInputs.set(12, scale);
          const rebuildRows = rowInputs.take();
          if (rebuildRows && rowsOnGpu && rowTarget) {
            const zTop = Z_FAR - ((Z_FAR + scroll) % cell);
            gl.useProgram(rowsProgram);
            ru.f4("uFrame", height, hy, k, scanPeriod);
            ru.f3("uSunSpan", scene.sunTop, scene.sunClip, Math.max(1, Math.round(scanPeriod / 2)));
            gaps32.set(scene.gaps);
            gl.uniform2fv(ru.loc.uGaps, gaps32);
            ru.f4("uLine", glowW, coreW, glowA, cell);
            ru.f3("uDepth", zTop % cell, zTop + cell / 2, hy + k / Z_FAR);
            ru.v3("uSkyTop", c.skyTop);
            ru.v3("uSkyMid", c.skyMid);
            ru.v3("uSkyBottom", c.skyBottom);
            ru.v3("uGridColor", c.grid);
            ru.v3("uCoreColor", c.core);
            ru.v3("uHaze", c.haze);
            rowTarget.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
            gl.useProgram(program);
          } else if (rebuildRows) {
            scene.height = height;
            scene.hy = hy;
            scene.k = k;
            scene.scanPeriod = scanPeriod;
            scene.glowW = glowW;
            scene.coreW = coreW;
            scene.glowA = glowA;
            scene.cell = cell;
            scene.scroll = scroll;
            fillRows(rows, n, scene, c);
          }

          const ridgeSpan = RIDGE_SPAN * width;
          const backH = BACK_HEIGHT * height;
          const frontH = FRONT_HEIGHT * height;

          gl.activeTexture(gl.TEXTURE1);
          if (rowsOnGpu && rowTarget) {
            gl.bindTexture(gl.TEXTURE_2D, rowTarget.texture);
          } else if (rowCount !== n) {
            rowCount = n;
            gl.bindTexture(gl.TEXTURE_2D, rowTex);
            resetUnpackState(gl);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 3, n, 0, gl.RGBA, gl.FLOAT, rows);
          } else if (rebuildRows) {
            updateDataTexture(gl, rowTex, 3, n, gl.RGBA, gl.FLOAT, rows);
          } else {
            gl.bindTexture(gl.TEXTURE_2D, rowTex);
          }
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, ridge.texture);

          u.f2("uResolution", width, height);
          u.f2("uHorizon", hy, vpx);
          u.f1("uCamX", camX);
          u.f3("uSun", vpx, sunY, r);
          u.f1("uSunClip", scene.sunClip);
          u.f1("uSunGlow", p.sunGlow);
          u.f2("uRidgeSpan", RIDGE_LEFT * width, ridgeSpan);
          u.f2("uRidgeShift", -camX * k * 0.01, -camX * k * 0.025);
          u.f2("uRidgeHeight", backH, frontH);
          u.f1("uMountains", p.mountains ? 1 : 0);
          u.f1("uMountainTop", mountainTop(hy, width, height, scale));
          u.f3("uVGlow", c.grid[0] * glowA, c.grid[1] * glowA, c.grid[2] * glowA);
          u.f1("uEdgeWidth", EDGE_WIDTH * scale);
          u.f2("uLine", glowW, coreW);
          u.f1("uCell", cell);
          u.f1("uInvCell", 1 / cell);
          u.f1("uLines", lines);
          triangle.draw();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
