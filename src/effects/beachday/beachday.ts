import { createChangeKey } from "../change-key";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  updateDataTexture,
  withScope,
} from "../gl";
import { createSkyState } from "../horizon/horizon-sim";
import { createLowResTarget } from "../lowres";
import { clamp, wrap } from "../math";
import { buildPeriodicNoiseTexture, hash32, HASH32_GLSL } from "../noise";
import { WATER_F0 } from "../sea/sea-sim";
import {
  createSeaWater,
  createSeaWaterFrame,
  SEA_SKY_GLSL,
  SEA_SKY_UNIFORMS,
} from "../sea/sea-water";
import { defineEffect } from "../types";
import { createSettledValue } from "../rebuild";
import { T_DRAIN, T_DRY } from "../wash";
import {
  APPROACH_DIST,
  beachPreset,
  beachSky,
  BIRD_FLOATS,
  BREAK,
  buildClouds,
  CAMERA_H,
  CLOUD_BOTTOM,
  CLOUD_H,
  CLOUD_SPAN,
  CLOUD_SPEED,
  CLOUD_TOP,
  CLOUD_W,
  createBeachScheduler,
  birdState,
  fillWaveTable,
  FOCAL,
  foamLevel,
  headlandColor,
  HORIZON,
  K,
  layoutSand,
  MAX_BIRDS,
  MAX_PRINTS,
  MAX_STONES,
  MAX_WAVES,
  packWavePhases,
  sunDx,
  sunSign,
  swellLevel,
  WET_END,
  WAVE_COLUMNS,
  WAVE_ROWS,
  WET_FADE,
  Z_SHORE,
} from "./beachday-sim";
import { beachdayMeta, TIME_OPTIONS } from "./beachday.meta";

const f = glslFloat;
const vec3 = (c: readonly number[]) => `vec3(${c.map((v) => f(v)).join(", ")})`;

/** The water renders at this divisor; the wash, sand and sky are full resolution. */
const WATER_DIVISOR = 2;
/** Seconds the Variation slider must hold still before the scene is rebuilt for it. */
const SEED_SETTLE = 0.3;
/** Strength of the glitter path at a preset's `glitter` = 1. */
const GLITTER_GAIN = 0.55;
/** Cap on the water's reflectance, so the far sea stays a shade darker than the sky. */
const FRESNEL_MAX = 0.8;
/** Ripple strength of the open water. */
const WIND = 0.5;
/** Foam noise: side, channels (R coarse lace, G fine lace), tiles per metre. */
const NOISE_SIZE = 256;
const NOISE_CHANNELS = [
  { period: 16, seed: 1431 },
  { period: 32, seed: 1432 },
] as const;
const FOAM_K = 0.4;
/** Lace drift, noise tiles per second, so foam never sits quite still. */
const LACE_DRIFT: readonly [number, number] = [0.004, -0.003];
/** Along-shore wiggle of a front (m): a base plus a share of its run-up so far. */
const WIG_BASE = 0.12;
const WIG_GAIN = 0.12;
/** Width (m) of the line of foam left at the top of the run-up. */
const SWASH_W = 0.05;
/** Noise tiles per metre for the foam patches left floating in the surf. */
const PATCH_K = 0.05;
/** Sand seen through the shallows fades with depth below the waterline: 1 / metres. */
const INV_CLEAR = 0.55;
/** Wet sand: its tint against dry, and how much of the sky it mirrors. */
const WET_TINT = [0.56, 0.53, 0.52] as const;
const WET_GLOSS = 0.15;
/** Cloud opacity at full density. */
const CLOUD_OPACITY = 0.92;
/** Seconds of waves simulated before the first frame, so it opens mid-wash with wet sand. */
const PRIME_SECONDS = 14;
const PRIME_STEP = 0.25;

const GEOMETRY_GLSL = /* glsl */ `
const float HORIZON = ${f(HORIZON)};
const float K = ${f(K)};
const float Z_SHORE = ${f(Z_SHORE)};
const float CAMERA_H = ${f(CAMERA_H)};
const float FOCAL = ${f(FOCAL)};
`;

/**
 * Cached pass, full resolution, redrawn only when the size or a setting it shows
 * changes. Above the horizon: the sky and sun disc (RGB) and the headland's
 * coverage (A). Below: the dry sand with its grain, ripples, shells, pebbles,
 * footprints and towel, supersampled 2x2.
 */
