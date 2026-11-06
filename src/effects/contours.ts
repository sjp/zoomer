import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { createLowResTarget } from "./lowres";
import { wrap } from "./math";
import { contoursMeta } from "./contours.meta";
import { defineEffect } from "./types";

/**
 * Rows of the low-res height field, whatever the canvas size: 270 rows is 1/4 of
 * 1080p and 1/8 of 4K, so the terrain has the same detail at every resolution.
 */
export const FIELD_ROWS = 270;
/** Noise-space z (time) advanced per second at speed 1. */
const Z_RATE = 0.04;
/**
 * The shader's simplex noise repeats exactly in z with this period: a z shift of
 * 3k moves the skewed lattice by (k, k, 4k) and leaves the cell offsets unchanged,
 * and `mod(i, 289)` makes the hash repeat when k is a multiple of 289. So z can wrap
 * on the CPU without a seam (proved against a CPU port in contours.test.ts).
 */
export const Z_PERIOD = 3 * 289;

/**
 * Advances noise z by `dz`, wrapped into [-Z_PERIOD / 2, Z_PERIOD / 2) so the
 * float32 uniform keeps its precision however long the effect runs. Centring the
 * range halves the largest |z| and so the worst-case float32 step error.
 */
export function advanceZ(z: number, dz: number): number {
  return wrap(z + dz, -Z_PERIOD / 2, Z_PERIOD);
}
/** Index contours are this much wider than ordinary lines. */
const INDEX_WIDTH = 1.8;
/** Opacity of ordinary and index lines. */
const LINE_ALPHA = 0.7;
const INDEX_ALPHA = 1;
/** Scale of the residual channel in the RGBA16F encoding (see `NOISE_FRAGMENT`). */
export const RESIDUAL_SCALE = 1024;
/** Steps per byte of the RGBA8 fallback encoding (see `NOISE_FRAGMENT`). */
export const HEIGHT_BYTE = 255;
/**
 * Offset of a level's own band and index test from the level: bands take the
 * colour of their mid-height, and level k is tested at k + LEVEL_CENTRE so float
 * error can't flip it.
 */
export const LEVEL_CENTRE = 0.5;

/** Canvas-to-field divisor that gives `FIELD_ROWS` rows; never below 1. */
export function fieldDivisor(height: number): number {
  return Math.max(1, height / FIELD_ROWS);
}

/**
 * Cubic B-spline basis: the weight of each of the four taps around a sample at
 * fraction `t` past texel i (taps i-1, i, i+1, i+2) as a polynomial in `t`, by
 * coefficient of 1, t, t² and t³. The shader's weights are generated from it.
 */
export const BSPLINE_BASIS: readonly (readonly [number, number, number, number])[] = [
  [1 / 6, -3 / 6, 3 / 6, -1 / 6],
  [4 / 6, 0, -6 / 6, 3 / 6],
  [1 / 6, 3 / 6, 3 / 6, -3 / 6],
  [0, 0, 0, 1 / 6],
];

/** Evaluates a cubic `c` at `t`. */
const cubic = (c: readonly number[], t: number) => c[0] + t * (c[1] + t * (c[2] + t * c[3]));

/** GLSL for cubic `c` in the variables `t`, `t2` and `t3`. */
const cubicGlsl = (c: readonly number[]) =>
  `${glslFloat(c[0])} + ${glslFloat(c[1])} * t + ${glslFloat(c[2])} * t2 + ${glslFloat(c[3])} * t3`;

/** Cubic B-spline weights of the taps i-1, i, i+1 and i+2 at fraction `t` (0..1). They sum to 1. */
export function bsplineWeights(t: number): [number, number, number, number] {
  const [b0, b1, b2, b3] = BSPLINE_BASIS;
  return [cubic(b0, t), cubic(b1, t), cubic(b2, t), cubic(b3, t)];
}

/** Texel offsets from i of the two bilinear taps' pairs: (i-1, i) and (i+1, i+2). */
export const BSPLINE_TAP_BASE = [-1, 1] as const;

/**
 * The B-spline as two bilinear taps per axis (Sigg & Hadwiger, GPU Gems 2 ch. 20):
 * weight `g0` at texel position `i + BSPLINE_TAP_BASE[0] + o0`, weight `g1` at
 * `i + BSPLINE_TAP_BASE[1] + o1`, where `o0`, `o1` are in [0, 1] so each tap blends
 * a pair of texels linearly. `sampleBSpline` in the shader is generated from the
 * same basis and tap offsets.
 */
export function bsplineTaps(t: number): { g0: number; g1: number; o0: number; o1: number } {
  const [w0, w1, w2, w3] = bsplineWeights(t);
  const g0 = w0 + w1;
  const g1 = w2 + w3;
  return { g0, g1, o0: w1 / g0, o1: w3 / g1 };
}

