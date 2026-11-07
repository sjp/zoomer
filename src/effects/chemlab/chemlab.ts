import type { Rgb } from "../color";
import { createFlameMotion, flameAt } from "../candlelight/candle-sim";
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
  withScope,
} from "../gl";
import { BASE_RADIUS, EPS, fillBlobs, makeBlobs, REF_H } from "../lavalamp/lavalamp-blobs";
import { approach, clamp, wrap } from "../math";
import {
  buildFontTexture,
  GLYPH_COUNT,
  GLYPH_H,
  GLYPH_W,
  glyphIndex,
} from "../missioncontrol/missioncontrol-text";
import { createNoise, HASH32_GLSL } from "../noise";
import { riseSpeed } from "../bubbles/bubbles-sim";
import { createSmokeField, type SmokeField } from "../smoke/smoke-field";
import { simSteps, WAVE_COUNT, wavePhases } from "../smoke/smoke-sim";
import type { StepClock } from "../reaction/reaction-sim";
import { createSpriteBatch } from "../sprites";
import { defineEffect } from "../types";
import {
  BEAKER,
  BENCH_BACK,
  BENCH_FRONT,
  BENCH_Y,
  BOARD,
  BOARD_FRAME,
  BOTTLE,
  type Box,
  BURNER,
  COLOUR_RATE,
  CONDENSER_A,
  CONDENSER_B,
  CONDENSER_R,
  CONICAL,
  createDistillate,
  createReactions,
  CYLINDER,
  distillateAt,
  DROP,
  fitScale,
  FLAME,
  FLAME_H,
  FLAME_W,
  FLASK,
  JAR,
  labLayout,
  type LabLayout,
  liquidColour,
  MAX_PROPS,
  MAX_VESSELS,
  OUTLET,
  paletteFor,
  POSTER,
  PUFF_LIFE,
  PUFF_RADIUS,
  RACK,
  type Reactions,
  reactionGlow,
  reactionPuff,
  RECEIVER_H,
  SHELF_THICK,
  SHELVES,
  slewColours,
  STILL_H,
  STILL_TOP,
  stepReactions,
  TRIPOD,
  TRIPOD_H,
  TUBE,
  VAPOUR_BOXES,
  VAPOUR_CURL,
  VAPOUR_LIFE,
  VAPOUR_ONSET,
  VAPOUR_RADIUS,
  VAPOUR_RISE,
  VAPOUR_SCALE,
  vapourDraft,
  vapourEmitter,
  vapourGrid,
  vapourRegion,
} from "./chemlab-sim";
import { chemlabMeta } from "./chemlab.meta";

const g = glslFloat;
const v3 = (c: readonly number[]) => `vec3(${g(c[0])}, ${g(c[1])}, ${g(c[2])})`;
const v4 = (b: Box) => `vec4(${g(b[0])}, ${g(b[1])}, ${g(b[2])}, ${g(b[3])})`;
const v2 = (p: readonly number[]) => `vec2(${g(p[0])}, ${g(p[1])})`;

const TAU = Math.PI * 2;

/** The cylinder of glowing goo: the vessel kind the shader gives slow lava-lamp blobs. */
const LAVA = 7;
const LAVA_BLOBS = 5;
/** Lamp seconds per second: the goo moves a little faster than a lava lamp's wax. */
const LAVA_SPEED = 1.6;

/** The glass and liquid shader's clock wraps after this many seconds; every rate in it repeats within it. */
const PERIOD = 120;
/** Bubble columns in a heated flask: radii (px at 1080p), and whole trips up the liquid per PERIOD. */
const BUBBLE_R_PX = [3, 4.5, 3.5, 5.5, 4, 3];
/** Typical liquid depth (design units) the bubbles' trip times are set for. */
const BUBBLE_DEPTH = 0.06;
const BUBBLE_LAPS = BUBBLE_R_PX.map((r, i) =>
  Math.max(1, Math.round((PERIOD * riseSpeed(r)) / 1080 / BUBBLE_DEPTH) + i),
);
/** Unheated liquids' glow pulse: period (s, dividing PERIOD) and depth. */
const PULSE_PERIOD = 8;
const PULSE_DEPTH = 0.06;

/** The light map: its size, and the scale its values are stored at in 8 bits. */
const LIGHT_W = 192;
const LIGHT_H = 108;
const LIGHT_SCALE = 4;
const MAX_LIGHTS = MAX_VESSELS + 8;
/** A liquid's light: its strength for a reference area of liquid, and its reach. */
const LIGHT_GAIN = 0.6;
const LIGHT_AREA = 2 * 0.03 * 0.05;
const BURNER_RGB: Rgb = [0.3, 0.45, 1.0];
const BURNER_LIGHT = 0.3;

/** Seconds for the room lights to come up or go down. */
const LIGHTS_FADE = 1.5;
/** Burner flicker, as candle-sim's `flameAt` takes it: gentle. */
const FLICKER = 0.7;
/** The vapour's opacity at full density, and how fast the dense part fades with height. */
const VAPOUR_ALPHA = 0.5;
const VAPOUR_HEIGHT_DECAY = 0.5;
/** The bench mist's drift phases: radians a second, each a whole number of turns per PERIOD. */
const MIST_RATES = [TAU / 40, -TAU / 60, TAU / 24, -TAU / 30];

/** Floats per instance: box, liquid, look, more. */
const INSTANCE_FLOATS = 16;
const MAX_INSTANCES = MAX_VESSELS + 8;

/** Chalk on the blackboard: made-up formulas, at their lines' top-left corners. */
const CHALK_LINES: readonly (readonly [string, number, number])[] = [
  ["2KX + Q3", -0.238, 0.335],
  ["ZQ2X + 3H", -0.238, 0.298],
  ["T: 451 K", 0.118, 0.335],
  ["PH 7.4?", 0.118, 0.298],
  ["N = 0.37", -0.238, 0.07],
  ["X/Y = 42", 0.118, 0.07],
];
const CODE_W = 16;
/** The chalk's dot pitch (design units). */
const CHALK_DOT = 0.0027;

const SHARED_GLSL = /* glsl */ `
float px;
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
const float TAU = 6.28318530718;
const float BENCH_Y = ${g(BENCH_Y)};
const float BENCH_BACK = ${g(BENCH_BACK)};
const float BENCH_FRONT = ${g(BENCH_FRONT)};
`;

/** The room's ambient light, dim and with the lab lights on: shared by every pass that lights the room. */
const AMBIENT_GLSL = /* glsl */ `
uniform float uLab;
vec3 ambient(vec2 p) {
  vec3 dim = vec3(0.065, 0.078, 0.095) * (1.0 + 0.25 * smoothstep(0.5, -0.3, p.y));
  vec3 lab = vec3(0.93, 0.95, 1.0) * (0.86 + 0.18 * smoothstep(-0.5, 0.5, p.y));
  return mix(dim, lab, uLab);
}
/** How strongly the liquids' glow shows: much less against the lab lights. */
float glowGain() {
  return mix(1.0, 0.4, uLab);
}
`;

/**
 * The lab, drawn once per resize or variation with four samples per pixel:
 * each point's colour (its albedo with contact shadows), and in alpha how much
 * of the liquids' glow it catches. The tiled wall, the blackboard with its
 * chalk, the periodic table, the shelves and bench, the reagent bottles, racks,
 * burners and tripods, and the distillation's still head and condenser.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uK;
uniform vec4 uProps[${String(MAX_PROPS)}];
/** Kind, tone. */
uniform vec2 uPropInfo[${String(MAX_PROPS)}];
uniform int uPropCount;
/** Each vessel's box (x, base y, half width, height), for its shadow. */
uniform vec4 uVessels[${String(MAX_VESSELS)}];
uniform int uVesselCount;
uniform sampler2D uFont;
uniform sampler2D uCodes;
out vec4 outColor;
${HASH32_GLSL}
${SHARED_GLSL}
const vec4 BOARD = ${v4(BOARD)};
const float BOARD_FRAME = ${g(BOARD_FRAME)};
const vec4 POSTER = ${v4(POSTER)};
const float SHELF_THICK = ${g(SHELF_THICK)};
const vec3 SHELF0 = ${v3([SHELVES[0].x0, SHELVES[0].x1, SHELVES[0].y])};
const vec3 SHELF1 = ${v3([SHELVES[1].x0, SHELVES[1].x1, SHELVES[1].y])};
const vec3 SHELF2 = ${v3([SHELVES[2].x0, SHELVES[2].x1, SHELVES[2].y])};
const vec3 SHELF3 = ${v3([SHELVES[3].x0, SHELVES[3].x1, SHELVES[3].y])};
const vec2 STILL_TOP = ${v2(STILL_TOP)};
const vec2 COND_A = ${v2(CONDENSER_A)};
const vec2 COND_B = ${v2(CONDENSER_B)};
const float COND_R = ${g(CONDENSER_R)};
const vec2 OUTLET = ${v2(OUTLET)};
const float STILL_NECK = ${g(BENCH_Y + TRIPOD_H + STILL_H)};
const float CHALK_DOT = ${g(CHALK_DOT)};
const vec2 CHALK_POS[${String(CHALK_LINES.length)}] = vec2[${String(CHALK_LINES.length)}](${CHALK_LINES.map(([, x, y]) => v2([x, y])).join(", ")});

/** The surface so far: albedo, contact shadow, and how much of the liquids' glow it catches. */
vec3 alb;
float sh;
float rcv;

void lay(vec3 c, float a, float r) {
  alb = mix(alb, c, a);
  sh = mix(sh, 1.0, a);
  rcv = mix(rcv, r, a);
}
/** Glass over what's there: darker and slightly green, with bright edges. */
void glassOver(float inside, float edge) {
  alb = mix(alb, alb * vec3(0.8, 0.88, 0.86) + vec3(0.03), inside);
  alb = mix(alb, vec3(0.72, 0.8, 0.8), edge);
}
float rand(vec2 cell, uint salt) {
  uvec2 u = uvec2(ivec2(cell) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ salt))) / 4294967296.0;
}
float hash1(float x, uint salt) {
  return float(hash32(uint(int(x * 977.0) + 70000) ^ salt)) / 4294967296.0;
}

