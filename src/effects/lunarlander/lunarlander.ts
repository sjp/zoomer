import { advanceGraph, createGraphWalk, type GraphWalk, walkWander } from "../graph-walk";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  updateDataTexture,
  withScope,
} from "../gl";
import { LAND_MASK_BIAS, LAND_MASK_GAIN, loadLandMask, uploadLandMask } from "../land-mask";
import { lowResSize } from "../lowres";
import { approach, clamp, smoothstep } from "../math";
import { HASH32_GLSL, hash32 } from "../noise";
import {
  buildCloudsSteps,
  buildSurfaceSteps,
  CLOUD_H,
  CLOUD_SOFT,
  CLOUD_W,
  cloudShaping,
  SURFACE_H,
  SURFACE_W,
  WORLDS,
} from "../planet/planet-sim";
import { drawGlyphAtlas, GLYPH_AT_GLSL } from "../splitflap/splitflap-atlas";
import { defineEffect } from "../types";
import { createBackgroundBuild } from "../rebuild";
import {
  ascentAt,
  BREAKERS,
  type CabinLayout,
  cabinLayout,
  CHECKLIST,
  CLIMB_RATE,
  climbHeight,
  createPlume,
  DIAL_START,
  DIAL_SWEEP,
  dialBase,
  dustLevel,
  earthTurn,
  elevationY,
  EYE_H,
  FRAME_W,
  HORIZON_Y,
  horizonDip,
  LAMPS,
  MAX_DIALS,
  MAX_PANELS,
  MOON_R,
  needleAngle,
  needleReading,
  PITCH,
  plumeAt,
  SUN_AZIMUTH,
  sunElevation,
  SWITCHES,
  TAN_HALF_FOV,
  warningGlow,
  windowSpan,
} from "./lunarlander-sim";
import { lunarlanderMeta } from "./lunarlander.meta";

const g = glslFloat;

/** The ground cache is never taller than this, so lift-off from a 4K canvas costs no more than 1080p. */
const GROUND_MAX_H = 1080;
/**
 * CPU milliseconds per frame spent building the Earth's clouds and the lunar
 * surface seen from orbit, which together take a few hundred ms in one go.
 */
const BUILD_BUDGET_MS = 2;
/** Seconds the Earth's clouds take to fade in once built. */
const CLOUD_FADE_SECONDS = 2;
/** Horizon angles stored in the ground cache run 0..HORIZON_MAX radians. */
const HORIZON_MAX = 0.5;
/** Glyph atlas cell, in texels: labels are tiny, so one small atlas serves every size. */
const ATLAS_CW = 20;
const ATLAS_CH = 28;
/** Seconds a needle takes to settle on its new reading. */
const NEEDLE_LAG = 1.5;
/** Dust motes' grid cell (frame units), fall speed (frame units per second) and grid period (cells). */
const MOTE_CELL = 0.035;
const MOTE_FALL = 0.004;
const MOTE_PERIOD = 4096;
/** The plume's height (frame units) when fully risen, and its inset from the window's edges. */
const PLUME_HEIGHT = 0.05;
const PLUME_INSET = 0.035;
/** Planet texture seed for the Earth's clouds and the Moon's ground seen from orbit, and the Earth's cloud cover. */
const BODY_SEED = 3;
const EARTH_CLOUDS = 0.5;

/** The camera: rays for frame-unit points (origin at the centre, y up, one unit the frame's height). */
const CAMERA_GLSL = /* glsl */ `
const float TAN_HALF = ${g(TAN_HALF_FOV)};
const vec3 FWD = vec3(0.0, ${g(-Math.sin(PITCH))}, ${g(Math.cos(PITCH))});
const vec3 UPV = vec3(0.0, ${g(Math.cos(PITCH))}, ${g(Math.sin(PITCH))});
vec3 rayDir(vec2 f) {
  vec2 a = f * (2.0 * TAN_HALF);
  return normalize(vec3(a.x, 0.0, 0.0) + FWD + a.y * UPV);
}
`;

/** Hashed value noise on a lattice, for the ground. */
const NOISE_GLSL = /* glsl */ `
${HASH32_GLSL}
float r8(uint h, int k) {
  return float((h >> uint(8 * k)) & 255u) / 255.0;
}
uint cellHash(vec2 c, uint salt) {
  ivec2 i = ivec2(c) + 65536;
  return hash32(uint(i.x) * 0x9e3779b9u ^ hash32(uint(i.y) ^ salt));
}
float vnoise(vec2 p, uint salt) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = float(cellHash(i, salt) >> 8);
  float b = float(cellHash(i + vec2(1.0, 0.0), salt) >> 8);
  float c = float(cellHash(i + vec2(0.0, 1.0), salt) >> 8);
  float d = float(cellHash(i + vec2(1.0, 1.0), salt) >> 8);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) / 16777216.0;
}
`;

/**
 * The ground outside, ray-marched once per resize or variation into a cache:
 * a rolling height field with three sizes of crater, boulders and a couple of
 * trails of footprints, on a Moon that curves away to a horizon about 4 km
 * off. Each texel keeps the ground's albedo (0 for sky), its normal's x and z,
 * and how high the skyline stands towards the sun, so the composite can light
 * it and cast the long shadows for any sun height without marching again.
 */
const GROUND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uAspect;
uniform uint uSalt;
uniform vec2 uSunDir;
uniform float uTrail;
out vec4 outColor;
${CAMERA_GLSL}
${NOISE_GLSL}
const float INV_2R = ${g(1 / (2 * MOON_R))};
const mat2 ROT_A = mat2(0.8, 0.6, -0.6, 0.8);
const mat2 ROT_B = mat2(0.28, -0.96, 0.96, 0.28);
const mat2 ROT_C = mat2(-0.5, 0.866, -0.866, -0.5);

// A crater layer: cells C across, a crater in a share 'prob' of them (radius
// r0..r1, kept inside its cell). Returns the height and a fresh crater's
// bright ejecta ring.
vec2 crater(vec2 q, float C, float prob, float r0, float r1, uint salt) {
  vec2 cell = floor(q / C);
  uint h = cellHash(cell, salt);
  if (r8(h, 0) > prob) {
    return vec2(0.0);
  }
  float R = mix(r0, r1, r8(h, 1) * r8(h, 1));
  vec2 c = (cell + 0.5) * C + (vec2(r8(h, 2), r8(h, 3)) - 0.5) * (C - 2.7 * R);
  float d = length(q - c) / R;
  if (d >= 1.3) {
    return vec2(0.0);
  }
  float s = (d - 1.0) / 0.3;
  float z = d < 1.0 ? 0.24 * (d * d - 1.0) + 0.06 : 0.06 * (1.0 - s) * (1.0 - s);
  float fresh = (hash32(h) & 3u) == 0u ? 1.0 - smoothstep(0.8, 1.3, d) : 0.0;
  return vec2(z * R, fresh);
}

float boulder(vec2 q) {
  const float C = 2.2;
  vec2 cell = floor(q / C);
  uint h = cellHash(cell, uSalt ^ 0x5bd1e995u);
  if (r8(h, 0) > 0.09) {
    return 0.0;
  }
  float R = mix(0.1, 0.45, r8(h, 1) * r8(h, 1));
  vec2 c = (cell + 0.5) * C + (vec2(r8(h, 2), r8(h, 3)) - 0.5) * (C - 2.0 * R);
  vec2 v = (q - c) / R;
  float d2 = dot(v, v);
  return d2 < 1.0 ? 0.7 * R * sqrt(1.0 - d2) : 0.0;
}

