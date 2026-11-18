import { createColorEase } from "../color";
import { createFadeThrough } from "../fade";
import {
  beginFrame,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat as F,
  type RenderTarget,
  scissorBox,
  scopedProgram,
  withScope,
} from "../gl";
import { HASH32_GLSL } from "../noise";
import { fitScale } from "../scene-layout";
import { OVER_GLSL, SDF2D_GLSL } from "../sdf-glsl";
import { defineEffect } from "../types";
import { CLOCK_HANDS_GLSL, CLOCK_MARKS_GLSL } from "../wall-clock";
import {
  advanceRoom,
  clockMinutes,
  createRoom,
  failingLevel,
  FLOOR_Y,
  type FlickerRoom,
  POOL_GLSL,
  stoppedSecond,
  THING_BOXES,
  THING_COAT,
  THING_DOOR,
  THING_FIGURE,
  THING_MAGAZINE,
  THING_PAPER,
  THING_SHIFT,
  THING_TURN,
  THINGS,
  TINT_FLOATS,
  TINTS,
  TUBE_X,
} from "./flickerroom-sim";
import { flickerroomMeta } from "./flickerroom.meta";

const TAU = Math.PI * 2;
/** Seconds a tint change eases over, and each half of a variation change's fade through black. */
const TINT_EASE = 1.5;
const SEED_FADE = 0.7;
/** The door's swing per state (radians): shut, ajar, further ajar. */
const DOOR_ANGLES = [0, 0.45, 0.9] as const;
/**
 * The corridor's figure per state: its scale (how far down the corridor it
 * stands; 1 would be in the doorway), or 0 for none.
 */
const FIGURE_SCALES = [0, 0.27, 0.5] as const;
/** Pixels of slack round a changed thing's box when it's redrawn. */
const BOX_PAD = 3;

/**
 * The room, drawn with four samples per pixel: once per resize or variation,
 * and after that only inside the box of whatever just changed. Pass 0 writes
 * the surfaces' colour (albedo); pass 1 how much of each ceiling tube's light
 * reaches them (RGB, tubes 0-2) and how much of the corridor's and exit sign's
 * own light (A).
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uK;
uniform int uPass;
uniform float uSeed;
/** The shifted chair (0/1), the lone chair turned (0/1), the door's swing (radians), the coat (0/1). */
uniform vec4 uA;
/** The magazine fallen (0/1), the paper fallen (0/1), the figure's scale (0 none). */
uniform vec3 uB;
/** The clock's hands: hour, minute, second, clockwise from twelve in radians. */
uniform vec3 uHands;
out vec4 outColor;
${SDF2D_GLSL}
${OVER_GLSL}
${HASH32_GLSL}
${CLOCK_MARKS_GLSL}
${CLOCK_HANDS_GLSL}
${POOL_GLSL}

const float FLOOR_Y = ${F(FLOOR_Y)};
/** Eye level: where the floor's and ceiling's lines converge. */
const float HORIZON = 0.16;
const float CEIL_Y = 0.6;
const float DADO = 0.02;
/** How far the wall is, in floor tiles' units, for the floor's and ceiling's perspective. */
const float DEPTH = 2.4;
const vec3 TRIM = vec3(0.6, 0.6, 0.54);
const vec3 METAL = vec3(0.5, 0.51, 0.5);

vec3 col;
/** How much of the tubes' light the surface gets, and how much of the corridor's own light. */
float recv;
float selfL;
/** A tube's own diffuser (on a ceiling seen in tall frames): coverage and which tube. */
float emitA;
float emitTube;
uint seedU;

float rand(vec2 cell, uint salt) {
  uvec2 u = uvec2(ivec2(floor(cell)) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ salt ^ seedU))) / 4294967296.0;
}
float vnoise(vec2 p, uint salt) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = rand(i, salt);
  float b = rand(i + vec2(1.0, 0.0), salt);
  float c = rand(i + vec2(0.0, 1.0), salt);
  float d = rand(i + vec2(1.0, 1.0), salt);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

/** Paints colour c at coverage a, lit by the tubes. */
void lay(vec3 c, float a) {
  col = mix(col, c, a);
  recv = mix(recv, 1.0, a);
  selfL *= 1.0 - a;
  emitA *= 1.0 - a;
}
/** As lay, with how much tube light (r) and corridor light (s) the surface gets. */
void layLit(vec3 c, float a, float r, float s) {
  col = mix(col, c, a);
  recv = mix(recv, r, a);
  selfL = mix(selfL, s, a);
  emitA *= 1.0 - a;
}
/** Darkens what's there by a soft shadow of a shape at distance d. */
void shade(float d, float k, float soft) {
  col *= 1.0 - k * (1.0 - smoothstep(-soft * 0.3, soft, d));
}
/** A tapering stroke from a (width w0) to b (width w1). */
float stroke(vec2 p, vec2 a, vec2 b, float w0, float w1) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(w0, w1, h);
}

// --- Wall, floor and ceiling ---

/** Seams of a grid of unit cells at t, anti-aliased by its footprint fw per pixel: 1 on a seam. */
float seams(vec2 t, vec2 fw) {
  vec2 g = abs(fract(t) - 0.5);
  vec2 s = smoothstep(0.5 - 1.5 * fw, vec2(0.5), g);
  return max(s.x, s.y);
}