/** Glazed wall tiles, muted green, with a darker band at dado height. */
void wall(vec2 p) {
  vec2 cell = vec2(0.052, 0.052);
  vec2 u = p / cell;
  vec2 id = floor(u);
  vec2 f = (fract(u) - 0.5) * cell;
  float v = rand(id, 5u);
  vec3 c = vec3(0.36, 0.46, 0.4) * (0.92 + 0.12 * v);
  if (abs(p.y + 0.02) < 0.026) {
    c = vec3(0.17, 0.27, 0.23) * (0.92 + 0.12 * v);
  }
  // Each tile's glaze is a touch lighter towards its top left.
  c *= 0.95 + 0.08 * smoothstep(0.03, -0.03, f.x - f.y);
  float grout = max(abs(f.x), abs(f.y)) - cell.x * 0.5 + 0.0013;
  c = mix(c, vec3(0.5, 0.52, 0.48), smoothstep(-px, px, grout));
  alb = c;
  sh = 1.0;
  rcv = 1.0;
}

/** The bench: a dark slate top seen from just above, its rounded front edge, and wooden cupboards below. */
void bench(vec2 p) {
  if (p.y > BENCH_BACK + 0.012) {
    return;
  }
  // The upstand along the wall.
  float up = p.y - BENCH_BACK - 0.006;
  lay(vec3(0.1, 0.11, 0.115), cover(up), 1.0);
  vec3 slate = vec3(0.085, 0.095, 0.1) * (0.85 + 0.25 * rand(floor(p * vec2(160.0, 900.0)), 9u));
  slate *= 0.85 + 0.25 * smoothstep(BENCH_FRONT, BENCH_BACK, p.y);
  lay(slate, cover(p.y - BENCH_BACK), 1.0);
  // The rounded front edge catches the light.
  float edge = abs(p.y - BENCH_FRONT) - 0.006;
  lay(vec3(0.17, 0.18, 0.19) * (0.7 + 0.5 * smoothstep(-0.006, 0.006, p.y - BENCH_FRONT)), cover(edge), 1.0);
  if (p.y < BENCH_FRONT - 0.006) {
    vec3 wood = vec3(0.2, 0.12, 0.065) * (0.85 + 0.15 * sin(p.y * 900.0 + 6.0 * sin(p.x * 13.0)));
    // Cupboard doors and their gaps, with a small knob each.
    float pitch = 0.2;
    float dx = (fract(p.x / pitch) - 0.5) * pitch;
    float door = max(abs(dx) - pitch * 0.5 + 0.004, p.y - (BENCH_FRONT - 0.016));
    wood = mix(wood * 0.45, wood, cover(door));
    float knob = length(vec2(abs(dx) - 0.012, p.y - (BENCH_FRONT - 0.05))) - 0.004;
    wood = mix(wood, vec3(0.5, 0.42, 0.3), cover(knob));
    lay(wood, cover(p.y - BENCH_FRONT + 0.006), 0.6);
  }
}

/** A dot-matrix letter's dots as round chalk marks: the board's formulas. */
float chalkText(vec2 p) {
  float a = 0.0;
  for (int i = 0; i < ${String(CHALK_LINES.length)}; i++) {
    vec2 l = (p - CHALK_POS[i]) / CHALK_DOT;
    if (l.x < 0.0 || l.y > 0.0 || l.y <= -7.0 || l.x >= ${g(CODE_W * 6)}) {
      continue;
    }
    int col = int(l.x) / 6;
    int dx = int(l.x) - col * 6;
    int dy = int(-l.y);
    if (dx >= ${String(GLYPH_W)}) {
      continue;
    }
    int code = int(texelFetch(uCodes, ivec2(col, i), 0).r * 255.0 + 0.5);
    float lit = texelFetch(uFont, ivec2(code * ${String(GLYPH_W)} + dx, ${String(GLYPH_H - 1)} - dy), 0).r;
    vec2 f = vec2(fract(l.x), fract(-l.y)) - 0.5;
    a = max(a, lit * (1.0 - smoothstep(0.35, 0.65, length(f))));
  }
  return a;
}

/** Chalk lines: a hexagonal ring with a circle in it, arrows, a sketched flask and underlines. */
float chalkMarks(vec2 p) {
  float d = 1.0;
  // A hexagonal ring.
  vec2 hc = p - vec2(-0.19, 0.18);
  for (int i = 0; i < 6; i++) {
    float a0 = TAU * float(i) / 6.0 + 0.5236;
    float a1 = a0 + TAU / 6.0;
    d = min(d, sdSeg(hc, 0.034 * vec2(cos(a0), sin(a0)), 0.034 * vec2(cos(a1), sin(a1))));
    // A side chain off one corner.
    if (i == 1) {
      vec2 c = 0.034 * vec2(cos(a0), sin(a0));
      d = min(d, sdSeg(hc, c, c + vec2(0.0, 0.026)));
    }
  }
  d = min(d, abs(length(hc) - 0.019));
  // An arrow after the first formula.
  d = min(d, sdSeg(p, vec2(-0.072, 0.326), vec2(-0.102, 0.326)));
  d = min(d, sdSeg(p, vec2(-0.072, 0.326), vec2(-0.081, 0.333)));
  d = min(d, sdSeg(p, vec2(-0.072, 0.326), vec2(-0.081, 0.319)));
  // An underline.
  d = min(d, sdSeg(p, vec2(0.118, 0.27), vec2(0.215, 0.272)));
  // A flask sketched on the right.
  vec2 fq = p - vec2(0.19, 0.13);
  d = min(d, sdSeg(fq, vec2(-0.008, 0.06), vec2(-0.008, 0.035)));
  d = min(d, sdSeg(fq, vec2(0.008, 0.06), vec2(0.008, 0.035)));
  d = min(d, sdSeg(fq, vec2(-0.008, 0.035), vec2(-0.035, -0.02)));
  d = min(d, sdSeg(fq, vec2(0.008, 0.035), vec2(0.035, -0.02)));
  d = min(d, sdSeg(fq, vec2(-0.035, -0.02), vec2(0.035, -0.02)));
  d = min(d, sdSeg(fq, vec2(-0.022, 0.006), vec2(0.022, 0.006)));
  // A curve, as of a rate against time, low on the left.
  vec2 gq = p - vec2(-0.235, -0.005);
  d = min(d, sdSeg(gq, vec2(0.0, 0.0), vec2(0.0, 0.05)));
  d = min(d, sdSeg(gq, vec2(0.0, 0.0), vec2(0.08, 0.0)));
  float gx = clamp(gq.x, 0.0, 0.075);
  d = min(d, length(gq - vec2(gx, 0.045 * (1.0 - exp(-gx / 0.02)))));
  return 1.0 - smoothstep(0.0011, 0.0011 + px * 1.5, d);
}

/** The blackboard: a wooden frame, dark slate with eraser smudges, the chalk, and the tray. */
void blackboard(vec2 p) {
  vec2 q = p - BOARD.xy;
  float outer = sdBox(q, BOARD.zw + BOARD_FRAME, 0.003);
  if (outer > 0.04) {
    return;
  }
  sh *= 1.0 - 0.4 * (1.0 - smoothstep(-0.005, 0.03, sdBox(q - vec2(0.006, -0.01), BOARD.zw + BOARD_FRAME, 0.003)));
  vec3 wood = vec3(0.3, 0.18, 0.09) * (0.85 + 0.15 * sin((abs(q.x) > BOARD.z ? q.y : q.x) * 700.0));
  lay(wood, cover(outer), 0.9);
  float inner = sdBox(q, BOARD.zw, 0.0);
  if (inner < px) {
    vec3 board = vec3(0.075, 0.105, 0.09);
    // Old chalk wiped round and round.
    float smudge = 0.5 + 0.5 * sin(q.x * 31.0 + 3.0 * sin(q.y * 23.0)) * sin(q.y * 17.0 - 2.0 * sin(q.x * 11.0));
    board += vec3(0.05) * smudge * smudge;
    float chalk = max(chalkText(p), chalkMarks(p));
    chalk *= 0.7 + 0.3 * rand(floor(p * 2400.0), 77u);
    board = mix(board, vec3(0.82, 0.84, 0.8), chalk * 0.85);
    lay(board, cover(inner), 0.9);
  }
  // The chalk tray, with a stick of chalk and a duster.
  vec2 tq = q - vec2(0.0, -BOARD.w - BOARD_FRAME - 0.004);
  lay(vec3(0.34, 0.21, 0.11) * (0.8 + 0.3 * smoothstep(-0.005, 0.005, tq.y)), cover(sdBox(tq, vec2(BOARD.z * 0.8, 0.005), 0.002)), 0.9);
  lay(vec3(0.85, 0.85, 0.8), cover(sdBox(tq - vec2(-0.12, 0.007), vec2(0.012, 0.0025), 0.0024)), 0.9);
  lay(vec3(0.25, 0.2, 0.17), cover(sdBox(tq - vec2(0.15, 0.011), vec2(0.024, 0.006), 0.002)), 0.9);
}

