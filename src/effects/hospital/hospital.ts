import {
  beginFrame,
  createColumnTable,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  withScope,
  scissorBox,
  scopedProgram,
} from "../gl";
import { createDayClock } from "../horizon/horizon-sim";
import { HASH32_GLSL } from "../noise";
import { defineEffect } from "../types";
import {
  BOARD_BAND,
  drawBoard,
  drawScreen,
  HEART_SIZE,
  HEART_UV,
  TRACE_RGB,
  TRACE_ROWS,
  WAVE_X0,
  WAVE_X1,
} from "./hospital-canvas";
import {
  BEZEL,
  BOARD_FRAME,
  createMonitor,
  dripDrop,
  ERASE_COLUMNS,
  heartFlash,
  type Monitor,
  type RoomLayout,
  roomLayout,
  stepMonitor,
  TRACE_CHANNELS,
  TRACE_COLUMNS,
} from "./hospital-sim";
import { hospitalMeta } from "./hospital.meta";
import { SDF2D_GLSL, OVER_GLSL } from "../sdf-glsl";
import { clockHands, CLOCK_HANDS_GLSL, CLOCK_MARKS_GLSL } from "../wall-clock";
import { createCanvasTexture, paintCanvas, type CanvasTexture } from "../canvas-texture";
import { createChangeKey } from "../change-key";

const g = glslFloat;

/** How far round its box (frame heights) the care board draws: its frame, shadow and pen tray. */
const BOARD_REACH = 0.05;
const vec3 = (c: readonly [number, number, number]) => `vec3(${g(c[0])}, ${g(c[1])}, ${g(c[2])})`;

/** Layout slots in the room shader's `uL` array (see `packLayout`). */
const SLOTS = 14;
/** Largest text texture side, in texels. */
const MAX_TEXT_TEXELS = 2048;

const KIND_SCREEN = 0;
const KIND_DROP = 1;
const KIND_HANDS = 2;

const SHARED_GLSL = /* glsl */ `
${SDF2D_GLSL}
`;

/**
 * The room, drawn once per resize or setting change with four samples per
 * pixel: the painted wall and its bumper rail, the curtain, the headwall with
 * its gas outlets and the oxygen flowmeter, the clock's face, the care board,
 * the obs chart, the monitor's housing, the glove boxes, the drip stand with
 * its bag, drip chamber and pump, and the bed: headboard, pillow, blanket and
 * side rails. The monitor's light on the room is baked in.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
/** 1 with the monitor on the left, -1 mirrored. */
uniform float uSide;
/** 0 by day, 1 at night. */
uniform float uNight;
uniform vec4 uL[${String(SLOTS)}];
uniform sampler2D uBoard;
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
${SHARED_GLSL}
#define SCREEN uL[0]
#define CLOCK uL[1]
#define BOARD uL[2]
#define CHART uL[3]
#define BAG uL[4]
#define DRIP uL[5]
#define PUMP uL[6]
#define OXY uL[7]
#define GLOVES uL[8]
#define PILLOW uL[9]
#define HEADBOARD uL[10]
#define HEADWALL uL[11]
#define MISC uL[12]
#define RAILS uL[13]
const float BEZEL = ${g(BEZEL)};
const float BOARD_FRAME = ${g(BOARD_FRAME)};
const float BAND = ${g(BOARD_BAND)};
const vec3 METAL = vec3(0.72, 0.74, 0.77);
const vec3 PLASTIC = vec3(0.9, 0.9, 0.88);

vec3 col;
float recv;
vec3 lightK;

/** Lays a surface of colour c over what's there, with coverage a and how much monitor light it catches. */
void lay(vec3 c, float a, float r) {
  col = mix(col, c, a);
  recv = mix(recv, r, a);
}
/** A matte colour under the room's light. */
vec3 lit(vec3 c) {
  return c * lightK;
}
/** Darkens what's there by a soft drop shadow of the shape whose distance is d. */
void shadow(float d, float k, float soft) {
  col *= 1.0 - k * (1.0 - smoothstep(-soft * 0.3, soft, d));
}
float rand(vec2 cell, uint salt) {
  uvec2 u = uvec2(ivec2(cell) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ salt))) / 4294967296.0;
}

/**
 * By day, bright and even light from the ceiling panels; at night, a dim blue
 * room with a warm pool from the reading light in the headwall.
 */
vec3 lighting(vec2 f) {
  vec3 day = vec3(1.0, 0.99, 0.96) * (0.84 + 0.2 * smoothstep(-0.5, 0.5, f.y));
  day *= 1.0 - 0.18 * smoothstep(0.35, 0.95, length(f * vec2(0.62, 1.0)));
  vec2 h = f - vec2(HEADWALL.x, HEADWALL.y - 0.05);
  float pool = exp(-h.x * h.x / 0.11 - h.y * h.y / 0.07);
  float up = exp(-h.x * h.x / 0.09 - (h.y - 0.2) * (h.y - 0.2) / 0.03) * step(HEADWALL.y, f.y);
  vec3 night = vec3(0.13, 0.16, 0.24) + vec3(1.0, 0.76, 0.52) * (0.62 * pool + 0.3 * up);
  night *= 1.0 - 0.35 * smoothstep(0.3, 0.95, length(f * vec2(0.62, 1.0)));
  return mix(day, night, uNight);
}

/** Painted plaster, pale sage above the bumper rail and a deeper shade below it. */
void wall(vec2 f) {
  float railY = MISC.y;
  vec3 paint = f.y > railY ? vec3(0.78, 0.84, 0.79) : vec3(0.64, 0.72, 0.69);
  float blotch = 1.0 + 0.012 * sin(f.x * 5.0 + sin(f.y * 4.0) * 2.0) * sin(f.y * 6.0 + 1.0);
  float grain = 0.985 + 0.03 * rand(floor(f * 1100.0), 7u);
  col = lit(paint * blotch * grain);
  recv = 1.0;
  // The rail: a pale hardwood band, rounded, with its shadow underneath.
  float d = abs(f.y - railY) - 0.013;
  shadow(abs(f.y - railY + 0.012) - 0.013, 0.3, 0.014);
  float t = (f.y - railY) / 0.013;
  vec3 rail = vec3(0.74, 0.6, 0.44) * (0.75 + 0.35 * sqrt(max(0.0, 1.0 - t * t)) + 0.12 * t);
  rail *= 0.95 + 0.05 * sin(f.x * 300.0 + sin(f.x * 31.0) * 4.0 + f.y * 900.0);
  lay(lit(rail), cover(d), 0.8);
}

/** The privacy curtain, drawn back and bunched against the edge, and its ceiling track. */
void curtain(vec2 f) {
  float c = MISC.z;
  float edge = c + 0.008 * sin(f.y * 23.0 + 1.3) + 0.004 * sin(f.y * 61.0);
  shadow(edge - 0.008 - f.x, 0.35, 0.03);
  float u = f.x - edge;
  float fold = sin(u * TAU / 0.034 + 0.6 * sin(f.y * 4.0 + u * 30.0));
  float fold2 = sin(u * TAU / 0.013 + 1.7);
  vec3 cloth = vec3(0.56, 0.7, 0.8);
  // A faint printed lattice.
  vec2 pp = vec2(f.x * 0.7 + f.y * 0.4, f.y - f.x * 0.4) * 34.0;
  float print = smoothstep(0.42, 0.5, abs(fract(pp.x) - 0.5)) + smoothstep(0.42, 0.5, abs(fract(pp.y) - 0.5));
  cloth *= 1.0 - 0.07 * min(print, 1.0);
  cloth *= 0.72 + 0.22 * fold + 0.06 * fold2;
  cloth *= 0.9 + 0.12 * smoothstep(-0.5, 0.4, f.y);
  lay(lit(cloth), cover(-u), 0.6);
  // The track along the ceiling, and the gliders the curtain hangs from.
  float ty = 0.478;
  shadow(abs(f.y - ty + 0.006) - 0.007, 0.25, 0.01);
  vec3 track = METAL * (0.72 + 0.3 * smoothstep(-0.006, 0.006, f.y - ty));
  lay(lit(track), cover(abs(f.y - ty) - 0.006), 0.6);
  float gx = fract((f.x - edge) / 0.017) - 0.5;
  float glider = max(abs(gx * 0.017) - 0.002, abs(f.y - ty + 0.012) - 0.009);
  lay(lit(vec3(0.85)), cover(glider) * step(edge, f.x), 0.6);
}