float height(vec2 q, bool detail) {
  float h = 9.0 * vnoise(q / 520.0, uSalt) + 2.2 * vnoise(q / 90.0, uSalt + 1u)
    + 0.6 * vnoise(q / 24.0, uSalt + 2u);
  h += crater(ROT_A * q, 70.0, 0.6, 7.0, 20.0, uSalt + 3u).x;
  h += crater(ROT_B * q, 16.0, 0.5, 1.2, 3.5, uSalt + 4u).x;
  if (detail) {
    h += 0.12 * vnoise(q / 5.0, uSalt + 5u) + crater(ROT_C * q, 5.0, 0.35, 0.3, 1.1, uSalt + 6u).x;
    h += boulder(q);
  }
  return h - dot(q, q) * INV_2R;
}

// Two trails of footprints wandering across the view 30-45 m out.
float prints(vec2 q) {
  float s = q.x + 34.0;
  if (s < 0.0 || s > 68.0 || q.y < 20.0 || q.y > 60.0) {
    return 1.0;
  }
  float dark = 0.0;
  for (int k = 0; k < 2; k++) {
    float zc = 37.0 + 5.0 * sin(s / 9.0 + uTrail) + float(k) * (1.4 + 0.8 * sin(s / 5.0));
    float n = floor(s / 0.72);
    float side = mod(n, 2.0) < 0.5 ? -1.0 : 1.0;
    vec2 v = vec2(s - (n + 0.5) * 0.72, q.y - zc - side * 0.14) / vec2(0.15, 0.065);
    dark = max(dark, 1.0 - smoothstep(0.55, 1.0, dot(v, v)));
  }
  return 1.0 - 0.3 * dark;
}

float albedo(vec2 q, bool detail) {
  float a = 0.56 + 0.18 * (vnoise(q / 170.0, uSalt + 7u) - 0.5) + 0.08 * (vnoise(q / 11.0, uSalt + 8u) - 0.5);
  a += 0.12 * crater(ROT_B * q, 16.0, 0.5, 1.2, 3.5, uSalt + 4u).y;
  if (detail) {
    a += 0.1 * crater(ROT_C * q, 5.0, 0.35, 0.3, 1.1, uSalt + 6u).y;
  }
  return clamp(a * prints(q), 0.12, 1.0);
}