const CACHE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uLand;
/** 1 / frame height (px), centre x (frame heights), horizon (px), sun side (+1 right). */
uniform vec4 uFrame;
/** Disc radius (px), disc on (0 or 1). */
uniform vec2 uDisc;
uniform vec3 uDiscColor;
/** Headland on (0 or 1), mirrored (0 or 1). */
uniform vec2 uLandMap;
uniform vec3 uSand;
uniform vec3 uLight;
uniform vec4 uStone[${String(MAX_STONES * 2)}];
uniform vec4 uPrint[${String(MAX_PRINTS)}];
uniform vec4 uTowel[2];
uniform vec3 uTowelColor[3];
out vec4 outColor;
${SEA_SKY_GLSL}
${GEOMETRY_GLSL}
${HASH32_GLSL}

float hash2(vec2 c) {
  ivec2 i = ivec2(c);
  return float(hash32(uint(i.x) * 1973u ^ hash32(uint(i.y) + 7919u)) >> 8) * ${f(1 / 16777216)};
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 t = p - i;
  t = t * t * (3.0 - 2.0 * t);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), t.x),
             mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), t.x), t.y);
}

/** 1 while a feature of this size spans a few pixels, fading out as it shrinks to one. */
float keep(float size, float fp) {
  return 1.0 - smoothstep(0.5 * size, size, fp);
}

/** Sun direction over the beach: X along the shore, n landward, up. */
vec3 sunDir() {
  return normalize(vec3(0.45 * uFrame.w, -0.7, 0.55));
}