/** The headwall: beige trunking with the reading light along its foot, gas outlets and sockets. */
void headwall(vec2 f) {
  vec2 q = f - HEADWALL.xy;
  vec2 hs = HEADWALL.zw;
  if (abs(q.y) > hs.y + 0.05) {
    return;
  }
  shadow(sdBox(q - vec2(0.004, -0.01), hs, 0.004), 0.35, 0.02);
  float t = q.y / hs.y;
  vec3 panel = vec3(0.86, 0.84, 0.78) * (0.82 + 0.18 * smoothstep(-1.0, 0.6, t));
  panel = mix(panel, panel * 1.1, smoothstep(0.85, 0.95, t));
  // Seams between the trunking's lengths.
  panel *= 1.0 - 0.3 * cover(abs(fract((q.x + 0.12) / 0.24) - 0.5) * 0.24 - 0.0007);
  vec3 c = lit(panel);
  // The reading light's diffuser along the foot: lit at night.
  float strip = abs(q.y + hs.y - 0.006) - 0.005;
  vec3 diffuser = mix(lit(vec3(0.95)), vec3(1.25, 1.06, 0.82), uNight);
  c = mix(c, diffuser, cover(strip));
  // Gas outlets towards the monitor's end: oxygen (white ring, green), air, suction (yellow).
  float x0 = OXY.x - HEADWALL.x;
  for (int i = 0; i < 3; i++) {
    vec2 o = q - vec2(x0 + float(i) * 0.042, 0.006);
    float r = length(o);
    vec3 ring = i == 0 ? vec3(0.95) : i == 1 ? vec3(0.1) : vec3(0.95, 0.8, 0.15);
    vec3 cap = i == 0 ? vec3(0.1, 0.55, 0.25) : i == 1 ? vec3(0.85) : vec3(0.95, 0.8, 0.15);
    c = mix(c, lit(vec3(0.3)), cover(r - 0.016));
    c = mix(c, lit(ring * (0.8 + 0.25 * smoothstep(0.01, -0.01, o.y - o.x))), cover(r - 0.0145));
    c = mix(c, lit(cap * 0.9), cover(r - 0.009));
    c = mix(c, lit(vec3(0.15)), cover(r - 0.003));
  }
  // Power sockets at the other end, each with its switch.
  for (int i = 0; i < 2; i++) {
    vec2 s = q - vec2(hs.x - 0.04 - float(i) * 0.05, 0.004);
    c = mix(c, lit(vec3(0.6)), cover(sdBox(s, vec2(0.0195, 0.0175), 0.003)));
    c = mix(c, lit(vec3(0.97)), cover(sdBox(s, vec2(0.018, 0.016), 0.003)));
    vec2 h = vec2(abs(s.x + 0.003) - 0.005, s.y - 0.002);
    c = mix(c, lit(vec3(0.2)), cover(sdBox(h, vec2(0.0012, 0.0035), 0.0005)));
    c = mix(c, lit(vec3(0.2)), cover(sdBox(s - vec2(-0.003, -0.008), vec2(0.0012, 0.0025), 0.0005)));
    c = mix(c, lit(vec3(0.85, 0.15, 0.1)), cover(sdBox(s - vec2(0.012, 0.0), vec2(0.003, 0.006), 0.001)));
  }
  lay(c, cover(sdBox(q, hs, 0.004)), 0.8);
}

/** The oxygen flowmeter on its outlet: a chrome body, a clear tube with its float, the humidifier bottle and the green tubing. */
void oxygen(vec2 f) {
  vec2 b = OXY.xy;
  vec2 hs = OXY.zw;
  if (abs(f.x - b.x) > 0.2 || f.y > HEADWALL.y + 0.02) {
    return;
  }
  // The green tubing, sagging from the bottle away to the pillow.
  vec2 c0 = b + vec2(hs.x * 0.6, hs.y + 0.006);
  vec2 c1 = b + vec2(0.07, -0.02);
  vec2 c2 = vec2(PILLOW.x - PILLOW.z * 0.55, PILLOW.y + 0.1);
  float cd = 1e3;
  vec2 prev = c0;
  for (int i = 1; i <= 10; i++) {
    float t = float(i) / 10.0;
    vec2 p = mix(mix(c0, c1, t), mix(c1, c2, t), t);
    cd = min(cd, sdSeg(f, prev, p));
    prev = p;
  }
  lay(lit(vec3(0.45, 0.8, 0.55) * 0.8), cover(cd - 0.0028), 0.6);
  lay(lit(vec3(0.75, 0.95, 0.8)), cover(cd - 0.001) * 0.4, 0.6);
  // The flowmeter: from the outlet down to the bottle.
  vec2 top = vec2(b.x, HEADWALL.y + 0.006);
  vec2 m = vec2(top.x, 0.5 * (top.y + b.y + hs.y));
  vec2 mq = f - m;
  float mh = 0.5 * (top.y - b.y - hs.y);
  shadow(sdBox(mq - vec2(0.005, -0.008), vec2(0.014, mh), 0.004), 0.3, 0.012);
  float cyl = mq.x / 0.014;
  vec3 chrome = METAL * (0.45 + 0.6 * pow(max(0.0, 1.0 - abs(cyl + 0.3)), 2.0));
  lay(lit(chrome), cover(sdBox(mq, vec2(0.014, mh), 0.004)), 0.7);
  // The clear tube with its float.
  vec2 tq = mq - vec2(0.0, 0.004);
  float tube = sdBox(tq, vec2(0.0075, mh * 0.62), 0.004);
  vec3 glass = vec3(0.86, 0.92, 0.95) * (0.75 + 0.3 * smoothstep(0.007, -0.004, tq.x));
  lay(lit(glass), cover(tube), 0.7);
  for (int i = 0; i < 5; i++) {
    float y = mh * 0.62 * (0.8 - 0.4 * float(i));
    lay(lit(vec3(0.2)), cover(sdBox(tq - vec2(-0.003, y), vec2(0.003, 0.0005), 0.0)), 0.7);
  }
  lay(lit(vec3(0.15, 0.6, 0.3)), cover(length(tq - vec2(0.0, mh * 0.62 * 0.15)) - 0.0045), 0.7);
  // The green knob on its side.
  vec2 kq = mq - vec2(0.019, mh * 0.75);
  lay(lit(vec3(0.1, 0.55, 0.25) * (0.7 + 0.4 * smoothstep(-0.006, 0.006, kq.y))), cover(sdBox(kq, vec2(0.006, 0.008), 0.003)), 0.7);
  // The humidifier bottle: clear, half full of water, with a white cap.
  vec2 q = f - b;
  shadow(sdBox(q - vec2(0.006, -0.01), hs, 0.008), 0.3, 0.015);
  float bd = sdBox(q, hs, 0.008);
  vec3 bottle = mix(col, lit(vec3(0.9, 0.95, 1.0)), 0.35);
  float level = -hs.y + 1.1 * hs.y;
  bottle = mix(bottle, lit(vec3(0.66, 0.82, 0.9)), 0.55 * step(q.y, level));
  bottle += lit(vec3(0.25)) * (1.0 - smoothstep(0.0, 0.002, abs(q.y - level))) * step(abs(q.x), hs.x - 0.003);
  bottle += lit(vec3(0.3)) * smoothstep(0.004, 0.0, abs(q.x + hs.x * 0.55)) * step(abs(q.y), hs.y - 0.01);
  bottle = mix(bottle, lit(vec3(0.5)), 1.0 - smoothstep(0.0, 0.0025, -bd));
  lay(bottle, cover(bd), 0.7);
  lay(lit(vec3(0.94) * (0.8 + 0.25 * smoothstep(-0.007, 0.007, q.y - hs.y))), cover(sdBox(q - vec2(0.0, hs.y + 0.002), vec2(hs.x + 0.003, 0.008), 0.003)), 0.7);
}