/** The periodic table: our own simplified grid of coloured blocks on a cream poster. */
void poster(vec2 p) {
  vec2 q = p - POSTER.xy;
  vec2 hs = POSTER.zw;
  float d = sdBox(q, hs, 0.0);
  if (d > 0.03) {
    return;
  }
  sh *= 1.0 - 0.3 * (1.0 - smoothstep(-0.004, 0.02, sdBox(q - vec2(0.004, -0.008), hs, 0.0)));
  vec3 c = vec3(0.82, 0.79, 0.69);
  // The title: a dark band of "lettering".
  vec2 tq = q - vec2(0.0, hs.y - 0.016);
  float letters = step(abs(tq.y), 0.004) * step(abs(tq.x), 0.07) * step(0.3, fract(tq.x * 140.0));
  c = mix(c, vec3(0.2, 0.18, 0.2), letters);
  // The grid: 18 columns and 7 rows, then two detached rows.
  float cellW = (2.0 * hs.x - 0.02) / 18.0;
  vec2 g0 = vec2(-hs.x + 0.01, hs.y - 0.03);
  vec2 gq = vec2(q.x - g0.x, g0.y - q.y) / cellW;
  int col = int(floor(gq.x));
  int row = int(floor(gq.y));
  vec2 f = fract(gq) - 0.5;
  bool on = false;
  vec3 block = vec3(0.0);
  if (gq.x >= 0.0 && col < 18 && gq.y >= 0.0 && row < 7) {
    on = row == 0 ? (col == 0 || col == 17) : row < 3 ? (col < 2 || col > 11) : true;
    block = col == 0 ? vec3(0.86, 0.46, 0.44) : col == 1 ? vec3(0.9, 0.66, 0.4) : col < 12 ? vec3(0.46, 0.6, 0.84) : col < 17 ? vec3(0.78, 0.8, 0.46) : vec3(0.66, 0.56, 0.84);
    if (row == 0 && col == 0) {
      block = vec3(0.5, 0.78, 0.5);
    }
    if (col >= 12 && col < 17 && float(col - 12) < float(row) * 0.9 - 0.5) {
      block = vec3(0.5, 0.74, 0.62);
    }
  }
  float fy = gq.y - 7.5;
  if (gq.x >= 2.0 && gq.x < 17.0 && fy >= 0.0 && fy < 2.0) {
    on = true;
    f = vec2(fract(gq.x), fract(fy)) - 0.5;
    block = vec3(0.48, 0.76, 0.72);
  }
  if (on) {
    float cell = max(abs(f.x), abs(f.y)) - 0.43;
    vec3 bc = block;
    // A tiny dark "symbol" in each cell.
    bc = mix(bc, bc * 0.45, step(abs(f.x), 0.18) * step(abs(f.y + 0.05), 0.16));
    c = mix(c, bc, smoothstep(px / cellW, -px / cellW, cell));
  }
  lay(c, cover(d), 0.9);
}

/** A shelf: the plank, its front edge, two brackets, and its shadow on the tiles. */
void shelf(vec2 p, vec3 s) {
  if (p.x < s.x - 0.03 || p.x > s.y + 0.03 || abs(p.y - s.z) > 0.06) {
    return;
  }
  float mid = 0.5 * (s.x + s.y);
  float half_ = 0.5 * (s.y - s.x);
  sh *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.035, sdBox(p - vec2(mid + 0.004, s.z - SHELF_THICK - 0.008), vec2(half_, 0.006), 0.004)));
  for (int i = 0; i < 2; i++) {
    float bx = i == 0 ? s.x + 0.05 : s.y - 0.05;
    vec2 bq = p - vec2(bx, s.z - SHELF_THICK);
    lay(vec3(0.16, 0.16, 0.15), cover(sdBox(bq - vec2(0.0, -0.022), vec2(0.0035, 0.022), 0.001)), 0.8);
  }
  vec2 q = p - vec2(mid, s.z - SHELF_THICK * 0.5);
  float plank = sdBox(q, vec2(half_, SHELF_THICK * 0.5), 0.0015);
  vec3 wood = vec3(0.36, 0.22, 0.11) * (0.82 + 0.12 * sin(q.x * 380.0 + 4.0 * sin(q.x * 37.0)));
  wood *= 0.75 + 0.35 * smoothstep(-SHELF_THICK * 0.5, SHELF_THICK * 0.5, q.y);
  lay(wood, cover(plank), 0.9);
}

/** A label: cream paper with a coloured band and lines of "writing" (never a real hazard sign). */
vec3 label(vec2 q, vec2 hs, float tone) {
  vec3 c = vec3(0.86, 0.83, 0.74);
  vec3 band = tone < 0.25 ? vec3(0.7, 0.2, 0.18) : tone < 0.5 ? vec3(0.2, 0.35, 0.65) : tone < 0.75 ? vec3(0.25, 0.55, 0.3) : vec3(0.8, 0.62, 0.15);
  c = mix(c, band, step(hs.y * 0.55, q.y));
  // Lines of "writing": short dark bars of made-up lengths.
  float row = (q.y + hs.y) / (hs.y * 0.45);
  float line = fract(row);
  float len = hs.x * (0.5 + 0.4 * hash1(floor(row) + tone * 13.0, 21u));
  float x0 = -0.75 * hs.x;
  float ink = step(0.4, line) * step(line, 0.62) * step(x0, q.x) * step(q.x, x0 + 1.5 * len) * step(q.y, hs.y * 0.45);
  return mix(c, vec3(0.2, 0.17, 0.15), ink * 0.85);
}

/** A brown reagent bottle with a stopper and a label. */
void bottle(vec2 p, vec4 b, float tone) {
  vec2 q = p - b.xy;
  float w = b.z;
  float h = b.w;
  float shoulder = 0.62 * h;
  float neckW = 0.36 * w;
  float t = clamp((q.y - shoulder) / (0.2 * h), 0.0, 1.0);
  float hw = q.y < shoulder ? w : mix(w, neckW, t * t * (3.0 - 2.0 * t));
  float body = max(abs(q.x) - hw, max(-q.y, q.y - 0.86 * h));
  float stopper = sdBox(q - vec2(0.0, 0.9 * h), vec2(neckW * 1.25, 0.06 * h), 0.002);
  float u = clamp(q.x / hw, -1.0, 1.0);
  vec3 glass = vec3(0.24, 0.12, 0.045) * (0.55 + 0.6 * sqrt(1.0 - u * u));
  glass += vec3(0.35, 0.25, 0.15) * exp(-pow((u + 0.5) / 0.1, 2.0));
  lay(glass, cover(body), 1.0);
  vec2 lq = q - vec2(0.0, 0.34 * h);
  vec2 lhs = vec2(0.8 * w, 0.2 * h);
  if (sdBox(lq, lhs, 0.0) < px) {
    lay(label(lq, lhs, tone) * (0.75 + 0.3 * sqrt(1.0 - u * u)), cover(sdBox(lq, lhs, 0.0)), 1.0);
  }
  vec3 cork = tone < 0.5 ? vec3(0.45, 0.32, 0.2) : vec3(0.12, 0.1, 0.09);
  lay(cork * (0.7 + 0.4 * smoothstep(-neckW, neckW, -q.x)), cover(stopper), 1.0);
}

/** A wide jar with a screw lid and a label. */
void jar(vec2 p, vec4 b, float tone) {
  vec2 q = p - b.xy;
  float w = b.z;
  float h = b.w;
  float body = sdBox(q - vec2(0.0, 0.42 * h), vec2(w, 0.42 * h), 0.004);
  float lid = sdBox(q - vec2(0.0, 0.92 * h), vec2(0.88 * w, 0.08 * h), 0.002);
  float u = clamp(q.x / w, -1.0, 1.0);
  vec3 glass = (tone > 0.6 ? vec3(0.5, 0.48, 0.44) : vec3(0.22, 0.11, 0.04)) * (0.55 + 0.6 * sqrt(1.0 - u * u));
  glass += vec3(0.3, 0.24, 0.16) * exp(-pow((u + 0.55) / 0.1, 2.0));
  lay(glass, cover(body), 1.0);
  vec2 lq = q - vec2(0.0, 0.4 * h);
  vec2 lhs = vec2(0.75 * w, 0.22 * h);
  if (sdBox(lq, lhs, 0.0) < px) {
    lay(label(lq, lhs, fract(tone * 3.7)) * (0.75 + 0.3 * sqrt(1.0 - u * u)), cover(sdBox(lq, lhs, 0.0)), 1.0);
  }
  lay(vec3(0.15, 0.15, 0.16) * (0.7 + 0.5 * smoothstep(-0.006, 0.006, q.y - 0.92 * h)), cover(lid), 1.0);
}

/** A wooden test-tube rack: two rails on end posts (the tubes stand in front). */
void rack(vec2 p, vec4 b) {
  vec2 q = p - b.xy;
  vec3 wood = vec3(0.42, 0.27, 0.14);
  float posts = max(abs(abs(q.x) - b.z + 0.004) - 0.004, max(-q.y, q.y - b.w));
  float rail = min(abs(q.y - 0.72 * b.w) - 0.004, abs(q.y - 0.004) - 0.004);
  rail = max(rail, abs(q.x) - b.z);
  lay(wood * (0.8 + 0.2 * smoothstep(0.0, b.w, q.y)), cover(min(posts, rail)), 1.0);
}

/** A gas burner: a metal barrel with an air collar on a round foot, and its hose to the bench's back. */
void burner(vec2 p, vec4 b) {
  vec2 q = p - b.xy;
  float hose = abs(length((q - vec2(0.03, 0.01)) * vec2(1.0, 2.2)) - 0.025) - 0.0025;
  hose = max(hose, -q.y + 0.004);
  lay(vec3(0.42, 0.14, 0.08), cover(hose) * step(0.0, q.x), 1.0);
  float u = clamp(q.x / b.z, -1.0, 1.0);
  vec3 metal = vec3(0.5, 0.48, 0.45) * (0.45 + 0.7 * sqrt(1.0 - u * u)) + vec3(0.25) * exp(-pow((u + 0.45) / 0.12, 2.0));
  float barrel = sdBox(q - vec2(0.0, b.w * 0.5), vec2(b.z, b.w * 0.5), 0.001);
  lay(metal, cover(barrel), 1.0);
  float collar = sdBox(q - vec2(0.0, 0.016), vec2(b.z * 1.3, 0.005), 0.001);
  lay(metal * 0.8, cover(collar), 1.0);
  float foot = sdBox(q - vec2(0.0, 0.004), vec2(b.z * 2.3, 0.004), 0.003);
  lay(vec3(0.16, 0.16, 0.17) * (0.7 + 0.4 * smoothstep(-0.004, 0.004, q.y - 0.004)), cover(foot), 1.0);
}

