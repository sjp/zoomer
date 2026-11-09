import { type Rgb, unitRgbMemo } from "../color";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
} from "../gl";
import {
  BREAK,
  buildShapeTable,
  createWaveScheduler,
  layoutAxes,
  MAX_WAVES,
  packWaves,
  SHAPE_COLUMNS,
  SHAPE_SPAN,
  SHORE_WEIGHTS,
  T_DRAIN,
  T_DRY,
  WAVE_FLOATS,
  waterPalette,
} from "./beach-sim";
import { createLowResTarget, qualityDivisor } from "../lowres";
import { buildPeriodicNoiseTexture, HASH32_GLSL } from "../noise";
import { fract } from "../math";
import { beachMeta } from "./beach.meta";
import { defineEffect } from "../types";

/** Side of the RGBA8 noise texture: foam (R, G) and caustic (B, A) channels. */
const NOISE_SIZE = 256;
const NOISE_CHANNELS = [
  { period: 32, seed: 541 },
  { period: 64, seed: 542 },
  { period: 16, seed: 543 },
  { period: 16, seed: 544 },
] as const;
/** Along-shore amplitude of the shoreline wiggle, height units. */
const SHORE_AMP = 0.05;
/** Noise texture repeats per height unit: foam (two scales), caustics and the full-res lace. */
const FOAM_K1 = 1.1;
const FOAM_K2 = 1.4;
const CAUSTIC_K = 1;
const LACE_K = 2;
/** Caustic pattern drift (texture units per second) and morph rate (radians per second). */
const CAUSTIC_DRIFT: readonly [number, number] = [0.004, 0.0025];
const CAUSTIC_MORPH = 0.35;
/** Lace drift (texture units per second), so the fine foam edge never sits still. */
const LACE_DRIFT: readonly [number, number] = [0.003, -0.002];
/** Seconds of waves simulated before the first frame, so it opens mid-surf with a wet band. */
const PRIME_SECONDS = 24;
const PRIME_STEP = 0.25;

/*
 * Low-res pass: water by depth with the seabed and caustics showing through the
 * shallows, sand with the wet band, the swash sheet and swell lines. Alpha is the
 * foam density (already broken up by advected noise), thresholded at full res in
 * the composite. p is in height units, y up.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uShape;
uniform sampler2D uNoise;
uniform vec2 uLowSize;
uniform float uAspect;
/** Landward unit axis (xy) and offset: n = dot(p, xy) - z. */
uniform vec3 uAxis;
/** Per wave, four vec4s; see packWaves. */
uniform vec4 uWave[${String(MAX_WAVES * 4)}];
uniform vec2 uOff[${String(MAX_WAVES)}];
uniform int uCount;
uniform vec3 uSand;
uniform vec3 uWetSand;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
/** Caustic drift (xy) and morph (cos, sin). */
uniform vec4 uCaustic;

out vec4 outColor;

const int MAX_WAVES = ${String(MAX_WAVES)};
const vec4 SHORE_W = vec4(${SHORE_WEIGHTS.map((v) => glslFloat(v)).join(", ")});
const float SHORE_AMP = ${glslFloat(SHORE_AMP)};
const float INV_SPAN = ${glslFloat(1 / SHAPE_SPAN)};
const float T_DRAIN = ${glslFloat(T_DRAIN)};
const float INV_DRY = ${glslFloat(1 / T_DRY)};
const float BREAK = ${glslFloat(BREAK)};
const float FOAM_K1 = ${glslFloat(FOAM_K1)};
const float FOAM_K2 = ${glslFloat(FOAM_K2)};
const float CAUSTIC_K = ${glslFloat(CAUSTIC_K)};
${HASH32_GLSL}

float sq(float x) { return x * x; }