vec3 sandAt(vec2 frag) {
  float invH = uFrame.x;
  float depth = max(HORIZON - frag.y * invH, 0.002);
  float z = K / depth;
  float n = Z_SHORE - z;
  float X = (frag.x * invH - uFrame.y) * CAMERA_H / depth;
  // Footprint of one pixel on the sand (m): across, and along the view (foreshortened).
  float fp = max(z / FOCAL, z * z / K) * invH;
  vec2 w = vec2(X, n);

  float v = 0.08 * (vnoise(w * 0.55) - 0.5);
  v += 0.06 * (vnoise(w * 2.5 + 17.0) - 0.5) * keep(0.3, fp);
  // Low wind ripples on the dry sand, about 7 cm apart.
  float ripple = sin((n + 0.04 * sin(X * 7.0) + 0.05 * vnoise(w * 5.0)) * 90.0);
  v += 0.03 * ripple * keep(0.06, fp) * smoothstep(1.6, 2.4, n);
  // Grains, a few millimetres across, and sparse darker grit.
  v += 0.16 * (hash2(floor(w * 200.0)) - 0.5) * keep(0.005, fp);
  v -= 0.25 * step(0.985, hash2(floor(w * 120.0) + 31.0)) * keep(0.008, fp);
  vec3 col = uSand * (1.0 + v);

  vec3 L = sunDir();
  float aa = fp;

  // Footprints: shallow hollows, the far wall in shade and the near wall lit.
  for (int i = 0; i < ${String(MAX_PRINTS)}; i++) {
    vec4 P = uPrint[i];
    if (P.w <= 0.0) continue;
    vec2 d = w - P.xy;
    if (dot(d, d) > 0.09) continue;
    vec2 dir = vec2(sin(P.z), -cos(P.z));
    float along = dot(d, dir);
    float across = dot(d, vec2(-dir.y, dir.x));
    float hw = 0.042 + 0.014 * clamp(along / 0.13, -1.0, 1.0);
    float e = length(vec2(along / 0.13, across / hw));
    float inside = 1.0 - smoothstep(1.0 - aa / 0.05, 1.0, e);
    float rim = smoothstep(0.45, 0.95, e) * inside;
    float ring = smoothstep(0.95, 1.05, e) * (1.0 - smoothstep(1.05, 1.45, e));
    float fy = d.y / max(length(d), 1e-4);
    float shade = 1.0 - P.w * (0.08 * inside + 0.28 * rim * max(-fy, 0.0)) + P.w * 0.14 * rim * max(fy, 0.0);
    shade += P.w * 0.06 * ring * max(-fy, 0.0);
    col *= shade;
  }

  // Pebbles and shells, each with a small shadow cast towards the camera.
  for (int i = 0; i < ${String(MAX_STONES)}; i++) {
    vec4 A = uStone[2 * i];
    if (A.z <= 0.0) continue;
    vec2 d = w - A.xy;
    float r = A.z;
    if (dot(d, d) > 9.0 * r * r) continue;
    vec4 B = uStone[2 * i + 1];
    float c = cos(A.w);
    float s = sin(A.w);
    vec2 sd = d - r * vec2(-0.5 * uFrame.w, 0.8);
    vec2 sq = vec2(c * sd.x + s * sd.y, -s * sd.x + c * sd.y);
    float es = length(vec2(sq.x, sq.y / B.z)) / r;
    col *= 1.0 - 0.32 * (1.0 - smoothstep(0.7, 1.25, es));
    vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y);
    float e = length(vec2(q.x, q.y / B.z)) / r;
    float cov = 1.0 - smoothstep(1.0 - aa / r, 1.0 + aa / r, e);
    if (cov <= 0.0) continue;
    vec3 N = normalize(vec3(d / r, sqrt(max(1.0 - e * e, 0.05))));
    float lit = 0.45 + 0.75 * max(dot(N, L), 0.0);
    vec3 albedo;
    if (B.x > 0.5) {
      // A small scallop: pale, with fine ribs fanning from the hinge.
      float rib = 0.92 + 0.08 * cos(atan(q.x, q.y + r) * 18.0) * keep(r * 0.2, fp);
      albedo = mix(vec3(0.97, 0.92, 0.86), vec3(0.95, 0.78, 0.74), B.y) * rib;
    } else {
      albedo = mix(vec3(0.52, 0.5, 0.48), vec3(0.6, 0.5, 0.4), B.y);
    }
    col = mix(col, albedo * uLight * lit, cov);
  }

  // The towel: a striped rectangle lying flat, with a hem round its edge.
  vec4 T = uTowel[0];
  vec4 T1 = uTowel[1];
  if (T1.y > 0.5) {
    vec2 d = w - T.xy;
    float c = cos(T1.x);
    float s = sin(T1.x);
    float tu = c * d.x + s * d.y;
    float tv = -s * d.x + c * d.y;
    float cov = (1.0 - smoothstep(T.z - aa, T.z + aa, abs(tu)))
      * (1.0 - smoothstep(T.w - aa, T.w + aa, abs(tv)));
    if (cov > 0.0) {
      float k = (tu / T.z * 0.5 + 0.5) * 7.0;
      int band = int(clamp(floor(k), 0.0, 6.0));
      int idx = band == 1 || band == 5 ? 1 : band == 3 ? 2 : 0;
      vec3 cloth = uTowelColor[idx];
      float hem = smoothstep(0.0, 0.035, min(T.z - abs(tu), T.w - abs(tv)));
      float fold = 0.94 + 0.1 * vnoise(vec2(tu, tv) * 3.0) + 0.05 * (hash2(floor(vec2(tu, tv) * 300.0)) - 0.5) * keep(0.004, fp);
      col = mix(col, cloth * uLight * fold * mix(0.85, 1.0, hem), cov);
    }
  }
  return col;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  float invH = uFrame.x;
  if (p.y > uFrame.z - 0.5) {
    vec2 q = (p - vec2(uFrame.y / invH, uFrame.z)) * invH;
    vec3 c = sky(q);
    float dist = length(q - uSkyA.xy) / invH;
    c = mix(c, uDiscColor, clamp(uDisc.x - dist + 0.5, 0.0, 1.0) * uDisc.y);
    float land = 0.0;
    if (uLandMap.x > 0.5) {
      float u = p.x * invH / (2.0 * uFrame.y);
      float lh = texture(uLand, vec2(mix(u, 1.0 - u, uLandMap.y), 0.5)).r;
      land = clamp(lh / invH - (p.y - uFrame.z) + 0.5, 0.0, 1.0);
    }
    outColor = vec4(c, land);
  } else {
    vec3 c = sandAt(p + vec2(-0.25, -0.25)) + sandAt(p + vec2(0.25, -0.25))
      + sandAt(p + vec2(-0.25, 0.25)) + sandAt(p + vec2(0.25, 0.25));
    outColor = vec4(0.25 * c, 1.0);
  }
}
`;

/**
 * Per-frame composite while upscaling the water: the cached sky with drifting
 * clouds, the headland and gulls above the horizon; below it the water
 * (turquoise over the sand in the shallows), the waves' crests, foam, wash and
 * wet sand over the cached sand. Mirrors beachFront's foam and wetness through
 * the per-column wave table (see fillWaveTable).
 */
const COMPOSITE_GLSL = /* glsl */ `
precision highp int;
uniform sampler2D uCache;
uniform sampler2D uNoise;
uniform sampler2D uClouds;
uniform sampler2D uWaves;
/** 1 / frame height (px), centre x (frame heights), horizon (px), highest low-res v of water. */
uniform vec4 uFrame;
uniform vec2 uWaveOff[${String(MAX_WAVES)}];
uniform int uCount;
uniform vec3 uDeep;
uniform vec3 uTeal;
uniform vec3 uTurq;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform vec3 uCrest;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform vec3 uLandColor;
uniform vec3 uBird;
/** Cloud strip offset (fraction of a repeat), lace drift. */
uniform vec3 uDrift;
uniform vec4 uBirdA[${String(MAX_BIRDS)}];
uniform vec2 uBirdLift;
${GEOMETRY_GLSL}
const float BREAK = ${f(BREAK)};
const float APPROACH_DIST = ${f(APPROACH_DIST)};
const float T_DRAIN = ${f(T_DRAIN)};
const float INV_DRY = ${f(1 / T_DRY)};
const float WET_END = ${f(WET_END)};
const float WET_FADE = ${f(WET_FADE)};
const float WAVE_ROWS = ${f(WAVE_ROWS)};
const vec3 WET_TINT = ${vec3(WET_TINT)};