/**
 * RGBA8 fallback encoding of a height in [0, 1), as the 8-bit branch of
 * `NOISE_FRAGMENT` writes it: hi and lo bytes with h = hi/255 + lo/255².
 */
export function packHeight8(h: number): [number, number] {
  const s = Math.min(Math.max(h, 0), 1) * HEIGHT_BYTE;
  const hi = Math.floor(s);
  return [hi, Math.round((s - hi) * HEIGHT_BYTE)];
}

/** `uDecode`: the weight of the second channel in `decodeHeight`, for each encoding. */
export function heightDecodeScale(isFloat: boolean): number {
  return isFloat ? 1 / RESIDUAL_SCALE : 1 / HEIGHT_BYTE;
}

/**
 * The shader's `decode`: height from the field texture's two channels (as sampled,
 * 0..1 for RGBA8) and `heightDecodeScale`. Linear, so it survives filtering.
 */
export function decodeHeight(r: number, g: number, scale: number): number {
  return r + g * scale;
}

/** `uIndexInv`: 1 / `every` (rounded), or 0 when index contours are off. */
export function indexInv(every: number): number {
  const n = Math.round(every);
  return n >= 1 ? 1 / n : 0;
}

/** Whether contour level `k` is an index contour, for `inv` from `indexInv`, as the shader tests it. */
export function isIndexLevel(k: number, inv: number): boolean {
  if (!(inv > 0)) {
    return false;
  }
  const r = (k + LEVEL_CENTRE) * inv;
  return r - Math.floor(r) < inv;
}

export type FillMode = "none" | "bands" | "smooth";

const FILL_UNIFORMS: Readonly<Record<FillMode, readonly [number, number]>> = {
  none: [0, 0],
  bands: [1, 1],
  smooth: [1, 0],
};

/** `uFill` for a fill mode: x is 1 if filled, y is 1 for bands and 0 for smooth (the default). */
export function fillUniform(mode: string): readonly [number, number] {
  return mode === "none" || mode === "bands" ? FILL_UNIFORMS[mode] : FILL_UNIFORMS.smooth;
}

/**
 * Fill colour position (0 = low colour, 1 = high colour) for height `h` in [0, 1]
 * with `levels` contour intervals and `fill` from `fillUniform`, as the shader
 * computes it away from its 1 px anti-aliasing across band edges. Bands take the
 * colour of their mid-height.
 */
export function fillT(h: number, levels: number, fill: readonly [number, number]): number {
  if (fill[0] === 0) {
    return 0;
  }
  const smooth = Math.min(Math.max(h, 0), 1);
  const band = Math.floor(h * levels);
  const banded = Math.min(Math.max((band + LEVEL_CENTRE) / levels, 0), 1);
  return smooth + (banded - smooth) * fill[1];
}

export interface LineStyle {
  /** Half widths in device px of ordinary and index lines, at least 0.5 (1 px lines). */
  halfWidth: number;
  indexHalfWidth: number;
  /** Opacity, reduced for lines thinner than 1 px instead of making them thinner. */
  alpha: number;
  indexAlpha: number;
  /** Line spacing in px over which lines fade out where they crowd together. */
  crowdStart: number;
  crowdEnd: number;
}

/** Device-pixel line style for `lineWidth` px at 1080p and viewport `scale`. */
export function lineStyle(lineWidth: number, scale: number): LineStyle {
  const w = Math.max(0, lineWidth * scale);
  const wi = w * INDEX_WIDTH;
  const ew = Math.max(w, 1);
  const ewi = Math.max(wi, 1);
  return {
    halfWidth: ew / 2,
    indexHalfWidth: ewi / 2,
    alpha: (LINE_ALPHA * w) / ew,
    indexAlpha: (INDEX_ALPHA * wi) / ewi,
    // Below ~2 line widths of clear space the lines would merge into moire.
    crowdStart: ew * 1.5 + 1,
    crowdEnd: ew * 3 + 2,
  };
}

/**
 * Low-res pass: 3 octaves of 3D simplex noise (time as z), soft-clipped to a
 * height in (0, 1). Simplex noise after Ashima Arts / Stefan Gustavson (MIT), with
 * the 2022 r^2 = 0.5 kernel, which unlike 0.6 has no discontinuities (they would
 * show as broken contours).
 *
 * Encoding, both decoded as h = r + g * uDecode, which is linear and so filters:
 * - RGBA16F: r = h rounded to half precision (exact in the target), g = the
 *   rounding residual * 1024. About 22 bits instead of half float's 11.
 * - RGBA8 fallback: r = hi byte, g = lo byte; 16 bits.
 */
export const NOISE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