${CLOCK_MARKS_GLSL}
/** The wall clock's face: a black rim, a white dial and its marks. The hands are drawn live. */
void clockFace(vec2 f) {
  if (CLOCK.w < 0.5) {
    return;
  }
  vec2 q = f - CLOCK.xy;
  float R = CLOCK.z;
  float r = length(q);
  if (r > R * 1.3) {
    return;
  }
  shadow(length(q - vec2(0.005, -0.009)) - R, 0.4, R * 0.2);
  float ang = atan(q.y, q.x);
  vec3 rim = vec3(0.07) + vec3(0.14) * max(0.0, cos(ang - 2.0)) * smoothstep(R, R * 0.93, r);
  lay(lit(rim), cover(r - R), 0.8);
  vec3 dial = vec3(0.95, 0.95, 0.93) * (0.88 + 0.12 * smoothstep(R * 0.9, 0.0, r));
  float tick = clockMarks(vec2(q.x * uSide, q.y), R, 0.85, vec4(0.1, 0.022, 0.04, 0.007));
  dial = mix(dial, vec3(0.06), cover(tick));
  lay(lit(dial), cover(r - R * 0.9), 0.6);
  col += lightK * vec3(0.05) * smoothstep(R * 0.9, R * 0.6, r) * smoothstep(0.3, 0.9, dot(normalize(q + 1e-5), vec2(-0.6, 0.8))) * smoothstep(R * 0.4, R * 0.8, r);
}

/** The care board: an aluminium frame, a whiteboard with a printed heading, the handwriting, and a pen tray. */
void board(vec2 f) {
  vec2 q = f - BOARD.xy;
  vec2 hs = BOARD.zw;
  if (sdBox(q, hs, 0.0) > ${g(BOARD_REACH)}) {
    return;
  }
  shadow(sdBox(q - vec2(0.006, -0.011), hs + BOARD_FRAME, 0.003), 0.35, 0.02);
  float outer = sdBox(q, hs + BOARD_FRAME, 0.003);
  float rim = sdBox(q, hs, 0.0);
  vec3 frame = METAL * (0.7 + 0.3 * smoothstep(BOARD_FRAME, 0.0, abs(rim - BOARD_FRAME * 0.5) * 2.0));
  frame *= 0.9 + 0.15 * smoothstep(-hs.y, hs.y, q.y);
  lay(lit(frame), cover(outer), 0.7);
  vec2 uv = vec2(q.x * uSide / hs.x * 0.5 + 0.5, 0.5 - q.y / hs.y * 0.5);
  vec4 t = texture(uBoard, uv);
  // A faint sheen across the board.
  float sheen = exp(-pow((q.x * uSide - q.y * 0.8 + hs.x * 0.3) / (hs.x * 0.35), 2.0));
  vec3 c = vec3(0.94, 0.95, 0.95) * (0.97 + 0.04 * sheen);
  if (uv.y < BAND) {
    c = mix(vec3(0.97), vec3(0.12, 0.36, 0.64), t.b);
  }
  c = mix(c, vec3(0.08, 0.2, 0.62), t.r * 0.95);
  c = mix(c, vec3(0.78, 0.12, 0.1), t.g * 0.95);
  c *= 0.85 + 0.15 * smoothstep(0.0, 0.006, -rim);
  lay(lit(c), cover(rim), 0.6);
  // The pen tray and two markers.
  vec2 pq = q - vec2(0.0, -hs.y - BOARD_FRAME - 0.006);
  lay(lit(METAL * (0.6 + 0.35 * smoothstep(-0.006, 0.006, pq.y))), cover(sdBox(pq, vec2(hs.x * 0.7, 0.006), 0.002)), 0.6);
  for (int i = 0; i < 2; i++) {
    vec2 mq = pq - vec2(hs.x * (i == 0 ? -0.35 : 0.05) * uSide, 0.008);
    vec3 mc = i == 0 ? vec3(0.1, 0.25, 0.7) : vec3(0.8, 0.12, 0.1);
    float body = sdBox(mq, vec2(0.03, 0.0045), 0.0045);
    lay(lit(vec3(0.92) * (0.8 + 0.3 * smoothstep(-0.004, 0.004, mq.y))), cover(body), 0.6);
    lay(lit(mc), cover(sdBox(mq - vec2(0.022 * uSide, 0.0), vec2(0.011, 0.0048), 0.0045)), 0.6);
  }
}

/** The obs chart on a clipboard, hung on a hook: printed headings, a grid, and the pulse and temperature plotted. */
void chart(vec2 f) {
  vec2 q = f - CHART.xy;
  vec2 hs = CHART.zw;
  if (sdBox(q, hs, 0.0) > 0.06) {
    return;
  }
  vec2 bh = hs + vec2(0.011, 0.016);
  vec2 bc = vec2(0.0, 0.006);
  // The hook and the clip's hanging hole.
  vec2 hook = q - vec2(0.0, hs.y + 0.042);
  lay(lit(METAL * 0.55), cover(length(hook) - 0.005), 0.6);
  shadow(sdBox(q - bc - vec2(0.006, -0.012), bh, 0.006), 0.4, 0.02);
  float board = sdBox(q - bc, bh, 0.006);
  vec3 hard = vec3(0.45, 0.31, 0.18) * (0.85 + 0.2 * smoothstep(-bh.y, bh.y, q.y));
  hard *= 0.94 + 0.06 * sin(q.x * 900.0 + sin(q.y * 70.0) * 3.0);
  lay(lit(hard), cover(board), 0.6);
  // The paper.
  vec2 u = vec2(q.x * uSide / hs.x * 0.5 + 0.5, 0.5 - q.y / hs.y * 0.5);
  vec3 paper = vec3(0.97, 0.97, 0.95);
  // Printed heading lines.
  for (int i = 0; i < 3; i++) {
    float y = 0.07 + 0.045 * float(i);
    float w = i == 0 ? 0.55 : 0.8 - 0.2 * float(i);
    paper = mix(paper, vec3(0.35), cover((abs(u.y - y) - 0.007) * hs.y * 2.0) * step(0.08, u.x) * step(u.x, 0.08 + w));
  }
  // The grid.
  vec2 g0 = vec2(0.08, 0.24);
  vec2 g1 = vec2(0.94, 0.95);
  if (u.x > g0.x && u.x < g1.x && u.y > g0.y && u.y < g1.y) {
    vec2 gq = (u - g0) / (g1 - g0);
    vec2 cell = abs(fract(gq * vec2(10.0, 12.0)) - 0.5);
    float line = 1.0 - smoothstep(0.42, 0.5, max(cell.x, cell.y));
    vec3 band = gq.y < 0.5 ? vec3(0.98, 0.93, 0.93) : vec3(0.93, 0.95, 0.99);
    paper = mix(band, vec3(0.7, 0.75, 0.82), 0.6 * (1.0 - line));
    // Pulse (red, upper) and temperature (blue, lower), a reading a column.
    vec2 pq = vec2(u.x * hs.x * 2.0, u.y * hs.y * 2.0);
    for (int s = 0; s < 2; s++) {
      float d = 1e3;
      float pt = 1e3;
      vec2 prev = vec2(0.0);
      for (int i = 0; i < 9; i++) {
        float x = mix(g0.x, g1.x, (float(i) + 0.5) / 10.0);
        float base = s == 0 ? 0.4 : 0.66;
        float y = mix(g0.y, g1.y, base + 0.1 * (rand(vec2(float(i), float(s)), 31u) - 0.5));
        vec2 p = vec2(x * hs.x * 2.0, y * hs.y * 2.0);
        if (i > 0) {
          d = min(d, sdSeg(pq, prev, p));
        }
        pt = min(pt, length(pq - p));
        prev = p;
      }
      vec3 ink = s == 0 ? vec3(0.8, 0.12, 0.12) : vec3(0.12, 0.25, 0.7);
      paper = mix(paper, ink, cover(d - 0.0007) * 0.85);
      paper = mix(paper, ink, cover(pt - 0.0022));
    }
  }
  lay(lit(paper), cover(sdBox(q, hs, 0.001)), 0.6);
  // The clip.
  vec2 cq = q - vec2(0.0, hs.y + 0.006);
  shadow(sdBox(cq - vec2(0.003, -0.006), vec2(0.035, 0.012), 0.004), 0.35, 0.008);
  vec3 clip = METAL * (0.55 + 0.45 * smoothstep(-0.012, 0.012, cq.y));
  lay(lit(clip), cover(sdBox(cq, vec2(0.035, 0.012), 0.004)), 0.6);
  lay(lit(METAL * 0.4), cover(length(cq - vec2(0.0, 0.019)) - 0.0075), 0.6);
  lay(lit(vec3(0.5)), cover(abs(length(cq - vec2(0.0, 0.019)) - 0.0075) - 0.0012), 0.6);
}