/** A tripod with a wire gauze: two splayed legs in view and the gauze on top. */
void tripod(vec2 p, vec4 b) {
  vec2 q = p - b.xy;
  float legs = min(sdSeg(q, vec2(-b.z * 0.85, b.w - 0.004), vec2(-b.z * 1.1, 0.0)), sdSeg(q, vec2(b.z * 0.85, b.w - 0.004), vec2(b.z * 1.1, 0.0))) - 0.0022;
  legs = min(legs, sdSeg(q, vec2(0.0, b.w - 0.004), vec2(0.004, 0.003)) - 0.0018);
  lay(vec3(0.13, 0.13, 0.14), cover(legs), 1.0);
  float ring = sdBox(q - vec2(0.0, b.w - 0.004), vec2(b.z, 0.0025), 0.001);
  lay(vec3(0.18, 0.18, 0.19), cover(ring), 1.0);
  float gauze = sdBox(q - vec2(0.0, b.w - 0.001), vec2(b.z * 1.05, 0.0012), 0.0);
  vec3 mesh = mix(vec3(0.4, 0.4, 0.38), vec3(0.62, 0.6, 0.55), step(0.5, fract(q.x * 900.0)));
  lay(mesh, cover(gauze), 1.0);
}

/** The distillation's glass: the still head and the condenser with its coil, held by a clamp on a stand. */
void still(vec2 p) {
  if (p.x < STILL_TOP.x - 0.04 || p.x > OUTLET.x + 0.04 || p.y > STILL_TOP.y + 0.04 || p.y < BENCH_Y - 0.01) {
    return;
  }
  // The retort stand: a rod from a heavy base, and a clamp round the condenser.
  vec2 mid = mix(COND_A, COND_B, 0.5);
  float rodX = mid.x + 0.03;
  float rod = max(abs(p.x - rodX) - 0.0028, max(BENCH_Y - p.y, p.y - mid.y - 0.06));
  lay(vec3(0.3, 0.3, 0.31) * (0.7 + 0.5 * smoothstep(0.003, -0.003, p.x - rodX)), cover(rod), 1.0);
  lay(vec3(0.12, 0.12, 0.13), cover(sdBox(p - vec2(rodX, BENCH_Y + 0.004), vec2(0.035, 0.004), 0.002)), 1.0);
  float arm = sdSeg(p, vec2(rodX, mid.y + 0.02), mid + vec2(0.0, 0.006)) - 0.0024;
  lay(vec3(0.28, 0.28, 0.3), cover(arm), 1.0);
  // Water hoses into the jacket.
  vec2 axis = normalize(COND_B - COND_A);
  vec2 nrm = vec2(-axis.y, axis.x);
  vec2 in0 = COND_B - axis * 0.02 - nrm * COND_R;
  vec2 out0 = COND_A + axis * 0.02 + nrm * COND_R;
  float hoses = min(sdSeg(p, in0, in0 + vec2(0.02, -0.07)), sdSeg(p, out0, out0 + vec2(-0.004, 0.035))) - 0.003;
  lay(vec3(0.4, 0.16, 0.1), cover(hoses), 1.0);
  // The still head: up from the flask's neck, then across into the condenser.
  float tube = min(sdSeg(p, vec2(STILL_TOP.x, STILL_NECK), STILL_TOP), sdSeg(p, STILL_TOP, COND_A)) - 0.0055;
  // The thermometer's stem in the head.
  float therm = sdSeg(p, STILL_TOP + vec2(0.0, 0.035), STILL_TOP + vec2(0.0, -0.02)) - 0.0016;
  // The jacket, its inner coil, and the outlet bending down.
  vec2 cq = vec2(dot(p - COND_A, axis), dot(p - COND_A, nrm));
  float len = length(COND_B - COND_A);
  float jacket = max(abs(cq.y) - COND_R, abs(cq.x - len * 0.5) - len * 0.5);
  float coil = abs(cq.y - COND_R * 0.6 * sin(cq.x * 260.0)) - 0.0011;
  coil = max(coil, abs(cq.x - len * 0.5) - len * 0.5 + 0.01);
  float outlet = min(sdSeg(p, COND_B, COND_B + axis * 0.015), sdSeg(p, COND_B + axis * 0.015, OUTLET + vec2(0.0, 0.004))) - 0.0045;
  float glass = min(min(tube, jacket), outlet);
  float inside = cover(glass);
  float edge = cover(abs(glass + 0.0012) - 0.0011);
  glassOver(inside, edge * 0.6);
  lay(vec3(0.6, 0.66, 0.66), cover(coil) * 0.6, 1.0);
  lay(vec3(0.7, 0.72, 0.74), cover(therm), 1.0);
  lay(vec3(0.75, 0.1, 0.08), cover(sdSeg(p, STILL_TOP + vec2(0.0, -0.012), STILL_TOP + vec2(0.0, -0.02)) - 0.0016), 1.0);
  // The thermometer's top and the joints' grey sleeves.
  lay(vec3(0.5, 0.52, 0.52), cover(sdBox(p - STILL_TOP - vec2(0.0, 0.036), vec2(0.004, 0.003), 0.001)), 1.0);
}

/** A soft shadow round the foot of anything standing on a shelf or the bench. */
void footShadow(vec2 p, vec4 b, float k) {
  vec2 d = (p - vec2(b.x + 0.006, b.y + 0.002)) / vec2(b.z * 1.3 + 0.012, 0.012);
  sh *= 1.0 - k * exp(-dot(d, d));
  // And on the wall behind something tall.
  vec2 w = (p - vec2(b.x + 0.012, b.y + b.w * 0.5)) / vec2(b.z + 0.01, b.w * 0.55);
  sh *= 1.0 - 0.18 * k * exp(-dot(w, w) * 2.0);
}

void props(vec2 p) {
  for (int i = 0; i < ${String(MAX_VESSELS)}; i++) {
    if (i >= uVesselCount) {
      break;
    }
    vec4 b = uVessels[i];
    if (abs(p.x - b.x) < b.z * 2.0 + 0.04 && p.y > b.y - 0.03 && p.y < b.y + b.w + 0.02) {
      footShadow(p, b, 0.5);
    }
  }
  for (int i = 0; i < ${String(MAX_PROPS)}; i++) {
    if (i >= uPropCount) {
      break;
    }
    vec4 b = uProps[i];
    if (abs(p.x - b.x) > b.z * 2.4 + 0.04 || p.y < b.y - 0.03 || p.y > b.y + b.w + 0.01) {
      continue;
    }
    int kind = int(uPropInfo[i].x + 0.5);
    float tone = uPropInfo[i].y;
    if (kind == ${String(BOTTLE)}) {
      footShadow(p, b, 0.5);
      bottle(p, b, tone);
    } else if (kind == ${String(JAR)}) {
      footShadow(p, b, 0.5);
      jar(p, b, tone);
    } else if (kind == ${String(RACK)}) {
      footShadow(p, b, 0.4);
      rack(p, b);
    } else if (kind == ${String(BURNER)}) {
      burner(p, b);
    } else if (kind == ${String(TRIPOD)}) {
      tripod(p, b);
    }
  }
}

vec4 room(vec2 p) {
  wall(p);
  blackboard(p);
  poster(p);
  shelf(p, SHELF0);
  shelf(p, SHELF1);
  shelf(p, SHELF2);
  shelf(p, SHELF3);
  bench(p);
  still(p);
  props(p);
  return vec4(alb * sh, rcv);
}

void main() {
  px = 1.0 / (uRes.y * uK);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    vec2 f = (gl_FragCoord.xy + o - 0.5 * uRes) / uRes.y;
    sum += room(f / uK);
  }
  outColor = sum * 0.25;
}
`;

/**
 * The glow the liquids and burners cast on the room, at low resolution: a
 * soft pool round each light. Redrawn only when a light changes.
 */
const LIGHT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uSize;
/** Design units per frame unit, and the frame's aspect. */
uniform vec2 uKA;
/** Each light: x, y, reach, unused; and its colour times its strength. */
uniform vec4 uLights[${String(MAX_LIGHTS)}];
uniform vec3 uLightRgb[${String(MAX_LIGHTS)}];
uniform int uCount;
out vec4 outColor;
void main() {
  vec2 f = (gl_FragCoord.xy / uSize - 0.5) * vec2(uKA.y, 1.0);
  vec2 p = f / uKA.x;
  vec3 c = vec3(0.0);
  for (int i = 0; i < ${String(MAX_LIGHTS)}; i++) {
    if (i >= uCount) {
      break;
    }
    vec4 l = uLights[i];
    vec2 d = (p - l.xy) * vec2(1.0, 0.85);
    float r2 = dot(d, d) / (l.z * l.z);
    c += uLightRgb[i] * (0.7 * exp(-r2) + 0.3 * exp(-sqrt(r2) * 0.45));
  }
  outColor = vec4(c / ${g(LIGHT_SCALE)}, 1.0);
}
`;