/** Field position = gl_FragCoord.xy * uPixToWorld + uWorldOffset. */
uniform vec2 uPixToWorld;
uniform vec2 uWorldOffset;
uniform float uZ;
/** 1 for the RGBA16F encoding, 0 for RGBA8. */
uniform float uFloat;

out vec4 outColor;

vec4 permute(vec4 x) { return mod((x * 34.0 + 10.0) * x, 289.0); }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  const float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = normalize(vec3(a0.xy, h.x));
  vec3 p1 = normalize(vec3(a0.zw, h.y));
  vec3 p2 = normalize(vec3(a1.xy, h.z));
  vec3 p3 = normalize(vec3(a1.zw, h.w));
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

void main() {
  vec2 p = gl_FragCoord.xy * uPixToWorld + uWorldOffset;
  // Octave weights 1, 0.45, 0.2: broad hills with a little detail, normalised.
  float n = snoise(vec3(p, uZ));
  n += 0.45 * snoise(vec3(p * 2.03 + vec2(19.19, -7.31), uZ + 31.7));
  n += 0.2 * snoise(vec3(p * 4.11 + vec2(-3.77, 11.13), uZ + 57.3));
  n *= 1.0 / 1.65;
  // Soft clip keeps h in (0, 1) without flat clamped plateaus.
  float h = 0.5 + 0.5 * tanh(1.4 * n);
  vec2 enc;
  if (uFloat > 0.5) {
    float hr = unpackHalf2x16(packHalf2x16(vec2(h, 0.0))).x;
    enc = vec2(hr, (h - hr) * ${glslFloat(RESIDUAL_SCALE)});
  } else {
    float s = h * ${glslFloat(HEIGHT_BYTE)};
    float hi = floor(s);
    enc = vec2(hi / ${glslFloat(HEIGHT_BYTE)}, s - hi);
  }
  outColor = vec4(enc, 0.0, 1.0);
}
`;

/**
 * Full-res pass, run as the low-res target's composite: sample the height field
 * (B-spline or bilinear), then draw constant-width anti-aliased contour lines
 * from the screen-space gradient of h * levels, over the fill.
 */
export const COMPOSITE = /* glsl */ `
uniform float uDecode;
uniform float uBSpline;
uniform float uLevels;
uniform float uInvLevels;
/** 1 / indexEvery, or 0 when index contours are off. */
uniform float uIndexInv;
/** (ordinary, index) half widths in px and opacities. */
uniform vec2 uHalfWidth;
uniform vec2 uAlpha;
/** Line spacing in px over which crowded lines fade out. */
uniform vec2 uCrowd;
/** x: 1 if filled, y: 1 for bands, 0 for smooth. */
uniform vec2 uFill;
uniform vec3 uLineColor;
uniform vec3 uBackground;
uniform vec3 uLowColor;
uniform vec3 uHighColor;

float decode(vec2 t) { return t.x + t.y * uDecode; }

float sampleBSpline(vec2 uv) {
  vec2 st = uv * uLowResSize - 0.5;
  vec2 i = floor(st);
  vec2 t = st - i;
  vec2 t2 = t * t;
  vec2 t3 = t2 * t;
  // Weights from BSPLINE_BASIS; w2 is implied, as the weights sum to 1.
  vec2 w0 = ${cubicGlsl(BSPLINE_BASIS[0])};
  vec2 w1 = ${cubicGlsl(BSPLINE_BASIS[1])};
  vec2 w3 = ${cubicGlsl(BSPLINE_BASIS[3])};
  vec2 g0 = w0 + w1;
  vec2 g1 = 1.0 - g0;
  // Tap centres in texels (texel k is centred at k + 0.5), then in uv.
  vec2 inv = 1.0 / uLowResSize;
  vec2 c0 = (i + ${glslFloat(BSPLINE_TAP_BASE[0] + 0.5)} + w1 / g0) * inv;
  vec2 c1 = (i + ${glslFloat(BSPLINE_TAP_BASE[1] + 0.5)} + w3 / g1) * inv;
  vec2 a = texture(uLowRes, c0).rg;
  vec2 b = texture(uLowRes, vec2(c1.x, c0.y)).rg;
  vec2 c = texture(uLowRes, vec2(c0.x, c1.y)).rg;
  vec2 d = texture(uLowRes, c1).rg;
  return decode(g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d));
}