void lino(vec2 p) {
  // Out from the wall the floor comes nearer: r is 1 at the wall, smaller nearer.
  float r = (HORIZON - FLOOR_Y) / (HORIZON - p.y);
  float drdy = r / (HORIZON - p.y);
  vec2 w = vec2(p.x * r, (1.0 - r) * DEPTH);
  vec2 t = w / 0.2;
  vec2 fw = vec2(abs(r) + abs(p.x * drdy), DEPTH * drdy) * px / 0.2;
  vec2 cell = floor(t);
  float checker = mod(cell.x + cell.y, 2.0);
  col = mix(vec3(0.47, 0.48, 0.42), vec3(0.4, 0.43, 0.37), checker);
  col *= 0.93 + 0.1 * vnoise(w * 24.0, 17u) + 0.04 * (rand(cell, 23u) - 0.5);
  // Scuffs and worn paths, most in front of the chairs.
  float scuff = vnoise(w * vec2(10.0, 30.0), 19u);
  col *= 1.0 - 0.14 * smoothstep(0.62, 0.9, scuff) * (1.0 - smoothstep(0.0, 0.6, abs(p.x + 0.1)));
  col *= 1.0 - 0.2 * seams(t, fw);
  // Where the floor meets the wall.
  col *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.03, FLOOR_Y - p.y));
}

void ceiling(vec2 p) {
  float r = (CEIL_Y - HORIZON) / (p.y - HORIZON);
  float drdy = r / (p.y - HORIZON);
  vec2 w = vec2(p.x * r, (1.0 - r) * DEPTH);
  vec2 t = w / 0.3;
  vec2 fw = vec2(abs(r) + abs(p.x * drdy), DEPTH * drdy) * px / 0.3;
  col = vec3(0.6, 0.6, 0.56) * (0.95 + 0.06 * vnoise(w * 20.0, 29u));
  col *= 1.0 - 0.25 * seams(t, fw);
  col *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.02, p.y - CEIL_Y));
  // The tubes' fittings, near the camera: only tall frames see this far up.
  for (int i = 0; i < 3; i++) {
    float tx = i == 0 ? ${F(TUBE_X[0])} : i == 1 ? ${F(TUBE_X[1])} : ${F(TUBE_X[2])};
    vec2 c = vec2(tx * 0.55, 0.45 * DEPTH);
    float d = sdBox(w - c, vec2(0.075, 0.05), 0.004);
    float k = length(vec2(abs(r) + abs(p.x * drdy), DEPTH * drdy)) * px;
    float a = clamp(0.5 - d / k, 0.0, 1.0);
    lay(METAL * 0.9, a);
    float g = clamp(0.5 - (d + 0.01) / k, 0.0, 1.0);
    col = mix(col, vec3(0.75), g);
    emitA = max(emitA, g);
    emitTube = g > 0.0 ? float(i) : emitTube;
  }
}

void wall(vec2 p) {
  col = p.y > DADO ? vec3(0.62, 0.64, 0.55) : vec3(0.38, 0.47, 0.4);
  float n = 0.6 * vnoise(p * 9.0, 3u) + 0.4 * vnoise(p * 27.0, 5u);
  col *= 0.94 + 0.09 * n;
  // A water stain or two, high up.
  float stain = vnoise(p * vec2(4.0, 2.5) + 7.0, 11u);
  col *= 1.0 - 0.1 * smoothstep(0.62, 0.8, stain) * smoothstep(0.25, 0.55, p.y);
  // Scuffs along the lower wall, where chair backs have rubbed.
  float scuff = vnoise(p * vec2(30.0, 160.0), 13u);
  col *= 1.0 - 0.12 * smoothstep(0.7, 0.92, scuff) * step(p.y, DADO) * step(-0.06, p.y);
  // The dado rail and its shadow.
  shade(DADO - p.y, 0.22, 0.012);
  lay(vec3(0.44, 0.5, 0.42), cover(abs(p.y - DADO - 0.007) - 0.007));
  // The skirting board.
  lay(vec3(0.24, 0.27, 0.24), cover(p.y - FLOOR_Y - 0.02));
  // The cornice under the ceiling.
  lay(TRIM * 0.95, cover(abs(p.y - CEIL_Y + 0.007) - 0.007));
}

// --- Things on the wall ---

const vec2 BOARD_C = vec2(-0.34, 0.19);
const vec2 BOARD_H = vec2(0.09, 0.095);
/** The paper that falls, and where it lands. */
const int FALLEN = 4;
const vec2 FLOOR_PAPER = vec2(-0.335, -0.255);

vec4 paperAt(int i) {
  vec2 c = i == 0 ? vec2(-0.392, 0.235) : i == 1 ? vec2(-0.343, 0.24) : i == 2 ? vec2(-0.288, 0.228) : i == 3 ? vec2(-0.378, 0.15) : vec2(-0.305, 0.148);
  vec2 h = i == 0 ? vec2(0.022, 0.03) : i == 1 ? vec2(0.018, 0.024) : i == 2 ? vec2(0.022, 0.03) : i == 3 ? vec2(0.026, 0.02) : vec2(0.02, 0.028);
  c += (vec2(rand(vec2(float(i), 1.0), 31u), rand(vec2(float(i), 2.0), 31u)) - 0.5) * 0.01;
  return vec4(c, h);
}