/** Every frame: the cached room lit by the ambient light and the liquids' glow. */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uLight;
uniform vec2 uRes;
uniform float uK;
out vec4 outColor;
${DITHER_GLSL}
${AMBIENT_GLSL}
void main() {
  vec4 a = texelFetch(uRoom, ivec2(gl_FragCoord.xy), 0);
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 lm = texture(uLight, uv).rgb * ${g(LIGHT_SCALE)};
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y / uK;
  vec3 c = a.rgb * (ambient(p) + lm * glowGain() * a.a);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * The glassware, one tight quad per vessel, flame and drop. Positions are in
 * design units; `vQ` is the point relative to the vessel's base centre.
 */
const VESSEL_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** x, base y, half width, height (design units). */
layout(location = 1) in vec4 aBox;
/** Liquid colour, and its level above the base. */
layout(location = 2) in vec4 aLiquid;
/** Kind, glow, bubbles, phase. */
layout(location = 3) in vec4 aLook;
/** Liquid opacity, a flame's sway. */
layout(location = 4) in vec4 aMore;
uniform float uK;
uniform float uAspect;
out vec2 vQ;
flat out vec4 vBox;
flat out vec4 vLiquid;
flat out vec4 vLook;
flat out vec4 vMore;
void main() {
  int kind = int(aLook.x + 0.5);
  float pad = 0.006;
  float hx = aBox.z + pad;
  float y0 = aBox.y - pad;
  float y1 = aBox.y + aBox.w + pad;
  if (kind == ${String(CYLINDER)} || kind == ${String(LAVA)}) {
    hx = aBox.z * 1.9 + pad;
  } else if (kind == ${String(FLAME)}) {
    hx = aBox.z * 1.6 + abs(aMore.y) * aBox.w + pad;
  } else if (kind == ${String(DROP)}) {
    hx = aBox.z * 1.5 + pad;
    y0 = aBox.y - aBox.z * 1.5 - pad;
    y1 = aBox.y + aBox.z * 2.5 + pad;
  }
  vec2 c = aCorner * 0.5 + 0.5;
  vec2 p = vec2(aBox.x + (2.0 * c.x - 1.0) * hx, mix(y0, y1, c.y));
  vQ = p - aBox.xy;
  vBox = aBox;
  vLiquid = aLiquid;
  vLook = aLook;
  vMore = aMore;
  gl_Position = vec4(p * uK * vec2(2.0 / uAspect, 2.0), 0.0, 1.0);
}
`;

const VESSEL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vQ;
flat in vec4 vBox;
flat in vec4 vLiquid;
flat in vec4 vLook;
flat in vec4 vMore;
uniform vec2 uRes;
uniform float uK;
uniform sampler2D uRoom;
uniform sampler2D uLight;
/** Seconds, wrapped to the period every rate here repeats in. */
uniform float uTime;
uniform float uBubbling;
uniform vec4 uBlobs[${String(LAVA_BLOBS)}];
uniform float uBlobR2[${String(LAVA_BLOBS)}];
/** The goo column's width in lamp units, and its pool's radius squared. */
uniform vec2 uLavaW;
out vec4 outColor;
${SHARED_GLSL}
${AMBIENT_GLSL}
const float LAPS[6] = float[6](${BUBBLE_LAPS.map((n) => g(n)).join(", ")});
const float BUBBLE_R[6] = float[6](${BUBBLE_R_PX.map((r) => g(r / 1080)).join(", ")});

/** The room behind a design point, lit as the composite lights it. */
vec3 roomAt(vec2 p) {
  vec2 uv = (p * uK * uRes.y + 0.5 * uRes) / uRes;
  vec4 a = texture(uRoom, uv);
  vec3 lm = texture(uLight, uv).rgb * ${g(LIGHT_SCALE)};
  return a.rgb * (ambient(p) + lm * glowGain() * a.a);
}
vec3 lightAt(vec2 p) {
  vec2 uv = (p * uK * uRes.y + 0.5 * uRes) / uRes;
  return texture(uLight, uv).rgb * ${g(LIGHT_SCALE)};
}
float hashf(float x) {
  return fract(sin(x * 127.1 + 311.7) * 43758.5453);
}

/**
 * The vessel's outline (signed distance, design units), the profile's half
 * width at this height (for shading it as a solid of revolution), and the
 * inside bottom, where the liquid starts.
 */
vec3 shape(int kind, vec2 q, float w, float h) {
  if (kind == ${String(BEAKER)}) {
    float d = sdBox(q - vec2(0.0, h * 0.5), vec2(w, h * 0.5), 0.003);
    // A little spout at the rim.
    d = min(d, length(q - vec2(-w, h - 0.002)) - 0.003);
    return vec3(d, w, 0.004);
  }
  if (kind == ${String(CONICAL)}) {
    float n = 0.32 * w;
    float yn = 0.6 * h;
    float slope = (w - n) / yn;
    float hw = q.y < yn ? mix(w, n, max(q.y, 0.0) / yn) : n;
    float body = max((abs(q.x) - mix(w, n, q.y / yn)) / sqrt(1.0 + slope * slope), max(-q.y, q.y - yn));
    float neck = max(abs(q.x) - n, max(yn - 0.004 - q.y, q.y - h));
    float lip = sdBox(q - vec2(0.0, h - 0.002), vec2(n * 1.25, 0.002), 0.001);
    return vec3(min(min(body, neck), lip), hw, 0.004);
  }
  if (kind == ${String(FLASK)}) {
    float cy = 0.92 * w;
    float n = 0.3 * w;
    float bulb = max(length(q - vec2(0.0, cy)) - w, -q.y);
    float neck = max(abs(q.x) - n, max(cy - q.y, q.y - h));
    float lip = sdBox(q - vec2(0.0, h - 0.002), vec2(n * 1.3, 0.002), 0.001);
    float dy = q.y - cy;
    float r2 = w * w - dy * dy;
    float hw = q.y > cy && r2 < n * n ? n : sqrt(max(r2, n * n));
    return vec3(min(min(bulb, neck), lip), hw, 0.004);
  }
  if (kind == ${String(TUBE)}) {
    float d = q.y < w ? length(q - vec2(0.0, w)) - w : abs(q.x) - w;
    d = max(d, q.y - h);
    d = min(d, sdBox(q - vec2(0.0, h - 0.0015), vec2(w * 1.25, 0.0015), 0.0008));
    float hw = q.y < w ? sqrt(max(w * w - (q.y - w) * (q.y - w), 1e-8)) : w;
    return vec3(d, hw, 0.002);
  }
  // A cylinder on a wide foot.
  float foot = 0.035 * h;
  float d = min(sdBox(q - vec2(0.0, (h + foot) * 0.5), vec2(w, (h - foot) * 0.5), 0.002), sdBox(q - vec2(0.0, foot * 0.5), vec2(w * 1.9, foot * 0.5), 0.002));
  return vec3(d, q.y < foot ? w * 1.9 : w, foot + 0.003);
}

/** A burner's flame: a soft blue cone with a brighter inner cone, swaying a little. Added on top. */
vec4 flame(vec2 q) {
  float h = vBox.w;
  float v = q.y / h;
  if (v < 0.0 || v > 1.0) {
    return vec4(0.0);
  }
  float x = q.x - vMore.y * v * v * h;
  float hw = vBox.z * (1.0 - v) * (0.55 + 0.9 * sqrt(v));
  float outer = smoothstep(hw + px, hw * 0.3, abs(x));
  float iv = v / 0.45;
  float ihw = vBox.z * 0.55 * max(1.0 - iv, 0.0) * (0.6 + 0.6 * sqrt(iv));
  float inner = iv < 1.0 ? smoothstep(ihw + px, ihw * 0.2, abs(x)) : 0.0;
  vec3 c = vLiquid.rgb * outer * 0.55 * (1.0 - 0.6 * v) + vec3(0.5, 0.75, 1.0) * inner * 0.7;
  return vec4(c * vLook.y, 0.0);
}

/** A drop of distillate: a glowing bead, slightly pointed on top. */
vec4 drop(vec2 q) {
  float r = vBox.z;
  float d = min(length(q) - r, max(length(q * vec2(1.0, 0.5)) - r * 0.75, -q.y));
  float a = cover(d);
  vec3 c = vLiquid.rgb * (0.7 + 0.5 * vLook.y) + vec3(0.35) * exp(-dot(q - vec2(-0.35, 0.35) * r, q - vec2(-0.35, 0.35) * r) / (0.1 * r * r));
  return vec4(c * a, a) * vMore.x;
}

vec4 vessel(int kind, vec2 q) {
  float w = vBox.z;
  float h = vBox.w;
  vec3 s = shape(kind == ${String(LAVA)} ? ${String(CYLINDER)} : kind, q, w, h);
  float a = cover(s.x);
  if (a <= 0.0) {
    return vec4(0.0);
  }
  float hw = max(s.y, 1e-4);
  vec2 p = vBox.xy + q;
  float u = clamp(q.x / hw, -1.0, 1.0);
  float nz = sqrt(1.0 - u * u);
  // The room behind, pulled towards the middle as a lens of glass and liquid would.
  vec3 behind = roomAt(p + vec2(-u * hw * 0.45, 0.0));
  vec3 lm = lightAt(p);
  vec3 c = behind * (0.74 + 0.14 * nz) * vec3(0.92, 1.0, 0.98);
  c *= 1.0 - 0.45 * smoothstep(0.7, 1.0, abs(u));

  // The liquid, up to its meniscus, which climbs the glass a little at the walls.
  vec3 L = vLiquid.rgb;
  float glow = vLook.y * (1.0 + ${g(PULSE_DEPTH)} * sin(TAU * (uTime / ${g(PULSE_PERIOD)} + vLook.w)) * step(vLook.z, 0.0));
  float level = vLiquid.w;
  float opacity = vMore.x;
  float bottom = s.z;
  float surf = level + 0.06 * hw * u * u * u * u;
  float inLiquid = cover(q.y - surf) * step(bottom, q.y) * cover(s.x + 0.0018) * opacity * step(bottom + 0.001, level);
  if (inLiquid > 0.0) {
    float lit = glow * glowGain() + 0.45 * uLab;
    vec3 liq = L * lit * (0.42 + 0.58 * nz) + behind * L * 0.3;
    // Brighter just under the surface, deeper colour lower down.
    liq *= 0.78 + 0.3 * smoothstep(level - 0.04, level, q.y);
    if (kind == ${String(LAVA)}) {
      // Slow blobs of brighter goo, as in the Lava Lamp.
      float depth = max(level - bottom, 1e-3);
      vec2 lp = vec2((q.x + w) / (2.0 * w) * uLavaW.x, (level - q.y) / depth * ${g(REF_H)});
      float field = 0.0;
      for (int i = 0; i < ${String(LAVA_BLOBS)}; i++) {
        vec4 b = uBlobs[i];
        vec2 o = lp * b.xy + b.zw;
        field += uBlobR2[i] / (dot(o, o) + ${g(EPS)});
      }
      float pd = max(0.0, ${g(REF_H)} - lp.y);
      field += uLavaW.y / (pd * pd + ${g(EPS)});
      vec3 wax = mix(L, vec3(1.0), 0.45) * lit * (0.6 + 0.5 * nz);
      liq = mix(liq * 0.6, wax, smoothstep(0.85, 1.15, field));
    }
    // Bubbles rising from the bottom of a heated flask.
    float bub = vLook.z;
    if (bub > 0.0) {
      for (int i = 0; i < 6; i++) {
        float wgt = clamp(uBubbling * 6.0 * bub - float(i), 0.0, 1.0);
        if (wgt <= 0.0) {
          break;
        }
        float hi = hashf(float(i) * 3.17 + vLook.w * 41.0);
        float lap = fract(uTime * LAPS[i] / ${g(PERIOD)} + hi);
        float by = bottom + 0.004 + lap * (level - bottom - 0.004);
        float bx = (hashf(hi * 13.7) * 2.0 - 1.0) * 0.6 * hw + 0.0015 * sin(TAU * (lap * 3.0 + hi));
        float r = BUBBLE_R[i] * (0.7 + 0.5 * lap);
        float bd = length(q - vec2(bx, by)) - r;
        float ring = cover(abs(bd) - 0.0007) + 0.25 * cover(bd);
        liq = mix(liq, mix(L, vec3(1.0), 0.6) * (0.5 + lit * 0.6), clamp(ring, 0.0, 1.0) * wgt * smoothstep(0.0, 0.1, 1.0 - lap));
      }
    }
    // The surface catches the light.
    float sl = exp(-pow((q.y - surf) / (1.4 * px), 2.0));
    liq += (L * 0.5 * lit + vec3(0.12 + 0.3 * uLab)) * sl;
    c = mix(c, liq, inLiquid);
  }

  // Bright rims down both walls, a highlight streak, and the glow of the liquid and anything near in the glass.
  float wall = (1.0 - abs(u)) * hw / px;
  float rim = exp(-wall * wall * 0.25);
  float streak = exp(-pow((u + 0.55) / 0.1, 2.0)) + 0.35 * exp(-pow((u - 0.62) / 0.06, 2.0));
  vec3 spec = vec3(0.1 + 0.4 * uLab) + lm * 0.18 * glowGain() + L * glow * 0.1 * opacity;
  c += spec * (rim * 0.9 + streak * 0.55);
  // The rim at the top.
  float top = exp(-pow((q.y - h + 0.0015) / (1.5 * px), 2.0)) * step(abs(q.x), hw + px);
  c += spec * top * 0.8;
  return vec4(c * a, a);
}

void main() {
  px = 1.0 / (uRes.y * uK);
  int kind = int(vLook.x + 0.5);
  if (kind == ${String(FLAME)}) {
    outColor = flame(vQ);
  } else if (kind == ${String(DROP)}) {
    outColor = drop(vQ);
  } else {
    outColor = vessel(kind, vQ);
  }
}
`;

/**
 * One vapour field over its third of the room: the shared smoke density,
 * tinted by the nearer of its two sources' liquids, fading out towards the
 * field's inner and top edges so it never shows a hard line.
 */
const VAPOUR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uField;
uniform vec2 uRes;
uniform float uK;
/** The field's box in design units: x0, y0, x1, y1. */
uniform vec4 uBox;
/** 1 for the right-hand field, -1 for the left. */
uniform float uSide;
/** The two sources' x (design units). */
uniform vec2 uSrcX;
uniform vec3 uSrc0;
uniform vec3 uSrc1;
out vec4 outColor;
${AMBIENT_GLSL}
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y / uK;
  vec2 uv = (p - uBox.xy) / (uBox.zw - uBox.xy);
  float d = texture(uField, uv).r;
  float inner = uSide > 0.0 ? uv.x : 1.0 - uv.x;
  d *= smoothstep(0.0, 0.18, inner) * smoothstep(1.0, 0.85, uv.y);
  if (d <= 0.002) {
    discard;
  }
  float w0 = exp(-pow((p.x - uSrcX.x) / 0.12, 2.0));
  float w1 = exp(-pow((p.x - uSrcX.y) / 0.12, 2.0));
  vec3 tint = (uSrc0 * w0 + uSrc1 * w1 + vec3(0.6) * 0.05) / (w0 + w1 + 0.05);
  vec3 c = mix(tint, vec3(1.0), 0.3) * mix(0.55, 0.85, uLab);
  float a = clamp(d, 0.0, 1.0) * ${g(VAPOUR_ALPHA)};
  outColor = vec4(c * a, a);
}
`;

/**
 * Heavy dry-ice vapour: a low, slowly creeping mist along the bench round each
 * dry-ice beaker, and veils of it spilling down the beaker's sides.
 */
const MIST_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uK;
/** Each spill: x, rim height, half width, strength. */
uniform vec4 uSpill[2];
uniform vec3 uSpillRgb[2];
/** Drift phases, wrapped. */
uniform vec4 uPhase;
out vec4 outColor;
${SHARED_GLSL}
${AMBIENT_GLSL}
float waves(vec2 p) {
  float a = sin(p.x * 41.0 + 3.0 * sin(p.x * 9.0 + uPhase.x) + uPhase.y);
  float b = sin(p.x * 23.0 + uPhase.z + 2.0 * sin(p.y * 70.0 + uPhase.w));
  return 0.55 + 0.25 * a + 0.2 * b;
}
void main() {
  px = 1.0 / (uRes.y * uK);
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y / uK;
  float layer = smoothstep(BENCH_FRONT - 0.03, BENCH_Y - 0.012, p.y) * (1.0 - smoothstep(BENCH_Y - 0.01, BENCH_Y + 0.045, p.y));
  float m = 0.0;
  vec3 tint = vec3(0.0);
  float tw = 0.0;
  for (int i = 0; i < 2; i++) {
    vec4 s = uSpill[i];
    if (s.w <= 0.0) {
      continue;
    }
    float dx = p.x - s.x;
    float spread = exp(-pow(dx / 0.17, 2.0)) * layer;
    // Veils down the outside of the beaker, from the rim to the bench.
    float side = abs(abs(dx) - s.z - 0.004) - 0.006;
    float veil = (1.0 - smoothstep(0.0, 0.006, side)) * step(BENCH_Y - 0.01, p.y) * (1.0 - smoothstep(s.y - 0.004, s.y + 0.012, p.y));
    veil *= 0.5 + 0.5 * sin(p.y * 160.0 + uPhase.y * 3.0 + dx * 300.0);
    // And a lip of it over the rim.
    float lip = exp(-pow((p.y - s.y - 0.006) / 0.008, 2.0)) * step(abs(dx), s.z + 0.01);
    float k = s.w * (spread + 0.6 * veil + 0.5 * lip);
    m += k;
    tint += uSpillRgb[i] * k;
    tw += k;
  }
  m *= waves(p);
  if (m <= 0.003) {
    discard;
  }
  vec3 c = mix(tint / max(tw, 1e-4), vec3(1.0), 0.55) * mix(0.5, 0.85, uLab);
  float a = clamp(m, 0.0, 1.0) * 0.5;
  outColor = vec4(c * a, a);
}
`;

