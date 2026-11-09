import { missioncontrolMeta } from "./missioncontrol.meta";
import {
  BLOCK_COUNT,
  BLOCKS_PER_UNIT,
  CEILING_Y,
  consoleLayout,
  type ConsoleLayout,
  DESK_D,
  DESK_H,
  EYE_Y,
  FACE_LEN,
  FACE_Y0,
  FACE_Y1,
  FACE_Z1,
  FLOOR0,
  FORWARD,
  GRAPH_ROWS,
  PIT_Y,
  type Rect,
  ROOM_HALF,
  ROW_DZ,
  ROW_Z0,
  ROWS,
  STEP,
  TABLE_TEXELS,
  TAN_HALF_FOV,
  telemetryBlock,
  TOP_Z1,
  UNIT_COUNT,
  UNIT_W,
  UNITS,
  UP,
  WALL_SCREENS,
  WALL_Z,
} from "./missioncontrol-room";
import {
  consoleStates,
  type ConsoleScratch,
  countdownText,
  createConsoleScratch,
  createLaunchState,
  createTrackEdges,
  fillTrackRow,
  groundTrack,
  launchOrbit,
  LAUNCH_SITE,
  type LatLonDeg,
  localTimeText,
  missionOffset,
  missionOrbit,
  missionTimeText,
  NO_TRACK,
  type Orbit,
  orbitNumber,
  PAD_CUT,
  resetLaunch,
  rocketClimb,
  stepLaunch,
  timeAtArgument,
  TRACK_BINS,
  unwrappedLon,
  CRT_FLICKER_RATES,
  RING_RATE,
  SHADER_PERIOD,
  TV_GRAIN_RATE,
  VAPOUR_DRIFT,
  VAPOUR_TILE,
} from "./missioncontrol-sim";
import {
  buildFontTexture,
  buildTextPage,
  CRT_COLS,
  DIGIT_0,
  GLYPH_COUNT,
  GLYPH_H,
  GLYPH_W,
  HEADER_COUNT,
  LINE,
  PAGE_COLS,
  PAGE_LINES,
  PATTERN_COUNT,
  RANDOM_DIGIT,
  SEG_COLON,
  SEG_COLON_MASK,
  SEG_DIGIT,
  SEG_GAP,
  SEG_LINE_MAX,
  sevenSegmentMasks,
  sevenSegWidth,
  TELEMETRY_COLS,
  TELEMETRY_LINES,
  WALL_GRAPHS,
  writeLine,
} from "../dot-matrix";
import {
  advanceGraph,
  createGraphWalk,
  GRAPH_SAMPLES,
  graphShift,
  GRAPH_DISTANCE_GLSL,
} from "../graph-walk";
import { hexToUnitRgb, type Rgb } from "../color";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  updateDataTexture,
  withScope,
  scopedProgram,
} from "../gl";
import { wrap } from "../math";
import { HASH_CELL_GLSL } from "../noise";
import {
  LAND_MASK_BIAS,
  LAND_MASK_GAIN,
  LAND_MASK_WIDTH,
  loadLandMask,
  uploadLandMask,
} from "../land-mask";
import { defineEffect } from "../types";
import { cameraRayGlsl, SUPERSAMPLE4_GLSL, SD_RECT_GLSL } from "../room-ray";

/** CRT phosphor colours. */
const PHOSPHOR_GREEN: Rgb = hexToUnitRgb("#5cff7a");
const PHOSPHOR_WHITE: Rgb = hexToUnitRgb("#d8e6ff");
const PHOSPHOR_AMBER: Rgb = hexToUnitRgb("#ffb43c");
/** Crafts on the map: the mission's, and the latest launch. */
const CRAFTS = 2;

const g = glslFloat;
const rect = (r: Rect) => `vec4(${g(r.x0)}, ${g(r.y0)}, ${g(r.x1)}, ${g(r.y1)})`;
const S = WALL_SCREENS;

/** Shared GLSL: camera rays, the consoles' profile and small helpers. */
const COMMON_GLSL = /* glsl */ `
const float TAU = 6.28318530718;
const float EYE_Y = ${g(EYE_Y)};
${cameraRayGlsl(FORWARD, UP, TAN_HALF_FOV)}
const float WALL_Z = ${g(WALL_Z)};
const int ROWS = ${String(ROWS)};
const int UNITS = ${String(UNITS)};
const float UNIT_W = ${g(UNIT_W)};
const float DESK_H = ${g(DESK_H)};
const float DESK_D = ${g(DESK_D)};
const float FACE_Y0 = ${g(FACE_Y0)};
const float FACE_Y1 = ${g(FACE_Y1)};
const float FACE_Z1 = ${g(FACE_Z1)};
const float TOP_Z1 = ${g(TOP_Z1)};
const float FACE_LEN = ${g(FACE_LEN)};
// The face's normal, towards the camera and a little up.
const vec3 FACE_N = vec3(0.0, ${g((FACE_Z1 - DESK_D) / FACE_LEN)}, ${g(-(FACE_Y1 - FACE_Y0) / FACE_LEN)});

float rowFloor(int k) {
  return ${g(FLOOR0)} - ${g(STEP)} * float(k);
}

float rowZ(int k) {
  return ${g(ROW_Z0)} + ${g(ROW_DZ)} * float(k);
}

float rowX0(int k) {
  return ${g(-0.5 * UNITS * UNIT_W)} + (float(k - 2 * (k / 2)) - 0.5) * ${g(0.5 * UNIT_W)};
}

// A ray from the eye, given by its (z, y) direction, against the line through
// a and b in the (z, y) plane. Returns the ray's t, and in s how far from a to b.
float lineHit(vec2 dir, vec2 a, vec2 b, out float s) {
  vec2 e = b - a;
  vec2 o = vec2(0.0, EYE_Y) - a;
  float den = dir.x * e.y - dir.y * e.x;
  den = abs(den) < 1e-9 ? 1e-9 : den;
  s = -(o.x * dir.y - o.y * dir.x) / den;
  return -(o.x * e.y - o.y * e.x) / den;
}

// As lineHit, but -1 unless the ray meets the segment between a and b.
float segHit(vec2 dir, vec2 a, vec2 b, out float s) {
  float t = lineHit(dir, a, b, s);
  return s >= 0.0 && s <= 1.0 ? t : -1.0;
}

// Where a ray meets row k's sloping face: the ray's t, and how far up the face.
float faceHit(int k, vec3 d, out float f) {
  float fl = rowFloor(k);
  float z0 = rowZ(k);
  float s;
  float t = lineHit(vec2(d.z, d.y), vec2(z0 + DESK_D, fl + FACE_Y0), vec2(z0 + FACE_Z1, fl + FACE_Y1), s);
  f = clamp(s, 0.0, 1.0) * FACE_LEN;
  return t;
}

${SD_RECT_GLSL}

${HASH_CELL_GLSL}
float hash2(vec2 p) {
  return hashCell(p);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x),
    mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}

// vnoise, repeating every period (a whole number of) cells in x.
float vnoiseTileX(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, period);
  float x1 = mod(i.x + 1.0, period);
  return mix(mix(hash2(vec2(x0, i.y)), hash2(vec2(x1, i.y)), u.x),
    mix(hash2(vec2(x0, i.y + 1.0)), hash2(vec2(x1, i.y + 1.0)), u.x), u.y);
}
`;