float sq(float x) { return x * x; }

vec3 ground(vec2 p, vec2 uv, vec3 sand) {
  float invH = uFrame.x;
  float depth = max(HORIZON - p.y * invH, 1e-4);
  float z = K / depth;
  float n = Z_SHORE - z;
  float X = (p.x * invH - uFrame.y) * CAMERA_H / depth;
  // Metres of beach per pixel, along the view and across it.
  float dn = z * z / K * invH;
  float dX = z / FOCAL * invH;
  vec3 wtex = textureLod(uLowRes, vec2(uv.x, min(uv.y, uFrame.w)), 0.0).rgb;

  float edge = 0.0;
  float wet = 0.0;
  float sheet = 0.0;
  float dens = 0.0;
  float best = 0.0;
  float bestD = 0.0;
  vec2 bestOff = vec2(0.0);
  float resid = 0.0;
  // The nearest wave face in front of this pixel: height up it (1 = crest), whitecap, coverage.
  float faceT = 0.0;
  float faceCap = 0.0;
  float faceA = 0.0;
  float faceX = 0.0;
  if (n > -APPROACH_DIST - 3.0) {
    float surf = smoothstep(-BREAK - 2.0, -BREAK + 1.0, n) * (1.0 - smoothstep(-0.2, 0.4, n));
    float aa = dn + 0.02;
    // Oldest (nearest) wave last, so its face covers the ones behind it.
    for (int j = 0; j < ${String(MAX_WAVES)}; j++) {
      int i = uCount - 1 - j;
      if (i < 0) break;
      vec4 A = textureLod(uWaves, vec2(uv.x, (float(2 * i) + 0.5) / WAVE_ROWS), 0.0);
      vec4 B = textureLod(uWaves, vec2(uv.x, (float(2 * i) + 1.5) / WAVE_ROWS), 0.0);
      vec2 ph = uWaveOff[i];
      float m = A.y;
      float wig = (${f(WIG_BASE)} + ${f(WIG_GAIN)} * max(m, 0.0))
        * (0.6 * sin(X * 0.8 + ph.x) + 0.4 * sin(X * 2.1 + ph.y));
      float fr = A.x + wig;
      float d = fr - n;
      edge = max(edge, fr);
      float ml = m + wig;
      if (m > 0.0) {
        // Wet until the draining sheet uncovers it, then drying (see wash.ts).
        float q = clamp((ml - n) / m, 0.0, 1.0);
        float since = max(A.z - T_DRAIN * sqrt(q), 0.0);
        float fade = 1.0 - smoothstep(WET_END - WET_FADE, WET_END, A.z);
        wet = max(wet, smoothstep(-aa, aa, ml - n) * exp(-since * INV_DRY) * fade);
      }
      sheet = max(sheet, (1.0 - 0.6 * smoothstep(0.0, T_DRAIN, A.z)) * smoothstep(-aa, aa, d));

      // The face: the view ray passes the crest line at height CAMERA_H (1 - zc / z); below
      // the wave's height it meets the face instead of the water behind. s = 1 at the crest.
      if (A.w > 0.003 && d > -aa) {
        float zc = Z_SHORE - fr;
        float s = CAMERA_H * (1.0 - zc / z) / A.w;
        float sa = CAMERA_H * zc / (z * z) * dn / A.w + 0.02;
        float cov = smoothstep(-dn, dn, d) * (1.0 - smoothstep(1.0 - sa, 1.0 + sa, s));
        // Far faces fade into the water: a low swell line, not a wall.
        cov *= 1.0 - smoothstep(14.0, 30.0, zc);
        if (cov > 0.0) {
          float t = clamp(s, 0.0, 1.0);
          // The breaking lip whitens from the top down.
          float cap = B.x * smoothstep(1.0 - 1.4 * B.x, 1.05 - 0.6 * B.x, t);
          faceT = mix(faceT, t, cov);
          faceCap = mix(faceCap, clamp(cap, 0.0, 1.0), cov);
          faceA = max(faceA, cov);
          faceX = ph.x;
        }
      }

      float band = B.x * smoothstep(-aa, aa, d) * exp(-max(d, 0.0) * B.y)
        + B.w * exp(-sq((n - ml) / (${f(SWASH_W)} + dn)));
      resid = max(resid, B.z * surf * smoothstep(0.0, 1.0, d));
      dens += band;
      if (band > best) {
        best = band;
        bestD = d;
        bestOff = ph;
      }
    }
  }

  // Foam: solid where the band is dense, breaking into lace where it thins.
  float foam = 0.0;
  if (dens > 0.01) {
    vec2 q = vec2(X, bestD * 0.5) * ${f(FOAM_K)} + bestOff * 0.159 + uDrift.yz;
    float lod = log2(max(max(dX, dn * 0.5) * ${f(FOAM_K * NOISE_SIZE)}, 1.0));
    vec4 nz = textureLod(uNoise, q, lod);
    foam = smoothstep(0.4, 0.56, dens * 1.3 + (0.6 * nz.r + 0.4 * nz.g - 0.5) * 1.1);
  }
  // Patches left floating in the surf zone, thinning as they dissolve.
  if (resid > 0.01) {
    vec2 q = vec2(X, n * 1.6) * ${f(PATCH_K)} + uDrift.yz;
    float lod = log2(max(max(dX, dn * 1.6) * ${f(PATCH_K * NOISE_SIZE)}, 1.0));
    vec4 nz = textureLod(uNoise, q, lod);
    float v = 0.55 * nz.r + 0.45 * nz.g;
    foam = max(foam, 0.7 * resid * smoothstep(0.78 - 0.2 * resid, 0.86 - 0.2 * resid, v));
  }

  float damp = max(0.85 * (1.0 - smoothstep(0.1, 0.6, n)) + 0.3 * (1.0 - smoothstep(0.6, 2.2, n)), wet);
  vec3 wetSand = sand * WET_TINT;
  vec3 col = mix(sand, wetSand, damp) + wtex * (${f(WET_GLOSS)} * damp * damp);

  // Water: the low-res surface (reflection and glitter over uDeep), with its body
  // colour swapped for one by distance, and the sand showing through the shallows.
  float sn = depth / length(vec2(depth, FOCAL));
  float m1 = 1.0 - sn;
  float m2 = m1 * m1;
  float F = min(${f(WATER_F0)} + ${f(1 - WATER_F0)} * m2 * m2 * m1, ${f(FRESNEL_MAX)});
  vec3 body = mix(uDeep, uTeal, smoothstep(-80.0, -15.0, n));
  body = mix(body, uTurq, smoothstep(-15.0, -3.0, n));
  body = mix(body, wetSand * uShallow, exp(min(n, 0.0) * ${f(INV_CLEAR)}));
  vec3 water = wtex + (body - uDeep) * (1.0 - F);
  float cover = max(sheet, 1.0 - smoothstep(-dn, dn, n - edge));
  col = mix(col, water, cover);
  // Foam lies on the water; a wave's face stands in front of whatever is behind it:
  // shaded at its foot, lit through near the crest, with the breaking lip white.
  col = mix(col, uFoam, foam);
  if (faceA > 0.0) {
    vec3 face = mix(water * 0.72, mix(water, uCrest, 0.55) * 1.12, smoothstep(0.15, 1.0, faceT));
    if (faceCap > 0.01) {
      vec2 q = vec2(X * ${f(FOAM_K)}, faceT * 0.6) + faceX * 0.159 + uDrift.yz;
      vec4 nz = textureLod(uNoise, q, log2(max(dX * ${f(FOAM_K * NOISE_SIZE)}, 1.0)));
      float cap = smoothstep(0.3, 0.6, faceCap * 1.2 + (0.6 * nz.r + 0.4 * nz.g - 0.5) * 0.9);
      face = mix(face, uFoam * 0.94, cap);
    }
    col = mix(col, face, faceA);
  }
  return col;
}

