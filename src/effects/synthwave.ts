import { hexToUnitRgb, mixRgb, type Rgb } from "./color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  FULLSCREEN_VERTEX,
  getUniforms,
  glslFloat,
  resetUnpackState,
  withScope,
} from "./gl";
import { defineEffect } from "./types";

/** Points per mountain ridge (2^n + 1 for midpoint displacement). */
const RIDGE_POINTS = 129;
/** Farthest grid depth drawn, in camera heights. */
const Z_FAR = 30;
/** Depth used to decide how many vertical lines can be visible at the sides. */
const Z_VISIBLE = 14;
const MAX_VERTICAL_LINES = 400;
const SUN_STRIPES = 7;
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [1, 1, 1];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Length of [a, b] inside the pixel row centred on y. */
const overlap = (a: number, b: number, y: number) =>
  Math.max(0, Math.min(b, y + 0.5) - Math.max(a, y - 0.5));

/** Box-filtered coverage of a line of width w at signed distance d from the pixel centre. */
const lineCov = (d: number, w: number) =>
  clamp(Math.min(d + 0.5 * w, 0.5) - Math.max(d - 0.5 * w, -0.5), 0, 1);

/** Floats per row of the row texture: three RGBA texels (see uRows in the shader). */
const ROW_FLOATS = 12;