void noticeboard(vec2 p) {
  vec2 q = p - BOARD_C;
  if (abs(q.x) > BOARD_H.x + 0.03 || abs(q.y) > BOARD_H.y + 0.03) {
    return;
  }
  shade(sdBox(q - vec2(0.004, -0.007), BOARD_H, 0.003), 0.35, 0.014);
  lay(vec3(0.42, 0.32, 0.22), cover(sdBox(q, BOARD_H, 0.003)));
  vec3 cork = vec3(0.56, 0.41, 0.27) * (0.86 + 0.22 * rand(p * 700.0, 37u));
  lay(cork, cover(sdBox(q, BOARD_H - 0.008, 0.0)));
  for (int i = 0; i < 5; i++) {
    vec4 pp = paperAt(i);
    float ang = (rand(vec2(float(i), 3.0), 31u) - 0.5) * 0.14;
    if (i != FALLEN || uB.y < 0.5) {
      vec2 pq = rot(ang) * (p - pp.xy);
      shade(sdBox(rot(ang) * (p - pp.xy - vec2(0.003, -0.004)), pp.zw, 0.0005), 0.3, 0.006);
      vec3 paper = vec3(0.72, 0.71, 0.66) * (0.93 + 0.07 * smoothstep(-pp.w, pp.w, pq.y));
      lay(paper, cover(sdBox(pq, pp.zw, 0.0005)));
    }
    // The pin, near the paper's top; it stays when the paper goes.
    vec2 pin = pp.xy + vec2(0.0, pp.w - 0.007);
    shade(length(p - pin - vec2(0.002, -0.003)) - 0.0035, 0.35, 0.003);
    float hue = rand(vec2(float(i), 4.0), 31u);
    vec3 pc = hue < 0.33 ? vec3(0.62, 0.16, 0.13) : hue < 0.66 ? vec3(0.2, 0.32, 0.55) : vec3(0.65, 0.58, 0.2);
    lay(pc, cover(length(p - pin) - 0.0035));
  }
}

const vec2 CLOCK_C = vec2(-0.6, 0.42);
const float CLOCK_R = 0.048;

void wallClock(vec2 p) {
  vec2 q = p - CLOCK_C;
  if (dot(q, q) > 0.0049) {
    return;
  }
  shade(length(q - vec2(0.004, -0.007)) - CLOCK_R * 1.08, 0.35, 0.012);
  lay(vec3(0.17, 0.18, 0.18), cover(length(q) - CLOCK_R * 1.08));
  float face = length(q) - CLOCK_R * 0.95;
  lay(vec3(0.72, 0.71, 0.66), cover(face));
  float R = CLOCK_R * 0.95;
  lay(vec3(0.12), cover(clockMarks(q, R, 0.88, vec4(0.12, 0.025, 0.05, 0.01))));
  vec4 h = clockHandsAt(q, uHands, R, vec3(0.1), vec3(0.6, 0.12, 0.1), false);
  col = h.rgb + col * (1.0 - h.a);
  // The glass's dull sheen.
  col += 0.04 * smoothstep(0.0, R, dot(q, vec2(-0.6, 0.8)) + 0.3 * R) * step(face, 0.0);
}

/** The door on the left: its centre x, half width, bottom and top. */
const vec4 LDOOR = vec4(-0.6, 0.095, FLOOR_Y, 0.29);

void leftDoor(vec2 p) {
  if (abs(p.x - LDOOR.x) > 0.14 || p.y > LDOOR.w + 0.04 || p.y < FLOOR_Y - 0.01) {
    return;
  }
  float mid = 0.5 * (LDOOR.z + LDOOR.w);
  float hh = 0.5 * (LDOOR.w - LDOOR.z);
  vec2 q = p - vec2(LDOOR.x, mid);
  // The architrave and its shadow.
  shade(sdBox(q - vec2(0.004, -0.008), vec2(LDOOR.y + 0.014, hh + 0.007), 0.001), 0.3, 0.014);
  lay(TRIM, cover(sdBox(q - vec2(0.0, 0.007), vec2(LDOOR.y + 0.014, hh + 0.007), 0.001)));
  // The dark room beyond.
  float open = sdBox(q, vec2(LDOOR.y, hh), 0.0);
  layLit(vec3(0.03, 0.033, 0.033), cover(open), 0.05, 0.0);
  // The leaf, hinged on the left, swung away into the dark.
  float th = uA.z;
  float x0 = LDOOR.x - LDOOR.y;
  float wr = 2.0 * LDOOR.y * cos(th);
  float f = clamp((p.x - x0) / wr, 0.0, 1.0);
  float shrink = 1.0 - 0.2 * sin(th) * f;
  float yb = HORIZON + (LDOOR.z - HORIZON) * shrink;
  float yt = HORIZON + (LDOOR.w - HORIZON) * shrink;
  float d = max(max(x0 - p.x, p.x - x0 - wr), max(yb - p.y, p.y - yt));
  vec2 u = vec2(f, (p.y - yb) / (yt - yb));
  vec2 su = vec2(wr, yt - yb);
  float grain = vnoise(vec2(u.x * 40.0, u.y * 3.0), 41u);
  vec3 leaf = vec3(0.5, 0.39, 0.27) * (0.92 + 0.12 * grain) * (1.0 - 0.4 * sin(th));
  // Kick plate, a blank plate at eye height and the lever handle.
  leaf = mix(leaf, METAL * (1.0 - 0.3 * sin(th)), cover((u.y - 0.11) * su.y) * cover((abs(u.x - 0.5) - 0.46) * su.x));
  float plate = max(abs(u.x - 0.5) * su.x - 0.024, abs(u.y - 0.74) * su.y - 0.012);
  leaf = mix(leaf, vec3(0.7, 0.69, 0.64) * (1.0 - 0.35 * sin(th)), cover(plate));
  vec2 hq = vec2((u.x - 0.88) * su.x, (u.y - 0.47) * su.y);
  float handle = min(sdBox(hq - vec2(-0.008, 0.0), vec2(0.016, 0.003), 0.002), length(hq) - 0.0045);
  leaf = mix(leaf, METAL * 1.2, cover(handle));
  lay(leaf, cover(d));
}