/** The monitor's housing and the bracket that holds it to the wall. The screen is drawn live. */
void monitor(vec2 f) {
  vec2 q = f - SCREEN.xy;
  vec2 hs = SCREEN.zw;
  vec2 oc = vec2(0.0, -0.012);
  vec2 ohs = hs + BEZEL + vec2(0.0, 0.012);
  if (sdBox(q - oc, ohs, 0.0) > 0.18) {
    return;
  }
  // The bracket: a wall plate under the monitor and a short arm up to it.
  vec2 plate = q - vec2(0.0, -ohs.y - 0.075);
  shadow(sdBox(plate - vec2(0.004, -0.006), vec2(0.03, 0.022), 0.004), 0.3, 0.01);
  lay(lit(vec3(0.55, 0.56, 0.58) * (0.8 + 0.3 * smoothstep(-0.02, 0.02, plate.y))), cover(sdBox(plate, vec2(0.03, 0.022), 0.004)), 0.7);
  float arm = sdSeg(q, vec2(0.0, -ohs.y - 0.07), vec2(0.0, -ohs.y + 0.02)) - 0.011;
  shadow(sdSeg(q - vec2(0.008, -0.008), vec2(0.0, -ohs.y - 0.07), vec2(0.0, -ohs.y)) - 0.011, 0.35, 0.012);
  lay(lit(vec3(0.3, 0.31, 0.33) * (0.7 + 0.5 * smoothstep(0.011, -0.011, q.x + 0.004))), cover(arm), 0.7);
  lay(lit(vec3(0.6)), cover(length(q - vec2(0.0, -ohs.y - 0.068)) - 0.007), 0.7);
  // The housing, a little chin below the screen with its keys.
  shadow(sdBox(q - oc - vec2(0.008, -0.016), ohs, 0.012), 0.45, 0.03);
  float d = sdBox(q - oc, ohs, 0.012);
  vec3 shell = vec3(0.2, 0.21, 0.23) * (0.8 + 0.3 * smoothstep(-ohs.y, ohs.y, q.y));
  shell += vec3(0.12) * (1.0 - smoothstep(0.0, 0.003, abs(d + 0.002)));
  lay(lit(shell), cover(d), 0.2);
  vec2 kq = q - vec2(0.0, -hs.y - 0.017);
  float kx = clamp(floor(kq.x / 0.03 + 0.5), -3.0, 3.0);
  vec2 kk = kq - vec2(kx * 0.03, 0.0);
  vec3 key = vec3(0.32) * (0.8 + 0.3 * smoothstep(-0.004, 0.004, kk.y));
  if (kx == 3.0) {
    key = vec3(0.25, 0.9, 0.4);
  }
  lay(kx == 3.0 ? key : lit(key), cover(sdBox(kk, vec2(kx == 3.0 ? 0.003 : 0.009, 0.003), 0.002)), 0.2);
  // The screen's recess.
  lay(vec3(0.01), cover(sdBox(q, hs + 0.002, 0.003)), 0.0);
}

/** Glove boxes in a wire rack: three sizes, each with a glove poking out. */
void gloves(vec2 f) {
  vec2 q = f - GLOVES.xy;
  vec2 hs = GLOVES.zw;
  if (sdBox(q, hs, 0.0) > 0.04) {
    return;
  }
  shadow(sdBox(q - vec2(0.006, -0.01), hs, 0.004), 0.35, 0.02);
  float w = 2.0 * hs.x / 3.0;
  float k = clamp(floor((q.x + hs.x) / w), 0.0, 2.0);
  vec2 bq = q - vec2(-hs.x + (k + 0.5) * w, 0.0);
  vec2 bh = vec2(0.5 * w - 0.004, hs.y - 0.003);
  vec3 tint = k == 0.0 ? vec3(0.55, 0.35, 0.75) : k == 1.0 ? vec3(0.2, 0.45, 0.85) : vec3(0.15, 0.6, 0.6);
  vec3 box = vec3(0.94) * (0.88 + 0.15 * smoothstep(-bh.y, bh.y, bq.y));
  box = mix(box, tint, step(bq.y, -bh.y * 0.35));
  // The dispensing slot, and a glove's cuff and fingers crumpled up out of it.
  vec2 hc = vec2(0.0, bh.y * 0.12);
  vec2 hq = (bq - hc) / vec2(bh.x * 0.5, bh.y * 0.2);
  float hole = (length(hq) - 1.0) * bh.y * 0.2;
  box = mix(box, vec3(0.12), cover(hole));
  float glove = 1e3;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 c = hc + vec2((fi - 1.5) * bh.x * 0.2 + 0.003 * sin(k * 5.0 + fi), bh.y * (0.32 + 0.12 * sin(k * 2.0 + fi * 1.7)));
    glove = min(glove, length(bq - c) - bh.x * 0.13);
  }
  glove = min(glove, sdBox(bq - hc - vec2(0.0, bh.y * 0.12), vec2(bh.x * 0.36, bh.y * 0.14), bh.y * 0.08));
  vec3 gc = mix(tint, vec3(0.86, 0.9, 1.0), 0.5);
  gc *= 0.82 + 0.25 * smoothstep(-bh.y * 0.1, bh.y * 0.6, bq.y - hc.y);
  box = mix(box, gc, cover(glove));
  lay(lit(box), cover(sdBox(bq, bh, 0.002)), 0.6);
  // The rack's wires along the front.
  float wire = min(abs(q.y + hs.y * 0.55) - 0.0016, abs(abs(q.x) - hs.x) - 0.0016);
  lay(lit(METAL * 0.75), cover(max(wire, sdBox(q, hs + 0.003, 0.0))), 0.6);
}

/** Seven-segment digit d, in a cell 0.6 wide and 1 high centred on p, as a distance (cell units). */
float seg7(vec2 p, int d) {
  int m = d == 0 ? 63 : d == 1 ? 6 : d == 2 ? 91 : d == 3 ? 79 : d == 4 ? 102 : d == 5 ? 109 : d == 6 ? 125 : d == 7 ? 7 : d == 8 ? 127 : 111;
  p.x -= 0.1 * p.y;
  float r = 1e3;
  vec2 hz = vec2(0.19, 0.05);
  vec2 vt = vec2(0.05, 0.19);
  if ((m & 1) != 0) r = min(r, sdBox(p - vec2(0.0, 0.46), hz, 0.04));
  if ((m & 2) != 0) r = min(r, sdBox(p - vec2(0.24, 0.23), vt, 0.04));
  if ((m & 4) != 0) r = min(r, sdBox(p - vec2(0.24, -0.23), vt, 0.04));
  if ((m & 8) != 0) r = min(r, sdBox(p - vec2(0.0, -0.46), hz, 0.04));
  if ((m & 16) != 0) r = min(r, sdBox(p - vec2(-0.24, -0.23), vt, 0.04));
  if ((m & 32) != 0) r = min(r, sdBox(p - vec2(-0.24, 0.23), vt, 0.04));
  if ((m & 64) != 0) r = min(r, sdBox(p, hz, 0.04));
  return r;
}