vec3 skyPart(vec2 p, vec4 cache) {
  float invH = uFrame.x;
  vec3 c = cache.rgb;
  float h = p.y * invH - HORIZON;
  float cv = (h - ${f(CLOUD_BOTTOM)}) * ${f(1 / (CLOUD_TOP - CLOUD_BOTTOM))};
  if (cv > 0.0 && cv < 1.0) {
    vec2 cl = textureLod(uClouds, vec2(p.x * invH * ${f(1 / CLOUD_SPAN)} + uDrift.x, cv), 0.0).rg;
    c = mix(c, mix(uCloudShade, uCloudLit, cl.g), cl.r * ${f(CLOUD_OPACITY)});
  }
  c = mix(c, uLandColor, cache.a);
  vec2 s = p * invH;
  for (int i = 0; i < ${String(MAX_BIRDS)}; i++) {
    vec4 b = uBirdA[i];
    if (b.w <= 0.0) continue;
    vec2 d = (s - b.xy) / b.z;
    if (abs(d.x) > 1.2 || abs(d.y) > 1.2) continue;
    float ax = abs(d.x);
    // A gull's wings: up from the body, tips drooping.
    float lift = i == 0 ? uBirdLift.x : uBirdLift.y;
    float yc = lift * ax * (1.6 - 1.2 * ax) - 0.15 * ax * ax;
    float th = 0.16 - 0.1 * ax;
    float dist = (abs(d.y - yc) - th) * b.z / invH;
    float cov = clamp(0.6 - dist, 0.0, 1.0) * (1.0 - smoothstep(0.92, 1.05, ax));
    c = mix(c, uBird, cov * b.w);
  }
  return c;
}