/** The coat hooks' rail: centre and half size. */
const vec2 HOOKS_C = vec2(0.37, 0.2);

void coatHooks(vec2 p) {
  if (abs(p.x - HOOKS_C.x) > 0.1 || p.y > 0.24 || p.y < -0.09) {
    return;
  }
  vec2 q = p - HOOKS_C;
  if (uA.w > 0.5) {
    // A dark coat on the middle hook, its shadow on the wall.
    vec2 c = q - vec2(0.0, -0.01);
    float flare = 0.034 + 0.012 * clamp(-c.y / 0.22, 0.0, 1.0);
    float body = max(abs(c.x) - flare, max(c.y + 0.03, -0.25 - c.y));
    float shoulders = sdBox(c - vec2(0.0, -0.035), vec2(0.036, 0.02), 0.018);
    float collar = sdBox(c - vec2(0.0, -0.006), vec2(0.011, 0.012), 0.004);
    float coat = min(min(body, shoulders), collar);
    vec2 sc = c - vec2(0.006, -0.012);
    float sb = max(abs(sc.x) - flare, max(sc.y + 0.03, -0.25 - sc.y));
    shade(min(sb, sdBox(sc - vec2(0.0, -0.035), vec2(0.036, 0.02), 0.018)), 0.4, 0.018);
    float hue = rand(vec2(9.0, 9.0), 43u);
    vec3 cloth = hue < 0.4 ? vec3(0.17, 0.19, 0.25) : hue < 0.75 ? vec3(0.3, 0.22, 0.15) : vec3(0.24, 0.26, 0.18);
    // Folds, the front opening and the sleeves' edges.
    cloth *= 0.88 + 0.12 * sin(c.x * 160.0 + 2.0 * sin(c.y * 30.0));
    cloth *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.003, abs(c.x - 0.004))) * step(c.y, -0.04);
    cloth *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.004, abs(abs(c.x) - 0.026))) * step(c.y, -0.05) * step(-0.17, c.y);
    lay(cloth, cover(coat));
  }
  shade(sdBox(q - vec2(0.003, -0.006), vec2(0.09, 0.009), 0.002), 0.3, 0.01);
  lay(vec3(0.45, 0.33, 0.22), cover(sdBox(q, vec2(0.09, 0.009), 0.002)));
  for (int i = 0; i < 3; i++) {
    vec2 h = q - vec2(-0.06 + 0.06 * float(i), 0.0);
    if (i == 1 && uA.w > 0.5) {
      continue;
    }
    float hook = min(stroke(h, vec2(0.0, 0.002), vec2(0.0, -0.016), 0.0028, 0.0028), length(h - vec2(0.0, -0.017)) - 0.004);
    shade(stroke(h - vec2(0.002, -0.004), vec2(0.0, 0.002), vec2(0.0, -0.016), 0.0028, 0.0028), 0.3, 0.005);
    lay(METAL * 1.1, cover(hook));
  }
}

// --- The doorway and the corridor beyond ---

/** The doorway on the right: centre x, half width, bottom and top. */
const vec4 RDOOR = vec4(0.65, 0.12, FLOOR_Y, 0.31);
/** Where the corridor's lines meet, and the far end's scale (1 is the doorway). */
const vec2 VP = vec2(0.65, 0.11);
const float S_END = 0.24;

float figureSdf(vec2 w) {
  float head = length((w - vec2(0.0, 0.272)) * vec2(1.0, 0.85)) - 0.026;
  float neck = sdBox(w - vec2(0.0, 0.24), vec2(0.011, 0.014), 0.004);
  float shoulders = sdBox(w - vec2(0.0, 0.212), vec2(0.047, 0.016), 0.014);
  float torso = sdBox(w - vec2(0.0, 0.145), vec2(0.04, 0.07), 0.01);
  float arms = min(sdBox(w - vec2(-0.05, 0.13), vec2(0.011, 0.078), 0.008), sdBox(w - vec2(0.05, 0.128), vec2(0.011, 0.08), 0.008));
  float legs = min(sdBox(w - vec2(-0.017, 0.045), vec2(0.014, 0.05), 0.004), sdBox(w - vec2(0.017, 0.045), vec2(0.014, 0.05), 0.004));
  return min(min(min(head, neck), min(shoulders, torso)), min(arms, legs));
}