/**
 * The room, ray-traced once per resize or seed: the tiers of consoles with their
 * CRT bezels, button banks, cups and ashtrays, the floor, the front wall with
 * its screens' frames, and the ceiling. Four samples per pixel for smooth edges.
 * Alpha says what the composite adds to: 1 on the wall around its screens,
 * (k + 1) * 32 / 255 on row k's sloping faces, 0 elsewhere.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uResolution;
uniform sampler2D uUnits;
out vec4 outColor;
${COMMON_GLSL}
const vec3 KEY = vec3(0.0, ${g(1 / Math.hypot(1, 0.3))}, ${g(-0.3 / Math.hypot(1, 0.3))});
const vec3 WARM = vec3(1.0, 0.84, 0.64);
const vec3 CONSOLE = vec3(0.47, 0.53, 0.48);
const vec4 SCREENS[6] = vec4[6](${[S.map, S.telemetry, S.tv, S.clock, S.countdown, S.graphs].map((r) => rect(r)).join(", ")});

float ambient(vec3 n) {
  return mix(0.09, 0.2, n.y * 0.5 + 0.5);
}

// Light pools from the downlights over the rows.
float pool(float x) {
  return 0.6 + 0.4 * cos(TAU * x / 2.2);
}

vec3 lit(vec3 albedo, vec3 n, float x) {
  return albedo * WARM * (ambient(n) + 0.45 * max(0.0, dot(n, KEY)) * pool(x));
}

vec3 faceColour(int u, vec2 q, float x) {
  vec3 n = FACE_N;
  // The rounded edge into the top catches the light.
  float edge = smoothstep(FACE_LEN - 0.035, FACE_LEN, q.y);
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), edge * 0.8));
  vec3 col = lit(CONSOLE * 0.9, n, x);
  if (min(q.x, UNIT_W - q.x) < 0.006) {
    col *= 0.45;
  }
  vec4 bank = texelFetch(uUnits, ivec2(2, u), 0);
  vec4 info = texelFetch(uUnits, ivec2(3, u), 0);
  float bd = sdRect(q, bank + vec4(-0.015, -0.012, 0.015, 0.012), 0.01);
  if (bd < 0.0) {
    col = lit(vec3(0.15, 0.16, 0.15), FACE_N, x) * (1.0 - 0.4 * (1.0 - smoothstep(-0.004, 0.0, bd)));
    vec2 cell = (bank.zw - bank.xy) / info.xy;
    vec2 c = floor((q - bank.xy) / cell);
    if (c.x >= 0.0 && c.y >= 0.0 && c.x < info.x && c.y < info.y) {
      vec2 lp = q - bank.xy - (c + 0.5) * cell;
      float side = 0.36 * min(cell.x, cell.y);
      float cd = sdRect(lp, vec4(-side, -side, side, side), side * 0.25);
      col = mix(col, vec3(0.1, 0.1, 0.095), 1.0 - smoothstep(-0.002, 0.002, cd));
    }
  }
  for (int j = 0; j < 2; j++) {
    vec4 r = texelFetch(uUnits, ivec2(j, u), 0);
    if (r.z <= r.x) {
      continue;
    }
    float d = sdRect(q, r, 0.025);
    if (d < 0.03) {
      // Bezel, darker towards the tube, then the glass.
      float t = clamp(d / 0.03, 0.0, 1.0);
      col = lit(vec3(0.1, 0.105, 0.1), FACE_N, x) * (0.6 + 0.6 * t);
      if (d < 0.0) {
        vec2 uv = (q - r.xy) / (r.zw - r.xy);
        float refl = 0.035 * smoothstep(0.5, 1.0, uv.y) * smoothstep(0.7, 0.0, uv.x);
        col = vec3(0.012, 0.016, 0.014) + refl * WARM;
      }
    }
  }
  return col;
}

vec3 wallColour(vec2 p, out float mask) {
  mask = 0.0;
  vec3 n = vec3(0.0, 0.0, -1.0);
  vec3 col = vec3(0.15, 0.16, 0.18) * (0.95 + 0.05 * vnoise(p * 30.0));
  if (abs(fract(p.x / 1.2 + 0.5) - 0.5) * 1.2 < 0.008) {
    col *= 0.6;
  }
  if (p.y > 5.2) {
    col = vec3(0.08, 0.08, 0.09);
  }
  col *= WARM * (0.16 + 0.12 * smoothstep(5.2, 2.0, p.y));
  // A soft cove light along the top of the wall.
  col += WARM * 0.25 * exp(-max(0.0, ${g(CEILING_Y)} - 0.15 - p.y) / 0.25) * step(p.y, ${g(CEILING_Y)} - 0.1);
  col = p.y > ${g(CEILING_Y)} - 0.15 && p.y < ${g(CEILING_Y)} - 0.1 ? WARM * 0.6 : col;
  // Light from the screens.
  float dm = max(0.0, sdRect(p, SCREENS[0], 0.0));
  col += vec3(0.03, 0.07, 0.17) * 0.6 * exp(-dm / 0.5);
  for (int i = 1; i < 6; i++) {
    float ds = max(0.0, sdRect(p, SCREENS[i], 0.0));
    col += vec3(0.1, 0.09, 0.07) * 0.12 * exp(-ds / 0.3);
  }
  for (int i = 0; i < 6; i++) {
    float d = sdRect(p, SCREENS[i], 0.03);
    if (d < 0.2) {
      mask = 1.0;
    }
    if (d < 0.07) {
      float t = clamp(d / 0.07, 0.0, 1.0);
      col = vec3(0.04, 0.042, 0.048) * (0.6 + 0.8 * t);
      if (d < 0.0) {
        col = vec3(0.008, 0.01, 0.018);
      }
    }
  }
  return col;
}

vec4 shade(vec3 d) {
  vec3 eye = vec3(0.0, EYE_Y, 0.0);
  vec2 dir = vec2(d.z, d.y);
  // Consoles, nearest row first: the first one hit hides the rest.
  for (int k = 0; k < ROWS; k++) {
    float fl = rowFloor(k);
    float z0 = rowZ(k);
    float x0 = rowX0(k);
    float best = 1e9;
    int surf = 0;
    float sHit = 0.0;
    vec2 pts[6] = vec2[6](
      vec2(z0, fl), vec2(z0, fl + DESK_H), vec2(z0 + DESK_D, fl + DESK_H),
      vec2(z0 + DESK_D, fl + FACE_Y0), vec2(z0 + FACE_Z1, fl + FACE_Y1), vec2(z0 + TOP_Z1, fl + FACE_Y1));
    for (int i = 0; i < 5; i++) {
      float s;
      float t = segHit(dir, pts[i], pts[i + 1], s);
      float x = d.x * t;
      if (t > 0.0 && t < best && x > x0 && x < x0 + float(UNITS) * UNIT_W) {
        best = t;
        surf = i + 1;
        sHit = s;
      }
    }
    // A cup or ashtray on the top, in front of whatever is behind it.
    float zc = z0 + 0.5 * (FACE_Z1 + TOP_Z1);
    float tc = zc / d.z;
    float xc = d.x * tc;
    int iu = int(floor((xc - x0) / UNIT_W));
    if (iu >= 0 && iu < UNITS) {
      int u = k * UNITS + iu;
      vec4 cl = texelFetch(uUnits, ivec2(4, u), 0);
      if (cl.x > 0.5) {
        bool cup = cl.x < 1.5;
        float rad = cup ? 0.042 : 0.07;
        float h = cup ? 0.1 : 0.03;
        float base = fl + FACE_Y1;
        vec2 c = vec2(x0 + float(iu) * UNIT_W + cl.y, zc);
        vec2 dd = vec2(d.x, d.z);
        float a = dot(dd, dd);
        float b = -dot(dd, c);
        float disc = b * b - a * (dot(c, c) - rad * rad);
        if (disc > 0.0) {
          float t = (-b - sqrt(disc)) / a;
          vec3 p = eye + d * t;
          if (t < best && p.y > base && p.y < base + h) {
            vec3 n = normalize(vec3(p.x - c.x, 0.0, p.z - c.y));
            vec3 alb = cup ? vec3(0.78, 0.75, 0.7) : vec3(0.16, 0.16, 0.17);
            float l = ambient(n) + 0.45 * max(0.0, dot(n, KEY)) * pool(p.x) + 0.1 * pow(max(0.0, -n.x), 3.0);
            return vec4(alb * WARM * l, 0.0);
          }
          float tt = (base + h - EYE_Y) / d.y;
          vec3 q = eye + d * tt;
          float rr = length(vec2(q.x - c.x, q.z - c.y));
          if (tt > 0.0 && tt < best && rr < rad) {
            vec3 inside = cup ? vec3(0.05, 0.032, 0.02) : vec3(0.22, 0.21, 0.2);
            vec3 rim = cup ? vec3(0.8, 0.77, 0.72) : vec3(0.2, 0.2, 0.21);
            return vec4(mix(inside, rim, smoothstep(rad - 0.012, rad - 0.006, rr)) * WARM * 0.5, 0.0);
          }
        }
      }
    }
    if (surf == 0) {
      continue;
    }
    vec3 p = eye + d * best;
    if (surf == 4) {
      int u = k * UNITS + clamp(int(floor((p.x - x0) / UNIT_W)), 0, UNITS - 1);
      vec2 q = vec2(p.x - x0 - floor((p.x - x0) / UNIT_W) * UNIT_W, sHit * FACE_LEN);
      return vec4(faceColour(u, q, p.x), float(k + 1) * 32.0 / 255.0);
    }
    float ux = p.x - x0 - floor((p.x - x0) / UNIT_W) * UNIT_W;
    float seam = min(ux, UNIT_W - ux) < 0.006 ? 0.5 : 1.0;
    if (surf == 5) {
      // The flat top, rounded at its front edge.
      float e = 1.0 - smoothstep(0.0, 0.03, p.z - z0 - FACE_Z1);
      vec3 n = normalize(mix(vec3(0.0, 1.0, 0.0), FACE_N, e * 0.5));
      return vec4(lit(CONSOLE, n, p.x) * seam, 0.0);
    }
    if (surf == 2) {
      return vec4(lit(vec3(0.3, 0.29, 0.27), vec3(0.0, 1.0, 0.0), p.x) * seam, 0.0);
    }
    return vec4(lit(CONSOLE * 0.55, vec3(0.0, 0.0, -1.0), p.x) * seam * 0.7, 0.0);
  }
  // The floor, stepping down row by row, then the pit before the wall.
  if (d.y < 0.0) {
    for (int k = 0; k <= ROWS; k++) {
      float y = k < ROWS ? rowFloor(k) : ${g(PIT_Y)};
      float t = (y - EYE_Y) / d.y;
      float z = d.z * t;
      float zEnd = k < ROWS ? rowZ(k) + TOP_Z1 : WALL_Z;
      if (z < zEnd && abs(d.x * t) < ${g(ROOM_HALF)}) {
        vec3 p = eye + d * t;
        float carpet = 0.9 + 0.1 * vnoise(p.xz * 40.0);
        return vec4(lit(vec3(0.07, 0.07, 0.09) * carpet, vec3(0.0, 1.0, 0.0), p.x), 0.0);
      }
    }
  }
  float tw = WALL_Z / d.z;
  float ts = (${g(ROOM_HALF)}) / max(abs(d.x), 1e-6);
  float tc = d.y > 0.0 ? (${g(CEILING_Y)} - EYE_Y) / d.y : 1e9;
  if (tc < tw && tc < ts) {
    // Ceiling: dark, with a row of round downlights near the wall.
    vec3 p = eye + d * tc;
    vec2 cell = vec2(fract(p.x / 2.2 + 0.5) - 0.5, (p.z - 10.6) / 2.2);
    float r = length(cell) * 2.2;
    vec3 col = vec3(0.05, 0.05, 0.055) * WARM;
    col += WARM * (0.75 * (1.0 - smoothstep(0.14, 0.16, r)) + 0.05 * exp(-r / 0.3));
    return vec4(col, 0.0);
  }
  if (ts < tw) {
    vec3 p = eye + d * ts;
    return vec4(vec3(0.12, 0.125, 0.14) * WARM * (0.12 + 0.05 * smoothstep(0.0, 4.0, p.y)), 0.0);
  }
  vec3 p = eye + d * tw;
  float mask;
  vec3 col = wallColour(p.xy, mask);
  return vec4(col, mask);
}

${SUPERSAMPLE4_GLSL}
void main() {
  float aspect = uResolution.x / uResolution.y;
  vec3 acc = vec3(0.0);
  float code = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 ndc = (gl_FragCoord.xy + SS4_OFFSETS[i]) / uResolution * 2.0 - 1.0;
    vec4 s = shade(rayDir(ndc, aspect));
    acc += s.rgb * 0.25;
    // The material code isn't averaged: the first sample's stands for the pixel.
    if (i == 0) {
      code = s.a;
    }
  }
  outColor = vec4(acc, code);
}
`;

/**
 * Every frame: the cached room, plus whatever glows. On the wall: the world map
 * with its ground tracks and craft, the telemetry, the launch screen, the big
 * clock, the countdown and the graphs. On the consoles: each CRT's scrolling
 * numbers or graph, and the push-buttons' lights. The console CRTs and the
 * launch screen go through one CRT function, in each screen's own UV.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uRoom;
uniform sampler2D uUnits;
uniform sampler2D uState;
uniform sampler2D uPage;
uniform sampler2D uFont;
uniform sampler2D uGraph;
uniform sampler2D uTrack;
uniform sampler2D uMask;
uniform vec2 uResolution;
// Pixels per metre at unit depth along the view.
uniform float uFocal;
uniform float uTime;
uniform vec3 uPhosphor;
uniform float uGraphShift;
// Per craft: latitude, longitude, the current orbit's starting longitude and
// how far (degrees) it has come since.
uniform vec4 uCraft[${String(CRAFTS)}];
uniform int uCraftCount;
// Launch site: latitude, longitude, shown.
uniform vec3 uSite;
// Launch screen: seconds since liftoff (negative on the pad), climb, brightness, venting.
uniform vec4 uTv;
// Big clock and countdown: characters and width (digit heights).
uniform vec2 uClockText;
uniform vec2 uCountText;
out vec4 outColor;
${COMMON_GLSL}
${DITHER_GLSL}
const vec4 MAP = ${rect(S.map)};
const vec4 TELEMETRY = ${rect(S.telemetry)};
const vec4 TV = ${rect(S.tv)};
const vec4 CLOCK = ${rect(S.clock)};
const vec4 COUNTDOWN = ${rect(S.countdown)};
const vec4 GRAPHS = ${rect(S.graphs)};
const int SEG_MASK[${String(GLYPH_COUNT)}] = int[${String(GLYPH_COUNT)}](${sevenSegmentMasks().join(", ")});
const float BINS = ${g(TRACK_BINS)};
const float LAND_MASK_GAIN = ${g(LAND_MASK_GAIN)};
const float LAND_MASK_BIAS = ${g(LAND_MASK_BIAS)};
const vec3 WALL_TEXT = vec3(1.0, 0.86, 0.58);
const vec3 TRACK_A = vec3(1.0, 0.92, 0.6);
const vec3 TRACK_B = vec3(1.0, 0.55, 0.25);

vec4 blockState(int b) {
  return texelFetch(uState, ivec2(b, 0), 0);
}

int pageCode(int line, int col) {
  return int(texelFetch(uPage, ivec2(col, line), 0).r * 255.0 + 0.5);
}

// Brightness of glyph g at q, in dots from its cell's bottom left (the glyph
// fills dots 0-4 across and 1-7 up), with dots dotPx pixels apart. Dots are
// soft and round; too small to resolve, they fade to the glyph's average.
float glyphDots(int gl, vec2 q, float dotPx) {
  vec2 dp = q - vec2(0.0, 1.0);
  ivec2 id = ivec2(floor(dp));
  if (gl <= 0 || id.x < 0 || id.y < 0 || id.x >= ${String(GLYPH_W)} || id.y >= ${String(GLYPH_H)}) {
    return 0.0;
  }
  float on = texelFetch(uFont, ivec2(gl * ${String(GLYPH_W)} + id.x, id.y), 0).r;
  vec2 f = fract(dp) - 0.5;
  float sigma = max(0.3, 0.6 / dotPx);
  float sharp = on * exp(-dot(f, f) / (2.0 * sigma * sigma)) * min(1.0, 0.3 / sigma + 0.2);
  float avg = texelFetch(uFont, ivec2(gl * ${String(GLYPH_W)}, ${String(GLYPH_H)}), 0).r * 0.6;
  return mix(avg, sharp, smoothstep(1.2, 2.6, dotPx));
}

// Dot-matrix text: p in dots from the top left of page line 'line' (x right,
// y down). Cells marked as random digits show a digit hashed from 'key'.
float textAt(vec2 p, int line, int cols, uint key, float dotPx) {
  float col = floor(p.x / 6.0);
  if (p.x < 0.0 || p.y < 0.0 || p.y >= 9.0 || col >= float(cols)) {
    return 0.0;
  }
  int code = pageCode(line, int(col));
  if (code == ${String(RANDOM_DIGIT)}) {
    code = ${String(DIGIT_0)} + int(hash32(key ^ (uint(col) * 0x9e3779b1u)) % 10u);
  }
  return glyphDots(code, vec2(p.x - col * 6.0, 8.0 - p.y), dotPx);
}

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0));
}

// One seven-segment character in a cell one unit tall, x from 0 to its width:
// lit segments in x, unlit in y.
vec2 sevenSeg(int mask, vec2 p, float aa) {
  p.x -= 0.08 * (p.y - 0.5);
  const float W = ${g(SEG_DIGIT)};
  const float HW = 0.055;
  vec2 a[9] = vec2[9](vec2(0.1, 0.96), vec2(W - 0.04, 0.88), vec2(W - 0.04, 0.12), vec2(0.1, 0.04),
    vec2(0.04, 0.12), vec2(0.04, 0.88), vec2(0.1, 0.5), vec2(0.5 * W, 0.33), vec2(0.5 * W, 0.3));
  vec2 b[9] = vec2[9](vec2(W - 0.1, 0.96), vec2(W - 0.04, 0.56), vec2(W - 0.04, 0.44), vec2(W - 0.1, 0.04),
    vec2(0.04, 0.44), vec2(0.04, 0.56), vec2(W - 0.1, 0.5), vec2(0.5 * W, 0.67), vec2(0.5 * W, 0.7));
  vec2 r = vec2(0.0);
  if (mask == ${String(SEG_COLON_MASK)}) {
    vec2 q = vec2(p.x - ${g(SEG_COLON / 2)}, p.y);
    float dc = min(length(q - vec2(0.0, 0.3)), length(q - vec2(0.0, 0.7)));
    return vec2(1.0 - smoothstep(0.06 - aa, 0.06 + aa, dc), 0.0);
  }
  for (int i = 0; i < 8; i++) {
    float c = 1.0 - smoothstep(HW - aa, HW + aa, segDist(p, a[i], b[i]));
    if (((mask >> i) & 1) == 1) {
      r.x = max(r.x, c);
    } else if (i < 7) {
      r.y = max(r.y, c);
    }
  }
  return r;
}

// A line of seven-segment characters, one unit tall, centred on x = 0.
vec2 sevenSegLine(int line, vec2 info, vec2 p, float aa) {
  float x = p.x + 0.5 * info.y;
  if (x < 0.0 || x > info.y || p.y < 0.0 || p.y > 1.0) {
    return vec2(0.0);
  }
  float at = 0.0;
  for (int i = 0; i < ${String(SEG_LINE_MAX)}; i++) {
    if (i >= int(info.x)) {
      break;
    }
    int code = pageCode(line, i);
    int mask = SEG_MASK[code];
    float w = mask == ${String(SEG_COLON_MASK)} ? ${g(SEG_COLON)} : ${g(SEG_DIGIT)};
    if (x < at + w + ${g(SEG_GAP / 2)}) {
      return code == 0 ? vec2(0.0) : sevenSeg(mask, vec2(x - at, p.y), aa);
    }
    at += w + ${g(SEG_GAP)};
  }
  return vec2(0.0);
}

// The CRT look, in a screen's own UV (0 to 1): barrel curvature, the tube's
// rounded edge, scanlines (faded out where they would alias) and a gentle,
// slow flicker. Returns the warped UV in xy, the tube's mask in z and the
// brightness gain in w.
vec4 crt(vec2 uv, float lines, float linePx, float seed) {
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + 0.07 * dot(c, c);
  vec2 w = c * 0.5 + 0.5;
  vec2 e = abs(c) - vec2(0.86);
  float corner = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - 0.14;
  float mask = 1.0 - smoothstep(-0.03, 0.0, corner);
  float scan = mix(1.0, 0.72 + 0.28 * cos(TAU * w.y * lines), smoothstep(1.6, 3.2, linePx));
  float flicker = 1.0 + 0.02 * sin(TAU * (${g(CRT_FLICKER_RATES[0])} * uTime + seed)) * sin(TAU * (${g(CRT_FLICKER_RATES[1])} * uTime + 1.7 * seed));
  return vec4(w, mask, scan * flicker);
}

${GRAPH_DISTANCE_GLSL}
float graphTrace(int row, vec2 gp, vec2 size, float hw, float mpp) {
  float dm = graphDistance(row, gp, size, vec2(0.0, 1.0));
  float ends = smoothstep(0.0, 0.02, gp.x) * (1.0 - smoothstep(0.98, 1.0, gp.x));
  return max(1.0 - smoothstep(hw - mpp, hw + mpp, dm), 0.25 * exp(-dm / (3.0 * hw))) * ends;
}

// A console CRT's picture at uv: scrolling lines of numbers under a header, or a graph.
float consoleCrt(int block, float mode, float graphRow, vec2 uv, float px) {
  if (mode > 0.5) {
    // A graph over a faint grid.
    vec2 gp = (uv - vec2(0.08, 0.12)) / vec2(0.84, 0.76);
    vec2 gd = abs(fract(gp * vec2(6.0, 4.0) + 0.5) - 0.5) / vec2(6.0, 4.0);
    float lw = 1.0 / px;
    float grid = 0.1 * (1.0 - smoothstep(0.5 * lw, 1.5 * lw, min(gd.x, gd.y)));
    float v = 0.0;
    if (gp.x > 0.0 && gp.x < 1.0 && gp.y > -0.1 && gp.y < 1.1) {
      v = graphTrace(int(graphRow), gp, vec2(1.0, 0.75), 0.012, lw);
    }
    return gp.x > 0.0 && gp.x < 1.0 && gp.y > 0.0 && gp.y < 1.0 ? max(v, grid) : v;
  }
  // Eight columns by six lines of 5x7 dots.
  vec4 st = blockState(block);
  int scroll = int(st.g * 255.0 + 0.5);
  vec2 dots = vec2(uv.x * 51.0 - 2.0, (1.0 - uv.y) * 56.0 - 1.0);
  int line = int(floor(dots.y / 9.0));
  float dotPx = px / 51.0;
  uint key = hash32(uint(block) * 747796405u);
  if (line < 0 || line > 5) {
    return 0.0;
  }
  if (line == 0) {
    return textAt(vec2(dots.x, dots.y), ${String(LINE.headers)} + int(key % ${String(HEADER_COUNT)}u), ${String(CRT_COLS)}, key, dotPx);
  }
  int abs_ = scroll + line;
  uint lk = hash32(key ^ uint(abs_) * 2654435761u);
  return textAt(vec2(dots.x, dots.y - float(line) * 9.0), ${String(LINE.patterns)} + int(lk % ${String(PATTERN_COUNT)}u), ${String(CRT_COLS)}, lk, dotPx);
}

vec3 buttonColour(int i) {
  return i == 0 ? vec3(1.0, 0.93, 0.8) : i == 1 ? vec3(1.0, 0.62, 0.18) : i == 2 ? vec3(0.35, 1.0, 0.45)
    : i == 3 ? vec3(1.0, 0.25, 0.18) : vec3(0.45, 0.65, 1.0);
}

// Light from row k's sloping face at (x, f): CRTs and push-buttons.
vec3 faceLight(int k, float x, float f, float mpp) {
  float x0 = rowX0(k);
  float iu = clamp(floor((x - x0) / UNIT_W), 0.0, float(UNITS - 1));
  int u = k * UNITS + int(iu);
  vec2 q = vec2(x - x0 - iu * UNIT_W, f);
  vec3 col = vec3(0.0);
  vec4 info = texelFetch(uUnits, ivec2(3, u), 0);
  vec4 extra = texelFetch(uUnits, ivec2(4, u), 0);
  int blockBase = 1 + u * ${String(BLOCKS_PER_UNIT)};
  for (int j = 0; j < 2; j++) {
    float mode = j == 0 ? info.z : info.w;
    if (mode > 1.5) {
      continue;
    }
    vec4 r = texelFetch(uUnits, ivec2(j, u), 0);
    float d = sdRect(q, r, 0.025);
    if (d > 0.05) {
      continue;
    }
    int block = blockBase + j;
    float level = blockState(block).r;
    vec2 size = r.zw - r.xy;
    float px = size.x / mpp;
    vec2 uv = (q - r.xy) / size;
    vec4 c = crt(uv, 60.0, size.y / mpp / 60.0, float(block) * 0.137);
    float pic = 0.0;
    if (d < 0.0) {
      pic = consoleCrt(block, mode, j == 0 ? extra.z : extra.w, c.xy, px);
    }
    float v = (pic * 0.9 + 0.05) * c.z * c.w * level;
    // Phosphor glow, on the glass and out onto the bezel.
    v += 0.06 * level * exp(-max(d, 0.0) / 0.012);
    col += uPhosphor * v;
  }
  vec4 bank = texelFetch(uUnits, ivec2(2, u), 0);
  vec2 cell = (bank.zw - bank.xy) / max(info.xy, vec2(1.0));
  vec2 cc = floor((q - bank.xy) / cell);
  if (cc.x >= 0.0 && cc.y >= 0.0 && cc.x < info.x && cc.y < info.y) {
    vec2 lp = q - bank.xy - (cc + 0.5) * cell;
    float side = 0.36 * min(cell.x, cell.y);
    float cd = sdRect(lp, vec4(-side, -side, side, side), side * 0.25);
    int b = int((info.y - 1.0 - cc.y) * info.x + cc.x);
    vec4 st = blockState(blockBase + 2 + b);
    int pal = int(st.a * 255.0 + 0.5);
    vec3 lens = mix(buttonColour(pal % 8), buttonColour(pal / 8), st.g);
    float cap = 1.0 - smoothstep(-mpp, mpp, cd);
    float halo = exp(-max(cd, 0.0) / 0.006) * 0.25;
    col += (lens * 0.75 + st.b * 0.35) * st.r * max(cap * (0.85 + 0.15 * smoothstep(side, -side, lp.y)), halo);
  }
  return col;
}

vec3 mapScreen(vec2 uv, float mpp) {
  vec2 size = MAP.zw - MAP.xy;
  vec2 pm = uv * size;
  float lon = uv.x * 360.0 - 180.0;
  float d = texture(uMask, vec2(uv.x, 1.0 - uv.y)).r * LAND_MASK_GAIN - LAND_MASK_BIAS;
  float aa = max(0.6, mpp * ${g(LAND_MASK_WIDTH)} / size.x);
  float land = smoothstep(-aa, aa, d);
  vec3 col = mix(vec3(0.02, 0.055, 0.17), vec3(0.36, 0.43, 0.42), land);
  col += vec3(0.25, 0.32, 0.34) * 0.35 * (1.0 - smoothstep(0.0, 1.5 * aa, abs(d)));
  // Graticule every 30 degrees, the equator a little brighter.
  vec2 deg = vec2(lon, uv.y * 180.0 - 90.0);
  vec2 gd = abs(fract(deg / 30.0 + 0.5) - 0.5) * 30.0 * size / vec2(360.0, 180.0);
  float grid = 1.0 - smoothstep(0.004, 0.004 + mpp, min(gd.x, gd.y));
  float eq = 1.0 - smoothstep(0.005, 0.005 + mpp, abs(deg.y) * size.y / 180.0);
  col += vec3(0.25, 0.35, 0.5) * (0.12 * grid + 0.1 * eq);
  // Ground tracks: the previous orbit fainter, the current one bright behind
  // the craft and dashed ahead of it.
  float hw = 0.011;
  for (int c = 0; c < ${String(CRAFTS)}; c++) {
    if (c >= uCraftCount) {
      break;
    }
    vec3 tint = c == 0 ? TRACK_A : TRACK_B;
    int j = int(floor(uv.x * BINS));
    float dPrev = 1e9;
    float dCur = 1e9;
    for (int k = j - 1; k <= j + 1; k++) {
      int kk = ((k % ${String(TRACK_BINS)}) + ${String(TRACK_BINS)}) % ${String(TRACK_BINS)};
      vec4 e = texelFetch(uTrack, ivec2(kk, c), 0);
      float xa = float(k) / BINS * size.x;
      float xb = float(k + 1) / BINS * size.x;
      if (e.x < 500.0 && e.y < 500.0) {
        dPrev = min(dPrev, segDist(pm, vec2(xa, (e.x / 180.0 + 0.5) * size.y), vec2(xb, (e.y / 180.0 + 0.5) * size.y)));
      }
      if (e.z < 500.0 && e.w < 500.0) {
        dCur = min(dCur, segDist(pm, vec2(xa, (e.z / 180.0 + 0.5) * size.y), vec2(xb, (e.w / 180.0 + 0.5) * size.y)));
      }
    }
    float off = mod(lon - uCraft[c].z, 360.0);
    bool past = off <= uCraft[c].w || off > 350.0;
    float dash = past ? 1.0 : 0.4 * step(0.45, fract(lon / 3.0));
    float cur = (1.0 - smoothstep(hw - mpp, hw + mpp, dCur)) * dash + (past ? 0.2 * exp(-dCur / 0.03) : 0.0);
    float prev = 0.4 * (1.0 - smoothstep(hw * 0.8 - mpp, hw * 0.8 + mpp, dPrev));
    col += tint * max(cur, prev);
    // The craft: a dot in a slowly breathing ring.
    vec2 cp = vec2((uCraft[c].y + 180.0) / 360.0, uCraft[c].x / 180.0 + 0.5) * size;
    vec2 dv = pm - cp;
    dv.x -= size.x * floor(dv.x / size.x + 0.5);
    float r = length(dv);
    float ring = 1.0 - smoothstep(0.012 - mpp, 0.012 + mpp, abs(r - 0.1 - 0.015 * sin(TAU * ${g(RING_RATE)} * uTime)));
    float dot_ = 1.0 - smoothstep(0.045 - mpp, 0.045 + mpp, r);
    col += mix(tint, vec3(1.0), 0.5) * max(dot_, 0.7 * ring) + tint * 0.25 * exp(-r / 0.08);
  }
  if (uSite.z > 0.5) {
    // The launch site: a small diamond.
    vec2 sp = vec2((uSite.y + 180.0) / 360.0, uSite.x / 180.0 + 0.5) * size;
    float dd = abs(abs(pm.x - sp.x) + abs(pm.y - sp.y) - 0.07);
    col += TRACK_B * 0.8 * (1.0 - smoothstep(0.01 - mpp, 0.01 + mpp, dd));
  }
  // The title, small, in the top left.
  float dot_ = 0.016;
  col += WALL_TEXT * 0.6 * textAt((pm - vec2(0.12, size.y - 0.1)) * vec2(1.0, -1.0) / dot_, ${String(LINE.mapLabel)}, 24, 0u, dot_ / mpp);
  return col * 0.85;
}

// The launch screen: a rocket on its pad by the tower, venting during the
// countdown, then climbing away on its flame over billowing smoke. Monochrome.
float tvScene(vec2 uv) {
  float s = uTv.x;
  vec2 p = vec2((uv.x - 0.5) * ${g(4 / 3)}, uv.y);
  float v = mix(0.36, 0.56, uv.y);
  float ground = 0.17 + 0.008 * sin(p.x * 13.0) + 0.006 * sin(p.x * 31.0 + 1.0);
  if (uv.y < ground) {
    v = 0.14 + 0.04 * uv.y;
  }
  // The tower: two rails with cross-bracing, and arms over to the rocket.
  float tx = p.x + 0.17;
  if (abs(tx) < 0.045 && uv.y > ground - 0.01 && uv.y < 0.8) {
    float d1 = 0.045 - abs(tx);
    float d2 = abs(fract(uv.y / 0.05) - 0.5) * 0.05;
    float d3 = abs(fract((uv.y + tx * (tx > 0.0 ? 1.0 : -1.0)) / 0.05) - 0.5) * 0.035;
    v = mix(v, 0.07, 1.0 - smoothstep(0.003, 0.007, min(d1, min(d2, d3))));
  }
  float armsIn = s < 0.0 ? 1.0 : 0.0;
  for (int i = 0; i < 2; i++) {
    float ay = ground + 0.22 + 0.2 * float(i);
    if (armsIn > 0.5 && p.x > -0.13 && p.x < -0.035 && abs(uv.y - ay) < 0.008) {
      v = 0.09;
    }
  }
  // The rocket: a white body with two dark bands, a pointed nose and fins.
  float base = ground + 0.015 + uTv.y;
  float rel = uv.y - base;
  float bx = abs(p.x);
  const float RW = 0.032;
  float body = rel > 0.0 && rel < 0.46 && bx < RW ? 1.0 : 0.0;
  float nose = rel >= 0.46 && rel < 0.58 && bx < RW * (1.0 - (rel - 0.46) / 0.12) ? 1.0 : 0.0;
  float fin = rel > 0.0 && rel < 0.07 && bx >= RW && bx < RW + 0.028 * (1.0 - rel / 0.07) ? 1.0 : 0.0;
  if (body + nose > 0.0) {
    float shadeX = 0.62 + 0.33 * clamp(-p.x / RW, -1.0, 1.0);
    float band = (rel > 0.16 && rel < 0.18) || (rel > 0.34 && rel < 0.355) ? 0.45 : 1.0;
    v = shadeX * band * 0.95;
  } else if (fin > 0.0) {
    v = 0.3;
  }
  if (s >= 0.0) {
    float ign = smoothstep(0.0, 1.5, s);
    float rise = smoothstep(${g(2)}, ${g(6)}, s);
    // Smoke rolling out along the ground, then thinning.
    float spread = 0.08 + 0.55 * (1.0 - exp(-s / 7.0));
    vec2 sp = vec2(p.x / spread, (uv.y - ground) / (0.05 + 0.08 * ign));
    float n = vnoise(vec2(p.x * 14.0 - s * 0.2, uv.y * 14.0)) * 0.6 + vnoise(vec2(p.x * 31.0 + s * 0.15, uv.y * 31.0)) * 0.4;
    float cloud = smoothstep(1.0, 0.55, length(sp) + 0.45 * (n - 0.5)) * ign;
    // The exhaust column the rocket leaves, widening as it drifts.
    float colW = min(0.012 + 0.004 * max(0.0, s - 3.0), 0.06);
    float column = rise * step(uv.y, base) * step(ground, uv.y) * smoothstep(colW, colW * 0.3, bx + 0.02 * (n - 0.5));
    column *= 0.7 * (1.0 - smoothstep(15.0, 50.0, s));
    float fade = 1.0 - smoothstep(30.0, 90.0, s);
    v = mix(v, 0.82 + 0.1 * n, clamp(max(cloud * fade, column), 0.0, 1.0));
    // The flame under the rocket, its brightness capped.
    float len = (0.05 + 0.12 * rise) * ign * (1.0 + 0.06 * sin(TAU * 1.7 * s));
    float fr = -rel / max(len, 1e-3);
    if (fr > 0.0 && fr < 1.0 && uv.y > ground && bx < RW * 0.8 * sqrt(1.0 - fr)) {
      v = max(v, 0.95);
    }
  } else if (uTv.w > 0.5) {
    // Vapour venting from the upper stage, drifting off.
    vec2 vp = vec2(p.x - 0.03, uv.y - (base + 0.4));
    // Its noise tiles across the drift, so the clock's wrap doesn't jump it.
    float n = vnoiseTileX(vec2(vp.x * 30.0 - uTime * ${g(VAPOUR_DRIFT)}, vp.y * 30.0), ${g(VAPOUR_TILE)});
    float wisp = smoothstep(0.12, 0.0, length(vp * vec2(0.6, 2.5))) * step(0.0, vp.x) * smoothstep(0.35, 0.75, n);
    v = mix(v, 0.85, 0.6 * wisp);
  }
  // Film grain, re-randomised at the codec's frame rate, slow enough not to sparkle.
  uvec2 gc = uvec2(ivec2(floor(uv * vec2(160.0, 120.0))) + 65536);
  uint gf = uint(floor(uTime * ${g(TV_GRAIN_RATE)}));
  v += 0.05 * (float(hash32(gc.x ^ hash32(gc.y ^ hash32(gf)))) / 4294967296.0 - 0.5);
  return v * uTv.z;
}

vec3 wallLight(vec2 p, float mpp) {
  if (p.x > MAP.x && p.x < MAP.z && p.y > MAP.y && p.y < MAP.w) {
    return mapScreen((p - MAP.xy) / (MAP.zw - MAP.xy), mpp);
  }
  if (p.x > TELEMETRY.x && p.x < TELEMETRY.z && p.y > TELEMETRY.y && p.y < TELEMETRY.w) {
    const float DOT = 0.0185;
    vec2 q = (vec2(p.x - TELEMETRY.x - 0.2, TELEMETRY.w - 0.12 - p.y)) / DOT;
    int line = int(floor(q.y / 9.0));
    if (line < 0 || line >= ${String(TELEMETRY_LINES)}) {
      return vec3(0.0);
    }
    vec4 st = blockState(${String(telemetryBlock(0))} + line);
    uint key = hash32(uint(line * 977) ^ uint(st.g * 255.0 + 0.5) * 2654435761u);
    return WALL_TEXT * 0.8 * textAt(vec2(q.x, q.y - float(line) * 9.0), ${String(LINE.telemetry)} + line, ${String(TELEMETRY_COLS)}, key, DOT / mpp);
  }
  if (p.x > TV.x && p.x < TV.z && p.y > TV.y && p.y < TV.w) {
    vec2 size = TV.zw - TV.xy;
    vec4 c = crt((p - TV.xy) / size, 120.0, size.y / mpp / 120.0, 0.3);
    return vec3(0.82, 0.88, 1.0) * tvScene(c.xy) * c.z * c.w * 0.8;
  }
  float aa = 1.5 * mpp;
  if (p.x > CLOCK.x && p.x < CLOCK.z && p.y > CLOCK.y && p.y < CLOCK.w) {
    const float DOT = 0.016;
    float label = textAt(vec2(p.x - CLOCK.x - 0.15, CLOCK.w - 0.08 - p.y) / DOT, ${String(LINE.clockLabel)}, 24, 0u, DOT / mpp);
    const float H = 0.5;
    vec2 seg = sevenSegLine(${String(LINE.clock)}, uClockText, (p - vec2(0.5 * (CLOCK.x + CLOCK.z), CLOCK.y + 0.1)) / H, aa / H);
    return WALL_TEXT * 0.6 * label + vec3(1.0, 0.7, 0.25) * (seg.x * 0.95 + seg.y * 0.05);
  }
  if (p.x > COUNTDOWN.x && p.x < COUNTDOWN.z && p.y > COUNTDOWN.y && p.y < COUNTDOWN.w) {
    const float DOT = 0.016;
    float label = textAt(vec2(p.x - COUNTDOWN.x - 0.15, COUNTDOWN.w - 0.08 - p.y) / DOT, ${String(LINE.countdownLabel)}, 24, 0u, DOT / mpp);
    const float H = 0.62;
    vec2 seg = sevenSegLine(${String(LINE.countdown)}, uCountText, (p - vec2(0.5 * (COUNTDOWN.x + COUNTDOWN.z), COUNTDOWN.y + 0.1)) / H, aa / H);
    return WALL_TEXT * 0.6 * label + vec3(1.0, 0.32, 0.18) * (seg.x * 0.95 + seg.y * 0.05);
  }
  if (p.x > GRAPHS.x && p.x < GRAPHS.z && p.y > GRAPHS.y && p.y < GRAPHS.w) {
    float h = (GRAPHS.w - GRAPHS.y) / ${g(WALL_GRAPHS)};
    int i = int(floor((GRAPHS.w - p.y) / h));
    float top = GRAPHS.w - float(i) * h;
    const float DOT = 0.014;
    float label = textAt(vec2(p.x - GRAPHS.x - 0.15, top - 0.06 - p.y) / DOT, ${String(LINE.graphLabels)} + i, 16, 0u, DOT / mpp);
    vec2 r0 = vec2(GRAPHS.x + 0.15, top - h + 0.05);
    vec2 size = vec2(GRAPHS.z - GRAPHS.x - 0.3, h - 0.25);
    vec2 gp = (p - r0) / size;
    float v = 0.0;
    if (gp.x > 0.0 && gp.x < 1.0 && gp.y > -0.2 && gp.y < 1.2) {
      v = graphTrace(i, gp, size, 0.01, mpp);
      v = max(v, 0.15 * (1.0 - smoothstep(0.003, 0.003 + mpp, abs(p.y - r0.y))));
    }
    return WALL_TEXT * 0.6 * label + vec3(0.5, 0.85, 1.0) * 0.8 * v;
  }
  return vec3(0.0);
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec4 room = texelFetch(uRoom, fc, 0);
  vec3 col = room.rgb;
  int code = int(room.a * 255.0 + 0.5);
  if (code > 16) {
    vec2 ndc = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
    vec3 d = rayDir(ndc, uResolution.x / uResolution.y);
    if (code > 200) {
      float t = WALL_Z / d.z;
      vec2 p = vec2(d.x * t, EYE_Y + d.y * t);
      col += wallLight(p, t / uFocal);
    } else {
      int k = clamp(code / 32 - 1, 0, ROWS - 1);
      float f;
      float t = faceHit(k, d, f);
      col += faceLight(k, d.x * t, f, t / uFocal);
    }
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Mission Control. The camera never moves, so the room is ray-traced once per
 * resize or seed into a full-resolution target. Each frame updates the console
 * block states, the graphs' random walks and (when they change) the text page,
 * the ground tracks and the clocks, then draws one full-screen composite.
 */
