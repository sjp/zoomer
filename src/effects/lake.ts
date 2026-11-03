import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import {
  blendPalette,
  createRingState,
  fillTreeTable,
  HORIZON_GAP,
  MAX_RINGS,
  packRings,
  PAL_BACK,
  PAL_EVERGREEN,
  PAL_MIST,
  PAL_RAMP,
  PAL_SKY_HIGH,
  PAL_SKY_LOW,
  PAL_WATER,
  PALETTE_ENTRIES,
  PALETTE_FLOATS,
  PALETTE_RATE,
  RING_STRIDE,
  seasonPalette,
  stepRings,
  TREE_CHANNELS,
  TREE_COLUMNS,
  WIND_SOFT,
  windSlope,
  windThreshold,
} from "./lake-sim";
import { lakeMeta } from "./lake.meta";
import { createLowResTarget, qualityDivisor } from "./lowres";
import { fract } from "./math";
import { buildPeriodicNoiseTexture, createRng } from "./noise";
import { defineEffect } from "./types";

const TAU = Math.PI * 2;

/** Noise texture side, and the lattice periods of its four channels. */
const NOISE_SIZE = 256;
/** R, G: fine wavelets (slope along X and Z). */
const FINE_PERIOD = 32;
/** B: the wind-patch field. */
const MASK_PERIOD = 8;
/** A: foliage clumps. */
const FOLIAGE_PERIOD = 64;

/** Water plane to noise uv, per camera height: the two fine wavelet layers and the patches. */
const FINE_SCALE_1: readonly [number, number] = [0.35, 0.4];
const FINE_SCALE_2: readonly [number, number] = [0.6, 0.68];
const MASK_SCALE: readonly [number, number] = [0.04, 0.12];
/** Drift of each layer in noise uv per second (negative z: towards the viewer). */
const FINE_DRIFT_1: readonly [number, number] = [0.01, -0.03];
const FINE_DRIFT_2: readonly [number, number] = [-0.013, -0.022];
const MASK_DRIFT: readonly [number, number] = [0.0025, -0.006];
/** Frame heights to foliage uv: clumps about 1 % of the frame height across. */
const FOLIAGE_SCALE = 1.6;
/** How far foliage noise roughens the crowns' outlines and seams. */
const EDGE_JITTER = 0.006;
const SEAM_JITTER = 0.003;
/** The sky fades from its low to its high colour over this height above the shore. */
const SKY_SPAN = 0.5;

/** Reflection shift in frame heights per unit of slope: mostly vertical, so it streaks. */
const DISP_X = 0.015;
const DISP_Y = 0.05;
/** Reflectance at the far shore (grazing) and at the bottom of the frame. */
const F_FAR = 0.9;
const F_NEAR = 0.62;
/** The reflection is a little darker than the bank. */
const REFLECT_DIM = 0.9;
/** How much ruffled water lightens towards the sky. */
const ROUGH_SKY = 0.12;

/** Mist: half-heights of the band above and below the shoreline, and its strength. */
const MIST_UP = 0.045;
const MIST_DOWN = 0.025;
const MIST_MAX = 0.55;
/** Mist drift, radians per second, of its two slow undulations. */
const MIST_SPEED_1 = 0.05;
const MIST_SPEED_2 = 0.031;

const v2 = (v: readonly [number, number]) => `vec2(${glslFloat(v[0])}, ${glslFloat(v[1])})`;

/**
 * One low-res pass: above the shoreline the bank (sky, hazy back row, front
 * crowns from the column table, roughened by foliage noise); below it the same
 * bank function, mirrored and shifted by the water's slope, the sum of the
 * ripple rings (on the water plane, see `lake-sim.ts`) and the wind patches
 * (a drifting low-frequency mask times two layers of fine wavelets).
 */
export const LAKE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uTree;
uniform sampler2D uNoise;
uniform vec4 uRings[${MAX_RINGS * 2}];
uniform int uRingCount;
uniform vec3 uPal[${PALETTE_ENTRIES}];
/** 1 / target size in pixels. */
uniform vec2 uInvSize;
uniform float uAspect;
uniform float uShore;
/** x: wind threshold, y: wind slope, z: fine cell height in target px at depth 1, w: mist. */
uniform vec4 uWind;
/** Drift of the two fine wavelet layers. */
uniform vec4 uFineOff;
/** xy: drift of the wind patches, zw: mist phases. */
uniform vec4 uMaskOff;
/** 1 when rendering straight to the canvas (no dithered blit after). */
uniform float uDither;
out vec4 outColor;
${DITHER_GLSL}

