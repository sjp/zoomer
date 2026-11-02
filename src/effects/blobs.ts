import { hexToUnitRgb, type Rgb } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  FULLSCREEN_VERTEX,
  getUniforms,
} from "./gl";
import { createLowResTarget, QUALITY_OPTIONS, qualityDivisor, type LowResTarget } from "./lowres";
import { createRng } from "./noise";
import { defineEffect } from "./types";

export const MAX_BLOBS = 6;
const TAU = Math.PI * 2;
/** Weight of the background colour in the normalised blend; a blob centre weighs 1. */
const BASE_WEIGHT = 0.3;
/** Gamma used to mix in (approximately) linear light; the shader re-encodes with 1/GAMMA. */
const GAMMA = 2.2;
/** Wall seconds between low-res keyframes (~30 Hz); the blit cross-fades between two. */
export const KEYFRAME_INTERVAL = 1 / 30;
/** Low-res divisors: the image has no high frequencies, so even "high" is 1/16 of the pixels. */
const DIVISORS = { high: 4, balanced: 6, low: 8 } as const;
/** Grain amplitude (0..1 colour units, peak to peak) at `grain` = 1. */
const GRAIN_AMP = 0.06;

// ---------------------------------------------------------------------------
// Palettes

export const PALETTES = {
  dusk: ["#ff6f61", "#b34fd1", "#4a58d9", "#ffb36b"],
  ocean: ["#0fa3b1", "#1e5fd8", "#5ce1e6", "#2b3a8c"],
  mint: ["#3ddc97", "#a8f0c6", "#1fb5a6", "#d6f5a3"],
  candy: ["#ff8fc7", "#ffd36e", "#8fd3ff", "#c79bff"],
  mono: ["#5a6274", "#8b93a6", "#3a4050", "#b8bfcc"],
} as const satisfies Record<string, readonly string[]>;

const PALETTE_OPTIONS = [
  { value: "dusk", label: "Dusk" },
  { value: "ocean", label: "Ocean" },
  { value: "mint", label: "Mint" },
  { value: "candy", label: "Candy" },
  { value: "mono", label: "Mono" },
  { value: "custom", label: "Custom" },
] as const;

/**
 * The hex colour of blob `index` (colours repeat when there are more blobs than
 * palette entries). "custom" uses `custom`; unknown names fall back to "dusk".
 */
export function paletteColor(palette: string, custom: readonly string[], index: number): string {
  const list: readonly string[] =
    palette === "custom" && custom.length > 0
      ? custom
      : Object.hasOwn(PALETTES, palette)
        ? PALETTES[palette as keyof typeof PALETTES]
        : PALETTES.dusk;
  return list[((index % list.length) + list.length) % list.length];
}

/** sRGB-ish (gamma 2.2) hex colour to linear-light channels in 0..1. */
export function hexToLinear(hex: string): Rgb {
  const [r, g, b] = hexToUnitRgb(hex);
  return [r ** GAMMA, g ** GAMMA, b ** GAMMA];
}

// ---------------------------------------------------------------------------
// Blob paths

/** Per-blob constants for a two-harmonic Lissajous path. Angular rates in rad/s at speed 1. */
export interface BlobPath {
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
 * Fills the `uBlobs` uniform array (MAX_BLOBS vec4s): centre x, y; k = log2(e) / r², so
 * the shader's `exp2(-d² k)` is the Gaussian `exp(-d²/r²)`; and weight (0 for unused).
 */
export function writeBlobUniforms(
  out: Float32Array,
  count: number,
  t: number,
  aspect: number,
  softness: number,
): void {
  for (let i = 0; i < MAX_BLOBS; i++) {
    const o = i * 4;
    if (i >= count) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      continue;
    }
    blobAt(BLOB_PATHS[i], t, aspect, softness, out, o);
    const r = Math.max(1e-3, out[o + 2]);
    out[o + 2] = Math.LOG2E / (r * r);
    out[o + 3] = 1;
  }
}

// ---------------------------------------------------------------------------
// Keyframe clock: low-res pass at ~30 Hz, cross-faded every frame.

export interface KeyframeClock {
  /** Wall seconds since keyframe A (the older of the two cached frames). */
  elapsed: number;
}

/**
 * Advances the keyframe clock by `dt` wall seconds and says how many low-res
 * keyframes to render this frame:
 * - 0: both cached frames are still valid; just cross-fade.
 * - 1: A has expired; the old B becomes A and a new B is rendered one interval ahead.
 * - 2: render both afresh (on `reset`, a non-positive interval, or after a gap of
 *   two intervals or more, when B is in the past too).
 * Non-finite or negative `dt` counts as 0.
 */