export const missioncontrol = defineEffect(missioncontrolMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) => scopedProgram(gl, scope, vs, fs);
      const tex = (t: WebGLTexture) =>
        scope.add(t, (x) => {
          gl.deleteTexture(x);
        });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, ["uResolution", "uUnits"]);
      const compositeProgram = program(FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const cu = createUniforms(gl, compositeProgram, [
        "uRoom",
        "uUnits",
        "uState",
        "uPage",
        "uFont",
        "uGraph",
        "uTrack",
        "uMask",
        "uResolution",
        "uFocal",
        "uTime",
        "uPhosphor",
        "uGraphShift",
        "uCraft",
        "uCraftCount",
        "uSite",
        "uTv",
        "uClockText",
        "uCountText",
      ]);
      gl.useProgram(roomProgram);
      ru.i1("uUnits", 1);
      gl.useProgram(compositeProgram);
      cu.i1("uRoom", 0);
      cu.i1("uUnits", 1);
      cu.i1("uState", 2);
      cu.i1("uPage", 3);
      cu.i1("uFont", 4);
      cu.i1("uGraph", 5);
      cu.i1("uTrack", 6);
      cu.i1("uMask", 7);

      let layout: ConsoleLayout = consoleLayout(0);
      const units = scope.own(
        createColumnTable(gl, TABLE_TEXELS, 4, {
          rows: UNIT_COUNT,
          data: new Float32Array(layout.table),
        }),
      );
      const state = new Uint8Array(BLOCK_COUNT * 4);
      const stateTex = tex(
        createDataTexture(gl, {
          width: BLOCK_COUNT,
          height: 1,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: state,
          filter: gl.NEAREST,
        }),
      );
      const page = buildTextPage();
      const pageTex = tex(
        createDataTexture(gl, {
          width: PAGE_COLS,
          height: PAGE_LINES,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: page,
          filter: gl.NEAREST,
        }),
      );
      const fontTex = tex(
        createDataTexture(gl, {
          width: GLYPH_W * GLYPH_COUNT,
          height: GLYPH_H + 1,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: buildFontTexture(),
          filter: gl.NEAREST,
        }),
      );
      let graph = createGraphWalk(GRAPH_ROWS, 0);
      let graphStart = 0;
      const graphTex = tex(
        createDataTexture(gl, {
          width: GRAPH_SAMPLES,
          height: GRAPH_ROWS,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: graph.values,
          filter: gl.NEAREST,
        }),
      );
      const track = scope.own(createColumnTable(gl, TRACK_BINS, 4, { rows: CRAFTS }));
      track.data.fill(NO_TRACK);
      track.upload();
      const edges = createTrackEdges();
      const maskTex = tex(
        createDataTexture(gl, {
          width: 1,
          height: 1,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: new Uint8Array([0]),
        }),
      );

      // Load the land mask in the background; the next frame uploads it.
      const maskImage = loadLandMask(scope, "Mission Control");

      let room: RenderTarget | null = null;
      scope.defer(() => {
        room?.dispose();
        room = null;
      });

      let width = 1;
      let height = 1;
      let time = 0;
      let seed = Number.NaN;
      let roomDrawn = false;
      let scratch: ConsoleScratch = createConsoleScratch(BLOCK_COUNT, layout.groups);
      let pageDirty = true;
      const lines: string[] = [];
      const setLine = (line: number, text: string) => {
        if (lines[line] !== text) {
          lines[line] = text;
          writeLine(page, line, text);
          pageDirty = true;
        }
      };

      // Orbits, launches and the map.
      let mission: Orbit = missionOrbit(0);
      let metOffset = 0;
      const launch = createLaunchState();
      let launchEpoch = 0;
      let launchesOn: boolean | null = null;
      /** The latest launched craft: its launch number and liftoff time (effect seconds). */
      let flown = -1;
      let flownAt = 0;
      let flownOrbit: Orbit | null = null;
      /** What the track texture was last built for: each craft's orbit, and the launch. */
      let trackOrbit = Number.NaN;
      let trackFlownOrbit = Number.NaN;
      let trackFlownAt = Number.NaN;
      let clockKey = Number.NaN;
      let countKey = Number.NaN;
      let clockText = "";
      let countText = "";
      const pos: LatLonDeg = { lat: 0, lon: 0 };
      const craft = new Float32Array(CRAFTS * 4);
      const date = new Date(0);

      /** Fills a craft's track row and its uniform, for the orbit it is on at `tau`. */
      /** Sets craft `c`'s uniform for `tau` s into its orbit, and returns which orbit it is on. */
      const placeCraft = (c: number, o: Orbit, tau: number, start: number): number => {
        const n = orbitNumber(o, tau);
        const from = Math.max(start, n * 2 * Math.PI);
        const l0 = unwrappedLon(o, timeAtArgument(o, from));
        groundTrack(o, tau, pos);
        craft[c * 4] = pos.lat;
        craft[c * 4 + 1] = pos.lon;
        craft[c * 4 + 2] = wrap(l0, -180, 360);
        craft[c * 4 + 3] = unwrappedLon(o, tau) - l0;
        return n;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          room?.dispose();
          room = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          roomDrawn = false;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          const newSeed = Math.floor(p.seed);
          if (newSeed !== seed) {
            seed = newSeed;
            layout = consoleLayout(seed);
            units.data.set(layout.table);
            gl.activeTexture(gl.TEXTURE1);
            units.upload();
            scratch = createConsoleScratch(BLOCK_COUNT, layout.groups);
            graph = createGraphWalk(GRAPH_ROWS, seed);
            graphStart = time;
            mission = missionOrbit(seed);
            metOffset = missionOffset(seed) - time;
            trackOrbit = Number.NaN;
            launchesOn = null;
            roomDrawn = false;
          }
          if (!room) {
            return;
          }

          // 1. The room, when it may have changed.
          if (!roomDrawn) {
            room.bind();
            gl.useProgram(roomProgram);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, units.texture);
            ru.f2("uResolution", width, height);
            triangle.draw();
            roomDrawn = true;
          }

          // 2. Console activity.
          consoleStates(layout.blocks, seed, p.activity, time, scratch, state);
          gl.activeTexture(gl.TEXTURE2);
          updateDataTexture(gl, stateTex, BLOCK_COUNT, 1, gl.RGBA, gl.UNSIGNED_BYTE, state);
          gl.activeTexture(gl.TEXTURE5);
          if (advanceGraph(graph, time - graphStart)) {
            updateDataTexture(
              gl,
              graphTex,
              GRAPH_SAMPLES,
              GRAPH_ROWS,
              gl.RED,
              gl.UNSIGNED_BYTE,
              graph.values,
            );
          } else {
            gl.bindTexture(gl.TEXTURE_2D, graphTex);
          }

          // 3. Launches: turning them on starts the schedule again. A new gap
          //    leaves the launch under way alone (see `stepLaunch`).
          if (p.launches !== launchesOn) {
            launchesOn = p.launches;
            launchEpoch = time;
            resetLaunch(launch);
            if (!p.launches) {
              flown = -1;
              flownOrbit = null;
              trackOrbit = Number.NaN;
            }
          }
          stepLaunch(launch, time - launchEpoch, p.launchGap);
          if (p.launches && launch.index >= 0 && launch.sinceLiftoff >= 0) {
            const at = launchEpoch + launch.liftoff;
            if (at !== flownAt || flown < 0) {
              flown = launch.index;
              flownAt = at;
              flownOrbit = launchOrbit(seed, flown);
              trackOrbit = Number.NaN;
            }
          }
          let tv = -1;
          let fade = 1;
          if (p.launches && launch.index >= 0 && launch.phase !== "countdown") {
            const reset = launch.reset;
            fade = Math.min(1, Math.abs(launch.sinceLiftoff - reset) / PAD_CUT);
            if (launch.phase === "flight") {
              tv = launch.sinceLiftoff;
            }
          }

          // 4. The crafts and their tracks, rebuilt as each starts a new orbit.
          const tau = metOffset + time;
          const orbit = placeCraft(0, mission, tau, Number.NEGATIVE_INFINITY);
          const flownOn = flownOrbit
            ? placeCraft(1, flownOrbit, time - flownAt, flownOrbit.phase)
            : Number.NaN;
          const count = flownOrbit ? 2 : 1;
          if (
            orbit !== trackOrbit ||
            !Object.is(flownOn, trackFlownOrbit) ||
            !Object.is(flownAt, trackFlownAt)
          ) {
            trackOrbit = orbit;
            trackFlownOrbit = flownOn;
            trackFlownAt = flownAt;
            track.data.fill(NO_TRACK);
            fillTrackRow(
              mission,
              orbitNumber(mission, tau),
              Number.NEGATIVE_INFINITY,
              edges,
              track.data,
              0,
            );
            if (flownOrbit) {
              const ft = time - flownAt;
              fillTrackRow(
                flownOrbit,
                orbitNumber(flownOrbit, ft),
                flownOrbit.phase,
                edges,
                track.data,
                TRACK_BINS * 4,
              );
            }
            gl.activeTexture(gl.TEXTURE6);
            track.upload();
            // Allocates only when a craft starts a new orbit.
            setLine(
              LINE.mapLabel,
              `GROUND TRACK   REV ${String(orbitNumber(mission, tau) + 1).padStart(4, "0")}`,
            );
          }

          // 5. Clocks and labels.
          // Formatted only when the second (or the clock's kind) changes.
          const local = p.clock === "local";
          const now = Date.now();
          const ck = local ? -1 - Math.floor(now / 1000) : Math.floor(metOffset + time);
          if (ck !== clockKey) {
            clockKey = ck;
            date.setTime(now);
            clockText = local ? localTimeText(date) : missionTimeText(metOffset + time);
          }
          setLine(LINE.clock, clockText);
          setLine(LINE.clockLabel, p.clock === "local" ? "LOCAL TIME" : "MISSION ELAPSED TIME");
          const kk =
            p.launches && launch.phase !== "idle"
              ? launch.display * 2 + (launch.phase === "flight" ? 1 : 0)
              : -1;
          if (kk !== countKey) {
            countKey = kk;
            countText = countdownText(launch, p.launches);
          }
          setLine(LINE.countdown, countText);
          setLine(LINE.countdownLabel, p.launches ? "LAUNCH" : "LAUNCH  STANDBY");
          gl.activeTexture(gl.TEXTURE3);
          if (pageDirty) {
            pageDirty = false;
            updateDataTexture(gl, pageTex, PAGE_COLS, PAGE_LINES, gl.RED, gl.UNSIGNED_BYTE, page);
          } else {
            gl.bindTexture(gl.TEXTURE_2D, pageTex);
          }

          gl.activeTexture(gl.TEXTURE7);
          gl.bindTexture(gl.TEXTURE_2D, maskTex);
          const image = maskImage.take();
          if (image) {
            uploadLandMask(gl, image);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
          }

          // 6. Composite to the canvas.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(compositeProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, room.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, units.texture);
          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_2D, fontTex);
          gl.activeTexture(gl.TEXTURE6);
          gl.bindTexture(gl.TEXTURE_2D, track.texture);
          cu.f2("uResolution", width, height);
          cu.f1("uFocal", (0.5 * height) / TAN_HALF_FOV);
          cu.f1("uTime", time % SHADER_PERIOD);
          cu.v3(
            "uPhosphor",
            p.phosphor === "white"
              ? PHOSPHOR_WHITE
              : p.phosphor === "amber"
                ? PHOSPHOR_AMBER
                : PHOSPHOR_GREEN,
          );
          cu.f1("uGraphShift", graphShift(time - graphStart));
          gl.uniform4fv(cu.loc.uCraft, craft);
          cu.i1("uCraftCount", count);
          cu.f3("uSite", LAUNCH_SITE.lat, LAUNCH_SITE.lon, p.launches ? 1 : 0);
          cu.f4(
            "uTv",
            tv,
            tv >= 0 ? rocketClimb(tv) : 0,
            fade,
            p.launches && launch.phase === "countdown" ? 1 : 0,
          );
          cu.f2("uClockText", clockText.length, sevenSegWidth(clockText));
          cu.f2("uCountText", countText.length, sevenSegWidth(countText));
          triangle.draw();
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