vec4 composite(vec2 uv) {
  vec2 p = gl_FragCoord.xy;
  vec4 cache = texelFetch(uCache, ivec2(p), 0);
  float above = clamp(p.y - uFrame.z + 0.5, 0.0, 1.0);
  vec3 col = vec3(0.0);
  if (above < 1.0) col = ground(p, uv, cache.rgb);
  if (above > 0.0) col = mix(col, skyPart(p, cache), above);
  return vec4(col, 1.0);
}
`;

const TIMES: readonly string[] = TIME_OPTIONS.map((o) => o.value);

/**
 * A sunny sandy beach seen from the sand, looking out to sea: small waves peel
 * along the shore, break into lacy foam, run up the sand and drain back, leaving
 * wet sand that dries; a glitter path under the sun, slow clouds and the odd
 * gull. The speaker sits in front, covering the middle.
 *
 * Three passes: the sky and sand (with every static detail) are cached at full
 * resolution; the Calm Sea's water pass renders the open water at reduced
 * resolution each frame; and one full-resolution composite adds clouds, gulls,
 * the shallows, foam and wet sand while upscaling the water.
 */
export const beachday = defineEffect(beachdayMeta, {
  create(gl) {
    return withScope((scope) => {
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE_GLSL }));
      const triangle = scope.own(createFullscreenTriangle(gl));
      const water = scope.own(createSeaWater(gl, triangle, 0));
      const cacheProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, CACHE_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const cu = createUniforms(gl, cacheProgram, [
        "uLand",
        "uFrame",
        "uDisc",
        "uDiscColor",
        "uLandMap",
        "uSand",
        "uLight",
        "uStone",
        "uPrint",
        "uTowel",
        "uTowelColor",
        ...SEA_SKY_UNIFORMS,
      ]);
      const u = createUniforms(gl, target.program, [
        "uCache",
        "uNoise",
        "uClouds",
        "uWaves",
        "uFrame",
        "uWaveOff",
        "uCount",
        "uDeep",
        "uTeal",
        "uTurq",
        "uShallow",
        "uFoam",
        "uCrest",
        "uCloudLit",
        "uCloudShade",
        "uLandColor",
        "uBird",
        "uDrift",
        "uBirdA",
        "uBirdLift",
      ]);

      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
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
      const cloudTex = scope.add(
        createDataTexture(gl, {
          width: CLOUD_W,
          height: CLOUD_H,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: new Uint8Array(CLOUD_W * CLOUD_H * 2),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      gl.bindTexture(gl.TEXTURE_2D, cloudTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      const waveTable = scope.own(createColumnTable(gl, WAVE_COLUMNS, 4, { rows: WAVE_ROWS }));

      gl.useProgram(cacheProgram);
      cu.i1("uLand", 1);
      gl.useProgram(target.program);
      u.i1("uCache", 1);
      u.i1("uNoise", 2);
      u.i1("uClouds", 3);
      u.i1("uWaves", 4);
      gl.useProgram(null);

      let cache: RenderTarget | null = null;
      scope.defer(() => {
        cache?.dispose();
      });

      const sky = createSkyState();
      const wf = createSeaWaterFrame(sky);
      const landRgb = wf.landColor;
      const sched = createBeachScheduler(0);
      const phases = new Float32Array(MAX_WAVES * 2);
      const birds = new Float32Array(MAX_BIRDS * BIRD_FLOATS);
      const birdA = new Float32Array(MAX_BIRDS * 4);
      const cacheKey = createChangeKey(6);
      let preset = beachPreset("afternoon");
      let presetIndex = -1;
      let seed = Number.NaN;
      // Each Variation step re-primes the waves, rebuilds the clouds and the headland
      // and redraws the cached scene, so a slider drag rebuilds once, when it settles.
      const settledSeed = createSettledValue<number>(SEED_SETTLE);
      const cloudData = new Uint8Array(CLOUD_W * CLOUD_H * 2);
      /** Unwrapped clock for the gulls (CPU only). */
      let clock = 0;
      let cloudU = 0;
      let laceU = 0;
      let laceV = 0;

      let width = 1;
      let height = 1;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          cache?.dispose();
          cache = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          if (!cache) {
            return;
          }
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const aspect = width / height;
          const waves = clamp(p.waves, 0, 1);
          target.resize(width, height, WATER_DIVISOR);

          const ti = Math.max(0, TIMES.indexOf(p.time));
          if (ti !== presetIndex) {
            presetIndex = ti;
            preset = beachPreset(p.time);
            beachSky(preset, sky);
            headlandColor(sky, preset, landRgb);
          }
          const wantSeed = settledSeed.update(p.seed, step);
          const mirror = (hash32(Math.floor(wantSeed) + 77) & 1) === 1;
          if (wantSeed !== seed) {
            seed = wantSeed;
            sched.reset(seed);
            for (let t = 0; t < PRIME_SECONDS; t += PRIME_STEP) {
              sched.step(PRIME_STEP, waves);
            }
            gl.activeTexture(gl.TEXTURE1);
            water.setLandSeed(seed);
            gl.activeTexture(gl.TEXTURE0);
            updateDataTexture(
              gl,
              cloudTex,
              CLOUD_W,
              CLOUD_H,
              gl.RG,
              gl.UNSIGNED_BYTE,
              buildClouds(seed, cloudData),
            );
          }

          // Motion.
          sched.step(step, waves);
          fillWaveTable(sched, foamLevel(waves), waveTable.data);
          gl.activeTexture(gl.TEXTURE4);
          waveTable.upload();
          gl.activeTexture(gl.TEXTURE0);
          packWavePhases(sched, phases);
          water.advance(step, WIND);
          clock += step;
          cloudU = wrap(cloudU + (step * CLOUD_SPEED) / CLOUD_SPAN, 0, 1);
          laceU = wrap(laceU + step * LACE_DRIFT[0], 0, 1);
          laceV = wrap(laceV + step * LACE_DRIFT[1], 0, 1);
          for (let i = 0; i < MAX_BIRDS; i++) {
            birdState(clock, seed, i, aspect, birds, i * BIRD_FLOATS);
            birdA[i * 4] = birds[i * BIRD_FLOATS];
            birdA[i * 4 + 1] = birds[i * BIRD_FLOATS + 1];
            birdA[i * 4 + 2] = birds[i * BIRD_FLOATS + 2];
            birdA[i * 4 + 3] = p.birds ? birds[i * BIRD_FLOATS + 3] : 0;
          }

          const horizonPx = HORIZON * height;
          const cx = aspect / 2;
          const sunX = sunDx(p.sun, aspect);
          const side = sunSign(p.sun);
          const skyK = 1 / (1 - HORIZON);

          // 1. The cached sky and sand, when the size or a setting they show changes.
          cacheKey.set(0, width);
          cacheKey.set(1, height);
          cacheKey.set(2, ti);
          cacheKey.set(3, side);
          cacheKey.set(4, p.towel ? 1 : 0);
          cacheKey.set(5, seed);
          if (cacheKey.take()) {
            const layout = layoutSand(seed, aspect, p.sun, p.towel);
            gl.useProgram(cacheProgram);
            cu.f4("uFrame", 1 / height, cx, horizonPx, side);
            cu.f2("uDisc", preset.disc * height, 1);
            cu.v3("uDiscColor", preset.discColor);
            cu.f2("uLandMap", 1, mirror ? 1 : 0);
            cu.v3("uSand", preset.sand);
            cu.v3("uLight", preset.lightColor);
            cu.v3("uZenith", sky.zenith);
            cu.v3("uHorizon", sky.horizon);
            cu.v3("uGlow", sky.glow);
            cu.f4("uSkyA", sunX, preset.sunY, sky.glowStrength, skyK);
            gl.uniform4fv(cu.loc.uStone, layout.stones);
            gl.uniform4fv(cu.loc.uPrint, layout.prints);
            gl.uniform4fv(cu.loc.uTowel, layout.towel);
            gl.uniform3fv(cu.loc.uTowelColor, layout.towelColors);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, water.landTexture);
            gl.activeTexture(gl.TEXTURE0);
            cache.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }

          // 2. The open water, low-res, rows below the horizon only.
          const lowW = target.width;
          const lowH = target.height;
          const pxLow = height / lowH;
          const waterRows = Math.min(lowH, Math.ceil(horizonPx / pxLow) + 2);
          const glitter = preset.glitter * GLITTER_GAIN;
          for (let c = 0; c < 3; c++) {
            wf.lightColor[c] = preset.lightColor[c] * glitter;
          }
          wf.lowToFullX = width / lowW;
          wf.lowToFullY = pxLow;
          wf.centreX = width / 2;
          wf.horizonPx = horizonPx;
          wf.focalPx = FOCAL * height;
          wf.focal = FOCAL;
          wf.cameraHeight = CAMERA_H;
          wf.aspectInv = height / width;
          wf.swell = swellLevel(waves);
          wf.wind = WIND;
          wf.lightX = sunX;
          wf.lightY = preset.sunY;
          wf.roughness = preset.roughness;
          wf.fresnelMax = FRESNEL_MAX;
          wf.deep = preset.deep;
          wf.skyK = skyK;
          wf.land = true;
          wf.mirror = mirror;
          target.bind();
          gl.viewport(0, 0, lowW, waterRows);
          water.draw(wf);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);

          // 3. Composite at full res while upscaling the water.
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, cache.texture);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, cloudTex);
          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_2D, waveTable.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.useProgram(target.program);
          u.f4("uFrame", 1 / height, cx, horizonPx, (waterRows - 0.5) / lowH);
          gl.uniform2fv(u.loc.uWaveOff, phases);
          u.i1("uCount", sched.count);
          u.v3("uDeep", preset.deep);
          u.v3("uTeal", preset.teal);
          u.v3("uTurq", preset.turquoise);
          u.v3("uShallow", preset.shallowTint);
          u.v3("uFoam", preset.foam);
          u.v3("uCrest", preset.crest);
          u.v3("uCloudLit", preset.cloudLit);
          u.v3("uCloudShade", preset.cloudShade);
          u.v3("uLandColor", landRgb);
          u.v3("uBird", preset.bird);
          u.f3("uDrift", cloudU, laceU, laceV);
          gl.uniform4fv(u.loc.uBirdA, birdA);
          u.f2("uBirdLift", birds[4], birds[BIRD_FLOATS + 4]);
          target.blit();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