void main() {
  vec2 f = (gl_FragCoord.xy / uRes - 0.5) * vec2(uAspect, 1.0);
  vec3 d = rayDir(f);
  outColor = vec4(0.0);
  if (d.y > 0.02) {
    return;
  }
  vec3 ro = vec3(0.0, ${g(EYE_H)} + height(vec2(0.0), true), 0.0);
  float t = 0.5;
  float tPrev = t;
  bool hit = false;
  for (int i = 0; i < 260; i++) {
    vec3 p = ro + d * t;
    float dh = p.y - height(p.xz, t < 250.0);
    if (dh < 0.0) {
      hit = true;
      break;
    }
    if (t > 6000.0 || (d.y > 0.0 && p.y > ro.y + 20.0)) {
      break;
    }
    tPrev = t;
    t += max(0.4 * dh, 0.01 + 0.04 * t);
  }
  if (!hit) {
    return;
  }
  for (int i = 0; i < 6; i++) {
    float tm = 0.5 * (tPrev + t);
    vec3 p = ro + d * tm;
    if (p.y < height(p.xz, tm < 250.0)) {
      t = tm;
    } else {
      tPrev = tm;
    }
  }
  bool detail = t < 250.0;
  vec3 P = ro + d * t;
  float e = max(0.03, 0.0025 * t);
  vec3 n = normalize(vec3(
    height(P.xz - vec2(e, 0.0), detail) - height(P.xz + vec2(e, 0.0), detail),
    2.0 * e,
    height(P.xz - vec2(0.0, e), detail) - height(P.xz + vec2(0.0, e), detail)));
  float h0 = height(P.xz, detail);
  float best = 0.0;
  float x = 0.15;
  for (int i = 0; i < 42; i++) {
    best = max(best, (height(P.xz + uSunDir * x, detail && x < 40.0) - h0) / x);
    x *= 1.2;
  }
  float horizon = atan(best) / ${g(HORIZON_MAX)};
  outColor = vec4(albedo(P.xz, detail), n.x * 0.5 + 0.5, n.z * 0.5 + 0.5, clamp(horizon, 0.0, 1.0));
}
`;

/**
 * The cabin, drawn once per resize or variation with four samples per pixel:
 * the grey-green bulkhead and its handrail, the panels of guarded toggle
 * switches, circuit breakers, caution lamps and strapped-on checklists, the
 * gauges' faces, the master alarm's housing, and the two thick-framed
 * triangular windows. Alpha is the glass's coverage; under the glass the colour
 * is what the glass reflects, a faint sheen and the sun's glare streak.
 */
const CABIN_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform uint uSalt;
uniform vec4 uPanels[${String(MAX_PANELS)}];
uniform int uKinds[${String(MAX_PANELS)}];
uniform int uPanelCount;
uniform vec3 uDials[${String(MAX_DIALS)}];
uniform int uDialCount;
uniform vec4 uLamp;
uniform vec2 uWinA;
uniform vec2 uWinB;
uniform vec2 uWinC;
out vec4 outColor;
${HASH32_GLSL}
${GLYPH_AT_GLSL}
${DITHER_GLSL}
const float FRAME_W = ${g(FRAME_W)};
const float DIAL_START = ${g(DIAL_START)};
const float DIAL_SWEEP = ${g(DIAL_SWEEP)};
const float TAU = 6.28318530718;
const vec3 BULK = vec3(0.25, 0.285, 0.265);
const vec3 GREEN = vec3(0.31, 0.35, 0.32);
const vec3 GREY = vec3(0.34, 0.345, 0.35);
const vec3 METAL = vec3(0.62, 0.63, 0.64);
const vec3 INK = vec3(0.86, 0.87, 0.85);
const vec3 BLACK = vec3(0.035, 0.037, 0.038);
const vec3 AMBER = vec3(0.95, 0.6, 0.18);

float px;
vec3 emit;

float cover(float d) {
  return clamp(0.5 - d / px, 0.0, 1.0);
}
float sdBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0;
  vec2 e1 = p2 - p1;
  vec2 e2 = p0 - p2;
  vec2 v0 = p - p0;
  vec2 v1 = p - p1;
  vec2 v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
/** Signed distance to the nearer window's glass (both mirror the right one). */
float sdWin(vec2 f) {
  return sdTri(vec2(abs(f.x), f.y), uWinA, uWinB, uWinC);
}

/** A made-up code of n letters and digits, centred on q = 0, in glyph cells h tall. */
float label(vec2 q, float h, uint code, int n) {
  float w = ${g(ATLAS_CW / ATLAS_CH)} * h;
  float u = q.x / w + 0.5 * float(n);
  float v = q.y / h + 0.5;
  if (u < 0.0 || u >= float(n) || v < 0.0 || v > 1.0) {
    return 0.0;
  }
  float k = floor(u);
  uint gi = 1u + hash32(code ^ (uint(k) * 0x27d4eb2du)) % 36u;
  return glyphAt(float(gi), vec2(u - k, v));
}

/** A guarded or bare toggle switch with its label, or now and then a flag indicator. */
vec3 toggle(vec2 q, uint h, vec3 col) {
  col = mix(col, INK, label(q - vec2(0.0, -0.0185), 0.0115, h, 3 + int((h >> 4) & 1u)));
  uint type = h % 13u;
  if (type == 0u) {
    return col;
  }
  vec2 c = vec2(0.0, 0.004);
  if (type == 1u) {
    // A flag indicator: a black disc with a striped or grey flag.
    float dd = length(q - c);
    col = mix(col, BLACK, cover(dd - 0.0078));
    float stripes = step(0.5, fract((q.x + q.y) * 260.0));
    vec3 flag = ((h >> 9) & 1u) == 1u ? mix(vec3(0.12), vec3(0.62), stripes) : vec3(0.45);
    col = mix(col, flag, cover(max(dd - 0.0058, -(q.y - c.y))));
    return col;
  }
  // The nut.
  float dn = length(q - c);
  col = mix(col, vec3(0.2), cover(dn - 0.0068));
  col = mix(col, METAL * (0.55 + 0.3 * (c.y - q.y) / 0.006), cover(dn - 0.0052));
  // Guards either side.
  if ((h >> 8) % 3u == 0u) {
    for (int s = -1; s <= 1; s += 2) {
      vec2 a = vec2(float(s) * 0.0108, -0.003);
      float dg = sdSeg(q, a, a + vec2(0.0, 0.022)) - 0.0017;
      float lit = 0.6 + 0.3 * clamp((a.x - q.x) * float(s) / 0.0017, -1.0, 1.0);
      col = mix(col, METAL * lit * 0.85, cover(dg));
    }
  }
  // The lever, mostly up, with its shadow.
  float dir = ((h >> 12) & 7u) < 2u ? -1.0 : 1.0;
  vec2 tip = c + vec2(0.0, dir * 0.0135);
  float sh = sdSeg(q - vec2(0.0018, -0.0026), c, tip) - 0.0026;
  col *= 1.0 - 0.45 * cover(sh - 0.0012);
  float dl = sdSeg(q, c, tip) - 0.0019;
  col = mix(col, METAL * (0.75 - 0.25 * (q.x / 0.0019)), cover(dl));
  float dt = length(q - tip) - 0.0032;
  vec2 hl = (q - tip) / 0.0032;
  col = mix(col, METAL * (0.7 + 0.35 * clamp(-hl.x * 0.6 + hl.y * 0.8, -1.0, 1.0)), cover(dt));
  return col;
}

/** A circuit breaker's knob, its white collar showing if it's pulled, and its label. */
vec3 breaker(vec2 q, uint h, vec3 col) {
  col = mix(col, INK, label(q - vec2(0.0, 0.0105), 0.0095, h, 2 + int((h >> 4) & 1u)));
  vec2 c = vec2(0.0, -0.004);
  float d = length(q - c);
  if ((h >> 8) % 9u == 0u) {
    col = mix(col, vec3(0.78), cover(d - 0.0066));
  }
  col = mix(col, BLACK, cover(d - 0.0052));
  vec2 n = (q - c) / 0.0052;
  col += vec3(0.1) * cover(d - 0.0052) * smoothstep(0.2, 0.9, -n.x * 0.6 + n.y * 0.8) * (1.0 - smoothstep(0.7, 1.0, dot(n, n)));
  return col;
}

/** A caution lamp: dark glass with an engraved code, a few glowing faintly. */
vec3 lamp(vec2 q, uint h, vec3 col) {
  float d = sdBox(q, vec2(0.026, 0.0115), 0.002);
  col = mix(col, vec3(0.06), cover(d - 0.0018));
  bool lit = (h & 7u) == 0u;
  vec3 lens = lit ? vec3(0.22, 0.14, 0.05) : vec3(0.075, 0.07, 0.065);
  float c = cover(d);
  col = mix(col, lens, c);
  float t = label(q, 0.0105, h, 4 + int((h >> 4) & 1u));
  col = mix(col, lit ? vec3(0.08, 0.05, 0.02) : vec3(0.3), t * c);
  if (lit) {
    emit += AMBER * 0.22 * c * (1.0 - t);
  }
  return col;
}

/** A checklist card, held on by two Velcro straps. */
vec3 checklist(vec2 f, vec4 r, uint h, vec3 col) {
  vec2 mid = 0.5 * (r.xy + r.zw);
  vec2 half_ = 0.5 * (r.zw - r.xy);
  float d = sdBox(f - mid, half_, 0.002);
  col *= 1.0 - 0.35 * cover(sdBox(f - mid - vec2(0.003, -0.004), half_, 0.004) - 0.003);
  vec3 paper = vec3(0.62, 0.6, 0.53);
  // Lines of small text: dashes of varying length.
  float row = floor((r.w - 0.03 - f.y) / 0.0105);
  float yIn = r.w - 0.03 - (row + 0.5) * 0.0105 - f.y;
  if (row >= 0.0 && f.y > r.y + 0.03) {
    uint rh = hash32(h ^ uint(row) * 0x9e3779b9u);
    float x = f.x - r.x - 0.012;
    float word = floor(x / 0.018);
    uint wh = hash32(rh + uint(max(word, 0.0)));
    float wx = x - word * 0.018;
    float len = 0.006 + 0.011 * float(wh & 255u) / 255.0;
    float end = (r.z - r.x - 0.024) * (0.5 + 0.5 * float((rh >> 8) & 255u) / 255.0);
    bool on = x > 0.0 && x < end && wx < len && (rh & 7u) != 0u;
    float th = row == 0.0 ? 0.0024 : 0.0016;
    paper = mix(paper, vec3(0.16), on ? cover(abs(yIn) - th) : 0.0);
  }
  col = mix(col, paper, cover(d));
  for (int k = 0; k < 2; k++) {
    float y = k == 0 ? r.w - 0.012 : r.y + 0.012;
    float ds = sdBox(f - vec2(mid.x, y), vec2(half_.x + 0.007, 0.0065), 0.0015);
    float fuzz = float(hash32(uint(gl_FragCoord.x) * 7919u ^ uint(gl_FragCoord.y) * 104729u) & 255u) / 255.0;
    col = mix(col, vec3(0.15, 0.16, 0.15) * (0.85 + 0.3 * fuzz), cover(ds));
  }
  return col;
}

vec3 panel(vec2 f, int i, vec4 r, int kind, vec3 col) {
  uint ph = hash32(uint(i) * 0x632be5abu ^ uSalt);
  if (kind == ${String(CHECKLIST)}) {
    return checklist(f, r, ph, col);
  }
  vec2 mid = 0.5 * (r.xy + r.zw);
  vec2 half_ = 0.5 * (r.zw - r.xy) - 0.003;
  float d = sdBox(f - mid, half_, 0.004);
  if (d > px) {
    return col;
  }
  vec3 plate = (ph & 1u) == 1u ? GREEN : GREY;
  // Bevel: lit along the top and left, shaded along the bottom and right.
  float edge = 1.0 - smoothstep(0.0, 0.004, -d);
  vec2 side = (f - mid) / half_;
  plate *= 1.0 + edge * 0.25 * clamp(side.y - side.x, -1.0, 1.0);
  // Screws in the corners.
  vec2 sc = abs(f - mid) - (half_ - 0.009);
  float ds = length(sc) - 0.0028;
  plate = mix(plate, plate * 0.55, cover(ds));
  plate = mix(plate, plate * 0.4, cover(ds + 0.0015) * cover(abs((f - mid).x - sign((f - mid).x) * (half_.x - 0.009)) - 0.0005));
  // Elements on a grid.
  vec2 cell = kind == ${String(SWITCHES)} ? vec2(0.034, 0.052) : kind == ${String(BREAKERS)} ? vec2(0.022, 0.034) : vec2(0.062, 0.033);
  vec2 inner = 2.0 * half_ - 0.024;
  vec2 n = max(floor(inner / cell), 1.0);
  vec2 origin = vec2(mid.x - 0.5 * n.x * cell.x, mid.y + 0.5 * n.y * cell.y);
  vec2 local = vec2(f.x - origin.x, origin.y - f.y) / cell;
  vec2 ci = floor(local);
  if (ci.x >= 0.0 && ci.y >= 0.0 && ci.x < n.x && ci.y < n.y) {
    vec2 c = vec2(origin.x + (ci.x + 0.5) * cell.x, origin.y - (ci.y + 0.5) * cell.y);
    bool clear = sdWin(c) > FRAME_W + 0.018;
    for (int k = 0; k < ${String(MAX_DIALS)}; k++) {
      if (k < uDialCount && length(c - uDials[k].xy) < uDials[k].z * 1.2 + 0.022) {
        clear = false;
      }
    }
    if (sdBox(c - uLamp.xy, uLamp.zw + 0.02, 0.0) < 0.012) {
      clear = false;
    }
    if (clear) {
      uint h = hash32(ph ^ hash32(uint(ci.x + 64.0 * ci.y) + 0x1b873593u));
      vec2 q = f - c;
      plate = kind == ${String(SWITCHES)} ? toggle(q, h, plate)
        : kind == ${String(BREAKERS)} ? breaker(q, h, plate)
        : lamp(q, h, plate);
    }
  }
  // The lamp panel is ruled into blocks.
  if (kind == ${String(LAMPS)}) {
    vec2 g = abs(fract(local - 0.5) - 0.5) * cell;
    plate *= 1.0 - 0.3 * cover(min(g.x, g.y) - 0.0006) * step(d, -0.008);
  }
  return mix(col * 0.5, plate, cover(d));
}

/** A round gauge's bezel, face, scale and code; its needle is drawn live. */
vec3 dial(vec2 f, vec3 dl, uint h, vec3 col) {
  vec2 q = f - dl.xy;
  float R = dl.z;
  float d = length(q);
  if (d > R * 1.2 + px) {
    return col;
  }
  col *= 1.0 - 0.5 * cover(length(q - vec2(0.003, -0.004)) - R * 1.17);
  vec2 n = q / max(d, 1e-6);
  vec3 bezel = vec3(0.24) * (0.8 + 0.5 * dot(n, vec2(-0.6, 0.8)));
  col = mix(col, bezel, cover(d - R * 1.16));
  col = mix(col, BLACK, cover(d - R));
  float a = atan(q.y, q.x);
  float s = mod(DIAL_START - a, TAU);
  if (s <= DIAL_SWEEP + 0.02) {
    float major = DIAL_SWEEP / 6.0;
    float minor = DIAL_SWEEP / 30.0;
    float dm = abs(s - major * floor(s / major + 0.5)) * d;
    float dn = abs(s - minor * floor(s / minor + 0.5)) * d;
    float tick = max(cover(dm - R * 0.022) * cover(abs(d - R * 0.82) - R * 0.1),
                     cover(dn - R * 0.012) * cover(abs(d - R * 0.87) - R * 0.05));
    tick = max(tick, cover(abs(d - R * 0.92) - R * 0.008));
    col = mix(col, INK, tick);
    if (s > DIAL_SWEEP * 0.82) {
      col = mix(col, vec3(0.6, 0.1, 0.07), cover(abs(d - R * 0.885) - R * 0.03));
    }
  }
  col = mix(col, INK, label(q - vec2(0.0, -R * 0.42), R * 0.24, h, 3));
  // A faint sheen on the glass.
  col += vec3(0.05) * cover(d - R) * smoothstep(0.3, 1.0, dot(n, vec2(-0.6, 0.8))) * smoothstep(0.4, 1.0, d / R);
  return col;
}

/** Everything that isn't the window glass's view, at frame point f. */
vec4 cabin(vec2 f) {
  emit = vec3(0.0);
  float aspect = uRes.x / uRes.y;
  // The bulkhead, and the plain recess behind the speaker.
  vec3 col = BULK;
  float dr = sdBox(f - vec2(0.0, -0.05), vec2(0.2, 0.44), 0.02);
  col *= 1.0 - 0.18 * cover(dr) - 0.12 * cover(abs(dr) - 0.003) * step(0.0, f.x - f.y * 0.2);
  col *= 1.0 + 0.2 * cover(abs(dr + 0.004) - 0.0015) * step(f.x - f.y * 0.2, 0.0);
  float rivet = length(vec2(f.x - sign(f.x) * 0.214, mod(f.y + 0.02, 0.06) - 0.03)) - 0.0026;
  col *= 1.0 - 0.3 * cover(rivet) * step(abs(f.y + 0.05), 0.42);
  // A dark duct across the top, with a handrail.
  col = mix(col, BULK * 0.6, cover(0.448 - f.y));
  float rail = abs(f.y - 0.468) - 0.0075;
  float railRun = cover(abs(f.x) - 0.215);
  col = mix(col, METAL * (0.45 + 0.4 * clamp((f.y - 0.468) / 0.0075, -1.0, 1.0)), cover(rail) * railRun);
  for (int s = -1; s <= 1; s += 2) {
    col = mix(col, METAL * 0.4, cover(sdBox(f - vec2(float(s) * 0.2, 0.465), vec2(0.005, 0.018), 0.002)));
  }

  for (int i = 0; i < ${String(MAX_PANELS)}; i++) {
    if (i >= uPanelCount) {
      break;
    }
    vec4 r = uPanels[i];
    if (f.x > r.x - 0.01 && f.x < r.z + 0.01 && f.y > r.y - 0.01 && f.y < r.w + 0.01) {
      col = panel(f, i, r, uKinds[i], col);
    }
  }
  for (int k = 0; k < ${String(MAX_DIALS)}; k++) {
    if (k >= uDialCount) {
      break;
    }
    col = dial(f, uDials[k], hash32(uint(k) * 0xcc9e2d51u ^ uSalt), col);
  }
  // The master alarm's housing; the composite lights its lens.
  float dlamp = sdBox(f - uLamp.xy, uLamp.zw, 0.003);
  col = mix(col, vec3(0.03), cover(dlamp - 0.0045));
  col = mix(col, vec3(0.16, 0.06, 0.035), cover(dlamp));
  col = mix(col, vec3(0.07, 0.025, 0.015), label(f - uLamp.xy, uLamp.w * 0.9, uSalt ^ 0x2f1u, 4) * cover(dlamp));

  // Light: dim and cool from above, brighter near the sunlit windows, dark in the corners.
  float dw = sdWin(f);
  vec3 light = vec3(0.78, 0.86, 0.96) * (0.62 + 0.38 * smoothstep(-0.5, 0.45, f.y));
  light += vec3(0.5, 0.48, 0.45) * exp(-max(dw, 0.0) / 0.07) * 0.6;
  vec2 vq = f / vec2(0.5 * aspect + 0.1, 0.6);
  light *= 1.0 - 0.5 * smoothstep(0.35, 1.05, dot(vq, vq));
  // Keep the middle, behind the speaker, a touch darker and calmer.
  light *= 1.0 - 0.15 * (1.0 - smoothstep(0.12, 0.3, abs(f.x)));
  col *= light;

  // The windows: a thick frame with a dark seal, a lit inner lip and bolts.
  if (dw < FRAME_W + px) {
    vec3 frame = vec3(0.22, 0.23, 0.225) * light;
    frame *= 1.0 + 0.5 * (1.0 - smoothstep(0.003, 0.012, dw));
    frame = mix(frame, vec3(0.02), 1.0 - smoothstep(0.0, 0.004, dw));
    frame *= 1.0 - 0.3 * smoothstep(FRAME_W - 0.006, FRAME_W, dw);
    vec2 p = vec2(abs(f.x), f.y);
    vec2 cen = (uWinA + uWinB + uWinC) / 3.0;
    for (int e = 0; e < 3; e++) {
      vec2 a = e == 0 ? uWinA : e == 1 ? uWinB : uWinC;
      vec2 b = e == 0 ? uWinB : e == 1 ? uWinC : uWinA;
      vec2 ab = b - a;
      float len = length(ab);
      vec2 nrm = vec2(ab.y, -ab.x) / len;
      nrm *= sign(dot(nrm, a - cen));
      float count = floor(len / 0.045);
      float t = clamp(floor(dot(p - a, ab) / (len * len) * count), 0.0, count - 1.0);
      vec2 bolt = a + ab * ((t + 0.5) / count) + nrm * (FRAME_W * 0.6);
      float db = length(p - bolt) - 0.0036;
      frame = mix(frame, frame * 0.5, cover(db + 0.0008));
      frame = mix(frame, frame * 1.5, cover(length(p - bolt + vec2(0.001, -0.001)) - 0.0018));
    }
    col = mix(col, frame, cover(dw - FRAME_W));
  }
  float glass = cover(dw);
  if (glass > 0.0) {
    // A faint sheen, and on the sunward window a glare streak across the glass.
    vec3 refl = vec3(0.008, 0.009, 0.011);
    if (f.x > 0.0) {
      vec2 o = vec2(uWinB.x - 0.17, uWinB.y - 0.06);
      vec2 dir = normalize(vec2(-0.35, -1.0));
      vec2 v = f - o;
      float along = dot(v, dir);
      float across = abs(v.x * dir.y - v.y * dir.x);
      float run = smoothstep(-0.02, 0.06, along) * (1.0 - smoothstep(0.15, 0.32, along));
      refl += vec3(1.0, 0.95, 0.86) * run * (0.05 * exp(-across * across / 0.00004) + 0.02 * exp(-across * across / 0.0012));
    }
    col = mix(col, refl, glass);
  }
  return vec4(col + emit, glass);
}

void main() {
  px = 1.0 / uRes.y;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    sum += cabin((gl_FragCoord.xy + o - 0.5 * uRes) / uRes.y);
  }
  sum *= 0.25;
  outColor = vec4(sum.rgb + dither8(gl_FragCoord.xy), sum.a);
}
`;