void corridor(vec2 p) {
  if (abs(p.x - RDOOR.x) > 0.17 || p.y > 0.42 || p.y < FLOOR_Y - 0.01) {
    return;
  }
  float mid = 0.5 * (RDOOR.z + RDOOR.w);
  float hh = 0.5 * (RDOOR.w - RDOOR.z);
  vec2 dq = p - vec2(RDOOR.x, mid);
  shade(sdBox(dq - vec2(0.004, -0.008), vec2(RDOOR.y + 0.015, hh + 0.008), 0.001), 0.3, 0.014);
  lay(TRIM, cover(sdBox(dq - vec2(0.0, 0.008), vec2(RDOOR.y + 0.015, hh + 0.008), 0.001)));
  float a = cover(sdBox(dq, vec2(RDOOR.y, hh), 0.0));
  if (a > 0.0) {
    vec2 q = p - VP;
    float sx = abs(q.x) / RDOOR.y;
    float sy = q.y < 0.0 ? q.y / (FLOOR_Y - VP.y) : q.y / (RDOOR.w - VP.y);
    float s = max(max(sx, sy), S_END);
    float dist = 1.0 / s;
    // World height on the corridor's walls, and across on its floor and ceiling.
    vec2 w = q / s + VP;
    vec3 c;
    if (s <= S_END) {
      // The far end: a shut door in a pale wall.
      c = vec3(0.5, 0.52, 0.47);
      float fd = max(abs(w.x - RDOOR.x + 0.01) - 0.05, w.y - 0.2);
      c = mix(c, vec3(0.3, 0.24, 0.18), cover(fd * S_END));
    } else if (sx > sy) {
      c = w.y > DADO ? vec3(0.52, 0.54, 0.47) : vec3(0.36, 0.44, 0.38);
      c *= w.y < FLOOR_Y + 0.02 ? 0.55 : 1.0;
      // A door along the right-hand wall.
      float side = step(0.0, q.x) * step(1.6, dist) * step(dist, 2.1) * step(w.y, 0.22);
      c = mix(c, vec3(0.3, 0.24, 0.18), side);
    } else if (q.y < 0.0) {
      c = vec3(0.36, 0.38, 0.33) * (1.0 - 0.25 * smoothstep(0.42, 0.5, abs(fract(dist * 2.5) - 0.5)));
    } else {
      c = vec3(0.5, 0.5, 0.47);
      // The corridor's own light panel, half way down.
      float panel = step(abs(w.x - RDOOR.x), 0.04) * step(2.0, dist) * step(dist, 2.35);
      c = mix(c, vec3(0.75), panel);
    }
    // Lit by a panel half way down and a little at the far end; near the doorway the room's light spills in.
    float g = (dist - 2.2) / 0.9;
    float light = 0.12 + 0.75 * exp(-g * g) + (s <= S_END ? 0.25 : 0.0);
    float spill = 0.6 * smoothstep(0.55, 1.0, s);
    layLit(c, a, spill, light);
    if (uB.z > 0.0) {
      float sf = uB.z;
      vec2 base = VP + vec2(-0.03, FLOOR_Y - VP.y) * sf;
      float fd = figureSdf((p - base) / sf) * sf;
      // A soft edge: a shape, not a cut-out.
      float fa = clamp(0.5 - fd / (2.0 * px), 0.0, 1.0) * a;
      layLit(vec3(0.015, 0.015, 0.018), fa, 0.0, 0.03);
    }
  }
  // The exit sign over the doorway.
  vec2 e = p - vec2(RDOOR.x, 0.37);
  shade(sdBox(e - vec2(0.003, -0.006), vec2(0.034, 0.014), 0.002), 0.3, 0.01);
  lay(vec3(0.7, 0.7, 0.66), cover(sdBox(e, vec2(0.034, 0.014), 0.002)));
  float face = sdBox(e, vec2(0.029, 0.009), 0.001);
  vec3 green = vec3(0.22, 0.7, 0.36);
  float glyph = max(abs(e.y) - 0.0025, abs(abs(e.x) - 0.012) - 0.009);
  layLit(mix(green, vec3(0.72), 0.85 * cover(glyph)), cover(face), 0.3, 1.0);
}

// --- Things standing on the floor ---

/** A moulded chair seen from the front, its feet at the origin. */
void chairFront(vec2 q, float k, vec3 shell) {
  vec2 back = q - vec2(0.0, 0.15);
  // Back legs, then front legs, the seat and the back.
  for (int s = -1; s <= 1; s += 2) {
    float fs = float(s);
    lay(METAL * 0.6, cover(stroke(q, vec2(0.04 * fs, 0.012), vec2(0.04 * fs, 0.076), 0.0022, 0.0022) * k));
  }
  for (int s = -1; s <= 1; s += 2) {
    float fs = float(s);
    lay(METAL, cover(stroke(q, vec2(0.046 * fs, 0.0), vec2(0.044 * fs, 0.075), 0.0026, 0.0026) * k));
  }
  lay(shell * 0.62, cover(sdBox(q - vec2(0.0, 0.074), vec2(0.052, 0.006), 0.004) * k));
  lay(shell * (0.95 + 0.06 * smoothstep(0.075, 0.1, q.y)), cover(sdBox(q - vec2(0.0, 0.087), vec2(0.05, 0.011), 0.006) * k));
  lay(METAL * 0.8, cover(sdBox(q - vec2(0.0, 0.103), vec2(0.008, 0.012), 0.002) * k));
  float b = sdBox(back, vec2(0.048, 0.044), 0.016);
  vec3 bc = shell * (1.02 - 0.12 * smoothstep(-0.02, 0.04, length(back * vec2(1.0, 1.4))));
  lay(bc, cover(b * k));
}

/** The same chair side-on, facing right, its feet at the origin. */
void chairSide(vec2 q, float k, vec3 shell) {
  lay(METAL * 0.6, cover(stroke(q, vec2(0.034, 0.008), vec2(0.03, 0.076), 0.0022, 0.0022) * k));
  lay(METAL * 0.6, cover(stroke(q, vec2(-0.044, 0.008), vec2(-0.036, 0.076), 0.0022, 0.0022) * k));
  lay(METAL, cover(stroke(q, vec2(0.042, 0.0), vec2(0.036, 0.076), 0.0026, 0.0026) * k));
  lay(METAL, cover(stroke(q, vec2(-0.05, 0.0), vec2(-0.04, 0.076), 0.0026, 0.0026) * k));
  // The seat, its top just seen from above, and the back rising from its rear edge.
  float seat = stroke(q, vec2(-0.046, 0.082), vec2(0.046, 0.084), 0.008, 0.007);
  lay(shell * (0.8 + 0.2 * smoothstep(0.076, 0.09, q.y)), cover(seat * k));
  float back = stroke(q, vec2(-0.046, 0.09), vec2(-0.062, 0.2), 0.007, 0.009);
  lay(shell * 0.86, cover(back * k));
  lay(METAL * 0.8, cover(stroke(q, vec2(-0.044, 0.08), vec2(-0.05, 0.11), 0.002, 0.002) * k));
}