/** The drip stand: its pole, the bag, the drip chamber, the pump and the line down to the bed. */
void dripStand(vec2 f) {
  float x = MISC.x;
  if (abs(f.x - x) > 0.25) {
    return;
  }
  vec2 bag = BAG.xy;
  vec2 bh = BAG.zw;
  float hookY = bag.y + bh.y + 0.04;
  // The pole, and the hooks at its top.
  float pole = max(abs(f.x - x) - 0.0045, f.y - hookY);
  shadow(max(abs(f.x - x - 0.007) - 0.0045, f.y - hookY), 0.3, 0.012);
  vec3 chrome = METAL * (0.45 + 0.7 * pow(max(0.0, 1.0 - abs((f.x - x) / 0.0045 + 0.35)), 2.0));
  lay(lit(chrome), cover(pole), 0.5);
  vec2 hq = f - vec2(x, hookY);
  float arms = sdSeg(hq, vec2(-0.045, 0.006), vec2(0.045, 0.006)) - 0.0025;
  arms = min(arms, abs(length(vec2(abs(hq.x) - 0.045, hq.y + 0.004)) - 0.009) - 0.0022 + 1e3 * step(0.0, hq.y + 0.004));
  arms = min(arms, length(hq - vec2(0.0, 0.006)) - 0.005);
  lay(lit(METAL * 0.75), cover(arms), 0.5);
  // The bag's hanger, the bag (clear, with its fluid and a printed label) and its port.
  vec2 q = f - bag;
  lay(lit(vec3(0.85)), cover(sdSeg(f, vec2(x, hookY - 0.006), vec2(x, bag.y + bh.y)) - 0.0018), 0.5);
  float pinch = q.y / bh.y;
  float bd = sdBox(q, vec2(bh.x * (1.0 - 0.2 * smoothstep(0.6, 1.0, pinch) - 0.25 * smoothstep(-0.7, -1.0, pinch)), bh.y), 0.01);
  shadow(sdBox(q - vec2(0.006, -0.012), bh, 0.012), 0.3, 0.02);
  vec3 bc = mix(col, lit(vec3(0.94, 0.97, 1.0)), 0.5);
  float level = bh.y * 0.45;
  bc = mix(bc, lit(vec3(0.84, 0.9, 0.95)), 0.5 * step(q.y, level));
  bc += lit(vec3(0.2)) * (1.0 - smoothstep(0.0, 0.0018, abs(q.y - level)));
  vec2 lq = q - vec2(0.0, -0.005);
  float label = sdBox(lq, vec2(bh.x * 0.62, bh.y * 0.36), 0.002);
  vec3 lc = vec3(0.97);
  for (int i = 0; i < 4; i++) {
    float y = bh.y * (0.22 - 0.13 * float(i));
    float w = bh.x * (i == 0 ? 0.48 : i == 1 ? 0.36 : 0.42 - 0.08 * float(i));
    vec3 ink = i == 0 ? vec3(0.1, 0.3, 0.65) : vec3(0.35);
    lc = mix(lc, ink, cover(abs(lq.y - y) - (i == 0 ? 0.0035 : 0.0018)) * step(abs(lq.x * uSide + bh.x * 0.48 - w), w));
  }
  bc = mix(bc, lit(lc), cover(label) * 0.9);
  bc += lit(vec3(0.35)) * smoothstep(0.003, 0.0, abs(q.x + bh.x * 0.6)) * step(abs(q.y), bh.y * 0.8);
  bc = mix(bc, lit(vec3(0.7, 0.75, 0.8)), 1.0 - smoothstep(0.0, 0.002, -bd));
  lay(bc, cover(bd), 0.5);
  lay(lit(vec3(0.9)), cover(sdBox(q - vec2(0.0, -bh.y - 0.008), vec2(0.004, 0.01), 0.002)), 0.5);
  // The drip chamber: a spike cap, clear walls and the pool at its foot. The drop is drawn live.
  vec2 dq = f - DRIP.xy;
  vec2 dh = DRIP.zw;
  lay(lit(vec3(0.95) * (0.8 + 0.3 * smoothstep(-0.006, 0.006, dq.x))), cover(sdBox(dq - vec2(0.0, dh.y + 0.008), vec2(dh.x * 0.8, 0.009), 0.003)), 0.5);
  float cd = sdBox(dq, dh, 0.004);
  vec3 cc = mix(col, lit(vec3(0.92, 0.96, 1.0)), 0.3);
  cc = mix(cc, lit(vec3(0.75, 0.86, 0.95)), 0.6 * step(dq.y, -dh.y * 0.35));
  cc += lit(vec3(0.3)) * smoothstep(0.0025, 0.0, abs(dq.x + dh.x * 0.55));
  cc = mix(cc, lit(vec3(0.62, 0.68, 0.75)), 1.0 - smoothstep(0.0, 0.0018, -cd));
  lay(cc, cover(cd), 0.5);
  // The line: down from the chamber into the pump, and out of it down to the bed.
  vec2 pc = PUMP.xy;
  vec2 ph = PUMP.zw;
  vec2 inTop = vec2(pc.x - ph.x * 0.45, pc.y + ph.y);
  float line = min(sdSeg(f, DRIP.xy - vec2(0.0, dh.y), vec2(DRIP.x, DRIP.y - dh.y - 0.02)), sdSeg(f, vec2(DRIP.x, DRIP.y - dh.y - 0.02), inTop));
  vec2 c0 = vec2(pc.x - ph.x * 0.45, pc.y - ph.y);
  vec2 c1 = vec2(pc.x - ph.x * 1.2, pc.y - ph.y - 0.22);
  vec2 c2 = vec2(PILLOW.x + PILLOW.z * 0.85, -0.55);
  vec2 prev = c0;
  for (int i = 1; i <= 10; i++) {
    float t = float(i) / 10.0;
    vec2 p = mix(mix(c0, c1, t), mix(c1, c2, t), t);
    line = min(line, sdSeg(f, prev, p));
    prev = p;
  }
  lay(lit(vec3(0.8, 0.86, 0.9)), cover(line - 0.0022), 0.5);
  lay(lit(vec3(0.98)), cover(line - 0.0008) * 0.6, 0.5);
  // The pump: an off-white case with a blue-grey face, its display, keys and pole clamp.
  vec2 pq = f - pc;
  shadow(sdBox(pq - vec2(0.008, -0.013), ph, 0.008), 0.4, 0.025);
  lay(lit(vec3(0.25)), cover(sdBox(pq - vec2(ph.x * 0.2, 0.0), vec2(ph.x * 1.0, 0.012), 0.004)), 0.5);
  float pd = sdBox(pq, ph, 0.008);
  vec3 pcol = vec3(0.9, 0.9, 0.87) * (0.82 + 0.22 * smoothstep(-ph.y, ph.y, pq.y));
  vec2 fh = ph - vec2(0.008, 0.01);
  float face = sdBox(pq - vec2(0.0, -0.002), fh, 0.005);
  pcol = mix(pcol, vec3(0.42, 0.48, 0.56), cover(face));
  vec2 sq = pq - vec2(0.0, fh.y * 0.48);
  vec2 sh = vec2(fh.x - 0.008, fh.y * 0.38);
  float disp = sdBox(sq, sh, 0.002);
  vec3 dc = vec3(0.04, 0.08, 0.05);
  // "125" in seven segments, and "mL/h" beside it.
  float dh2 = min(sh.y * 1.4, sh.x * 0.95);
  vec2 dp = vec2(sq.x * uSide, sq.y) / dh2;
  float seg = 1e3;
  for (int i = 0; i < 3; i++) {
    seg = min(seg, seg7(dp - vec2(-0.66 + 0.66 * float(i), 0.0), i == 0 ? 1 : i == 1 ? 2 : 5));
  }
  float ghost = 1e3;
  for (int i = 0; i < 3; i++) {
    ghost = min(ghost, seg7(dp - vec2(-0.66 + 0.66 * float(i), 0.0), 8));
  }
  dc = mix(dc, vec3(0.06, 0.12, 0.08), cover(ghost * dh2));
  dc = mix(dc, vec3(0.42, 1.0, 0.5), cover(seg * dh2));
  pcol = mix(pcol, dc, cover(disp));
  // Keys: a grid of pale keys, and a green "running" lamp.
  vec2 kq = pq - vec2(0.0, -fh.y * 0.45);
  vec2 kc = clamp(floor(kq / vec2(0.022, 0.018) + 0.5), vec2(-1.0, -1.0), vec2(1.0, 0.0));
  vec2 kk = kq - kc * vec2(0.022, 0.018);
  pcol = mix(pcol, vec3(0.8, 0.82, 0.84) * (0.8 + 0.3 * smoothstep(-0.005, 0.005, kk.y)), cover(sdBox(kk, vec2(0.0075, 0.0055), 0.002)));
  vec2 lamp = vec2(pq.x * uSide - fh.x + 0.008, pq.y - fh.y * 0.02);
  vec3 lampC = vec3(0.3, 1.0, 0.45);
  float ld = length(lamp) - 0.0035;
  lay(lit(pcol), cover(pd), 0.5);
  lay(lampC, cover(ld), 0.5);
}