export function advanceKeyframes(
  clock: KeyframeClock,
  dt: number,
  interval: number,
  reset: boolean,
): 0 | 1 | 2 {
  if (reset || !(interval > 0)) {
    clock.elapsed = 0;
    return 2;
  }
  const e = clock.elapsed + (Number.isFinite(dt) && dt > 0 ? dt : 0);
  if (e < interval) {
    clock.elapsed = e;
    return 0;
  }
  if (e < 2 * interval) {
    clock.elapsed = e - interval;
    return 1;
  }
  clock.elapsed = 0;
  return 2;
}

/** Cross-fade weight of keyframe B: 0 shows A, 1 shows B. */
export function keyframeMix(clock: KeyframeClock, interval: number): number {
  return interval > 0 ? Math.min(1, Math.max(0, clock.elapsed / interval)) : 0;
}

// ---------------------------------------------------------------------------
// Shaders

const BLOB_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
/** Low-res pixel to frame-height units: (aspect / width, 1 / height). */
uniform vec2 uToUnits;
/** x, y, k = log2(e) / r^2, weight. */
uniform vec4 uBlobs[${MAX_BLOBS}];
/** Linear-light blob colours. */
uniform vec3 uColors[${MAX_BLOBS}];
uniform vec3 uBase;
uniform int uCount;
out vec4 outColor;

const int MAX_BLOBS = ${MAX_BLOBS};
const float BASE_WEIGHT = ${BASE_WEIGHT.toFixed(3)};
const float INV_GAMMA = ${(1 / GAMMA).toFixed(6)};

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

/** Blit body: cross-fade the two keyframes, then optional static grain. */
const COMPOSITE = /* glsl */ `
uniform sampler2D uAux;
/** Weight of uAux (unit 1) against uLowRes (unit 0). */
uniform float uMix;
uniform float uGrain;
vec4 composite(vec2 uv) {
  vec3 c = mix(texture(uLowRes, uv).rgb, texture(uAux, uv).rgb, uMix);
  if (uGrain > 0.0) {
    // Static per-pixel hash: hides banding, and a still pattern costs a codec nothing.
    uvec2 q = uvec2(gl_FragCoord.xy);
    uint h = q.x * 1664525u + q.y * 1013904223u;
    h ^= h >> 16u;
    h *= 2246822519u;
    h ^= h >> 13u;
    float g = float(h & 65535u) * (1.0 / 65535.0) - 0.5;
    c += g * uGrain;
  }
  return vec4(c, 1.0);
}
`;

/**
 * Soft gradient blobs: a handful of large Gaussian colour fields drifting on slow
 * Lissajous paths, blended in linear light over a base colour. Rendered at 1/8 res
 * (by default) at ~30 Hz into two cached keyframes, which the full-res blit
 * cross-fades every frame so the motion never steps.
 */
