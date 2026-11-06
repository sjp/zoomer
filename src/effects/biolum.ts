import { hexToUnitRgb, unitRgbMemo } from "./color";
import { createChangeKey } from "./change-key";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import {
  APPROACH_DIST,
  BREAK,
  CAMERA_K,
  createBiolumScheduler,
  GLOW_CAP,
  GLOW_END,
  GLOW_FADE,
  HORIZON,
  MAX_WAVES,
  packWaves,
  RISE_AFTER,
  RISE_BEFORE,
  RUNUP_LOSS,
  shoreLine,
  WAVE_FLOATS,
  WET_FADE,
  WET_TAIL,
} from "./biolum-sim";
import { biolumMeta } from "./biolum.meta";
import { createLowResTarget, qualityDivisor } from "./lowres";
import { clamp, wrap } from "./math";
import { buildPeriodicNoiseTexture, HASH32_GLSL } from "./noise";
import { defineEffect } from "./types";
import { T_ACTIVE, T_APPROACH, T_DRAIN, T_DRY, T_RUNUP, T_STOP } from "./wash";

const f = glslFloat;
const vec3 = (hex: string, k = 1) =>
  `vec3(${hexToUnitRgb(hex)
    .map((c) => f(c * k))
    .join(", ")})`;

/** Noise texture side; R and G are foam, B sea glints, A the faint plankton shimmer. */
const NOISE_SIZE = 128;
const NOISE_CHANNELS = [
  { period: 8, seed: 611 },
  { period: 16, seed: 612 },
  { period: 8, seed: 613 },
  { period: 4, seed: 614 },
] as const;
/** Foam noise tiles per world unit, along the shore and across it. */
const FOAM_KX = 2;
const FOAM_KN = 3;
/** Along-shore wiggle of a wave front, world units. */
const WIGGLE = 0.014;
/** The glow's soft spread (for the faint light on the water near a crest): 1 / falloff in band widths. */
const HALO_FALL = 0.6;
const HALO_LEVEL = 0.12;
/** Reflection on wet sand: the band mirrored about the front, this many times wider, and its level. */
const REFL_WIDEN = 2.5;
const REFL_LEVEL = 0.35;
/** White core added where the glow is strongest, per unit of intensity. */
const CORE = 0.22;
/** Faint shimmer of plankton in the surf zone between waves, per unit of intensity. */
const SHIMMER = 0.05;
/** Sea glint and shimmer drift, noise tiles per second. */
const SEA_DRIFT: readonly [number, number] = [0.003, 0.02];
const SHIMMER_DRIFT: readonly [number, number] = [-0.004, 0.011];
/** Seconds of waves simulated before the first frame, so it opens just after a break. */
const PRIME_SECONDS = 5;
const PRIME_STEP = 0.25;
/** Star grid cell and dot radius, px at 1080p; peak star brightness. */
const STAR_CELL = 16;
const STAR_RADIUS = 0.9;
const STAR_LEVEL = 0.4;

/**
 * Low-res pass: sky, sea, sand and the glowing waves. y up, height units. Below
 * the horizon each pixel maps to a shore normal n (positive landward) and an
 * along-shore position X in world units, through a pinhole camera K above the
 * water. Mirrors biolumFront, glowEnergy, foamWidth and biolumWetness.
 */
const SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uNoise;
/** Low-res px to height units, x and y. */
uniform vec2 uInvLow;
/** Shoreline y = uShore.x + uShore.y * x. */
uniform vec2 uShore;
/** Frame centre x, height units. */
uniform float uCx;
/** Per wave: A (local time at x = 0, its slope per unit x, reach, -), B (foam offsets, -, -). */
uniform vec4 uWave[${String(MAX_WAVES * 2)}];
uniform int uCount;
/** Glow colour times intensity. */
uniform vec3 uGlowColor;
uniform float uIntensity;
uniform vec2 uSeaOff;
uniform vec2 uShimmerOff;

out vec4 outColor;

