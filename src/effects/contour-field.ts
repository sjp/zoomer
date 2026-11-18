/**
 * Contour lines from a smooth scalar field rendered at reduced resolution: the
 * field's two-channel height encoding (precise enough for thin lines), a
 * 4-tap cubic B-spline sampler (C2, so lines have no kinks at texel edges) and
 * the screen-space level distance that constant-width lines are drawn from.
 */
import { glslFloat } from "./gl";

/** Scale of the residual channel in the RGBA16F encoding (see `ENCODE_HEIGHT_GLSL`). */
export const RESIDUAL_SCALE = 1024;
/** Steps per byte of the RGBA8 fallback encoding (see `ENCODE_HEIGHT_GLSL`). */
export const HEIGHT_BYTE = 255;

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
 * a pair of texels linearly. `textureBSpline` in the shader is generated from the
 * same basis and tap offsets.
 */
export function bsplineTaps(t: number): { g0: number; g1: number; o0: number; o1: number } {
  const [w0, w1, w2, w3] = bsplineWeights(t);
  const g0 = w0 + w1;
  const g1 = w2 + w3;
  return { g0, g1, o0: w1 / g0, o1: w3 / g1 };
}

/**
 * RGBA8 fallback encoding of a height in [0, 1), as `encodeHeight` writes it:
 * hi and lo bytes with h = hi/255 + lo/255².
 */
export function packHeight8(h: number): [number, number] {
  const s = Math.min(Math.max(h, 0), 1) * HEIGHT_BYTE;
  const hi = Math.floor(s);
  return [hi, Math.round((s - hi) * HEIGHT_BYTE)];
}

/** The weight of the second channel in `decodeHeight`, for each encoding. */
export function heightDecodeScale(isFloat: boolean): number {
  return isFloat ? 1 / RESIDUAL_SCALE : 1 / HEIGHT_BYTE;
}

/**
 * Height from the field texture's two channels (as sampled, 0..1 for RGBA8) and
 * `heightDecodeScale`, as the shaders decode it. Linear, so it survives filtering.
 */
export function decodeHeight(r: number, g: number, scale: number): number {
  return r + g * scale;
}

/**
 * GLSL `vec2 encodeHeight(float h, float isFloat)`: a height in [0, 1) as two
 * channels, decoded as h = r + g * `heightDecodeScale`, which is linear and so
 * filters:
 * - RGBA16F (`isFloat` 1): r = h rounded to half precision (exact in the
 *   target), g = the rounding residual * 1024. About 22 bits instead of half
 *   float's 11.
 * - RGBA8 fallback (`isFloat` 0): r = hi byte, g = lo byte; 16 bits.
 */
export const ENCODE_HEIGHT_GLSL = /* glsl */ `
vec2 encodeHeight(float h, float isFloat) {
  vec2 enc;
  if (isFloat > 0.5) {
    float hr = unpackHalf2x16(packHalf2x16(vec2(h, 0.0))).x;
    enc = vec2(hr, (h - hr) * ${glslFloat(RESIDUAL_SCALE)});
  } else {
    float s = h * ${glslFloat(HEIGHT_BYTE)};
    float hi = floor(s);
    enc = vec2(hi / ${glslFloat(HEIGHT_BYTE)}, s - hi);
  }
  return enc;
}
`;

/**
 * GLSL `vec4 textureBSpline(sampler2D tex, vec2 size, vec2 uv)`: a cubic
 * B-spline sample of the linear-filtered `size`-texel texture `tex` at `uv`,
 * in four bilinear fetches.
 */
export const BSPLINE_GLSL = /* glsl */ `
vec4 textureBSpline(sampler2D tex, vec2 size, vec2 uv) {
  vec2 st = uv * size - 0.5;
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
  vec2 inv = 1.0 / size;
  vec2 c0 = (i + ${glslFloat(BSPLINE_TAP_BASE[0] + 0.5)} + w1 / g0) * inv;
  vec2 c1 = (i + ${glslFloat(BSPLINE_TAP_BASE[1] + 0.5)} + w3 / g1) * inv;
  vec4 a = texture(tex, c0);
  vec4 b = texture(tex, vec2(c1.x, c0.y));
  vec4 c = texture(tex, vec2(c0.x, c1.y));
  vec4 d = texture(tex, c1);
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}
`;

/**
 * GLSL `vec3 contourLevel(float x)`: for a field in level units (`x` = level
 * index, so level k is where x = k), the nearest level k, the signed distance
 * to it in px and the field's gradient in levels per px. A line of half width
 * hw covers `clamp(hw + 0.5 - abs(distance), 0.0, 1.0)` of a pixel.
 */
export const CONTOUR_LEVEL_GLSL = /* glsl */ `
vec3 contourLevel(float x) {
  // Level units per pixel; length() rather than fwidth() so width is isotropic.
  float grad = max(length(vec2(dFdx(x), dFdy(x))), 1e-6);
  float k = floor(x + 0.5);
  return vec3(k, (x - k) / grad, grad);
}
`;