/**
 * Per frame: the cached cabin, and through its glass the cached ground lit by
 * the creeping sun (or, during a lift-off, sliding away below a curving limb),
 * the turning Earth, the distant dust plume, drifting dust and the master
 * alarm's glow.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uCabin;
uniform sampler2D uGround;
uniform sampler2D uMask;
uniform sampler2D uClouds;
uniform sampler2D uSurface;
uniform vec2 uRes;
uniform vec2 uCacheRes;
uniform vec3 uSun;
uniform float uSunElev;
/** Ground slide (frame units), orbit mix, height over the Moon's radius, horizon dip (radians). */
uniform vec4 uClimb;
/** Earth centre (frame units), radius, shown. */
uniform vec4 uEarth;
uniform vec3 uEarthSun;
uniform float uEarthTurn;
uniform vec2 uCloud;
/** Plume base x, y, height, amount. */
uniform vec4 uPlume;
/** Dust level, fall offset (cells), seed salt. */
uniform vec3 uDust;
uniform vec4 uLamp;
uniform float uGlow;
out vec4 outColor;
${CAMERA_GLSL}
${NOISE_GLSL}
${DITHER_GLSL}
const float HORIZON_MAX = ${g(HORIZON_MAX)};
const float TAU = 6.28318530718;
const float INV_TAU = 0.15915494309189535;
const float INV_PI = 0.3183098861837907;
const vec3 TINT = vec3(1.0, 0.97, 0.92);
const float SUN_K = 0.92;
const vec3 GLASS = vec3(0.86, 0.9, 0.9);
const vec3 OCEAN = vec3(0.02, 0.06, 0.17);
const vec3 ATMO = vec3(0.3, 0.55, 1.0);