const float HORIZON = ${f(HORIZON)};
const float INV_HORIZON = ${f(1 / HORIZON)};
const float INV_SKY = ${f(1 / (1 - HORIZON))};
const float K = ${f(CAMERA_K)};
const float BREAK = ${f(BREAK)};
const float APPROACH_SPEED = ${f((APPROACH_DIST - BREAK) / T_APPROACH)};
const float T_APPROACH = ${f(T_APPROACH)};
const float T_STOP = ${f(T_STOP)};
const float T_ACTIVE = ${f(T_ACTIVE)};
const float T_DRAIN = ${f(T_DRAIN)};
const float INV_RUNUP = ${f(1 / T_RUNUP)};
const float INV_DRAIN = ${f(1 / T_DRAIN)};
const float INV_DRY = ${f(1 / T_DRY)};
const float WET_END = ${f(T_ACTIVE + WET_TAIL)};
const float WET_START = ${f(T_ACTIVE + WET_TAIL - WET_FADE)};
const float INV_GLOW_FADE = ${f(1 / GLOW_FADE)};
const float GLOW_END = ${f(GLOW_END)};
const float GLOW_CAP = ${f(GLOW_CAP)};
const float WIGGLE = ${f(WIGGLE)};

const vec3 SKY_TOP = ${vec3("#020309")};
const vec3 SKY_HORIZON = ${vec3("#0b1323")};
const vec3 SEA_FAR = ${vec3("#08101c")};
const vec3 SEA_NEAR = ${vec3("#020509")};
const vec3 GLINT = ${vec3("#1a2638", 0.6)};
const vec3 SWELL = ${vec3("#14263a", 0.6)};
const vec3 SAND_DRY = ${vec3("#110f0d")};
const vec3 SAND_WET = ${vec3("#06080b")};
const vec3 SHEEN = ${vec3("#0b1424", 0.7)};

/** Mirrors washFront in wash.ts, with this effect's break and approach distances. */
float front(float t, float reach) {
  t = max(t, 0.0);
  if (t < T_APPROACH) return -BREAK - APPROACH_SPEED * (T_APPROACH - t);
  if (t < T_STOP) {
    float x = 1.0 - (t - T_APPROACH) * INV_RUNUP;
    return -BREAK + (reach + BREAK) * (1.0 - x * x);
  }
  if (t < T_ACTIVE) {
    float x = (t - T_STOP) * INV_DRAIN;
    return reach * (1.0 - x * x);
  }
  return 0.0;
}

/** Mirrors glowEnergy. */
float energy(float t) {
  float rise = smoothstep(${f(T_APPROACH - RISE_BEFORE)}, ${f(T_APPROACH + RISE_AFTER)}, t);
  float linger = 1.0 - ${f(RUNUP_LOSS)} * smoothstep(T_APPROACH, T_STOP, t);
  float drain = exp(-max(0.0, t - T_STOP) * INV_GLOW_FADE);
  float end = 1.0 - smoothstep(${f(T_STOP + 1.5)}, GLOW_END, t);
  return rise * linger * drain * end;
}

/** Mirrors foamWidth. */
float foamWidth(float t) {
  return 0.025 + 0.09 * smoothstep(T_APPROACH, T_ACTIVE, t);
}

/** A swell line's faint sheen on the approach, gone by the break. */
float swell(float t) {
  return smoothstep(0.0, 1.5, t) * (1.0 - smoothstep(T_APPROACH - 0.3, T_APPROACH + 0.2, t));
}

/** The foam band's profile across it: s = 0 at the front, 1 a band width seaward. */
float band(float s) {
  return smoothstep(-0.15, 0.05, s) * (1.0 - smoothstep(0.2, 1.0, s));
}