/**
 * A slightly mad scientist's chemistry lab. The room (tiled wall, blackboard,
 * periodic table, shelves, bench, reagent bottles and the distillation's glass)
 * is drawn once per resize or variation; a small light map of the liquids'
 * glow is redrawn only when a colour or a glow changes. Each frame lights the
 * room, draws every vessel, flame and drop in one instanced pass, advances two
 * vapour fields from the shared smoke model, one per side, and adds the dry-ice
 * mist along the bench.
 */
export const chemlab = defineEffect(chemlabMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });
      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const lightProgram = program(FULLSCREEN_VERTEX, LIGHT_FRAGMENT);
      const compProgram = program(FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const vesselProgram = program(VESSEL_VERTEX, VESSEL_FRAGMENT);
      const vapourProgram = program(FULLSCREEN_VERTEX, VAPOUR_FRAGMENT);
      const mistProgram = program(FULLSCREEN_VERTEX, MIST_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const batch = scope.own(createSpriteBatch(gl, MAX_INSTANCES, [4, 4, 4, 4]));
      const fields: SmokeField[] = [
        createSmokeField(gl, scope, "chemlab"),
        createSmokeField(gl, scope, "chemlab"),
      ];

      const ru = createUniforms(gl, roomProgram, [
        "uRes",
        "uK",
        "uProps",
        "uPropInfo",
        "uPropCount",
        "uVessels",
        "uVesselCount",
        "uFont",
        "uCodes",
      ]);
      const lu = createUniforms(gl, lightProgram, [
        "uSize",
        "uKA",
        "uLights",
        "uLightRgb",
        "uCount",
      ]);
      const cu = createUniforms(gl, compProgram, ["uRoom", "uLight", "uRes", "uK", "uLab"]);
      const vu = createUniforms(gl, vesselProgram, [
        "uRes",
        "uK",
        "uAspect",
        "uRoom",
        "uLight",
        "uTime",
        "uBubbling",
        "uBlobs",
        "uBlobR2",
        "uLavaW",
        "uLab",
      ]);
      const au = createUniforms(gl, vapourProgram, [
        "uField",
        "uRes",
        "uK",
        "uBox",
        "uSide",
        "uSrcX",
        "uSrc0",
        "uSrc1",
        "uLab",
      ]);
      const mu = createUniforms(gl, mistProgram, [
        "uRes",
        "uK",
        "uSpill",
        "uSpillRgb",
        "uPhase",
        "uLab",
      ]);
      gl.useProgram(roomProgram);
      ru.i1("uFont", 0);
      ru.i1("uCodes", 1);
      gl.useProgram(compProgram);
      cu.i1("uRoom", 0);
      cu.i1("uLight", 1);
      gl.useProgram(vesselProgram);
      vu.i1("uRoom", 0);
      vu.i1("uLight", 1);
      gl.useProgram(vapourProgram);
      au.i1("uField", 0);
      gl.useProgram(null);

      const delTex = (t: WebGLTexture) => {
        gl.deleteTexture(t);
      };
      const font = scope.add(
        createDataTexture(gl, {
          width: GLYPH_W * GLYPH_COUNT,
          height: GLYPH_H + 1,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: buildFontTexture(),
          filter: gl.NEAREST,
        }),
        delTex,
      );
      const codes = new Uint8Array(CODE_W * CHALK_LINES.length);
      CHALK_LINES.forEach(([text], row) => {
        let i = 0;
        for (const ch of text) {
          if (i < CODE_W) {
            codes[row * CODE_W + i++] = glyphIndex(ch);
          }
        }
      });
      const codesTex = scope.add(
        createDataTexture(gl, {
          width: CODE_W,
          height: CHALK_LINES.length,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: codes,
          filter: gl.NEAREST,
        }),
        delTex,
      );
      const lightTarget = createRenderTarget(gl, LIGHT_W, LIGHT_H, gl.RGBA8);
      if (!lightTarget) {
        throw new Error("Chemistry Lab: RGBA8 light map is not renderable");
      }
      scope.own(lightTarget);

      let roomTarget: RenderTarget | null = null;
      scope.defer(() => {
        roomTarget?.dispose();
      });
      let width = 1;
      let height = 1;
      let k = 1;
      let roomDirty = true;

      // The arrangement, rebuilt when the variation changes.
      let seed = Number.NaN;
      let layout: LabLayout = labLayout(0);
      let reactions: Reactions = createReactions(layout);
      const propData = new Float32Array(MAX_PROPS * 4);
      const propInfo = new Float32Array(MAX_PROPS * 2);
      const vesselBoxes = new Float32Array(MAX_VESSELS * 4);
      /** Each vessel's liquid colour: where the palette and reactions put it, and as shown. */
      let target = new Float32Array(0);
      let shown = new Float32Array(0);
      const lights = new Float32Array(MAX_LIGHTS * 4);
      const lightRgb = new Float32Array(MAX_LIGHTS * 3);
      const lastLights = new Float32Array(MAX_LIGHTS * 7).fill(Number.NaN);
      let lightCount = 0;
      let lightDirty = true;

      let time = 0;
      let lab = Number.NaN;
      const distillate = createDistillate();
      /** Seconds the receiver is ahead, so it starts part-filled. */
      let dripOffset = 0;
      const noise = createNoise(0xc4e3);
      const flames = createFlameMotion();
      const maxFlames = flames.sway.length;
      const blobs = makeBlobs(23).slice(0, LAVA_BLOBS);
      const blobData = new Float32Array(LAVA_BLOBS * 4);
      const blobR2 = new Float32Array(LAVA_BLOBS);
      const blobLife = new Float32Array(LAVA_BLOBS).fill(1);
      const clock: StepClock = { acc: 0 };
      const phases = new Float32Array(WAVE_COUNT);
      const region = new Float64Array(4);
      const grid = new Int32Array(2);
      const e0 = new Float64Array(4);
      const e1 = new Float64Array(4);
      const mistPhase = new Float32Array(4);
      const spill = new Float32Array(8);
      const spillRgb = new Float32Array(6);
      const spillIdx = new Int16Array(2);

      const rebuild = (s: number) => {
        seed = s;
        layout = labLayout(s);
        reactions = createReactions(layout);
        propData.fill(0);
        propInfo.fill(0);
        layout.props.forEach((p, i) => {
          propData.set([p.x, p.y, p.w, p.h], i * 4);
          propInfo[i * 2] = p.kind;
          propInfo[i * 2 + 1] = p.tone;
        });
        vesselBoxes.fill(0);
        layout.vessels.forEach((v, i) => {
          vesselBoxes.set([v.x, v.y, v.kind === CYLINDER ? v.w * 1.9 : v.w, v.h], i * 4);
        });
        spillIdx.fill(-1);
        layout.vessels.forEach((v, i) => {
          if (v.spill) {
            spillIdx[v.x < 0 ? 0 : 1] = i;
          }
        });
        target = new Float32Array(layout.vessels.length * 3);
        shown = new Float32Array(layout.vessels.length * 3).fill(Number.NaN);
        dripOffset = (s % 50) * 3;
        roomDirty = true;
        lightDirty = true;
      };

      /** Adds a light at (x, y) reaching `r`, of colour `c` (at `o`) times `gain`. */
      const addLight = (
        x: number,
        y: number,
        r: number,
        c: ArrayLike<number>,
        o: number,
        gain: number,
      ) => {
        if (lightCount >= MAX_LIGHTS) {
          return;
        }
        const i = lightCount++;
        lights[i * 4] = x;
        lights[i * 4 + 1] = y;
        lights[i * 4 + 2] = r;
        lights[i * 4 + 3] = 0;
        lightRgb[i * 3] = c[o] * gain;
        lightRgb[i * 3 + 1] = c[o + 1] * gain;
        lightRgb[i * 3 + 2] = c[o + 2] * gain;
      };

      /** Instances written this frame. */
      let count = 0;
      const data = batch.data;
      /** Writes one instance: its box, liquid colour and level, kind, glow, bubbles, phase, opacity and sway. */
      const put = (
        x: number,
        y: number,
        w: number,
        h: number,
        r: number,
        gg: number,
        b: number,
        level: number,
        kind: number,
        glow: number,
        bubbles: number,
        phase: number,
        opacity: number,
        sway: number,
      ) => {
        if (count >= MAX_INSTANCES) {
          return;
        }
        const o = count++ * INSTANCE_FLOATS;
        data[o] = x;
        data[o + 1] = y;
        data[o + 2] = w;
        data[o + 3] = h;
        data[o + 4] = r;
        data[o + 5] = gg;
        data[o + 6] = b;
        data[o + 7] = level;
        data[o + 8] = kind;
        data[o + 9] = glow;
        data[o + 10] = bubbles;
        data[o + 11] = phase;
        data[o + 12] = opacity;
        data[o + 13] = sway;
        data[o + 14] = 0;
        data[o + 15] = 0;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          roomTarget?.dispose();
          roomTarget = null;
          roomTarget = createRenderTarget(gl, width, height, gl.RGBA8);
          k = fitScale(width / height);
          roomDirty = true;
          lightDirty = true;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!roomTarget) {
            return;
          }
          const s = Number.isFinite(p.seed) ? Math.floor(p.seed) : 0;
          if (s !== seed) {
            rebuild(s);
          }
          const vessels = layout.vessels;
          const nV = vessels.length;
          const aspect = width / height;
          const vapour = clamp(Number.isFinite(p.vapour) ? p.vapour : 0, 0, 1);
          const bubbling = clamp(Number.isFinite(p.bubbling) ? p.bubbling : 0, 0, 1);
          const labOn = p.lighting === "lab";
          lab = Number.isFinite(lab)
            ? approach(lab, labOn ? 1 : 0, step / LIGHTS_FADE)
            : labOn
              ? 1
              : 0;
          const labEase = lab * lab * (3 - 2 * lab);

          // 1. The room, when the size or the variation changes.
          if (roomDirty) {
            roomDirty = false;
            roomTarget.bind();
            gl.useProgram(roomProgram);
            ru.f2("uRes", width, height);
            ru.f1("uK", k);
            gl.uniform4fv(ru.loc.uProps, propData);
            gl.uniform2fv(ru.loc.uPropInfo, propInfo);
            ru.i1("uPropCount", layout.props.length);
            gl.uniform4fv(ru.loc.uVessels, vesselBoxes);
            ru.i1("uVesselCount", nV);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, codesTex);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, font);
            triangle.draw();
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 2. Reactions, the distillate, and the liquids' colours.
          stepReactions(reactions, layout, seed, time, p.reactions);
          distillateAt(time + dripOffset, distillate);
          const palette = paletteFor(p.palette);
          for (let i = 0; i < nV; i++) {
            liquidColour(reactions, i, time, palette, target, i * 3);
          }
          // The distillate is the boiling flask's colour.
          if (layout.still >= 0 && layout.receiver >= 0) {
            target.copyWithin(layout.receiver * 3, layout.still * 3, layout.still * 3 + 3);
          }
          slewColours(shown, target, COLOUR_RATE, step);

          // 3. The light map, when any light has changed.
          lightCount = 0;
          for (let i = 0; i < nV; i++) {
            const v = vessels[i];
            const level = i === layout.receiver ? distillate.level : v.fill;
            const opacity = i === layout.receiver ? distillate.opacity : 1;
            const area = Math.sqrt((2 * v.w * Math.max(0, level)) / LIGHT_AREA);
            const gain = LIGHT_GAIN * area * opacity * (1 + reactionGlow(reactions, i, time));
            addLight(v.x, v.y + level * 0.5, 0.04 + 1.6 * v.w, shown, i * 3, gain);
          }
          for (const pr of layout.props) {
            if (pr.kind === BURNER) {
              addLight(pr.x, pr.y + pr.h + FLAME_H * 0.5, 0.05, BURNER_RGB, 0, BURNER_LIGHT);
            }
          }
          for (let i = 0; i < lightCount; i++) {
            for (let j = 0; j < 4; j++) {
              if (lastLights[i * 7 + j] !== lights[i * 4 + j]) {
                lastLights[i * 7 + j] = lights[i * 4 + j];
                lightDirty = true;
              }
            }
            for (let j = 0; j < 3; j++) {
              if (lastLights[i * 7 + 4 + j] !== lightRgb[i * 3 + j]) {
                lastLights[i * 7 + 4 + j] = lightRgb[i * 3 + j];
                lightDirty = true;
              }
            }
          }
          if (lightDirty) {
            lightDirty = false;
            lightTarget.bind();
            gl.useProgram(lightProgram);
            lu.f2("uSize", LIGHT_W, LIGHT_H);
            lu.f2("uKA", k, aspect);
            gl.uniform4fv(lu.loc.uLights, lights);
            gl.uniform3fv(lu.loc.uLightRgb, lightRgb);
            lu.i1("uCount", lightCount);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 4. The vapour: two fields, each fed by up to two necks.
          const n = simSteps(clock, step);
          gl.activeTexture(gl.TEXTURE0);
          if (n > 0) {
            wavePhases(time, phases);
            for (let side = 0; side < 2; side++) {
              const field = fields[side];
              vapourGrid(side, grid);
              if (!field.resize(grid[0], grid[1])) {
                continue;
              }
              const ia = layout.emitters[side * 2];
              const ib = layout.emitters[side * 2 + 1];
              const pa = ia >= 0 ? reactionPuff(reactions, ia, time) : 0;
              const pb = ib >= 0 ? reactionPuff(reactions, ib, time) : 0;
              vapourEmitter(layout, side, 0, vapour, pa, e0);
              vapourEmitter(layout, side, 1, vapour, pb, e1);
              vapourRegion(side, region);
              const puff = Math.max(pa, pb);
              const cell = region[2] / grid[0];
              const radius = Math.max(
                VAPOUR_RADIUS * VAPOUR_SCALE * (1 + PUFF_RADIUS * puff),
                0.9 * cell,
              );
              const life =
                VAPOUR_LIFE[0] + (VAPOUR_LIFE[1] - VAPOUR_LIFE[0]) * vapour + PUFF_LIFE * puff;
              const draft = vapourDraft(time + side * 37) * (side === 0 ? -1 : 1);
              const u = field.uniforms;
              gl.useProgram(field.program);
              u.f4("uRegion", region[0], region[1], region[2], region[3]);
              u.f4("uPhase", phases[0], phases[1], phases[2], phases[3]);
              u.f3("uFlow", VAPOUR_RISE, draft, VAPOUR_CURL);
              u.f2("uOnset", VAPOUR_ONSET[0], 1 / (VAPOUR_ONSET[1] - VAPOUR_ONSET[0]));
              u.f4("uEmit0", e0[0], e0[1], e0[2], e0[3]);
              u.f4("uEmit1", e1[0], e1[1], e1[2], e1[3]);
              u.f1("uInvR2", 1 / (radius * radius));
              u.f3("uWisp", 0, 0, 0);
              u.f2("uDecay", 1 / life, VAPOUR_HEIGHT_DECAY);
              field.advance(n);
            }
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 5. The room, lit.
          gl.useProgram(compProgram);
          cu.f2("uRes", width, height);
          cu.f1("uK", k);
          cu.f1("uLab", labEase);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, lightTarget.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, roomTarget.texture);
          triangle.draw();

          // 6. The glassware, flames and the drop, premultiplied.
          count = 0;
          for (let i = 0; i < nV; i++) {
            const v = vessels[i];
            const receiver = i === layout.receiver;
            const glow = (v.heated ? 1.1 : 0.95) * (1 + reactionGlow(reactions, i, time));
            const bubbles = v.heated ? 1 : v.spill ? 0.5 : 0;
            put(
              v.x,
              v.y,
              v.w,
              v.h,
              shown[i * 3],
              shown[i * 3 + 1],
              shown[i * 3 + 2],
              receiver ? distillate.level : v.fill,
              i === layout.lava ? LAVA : v.kind,
              glow,
              bubbles,
              v.phase,
              receiver ? distillate.opacity : 1,
              0,
            );
          }
          let f = 0;
          for (const pr of layout.props) {
            if (pr.kind !== BURNER || f >= maxFlames) {
              continue;
            }
            flameAt(noise, f, time, FLICKER, 0, flames);
            put(
              pr.x,
              pr.y + pr.h,
              FLAME_W,
              FLAME_H * flames.stretch[f],
              BURNER_RGB[0],
              BURNER_RGB[1],
              BURNER_RGB[2],
              0,
              FLAME,
              flames.bright[f],
              0,
              0,
              1,
              flames.sway[f],
            );
            f++;
          }
          if (distillate.drop > 0 && layout.still >= 0 && count < MAX_INSTANCES) {
            const r = 0.0034 * Math.sqrt(distillate.drop);
            const top = BENCH_Y + RECEIVER_H;
            const y = OUTLET[1] - r + (top - OUTLET[1] + r) * distillate.fall;
            const si = layout.still * 3;
            put(
              OUTLET[0],
              y,
              r,
              0,
              shown[si],
              shown[si + 1],
              shown[si + 2],
              0,
              DROP,
              1,
              0,
              0,
              1,
              0,
            );
          }
          batch.upload(count);
          if (layout.lava >= 0) {
            const v = vessels[layout.lava];
            const depth = Math.max(1e-3, v.fill - 0.035 * v.h - 0.003);
            const lampW = (REF_H * 2 * v.w) / depth;
            fillBlobs(
              blobData,
              blobR2,
              blobs,
              LAVA_BLOBS,
              time * LAVA_SPEED,
              BASE_RADIUS * 0.65 * REF_H,
              lampW,
              blobLife,
            );
            gl.useProgram(vesselProgram);
            gl.uniform4fv(vu.loc.uBlobs, blobData);
            gl.uniform1fv(vu.loc.uBlobR2, blobR2);
            vu.f2("uLavaW", lampW, (0.05 * REF_H) ** 2);
          }
          gl.useProgram(vesselProgram);
          vu.f2("uRes", width, height);
          vu.f1("uK", k);
          vu.f1("uAspect", aspect);
          vu.f1("uTime", wrap(time, 0, PERIOD));
          vu.f1("uBubbling", bubbling);
          vu.f1("uLab", labEase);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          batch.draw(0, count);

          // 7. The vapour over its thirds.
          gl.enable(gl.SCISSOR_TEST);
          gl.useProgram(vapourProgram);
          au.f2("uRes", width, height);
          au.f1("uK", k);
          au.f1("uLab", labEase);
          for (let side = 0; side < 2; side++) {
            const tex = fields[side].texture;
            if (!tex) {
              continue;
            }
            const b = VAPOUR_BOXES[side];
            const x0 = Math.max(0, Math.floor(b[0] * k * height + width / 2));
            const x1 = Math.min(width, Math.ceil(b[2] * k * height + width / 2));
            const y0 = Math.max(0, Math.floor(b[1] * k * height + height / 2));
            const y1 = Math.min(height, Math.ceil(b[3] * k * height + height / 2));
            if (x1 <= x0 || y1 <= y0) {
              continue;
            }
            gl.scissor(x0, y0, x1 - x0, y1 - y0);
            const ia = layout.emitters[side * 2];
            const ib = layout.emitters[side * 2 + 1];
            const ca = ia >= 0 ? ia : Math.max(0, ib);
            const cb = ib >= 0 ? ib : ca;
            au.f4("uBox", b[0], b[1], b[2], b[3]);
            au.f1("uSide", side === 0 ? -1 : 1);
            au.f2("uSrcX", ca < nV ? vessels[ca].x : 0, cb < nV ? vessels[cb].x : 0);
            au.f3("uSrc0", shown[ca * 3], shown[ca * 3 + 1], shown[ca * 3 + 2]);
            au.f3("uSrc1", shown[cb * 3], shown[cb * 3 + 1], shown[cb * 3 + 2]);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            triangle.draw();
          }

          // 8. The dry-ice mist along the bench.
          let anySpill = false;
          for (let side = 0; side < 2; side++) {
            const i = spillIdx[side];
            if (i < 0 || vapour <= 0) {
              spill.fill(0, side * 4, side * 4 + 4);
              continue;
            }
            anySpill = true;
            const v = vessels[i];
            spill[side * 4] = v.x;
            spill[side * 4 + 1] = v.y + v.h;
            spill[side * 4 + 2] = v.w;
            spill[side * 4 + 3] = vapour;
            spillRgb[side * 3] = shown[i * 3];
            spillRgb[side * 3 + 1] = shown[i * 3 + 1];
            spillRgb[side * 3 + 2] = shown[i * 3 + 2];
          }
          if (anySpill) {
            const y0 = Math.max(0, Math.floor((BENCH_FRONT - 0.04) * k * height + height / 2));
            const y1 = Math.min(height, Math.ceil((BENCH_Y + 0.13) * k * height + height / 2));
            if (y1 > y0) {
              const tw = wrap(time, 0, PERIOD);
              for (let j = 0; j < 4; j++) {
                mistPhase[j] = wrap(MIST_RATES[j] * tw, 0, TAU);
              }
              gl.scissor(0, y0, width, y1 - y0);
              gl.useProgram(mistProgram);
              mu.f2("uRes", width, height);
              mu.f1("uK", k);
              mu.f1("uLab", labEase);
              gl.uniform4fv(mu.loc.uSpill, spill);
              gl.uniform3fv(mu.loc.uSpillRgb, spillRgb);
              mu.f4("uPhase", mistPhase[0], mistPhase[1], mistPhase[2], mistPhase[3]);
              triangle.draw();
            }
          }
          gl.disable(gl.SCISSOR_TEST);
          gl.disable(gl.BLEND);
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