/** Small seeded PRNG so the mountains are identical every time. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Fills `out` with a 0..1 ridge line using midpoint displacement. */
const generateRidge = (out: Float32Array, seed: number, roughness: number) => {
  const rand = mulberry32(seed);
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
  for (let i = 0; i <= last; i++) out[i] = (out[i] - min) / range;
};

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
  const rows: [number, number][] = [
    [1987, 0.55],
    [2049, 0.5],
  ];
  rows.forEach(([seed, roughness], row) => {
    generateRidge(ridge, seed, roughness);
    for (let i = 0; i <= last; i++) {
      // Keep the middle low so the sun stays visible.
      const env = 0.2 + 0.8 * smoothstep(0.08, 0.42, Math.abs(i / last - 0.5));
      data[row * RIDGE_POINTS + i] = ridge[i] * env;
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
/** Horizon y, vanishing point x, projection constant (ground at depth z is at hy + k / z). */
uniform vec3 uHorizon;
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

const int RIDGE_LAST = ${RIDGE_POINTS - 1};
const float RIDGE_SEGMENTS = ${glslFloat(RIDGE_POINTS - 1)};

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

  // Haze band hugging the horizon, then CRT scanlines.
  vec4 post = texelFetch(uRows, ivec2(1, row), 0);
  outColor = vec4(clamp(col * post.a + post.rgb, 0.0, 1.0), 1.0);
}
`;

let ridgeData: Float32Array | undefined;
/** The ridges are deterministic, so build them once and reuse them across instances. */
const getRidgeData = () => (ridgeData ??= buildRidgeData());

let ridgeMaxStep: [number, number] | undefined;
/** Largest height change between neighbouring ridge points, per row (0..1 units). */
const getRidgeMaxStep = () =>
  (ridgeMaxStep ??= [0, 1].map((row) => {
    const data = getRidgeData();
    let max = 0;
    for (let i = 1; i < RIDGE_POINTS; i++) {
      const at = row * RIDGE_POINTS + i;
      max = Math.max(max, Math.abs(data[at] - data[at - 1]));
    }
    return max;
  }) as [number, number]);

interface Palette {
  key: string;
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
  key: string,
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
    key,
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
 * Retro 80s horizon: gradient sky, striped sun, mountain silhouettes and a neon
 * perspective grid rolling toward the viewer, drawn by one WebGL2 fragment shader
 * with analytically anti-aliased lines.
 */
export const synthwave = defineEffect({
  id: "synthwave",
  name: "Synthwave Grid",
  description:
    "A retro 80s neon horizon with a striped sun, mountains and a glowing grid rolling toward you.",
  params: {
    speed: { kind: "number", label: "Speed", min: 0, max: 5, step: 0.1, default: 1 },
    gridColor: { kind: "color", label: "Grid colour", default: "#ff3fd2" },
    gridGlow: { kind: "number", label: "Grid glow", min: 0, max: 1, step: 0.01, default: 0.6 },
    gridSize: {
      kind: "number",
      label: "Grid cell size",
      min: 0.2,
      max: 1.2,
      step: 0.05,
      default: 0.5,
    },
    skyTop: { kind: "color", label: "Sky top colour", default: "#0a0220" },
    skyBottom: { kind: "color", label: "Sky horizon colour", default: "#6a1a7a" },
    sunTop: { kind: "color", label: "Sun top colour", default: "#ffe45c" },
    sunBottom: { kind: "color", label: "Sun bottom colour", default: "#ff2a8a" },
    sunSize: { kind: "number", label: "Sun size", min: 0.05, max: 0.45, step: 0.01, default: 0.24 },
    sunGlow: { kind: "number", label: "Sun glow", min: 0, max: 1, step: 0.01, default: 0.5 },
    sunStripes: { kind: "boolean", label: "Sun stripes", default: true },
    mountains: { kind: "boolean", label: "Mountains", default: true },
    horizon: {
      kind: "number",
      label: "Horizon height",
      min: 0.25,
      max: 0.75,
      step: 0.01,
      default: 0.45,
    },
    sway: { kind: "number", label: "Camera sway", min: 0, max: 1, step: 0.01, default: 0.15 },
    scanlines: { kind: "boolean", label: "CRT scanlines", default: false },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ridgeTex = scope.add(
        createDataTexture(gl, {
          width: RIDGE_POINTS,
          height: 2,
          // R16F is filterable in core WebGL2 and accepts FLOAT data; R32F is not.
          internalFormat: gl.R16F,
          format: gl.RED,
          type: gl.FLOAT,
          data: getRidgeData(),
        }),
        (t) => gl.deleteTexture(t),
      );
      const loc = getUniforms(gl, program, [
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
      gl.uniform1i(loc.uRidge, 0);
      gl.uniform1i(loc.uRows, 1);
      gl.useProgram(null);

      /*
       * Per-row values (sky gradient, sun stripes, horizontal grid lines, haze,
       * scanlines) are the same across each row, so they are computed once per row
       * here rather than once per pixel, and uploaded as a tiny float texture.
       */
      const rowTex = scope.add(gl.createTexture(), (t) => gl.deleteTexture(t));
      gl.bindTexture(gl.TEXTURE_2D, rowTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      let rows = new Float32Array(0);
      /** Rows allocated in rowTex; 0 forces (re)allocation. */
      let rowCount = 0;

      const gaps = new Float64Array(SUN_STRIPES * 2);
      const [backStep, frontStep] = getRidgeMaxStep();
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
          const key = `${p.skyTop}|${p.skyBottom}|${p.gridColor}|${p.sunTop}|${p.sunBottom}`;
          if (palette?.key !== key) {
            palette = buildPalette(key, p.skyTop, p.skyBottom, p.gridColor, p.sunTop, p.sunBottom);
            const pc = palette;
            gl.uniform3fv(loc.uSunTop, pc.sunTop);
            gl.uniform3fv(loc.uSunBottom, pc.sunBottom);
            gl.uniform3fv(loc.uSunGlowColor, pc.sunGlow);
            gl.uniform3fv(loc.uBackColor, pc.backColor);
            gl.uniform3fv(loc.uGround, pc.ground);
            gl.uniform3fv(loc.uGrid, pc.grid);
            gl.uniform3f(loc.uVCore, pc.core[0] * 0.9, pc.core[1] * 0.9, pc.core[2] * 0.9);
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
          const sunTop = sunY - r;
          const sunClip = Math.min(sunY + r, hy + 1);
          // Cut-out gaps drift downward and widen toward the bottom of the sun.
          const regionTop = sunY - r * 0.15;
          const regionH = sunY + r - regionTop;
          const maxGap = (regionH / SUN_STRIPES) * 0.75;
          for (let i = 0; i < SUN_STRIPES; i++) {
            const u = (i + stripePhase) / SUN_STRIPES;
            const centre = regionTop + u * regionH;
            const gap = p.sunStripes ? maxGap * u * u * 0.4 + maxGap * u * 0.6 : 0;
            // Clipped to the disc's drawn span, as the coverage below needs.
            gaps[i * 2] = Math.max(centre - gap / 2, sunTop);
            gaps[i * 2 + 1] = Math.min(centre + gap / 2, sunClip);
          }

          // Horizontal lines sit at Z_FAR - ((Z_FAR + scroll) % cell) - m * cell.
          const zTop = Z_FAR - ((Z_FAR + scroll) % cell);
          const zPhase = zTop % cell;
          const zMax = zTop + cell / 2;
          const yFar = hy + k / Z_FAR;
          const halfWorld = ((width / 2) * Z_VISIBLE) / k + Math.abs(camX);
          const lines = Math.min(MAX_VERTICAL_LINES, Math.ceil(halfWorld / cell));
          const scanPeriod = p.scanlines ? Math.max(2, Math.round(4 * scale)) : 0;
          const scanThick = Math.max(1, Math.round(scanPeriod / 2));
          const glowW = (2 + 10 * p.gridGlow) * scale;
          const coreW = 1.6 * scale;
          const glowA = 0.22 * p.gridGlow;
          const hazeH = height * 0.07;
          const groundH = height - hy;

          // Per-row values, bottom row first (gl_FragCoord.y = r + 0.5).
          const n = Math.max(1, Math.ceil(height));
          if (n !== rowCount) {
            rows = new Float32Array(n * ROW_FLOATS);
            rowCount = 0;
          }
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
              for (let i = 0; i < SUN_STRIPES * 2; i += 2) cy -= overlap(gaps[i], gaps[i + 1], y);
            }
            rows[o + 3] = clamp(cy, 0, 1);

            // Haze, then scanlines: (mix(col, haze, h)) * s = col * a + rgb.
            const h = 0.45 * Math.max(0, 1 - Math.abs(y - hy) / hazeH);
            const s = scanPeriod > 0 && Math.floor(y) % scanPeriod < scanThick ? 0.84 : 1;
            rows[o + 4] = haze[0] * h * s;
            rows[o + 5] = haze[1] * h * s;
            rows[o + 6] = haze[2] * h * s;
            rows[o + 7] = (1 - h) * s;

            // Horizontal grid lines at evenly spaced depths. Separate strokes in 2D, so they add.
            const dy = y - hy;
            let hg = 0;
            let hc = 0;
            let vmask = 0;
            if (dy > 0) {
              const tv = dy / groundH;
              const fv =
                tv < 0.08 ? (tv / 0.08) * 0.25 : Math.min(1, 0.25 + ((tv - 0.08) / 0.22) * 0.75);
              vmask = clamp(y + 0.5 - yFar, 0, 1) * fv;
              const z = k / dy;
              const j0 = Math.floor((z - zPhase) / cell);
              for (let j = j0 - 2; j <= j0 + 2; j++) {
                const zj = zPhase + j * cell;
                if (zj <= 0 || zj >= zMax) continue;
                const yj = hy + k / zj;
                const th = clamp(1.2 / zj, 0.35, 1.8);
                const fade = smoothstep(0, 0.3, (yj - hy) / groundH);
                hg += fade * lineCov(y - yj, glowW * th);
                hc += fade * lineCov(y - yj, coreW * th);
              }
              // Where lines crowd closer than a pixel, fade to their average coverage.
              const spacingH = (k * cell) / (z * z);
              const thz = clamp(1.2 / z, 0.35, 1.8);
              const avgH =
                ((smoothstep(0, 0.3, tv) * thz) / spacingH) * clamp((zMax - z) / cell, 0, 1);
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

          // Highest row either ridge can affect: its peak, plus how far the
          // anti-aliasing (and the front edge line) reaches up a steep slope,
          // plus a little slack for half-float rounding.
          const ridgeSpan = 1.16 * width;
          const backH = height * 0.16;
          const frontH = height * 0.09;
          const edgeWidth = 1.5 * scale;
          const backS = (backStep * backH * (RIDGE_POINTS - 1)) / ridgeSpan;
          const frontS = (frontStep * frontH * (RIDGE_POINTS - 1)) / ridgeSpan;
          const mountainTop =
            hy +
            1 -
            Math.max(
              backH + 0.5 * Math.sqrt(1 + backS * backS),
              frontH + (0.5 * edgeWidth + 0.5) * Math.sqrt(1 + frontS * frontS),
            ) -
            2;

          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, rowTex);
          resetUnpackState(gl);
          if (rowCount !== n) {
            rowCount = n;
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 3, n, 0, gl.RGBA, gl.FLOAT, rows);
          } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 3, n, gl.RGBA, gl.FLOAT, rows);
          }
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, ridgeTex);

          gl.uniform2f(loc.uResolution, width, height);
          gl.uniform3f(loc.uHorizon, hy, vpx, k);
          gl.uniform1f(loc.uCamX, camX);
          gl.uniform3f(loc.uSun, vpx, sunY, r);
          gl.uniform1f(loc.uSunClip, sunClip);
          gl.uniform1f(loc.uSunGlow, p.sunGlow);
          gl.uniform2f(loc.uRidgeSpan, -0.08 * width, ridgeSpan);
          gl.uniform2f(loc.uRidgeShift, -camX * k * 0.01, -camX * k * 0.025);
          gl.uniform2f(loc.uRidgeHeight, backH, frontH);
          gl.uniform1f(loc.uMountains, p.mountains ? 1 : 0);
          gl.uniform1f(loc.uMountainTop, mountainTop);
          gl.uniform3f(loc.uVGlow, c.grid[0] * glowA, c.grid[1] * glowA, c.grid[2] * glowA);
          gl.uniform1f(loc.uEdgeWidth, edgeWidth);
          gl.uniform2f(loc.uLine, glowW, coreW);
          gl.uniform1f(loc.uCell, cell);
          gl.uniform1f(loc.uInvCell, 1 / cell);
          gl.uniform1f(loc.uLines, lines);
          triangle.draw();
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