void main() {
  vec2 p = gl_FragCoord.xy * uInvLow;
  vec3 col;
  if (p.y >= HORIZON) {
    float h = (p.y - HORIZON) * INV_SKY;
    col = mix(SKY_HORIZON, SKY_TOP, sqrt(clamp(h, 0.0, 1.0)));
  } else {
    float depth = HORIZON - p.y;
    float ys = uShore.x + uShore.y * p.x;
    float n = K / (HORIZON - ys) - K / depth;
    float X = (p.x - uCx) * K / depth;
    float k = clamp(depth * INV_HORIZON, 0.0, 1.0);

    // Sea: dark and glossy, with sparse glints in perspective and a faint shimmer near shore.
    vec3 sea = mix(SEA_FAR, SEA_NEAR, sqrt(k));
    float z = 1.0 / (depth + 0.03);
    vec2 sq = vec2(p.x * z * 0.1, z * 0.35);
    float glint = smoothstep(0.62, 0.85, textureLod(uNoise, sq + uSeaOff, 0.0).b);
    float sparkle = smoothstep(0.6, 0.9, textureLod(uNoise, sq * 1.7 + uShimmerOff, 0.0).a);
    sea += GLINT * (glint * (1.0 - 0.5 * k));
    float surf = smoothstep(-0.9, -0.15, n) * (1.0 - smoothstep(-0.02, 0.04, n));

    float glow = 0.0;
    float refl = 0.0;
    float halo = 0.0;
    float wet = 0.0;
    float edge = 0.0;
    float ridge = 0.0;
    for (int i = 0; i < ${String(MAX_WAVES)}; i++) {
      if (i >= uCount) break;
      vec4 A = uWave[2 * i];
      vec2 off = uWave[2 * i + 1].xy;
      float t = A.x - A.y * p.x;
      float wig = WIGGLE * (sin(X * 1.9 + off.x * 6.2832) + 0.5 * sin(X * 4.3 + off.y * 6.2832));
      float fr = front(t, A.z) + wig;
      edge = max(edge, fr);
      float w = foamWidth(t);
      float s = (fr - n) / w;
      ridge += swell(t) * exp(-4.0 * s * s);
      float e = energy(t);
      if (e > 0.0) {
        float b = band(s);
        if (b > 0.0) {
          vec2 fn = textureLod(uNoise, vec2(X * ${f(FOAM_KX)}, (n - fr) * ${f(FOAM_KN)}) + off, 0.0).rg;
          float foam = smoothstep(0.3, 0.75, dot(fn, vec2(0.6, 0.4)));
          glow += e * b * mix(0.25, 1.0, foam);
        }
        // The band mirrored about the front, wider and without foam detail.
        refl += e * band(-s * ${f(1 / REFL_WIDEN)});
        halo += e * exp(-abs(s) * ${f(HALO_FALL)});
      }
      float m = t < T_STOP ? fr : A.z + wig;
      if (m > 0.0 && n <= m) {
        float q = clamp((m - n) / m, 0.0, 1.0);
        float since = t - T_STOP - T_DRAIN * sqrt(q);
        float fade = 1.0 - smoothstep(WET_START, WET_END, t);
        wet = max(wet, exp(-max(since, 0.0) * INV_DRY) * fade);
      }
    }

    // Water covers everything seaward of the furthest front; a thin sheet over the sand.
    float aa = K * uInvLow.y / (depth * depth) + 1e-4;
    float water = 1.0 - smoothstep(-aa, aa, n - edge);
    vec3 sheet = mix(sea, SAND_WET + SHEEN, smoothstep(-0.03, 0.03, n) * 0.6);
    vec3 sand = mix(SAND_DRY, SAND_WET + SHEEN, wet);
    col = mix(sand, sheet, water);
    col += SWELL * (ridge * water);

    float g = 1.0 - exp(-GLOW_CAP * glow);
    float r = (1.0 - exp(-GLOW_CAP * refl)) * ${f(REFL_LEVEL)} * max(wet, water);
    float hl = (1.0 - exp(-halo)) * ${f(HALO_LEVEL)} * water;
    col += uGlowColor * (g + r + hl + ${f(SHIMMER)} * sparkle * surf * water);
    col += vec3(g * g * ${f(CORE)} * uIntensity);
  }
  outColor = vec4(col, 1.0);
}
`;

/** Full-res blit: upscales the scene and adds dim stars above the horizon. */
const COMPOSITE = /* glsl */ `
precision highp int;
uniform vec2 uPx;
uniform float uStars;
uniform float uStarCell;
uniform float uStarSharp;

const float HORIZON = ${f(HORIZON)};
const vec3 STAR_COLOR = ${vec3("#c8d4ff")};

${HASH32_GLSL}

/** One dim star in some cells of a pixel grid. */
float star(vec2 frag) {
  vec2 cell = floor(frag / uStarCell);
  uint h = hash32(uint(cell.x) * 1973u + uint(cell.y) * 9277u + 61061u);
  if ((h & 0xffu) > 36u) return 0.0;
  vec2 jitter = vec2(float((h >> 8) & 0xffu), float((h >> 16) & 0xffu)) * (0.6 / 255.0);
  vec2 dd = frag - (cell + 0.2 + jitter) * uStarCell;
  float b = 0.25 + 0.75 * float(h >> 24) * (1.0 / 255.0);
  return b * b * exp(-dot(dd, dd) * uStarSharp);
}