vec4 shadeTexel(ivec2 ij, vec3 vd) {
  vec4 t = texelFetch(uGround, ij, 0);
  if (t.r < 0.02) {
    return vec4(0.0);
  }
  vec3 n = vec3(t.g * 2.0 - 1.0, 0.0, t.b * 2.0 - 1.0);
  n.y = sqrt(max(0.0, 1.0 - n.x * n.x - n.z * n.z));
  float ci = max(dot(n, uSun), 0.0);
  float ce = max(dot(n, -vd), 0.05);
  float horizon = t.a * HORIZON_MAX;
  float lit = smoothstep(horizon - 0.004, horizon + 0.004, uSunElev);
  float L = t.r * (SUN_K * 2.0 * ci / (ci + ce) * lit + 0.012);
  return vec4(L * TINT, 1.0);
}

vec4 ground(vec2 f, vec3 vd) {
  vec2 c = (f / vec2(uRes.x / uRes.y, 1.0) + 0.5) * uCacheRes - 0.5;
  vec2 i0 = floor(c);
  vec2 w = c - i0;
  ivec2 b = ivec2(i0);
  ivec2 m = ivec2(uCacheRes) - 1;
  vec4 s00 = shadeTexel(clamp(b, ivec2(0), m), vd);
  vec4 s10 = shadeTexel(clamp(b + ivec2(1, 0), ivec2(0), m), vd);
  vec4 s01 = shadeTexel(clamp(b + ivec2(0, 1), ivec2(0), m), vd);
  vec4 s11 = shadeTexel(clamp(b + ivec2(1, 1), ivec2(0), m), vd);
  return mix(mix(s00, s10, w.x), mix(s01, s11, w.x), w.y);
}

/** The Moon seen from above: a curving limb, textured and lit by the same sun. */
vec4 orbit(vec3 d) {
  float e = asin(clamp(d.y, -1.0, 1.0));
  float pxa = 2.0 * TAN_HALF / uRes.y;
  float cov = clamp((-uClimb.w - e) / pxa + 0.5, 0.0, 1.0);
  if (cov <= 0.0) {
    return vec4(0.0);
  }
  float hr = uClimb.z;
  float k = 1.0 + hr;
  float b = k * d.y;
  float disc = max(b * b - hr * (2.0 + hr), 0.0);
  float t = -b - sqrt(disc);
  vec3 N = normalize(vec3(0.0, k, 0.0) + d * t);
  float lat = asin(clamp(N.z, -1.0, 1.0));
  float lon = atan(N.x, N.y);
  vec2 uv = vec2(lon * INV_TAU, lat * INV_PI + 0.5);
  vec3 s = texture(uSurface, uv).rgb;
  float alb = 0.3 + 0.55 * dot(s, vec3(0.3, 0.59, 0.11));
  alb *= 0.85 + 0.2 * vnoise(uv * 900.0, 11u) + 0.1 * vnoise(uv * 3600.0, 12u);
  float ci = max(dot(N, uSun), 0.0);
  float ce = max(dot(N, -d), 0.05);
  float L = alb * SUN_K * 2.0 * ci / (ci + ce);
  return vec4(L * TINT * cov, cov);
}