vec3 ramp(float t) {
  float s = clamp(t, 0.0, 1.0) * 3.0;
  if (s < 1.0) return mix(uPal[${PAL_RAMP}], uPal[${PAL_RAMP + 1}], s);
  if (s < 2.0) return mix(uPal[${PAL_RAMP + 1}], uPal[${PAL_RAMP + 2}], s - 1.0);
  return mix(uPal[${PAL_RAMP + 2}], uPal[${PAL_RAMP + 3}], s - 2.0);
}

/** The far bank and sky at u (0..1 across) and h frame heights above the shoreline. */
vec3 bank(float u, float h) {
  float fol = textureLod(uNoise, vec2(u * uAspect, h) * ${glslFloat(FOLIAGE_SCALE)}, 0.0).a;
  vec4 c = textureLod(uTree, vec2(u + (fol - 0.5) * ${glslFloat(SEAM_JITTER)}, 0.5), 0.0);
  float he = h + (fol - 0.5) * ${glslFloat(EDGE_JITTER)};
  float aa = uInvSize.y;
  vec3 col = mix(uPal[${PAL_SKY_LOW}], uPal[${PAL_SKY_HIGH}], smoothstep(0.0, ${glslFloat(SKY_SPAN)}, h));
  col = mix(col, uPal[${PAL_BACK}] * (0.9 + 0.2 * fol), 1.0 - smoothstep(c.a - aa, c.a + aa, he));
  vec3 leaf = mix(ramp(c.g), uPal[${PAL_EVERGREEN}], step(1.5, c.g));
  float lit = (0.55 + 0.45 * c.b) * mix(0.55, 1.05, clamp(h / max(c.r, 1e-3), 0.0, 1.0));
  lit *= 0.75 + 0.5 * fol;
  return mix(col, leaf * lit, 1.0 - smoothstep(c.r - aa, c.r + aa, he));
}

