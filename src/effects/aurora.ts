import { unitRgbMemo } from "./color";
import {
  beginFrame,
  type ColumnTable,
  createColumnTable,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { createNoise, createRng, fbm2, fbmPeriodic2, type Noise } from "./noise";
import { createSpriteBatch } from "./sprites";
import { auroraMeta } from "./aurora.meta";
import { defineEffect } from "./types";
import { approach } from "./math";

/*
 * Aurora: one full-screen pass draws the sky gradient, up to three additive
 * curtain bands and the horizon silhouette; a small instanced sprite pass adds
 * the stars on top. Nothing is evaluated in 2D per pixel: everything that varies
 * along x lives in 1D tables.
 *
 * - Path table (PATH_COLS x 2, RGBA16F, rebuilt on the CPU each frame): row 0
 *   holds each band's wave offset from its base height (the bases are a uniform,
 *   so the small offsets keep half-float precision and the edges move sub-pixel),
 *   row 1 its brightness along x.
 * - Ray table (RAY_COLS x 1, RGBA16F, static, REPEAT): ridged periodic noise, one
 *   pattern per channel. Sampled twice at different scales and drift speeds.
 * - Horizon table (about width / 2 x 1, RG16F, rebuilt on resize): silhouette
 *   height and slope, for anti-aliasing.
 */

export const PATH_COLS = 160;
export const RAY_COLS = 2048;
/** Noise cells per ray-table period; RAY_COLS / RAY_CELLS texels per cell. */
const RAY_CELLS = 128;
export const MAX_BANDS = 3;
export const MAX_STARS = 500;
/** Floats per star instance: x, y (0..1, y up), radius (1080p px), brightness, phase, rate. */
export const STAR_STRIDE = 6;
/** Twinkle time wraps at this many seconds; star rates are whole cycles per period. */
export const TWINKLE_PERIOD = 600;
const TAU = Math.PI * 2;

/** Base height (fraction of canvas height from the bottom) and gain of each band. */
export const BAND_BASE = [0.44, 0.6, 0.3] as const;
const BAND_GAIN = [1.6, 1.2, 1] as const;
/** Seconds a band takes to fade in or out when the band count changes. */
const BAND_FADE = 1;
/** How far each band's path wanders up and down, in canvas heights. */
export const PATH_AMPLITUDE = 0.09;
/** Distances (canvas heights) over which a curtain halves in brightness, up and down. */
const HALF_UP = 0.09;
const HALF_DOWN = 0.012;
/** Height above the base over which the colour goes from low to high. */
const COLOR_SPAN = 0.32;
/** Ray table repeats per canvas height for the fine and coarse ray layers. */
const RAY_SCALE_FINE = 0.42;
const RAY_SCALE_COARSE = 0.13;

export type HorizonKind = "none" | "hills" | "pines";

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * Fills `out` (cols * 2 * 4 floats, i.e. two RGBA rows) with the per-column curtain
 * table at `time`. Row 0: offset of bands 0..2 from their `BAND_BASE` heights, as
 * a fraction of canvas height (within +-PATH_AMPLITUDE); absolute heights near 0.6
 * would only get half-float steps of about 1 px at 2160p. Row 1: brightness of
 * bands 0..2 along x, in 0.25..1. Column i covers x = (i + 0.5) / cols of the
 * canvas width; `aspect` is width / height so that the noise is not stretched on
 * wide screens. Alpha channels are 0.
 */
export function buildPathTable(
  out: Float32Array,
  cols: number,
  aspect: number,
  time: number,
  noise: Noise,
): void {
  const row1 = cols * 4;
  for (let i = 0; i < cols; i++) {
    const x = ((i + 0.5) / cols) * aspect;
    const o = i * 4;
    for (let b = 0; b < MAX_BANDS; b++) {
      const s = b * 17.3;
      const wave =
        0.72 * noise.noise2(x * 0.85 + s, time + s) +
        0.28 * noise.noise2(x * 2.4 - s, time * 1.7 + 40 + s);
      out[o + b] = PATH_AMPLITUDE * wave;
      out[row1 + o + b] =
        0.25 + 0.75 * smooth01(0.55 + 0.9 * noise.noise2(x * 0.6 + 90 + s, time * 0.4));
    }
    out[o + 3] = 0;
    out[row1 + o + 3] = 0;
  }
}

/**
 * Ray striations: ridged, seamlessly periodic 1D noise, `cols` RGBA texels (one
 * independent pattern per channel), values in 0..1 with thin bright ridges.
 */
export function buildRayTable(cols: number = RAY_COLS, seed = 7): Float32Array {
  const noise = createNoise(seed);
  const out = new Float32Array(cols * 4);
  const perCell = cols / RAY_CELLS;
  let max = 0;
  for (let i = 0; i < cols; i++) {
    for (let c = 0; c < 4; c++) {
      // y is a fixed row per channel; the x period is RAY_CELLS, so the table wraps.
      const n = fbmPeriodic2(noise, i / perCell, c * 3.37 + 0.5, RAY_CELLS, 2, 0.6);
      const r = Math.max(0, 1 - Math.abs(n) * 1.6);
      const v = r * r * r;
      out[i * 4 + c] = v;
      max = Math.max(max, v);
    }
  }
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}

/**
 * Silhouette table: `cols` RG pairs of (height as a fraction of canvas height,
 * slope dh/dx in pixels per pixel). Column i covers x = (i + 0.5) / cols of the
 * width; `aspect` is width / height so trees keep their shape. "none" is all 0.
 */
export function buildHorizonTable(
  kind: HorizonKind,
  cols: number,
  aspect: number,
  seed = 11,
): Float32Array {
  const out = new Float32Array(cols * 2);
  if (kind === "none" || cols < 1) return out;
  const noise = createNoise(seed);
  const colW = aspect / cols;
  const xAt = (i: number) => (i + 0.5) * colW;
  const h = new Float32Array(cols);
  if (kind === "hills") {
    for (let i = 0; i < cols; i++) {
      h[i] = 0.075 + 0.05 * fbm2(noise, xAt(i) * 1.1, 3.7, 3);
    }
  } else {
    const ground = (x: number) => 0.035 + 0.018 * fbm2(noise, x * 1.4, 8.1, 2);
    for (let i = 0; i < cols; i++) h[i] = ground(xAt(i));
    const rng = createRng(seed + 1);
    const tiers = 5;
    for (let x = -0.08; x < aspect + 0.08; x += 0.012 + 0.04 * rng()) {
      // Occasional clearings.
      if (rng() < 0.08) continue;
      const height = 0.04 + 0.1 * rng() ** 1.4;
      const base = ground(x);
      const halfW = height * (0.24 + 0.08 * rng());
      const tierDrop = height * 0.34;
      const first = Math.max(0, Math.floor((x - halfW) / colW - 0.5));
      const last = Math.min(cols - 1, Math.ceil((x + halfW) / colW));
      for (let i = first; i <= last; i++) {
        const dx = Math.abs(xAt(i) - x);
        let top = 0;
        for (let k = 0; k < tiers; k++) {
          // Each tier is a triangle; lower tiers sit lower and spread wider.
          const apex = height * (1 - k * 0.17);
          const tierHalfW = halfW * (0.3 + (0.7 * (k + 1)) / tiers);
          top = Math.max(top, apex - (dx / tierHalfW) * tierDrop);
        }
        h[i] = Math.max(h[i], base + top);
      }
    }
  }
  for (let i = 0; i < cols; i++) {
    const a = h[Math.max(0, i - 1)];
    const b = h[Math.min(cols - 1, i + 1)];
    const span = (Math.min(cols - 1, i + 1) - Math.max(0, i - 1)) * colW;
    out[i * 2] = h[i];
    out[i * 2 + 1] = span > 0 ? (b - a) / span : 0;
  }
  return out;
}

/** Highest silhouette point in a horizon table, as a fraction of canvas height. */
export function horizonMax(table: Float32Array): number {
  let max = 0;
  for (let i = 0; i < table.length; i += 2) max = Math.max(max, table[i]);
  return max;
}

/**
 * Stars to draw for a star density (0..1) on a `width` x `height` canvas: MAX_STARS
 * at full density on a 16:9 screen, more on wider screens (up to 1.5 times, capped
 * at MAX_STARS) and fewer on narrower ones, so the sky looks equally dense.
 */
export function auroraStarCount(density: number, width: number, height: number): number {
  const aspectShare = Math.min(1.5, width / Math.max(1, height) / (16 / 9));
  return Math.max(0, Math.min(MAX_STARS, Math.round(density * MAX_STARS * aspectShare)));
}

/**
 * Fills `out` with up to `count` star instances (STAR_STRIDE floats each) from a
 * fixed seeded sequence, so changing the density adds or removes stars without
 * moving the others. Stars hidden by the silhouette are skipped, and stars dim
 * towards the horizon. Returns the number of stars written.
 */
export function buildStars(
  out: Float32Array,
  count: number,
  horizon: Float32Array,
  seed = 23,
): number {
  const rng = createRng(seed);
  const cols = horizon.length / 2;
  const max = Math.min(count, Math.floor(out.length / STAR_STRIDE));
  let n = 0;
  // Draw from a longer sequence so rejected stars are replaced.
  for (let tries = 0; n < max && tries < max * 4; tries++) {
    const x = rng();
    const y = rng();
    const big = rng();
    const bright = rng();
    const phase = rng() * TAU;
    const cycles = 40 + Math.floor(rng() * 160);
    const radius = 0.7 + 1.1 * big * big * big;
    const col = Math.min(cols - 1, Math.floor(x * cols));
    const ground = cols > 0 ? horizon[col * 2] : 0;
    if (y < ground + radius / 1080 + 0.006) continue;
    const o = n * STAR_STRIDE;
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = radius;
    out[o + 3] = (0.25 + 0.75 * bright * bright) * (0.35 + 0.65 * smooth01(y * 2.5));
    out[o + 4] = phase;
    out[o + 5] = (cycles * TAU) / TWINKLE_PERIOD;
    n++;
  }
  return n;
}

let rayTable: Float32Array | undefined;
const getRayTable = () => (rayTable ??= buildRayTable());

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform vec2 uResolution;
/** Row 0: band height offsets from uBandBase; row 1: band brightness. Linear, clamped. */
uniform sampler2D uPath;
/** Base height of each band, as a fraction of canvas height from the bottom. */
uniform vec3 uBandBase;
/** Ridged ray noise, one pattern per channel. Linear, repeating. */
uniform sampler2D uRays;
/** Silhouette height (fraction of canvas height) and slope (px/px). */
uniform sampler2D uHorizon;
/** Fine and coarse ray drifts, in table periods. */
uniform vec2 uRayDrift;
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform vec3 uSilhouette;
uniform vec3 uLow;
uniform vec3 uHigh;
/** log2 falloff rates per canvas height, above and below each band's base. */
uniform vec2 uFalloff;
uniform float uColorSpan;
/** Per-band gain (0 for unused bands). */
uniform vec3 uGain;
/** Rows below this (px) may be covered by the silhouette; negative = none. */
uniform float uHorizonTop;

out vec4 outColor;
${DITHER_GLSL}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float u = frag.x / uResolution.x;
  float y = frag.y / uResolution.y;
  float dither = dither8(frag);

  // Silhouette first: fully covered pixels skip the curtains.
  float cover = 0.0;
  if (frag.y < uHorizonTop) {
    vec2 hs = textureLod(uHorizon, vec2(u, 0.5), 0.0).rg;
    float dist = (hs.x * uResolution.y - frag.y) * inversesqrt(1.0 + hs.y * hs.y);
    cover = clamp(dist + 0.5, 0.0, 1.0);
    if (cover >= 1.0) {
      outColor = vec4(uSilhouette + dither, 1.0);
      return;
    }
  }

  vec3 col = mix(uSkyBottom, uSkyTop, y);

  vec3 base = uBandBase + textureLod(uPath, vec2(u, 0.25), 0.0).rgb;
  vec3 amp = textureLod(uPath, vec2(u, 0.75), 0.0).rgb * uGain;
  float xh = frag.x / uResolution.y;
  vec3 fine = textureLod(uRays, vec2(xh * ${glslFloat(RAY_SCALE_FINE)} + uRayDrift.x, 0.5), 0.0).rgb;
  vec3 coarse = textureLod(uRays, vec2(xh * ${glslFloat(RAY_SCALE_COARSE)} + uRayDrift.y, 0.5), 0.0).rgb;

  vec3 d = vec3(y) - base;
  // Long fade upwards, short fade downwards.
  vec3 f = exp2(min(d, 0.0) * uFalloff.y - max(d, 0.0) * uFalloff.x);
  vec3 w = amp * f * (0.25 + fine * (0.55 + coarse));
  vec3 t = clamp(d * uColorSpan, 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t);
  vec3 aurora = uLow * (w.x + w.y + w.z) + (uHigh - uLow) * dot(w, t);
  // Soft saturation so overlapping bands don't clip harshly.
  col += 1.0 - exp2(-aurora);

  col = mix(col, uSilhouette, cover);
  outColor = vec4(col + dither, 1.0);
}
`;

const STAR_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** x, y (0..1, y up), radius (1080p px), brightness. */
layout(location = 1) in vec4 aStar;
/** Twinkle phase and rate (rad/s). */
layout(location = 2) in vec2 aTwinkle;
uniform vec2 uResolution;
uniform float uScale;
uniform float uTime;
out vec2 vLocal;
out float vBright;
void main() {
  float r = max(aStar.z * uScale, 0.5);
  // One pixel of margin so the soft edge is never clipped.
  float ext = r + 1.0;
  vec2 px = aStar.xy * uResolution + aCorner * ext;
  vLocal = aCorner * ext / r;
  vBright = aStar.w * (0.65 + 0.35 * sin(uTime * aTwinkle.y + aTwinkle.x));
  gl_Position = vec4(px / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

const STAR_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
in float vBright;
out vec4 outColor;
void main() {
  float c = clamp(1.0 - dot(vLocal, vLocal), 0.0, 1.0);
  outColor = vec4(vec3(0.85, 0.9, 1.0) * (c * c * vBright), 1.0);
}
`;