vec3 shellColour() {
  float h = rand(vec2(3.0, 7.0), 47u);
  return h < 0.4 ? vec3(0.26, 0.4, 0.42) : h < 0.75 ? vec3(0.58, 0.36, 0.2) : vec3(0.4, 0.42, 0.44);
}

/** The row of chairs along the wall; the left-hand one may be pulled out and askew. */
void chairRow(vec2 p) {
  if (p.x < -0.55 || p.x > 0.24 || p.y > 0.12 || p.y < -0.29) {
    return;
  }
  vec3 shell = shellColour();
  float feet = FLOOR_Y - 0.035;
  for (int i = 0; i < 5; i++) {
    float x = -0.4 + 0.14 * float(i);
    vec2 base = vec2(x, feet);
    float ang = 0.0;
    float sc = 1.0;
    if (i == 0 && uA.x > 0.5) {
      base = vec2(-0.425, -0.205);
      ang = -0.1;
      sc = 1.07;
    }
    vec2 q = rot(ang) * (p - base) / sc;
    if (abs(q.x) > 0.11 || q.y > 0.24 || q.y < -0.05) {
      continue;
    }
    // Its shadow on the wall (when against it) and on the floor.
    if (sc == 1.0) {
      shade(sdBox(q - vec2(0.006, 0.137), vec2(0.048, 0.044), 0.016), 0.3, 0.02);
    }
    shade(length((q - vec2(0.004, 0.002)) * vec2(1.0, 4.0)) - 0.05, 0.4, 0.02);
    chairFront(q, sc, shell);
  }
}

/** The lone chair in front of the coat hooks: side-on, facing the doorway, or turned to face out. */
void loneChair(vec2 p) {
  vec2 base = vec2(0.38, -0.33);
  float k = 1.25;
  vec2 q = (p - base) / k;
  if (abs(q.x) > 0.09 || q.y > 0.25 || q.y < -0.04) {
    return;
  }
  shade(length((q - vec2(0.006, 0.0)) * vec2(1.0, 4.0)) - 0.058, 0.4, 0.02);
  if (uA.y > 0.5) {
    chairFront(q, k, shellColour());
  } else {
    chairSide(q, k, shellColour());
  }
}

void plant(vec2 p) {
  vec2 b = vec2(-0.81, -0.12);
  if (p.x < -1.07 || p.x > -0.55 || p.y > 0.2 || p.y < -0.25) {
    return;
  }
  // Shadows on the floor and wall, then the pot.
  shade(length((p - vec2(-0.8, -0.205)) * vec2(1.0, 3.5)) - 0.055, 0.4, 0.02);
  shade(length((p - vec2(-0.795, -0.02)) * vec2(1.0, 0.7)) - 0.1, 0.18, 0.06);
  float t = clamp((p.y + 0.2) / 0.08, 0.0, 1.0);
  float pot = max(abs(p.x - b.x) - mix(0.04, 0.052, t), max(-0.2 - p.y, p.y + 0.12));
  vec3 terra = vec3(0.48, 0.32, 0.23) * (0.85 + 0.15 * smoothstep(-0.05, 0.05, b.x - p.x + 0.02));
  lay(terra, cover(pot));
  lay(terra * 1.08, cover(sdBox(p - vec2(b.x, -0.126), vec2(0.056, 0.008), 0.002)));
  // Leaves: long blades fanning out from the soil, some browning, some drooping over the rim.
  for (int i = 0; i < 11; i++) {
    float fi = float(i);
    float ang = mix(-1.25, 1.25, (fi + rand(vec2(fi, 1.0), 53u)) / 11.0);
    float len = 0.11 + 0.13 * rand(vec2(fi, 2.0), 53u) * (1.0 - 0.4 * abs(ang));
    float droop = rand(vec2(fi, 3.0), 53u);
    vec2 dir = vec2(sin(ang), cos(ang));
    vec2 a0 = b + vec2(0.01 * sin(ang), 0.004);
    vec2 m = a0 + dir * len * 0.55;
    vec2 tip = m + (dir * 0.45 + vec2(0.35 * sign(dir.x) * droop, -1.2 * droop * droop)) * len;
    float w = 0.009 + 0.006 * rand(vec2(fi, 4.0), 53u);
    float d = min(stroke(p, a0, m, 0.004, w), stroke(p, m, tip, w, 0.0005));
    float brown = step(rand(vec2(fi, 5.0), 53u), 0.35);
    vec3 green = mix(vec3(0.24, 0.34, 0.19), vec3(0.46, 0.39, 0.2), brown);
    green *= 0.85 + 0.25 * rand(vec2(fi, 6.0), 53u);
    shade(d + 0.004, 0.25, 0.006);
    lay(green, cover(d));
  }
  // A dead leaf on the floor.
  vec2 fl = rot(0.5) * (p - vec2(-0.725, -0.235));
  lay(vec3(0.42, 0.33, 0.18), cover((length(fl * vec2(1.0, 3.2)) - 0.018) * 0.6));
}