export const blobs = defineEffect({
  id: "blobs",
  name: "Gradient Blobs",
  description: "Large, soft colour fields that slowly drift and merge. Very low power.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "dusk" },
    color1: { kind: "color", label: "Colour 1 (custom)", default: "#ff6f61" },
    color2: { kind: "color", label: "Colour 2 (custom)", default: "#b34fd1" },
    color3: { kind: "color", label: "Colour 3 (custom)", default: "#4a58d9" },
    color4: { kind: "color", label: "Colour 4 (custom)", default: "#ffb36b" },
    background: { kind: "color", label: "Background", default: "#140f2a" },
    blobs: { kind: "number", label: "Blobs", min: 3, max: MAX_BLOBS, step: 1, default: 5 },
    speed: { kind: "number", label: "Speed", min: 0, max: 2, step: 0.05, default: 0.3 },
    softness: { kind: "number", label: "Softness", min: 0.5, max: 1.6, step: 0.05, default: 1 },
    grain: { kind: "number", label: "Grain", min: 0, max: 1, step: 0.01, default: 0.15 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "low" },
  },
  context: "webgl2",
  create(gl) {
    const program = createProgram(gl, FULLSCREEN_VERTEX, BLOB_FRAGMENT);
    const triangle = createFullscreenTriangle(gl);
    let main: LowResTarget | undefined;
    let aux: LowResTarget | undefined;
    try {
      main = createLowResTarget(gl, { composite: COMPOSITE });
      aux = createLowResTarget(gl);
    } catch (err) {
      main?.dispose();
      gl.deleteProgram(program);
      triangle.dispose();
      throw err;
    }
    // Narrowed copies for the closures below.
    const mainT = main;
    const auxT = aux;
    const loc = getUniforms(gl, program, ["uToUnits", "uBlobs", "uColors", "uBase", "uCount"]);
    const cLoc = getUniforms(gl, mainT.program, ["uAux", "uMix", "uGrain"]);
    gl.useProgram(mainT.program);
    gl.uniform1i(cLoc.uAux, 1);

    const blobData = new Float32Array(MAX_BLOBS * 4);
    const colorData = new Float32Array(MAX_BLOBS * 3);
    const custom = ["", "", "", ""];
    const clock: KeyframeClock = { elapsed: 0 };

    let width = 1;
    let height = 1;
    let aspect = 1;
    /** Sim seconds (speed-scaled), float64. */
    let time = 0;
    /** Sim time each target currently holds; NaN when stale. */
    let simMain = Number.NaN;
    let simAux = Number.NaN;
    /** True when `main` holds keyframe A (the older one). */
    let mainIsA = true;
    let lastLowW = 0;
    let lastLowH = 0;
    let lastAspect = 0;
    let lastPalette = "";
    let lastC1 = "";
    let lastC2 = "";
    let lastC3 = "";
    let lastC4 = "";
    let lastBg = "";
    let lastCount = -1;
    let lastSoftness = Number.NaN;
    let lastMix = Number.NaN;
    let lastGrain = Number.NaN;
    let count = 3;
    let softness = 1;

    /** Renders the blob field at sim time `t` into `target`, unless it already holds it. */
    const renderKey = (target: LowResTarget, t: number): void => {
      if ((target === mainT ? simMain : simAux) === t) return;
      writeBlobUniforms(blobData, count, t, aspect, softness);
      gl.useProgram(program);
      gl.uniform4fv(loc.uBlobs, blobData);
      target.bind();
      triangle.draw();
      if (target === mainT) simMain = t;
      else simAux = t;
    };

    return {
      resize(v) {
        width = v.width;
        height = v.height;
        aspect = width / Math.max(1, height);
      },
      frame(dt, p) {
        beginFrame(gl, width, height);
        time += (Number.isFinite(dt) && dt > 0 ? dt : 0) * p.speed;
        let invalid = false;

        const divisor = qualityDivisor(p.quality, DIVISORS);
        mainT.resize(width, height, divisor);
        auxT.resize(width, height, divisor);
        gl.useProgram(program);
        if (mainT.width !== lastLowW || mainT.height !== lastLowH || aspect !== lastAspect) {
          lastLowW = mainT.width;
          lastLowH = mainT.height;
          lastAspect = aspect;
          gl.uniform2f(loc.uToUnits, aspect / lastLowW, 1 / lastLowH);
          invalid = true;
        }
        const n = Math.max(1, Math.min(MAX_BLOBS, Math.round(p.blobs)));
        if (n !== lastCount) {
          lastCount = count = n;
          gl.uniform1i(loc.uCount, n);
          invalid = true;
        }
        if (p.softness !== lastSoftness) {
          lastSoftness = softness = p.softness;
          invalid = true;
        }
        if (
          p.palette !== lastPalette ||
          p.color1 !== lastC1 ||
          p.color2 !== lastC2 ||
          p.color3 !== lastC3 ||
          p.color4 !== lastC4
        ) {
          lastPalette = p.palette;
          custom[0] = lastC1 = p.color1;
          custom[1] = lastC2 = p.color2;
          custom[2] = lastC3 = p.color3;
          custom[3] = lastC4 = p.color4;
          for (let i = 0; i < MAX_BLOBS; i++)
            colorData.set(hexToLinear(paletteColor(p.palette, custom, i)), i * 3);
          gl.uniform3fv(loc.uColors, colorData);
          invalid = true;
        }
        if (p.background !== lastBg) {
          lastBg = p.background;
          gl.uniform3fv(loc.uBase, hexToLinear(p.background));
          invalid = true;
        }
        if (invalid) {
          simMain = Number.NaN;
          simAux = Number.NaN;
        }

        const due = advanceKeyframes(clock, dt, KEYFRAME_INTERVAL, invalid);
        if (due === 2) {
          mainIsA = true;
          renderKey(mainT, time);
          renderKey(auxT, time + p.speed * KEYFRAME_INTERVAL);
        } else if (due === 1) {
          // Old B becomes A; the old A's texture is reused for the next B, rendered at
          // the sim time it will be shown at (one interval after the old B).
          mainIsA = !mainIsA;
          const lead = p.speed * (KEYFRAME_INTERVAL - clock.elapsed);
          renderKey(mainIsA ? auxT : mainT, time + lead);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // Blit: main on unit 0 (bound by blit), aux on unit 1.
        gl.useProgram(mainT.program);
        const b = keyframeMix(clock, KEYFRAME_INTERVAL);
        const mix = mainIsA ? b : 1 - b;
        if (mix !== lastMix) {
          lastMix = mix;
          gl.uniform1f(cLoc.uMix, mix);
        }
        if (p.grain !== lastGrain) {
          lastGrain = p.grain;
          gl.uniform1f(cLoc.uGrain, Math.max(0, p.grain) * GRAIN_AMP);
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, auxT.texture);
        mainT.blit();
        // Unbind both so neither is sampled while it is a render target next frame.
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
      },
      dispose() {
        gl.deleteProgram(program);
        triangle.dispose();
        mainT.dispose();
        auxT.dispose();
      },
    };
  },
});
