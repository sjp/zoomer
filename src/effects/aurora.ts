import { hexToUnitRgb, type Rgb, unitRgbMemo } from "./color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  getUniforms,
  resetUnpackState,
  withScope,
} from "./gl";
import { createNoise, createRng, fbm2, fbmPeriodic2, type Noise } from "./noise";
import { createSpriteBatch } from "./sprites";
import { defineEffect } from "./types";

/*
 * Aurora: one full-screen pass draws the sky gradient, up to three additive
 * curtain bands and the horizon silhouette; a small instanced sprite pass adds
 * the stars on top. Nothing is evaluated in 2D per pixel: everything that varies
 * along x lives in 1D tables.
 *
 * - Path table (PATH_COLS x 2, RGBA16F, rebuilt on the CPU each frame): row 0
 *   holds each band's base height, row 1 its brightness along x.
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
const BAND_BASE = [0.44, 0.6, 0.3] as const;
const BAND_GAIN = [1.6, 1.2, 1] as const;
/** How far each band's path wanders up and down, in canvas heights. */
const PATH_AMPLITUDE = 0.09;
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
 * table at `time`. Row 0: base height of bands 0..2 as a fraction of canvas height
 * from the bottom. Row 1: brightness of bands 0..2 along x, in 0.25..1. Column i
 * covers x = (i + 0.5) / cols of the canvas width; `aspect` is width / height so
 * that the noise is not stretched on wide screens. Alpha channels are 0.
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
      out[o + b] = BAND_BASE[b] + PATH_AMPLITUDE * wave;
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
/** Row 0: band base heights; row 1: band brightness. Linear, clamped. */
uniform sampler2D uPath;
/** Ridged ray noise, one pattern per channel. Linear, repeating. */
uniform sampler2D uRays;
/** Silhouette height (fraction of canvas height) and slope (px/px). */
uniform sampler2D uHorizon;
/** Fine and coarse ray scale (repeats per canvas height), then their drifts. */
uniform vec4 uRayUv;
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

  vec3 base = textureLod(uPath, vec2(u, 0.25), 0.0).rgb;
  vec3 amp = textureLod(uPath, vec2(u, 0.75), 0.0).rgb * uGain;
  float xh = frag.x / uResolution.y;
  vec3 fine = textureLod(uRays, vec2(xh * uRayUv.x + uRayUv.z, 0.5), 0.0).rgb;
  vec3 coarse = textureLod(uRays, vec2(xh * uRayUv.y + uRayUv.w, 0.5), 0.0).rgb;

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

const HORIZON_OPTIONS = [
  { value: "none", label: "None" },
  { value: "hills", label: "Hills" },
  { value: "pines", label: "Pines" },
] as const;

const toHorizonKind = (v: string): HorizonKind =>
  v === "hills" || v === "pines" || v === "none" ? v : "none";

const scaleRgb = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

/**
 * Northern lights: rippling green-to-purple curtains with fine vertical rays over
 * a starry night sky, optionally above a hill or pine-tree silhouette.
 */