void lightSwitch(vec2 p) {
  vec2 q = p - vec2(0.83, 0.07);
  if (abs(q.x) > 0.03 || abs(q.y) > 0.04) {
    return;
  }
  shade(sdBox(q - vec2(0.002, -0.004), vec2(0.013, 0.019), 0.002), 0.3, 0.006);
  lay(vec3(0.7, 0.69, 0.64), cover(sdBox(q, vec2(0.013, 0.019), 0.002)));
  lay(vec3(0.62, 0.61, 0.56), cover(sdBox(q - vec2(0.0, 0.003), vec2(0.005, 0.009), 0.001)));
}

void floorPaper(vec2 p) {
  vec2 q = p - FLOOR_PAPER;
  if (uB.y < 0.5 || abs(q.x) > 0.05 || abs(q.y) > 0.04) {
    return;
  }
  // Lying flat, so foreshortened.
  vec2 fq = rot(0.45) * vec2(q.x, q.y / 0.55);
  float d = sdBox(fq, paperAt(FALLEN).zw, 0.0005) * 0.55;
  shade(d + 0.001, 0.25, 0.004);
  lay(vec3(0.7, 0.69, 0.64), cover(d));
}

vec3 magColour(float i) {
  float h = rand(vec2(i, 8.0), 59u);
  return h < 0.25 ? vec3(0.62, 0.25, 0.22) : h < 0.5 ? vec3(0.25, 0.38, 0.58) : h < 0.75 ? vec3(0.66, 0.58, 0.32) : vec3(0.7, 0.68, 0.62);
}

/** A magazine lying flat at c, its half size h (before foreshortening), turned by ang. */
void magazine(vec2 p, vec2 c, vec2 h, float ang, float squash, vec3 cover0, float k) {
  vec2 q = rot(ang) * vec2(p.x - c.x, (p.y - c.y) / squash);
  float d = sdBox(q, h, 0.001) * squash;
  shade(d - 0.001, 0.3 * k, 0.004);
  vec3 c0 = mix(cover0, vec3(0.72, 0.71, 0.66), 0.55 * smoothstep(0.3, 0.32, abs(q.y / h.y - 0.1)) * step(0.0, q.y));
  lay(c0, cover(d));
}

/** The low table in front of the chairs, its pile of magazines, and one on the floor. */
void table(vec2 p) {
  if (p.x < -0.8 || p.x > -0.38 || p.y > -0.19 || p.y < -0.47) {
    return;
  }
  vec2 c = vec2(-0.51, -0.23);
  shade(sdBox(p - vec2(-0.505, -0.305), vec2(0.115, 0.016), 0.012), 0.4, 0.025);
  vec3 wood = vec3(0.46, 0.34, 0.23);
  for (int s = -1; s <= 1; s += 2) {
    float fs = float(s);
    lay(wood * 0.55, cover(sdBox(p - vec2(c.x + 0.094 * fs, -0.265), vec2(0.005, 0.02), 0.001)));
    lay(wood * 0.7, cover(sdBox(p - vec2(c.x + 0.102 * fs, -0.285), vec2(0.006, 0.03), 0.001)));
  }
  lay(wood * 0.7, cover(sdBox(p - vec2(c.x, -0.25), vec2(0.11, 0.006), 0.001)));
  vec3 top = wood * (0.95 + 0.08 * vnoise(vec2(p.x * 60.0, p.y * 6.0), 61u));
  lay(top, cover(sdBox(p - c, vec2(0.108, 0.015), 0.002)));
  int n = uB.x > 0.5 ? 2 : 3;
  for (int i = 0; i < 3; i++) {
    if (i >= n) {
      break;
    }
    float fi = float(i);
    vec2 mc = vec2(-0.535 + 0.012 * (rand(vec2(fi, 9.0), 59u) - 0.5), -0.229 + 0.003 * fi);
    float ang = (rand(vec2(fi, 10.0), 59u) - 0.5) * 0.5;
    magazine(p, mc, vec2(0.032, 0.022), ang, 0.32, magColour(fi), 0.6);
  }
  if (uB.x > 0.5) {
    magazine(p, vec2(-0.71, -0.4), vec2(0.034, 0.024), 0.35, 0.5, magColour(2.0), 1.0);
  }
}

void room(vec2 p) {
  recv = 1.0;
  selfL = 0.0;
  emitA = 0.0;
  emitTube = 0.0;
  if (p.y < FLOOR_Y) {
    lino(p);
  } else if (p.y > CEIL_Y) {
    ceiling(p);
  } else {
    wall(p);
  }
  noticeboard(p);
  wallClock(p);
  leftDoor(p);
  coatHooks(p);
  corridor(p);
  lightSwitch(p);
  chairRow(p);
  plant(p);
  floorPaper(p);
  table(p);
  loneChair(p);
}