vec4 composite(vec2 uv) {
  float h;
  if (uBSpline > 0.5) {
    h = sampleBSpline(uv);
  } else {
    h = decode(texture(uLowRes, uv).rg);
  }
  float x = h * uLevels;
  // Level units per pixel; length() rather than fwidth() so width is isotropic.
  float grad = max(length(vec2(dFdx(x), dFdy(x))), 1e-6);
  float k = floor(x + 0.5);
  // Signed distance in px to the nearest level k.
  float sd = (x - k) / grad;
  bool isIndex = uIndexInv > 0.0 && fract((k + ${glslFloat(LEVEL_CENTRE)}) * uIndexInv) < uIndexInv;
  float hw = isIndex ? uHalfWidth.y : uHalfWidth.x;
  float alpha = isIndex ? uAlpha.y : uAlpha.x;
  // Box-filtered coverage of a line of width 2 * hw.
  float cov = clamp(hw + 0.5 - abs(sd), 0.0, 1.0);
  cov *= smoothstep(uCrowd.x, uCrowd.y, 1.0 / grad);

  // Bands blend across a 1 px edge at each level, so they don't alias.
  float band = k - 1.0 + clamp(sd + 0.5, 0.0, 1.0);
  float bandT = clamp((band + ${glslFloat(LEVEL_CENTRE)}) * uInvLevels, 0.0, 1.0);
  float t = mix(h, bandT, uFill.y);
  vec3 fill = mix(uBackground, mix(uLowColor, uHighColor, t), uFill.x);
  return vec4(mix(fill, uLineColor, cov * alpha), 1.0);
}
`;

/**
 * An animated topographic map: contour lines of a slowly morphing noise height
 * field. The field renders into a ~270-row texture; the full-res pass samples it
 * with a 4-tap B-spline (C2, so lines have no kinks) and draws lines from it.
 */
export const contours = defineEffect(contoursMeta, {
  create(gl) {
    return withScope((scope) => {
      const noiseProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, NOISE_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl, { format: "rgba16f", composite: COMPOSITE }));
      const nu = createUniforms(gl, noiseProgram, ["uPixToWorld", "uWorldOffset", "uZ", "uFloat"]);
      const cu = createUniforms(gl, target.program, [
        "uDecode",
        "uBSpline",
        "uLevels",
        "uInvLevels",
        "uIndexInv",
        "uHalfWidth",
        "uAlpha",
        "uCrowd",
        "uFill",
        "uLineColor",
        "uBackground",
        "uLowColor",
        "uHighColor",
      ]);

      let width = 1;
      let height = 1;
      let vpScale = 1;
      /** Noise z, kept in float64 on the CPU and wrapped to the noise's period. */
      let z = 0;
      let sizeDirty = true;
      let lastLineWidth = Number.NaN;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          vpScale = v.scale;
          sizeDirty = true;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          z = advanceZ(z, dt * p.speed * Z_RATE);

          // A resize may replace the target, losing the field.
          let fieldDirty = sizeDirty;
          if (sizeDirty) {
            target.resize(width, height, fieldDivisor(height));
            sizeDirty = false;
            lastLineWidth = Number.NaN;
          }

          // Height field pass, only when the field changed.
          gl.useProgram(noiseProgram);
          // Field units per frame height; the field is centred on the canvas.
          const freq = 1 / Math.max(0.01, p.scale);
          const aspect = width / height;
          if (nu.f1("uFloat", target.isFloat ? 1 : 0)) {
            fieldDirty = true;
          }
          if (nu.f2("uPixToWorld", (aspect * freq) / target.width, freq / target.height)) {
            fieldDirty = true;
          }
          if (nu.f2("uWorldOffset", -0.5 * aspect * freq + 3.7, -0.5 * freq - 1.9)) {
            fieldDirty = true;
          }
          if (nu.f1("uZ", z)) {
            fieldDirty = true;
          }
          if (fieldDirty) {
            target.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }

          // Full-res contour pass (the target's composite blit).
          gl.useProgram(target.program);
          cu.f1("uDecode", heightDecodeScale(target.isFloat));
          const levels = Math.max(1, p.levels);
          cu.f1("uLevels", levels);
          cu.f1("uInvLevels", 1 / levels);
          cu.f1("uIndexInv", indexInv(p.indexEvery));
          if (p.lineWidth !== lastLineWidth) {
            lastLineWidth = p.lineWidth;
            const s = lineStyle(p.lineWidth, vpScale);
            cu.f2("uHalfWidth", s.halfWidth, s.indexHalfWidth);
            cu.f2("uAlpha", s.alpha, s.indexAlpha);
            cu.f2("uCrowd", s.crowdStart, s.crowdEnd);
          }
          const fill = fillUniform(p.fill);
          cu.f2("uFill", fill[0], fill[1]);
          cu.f1("uBSpline", p.sampling === "bilinear" ? 0 : 1);
          cu.rgb("uLineColor", p.lineColor);
          cu.rgb("uBackground", p.background);
          cu.rgb("uLowColor", p.lowColor);
          cu.rgb("uHighColor", p.highColor);
          target.blit();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