void main() {
  vec2 p = gl_FragCoord.xy / uLowSize * vec2(uAspect, 1.0);
  float s = dot(p, vec2(-uAxis.y, uAxis.x));
  vec4 T = textureLod(uShape, vec2(s * INV_SPAN, 0.5), 0.0);
  float n = dot(p, uAxis.xy) - uAxis.z - dot(T, SHORE_W) * SHORE_AMP;

  // A strip at the waterline that never dries.
  float wet = 1.0 - smoothstep(0.0, 0.012, n);
  float sheet = 0.0;
  float swell = 0.0;
  float dens = 0.0;
  float best = 0.0;
  float bestD = 0.0;
  vec2 bestOff = vec2(0.0);
  float surf = smoothstep(-BREAK - 0.05, -BREAK + 0.01, n) * (1.0 - smoothstep(0.0, 0.03, n));
  for (int i = 0; i < MAX_WAVES; i++) {
    if (i >= uCount) break;
    vec4 A = uWave[i * 4];
    vec4 B = uWave[i * 4 + 1];
    vec4 C = uWave[i * 4 + 2];
    float sh = dot(T, uWave[i * 4 + 3]);
    float front = A.x + A.y * sh;
    float mloc = A.z + A.y * sh;
    // > 0 on the water side of the front.
    float d = front - n;
    if (A.z > 0.0) {
      // Fully wet until the draining sheet uncovers it, then drying (see waveWetness).
      float q = clamp((mloc - n) / A.z, 0.0, 1.0);
      float since = max(A.w - T_DRAIN * sqrt(q), 0.0);
      wet = max(wet, smoothstep(-0.004, 0.004, mloc - n) * exp(-since * INV_DRY) * C.z);
    }
    sheet = max(sheet, C.y * smoothstep(-0.003, 0.003, d));
    swell += C.x * exp(-sq(d * 40.0));
    float band = B.x * smoothstep(-0.004, 0.006, d) * exp(-max(d, 0.0) * B.y)
      + B.z * surf * smoothstep(0.0, 0.03, d)
      + B.w * exp(-sq((n - mloc) * 220.0));
    dens += band;
    if (band > best) {
      best = band;
      bestD = d;
      bestOff = uOff[i];
    }
  }

  float depth = max(-n, 0.0);
  // Grain: static per-pixel hash, only on the sand (the water covers it).
  uint h = hash32(uint(gl_FragCoord.x) ^ hash32(uint(gl_FragCoord.y)));
  float grain = 1.0 + 0.05 * (float(h >> 8) * ${glslFloat(1 / 16777216)} - 0.5);
  vec3 ground = mix(uSand, uWetSand, wet) * grain;

  // Seabed through the water: tinted, with caustics in the shallows.
  vec3 bed = ground * mix(vec3(1.0), uShallow, smoothstep(0.0, 0.025, depth));
  float trans = exp(-depth * 12.0);
  if (depth > 0.0 && trans > 0.03) {
    vec4 c = texture(uNoise, p * CAUSTIC_K + uCaustic.xy);
    float v = (c.b - 0.5) * uCaustic.z + (c.a - 0.5) * uCaustic.w;
    float k = 1.0 - min(abs(v) * 9.0, 1.0);
    k *= k;
    bed += (k * k) * 0.3 * smoothstep(0.0, 0.03, depth) * uShallow;
  }
  vec3 water = mix(uMid, uDeep, smoothstep(0.04, 0.5, depth));
  vec3 col = mix(water, bed, trans);
  // The thin swash sheet over the sand: a clear, slightly glossy film.
  col = mix(col, col * uShallow * 1.08 + 0.03, sheet * 0.55 * (1.0 - smoothstep(0.0, 0.06, depth)));
  // Swell lines: a lighter ridge on the open water.
  col += min(swell, 1.0) * 0.07 * (1.0 - smoothstep(-0.02, 0.0, n)) * (uMid + 0.2);

  float foam = 0.0;
  if (dens > 0.004) {
    vec2 q = vec2(s, bestD * 1.8);
    float f1 = texture(uNoise, q * FOAM_K1 + bestOff).r;
    float f2 = texture(uNoise, q * FOAM_K2 + bestOff.yx).g;
    float fn = 0.6 * f1 + 0.4 * f2;
    foam = clamp(dens * clamp(0.5 + (fn - 0.5) * 3.0, 0.05, 1.0) * 2.0, 0.0, 1.0);
  }
  outColor = vec4(clamp(col, 0.0, 1.0), foam);
}
`;

/**
 * Upscale with the lacy foam edge: the low-res foam density plus one full-res noise
 * fetch, thresholded, over the low-res colour. Dither is added by the blit.
 */
const COMPOSITE = /* glsl */ `
uniform sampler2D uNoise;
/** Noise texture units per px, and the lace drift. */
uniform float uLaceScale;
uniform vec2 uLaceOff;
uniform vec3 uFoamColor;
vec4 composite(vec2 uv) {
  vec4 c = texture(uLowRes, uv);
  vec3 col = c.rgb;
  if (c.a > 0.02) {
    vec4 nz = texture(uNoise, gl_FragCoord.xy * uLaceScale + uLaceOff);
    float lace = (0.65 * nz.g + 0.35 * nz.r - 0.5) * 1.4;
    float foam = smoothstep(0.4, 0.6, c.a + lace) * smoothstep(0.02, 0.3, c.a);
    col = mix(col, uFoamColor, foam * 0.92);
  }
  return vec4(col, 1.0);
}
`;

/**
 * A drone's-eye view straight down on a beach: deep water shading to turquoise and
 * clear shallows over sand, swell lines that break into lacy foam, run up the sand,
 * stop and drain back, and a darker wet band that slowly dries. Each wave is an
 * analytic front (no simulation texture); one low-res pass shades water, sand and
 * foam density, and the blit thresholds the foam against full-res noise.
 */
export const beach = defineEffect(beachMeta, {
  create(gl) {
    return withScope((scope) => {
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const shape = scope.own(
        createColumnTable(gl, SHAPE_COLUMNS, 4, { wrap: gl.REPEAT, data: buildShapeTable(54) }),
      );
      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, NOISE_CHANNELS),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      gl.bindTexture(gl.TEXTURE_2D, noiseTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);

      const u = createUniforms(gl, program, [
        "uShape",
        "uNoise",
        "uLowSize",
        "uAspect",
        "uAxis",
        "uWave",
        "uOff",
        "uCount",
        "uSand",
        "uWetSand",
        "uDeep",
        "uMid",
        "uShallow",
        "uCaustic",
      ]);
      const cu = createUniforms(gl, target.program, [
        "uNoise",
        "uLaceScale",
        "uLaceOff",
        "uFoamColor",
      ]);
      gl.useProgram(program);
      u.i1("uShape", 0);
      u.i1("uNoise", 1);
      gl.useProgram(target.program);
      cu.i1("uNoise", 1);
      gl.useProgram(null);

      const toRgb = unitRgbMemo();
      const sched = createWaveScheduler(54);
      const waves = new Float32Array(MAX_WAVES * WAVE_FLOATS);
      const offsets = new Float32Array(MAX_WAVES * 2);
      const axis = new Float32Array(3);
      const wetSand: Rgb = [0, 0, 0];
      let lastSand = "";

      let width = 1;
      let height = 1;
      let primed = false;
      /** Wrapped phases: caustic drift and lace drift (texture units, [0, 1)), morph (radians). */
      let causticX = 0;
      let causticY = 0;
      let laceX = 0;
      let laceY = 0;
      let morph = 0;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Math.max(0, dt);
          if (!primed) {
            primed = true;
            for (let t = 0; t < PRIME_SECONDS; t += PRIME_STEP) {
              sched.step(PRIME_STEP, p.waveTime, p.reach);
            }
          }
          sched.step(step, p.waveTime, p.reach);
          const count = packWaves(sched, p.foam, waves, offsets);
          causticX = fract(causticX + step * CAUSTIC_DRIFT[0]);
          causticY = fract(causticY + step * CAUSTIC_DRIFT[1]);
          laceX = fract(laceX + step * LACE_DRIFT[0]);
          laceY = fract(laceY + step * LACE_DRIFT[1]);
          morph = (morph + step * CAUSTIC_MORPH) % (2 * Math.PI);

          target.resize(width, height, qualityDivisor(p.quality));
          const palette = waterPalette(p.water);

          // Water, sand and foam density, into the low-res target.
          gl.useProgram(program);
          u.f2("uLowSize", target.width, target.height);
          u.f1("uAspect", width / height);
          layoutAxes(p.layout, width / height, axis);
          u.f3("uAxis", axis[0], axis[1], axis[2]);
          gl.uniform4fv(u.loc.uWave, waves);
          gl.uniform2fv(u.loc.uOff, offsets);
          u.i1("uCount", count);
          if (p.sand !== lastSand) {
            lastSand = p.sand;
            const sand = toRgb(p.sand);
            // Wet sand: darker and a little more saturated.
            for (let k = 0; k < 3; k++) {
              wetSand[k] = sand[k] * (0.65 + 0.35 * sand[k]) * 0.68;
            }
          }
          u.rgb("uSand", p.sand);
          u.v3("uWetSand", wetSand);
          u.v3("uDeep", toRgb(palette.deep));
          u.v3("uMid", toRgb(palette.mid));
          u.v3("uShallow", toRgb(palette.shallow));
          u.f4("uCaustic", causticX, causticY, Math.cos(morph), Math.sin(morph));
          target.bind();
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, shape.texture);
          triangle.draw();

          // Upscale with the full-res foam edge, to the canvas (noise stays on unit 1).
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.useProgram(target.program);
          cu.f1("uLaceScale", LACE_K / height);
          cu.f2("uLaceOff", laceX, laceY);
          cu.v3("uFoamColor", toRgb(palette.foam));
          target.blit();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