const toHorizonKind = (v: string): HorizonKind =>
  v === "hills" || v === "pines" || v === "none" ? v : "none";

/**
 * Northern lights: rippling green-to-purple curtains with fine vertical rays over
 * a starry night sky, optionally above a hill or pine-tree silhouette.
 */
export const aurora = defineEffect(auroraMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const u = createUniforms(gl, program, [
        "uResolution",
        "uPath",
        "uBandBase",
        "uRays",
        "uHorizon",
        "uRayDrift",
        "uSkyTop",
        "uSkyBottom",
        "uSilhouette",
        "uLow",
        "uHigh",
        "uFalloff",
        "uColorSpan",
        "uGain",
        "uHorizonTop",
      ]);
      gl.useProgram(program);
      u.i1("uPath", 0);
      u.f3("uBandBase", BAND_BASE[0], BAND_BASE[1], BAND_BASE[2]);
      u.i1("uRays", 1);
      u.i1("uHorizon", 2);
      u.f2("uFalloff", 1 / HALF_UP, 1 / HALF_DOWN);
      u.f1("uColorSpan", 1 / COLOR_SPAN);

      const starProgram = scope.add(createProgram(gl, STAR_VERTEX, STAR_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const starU = createUniforms(gl, starProgram, ["uResolution", "uScale", "uTime"]);
      const stars = scope.own(createSpriteBatch(gl, MAX_STARS, [4, 2]));
      gl.useProgram(null);

      const path = scope.own(createColumnTable(gl, PATH_COLS, 4, { rows: 2 }));
      const rays = scope.own(
        createColumnTable(gl, RAY_COLS, 4, { wrap: gl.REPEAT, data: getRayTable() }),
      );
      let horizon: ColumnTable | null = null;
      scope.defer(() => horizon?.dispose());

      const noise = createNoise(1337);
      const skyRgb = unitRgbMemo();

      let width = 1;
      let height = 1;
      let scale = 1;
      let sizeDirty = true;
      let horizonKind: HorizonKind | undefined;
      let horizonTable: Float32Array = new Float32Array(2);
      let horizonTop = -1;
      let starDensity = Number.NaN;
      let starCount = 0;

      /** Curtain noise time and ray drifts (wrapped to one table period). */
      let pathTime = 0;
      /** Fade of bands 2 and 3, 0..1; NaN before the first frame, which starts at its target. */
      let band2 = Number.NaN;
      let band3 = Number.NaN;
      let driftFine = 0;
      let driftCoarse = 0;
      let twinkleTime = 0;
      /** The time and aspect the path table was last built for (NaN: never). */
      let builtPathTime = Number.NaN;
      let builtAspect = Number.NaN;

      const rebuildHorizon = (kind: HorizonKind) => {
        const cols = kind === "none" ? 1 : Math.min(2048, Math.max(16, Math.ceil(width / 2)));
        horizonTable = buildHorizonTable(kind, cols, width / height);
        horizonTop = kind === "none" ? -1 : horizonMax(horizonTable) * height + 2;
        horizon?.dispose();
        horizon = null; // so a failed create below can't dispose it twice
        horizon = createColumnTable(gl, cols, 2, { data: horizonTable });
        gl.useProgram(program);
        u.f1("uHorizonTop", horizonTop);
      };

      return {
        resize(v) {
          if (v.width !== width || v.height !== height) sizeDirty = true;
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const speed = p.speed;
          pathTime += dt * speed * 0.05;
          driftFine = (driftFine + dt * speed * 0.004) % 1;
          driftCoarse = (driftCoarse - dt * speed * 0.0025) % 1;
          twinkleTime = (twinkleTime + dt * speed) % TWINKLE_PERIOD;

          const kind = toHorizonKind(p.horizon);
          let starsDirty = false;
          if (sizeDirty || kind !== horizonKind) {
            sizeDirty = false;
            horizonKind = kind;
            rebuildHorizon(kind);
            starsDirty = true;
          }
          if (starsDirty || p.stars !== starDensity) {
            starDensity = p.stars;
            starCount = buildStars(
              stars.data,
              auroraStarCount(starDensity, width, height),
              horizonTable,
            );
            stars.upload(starCount);
          }

          gl.useProgram(program);
          u.rgb("uLow", p.lowColor);
          u.rgb("uHigh", p.highColor);
          const sky = skyRgb(p.sky);
          const sr = sky[0];
          const sg = sky[1];
          const sb = sky[2];
          u.f3("uSkyTop", sr, sg, sb);
          u.f3("uSkyBottom", sr * 0.22, sg * 0.22, sb * 0.22);
          u.f3("uSilhouette", sr * 0.07, sg * 0.07, sb * 0.07);
          const g = p.intensity;
          // Bands fade in and out over a second when the band count changes.
          const want2 = p.bands >= 1.5 ? 1 : 0;
          const want3 = p.bands >= 2.5 ? 1 : 0;
          if (Number.isNaN(band2)) {
            band2 = want2;
            band3 = want3;
          }
          const bandStep = Math.max(0, dt) / BAND_FADE;
          band2 = approach(band2, want2, bandStep);
          band3 = approach(band3, want3, bandStep);
          u.f3("uGain", BAND_GAIN[0] * g, BAND_GAIN[1] * g * band2, BAND_GAIN[2] * g * band3);
          u.f2("uResolution", width, height);
          u.f2("uRayDrift", driftFine, driftCoarse);

          // The table only moves with time, so a paused aurora skips the rebuild and upload.
          const aspect = width / height;
          const pathDirty = pathTime !== builtPathTime || aspect !== builtAspect;
          if (pathDirty) {
            builtPathTime = pathTime;
            builtAspect = aspect;
            buildPathTable(path.data, PATH_COLS, aspect, pathTime, noise);
          }

          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, horizon?.texture ?? null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, rays.texture);
          gl.activeTexture(gl.TEXTURE0);
          if (pathDirty) path.upload();
          else gl.bindTexture(gl.TEXTURE_2D, path.texture);
          triangle.draw();

          if (starCount > 0) {
            gl.enable(gl.BLEND);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.useProgram(starProgram);
            starU.f2("uResolution", width, height);
            starU.f1("uScale", scale);
            starU.f1("uTime", twinkleTime);
            stars.draw(0, starCount);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