/** The Earth: land from the shared mask, the Planet effect's clouds, a thin blue limb. */
vec3 earth(vec2 f) {
  vec2 q = (f - uEarth.xy) / uEarth.z;
  float r = length(q);
  float pxr = 1.0 / (uEarth.z * uRes.y);
  if (r > 1.0 + 30.0 * pxr) {
    return vec3(0.0);
  }
  float cov = clamp((1.0 - r) / pxr + 0.5, 0.0, 1.0);
  vec2 e = q / max(r, 1.0);
  float mu = sqrt(max(0.0, 1.0 - dot(e, e)));
  vec3 N = vec3(e, mu);
  float ndl = dot(N, uEarthSun);
  vec3 atmo = ATMO * smoothstep(-0.2, 0.3, ndl);
  vec3 halo = atmo * 0.35 * exp(-max(r - 1.0, 0.0) * 30.0);
  if (cov <= 0.0) {
    return halo;
  }
  // The axis leans about 20 degrees in the picture.
  vec3 B = vec3(0.94 * N.x + 0.342 * N.y, -0.342 * N.x + 0.94 * N.y, N.z);
  float lat = asin(clamp(B.y, -1.0, 1.0));
  float lon = atan(B.x, B.z) + uEarthTurn * TAU;
  float alat = abs(lat);
  float m = texture(uMask, vec2(fract(lon * INV_TAU + 0.5), 0.5 - lat * INV_PI)).r * ${g(LAND_MASK_GAIN)} - ${g(LAND_MASK_BIAS)};
  float land = smoothstep(-1.0, 1.0, m);
  float arid = exp(-pow((alat - 0.42) / 0.16, 2.0));
  vec3 surf = mix(OCEAN, mix(vec3(0.13, 0.2, 0.08), vec3(0.45, 0.38, 0.25), arid), land);
  surf = mix(surf, vec3(0.86, 0.9, 0.94), smoothstep(1.15, 1.28, alat));
  float c = texture(uClouds, vec2(lon * INV_TAU, lat * INV_PI + 0.5)).r;
  surf = mix(surf, vec3(0.92), smoothstep(uCloud.x, uCloud.x + ${g(CLOUD_SOFT)}, c) * uCloud.y);
  vec3 lit = surf * (0.006 + 0.9 * max(ndl, 0.0)) + atmo * 0.5 * pow(1.0 - mu, 3.0);
  return lit * cov + halo * (1.0 - cov);
}