/** The bed's headboard, pillow, blanket and side rails. */
void bed(vec2 f) {
  // The headboard: a pale frame round a wood-laminate panel.
  vec2 q = f - HEADBOARD.xy;
  vec2 hs = HEADBOARD.zw;
  shadow(sdBox(q - vec2(0.0, -0.014), hs, 0.04), 0.4, 0.04);
  float d = sdBox(q, hs, 0.04);
  vec3 frame = PLASTIC * (0.8 + 0.25 * smoothstep(-hs.y, hs.y, q.y));
  frame *= 1.0 - 0.2 * (1.0 - smoothstep(0.0, 0.006, -d));
  float inner = sdBox(q, hs - 0.022, 0.026);
  vec3 lam = vec3(0.72, 0.56, 0.4) * (0.92 + 0.08 * sin(q.x * 160.0 + sin(q.y * 25.0) * 3.0 + sin(q.x * 13.0) * 2.0));
  lam *= 0.8 + 0.25 * smoothstep(-hs.y, hs.y, q.y);
  frame = mix(frame, lam, cover(inner));
  lay(lit(frame), cover(d), 0.4);
  // The pillow: soft, white, with a few creases.
  vec2 pq = f - PILLOW.xy;
  vec2 ph = PILLOW.zw;
  float puff = 0.006 * sin(pq.x * 40.0) * smoothstep(ph.x * 0.4, ph.x, abs(pq.x));
  shadow(sdBox(pq - vec2(0.006, -0.012), ph, 0.1), 0.45, 0.035);
  float pd = sdBox(pq, ph, 0.1) + puff * smoothstep(0.0, ph.y, pq.y);
  vec2 pn = pq / ph;
  vec3 cotton = vec3(0.95, 0.96, 0.98);
  // Rounded like a stuffed case: brightest a little above the middle, falling off to the edges.
  float edge = smoothstep(0.0, 0.07, -pd);
  float shade = 0.8 + 0.16 * smoothstep(-1.0, 0.7, pn.y) - 0.08 * pn.x * pn.x;
  // A few soft creases running in from the corners.
  float crease = 0.0;
  for (int i = 0; i < 4; i++) {
    float sx = i < 2 ? -1.0 : 1.0;
    float sy = (i == 0 || i == 2) ? 1.0 : -1.0;
    vec2 cq = pn - vec2(sx, sy) * 0.92;
    float along = dot(cq, normalize(vec2(-sx, -sy * 0.6)));
    float across = dot(cq, normalize(vec2(sy * 0.6, -sx)));
    crease += 0.05 * exp(-across * across / 0.0025) * smoothstep(0.45, 0.0, along) * step(0.0, along);
  }
  cotton *= (shade - crease) * (0.86 + 0.14 * edge);
  // The case's seam just inside the edge.
  cotton *= 1.0 - 0.05 * (1.0 - smoothstep(0.0, 0.0025, abs(pd + 0.012)));
  lay(lit(cotton), cover(pd), 0.5);
  // The blanket across the bottom: a pale blue cellular weave.
  float top = RAILS.y + RAILS.w * 0.25 + 0.012 * sin(f.x * 9.0 + 0.5) + 0.006 * sin(f.x * 23.0);
  float bd = f.y - top;
  shadow(bd - 0.004, 0.3, 0.02);
  vec2 cell = abs(fract(f * vec2(110.0, 95.0)) - 0.5);
  float holes = smoothstep(0.24, 0.16, max(cell.x, cell.y));
  vec3 blanket = vec3(0.6, 0.72, 0.86) * (0.88 + 0.12 * smoothstep(-0.5, top, f.y)) * (1.0 - 0.18 * holes);
  blanket *= 0.9 + 0.1 * sin(f.x * 14.0 + f.y * 30.0);
  lay(lit(blanket), cover(bd), 0.3);
  // The side rails, one each side, the monitor's with its control panel.
  vec2 rq = vec2(-abs(f.x), f.y) - RAILS.xy;
  vec2 rh = RAILS.zw;
  shadow(sdBox(rq - vec2(0.006, -0.012), rh, 0.03), 0.4, 0.03);
  float rd = sdBox(rq, rh, 0.03);
  vec3 rc = PLASTIC * (0.75 + 0.3 * smoothstep(-rh.y, rh.y, rq.y));
  rc *= 1.0 - 0.15 * (1.0 - smoothstep(0.0, 0.006, -rd));
  rc += vec3(0.08) * (1.0 - smoothstep(0.0, 0.004, abs(rq.y - rh.y + 0.008))) * step(abs(rq.x), rh.x - 0.03);
  // Two hand-hold openings.
  float holeD = 1e3;
  for (int i = 0; i < 2; i++) {
    vec2 hq = rq - vec2(rh.x * (i == 0 ? -0.48 : 0.12), rh.y * 0.25);
    holeD = min(holeD, sdBox(hq, vec2(rh.x * 0.27, rh.y * 0.22), rh.y * 0.2));
  }
  vec3 behind = col * 0.75;
  rc = mix(rc, behind, cover(holeD));
  rc *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.006, holeD)) * step(0.0, holeD);
  if (f.x < 0.0) {
    vec2 cq = rq - vec2(rh.x * 0.62, rh.y * 0.2);
    vec2 ch = vec2(rh.x * 0.2, rh.y * 0.42);
    rc = mix(rc, vec3(0.28, 0.3, 0.34), cover(sdBox(cq, ch, 0.008)));
    vec2 bk = clamp(floor(cq / vec2(ch.x * 0.62, ch.y * 0.7) + 0.5), vec2(-1.0), vec2(1.0, 0.0));
    vec2 bq = cq - bk * vec2(ch.x * 0.62, ch.y * 0.7) - vec2(0.0, ch.y * 0.35);
    rc = mix(rc, vec3(0.75, 0.78, 0.82) * (0.8 + 0.3 * smoothstep(-0.006, 0.006, bq.y)), cover(sdBox(bq, vec2(ch.x * 0.24, ch.y * 0.24), 0.003)));
  }
  lay(lit(rc), cover(rd), 0.3);
}