void main() {
  vec2 p = gl_FragCoord.xy * uInvSize;
  float h = p.y - uShore;
  vec3 col;
  if (h >= 0.0) {
    col = bank(p.x, h);
  } else {
    // The water plane under this pixel (see toPlane).
    float z = 1.0 / (uShore + ${glslFloat(HORIZON_GAP)} - p.y);
    vec2 w = vec2((p.x - 0.5) * uAspect * z, z);
    vec2 s = vec2(0.0);
    for (int i = 0; i < ${MAX_RINGS}; i++) {
      if (i >= uRingCount) break;
      vec4 a = uRings[2 * i];
      vec2 d = w - a.xy;
      float d2 = dot(d, d);
      if (d2 >= a.z) continue;
      vec4 b = uRings[2 * i + 1];
      float r = sqrt(d2);
      float x = r - b.x;
      float q = x * b.y;
      if (abs(q) >= 1.0) continue;
      float e = 1.0 - q * q;
      float ph = x * b.z;
      float slope = b.w * (-4.0 * q * e * a.w * cos(ph) - e * e * sin(ph));
      s += d * (slope / max(r, 1e-4));
    }
    float n = textureLod(uNoise, w * ${v2(MASK_SCALE)} + uMaskOff.xy, 0.0).b;
    float m = smoothstep(uWind.x, uWind.x + ${glslFloat(WIND_SOFT)}, n);
    // Fine wavelets fade out where they would shrink below a couple of pixels.
    float fine = m * uWind.y * smoothstep(1.5, 4.0, uWind.z / (z * z));
    vec2 g = textureLod(uNoise, w * ${v2(FINE_SCALE_1)} + uFineOff.xy, 0.0).rg
      + textureLod(uNoise, w * ${v2(FINE_SCALE_2)} + uFineOff.zw, 0.0).rg - 1.0;
    s += g * fine;
    float hr = max(0.0, -h + s.y * ${glslFloat(DISP_Y)});
    float ur = p.x + s.x * ${glslFloat(DISP_X)} / uAspect;
    vec3 refl = bank(ur, hr) * ${glslFloat(REFLECT_DIM)};
    float f = mix(${glslFloat(F_FAR)}, ${glslFloat(F_NEAR)}, clamp(-h / uShore, 0.0, 1.0));
    col = mix(uPal[${PAL_WATER}], refl, f);
    col = mix(col, uPal[${PAL_SKY_LOW}], m * ${glslFloat(ROUGH_SKY)});
  }
  // Mist lying on the water along the far shore.
  float mh = h / (h > 0.0 ? ${glslFloat(MIST_UP)} : ${glslFloat(MIST_DOWN)});
  float xs = p.x * uAspect;
  float drift = 0.75 + 0.25 * sin(xs * 7.0 + uMaskOff.z) * sin(xs * 3.1 - uMaskOff.w);
  col = mix(col, uPal[${PAL_MIST}], uWind.w * exp(-mh * mh) * drift);
  outColor = vec4(col + dither8(gl_FragCoord.xy) * uDither, 1.0);
}
`;

const UNIFORMS = [
  "uTree",
  "uNoise",
  "uRings",
  "uRingCount",
  "uPal",
  "uInvSize",
  "uAspect",
  "uShore",
  "uWind",
  "uFineOff",
  "uMaskOff",
  "uDither",
] as const;

/**
 * A still lake in autumn mirroring a treeline on the far bank. Wind patches drift
 * across and streak the reflection; now and then a ring spreads across it. One
 * low-res pass and a dithered blit.
 */
export const lake = defineEffect(lakeMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, LAKE_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const u = createUniforms(gl, program, UNIFORMS);
      gl.useProgram(program);
      u.i1("uTree", 0);
      u.i1("uNoise", 1);

      const trees = scope.own(createColumnTable(gl, TREE_COLUMNS, TREE_CHANNELS));
      const noise = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          wrap: gl.REPEAT,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, [
            { period: FINE_PERIOD, seed: 0x7201 },
            { period: FINE_PERIOD, seed: 0x7202 },
            { period: MASK_PERIOD, seed: 0x7203 },
            { period: FOLIAGE_PERIOD, seed: 0x7204 },
          ]),
        }),
        (t) => gl.deleteTexture(t),
      );

      const rng = createRng(0x72);
      const rings = createRingState(rng);
      const packed = new Float32Array(MAX_RINGS * RING_STRIDE);
      const palette = new Float32Array(PALETTE_FLOATS);
      let paletteReady = false;
      /** Fine-cell height on the water plane, for the detail fade. */
      const fineCell = 1 / (FINE_PERIOD * Math.max(FINE_SCALE_1[1], FINE_SCALE_2[1]));

      let width = 1;
      let height = 1;
      let tableSeed = Number.NaN;
      let tableAspect = Number.NaN;
      let time = 0;
      let mist = -1;

      return {
        resize(v) {
          width = v.width;
          height = v.height;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          stepRings(rings, step, p.ripples, rng);

          target.resize(width, height, qualityDivisor(p.quality));
          const tw = target.width;
          const th = target.height;
          const aspect = width / Math.max(1, height);
          const shore = Math.min(0.9, Math.max(0.1, p.shoreline));

          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          const seed = Math.floor(p.seed);
          if (seed !== tableSeed || aspect !== tableAspect) {
            tableSeed = seed;
            tableAspect = aspect;
            fillTreeTable(trees.data, seed, aspect);
            trees.upload();
          } else gl.bindTexture(gl.TEXTURE_2D, trees.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, noise);

          const goal = seasonPalette(p.season);
          if (!paletteReady) {
            palette.set(goal);
            paletteReady = true;
            gl.uniform3fv(u.loc.uPal, palette);
          } else if (blendPalette(palette, goal, PALETTE_RATE * step)) {
            gl.uniform3fv(u.loc.uPal, palette);
          }

          // Mist fades in and out rather than snapping.
          const mistGoal = p.mist ? 1 : 0;
          mist =
            mist < 0
              ? mistGoal
              : mistGoal > mist
                ? Math.min(1, mist + step)
                : Math.max(0, mist - step);

          u.f2("uInvSize", 1 / tw, 1 / th);
          u.f1("uAspect", aspect);
          u.f1("uShore", shore);
          u.f4(
            "uWind",
            windThreshold(p.wind, time),
            windSlope(p.wind),
            fineCell * th,
            MIST_MAX * mist,
          );
          u.f4(
            "uFineOff",
            fract(time * FINE_DRIFT_1[0]),
            fract(time * FINE_DRIFT_1[1]),
            fract(time * FINE_DRIFT_2[0]),
            fract(time * FINE_DRIFT_2[1]),
          );
          u.f4(
            "uMaskOff",
            fract(time * MASK_DRIFT[0]),
            fract(time * MASK_DRIFT[1]),
            (time * MIST_SPEED_1) % TAU,
            (time * MIST_SPEED_2) % TAU,
          );
          u.f1("uDither", target.direct ? 1 : 0);
          const count = packRings(packed, rings, shore, aspect);
          u.i1("uRingCount", count);
          if (count > 0) gl.uniform4fv(u.loc.uRings, packed);

          target.bind();
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
          target.blit();
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