void main() {
  vec4 cab = texelFetch(uCabin, ivec2(gl_FragCoord.xy), 0);
  vec3 col = cab.rgb;
  vec2 f = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  if (cab.a > 0.002) {
    vec3 d = rayDir(f);
    vec4 view = ground(f + vec2(0.0, uClimb.x), d);
    if (uClimb.y > 0.0) {
      view = mix(view, orbit(d), uClimb.y);
    }
    vec3 out_ = view.rgb;
    if (uEarth.w > 0.0) {
      out_ += earth(f) * (1.0 - view.a);
    }
    if (uPlume.w > 0.0) {
      vec2 q = f - uPlume.xy;
      float hgt = q.y / max(uPlume.z, 1e-4);
      if (abs(q.x) < 0.1 && hgt > -0.2 && hgt < 1.6) {
        float w = 0.004 + 0.02 * clamp(hgt, 0.0, 1.5) * uPlume.z / ${g(PLUME_HEIGHT)};
        float billow = 0.65 + 0.35 * vnoise(vec2(q.x / 0.006, q.y / 0.008), 31u);
        float dens = exp(-q.x * q.x / (2.0 * w * w)) * smoothstep(-0.15, 0.05, hgt) * (1.0 - smoothstep(0.6, 1.5, hgt));
        out_ = mix(out_, vec3(0.74, 0.72, 0.69), clamp(dens * billow * uPlume.w * 0.55, 0.0, 1.0));
      }
    }
    if (uDust.x > 0.0) {
      vec2 gq = vec2(f.x / ${g(MOTE_CELL)}, f.y / ${g(MOTE_CELL)} + uDust.y);
      vec2 cell = floor(gq);
      uint h = cellHash(vec2(cell.x, mod(cell.y, ${g(MOTE_PERIOD)})), uint(uDust.z));
      if ((h & 255u) < 22u) {
        vec2 at = cell + 0.2 + 0.6 * vec2(r8(h, 1), r8(h, 2));
        vec2 dq = (gq - at) * ${g(MOTE_CELL)};
        float sigma = 0.0011 + 0.0012 * r8(h, 3);
        out_ += vec3(0.8, 0.78, 0.74) * (0.25 * uDust.x * exp(-dot(dq, dq) / (2.0 * sigma * sigma)));
      }
    }
    col += out_ * GLASS * cab.a;
  }
  // The master alarm's glow, in its lens and spilling a little round it.
  if (uGlow > 0.0) {
    vec2 q = abs(f - uLamp.xy) - uLamp.zw;
    float dl = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    col += vec3(1.0, 0.42, 0.12) * uGlow * (0.75 * clamp(0.5 - dl * uRes.y, 0.0, 1.0) + 0.12 * exp(-max(dl, 0.0) / 0.012));
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** A gauge's white needle and its cap, premultiplied, drawn in a scissor round the dial. */
const NEEDLE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
/** Dial centre x, y (frame units), face radius, needle angle. */
uniform vec4 uDial;
out vec4 outColor;
float needle(vec2 q, float px) {
  float w = q.x > 0.0 ? mix(0.03, 0.008, clamp(q.x / 0.8, 0.0, 1.0)) : 0.035;
  return clamp((w - abs(q.y)) / px + 0.5, 0.0, 1.0) * clamp(min(q.x + 0.22, 0.8 - q.x) / px + 0.5, 0.0, 1.0);
}
void main() {
  vec2 f = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float R = uDial.z;
  vec2 d = (f - uDial.xy) / R;
  float c = cos(uDial.w);
  float s = sin(uDial.w);
  float px = 1.0 / (R * uRes.y);
  vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y);
  vec2 ds = d - vec2(0.03, -0.045);
  vec2 qs = vec2(c * ds.x + s * ds.y, -s * ds.x + c * ds.y);
  float shadow = needle(qs, px * 3.0) * 0.5 * clamp((1.0 - length(d)) / px, 0.0, 1.0);
  float n = needle(q, px);
  float cap = clamp((0.09 - length(d)) / px + 0.5, 0.0, 1.0);
  vec3 col = vec3(0.8, 0.81, 0.79) * n;
  float a = max(n, shadow);
  col = mix(col, vec3(0.1), cap);
  a = max(a, cap);
  outColor = vec4(col, a);
}
`;

/**
 * Inside the cramped cabin of a lander parked on the Moon: panels of guarded
 * switches, breakers, caution lamps and gauges round the speaker, two
 * triangular windows looking out on a cratered grey plain in low, hard sun,
 * and the Earth hanging in the black sky. Very little moves: the needles
 * wander, the shadows creep, the Earth turns, a dust plume rises far off now
 * and then, and the master alarm blinks slowly every few minutes. Optionally,
 * every half hour the lander lifts off to orbit and slowly comes back down.
 */
export const lunarlander = defineEffect(lunarlanderMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) =>
        scope.add(createProgram(gl, FULLSCREEN_VERTEX, fs), (p) => {
          gl.deleteProgram(p);
        });
      const groundProgram = program(GROUND_FRAGMENT);
      const cabinProgram = program(CABIN_FRAGMENT);
      const compProgram = program(COMPOSITE_FRAGMENT);
      const needleProgram = program(NEEDLE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const gu = createUniforms(gl, groundProgram, [
        "uRes",
        "uAspect",
        "uSalt",
        "uSunDir",
        "uTrail",
      ]);
      const ku = createUniforms(gl, cabinProgram, [
        "uRes",
        "uSalt",
        "uPanels",
        "uKinds",
        "uPanelCount",
        "uDials",
        "uDialCount",
        "uLamp",
        "uWinA",
        "uWinB",
        "uWinC",
        "uAtlas",
        "uTile",
        "uPad",
        "uGlyphSize",
      ]);
      const cu = createUniforms(gl, compProgram, [
        "uCabin",
        "uGround",
        "uMask",
        "uClouds",
        "uSurface",
        "uRes",
        "uCacheRes",
        "uSun",
        "uSunElev",
        "uClimb",
        "uEarth",
        "uEarthSun",
        "uEarthTurn",
        "uCloud",
        "uPlume",
        "uDust",
        "uLamp",
        "uGlow",
      ]);
      const nu = createUniforms(gl, needleProgram, ["uRes", "uDial"]);
      gl.useProgram(cabinProgram);
      ku.i1("uAtlas", 0);
      gl.useProgram(compProgram);
      cu.i1("uCabin", 0);
      cu.i1("uGround", 1);
      cu.i1("uMask", 2);
      cu.i1("uClouds", 3);
      cu.i1("uSurface", 4);
      gl.useProgram(null);

      const texture = (
        w: number,
        h: number,
        internalFormat: GLenum,
        format: GLenum,
        data: Uint8Array,
      ) => {
        const tex = scope.add(
          createDataTexture(gl, {
            width: w,
            height: h,
            internalFormat,
            format,
            type: gl.UNSIGNED_BYTE,
            data,
            wrap: gl.REPEAT,
          }),
          (t) => {
            gl.deleteTexture(t);
          },
        );
        // Longitude repeats; latitude stops at the poles.
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
      };
      // Until the land mask loads: one "far out at sea" texel.
      const maskTex = texture(1, 1, gl.R8, gl.RED, new Uint8Array([0]));
      const maskImage = loadLandMask(scope, "Lunar Lander Cabin");
      // The Earth's clouds and the Moon's ground from orbit are built when first needed.
      const cloudData = new Uint8Array(CLOUD_W * CLOUD_H * 4);
      const surfaceData = new Uint8Array(SURFACE_W * SURFACE_H * 4);
      const cloudTex = texture(CLOUD_W, CLOUD_H, gl.RGBA8, gl.RGBA, cloudData);
      const surfaceTex = texture(SURFACE_W, SURFACE_H, gl.RGBA8, gl.RGBA, surfaceData);
      let cloudsBuilt = false;
      let surfaceBuilt = false;
      let cloudFade = 0;
      // Both textures build a little each frame from the start: the clouds first (the
      // Earth is up from the first frame), then the surface, long before any lift-off
      // can reach orbit (at least 15 s of climbing).
      const cloudBuild = createBackgroundBuild<number, Uint8Array>();
      cloudBuild.request(0, () => buildCloudsSteps("earth", BODY_SEED, cloudData));
      const surfaceBuild = createBackgroundBuild<number, Uint8Array>();
      surfaceBuild.request(0, () => buildSurfaceSteps("desert", BODY_SEED, surfaceData));
      const uploadClouds = () => {
        cloudsBuilt = true;
        gl.activeTexture(gl.TEXTURE3);
        updateDataTexture(gl, cloudTex, CLOUD_W, CLOUD_H, gl.RGBA, gl.UNSIGNED_BYTE, cloudData);
      };
      const uploadSurface = () => {
        surfaceBuilt = true;
        gl.activeTexture(gl.TEXTURE4);
        updateDataTexture(
          gl,
          surfaceTex,
          SURFACE_W,
          SURFACE_H,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          surfaceData,
        );
      };
      const shaping = cloudShaping(EARTH_CLOUDS, WORLDS.earth, new Float64Array(2));
      const atlas = scope.add(gl.createTexture(), (t) => {
        gl.deleteTexture(t);
      });
      let atlasDrawn = false;

      let cabin: RenderTarget | null = null;
      let groundTarget: RenderTarget | null = null;
      scope.defer(() => {
        cabin?.dispose();
        groundTarget?.dispose();
      });
      let width = 1;
      let height = 1;
      let layout: CabinLayout = cabinLayout(16 / 9);
      let cabinSeed = Number.NaN;
      let groundSeed = Number.NaN;
      const panels = new Float32Array(MAX_PANELS * 4);
      const kinds = new Int32Array(MAX_PANELS);
      const dials = new Float32Array(MAX_DIALS * 3);
      const span = new Float64Array(2);
      const plume = createPlume();

      let time = 0;
      let climb = 0;
      let walk: GraphWalk = createGraphWalk(MAX_DIALS, 0);
      let walkTime = 0;
      let walkSeed = Number.NaN;
      const needles = new Float64Array(MAX_DIALS).fill(Number.NaN);

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          cabin?.dispose();
          groundTarget?.dispose();
          cabin = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          const divisor = Math.max(1, height / GROUND_MAX_H);
          groundTarget = createRenderTarget(
            gl,
            lowResSize(width, divisor),
            lowResSize(height, divisor),
            gl.RGBA8,
            { filter: gl.NEAREST },
          );
          layout = cabinLayout(width / height);
          panels.fill(0);
          kinds.fill(0);
          dials.fill(0);
          layout.panels.slice(0, MAX_PANELS).forEach((p, i) => {
            panels.set([p.x0, p.y0, p.x1, p.y1], i * 4);
            kinds[i] = p.kind;
          });
          layout.dials.slice(0, MAX_DIALS).forEach((d, i) => {
            dials.set([d.x, d.y, d.r], i * 3);
          });
          cabinSeed = Number.NaN;
          groundSeed = Number.NaN;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!cabin || !groundTarget) {
            return;
          }
          const seed = Math.floor(clamp(Number.isFinite(p.seed) ? p.seed : 0, 0, 999));
          const salt = hash32(seed + 0x6a09e667);
          const sunEl = sunElevation(time);
          const sunX = Math.sin(SUN_AZIMUTH);
          const sunZ = Math.cos(SUN_AZIMUTH);

          // 1. The cabin, when the size or variation changes.
          if (seed !== cabinSeed) {
            gl.useProgram(cabinProgram);
            gl.activeTexture(gl.TEXTURE0);
            if (!atlasDrawn) {
              atlasDrawn = true;
              const m = drawGlyphAtlas(gl, atlas, ATLAS_CW, ATLAS_CH);
              ku.f2("uTile", m.tile[0], m.tile[1]);
              ku.f2("uPad", m.pad[0], m.pad[1]);
              ku.f2("uGlyphSize", m.glyph[0], m.glyph[1]);
            }
            gl.bindTexture(gl.TEXTURE_2D, atlas);
            ku.f2("uRes", width, height);
            ku.u1("uSalt", salt);
            gl.uniform4fv(ku.loc.uPanels, panels);
            gl.uniform1iv(ku.loc.uKinds, kinds);
            ku.i1("uPanelCount", Math.min(MAX_PANELS, layout.panels.length));
            gl.uniform3fv(ku.loc.uDials, dials);
            ku.i1("uDialCount", Math.min(MAX_DIALS, layout.dials.length));
            const [lx, ly, lw, lh] = layout.lamp;
            ku.f4("uLamp", lx, ly, lw, lh);
            const w = layout.window;
            ku.f2("uWinA", w[0], w[1]);
            ku.f2("uWinB", w[2], w[3]);
            ku.f2("uWinC", w[4], w[5]);
            cabin.bind();
            triangle.draw();
            cabinSeed = seed;
          }

          // 2. The ground, only inside the windows' bounds (the rest stays sky).
          if (seed !== groundSeed) {
            gl.useProgram(groundProgram);
            groundTarget.bind();
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            const gw = groundTarget.width;
            const gh = groundTarget.height;
            gu.f2("uRes", gw, gh);
            gu.f1("uAspect", width / height);
            gu.u1("uSalt", salt);
            gu.f2("uSunDir", sunX, sunZ);
            gu.f1("uTrail", (salt & 0xffff) / 0x2900);
            const w = layout.window;
            const top = Math.max(w[1], w[3]) + FRAME_W;
            const bottom = w[5] - FRAME_W;
            const outer = Math.max(w[0], w[2], w[4]) + FRAME_W;
            const inner = Math.min(w[0], w[2], w[4]) - FRAME_W;
            const toY = (y: number) => (y + 0.5) * gh;
            const y0 = Math.max(0, Math.floor(toY(bottom)) - 2);
            const y1 = Math.min(gh, Math.ceil(toY(top)) + 2);
            gl.enable(gl.SCISSOR_TEST);
            for (const side of [-1, 1]) {
              const a = side * inner;
              const b = side * outer;
              const toX = (x: number) => x * gh + gw / 2;
              const x0 = Math.max(0, Math.floor(toX(Math.min(a, b))) - 2);
              const x1 = Math.min(gw, Math.ceil(toX(Math.max(a, b))) + 2);
              if (x1 > x0 && y1 > y0) {
                gl.scissor(x0, y0, x1 - x0, y1 - y0);
                triangle.draw();
              }
            }
            gl.disable(gl.SCISSOR_TEST);
            groundSeed = seed;
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);

          // 3. Lift-off: never faster than the setting allows, so switching it mid-flight eases home.
          climb = approach(climb, p.ascent ? ascentAt(time) : 0, CLIMB_RATE * step);
          const climbM = climbHeight(climb);
          const dip = horizonDip(climbM);
          const slide = HORIZON_Y - elevationY(-dip);
          const orbitMix = smoothstep(0.25, 0.7, climb);
          const quiet = 1 - smoothstep(0, 0.08, climb);
          if (!cloudsBuilt) {
            if (cloudBuild.step(BUILD_BUDGET_MS)) {
              uploadClouds();
            }
          } else if (!surfaceBuilt) {
            if (orbitMix > 0) {
              // Never expected: the climb takes far longer than the build.
              surfaceBuild.finish();
              uploadSurface();
            } else if (surfaceBuild.step(BUILD_BUDGET_MS)) {
              uploadSurface();
            }
          }
          cloudFade = Math.min(1, cloudFade + (cloudsBuilt ? step / CLOUD_FADE_SECONDS : 0));

          // 4. The Earth.
          const side = p.earth === "left" ? -1 : p.earth === "right" ? 1 : 0;

          // 5. Composite.
          gl.useProgram(compProgram);
          cu.f2("uRes", width, height);
          cu.f2("uCacheRes", groundTarget.width, groundTarget.height);
          const cosEl = Math.cos(sunEl);
          cu.f3("uSun", sunX * cosEl, Math.sin(sunEl), sunZ * cosEl);
          cu.f1("uSunElev", sunEl);
          cu.f4("uClimb", slide, orbitMix, climbM / MOON_R, dip);
          const [ex, ey, er] = layout.earth;
          cu.f4("uEarth", side * ex, ey, er, side === 0 ? 0 : 1);
          const phase = clamp(Number.isFinite(p.phase) ? p.phase : 0.6, 0, 1);
          const phi = Math.PI * (1 - phase);
          cu.f3("uEarthSun", Math.sin(phi), 0.12, Math.cos(phi));
          cu.f1("uEarthTurn", earthTurn(time));
          cu.f2("uCloud", shaping[0], shaping[1] * cloudFade);
          plumeAt(time, seed, plume);
          const amount = plume.amount * quiet;
          if (amount > 0) {
            windowSpan(layout, HORIZON_Y, span);
            const x =
              plume.side *
              (span[0] + PLUME_INSET + (span[1] - span[0] - 2 * PLUME_INSET) * plume.across);
            cu.f4(
              "uPlume",
              x,
              HORIZON_Y - 0.002,
              PLUME_HEIGHT * (0.15 + 0.85 * plume.rise),
              amount,
            );
          } else {
            cu.f4("uPlume", 0, 0, 0, 0);
          }
          const fall = (time * MOTE_FALL) / MOTE_CELL;
          cu.f3("uDust", dustLevel(time, seed) * quiet, fall % MOTE_PERIOD, salt & 0xffff);
          const [lx, ly, lw, lh] = layout.lamp;
          cu.f4("uLamp", lx, ly, lw, lh);
          cu.f1("uGlow", warningGlow(time, seed));

          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_2D, surfaceTex);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, cloudTex);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, maskTex);
          const image = maskImage.take();
          if (image) {
            uploadLandMask(gl, image);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
          }
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, groundTarget.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, cabin.texture);
          triangle.draw();

          // 6. The needles, wandering on the random walk.
          if (seed !== walkSeed) {
            walkSeed = seed;
            walk = createGraphWalk(MAX_DIALS, seed);
            walkTime = 0;
            needles.fill(Number.NaN);
          }
          walkTime += step;
          advanceGraph(walk, walkTime);
          const lag = 1 - Math.exp(-step / NEEDLE_LAG);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.enable(gl.SCISSOR_TEST);
          gl.useProgram(needleProgram);
          nu.f2("uRes", width, height);
          const count = Math.min(MAX_DIALS, layout.dials.length);
          for (let i = 0; i < count; i++) {
            const d = layout.dials[i];
            const target = needleAngle(needleReading(dialBase(seed, i), walkWander(walk, i)));
            const prev = needles[i];
            const angle = Number.isNaN(prev) ? target : prev + (target - prev) * lag;
            needles[i] = angle;
            nu.f4("uDial", d.x, d.y, d.r, angle);
            const cx = d.x * height + width / 2;
            const cy = d.y * height + height / 2;
            const r = d.r * height;
            const sx = Math.max(0, Math.floor(cx - r));
            const sy = Math.max(0, Math.floor(cy - r));
            const ex2 = Math.min(width, Math.ceil(cx + r));
            const ey2 = Math.min(height, Math.ceil(cy + r));
            if (ex2 > sx && ey2 > sy) {
              gl.scissor(sx, sy, ex2 - sx, ey2 - sy);
              triangle.draw();
            }
          }
          gl.disable(gl.SCISSOR_TEST);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