vec4 room(vec2 f) {
  lightK = lighting(f);
  wall(f);
  curtain(f);
  headwall(f);
  oxygen(f);
  clockFace(f);
  board(f);
  chart(f);
  monitor(f);
  gloves(f);
  dripStand(f);
  bed(f);
  // The monitor's light, strongest at night.
  float ds = max(sdBox(f - SCREEN.xy, SCREEN.zw + BEZEL, 0.01), 0.0);
  float fall = 0.5 * exp(-ds / 0.05) + 0.4 * exp(-ds / 0.2);
  vec3 glow = vec3(0.1, 0.22, 0.2) * fall * recv * mix(0.25, 1.0, uNight);
  return vec4(col + glow, 1.0);
}

void main() {
  px = 1.0 / uRes.y;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    vec2 f = (gl_FragCoord.xy + o - 0.5 * uRes) / uRes.y;
    sum += room(vec2(f.x * uSide, f.y)).rgb;
  }
  sum *= 0.25;
  outColor = vec4(sum + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** Every frame: the cached room. */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
out vec4 outColor;
void main() {
  outColor = vec4(texelFetch(uRoom, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
}
`;

/**
 * The live parts, each drawn premultiplied in a scissor round its box: the
 * monitor's screen with its sweeping traces and beating heart, the drop in the
 * drip chamber, and the clock's hands.
 */
const GADGET_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform int uKind;
/** The part's centre and half size (frame units), or centre and radius. */
uniform vec4 uBox;
uniform vec4 uVal;
/** At night the screen is turned down a little. */
uniform float uDim;
uniform sampler2D uText;
uniform sampler2D uTrace;
out vec4 outColor;
${SHARED_GLSL}
const int N = ${String(TRACE_COLUMNS)};
const int ERASE = ${String(ERASE_COLUMNS)};
const float X0 = ${g(WAVE_X0)};
const float X1 = ${g(WAVE_X1)};

/** Premultiplied src over dst. */
${OVER_GLSL}

float dot2(vec2 v) {
  return dot(v, v);
}
/** A heart about one unit tall, its notch at the top and point at the origin. */
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) {
    return sqrt(dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  }
  return sqrt(min(dot2(p - vec2(0.0, 1.0)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}

bool shown(int j, int cursor) {
  return j >= 0 && j < N && (j - cursor + N) % N >= ERASE;
}

/** Trace r's height (screen uv, down) at column j. */
float traceY(int j, int r, float top, float h) {
  vec4 v = texelFetch(uTrace, ivec2(j, 0), 0);
  if (r == 0) {
    return top + h * (0.66 - 0.5 * v.x);
  }
  if (r == 1) {
    return top + h * (0.9 - 0.76 * v.y);
  }
  return top + h * (0.86 - 0.66 * v.z);
}

/** The screen: its texture of labels and numbers, the three traces swept up to the cursor, and the heart. */
vec4 screen(vec2 q) {
  vec2 hs = uBox.zw;
  vec2 size = 2.0 * hs;
  vec2 uv = vec2(q.x / hs.x * 0.5 + 0.5, 0.5 - q.y / hs.y * 0.5);
  vec3 c = texture(uText, uv).rgb;
  vec2 p = uv * size;
  int cursor = int(uVal.x);
  float colx = (uv.x - X0) / (X1 - X0) * float(N - 1);
  int i0 = int(floor(colx));
  float w = 0.00075;
  for (int r = 0; r < 3; r++) {
    float top = r == 0 ? ${g(TRACE_ROWS[0][0])} : r == 1 ? ${g(TRACE_ROWS[1][0])} : ${g(TRACE_ROWS[2][0])};
    float bottom = r == 0 ? ${g(TRACE_ROWS[0][1])} : r == 1 ? ${g(TRACE_ROWS[1][1])} : ${g(TRACE_ROWS[2][1])};
    if (uv.y < top - 0.02 || uv.y > bottom + 0.02) {
      continue;
    }
    vec3 rgb = r == 0 ? ${vec3(TRACE_RGB[0])} : r == 1 ? ${vec3(TRACE_RGB[1])} : ${vec3(TRACE_RGB[2])};
    float h = bottom - top;
    float d = 1e3;
    for (int k = -3; k <= 3; k++) {
      int j = i0 + k;
      if (!shown(j, cursor) || !shown(j + 1, cursor)) {
        continue;
      }
      vec2 a = vec2(X0 + (X1 - X0) * float(j) / float(N - 1), traceY(j, r, top, h)) * size;
      vec2 b = vec2(X0 + (X1 - X0) * float(j + 1) / float(N - 1), traceY(j + 1, r, top, h)) * size;
      d = min(d, sdSeg(p, a, b));
    }
    c = mix(c, rgb, cover(d - w));
    c += rgb * 0.22 * exp(-d / (2.5 * px));
  }
  // The heart by the heart rate, lit at each beat.
  float hsz = ${g(HEART_SIZE)} * size.y;
  vec2 hp = vec2(uv.x - ${g(HEART_UV[0])}, ${g(HEART_UV[1])} - uv.y) * size / hsz + vec2(0.0, 0.5);
  float hd = sdHeart(hp) * hsz;
  vec3 green = ${vec3(TRACE_RGB[0])};
  c = mix(c, green * mix(0.18, 1.0, uVal.y), cover(hd));
  c += green * 0.3 * uVal.y * exp(-max(hd, 0.0) / (3.0 * px));
  c *= uDim;
  float a = cover(sdBox(q, hs, 0.002));
  return vec4(c * a, a);
}

/** The drop at the drip chamber's spout, swollen to uVal.x and fallen uVal.y of the way to the pool. */
vec4 drop(vec2 q) {
  vec2 hs = uBox.zw;
  float spout = hs.y * 0.82;
  float pool = -hs.y * 0.35;
  float R = hs.x * 0.42 * max(uVal.x, 0.05);
  float y = mix(spout - R * 0.9, pool + R, uVal.y);
  vec2 d = q - vec2(0.0, y);
  // A swelling drop hangs from the spout, stretched a little.
  d.y /= 1.0 + 0.25 * uVal.x * (1.0 - uVal.y);
  float r = length(d) - R;
  float a = cover(r) * 0.75;
  vec3 c = vec3(0.8, 0.9, 1.0) * (0.7 + 0.4 * smoothstep(R, -R, d.x + d.y));
  c = mix(c, vec3(1.0), cover(length(d - vec2(-0.3, 0.35) * R) - R * 0.28));
  // The spout itself.
  float s = sdBox(q - vec2(0.0, spout + hs.y * 0.08), vec2(hs.x * 0.16, hs.y * 0.1), 0.0);
  vec4 o = vec4(vec3(0.85) * cover(s), cover(s));
  o = over(vec4(c * a, a), o);
  return o * uDim;
}

${CLOCK_HANDS_GLSL}

/** The clock's hands at uVal.xyz (hour, minute, second; clockwise from twelve), with their shadows. */
vec4 clockHands(vec2 q) {
  return clockHandsAt(q, uVal.xyz, uBox.z, vec3(0.05) * uDim, vec3(0.85, 0.08, 0.06) * uDim, false);
}

void main() {
  px = 1.0 / uRes.y;
  vec2 f = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 q = f - uBox.xy;
  if (uKind == ${String(KIND_SCREEN)}) {
    outColor = screen(q);
  } else if (uKind == ${String(KIND_DROP)}) {
    outColor = drop(q);
  } else {
    outColor = clockHands(q);
  }
}
`;

/** Packs the layout into the room shader's `uL` slots. */
function packLayout(l: RoomLayout, showClock: boolean, out: Float32Array): void {
  out.fill(0);
  const put = (slot: number, v: readonly number[]) => {
    out.set([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0], slot * 4);
  };
  put(0, l.screen);
  put(1, [l.clock[0], l.clock[1], l.clock[2], showClock ? 1 : 0]);
  put(2, l.board);
  put(3, l.chart);
  put(4, l.bag);
  put(5, l.drip);
  put(6, l.pump);
  put(7, l.oxygen);
  put(8, l.gloves);
  put(9, l.pillow);
  put(10, l.headboard);
  put(11, l.headwall);
  put(12, [l.pole, l.rail, l.curtain, l.aspect / 2]);
  put(13, l.rails);
}

/**
 * Propped up in a hospital bed: a pillow and headboard behind the speaker, a
 * bedside monitor on the wall to one side, and on the other a drip stand with
 * its bag, drip chamber and pump, a care board, an obs chart and a clock, with
 * the privacy curtain drawn back. The room is drawn once per resize or
 * setting change; each frame redraws the monitor's screen (its traces sweeping
 * across, its heart lighting with each beat and its numbers, redrawn on a
 * canvas only when one changes), the drop swelling and falling in the drip
 * chamber, and the clock's hands.
 */
export const hospital = defineEffect(hospitalMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);
      const roomProgram = program(ROOM_FRAGMENT);
      const compProgram = program(COMPOSITE_FRAGMENT);
      const gadgetProgram = program(GADGET_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ru = createUniforms(gl, roomProgram, ["uRes", "uSide", "uNight", "uL", "uBoard"]);
      const cu = createUniforms(gl, compProgram, ["uRoom"]);
      const gu = createUniforms(gl, gadgetProgram, [
        "uRes",
        "uKind",
        "uBox",
        "uVal",
        "uDim",
        "uText",
        "uTrace",
      ]);
      gl.useProgram(roomProgram);
      ru.i1("uBoard", 0);
      gl.useProgram(compProgram);
      cu.i1("uRoom", 0);
      gl.useProgram(gadgetProgram);
      gu.i1("uText", 0);
      gu.i1("uTrace", 1);
      gl.useProgram(null);

      const traceTable = scope.own(createColumnTable(gl, TRACE_COLUMNS, TRACE_CHANNELS));
      const board = createCanvasTexture(gl, scope);
      const screen = createCanvasTexture(gl, scope);
      const boardTex = board.texture;
      const screenTex = screen.texture;
      /** Draws on a fresh canvas of `w` x `h` and uploads it, or blanks the texture without a canvas. */
      const paint = (
        target: CanvasTexture,
        w: number,
        h: number,
        draw: (ctx: OffscreenCanvasRenderingContext2D) => void,
      ) => {
        target.upload(paintCanvas(w, h, draw));
      };

      let roomTarget: RenderTarget | null = null;
      scope.defer(() => {
        roomTarget?.dispose();
      });
      let width = 1;
      let height = 1;
      let layout = roomLayout(16 / 9);
      const slots = new Float32Array(SLOTS * 4);
      // What the cached room and textures were drawn for; NaN or null forces a redraw.
      let roomSide = Number.NaN;
      let roomNight = Number.NaN;
      let roomClock: boolean | null = null;
      let boardW = 0;
      let boardH = 0;
      let boardText: string | null = null;
      /** Set when only the board's writing changed: the room is redrawn round the board alone. */
      let boardOnly = false;
      const screenKey = createChangeKey(7);

      let time = 0;
      let monitor: Monitor | null = null;
      let monitorSeed = Number.NaN;
      const day = createDayClock();
      const hands = new Float64Array(3);
      const dropState = new Float64Array(2);

      /** Mirrors the room: 1, or -1 with the monitor on the right. */
      let side = 1;
      /** Texels for a texture `v` frame heights across, at twice the frame's resolution. */
      const px = (v: number) => Math.max(1, Math.min(MAX_TEXT_TEXELS, Math.round(2 * v * height)));
      /** Draws gadget `kind` in a scissor round its box, mirrored by `side`. Expects the gadget program bound. */
      const drawGadget = (kind: number, cx: number, cy: number, hw: number, hh: number) => {
        const x = side * cx;
        gu.i1("uKind", kind);
        gu.f4("uBox", x, cy, hw, hh);
        if (scissorBox(gl, width, height, x, cy, hw, hh)) {
          triangle.draw();
        }
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          roomTarget?.dispose();
          roomTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          layout = roomLayout(width / height);
          roomSide = Number.NaN;
          boardText = null;
          screenKey.invalidate();
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!roomTarget) {
            return;
          }
          side = p.monitor === "right" ? -1 : 1;
          const night = p.lighting === "night" ? 1 : 0;

          // 1. The monitor's model: new for a new variation, then run on.
          if (!monitor || p.seed !== monitorSeed) {
            monitorSeed = p.seed;
            monitor = createMonitor(p.seed, p.heartRate);
            screenKey.invalidate();
          } else {
            stepMonitor(monitor, step, p.heartRate);
          }
          traceTable.data.set(monitor.traces);
          gl.activeTexture(gl.TEXTURE1);
          traceTable.upload();
          gl.activeTexture(gl.TEXTURE0);

          // 2. The board's writing; the room is redrawn round the board with it.
          const [bx, by, bw, bh] = layout.board;
          const bpw = px(bw);
          const bph = px(bh);
          if (bpw !== boardW || bph !== boardH || p.board !== boardText) {
            boardW = bpw;
            boardH = bph;
            boardText = p.board;
            paint(board, bpw, bph, (ctx) => {
              drawBoard(ctx, bpw, bph, p.board);
            });
            boardOnly = true;
          }

          // 3. The room, when the size or a setting it shows changes; only the
          // board's box when only its writing did, as while it is being typed.
          const whole = side !== roomSide || night !== roomNight || p.clock !== roomClock;
          if (whole || boardOnly) {
            roomSide = side;
            roomNight = night;
            roomClock = p.clock;
            packLayout(layout, p.clock, slots);
            gl.useProgram(roomProgram);
            ru.f2("uRes", width, height);
            ru.f1("uSide", side);
            ru.f1("uNight", night);
            gl.uniform4fv(ru.loc.uL, slots);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, boardTex);
            roomTarget.bind();
            if (whole) {
              triangle.draw();
            } else {
              gl.enable(gl.SCISSOR_TEST);
              const m = BOARD_REACH;
              if (scissorBox(gl, width, height, side * bx, by, bw + m, bh + m)) {
                triangle.draw();
              }
              gl.disable(gl.SCISSOR_TEST);
            }
            boardOnly = false;
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 4. The screen's numbers, when one of them or the screen's size changes.
          const [scx, scy, shw, shh] = layout.screen;
          const spw = px(shw);
          const sph = px(shh);
          const vitals = monitor.vitals;
          screenKey.set(0, spw);
          screenKey.set(1, sph);
          screenKey.set(2, vitals.hr);
          screenKey.set(3, vitals.spo2);
          screenKey.set(4, vitals.rr);
          screenKey.set(5, vitals.sys);
          screenKey.set(6, vitals.dia);
          if (screenKey.take()) {
            paint(screen, spw, sph, (ctx) => {
              drawScreen(ctx, spw, sph, vitals);
            });
          }

          // 5. The room.
          gl.useProgram(compProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, roomTarget.texture);
          triangle.draw();

          // 6. The live parts, each in a scissor round its box.
          gl.useProgram(gadgetProgram);
          gu.f2("uRes", width, height);
          gu.f1("uDim", night ? 0.8 : 1);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, traceTable.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, screenTex);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.enable(gl.SCISSOR_TEST);
          gu.f4("uVal", monitor.cursor, heartFlash(monitor), 0, 0);
          drawGadget(KIND_SCREEN, scx, scy, shw, shh);
          dripDrop(time, dropState);
          const [dx, dy, dw, dh] = layout.drip;
          gu.f4("uVal", dropState[0], dropState[1], 0, 0);
          drawGadget(KIND_DROP, dx, dy, dw, dh);
          // The clock keeps time while hidden, so it shows the right time when it comes back.
          const dayTime = day.step(step, "local", 0, 0);
          if (p.clock) {
            clockHands(dayTime, hands);
            const [cx, cy, cr] = layout.clock;
            // Mirroring flips the room, not the clock: its hands still turn clockwise.
            gu.f4("uVal", hands[0], hands[1], hands[2], 0);
            drawGadget(KIND_HANDS, cx, cy, cr, cr);
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