void main() {
  px = 1.0 / (uRes.y * uK);
  seedU = hash32(uint(uSeed) + 0x51edu);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    vec2 p = (gl_FragCoord.xy + o - 0.5 * uRes) / (uRes.y * uK);
    room(p);
    if (uPass == 0) {
      sum += vec4(col, 1.0);
    } else {
      vec3 pools = vec3(tubePool(${F(TUBE_X[0])}, p), tubePool(${F(TUBE_X[1])}, p), tubePool(${F(TUBE_X[2])}, p)) * recv;
      vec3 own = vec3(emitTube == 0.0 ? 1.0 : 0.0, emitTube == 1.0 ? 1.0 : 0.0, emitTube == 2.0 ? 1.0 : 0.0);
      sum += vec4(mix(pools, own, emitA), selfL);
    }
  }
  outColor = sum * 0.25;
}
`;

/** Every frame: the cached room, lit by the tubes as they are now. */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uAlbedo;
uniform sampler2D uMask;
uniform vec3 uAmbient;
uniform vec3 uTube;
/** Each tube's light now: the failing one's flicker times its strength, then the others. */
uniform vec3 uLevels;
uniform float uSelf;
/** 1, or less while fading through black for a new variation. */
uniform float uFade;
out vec4 outColor;
${DITHER_GLSL}
const vec3 SELF_LIGHT = vec3(0.78, 0.8, 0.72);
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec3 albedo = texelFetch(uAlbedo, t, 0).rgb;
  vec4 m = texelFetch(uMask, t, 0);
  vec3 light = uAmbient + uTube * dot(uLevels, m.rgb) + SELF_LIGHT * (uSelf * m.a);
  outColor = vec4(albedo * light * uFade + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * An empty waiting room under three ceiling tubes, one of them failing. Every
 * so often it stutters nearly off and back, and at its darkest one small thing
 * in the room changes; between flickers nothing moves.
 *
 * The room's colours and how much of each tube's light reaches each pixel are
 * drawn once per resize or variation into two cached targets, and after a
 * change only inside that thing's box, so the rest of the frame stays
 * pixel-identical. Each frame is then one pass: two texel fetches, the tubes'
 * light and a dither.
 */
export const flickerroom = defineEffect(flickerroomMeta, {
  create(gl) {
    return withScope((scope) => {
      const roomProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const compositeProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ru = createUniforms(gl, roomProgram, [
        "uRes",
        "uK",
        "uPass",
        "uSeed",
        "uA",
        "uB",
        "uHands",
      ]);
      const cu = createUniforms(gl, compositeProgram, [
        "uAlbedo",
        "uMask",
        "uAmbient",
        "uTube",
        "uLevels",
        "uSelf",
        "uFade",
      ]);
      gl.useProgram(compositeProgram);
      cu.i1("uAlbedo", 0);
      cu.i1("uMask", 1);
      gl.useProgram(null);

      let albedoTarget: RenderTarget | null = null;
      let maskTarget: RenderTarget | null = null;
      scope.defer(() => {
        albedoTarget?.dispose();
        maskTarget?.dispose();
      });
      let width = 1;
      let height = 1;
      let k = 1;
      let room: FlickerRoom | null = null;
      /** The whole room needs drawing; or, bits of the things whose boxes do. */
      let redrawAll = true;
      let redrawThings = 0;
      const tintEase = createColorEase(TINT_FLOATS);
      const seedFade = createFadeThrough(SEED_FADE);

      /** Draws the room (both passes) into the targets, in a scissor round each changed box. */
      const drawRoom = (r: FlickerRoom, things: number) => {
        if (!albedoTarget || !maskTarget) {
          return;
        }
        const s = r.state;
        const minutes = clockMinutes(r);
        gl.useProgram(roomProgram);
        ru.f2("uRes", width, height);
        ru.f1("uK", k);
        ru.f1("uSeed", r.seed);
        ru.f4("uA", s[THING_SHIFT], s[THING_TURN], DOOR_ANGLES[s[THING_DOOR]] ?? 0, s[THING_COAT]);
        ru.f3("uB", s[THING_MAGAZINE], s[THING_PAPER], FIGURE_SCALES[s[THING_FIGURE]] ?? 0);
        ru.f3(
          "uHands",
          (minutes / 720) * TAU,
          ((minutes % 60) / 60) * TAU,
          stoppedSecond(r.seed) * TAU,
        );
        if (things !== 0) {
          gl.enable(gl.SCISSOR_TEST);
        }
        for (let pass = 0; pass < 2; pass++) {
          ru.i1("uPass", pass);
          (pass === 0 ? albedoTarget : maskTarget).bind();
          if (things === 0) {
            triangle.draw();
            continue;
          }
          for (let i = 0; i < THINGS; i++) {
            const b = THING_BOXES[i];
            if (
              (things & (1 << i)) !== 0 &&
              scissorBox(gl, width, height, b[0] * k, b[1] * k, b[2] * k, b[3] * k, BOX_PAD)
            ) {
              triangle.draw();
            }
          }
        }
        gl.disable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          k = fitScale(width / height);
          albedoTarget?.dispose();
          albedoTarget = null;
          albedoTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          maskTarget?.dispose();
          maskTarget = null;
          maskTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          redrawAll = true;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
          const seed = Math.floor(Number.isFinite(p.seed) ? p.seed : 0);
          if (!room) {
            room = createRoom(seed, p.interval);
          } else if (seed !== room.seed && seedFade.idle) {
            seedFade.start();
          }
          // A new variation comes in at the bottom of a fade through black.
          if (seedFade.step(step)) {
            room = createRoom(seed, p.interval);
            redrawAll = true;
            redrawThings = 0;
          }
          const changed = advanceRoom(room, step, p.interval, p.presence);
          redrawThings = redrawThings | changed;
          const tint = tintEase.step(TINTS[p.tint] ?? TINTS.green, step, TINT_EASE);
          const level = failingLevel(room, p.hum);

          if (!albedoTarget || !maskTarget) {
            return;
          }
          if (redrawAll) {
            drawRoom(room, 0);
          } else if (redrawThings !== 0) {
            drawRoom(room, redrawThings);
          }
          redrawAll = false;
          redrawThings = 0;

          gl.useProgram(compositeProgram);
          cu.f3("uAmbient", tint[0], tint[1], tint[2]);
          cu.f3("uTube", tint[3], tint[4], tint[5]);
          cu.f3("uLevels", tint[6] * level, tint[7], tint[8]);
          cu.f1("uSelf", tint[9]);
          cu.f1("uFade", seedFade.alpha);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, maskTarget.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, albedoTarget.texture);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