vec4 composite(vec2 uv) {
  vec3 c = texture(uLowRes, uv).rgb;
  float y = gl_FragCoord.y * uPx.x;
  if (uStars > 0.0 && y > HORIZON + 0.03) {
    float fade = smoothstep(HORIZON + 0.03, HORIZON + 0.3, y);
    c += STAR_COLOR * (uStars * fade * star(gl_FragCoord.xy));
  }
  return vec4(c, 1.0);
}
`;

/**
 * A beach at night seen from the side: small waves roll in and break, and their
 * foam glows blue where plankton lights up, fading as it washes up the sand and
 * drains back. One low-res pass draws the sky, sea, sand and glow; the blit adds
 * the stars at full resolution.
 */
export const biolum = defineEffect(biolumMeta, {
  create(gl) {
    return withScope((scope) => {
      const scene = scope.add(createProgram(gl, FULLSCREEN_VERTEX, SCENE_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const noiseTexture = scope.add(
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
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));

      const u = createUniforms(gl, scene, [
        "uNoise",
        "uInvLow",
        "uShore",
        "uCx",
        "uWave",
        "uCount",
        "uGlowColor",
        "uIntensity",
        "uSeaOff",
        "uShimmerOff",
      ]);
      const cu = createUniforms(gl, target.program, ["uPx", "uStars", "uStarCell", "uStarSharp"]);
      gl.useProgram(scene);
      u.i1("uNoise", 0);
      gl.useProgram(null);

      const glowColor = unitRgbMemo();
      const sched = createBiolumScheduler(0);
      const waveData = new Float32Array(MAX_WAVES * WAVE_FLOATS);
      const shore = new Float32Array(2);
      /** Seed the scheduler was last primed with; NaN until the first frame. */
      let seed = Number.NaN;
      let seaU = 0;
      let seaV = 0;
      let shimU = 0;
      let shimV = 0;
      const sizeKey = createChangeKey(3);

      let width = 1;
      let height = 1;
      let scale = 1;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          const divisor = qualityDivisor(p.quality);
          sizeKey.set(0, width);
          sizeKey.set(1, height);
          sizeKey.set(2, divisor);
          if (sizeKey.take()) {
            target.resize(width, height, divisor);
          }

          const interval = p.interval;
          if (p.seed !== seed) {
            seed = p.seed;
            sched.reset(seed);
            for (let t = 0; t < PRIME_SECONDS; t += PRIME_STEP) {
              sched.step(PRIME_STEP, interval);
            }
          }
          sched.step(dt, interval);
          const count = packWaves(sched, aspect, waveData);
          shoreLine(p.shoreline, aspect, shore);

          seaU = wrap(seaU + dt * SEA_DRIFT[0], 0, 1);
          seaV = wrap(seaV + dt * SEA_DRIFT[1], 0, 1);
          shimU = wrap(shimU + dt * SHIMMER_DRIFT[0], 0, 1);
          shimV = wrap(shimV + dt * SHIMMER_DRIFT[1], 0, 1);

          const intensity = clamp(p.intensity, 0, 1);
          const color = glowColor(p.glowColor);

          gl.useProgram(scene);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
          gl.uniform4fv(u.loc.uWave, waveData);
          u.i1("uCount", count);
          u.f2("uInvLow", aspect / target.width, 1 / target.height);
          u.f2("uShore", shore[0], shore[1]);
          u.f1("uCx", aspect * 0.5);
          u.f3("uGlowColor", color[0] * intensity, color[1] * intensity, color[2] * intensity);
          u.f1("uIntensity", intensity);
          u.f2("uSeaOff", seaU, seaV);
          u.f2("uShimmerOff", shimU, shimV);
          target.bind();
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);

          gl.useProgram(target.program);
          cu.f2("uPx", 1 / height, height);
          cu.f1("uStars", p.stars ? STAR_LEVEL : 0);
          cu.f1("uStarCell", STAR_CELL * scale);
          const r = Math.max(STAR_RADIUS * scale, 0.6);
          cu.f1("uStarSharp", 1 / (r * r));
          target.blit();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
