/**
 * The Gradient Blobs field, shared with the effects that use it as a backdrop:
 * a handful of large Gaussian colour fields on slow two-harmonic Lissajous
 * paths, and the fragment shader that blends them in linear light over a base
 * colour. Callers render it at reduced resolution and upscale it.
 */
import { LINEAR_GAMMA } from "./color";
import { glslFloat } from "./gl";
import { createRng } from "./noise";
import { MAX_BLOBS } from "./blobs/blobs.meta";

const TAU = Math.PI * 2;
/** Weight of the background colour in the normalised blend; a blob centre weighs 1. */
const BASE_WEIGHT = 0.3;

/** Per-blob constants for a two-harmonic Lissajous path. Angular rates in rad/s at speed 1. */
interface BlobPath {
  ax: number;
  wx: number;
  px: number;
  wx2: number;
  px2: number;
  ay: number;
  wy: number;
  py: number;
  wy2: number;
  py2: number;
  /** Base radius as a fraction of frame height. */
  radius: number;
  wr: number;
  pr: number;
}

/** Amplitude of the second (wobble) harmonic, as a fraction of width/height. */
const WOBBLE = 0.07;
/** Relative radius breathing. */
const BREATHE = 0.15;

/** Deterministic path table. Phases are golden-ratio spaced so any prefix is spread out. */
export function makeBlobPaths(): BlobPath[] {
  const rng = createRng(4242);
  const paths: BlobPath[] = [];
  for (let i = 0; i < MAX_BLOBS; i++) {
    const g = (i * 0.618034) % 1;
    const period = (lo: number, hi: number) => TAU / (lo + (hi - lo) * rng());
    paths.push({
      ax: 0.3 + 0.08 * rng(),
      wx: period(9, 16),
      px: g * TAU,
      wx2: period(5, 9),
      px2: rng() * TAU,
      ay: 0.28 + 0.08 * rng(),
      wy: period(10, 17),
      py: (g + 0.25) * TAU + rng(),
      wy2: period(5, 9),
      py2: rng() * TAU,
      radius: 0.3 + 0.3 * ((g + 0.5 * rng()) % 1),
      wr: period(7, 13),
      pr: rng() * TAU,
    });
  }
  return paths;
}

export const BLOB_PATHS: readonly BlobPath[] = makeBlobPaths();

/**
 * Blob centre and radius at time `t` (seconds at speed 1), in frame-height units with
 * x in 0..aspect. Writes x, y, r to `out[o..o+2]`.
 */
export function blobAt(
  path: BlobPath,
  t: number,
  aspect: number,
  softness: number,
  out: Float32Array | number[],
  o = 0,
): void {
  const ux =
    0.5 + path.ax * Math.sin(t * path.wx + path.px) + WOBBLE * Math.sin(t * path.wx2 + path.px2);
  const uy =
    0.5 + path.ay * Math.sin(t * path.wy + path.py) + WOBBLE * Math.sin(t * path.wy2 + path.py2);
  out[o] = ux * aspect;
  out[o + 1] = uy;
  out[o + 2] = path.radius * softness * (1 + BREATHE * Math.sin(t * path.wr + path.pr));
}

/**
 * Fills the first `count` entries of the `uBlobs` uniform array (MAX_BLOBS vec4s):
 * centre x, y, k = log2(e) / r², so the shader's `exp2(-d² k)` is the Gaussian
 * `exp(-d²/r²)`, and the blob's weight (from `weights`, default 1), which fades it
 * in and out. Later entries are left as they are: the shader stops at `uCount`.
 */
export function writeBlobUniforms(
  out: Float32Array,
  count: number,
  t: number,
  aspect: number,
  softness: number,
  weights?: ArrayLike<number>,
): void {
  const n = Math.min(count, MAX_BLOBS);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    blobAt(BLOB_PATHS[i], t, aspect, softness, out, o);
    const r = Math.max(1e-3, out[o + 2]);
    out[o + 2] = Math.LOG2E / (r * r);
    out[o + 3] = weights ? weights[i] : 1;
  }
}

/**
 * The blob field at one fragment per low-res pixel. Uniforms: `uToUnits`
 * (low-res pixel to frame-height units: aspect / width, 1 / height), `uBlobs`
 * (from `writeBlobUniforms`), `uColors` (linear-light colours, MAX_BLOBS), `uBase`
 * (linear-light background) and `uCount` (blobs to sum).
 */
export const BLOB_FIELD_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
/** Low-res pixel to frame-height units: (aspect / width, 1 / height). */
uniform vec2 uToUnits;
/** x, y, k = log2(e) / r^2; only the first uCount are set. */
uniform vec4 uBlobs[${String(MAX_BLOBS)}];
/** Linear-light blob colours. */
uniform vec3 uColors[${String(MAX_BLOBS)}];
uniform vec3 uBase;
uniform int uCount;
out vec4 outColor;

const int MAX_BLOBS = ${String(MAX_BLOBS)};
const float BASE_WEIGHT = ${glslFloat(BASE_WEIGHT)};
const float INV_GAMMA = ${glslFloat(1 / LINEAR_GAMMA)};

void main() {
  vec2 p = gl_FragCoord.xy * uToUnits;
  vec3 sum = uBase * BASE_WEIGHT;
  float wsum = BASE_WEIGHT;
  for (int i = 0; i < MAX_BLOBS; i++) {
    if (i >= uCount) break;
    vec4 b = uBlobs[i];
    vec2 d = p - b.xy;
    float w = b.w * exp2(-dot(d, d) * b.z);
    sum += uColors[i] * w;
    wsum += w;
  }
  outColor = vec4(pow(sum / wsum, vec3(INV_GAMMA)), 1.0);
}
`;