export const aurora = defineEffect({
  id: "aurora",
  name: "Aurora",
  description:
    "Northern lights: slow green and purple curtains ripple over a starry night sky above a dark treeline.",
  params: {
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    intensity: { kind: "number", label: "Intensity", min: 0, max: 2, step: 0.05, default: 1 },
    bands: { kind: "number", label: "Bands", min: 1, max: 3, step: 1, default: 2 },
    lowColor: { kind: "color", label: "Base colour", default: "#3dff9a" },
    highColor: { kind: "color", label: "Top colour", default: "#9b5cff" },
    sky: { kind: "color", label: "Sky colour", default: "#0a1a3c" },
    stars: { kind: "number", label: "Stars", min: 0, max: 1, step: 0.05, default: 0.5 },
    horizon: { kind: "select", label: "Horizon", options: HORIZON_OPTIONS, default: "pines" },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const triangle = scope.own(createFullscreenTriangle(gl));
      const loc = getUniforms(gl, program, [
        "uResolution",
        "uPath",
        "uRays",
        "uHorizon",
        "uRayUv",
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
      gl.uniform1i(loc.uPath, 0);
      gl.uniform1i(loc.uRays, 1);
      gl.uniform1i(loc.uHorizon, 2);
      gl.uniform2f(loc.uFalloff, 1 / HALF_UP, 1 / HALF_DOWN);
      gl.uniform1f(loc.uColorSpan, 1 / COLOR_SPAN);

      const starProgram = scope.add(createProgram(gl, STAR_VERTEX, STAR_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const starLoc = getUniforms(gl, starProgram, ["uResolution", "uScale", "uTime"]);
      const stars = scope.own(createSpriteBatch(gl, MAX_STARS, [4, 2]));
      gl.useProgram(null);

      const pathData = new Float32Array(PATH_COLS * 2 * 4);
      const pathTex = scope.add(
        createDataTexture(gl, {
          width: PATH_COLS,
          height: 2,
          internalFormat: gl.RGBA16F,
          format: gl.RGBA,
          type: gl.FLOAT,
          data: pathData,
        }),
        (t) => gl.deleteTexture(t),
      );
      const rayTex = scope.add(
        createDataTexture(gl, {
          width: RAY_COLS,
          height: 1,
          internalFormat: gl.RGBA16F,
          format: gl.RGBA,
          type: gl.FLOAT,
          data: getRayTable(),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );
      let horizonTex: WebGLTexture | null = null;
      scope.defer(() => {
        if (horizonTex) gl.deleteTexture(horizonTex);
      });

      const noise = createNoise(1337);
      const lowRgb = unitRgbMemo();
      const highRgb = unitRgbMemo();
      let skyHex = "";
      let lastLow: Rgb | undefined;
      let lastHigh: Rgb | undefined;
      let lastGain = Number.NaN;
      let lastBands = Number.NaN;

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
      let driftFine = 0;
      let driftCoarse = 0;
      let twinkleTime = 0;

      const rebuildHorizon = (kind: HorizonKind) => {
        const cols = kind === "none" ? 1 : Math.min(2048, Math.max(16, Math.ceil(width / 2)));
        horizonTable = buildHorizonTable(kind, cols, width / height);
        horizonTop = kind === "none" ? -1 : horizonMax(horizonTable) * height + 2;
        if (horizonTex) gl.deleteTexture(horizonTex);
        horizonTex = createDataTexture(gl, {
          width: cols,
          height: 1,
          internalFormat: gl.RG16F,
          format: gl.RG,
          type: gl.FLOAT,
          data: horizonTable,
        });
        gl.useProgram(program);
        gl.uniform1f(loc.uHorizonTop, horizonTop);
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
            const aspectShare = Math.min(1.5, width / height / (16 / 9));
            const count = Math.round(starDensity * MAX_STARS * aspectShare);
            starCount = buildStars(stars.data, Math.min(MAX_STARS, count), horizonTable);
            stars.upload(starCount);
          }

          gl.useProgram(program);
          const low = lowRgb(p.lowColor);
          if (low !== lastLow) {
            lastLow = low;
            gl.uniform3fv(loc.uLow, low);
          }
          const high = highRgb(p.highColor);
          if (high !== lastHigh) {
            lastHigh = high;
            gl.uniform3fv(loc.uHigh, high);
          }
          if (p.sky !== skyHex) {
            skyHex = p.sky;
            const sky = hexToUnitRgb(skyHex);
            gl.uniform3fv(loc.uSkyTop, sky);
            gl.uniform3fv(loc.uSkyBottom, scaleRgb(sky, 0.22));
            gl.uniform3fv(loc.uSilhouette, scaleRgb(sky, 0.07));
          }
          if (p.intensity !== lastGain || p.bands !== lastBands) {
            lastGain = p.intensity;
            lastBands = p.bands;
            const g = p.intensity;
            gl.uniform3f(
              loc.uGain,
              BAND_GAIN[0] * g,
              p.bands >= 2 ? BAND_GAIN[1] * g : 0,
              p.bands >= 3 ? BAND_GAIN[2] * g : 0,
            );
          }
          gl.uniform2f(loc.uResolution, width, height);
          gl.uniform4f(loc.uRayUv, RAY_SCALE_FINE, RAY_SCALE_COARSE, driftFine, driftCoarse);

          buildPathTable(pathData, PATH_COLS, width / height, pathTime, noise);

          resetUnpackState(gl);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, horizonTex);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, rayTex);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, pathTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PATH_COLS, 2, gl.RGBA, gl.FLOAT, pathData);
          triangle.draw();

          if (starCount > 0) {
            gl.enable(gl.BLEND);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.useProgram(starProgram);
            gl.uniform2f(starLoc.uResolution, width, height);
            gl.uniform1f(starLoc.uScale, scale);
            gl.uniform1f(starLoc.uTime, twinkleTime);
            stars.draw(0, starCount);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
