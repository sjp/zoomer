import { type Rgb, unitRgbMemo } from "../color";
import {
  beginFrame,
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
  scissorBox,
  scopedProgram,
} from "../gl";
import { HALF_DUTY, SLAT_GAP_GLSL } from "../blinds/blinds-sim";
import {
  BASE_RADIUS,
  fillBlobs,
  makeBlobs,
  REF_H,
  lavaFieldGlsl,
} from "../lavalamp/lavalamp-blobs";
import { buildFontTexture, GLYPH_COUNT, GLYPH_H, GLYPH_W, glyphIndex } from "../dot-matrix";
import { HASH32_GLSL } from "../noise";
import { defineEffect } from "../types";
import {
  BULB,
  CASSETTES,
  CEILING_Y,
  CELL,
  COMFORT_RATE,
  createReels,
  cursorLevel,
  DECK,
  DECK_WINDOW,
  DEMO_H,
  DEMO_W,
  DESK_BACK,
  DESK_END,
  DESK_FRONT,
  GLYPH_SCALE,
  HEADLIGHT_WIDTH,
  headlightAt,
  JOYSTICK,
  KEYBOARD,
  LAMP_GLASS,
  LAMP_LIGHT,
  LOADING_LINE,
  LOADING_PAPER,
  MAX_CODES,
  MONITOR,
  PAPER,
  POSTER_CAR,
  POSTER_SPACE,
  POSTER_SUNSET,
  PROMPT_LINES,
  RADIO,
  REEL_R,
  REELS,
  screenGlow,
  SCREEN,
  SCROLL_SWING,
  SCROLL_Y,
  scrollerCodes,
  scrollOffset,
  SHELF,
  slewColor,
  BEDSIDE_FADE,
  BED_TOP,
  stepFade,
  stepModes,
  stepReels,
  STRIPE_BANDS,
  STRIPE_EDGE,
  STRIPE_PALETTE,
  stripePhase,
  SCROLL_SPEED,
  sweepAt,
  sweepPos,
  TABLE,
  WINDOW,
  WINDOW_FRAME,
  type Box,
} from "./bedroom80s-sim";
import { bedroom80sMeta } from "./bedroom80s.meta";
import { SDF2D_GLSL } from "../sdf-glsl";
import { fitScale } from "../scene-layout";

const g = glslFloat;
const v3 = (c: readonly number[]) => `vec3(${g(c[0])}, ${g(c[1])}, ${g(c[2])})`;
const v4 = (b: Box) => `vec4(${g(b[0])}, ${g(b[1])}, ${g(b[2])}, ${g(b[3])})`;

const TAU = Math.PI * 2;

/** The glyph-code texture: row 0 the scroller, then the prompt's lines, then the loading line. */
const CODES_W = Math.max(MAX_CODES, 32);
const PROMPT_ROW = 1;
const LOADING_ROW = PROMPT_ROW + PROMPT_LINES.length;
const CODE_ROWS = LOADING_ROW + 1;

/** Blobs in the little lava lamp, and their size relative to the Lava Lamp effect's. */
const LAMP_BLOBS = 6;
const LAMP_BLOB_SIZE = 0.8;
/** The lamp's wax pool radius, in lamp units. */
const LAMP_POOL_R = 0.06 * REF_H;

/** The copper bars: their middle and swing (demo pixels from the top), and their period (s). */
const BAR_MID = 70;
const BAR_SWING = 26;
const BAR_PERIOD = 18;
/** The starfield's three layers' speeds (demo pixels a second) and the period after which they all repeat. */
const STAR_SPEED = 6;
const STAR_PERIOD = DEMO_W / STAR_SPEED;
/** The scroller's wave: its speed (radians a second). */
const WAVE_SPEED = 1.1;

/** The night's ambient light, the streetlight through the blinds, and the lights' strengths. */
const AMBIENT: Rgb = [0.1, 0.11, 0.16];
const STREET_RGB: Rgb = [1.0, 0.62, 0.3];
const CRT_GAIN = 1.5;
const LAMP_GAIN = 0.75;
const BEDSIDE_RGB: Rgb = [1.0, 0.74, 0.45];
const BEDSIDE_GAIN = 1.3;
const HEADLIGHT_RGB: Rgb = [0.9, 0.93, 1.0];
/** Light stripes the blinds cast on the ceiling, from the wall out to the frame's top. */
const CEILING_SLATS = 40;

const KIND_CRT = 0;
const KIND_LAMP = 1;
const KIND_REEL = 2;

const SHARED_GLSL = /* glsl */ `
${SDF2D_GLSL}
const float CEILING_Y = ${g(CEILING_Y)};
${SLAT_GAP_GLSL}
/** The stripes the blinds cast on the ceiling at design y: 1 in a stripe of light, 0 between. */
float ceilingSlats(float y) {
  float u = max(1.0 - CEILING_Y / max(y, CEILING_Y), 0.0);
  return slatGap(u * ${g(CEILING_SLATS)}, 0.25 + 3.0 * u, ${g(HALF_DUTY)}) * smoothstep(0.0, 0.01, u);
}
`;

/**
 * The bedroom, drawn once per resize or setting change with four samples per
 * pixel, in two passes. Pass 0 is the room under the night's ambient light,
 * with the streetlight's slats on the ceiling and the glowing things (the
 * street outside, the monitor's LED), and in alpha how much of the lava lamp's
 * light each point catches. Pass 1 is each point's colour (its albedo, with
 * its contact shadows), and in alpha how much of the screen's glow it catches.
 * Each frame lights the room from these with the lights' current colours.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
/** 1 with the computer on the left, -1 mirrored. */
uniform float uSide;
/** Design units per frame unit (see fitScale). */
uniform float uK;
uniform int uPass;
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
${SHARED_GLSL}
const vec4 SCREEN = ${v4(SCREEN)};
const vec4 MONITOR = ${v4(MONITOR)};
const vec4 KEYBOARD = ${v4(KEYBOARD)};
const vec4 DECK = ${v4(DECK)};
const vec4 DECK_WINDOW = ${v4(DECK_WINDOW)};
const vec4 CASSETTES = ${v4(CASSETTES)};
const vec4 JOYSTICK = ${v4(JOYSTICK)};
const vec4 POSTER_SUNSET = ${v4(POSTER_SUNSET)};
const vec4 POSTER_SPACE = ${v4(POSTER_SPACE)};
const vec4 POSTER_CAR = ${v4(POSTER_CAR)};
const vec4 SHELF = ${v4(SHELF)};
const vec4 RADIO = ${v4(RADIO)};
const vec4 LAMP_GLASS = ${v4(LAMP_GLASS)};
const vec4 WINDOW = ${v4(WINDOW)};
const vec4 TABLE = ${v4(TABLE)};
const vec2 BULB = vec2(${g(BULB[0])}, ${g(BULB[1])});
const vec2 LAMP_LIGHT = vec2(${g(LAMP_LIGHT[0])}, ${g(LAMP_LIGHT[1])});
const float FRAME = ${g(WINDOW_FRAME)};
const float DESK_BACK = ${g(DESK_BACK)};
const float DESK_FRONT = ${g(DESK_FRONT)};
const float DESK_END = ${g(DESK_END)};
const float BED_TOP = ${g(BED_TOP)};
const vec3 AMBIENT = ${v3(AMBIENT)};
const vec3 STREET = ${v3(STREET_RGB)};
const vec3 BEIGE = vec3(0.74, 0.68, 0.56);

/** The surface so far: albedo, glow, contact shadow, and how much screen and lamp light it catches. */
vec3 alb;
vec3 em;
float sh;
float rc;
float rl;

void lay(vec3 c, float a, float crt, float lamp) {
  alb = mix(alb, c, a);
  em *= 1.0 - a;
  sh = mix(sh, 1.0, a);
  rc = mix(rc, crt, a);
  rl = mix(rl, lamp, a);
}
void glow(vec3 e, float a) {
  em = mix(em, e, a);
  alb *= 1.0 - a;
  sh = mix(sh, 1.0, a);
  rc *= 1.0 - a;
  rl *= 1.0 - a;
}
/** A soft shadow on what's there, from a box offset down and away from the lights. */
void shadowBox(vec2 q, vec2 hs, float r, float soft, float k) {
  sh *= 1.0 - k * (1.0 - smoothstep(-soft * 0.3, soft, sdBox(q, hs, r)));
}
float rand(vec2 cell, uint salt) {
  uvec2 u = uvec2(ivec2(cell) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ salt))) / 4294967296.0;
}

/** Wallpaper: soft two-tone stripes with a small diamond in each panel and fine pinstripes. */
void wallpaper(vec2 p) {
  vec2 cell = vec2(0.064, 0.084);
  vec2 u = p / cell;
  vec2 f = fract(u) - 0.5;
  bool odd = mod(floor(u.x), 2.0) > 0.5;
  vec3 c = odd ? vec3(0.5, 0.47, 0.4) : vec3(0.55, 0.52, 0.44);
  float pin = abs(abs(f.x) - 0.5) * cell.x - 0.0012;
  c = mix(c, vec3(0.4, 0.3, 0.26), cover(pin) * 0.6);
  vec2 dq = vec2(f.x, mod(u.y + (odd ? 0.5 : 0.0), 1.0) - 0.5) * cell;
  float diamond = abs(dq.x) + abs(dq.y) - 0.009;
  c = mix(c, odd ? vec3(0.56, 0.3, 0.24) : vec3(0.25, 0.4, 0.42), cover(diamond));
  alb = c;
  em = vec3(0.0);
  sh = 1.0;
  rc = 1.0;
  rl = 1.0;
}

/** The ceiling above the wall, with a cornice where they meet. */
void ceiling(vec2 p) {
  if (p.y < CEILING_Y - 0.02) {
    return;
  }
  // The cornice's shadow on the wall.
  sh *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.03, CEILING_Y - p.y));
  vec3 c = vec3(0.6, 0.58, 0.55);
  lay(c, cover(CEILING_Y - p.y), 0.75, 0.8);
  float cornice = abs(p.y - CEILING_Y - 0.004) - 0.006;
  lay(vec3(0.66, 0.64, 0.6) * (0.75 + 0.3 * smoothstep(-0.006, 0.006, p.y - CEILING_Y - 0.004)), cover(cornice), 0.8, 0.8);
}

/** The floor's carpet, low down. */
void carpet(vec2 p) {
  float top = -0.42;
  if (p.y > top + 0.03) {
    return;
  }
  // The skirting board, then the carpet.
  lay(vec3(0.62, 0.6, 0.55), cover(p.y - top), 0.8, 0.8);
  vec3 c = vec3(0.3, 0.14, 0.12) * (0.85 + 0.25 * rand(floor(p * 600.0), 3u));
  lay(c, cover(p.y - top + 0.022), 0.9, 0.8);
}

/** The street at night through the window: sky, rooftops with a lit window, and the streetlight. */
vec3 street(vec2 q, vec2 hs) {
  vec2 u = q / hs;
  vec3 c = mix(vec3(0.05, 0.05, 0.09), vec3(0.012, 0.016, 0.045), clamp(u.y * 0.5 + 0.5, 0.0, 1.0));
  // Rooftops across the road.
  float roof = -0.35 + 0.12 * step(0.5, fract(u.x * 1.3 + 0.2)) - 0.18 * abs(fract(u.x * 2.6) - 0.5);
  if (u.y < roof) {
    c = vec3(0.012, 0.012, 0.02);
    vec2 w = vec2(u.x - 0.45, u.y + 0.62);
    c = mix(c, vec3(0.55, 0.36, 0.15), step(abs(w.x), 0.07) * step(abs(w.y), 0.08));
  }
  // The streetlight: a pole, an arm and the lamp, with its haze.
  vec2 lamp = vec2(-0.45, 0.48);
  float pole = max(abs(u.x + 0.72) * hs.x - 0.003, u.y - lamp.y - 0.05);
  c = mix(c, vec3(0.02), cover(pole));
  float arm = sdSeg(q, vec2(-0.72, lamp.y + 0.05) * hs, vec2(lamp.x, lamp.y + 0.03) * hs) - 0.002;
  c = mix(c, vec3(0.02), cover(arm));
  vec2 lq = (u - lamp) * hs;
  c += STREET * (0.55 * exp(-dot(lq, lq) / 0.0004) + 0.2 * exp(-length(lq) / 0.06));
  c = mix(c, STREET * 1.1, cover(sdBox(lq, vec2(0.016, 0.004), 0.003)));
  return c;
}

/** The window: its frame, sill and blinds, with the street through the gaps between the slats. */
void windowBlinds(vec2 p) {
  vec2 q = p - WINDOW.xy;
  vec2 hs = WINDOW.zw;
  float outer = sdBox(q, hs + FRAME, 0.002);
  if (outer > 0.05) {
    return;
  }
  shadowBox(q - vec2(-0.006, -0.012), hs + FRAME, 0.002, 0.03, 0.35);
  vec3 frame = vec3(0.68, 0.66, 0.6) * (0.85 + 0.2 * smoothstep(FRAME, -FRAME, abs(sdBox(q, hs, 0.0) - FRAME * 0.5) * 2.0 - FRAME));
  lay(frame, cover(outer), 0.9, 0.9);
  float glass = sdBox(q, hs, 0.0);
  if (glass < px) {
    glow(street(q, hs), cover(glass));
    // The slats: mostly closed, so the street shows only through narrow gaps.
    float pitch = 0.019;
    float s = (hs.y - q.y) / pitch;
    float k = fract(s);
    float slat = step(0.0, -glass) * (1.0 - smoothstep(0.62, 0.7, k)) * smoothstep(0.0, 0.04, k);
    vec3 sc = vec3(0.7, 0.68, 0.62) * (0.7 + 0.35 * smoothstep(0.0, 0.66, k));
    // Their edges catch the streetlight from behind.
    float rim = smoothstep(0.5, 0.66, k) * (1.0 - smoothstep(0.66, 0.7, k));
    lay(sc, slat, 0.8, 0.9);
    em += STREET * 0.05 * rim * exp(-length(q - vec2(-0.45, 0.48) * hs) / 0.12);
    // Ladder strings, and the head rail.
    float strings = abs(abs(q.x) - hs.x * 0.55) - 0.0008;
    lay(vec3(0.55, 0.53, 0.48), cover(strings) * step(q.y, hs.y), 0.6, 0.6);
    lay(vec3(0.72, 0.7, 0.64) * (0.8 + 0.25 * smoothstep(-0.008, 0.008, q.y - hs.y + 0.012)), cover(sdBox(q - vec2(0.0, hs.y - 0.012), vec2(hs.x, 0.012), 0.002)), 0.8, 0.9);
    // The pull cord.
    lay(vec3(0.6, 0.58, 0.52), cover(sdSeg(q, vec2(hs.x * 0.8, hs.y - 0.02), vec2(hs.x * 0.8, -hs.y * 0.3)) - 0.0012), 0.6, 0.6);
  }
  // The sill.
  vec2 sq = q - vec2(0.0, -hs.y - FRAME - 0.005);
  lay(vec3(0.7, 0.68, 0.62) * (0.75 + 0.35 * smoothstep(-0.006, 0.006, sq.y)), cover(sdBox(sq, vec2(hs.x + FRAME + 0.015, 0.007), 0.002)), 0.9, 0.9);
}

/** A neon sunset: a striped sun sinking behind a glowing grid. */
vec3 sunsetArt(vec2 q, vec2 hs) {
  float hz = -0.25 * hs.y;
  vec3 c;
  if (q.y > hz) {
    float t = (q.y - hz) / (hs.y - hz);
    c = mix(vec3(0.95, 0.38, 0.45), vec3(0.2, 0.06, 0.32), sqrt(t));
    vec2 s = q - vec2(0.0, hz);
    float r = 0.62 * hs.y;
    float band = (s.y / r);
    float cut = band < 0.5 ? step(fract(band * 7.0), 0.3 + 0.5 * (0.5 - band)) : 0.0;
    vec3 sun = mix(vec3(0.98, 0.3, 0.5), vec3(1.0, 0.82, 0.3), clamp(band, 0.0, 1.0));
    c = mix(c, sun, cover(length(s) - r) * (1.0 - cut));
  } else {
    float d = hz - q.y + 0.004;
    c = vec3(0.07, 0.02, 0.12);
    float depth = 0.01 / d;
    float hline = 1.0 - smoothstep(0.0, 0.18, abs(fract(depth * 2.0) - 0.5) * 2.0 * d * 40.0);
    float vline = 1.0 - smoothstep(0.0, 0.08, abs(fract(q.x / d * 0.16) - 0.5) * 2.0);
    c += vec3(0.85, 0.2, 0.75) * max(hline * smoothstep(0.0, 0.006, d), vline * smoothstep(0.0, 0.01, d)) * 0.8;
  }
  return c;
}

/** A space scene: stars, a ringed planet and a little moon. */
vec3 spaceArt(vec2 q, vec2 hs) {
  vec3 c = mix(vec3(0.02, 0.03, 0.09), vec3(0.06, 0.03, 0.12), q.y / hs.y * 0.5 + 0.5);
  float st = rand(floor(q * 260.0), 41u);
  c += vec3(0.8) * step(0.965, st) * (st - 0.965) * 25.0;
  vec2 pc = vec2(0.15 * hs.x, -0.2 * hs.y);
  float r = 0.62 * hs.x;
  vec2 rq = (q - pc) * vec2(1.0, 3.4);
  float ring = abs(length(rq) - 1.55 * r) - 0.12 * r;
  vec3 ringC = vec3(0.75, 0.62, 0.45);
  bool front = q.y < pc.y;
  if (!front) {
    c = mix(c, ringC * 0.7, cover(ring));
  }
  float lit = clamp(0.35 + 0.8 * dot(normalize(q - pc + vec2(1e-4)), normalize(vec2(-0.7, 0.6))), 0.15, 1.0);
  vec3 planet = mix(vec3(0.85, 0.5, 0.3), vec3(0.95, 0.75, 0.5), step(0.5, fract((q.y - pc.y) / r * 2.5 + 0.2))) * lit;
  c = mix(c, planet, cover(length(q - pc) - r));
  if (front) {
    c = mix(c, ringC, cover(ring));
  }
  vec2 mq = q - vec2(-0.5 * hs.x, 0.6 * hs.y);
  c = mix(c, vec3(0.7, 0.72, 0.75) * (0.6 + 0.4 * smoothstep(0.01, -0.01, mq.x + mq.y)), cover(length(mq) - 0.14 * hs.x));
  return c;
}

/** A sports car's silhouette against a big sunset. */
vec3 carArt(vec2 q, vec2 hs) {
  vec2 u = q / hs;
  vec3 c = mix(vec3(0.95, 0.42, 0.55), vec3(0.1, 0.45, 0.55), clamp(u.y * 0.6 + 0.5, 0.0, 1.0));
  c = mix(c, vec3(1.0, 0.75, 0.35), cover(length(q - vec2(0.25 * hs.x, -0.05 * hs.y)) - 0.55 * hs.y));
  float road = q.y + 0.72 * hs.y;
  c = mix(c, vec3(0.05, 0.03, 0.08), cover(road));
  // The car: a long low wedge, a raked cabin and two wheels.
  vec2 b = q - vec2(-0.05 * hs.x, -0.48 * hs.y);
  float body = sdBox(b, vec2(0.72 * hs.x, 0.13 * hs.y), 0.02 * hs.y);
  body = max(body, dot(b - vec2(0.55 * hs.x, 0.13 * hs.y), normalize(vec2(0.35, 1.0))));
  vec2 cb = q - vec2(-0.2 * hs.x, -0.25 * hs.y);
  float cabin = max(sdBox(cb, vec2(0.38 * hs.x, 0.13 * hs.y), 0.0), dot(cb - vec2(0.12 * hs.x, 0.13 * hs.y), normalize(vec2(0.45, 1.0))));
  cabin = max(cabin, dot(cb - vec2(-0.38 * hs.x, -0.13 * hs.y), normalize(vec2(-0.8, 0.6))));
  float car = min(body, cabin);
  for (int i = -1; i <= 1; i += 2) {
    car = min(car, length(q - vec2((float(i) * 0.45 - 0.05) * hs.x, -0.62 * hs.y)) - 0.16 * hs.y);
  }
  c = mix(c, vec3(0.03, 0.02, 0.05), cover(car));
  // A neon line along its flank.
  c = mix(c, vec3(1.0, 0.35, 0.7), cover(abs(b.y + 0.02 * hs.y) - 0.012 * hs.y) * cover(body + 0.03 * hs.y));
  return c;
}

/** A poster on the wall, its bottom corner curling away, held up with two pins. */
void poster(vec2 p, vec4 box, int kind) {
  vec2 q = p - box.xy;
  vec2 hs = box.zw;
  if (sdBox(q, hs, 0.0) > 0.04) {
    return;
  }
  shadowBox(q - vec2(-0.005, -0.01), hs, 0.002, 0.02, 0.4);
  vec3 art = kind == 0 ? sunsetArt(q, hs) : kind == 1 ? spaceArt(q, hs) : carArt(q, hs);
  // The white border, and a gentle bow from the paper curling.
  vec2 inner = hs - 0.008;
  art = mix(vec3(0.85, 0.83, 0.78), art, cover(sdBox(q, inner, 0.0)));
  art *= 0.88 + 0.16 * smoothstep(-hs.y, hs.y, q.y) - 0.08 * smoothstep(0.7, 1.0, abs(q.x / hs.x));
  // The curl: the corner lifts away, showing the paper's back.
  vec2 cq = q - vec2(hs.x, -hs.y);
  float t = -cq.x + cq.y;
  float curl = 0.03;
  float paper = cover(sdBox(q, hs, 0.0)) * smoothstep(curl - 0.002, curl + 0.002, t);
  lay(art, paper, 1.0, 1.0);
  // The folded-over flap: the corner reflected across the fold line.
  vec2 fp = cq + vec2(t - curl, -(t - curl));
  float flap = cover(curl - t) * cover(fp.x) * cover(-fp.y);
  lay(vec3(0.82, 0.8, 0.74) * (0.7 + 0.35 * clamp((t - curl) / curl, 0.0, 1.0)), flap, 1.0, 1.0);
  // The pins.
  for (int i = -1; i <= 1; i += 2) {
    vec2 pq = q - vec2(float(i) * (hs.x - 0.012), hs.y - 0.012);
    vec3 pin = kind == 1 ? vec3(0.2, 0.4, 0.8) : vec3(0.85, 0.15, 0.12);
    lay(pin * (0.6 + 0.6 * smoothstep(0.003, -0.003, pq.x + pq.y)), cover(length(pq) - 0.0045), 1.0, 1.0);
  }
}

/** The wall shelf on its brackets, with books and a radio; the lava lamp's base and cap. */
void shelf(vec2 p) {
  vec2 q = p - SHELF.xy;
  vec2 hs = SHELF.zw;
  if (abs(q.x) > hs.x + 0.06 || q.y > 0.21 || q.y < -0.08) {
    return;
  }
  shadowBox(q - vec2(-0.004, -0.02), vec2(hs.x, hs.y + 0.004), 0.002, 0.04, 0.55);
  for (int i = -1; i <= 1; i += 2) {
    vec2 bq = q - vec2(float(i) * (hs.x - 0.04), -0.025);
    lay(vec3(0.15), cover(sdBox(bq, vec2(0.003, 0.022), 0.0)), 0.6, 0.8);
  }
  // Books, leaning a little, at the shelf's far end from the lamp.
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float h = 0.055 + 0.022 * rand(vec2(fi, 1.0), 5u);
    float w = 0.0075 + 0.003 * rand(vec2(fi, 2.0), 5u);
    vec2 bc = vec2(-hs.x + 0.012 + fi * 0.0145, hs.y + h * 0.5);
    vec2 bq = q - bc;
    float r = rand(vec2(fi, 3.0), 5u);
    vec3 col = r < 0.25 ? vec3(0.55, 0.12, 0.1) : r < 0.5 ? vec3(0.12, 0.25, 0.45) : r < 0.75 ? vec3(0.75, 0.6, 0.2) : vec3(0.15, 0.4, 0.25);
    col *= 0.8 + 0.35 * smoothstep(w, -w, bq.x);
    col = mix(col, vec3(0.85, 0.8, 0.6), cover(abs(bq.y - h * 0.3) - 0.003) * 0.6);
    lay(col, cover(sdBox(bq, vec2(w, h * 0.5), 0.001)), 0.8, 1.0);
  }
  // The radio: a little boxy set with two speakers, a dial and a handle.
  vec2 rq = p - RADIO.xy;
  vec2 rh = RADIO.zw;
  shadowBox(rq - vec2(-0.004, -0.004), rh, 0.006, 0.012, 0.4);
  lay(vec3(0.1), cover(sdSeg(rq, vec2(-rh.x * 0.7, rh.y), vec2(-rh.x * 0.6, rh.y + 0.012)) - 0.002), 0.7, 1.0);
  lay(vec3(0.1), cover(sdSeg(rq, vec2(rh.x * 0.7, rh.y), vec2(rh.x * 0.6, rh.y + 0.012)) - 0.002), 0.7, 1.0);
  lay(vec3(0.1), cover(sdSeg(rq, vec2(-rh.x * 0.6, rh.y + 0.012), vec2(rh.x * 0.6, rh.y + 0.012)) - 0.002), 0.7, 1.0);
  vec3 body = vec3(0.16, 0.16, 0.18) * (0.8 + 0.3 * smoothstep(-rh.y, rh.y, rq.y));
  for (int i = -1; i <= 1; i += 2) {
    vec2 sq = rq - vec2(float(i) * rh.x * 0.58, -0.004);
    float sr = length(sq);
    float grill = 0.5 + 0.5 * sin(sr * 1400.0);
    body = mix(body, vec3(0.06) + vec3(0.05) * grill, cover(sr - 0.018));
    body = mix(body, vec3(0.55), cover(abs(sr - 0.018) - 0.0012));
  }
  vec2 dq = rq - vec2(0.0, rh.y * 0.45);
  body = mix(body, vec3(0.5, 0.45, 0.35), cover(sdBox(dq, vec2(0.012, 0.005), 0.001)));
  body = mix(body, vec3(0.8, 0.2, 0.1), cover(abs(dq.x - 0.003) - 0.0006) * step(abs(dq.y), 0.005));
  lay(body, cover(sdBox(rq, rh, 0.005)), 0.8, 1.0);
  // The plank.
  vec3 wood = vec3(0.42, 0.26, 0.15) * (0.85 + 0.1 * sin(q.x * 300.0 + sin(q.x * 40.0) * 3.0));
  wood *= 0.8 + 0.35 * smoothstep(-hs.y, hs.y, q.y);
  lay(wood, cover(sdBox(q, hs, 0.001)), 0.8, 1.0);
  // The lava lamp's base (a tapering cone) and its cap; the glass is drawn live.
  vec2 lq = p - LAMP_GLASS.xy;
  vec2 lh = LAMP_GLASS.zw;
  float base0 = SHELF.y + SHELF.w;
  float top0 = -lh.y;
  float by = (lq.y - (base0 - LAMP_GLASS.y)) / (top0 - (base0 - LAMP_GLASS.y));
  float bw = mix(lh.x * 1.25, lh.x * 0.72, clamp(by, 0.0, 1.0));
  float base = max(abs(lq.y - 0.5 * (top0 + base0 - LAMP_GLASS.y)) - 0.5 * (top0 - base0 + LAMP_GLASS.y), abs(lq.x) - bw);
  vec3 metal = vec3(0.55, 0.42, 0.22) * (0.5 + 0.8 * pow(max(0.0, 1.0 - abs(lq.x / bw + 0.35)), 2.0));
  lay(metal, cover(base), 0.8, 1.0);
  float cy = lq.y - lh.y;
  float cw = mix(lh.x * 0.5, lh.x * 0.3, clamp(cy / 0.02, 0.0, 1.0));
  float cap = max(abs(cy - 0.01) - 0.01, abs(lq.x) - cw);
  lay(metal, cover(cap), 0.8, 1.0);
}

/** The bedside table, its lamp (lit live, by the composite's light) and the bed's duvet. */
void bedside(vec2 p) {
  if (p.x < TABLE.x - TABLE.z - 0.3 || p.y > BULB.y + 0.06) {
    return;
  }
  vec2 q = p - TABLE.xy;
  vec2 hs = TABLE.zw;
  vec3 wood = vec3(0.35, 0.22, 0.13);
  // The cabinet under the top, and the top.
  lay(wood * 0.8 * (0.85 + 0.15 * sin(p.y * 200.0)), cover(max(abs(q.x) - hs.x + 0.01, q.y)), 0.7, 0.8);
  lay(wood * 0.6, cover(abs(abs(q.x) - hs.x * 0.5) - 0.001) * step(q.y, -0.01) * step(-0.12, q.y), 0.7, 0.8);
  lay(wood * (0.9 + 0.3 * smoothstep(-hs.y, hs.y, q.y)), cover(sdBox(q, hs, 0.002)), 0.8, 0.9);
  // The lamp: a round base, a stem and a fabric shade.
  vec2 lq = p - BULB;
  float baseY = TABLE.y + hs.y;
  vec2 bq = p - vec2(BULB.x, baseY + 0.018);
  shadowBox(bq - vec2(-0.006, -0.004), vec2(0.022, 0.016), 0.012, 0.012, 0.4);
  lay(vec3(0.55, 0.38, 0.3) * (0.7 + 0.4 * smoothstep(0.02, -0.02, bq.x)), cover(sdBox(bq, vec2(0.022, 0.018), 0.014)), 0.8, 0.8);
  lay(vec3(0.6, 0.55, 0.4), cover(sdSeg(p, vec2(BULB.x, baseY + 0.03), BULB) - 0.0025), 0.8, 0.8);
  float t = clamp((lq.y + 0.02) / 0.06, 0.0, 1.0);
  float shade = max(abs(lq.y - 0.01) - 0.03, abs(lq.x) - mix(0.05, 0.032, t));
  lay(vec3(0.9, 0.82, 0.62) * (0.85 + 0.15 * sin(lq.x * 500.0)), cover(shade), 0.6, 0.6);
  // The duvet: a bold geometric print with soft folds.
  vec2 d = p - vec2(0.0, BED_TOP);
  float edge = d.y - 0.008 * sin(p.x * 30.0) + 0.0;
  if (p.x > 0.3 && edge < 0.02) {
    vec2 u = vec2(p.x, p.y) / 0.05;
    float zig = abs(fract(u.x + 0.5 * floor(u.y)) - 0.5) * 2.0;
    vec3 c = fract(u.y) < zig ? vec3(0.12, 0.45, 0.5) : vec3(0.85, 0.35, 0.5);
    c = mix(c, vec3(0.1, 0.1, 0.25), step(0.82, fract(u.y)));
    c *= 0.75 + 0.25 * sin(p.x * 45.0 + p.y * 20.0) + 0.15 * smoothstep(-0.03, 0.0, edge);
    lay(c, cover(edge) * smoothstep(0.3, 0.33, p.x), 0.6, 0.6);
  }
}

/** The desk: its top and front edge, along the bottom on the computer's side. */
void desk(vec2 p) {
  if (p.x > DESK_END + 0.02 || p.y > DESK_BACK + 0.02) {
    return;
  }
  float end = p.x - DESK_END;
  // The top recedes to the wall; its back edge meets the wall in shadow.
  float t = clamp((p.y - DESK_FRONT) / (DESK_BACK - DESK_FRONT), 0.0, 1.0);
  vec3 top = vec3(0.5, 0.36, 0.24) * (1.0 - 0.25 * t) * (0.94 + 0.06 * sin(p.x * 120.0 + sin(p.y * 90.0) * 2.0));
  lay(top, cover(max(p.y - DESK_BACK, end)), 1.3, 1.0);
  sh *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.01, DESK_BACK - p.y));
  vec3 front = vec3(0.36, 0.24, 0.15) * (0.8 + 0.2 * smoothstep(-0.5, DESK_FRONT, p.y));
  front = mix(front, vec3(0.55, 0.42, 0.3), 1.0 - smoothstep(0.0, 0.01, DESK_FRONT - p.y));
  // A drawer with a handle.
  vec2 dq = p - vec2(DESK_END - 0.17, DESK_FRONT - 0.07);
  front = mix(front, front * 0.6, cover(abs(sdBox(dq, vec2(0.13, 0.045), 0.003)) - 0.0012));
  front = mix(front, vec3(0.7, 0.6, 0.4), cover(sdBox(dq - vec2(0.0, 0.015), vec2(0.025, 0.0035), 0.003)));
  lay(front, cover(max(p.y - DESK_FRONT, end)), 0.8, 0.8);
}

/** The monitor: a beige case with a rounded bezel round the dark tube, a stand and a side panel going back. */
void monitor(vec2 p) {
  vec2 q = p - MONITOR.xy;
  vec2 hs = MONITOR.zw;
  if (sdBox(q, hs, 0.0) > 0.06) {
    return;
  }
  // The stand, down to the desk.
  vec2 st = p - vec2(MONITOR.x, 0.5 * (MONITOR.y - hs.y + DESK_BACK + 0.012));
  float standH = 0.5 * (MONITOR.y - hs.y - DESK_BACK - 0.012);
  shadowBox(p - vec2(MONITOR.x - 0.012, DESK_BACK + 0.005), vec2(hs.x * 0.8, 0.01), 0.01, 0.025, 0.6);
  lay(BEIGE * 0.6, cover(sdBox(st, vec2(0.06, standH), 0.0)), 0.6, 1.0);
  lay(BEIGE * 0.85, cover(sdBox(p - vec2(MONITOR.x, DESK_BACK + 0.006), vec2(0.085, 0.008), 0.004)), 0.9, 1.0);
  // The side going back to the tube's bulge: a darker panel beyond the case's far edge.
  vec2 sq = q - vec2(hs.x, 0.0);
  float side = max(max(-sq.x, sq.x - 0.03), abs(sq.y) - (hs.y - 0.01 - sq.x * 0.8));
  shadowBox(q - vec2(0.02, -0.015), hs, 0.02, 0.04, 0.5);
  lay(BEIGE * (0.48 - 2.0 * sq.x), cover(side), 0.3, 1.0);
  // The case's front.
  float d = sdBox(q, hs, 0.018);
  vec3 c = BEIGE * (0.9 + 0.12 * smoothstep(-hs.y, hs.y, q.y));
  c *= 0.85 + 0.15 * smoothstep(0.0, -0.008, d);
  // The bezel's bevel round the tube, and the dark recess.
  vec2 sc = p - SCREEN.xy;
  float rec = sdBox(sc, SCREEN.zw + 0.012, 0.02);
  c *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.012, rec)) * smoothstep(-0.02, 0.0, sc.y + sc.x * 0.2 + 0.02);
  c = mix(c, vec3(0.03, 0.035, 0.04), cover(sdBox(sc, SCREEN.zw + 0.004, 0.016)));
  // Under the screen: two knobs, a vent and the power light.
  float row = MONITOR.y - hs.y + 0.022;
  for (int i = 0; i < 2; i++) {
    vec2 kq = p - vec2(MONITOR.x + hs.x - 0.03 - float(i) * 0.024, row);
    c = mix(c, vec3(0.2, 0.18, 0.16) * (0.7 + 0.5 * smoothstep(0.004, -0.004, kq.x + kq.y)), cover(length(kq) - 0.007));
  }
  vec2 vq = p - vec2(MONITOR.x - hs.x + 0.06, row);
  c = mix(c, c * 0.55, cover(abs(fract(vq.x / 0.008) - 0.5) * 0.008 - 0.0015) * step(abs(vq.x), 0.04) * step(abs(vq.y), 0.006));
  lay(c, cover(d), 1.0, 1.0);
  vec2 led = p - vec2(MONITOR.x + hs.x - 0.08, row);
  glow(vec3(0.9, 0.12, 0.05), cover(length(led) - 0.0028));
  em += vec3(0.25, 0.03, 0.01) * exp(-dot(led, led) / 0.00003) * (1.0 - cover(length(led) - 0.0028));
}

/** The cassette recorder: a dark-topped beige box, a window over the tape (the reels are live), and its keys. */
void deck(vec2 p) {
  vec2 q = p - DECK.xy;
  vec2 hs = DECK.zw;
  if (sdBox(q, hs, 0.0) > 0.03) {
    return;
  }
  shadowBox(q - vec2(-0.006, -0.008), hs, 0.004, 0.02, 0.5);
  vec3 c = BEIGE * 0.8 * (0.9 + 0.15 * smoothstep(-hs.y, hs.y, q.y));
  c = mix(c, vec3(0.12, 0.11, 0.1), step(hs.y * 0.05, q.y));
  vec2 wq = p - DECK_WINDOW.xy;
  float win = sdBox(wq, DECK_WINDOW.zw, 0.004);
  c = mix(c, vec3(0.25, 0.24, 0.22), cover(win - 0.004));
  // The cassette inside, under the window: a label and the tape between the reels.
  vec3 cas = vec3(0.08);
  cas = mix(cas, vec3(0.8, 0.78, 0.7), step(0.006, wq.y));
  cas = mix(cas, vec3(0.8, 0.25, 0.15), step(0.0105, wq.y) * step(wq.y, 0.0125));
  c = mix(c, cas, cover(win));
  // Piano keys along the front.
  float kx = clamp(floor((q.x + hs.x - 0.008) / 0.0195), 0.0, 4.0);
  vec2 kq = q - vec2(-hs.x + 0.0175 + kx * 0.0195, -hs.y + 0.012);
  vec3 key = kx == 0.0 ? vec3(0.65, 0.18, 0.12) : vec3(0.58, 0.56, 0.52);
  c = mix(c, key * (0.75 + 0.35 * smoothstep(-0.006, 0.006, kq.y)), cover(sdBox(kq, vec2(0.0082, 0.0075), 0.0015)));
  lay(c, cover(sdBox(q, hs, 0.005)), 1.0, 1.0);
}

/** A stack of cassettes in their cases, seen edge on. */
void cassettes(vec2 p) {
  vec2 q = p - CASSETTES.xy;
  vec2 hs = CASSETTES.zw;
  if (sdBox(q, hs, 0.0) > 0.03) {
    return;
  }
  shadowBox(q - vec2(-0.006, -0.006), hs, 0.002, 0.016, 0.5);
  float pitch = 2.0 * hs.y / 4.0;
  float k = clamp(floor((q.y + hs.y) / pitch), 0.0, 3.0);
  float off = (rand(vec2(k, 4.0), 7u) - 0.5) * 0.012;
  vec2 cq = q - vec2(off, -hs.y + (k + 0.5) * pitch);
  vec2 ch = vec2(hs.x - 0.006, pitch * 0.5 - 0.0008);
  float r = rand(vec2(k, 5.0), 7u);
  vec3 label = r < 0.3 ? vec3(0.85, 0.82, 0.72) : r < 0.55 ? vec3(0.2, 0.35, 0.65) : r < 0.8 ? vec3(0.9, 0.7, 0.2) : vec3(0.12);
  vec3 c = vec3(0.45, 0.47, 0.5) * (0.7 + 0.4 * smoothstep(-ch.y, ch.y, cq.y));
  c = mix(c, label, step(abs(cq.x), ch.x - 0.006) * step(abs(cq.y), ch.y * 0.6));
  c = mix(c, vec3(0.75, 0.15, 0.12), step(abs(cq.x), ch.x - 0.006) * step(abs(cq.y - ch.y * 0.15), ch.y * 0.12) * step(r, 0.55));
  lay(c, cover(sdBox(cq, ch, 0.0012)), 1.0, 0.8);
}

/** The computer: a beige wedge, its keyboard of brown keys, a few grey ones, a long space bar and a power light. */
void keyboard(vec2 p) {
  vec2 q = p - KEYBOARD.xy;
  vec2 hs = KEYBOARD.zw;
  if (sdBox(q, hs, 0.0) > 0.03) {
    return;
  }
  shadowBox(q - vec2(-0.008, -0.01), hs, 0.006, 0.02, 0.55);
  // The front face (the wedge's low edge), then the sloping top.
  float split = -hs.y + 0.016;
  float d = sdBox(q, hs, 0.006);
  vec3 c = BEIGE * mix(0.62, 0.95, smoothstep(split - 0.002, split + 0.002, q.y));
  c *= q.y > split ? 0.9 + 0.12 * (q.y - split) / (hs.y - split) : 1.0;
  // Keys: five rows on the sloping top.
  vec2 kp = vec2(q.x + hs.x - 0.02, q.y - split - 0.006);
  float pitch = 0.0182;
  float rowH = 0.0118;
  float rowI = floor(kp.y / rowH);
  if (rowI >= 0.0 && rowI < 5.0) {
    float shift = rowI * 0.0045;
    float kx = floor((kp.x - shift) / pitch);
    vec2 kq = vec2(kp.x - shift - (kx + 0.5) * pitch, kp.y - (rowI + 0.5) * rowH);
    float inRow = step(0.0, kx) * step(kx, 15.0);
    vec2 khs = vec2(pitch * 0.5 - 0.0018, rowH * 0.5 - 0.0016);
    if (rowI == 0.0) {
      // The space bar.
      inRow = step(abs(kp.x - 0.17), 0.075);
      kq = vec2(kp.x - 0.17, kq.y);
      khs.x = 0.075;
    }
    vec3 keyC = kx > 13.0 && rowI > 0.0 ? vec3(0.55, 0.53, 0.5) : vec3(0.36, 0.28, 0.22);
    keyC *= 0.8 + 0.35 * smoothstep(-khs.y, khs.y, kq.y);
    c = mix(c, c * 0.55, inRow * cover(sdBox(kq + vec2(0.0, 0.0012), khs, 0.0015)));
    c = mix(c, keyC, inRow * cover(sdBox(kq, khs, 0.0015)));
  }
  lay(c, cover(d), 1.3, 1.0);
  vec2 led = q - vec2(hs.x - 0.02, split - 0.008);
  glow(vec3(0.95, 0.2, 0.08), cover(length(led) - 0.0022));
}

/** The joystick: a black base with a red fire button and a stick with a knob. */
void joystick(vec2 p) {
  vec2 q = p - JOYSTICK.xy;
  vec2 hs = JOYSTICK.zw;
  if (sdBox(q, hs + vec2(0.0, 0.08), 0.0) > 0.03) {
    return;
  }
  shadowBox(q - vec2(-0.006, -0.008), hs, 0.008, 0.016, 0.5);
  vec2 top = vec2(0.004, hs.y + 0.065);
  shadowBox(p - JOYSTICK.xy - vec2(-0.012, hs.y * 0.3), vec2(0.004, 0.03), 0.004, 0.012, 0.25);
  lay(vec3(0.07) * (0.7 + 0.5 * smoothstep(-hs.y, hs.y, q.y)), cover(sdBox(q, hs, 0.008)), 1.0, 1.0);
  lay(vec3(0.09), cover(sdBox(q - vec2(0.0, hs.y - 0.002), vec2(0.016, 0.005), 0.004)), 1.0, 1.0);
  lay(vec3(0.08) * (0.7 + 0.6 * smoothstep(0.004, -0.004, q.x - top.x * (q.y / top.y))), cover(sdSeg(q, vec2(0.0, hs.y), top) - 0.0045), 1.0, 1.0);
  vec2 kq = q - top;
  lay(vec3(0.1) + vec3(0.25) * smoothstep(0.008, 0.0, length(kq - vec2(-0.003, 0.003))), cover(length(kq) - 0.009), 1.0, 1.0);
  vec2 bq = q - vec2(-hs.x + 0.012, hs.y - 0.002);
  lay(vec3(0.75, 0.1, 0.08) * (0.7 + 0.5 * smoothstep(-0.004, 0.004, bq.y)), cover(sdBox(bq, vec2(0.007, 0.004), 0.003)), 1.0, 1.0);
}

/** How much of the screen's glow reaches a point: strong close to the tube, a soft wash further off. */
float crtFall(vec2 p) {
  float d = max(sdBox(p - SCREEN.xy, SCREEN.zw, 0.02), 0.0);
  float below = smoothstep(SCREEN.y, SCREEN.y - 0.3, p.y);
  return 0.75 * exp(-d / 0.03) + (0.45 + 0.25 * below) * exp(-d / 0.22);
}

/** How much of the lava lamp's light reaches a point. */
float lampFall(vec2 p) {
  vec2 d = (p - LAMP_LIGHT) * vec2(1.0, 0.75);
  float r = length(d);
  return 0.8 * exp(-r / 0.035) + 0.5 * exp(-r / 0.2);
}

/** The streetlight's slats on the ceiling, above and ahead of the window. */
float streetOnCeiling(vec2 p) {
  if (p.y < CEILING_Y) {
    return 0.0;
  }
  float x = (p.x - WINDOW.x) / (0.3 + 1.2 * (p.y - CEILING_Y));
  return 0.22 * exp(-x * x) * ceilingSlats(p.y);
}

vec4 room(vec2 p) {
  wallpaper(p);
  ceiling(p);
  carpet(p);
  windowBlinds(p);
  poster(p, POSTER_SUNSET, 0);
  poster(p, POSTER_SPACE, 1);
  poster(p, POSTER_CAR, 2);
  shelf(p);
  bedside(p);
  desk(p);
  monitor(p);
  deck(p);
  cassettes(p);
  keyboard(p);
  joystick(p);
  if (uPass == 0) {
    vec3 light = AMBIENT + STREET * streetOnCeiling(p);
    return vec4(alb * sh * light + em, clamp(rl * lampFall(p), 0.0, 1.0));
  }
  return vec4(alb * sh, clamp(rc * crtFall(p), 0.0, 1.0));
}

void main() {
  px = 1.0 / (uRes.y * uK);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    vec2 f = (gl_FragCoord.xy + o - 0.5 * uRes) / uRes.y;
    sum += room(vec2(f.x * uSide, f.y) / uK);
  }
  sum *= 0.25;
  outColor = vec4(sum.rgb + (uPass == 0 ? dither8(gl_FragCoord.xy) : 0.0), sum.a);
}
`;

/**
 * Every frame: the cached room lit by the screen's glow, the lava lamp, the
 * bedside lamp, and any headlights sweeping across the ceiling.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uBase;
uniform sampler2D uAlbedo;
uniform vec2 uRes;
uniform float uSide;
uniform float uK;
uniform vec3 uCrt;
uniform vec3 uLamp;
uniform vec3 uBed;
/** The headlights' patch: its centre (design x) and brightness. */
uniform vec2 uHead;
out vec4 outColor;
${DITHER_GLSL}
${SHARED_GLSL}
const vec2 BULB = vec2(${g(BULB[0])}, ${g(BULB[1])});
const vec3 HEADLIGHT = ${v3(HEADLIGHT_RGB)};
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uBase, ip, 0);
  vec4 b = texelFetch(uAlbedo, ip, 0);
  vec2 f = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 p = vec2(f.x * uSide, f.y) / uK;
  vec3 light = b.a * uCrt + a.a * uLamp;
  vec2 bd = p - BULB;
  light += uBed * (exp(-dot(bd, bd) / 0.0025) + 0.4 * exp(-length(bd * vec2(0.8, 1.0)) / 0.18));
  if (uHead.y > 0.0 && p.y > CEILING_Y) {
    float x = (p.x - uHead.x) / ${g(HEADLIGHT_WIDTH)};
    light += HEADLIGHT * (uHead.y * exp(-x * x) * ceilingSlats(p.y));
  }
  // The tube's bloom on the bezel round it.
  vec3 c = a.rgb + b.rgb * light + uCrt * (0.12 * b.a * b.a * b.a);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * The computer's picture, at its own 320 x 200 pixels: the demo (copper bars,
 * a starfield and a sine scroller), the loading screen (slow stripes in the
 * border) or the prompt, crossfaded by uMode.
 */
const DEMO_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uFont;
uniform sampler2D uCodes;
/** The modes' weights: demo, stripes, prompt. */
uniform vec3 uMode;
uniform float uScroll;
uniform int uLen;
uniform float uWave;
uniform vec3 uBars;
uniform float uStarT;
uniform float uStripe;
uniform float uCursor;
out vec4 outColor;
${HASH32_GLSL}
const float TAU = 6.28318530718;
const float W = ${g(DEMO_W)};
const float H = ${g(DEMO_H)};
const int GW = ${String(GLYPH_W)};
const int GH = ${String(GLYPH_H)};
const float CELL = ${g(CELL)};
const float SCALE = ${g(GLYPH_SCALE)};
const vec4 PAPER = vec4(${g(PAPER[0])}, ${g(PAPER[1])}, ${g(PAPER[2])}, ${g(PAPER[3])});
const vec3 PAL0 = ${v3(STRIPE_PALETTE[0])};
const vec3 PAL1 = ${v3(STRIPE_PALETTE[1])};
const vec3 PAL2 = ${v3(STRIPE_PALETTE[2])};
const vec3 PAL3 = ${v3(STRIPE_PALETTE[3])};

int codeAt(int col, int row) {
  return int(texelFetch(uCodes, ivec2(col, row), 0).r * 255.0 + 0.5);
}
/** Glyph code's dot at column x, row y (0 at the top), 0 outside it. */
float dot5x7(int code, int x, int y) {
  if (x < 0 || x >= GW || y < 0 || y >= GH) {
    return 0.0;
  }
  return texelFetch(uFont, ivec2(code * GW + x, GH - 1 - y), 0).r;
}
/** A line of text from the codes texture's row, at 1:1 in 6 x 8 cells from origin o (pixels, y down). */
float textLine(vec2 p, vec2 o, int row, int cols) {
  vec2 l = p - o;
  if (l.x < 0.0 || l.y < 0.0 || l.y >= 8.0) {
    return 0.0;
  }
  int col = int(l.x) / 6;
  if (col >= cols) {
    return 0.0;
  }
  return dot5x7(codeAt(col, row), int(l.x) % 6, int(l.y));
}

/** The loading stripes' colour (the twin of stripeColor in bedroom80s-sim.ts). */
vec3 pal(int i) {
  i = i % 4;
  return i == 0 ? PAL0 : i == 1 ? PAL1 : i == 2 ? PAL2 : PAL3;
}
vec3 stripeColor(float v) {
  float s = v * ${g(STRIPE_BANDS)} + uStripe;
  float i = floor(s);
  float w = smoothstep(${g(1 - STRIPE_EDGE)}, 1.0, s - i);
  int k = int(i);
  return mix(pal(k), pal(k + 1), w);
}

/** The scroller's coverage at p: dot-matrix letters scaled up, riding a sine wave. */
float scroller(vec2 p) {
  float dy = ${g(SCROLL_SWING)} * sin(p.x * 0.035 + uWave);
  float ly = p.y - (${g(SCROLL_Y)} - float(GH) * SCALE * 0.5) - dy;
  if (ly < 0.0 || ly >= float(GH) * SCALE) {
    return 0.0;
  }
  float tx = p.x + uScroll;
  float ci = floor(tx / CELL);
  int idx = int(mod(ci, float(uLen)));
  int cx = int(floor((tx - ci * CELL) / SCALE));
  return dot5x7(codeAt(idx, 0), cx, int(floor(ly / SCALE)));
}

vec3 demo(vec2 p) {
  vec3 c = mix(vec3(0.0, 0.0, 0.05), vec3(0.03, 0.0, 0.07), p.y / H);
  // Stars: at most one per row, in three layers drifting left at different speeds.
  uint h = hash32(uint(p.y) * 0x9e3779b1u + 7u);
  if ((h & 255u) < 70u) {
    uint layer = (h >> 8) % 3u;
    float speed = ${g(STAR_SPEED)} * float(1u << layer);
    float x0 = float((h >> 12) & 1023u) / 1024.0 * W;
    float sx = mod(x0 - uStarT * speed, W);
    float b = 0.35 + 0.3 * float(layer);
    c += vec3(b) * step(abs(p.x - sx - 0.5), 0.6);
  }
  // Two rainbow raster lines.
  for (int i = 0; i < 2; i++) {
    float y = i == 0 ? 28.0 : 118.0;
    vec3 hue = 0.55 + 0.45 * cos(TAU * (p.x / W + vec3(0.0, 0.33, 0.67)));
    c = mix(c, hue * 0.8, step(abs(p.y - y), 0.75));
  }
  // Copper bars: soft horizontal gradients bobbing slowly.
  for (int i = 0; i < 3; i++) {
    float d = abs(p.y - uBars[i]) / 12.0;
    if (d < 1.0) {
      vec3 bc = i == 0 ? vec3(1.0, 0.35, 0.2) : i == 1 ? vec3(0.25, 0.9, 0.6) : vec3(0.45, 0.4, 1.0);
      float k = cos(d * 1.5707963);
      c = mix(c, bc * (0.25 + 0.7 * k), smoothstep(0.0, 0.3, k));
    }
  }
  // The scroller, with a drop shadow.
  float shadow = scroller(p - vec2(2.0, 2.0));
  c *= 1.0 - 0.7 * shadow;
  float s = scroller(p);
  vec3 tc = mix(vec3(1.0, 0.92, 0.45), vec3(1.0, 0.35, 0.65), clamp((p.y - ${g(SCROLL_Y)} + 12.0) / 24.0, 0.0, 1.0));
  return mix(c, tc, s);
}

bool inPaper(vec2 p) {
  return p.x >= PAPER.x && p.x < PAPER.x + PAPER.z && p.y >= PAPER.y && p.y < PAPER.y + PAPER.w;
}

vec3 loading(vec2 p) {
  if (!inPaper(p)) {
    return stripeColor(p.y / H);
  }
  vec3 c = ${v3(LOADING_PAPER)};
  float t = textLine(p, PAPER.xy + vec2(8.0, 8.0), ${String(LOADING_ROW)}, 16);
  return mix(c, vec3(0.75, 0.75, 0.72), t);
}

vec3 prompt(vec2 p) {
  vec3 border = vec3(0.4, 0.42, 0.8);
  if (!inPaper(p)) {
    return border;
  }
  vec3 paper = vec3(0.14, 0.15, 0.48);
  vec3 ink = vec3(0.6, 0.62, 0.95);
  float t = 0.0;
  for (int i = 0; i < ${String(PROMPT_LINES.length)}; i++) {
    t = max(t, textLine(p, PAPER.xy + vec2(4.0, 6.0 + 8.0 * float(i)), ${String(PROMPT_ROW)} + i, 32));
  }
  vec2 cur = p - (PAPER.xy + vec2(4.0, 6.0 + 8.0 * ${g(PROMPT_LINES.length)}));
  float block = step(0.0, cur.x) * step(cur.x, 5.0) * step(0.0, cur.y) * step(cur.y, 7.0);
  vec3 c = mix(paper, ink, t);
  return mix(c, mix(paper, ink, uCursor), block);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, H - gl_FragCoord.y);
  vec3 c = vec3(0.0);
  if (uMode.x > 0.0) {
    c += uMode.x * demo(p);
  }
  if (uMode.y > 0.0) {
    c += uMode.y * loading(p);
  }
  if (uMode.z > 0.0) {
    c += uMode.z * prompt(p);
  }
  outColor = vec4(c, 1.0);
}
`;

/**
 * The live parts, each drawn premultiplied in a scissor round its box: the
 * CRT's picture (curved, with scanlines and a soft phosphor glow), the lava
 * lamp's glass with its wax, and a cassette reel.
 */
const GADGET_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform int uKind;
/** The part's centre and half size (frame units), or centre and radius. */
uniform vec4 uBox;
uniform vec4 uVal;
uniform sampler2D uDemo;
uniform vec4 uBlobs[${String(LAMP_BLOBS)}];
uniform float uBlobR2[${String(LAMP_BLOBS)}];
${lavaFieldGlsl(LAMP_BLOBS)}
uniform vec3 uLampRgb;
/** The lamp's width in lamp units, and its wax pool's radius squared. */
uniform vec2 uLampW;
out vec4 outColor;
${SHARED_GLSL}

/** The tube: barrel curvature, rounded corners, scanlines, a soft glow and the glass's sheen. */
vec4 crt(vec2 q) {
  vec2 hs = uBox.zw;
  vec2 c = q / hs;
  c *= 1.0 + 0.055 * dot(c, c);
  vec2 w = c * 0.5 + 0.5;
  vec2 e = abs(c) - vec2(0.88);
  float corner = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - 0.12;
  float tube = 1.0 - smoothstep(-0.02, 0.0, corner);
  vec2 texel = 1.0 / vec2(${g(DEMO_W)}, ${g(DEMO_H)});
  vec3 pic = texture(uDemo, w).rgb;
  vec3 halo = texture(uDemo, w + texel * vec2(1.5, 1.5)).rgb + texture(uDemo, w + texel * vec2(-1.5, 1.5)).rgb
    + texture(uDemo, w + texel * vec2(1.5, -1.5)).rgb + texture(uDemo, w + texel * vec2(-1.5, -1.5)).rgb;
  float linePx = 2.0 * hs.y * uRes.y / ${g(DEMO_H)};
  float scan = mix(1.0, 0.68 + 0.32 * cos(TAU * w.y * ${g(DEMO_H)}), smoothstep(1.6, 3.2, linePx));
  vec3 col = pic * scan + halo * 0.07;
  col *= 0.9 * (1.0 - 0.22 * dot(c, c));
  // The glass: a faint grey even when black, and a soft reflection high up.
  col += vec3(0.025, 0.028, 0.03) + vec3(0.05) * smoothstep(0.5, 0.0, length(c - vec2(-0.45, 0.55)));
  vec3 outside = vec3(0.03, 0.035, 0.04) + uVal.rgb * 0.06;
  col = mix(outside, col, tube);
  float a = cover(sdBox(q, hs, 0.17 * hs.y));
  return vec4(col * a, a);
}

/** The lava lamp's glass: wax blobs (as in the Lava Lamp effect) rising and falling in tinted liquid. */
vec4 lamp(vec2 q) {
  vec2 hs = uBox.zw;
  float ny = q.y / hs.y;
  float hw = hs.x * (ny < -0.4 ? mix(0.78, 1.0, (ny + 1.0) / 0.6) : mix(1.0, 0.5, (ny + 0.4) / 1.4));
  float d = max(abs(q.x) - hw, abs(q.y) - hs.y);
  float a = cover(d);
  if (a <= 0.0) {
    return vec4(0.0);
  }
  vec2 p = vec2((q.x + hs.x) / (2.0 * hs.x) * uLampW.x, (hs.y - q.y) / (2.0 * hs.y) * ${g(REF_H)});
  float field = lavaField(p, uLampW.y);
  float t = p.y / ${g(REF_H)};
  vec3 wax = mix(mix(uLampRgb, vec3(1.0, 0.85, 0.6), 0.3), uLampRgb, t);
  vec3 liquid = uLampRgb * 0.22 + vec3(0.03, 0.02, 0.04);
  liquid *= 0.7 + 0.5 * (1.0 - abs(q.x / hw));
  float edge = smoothstep(0.88, 1.12, field);
  float core = smoothstep(1.0, 3.6, field);
  vec3 lit = wax * (0.78 + 0.22 * core) + (1.0 - wax) * 0.3 * core * core;
  float h = smoothstep(0.38, 1.0, field);
  vec3 col = mix(liquid + wax * 0.3 * h * h, lit, edge);
  // The glass's sheen down one side, and its edges.
  col += vec3(0.12) * exp(-pow((q.x / hw + 0.45) / 0.12, 2.0));
  col *= 0.75 + 0.25 * smoothstep(1.0, 0.7, abs(q.x / hw));
  return vec4(col * a, a);
}

/** A cassette reel turned to uVal.x: a white hub with six teeth inside a pack of brown tape. */
vec4 reel(vec2 q) {
  float R = uBox.z;
  float r = length(q);
  float cs = cos(uVal.x);
  float sn = sin(uVal.x);
  vec2 qr = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
  vec3 tape = vec3(0.14, 0.08, 0.05) * (0.8 + 0.4 * smoothstep(R * 0.5, R, r));
  tape += vec3(0.05, 0.035, 0.02) * smoothstep(0.6, 1.0, dot(normalize(q + 1e-6), vec2(-0.6, 0.8)));
  vec3 c = tape;
  float hubR = 0.48 * R;
  vec3 hub = vec3(0.86, 0.84, 0.8);
  float ang = atan(qr.y, qr.x);
  float tooth = abs(fract(ang / TAU * 6.0) - 0.5) * 2.0;
  float hole = r - mix(0.2 * R, 0.3 * R, step(0.5, tooth));
  hub = mix(hub, vec3(0.05), cover(hole));
  c = mix(c, hub, cover(r - hubR));
  float a = cover(r - R);
  return vec4(c * a, a);
}

void main() {
  px = 1.0 / uRes.y;
  vec2 f = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 q = f - uBox.xy;
  if (uKind == ${String(KIND_CRT)}) {
    outColor = crt(q);
  } else if (uKind == ${String(KIND_LAMP)}) {
    outColor = lamp(q);
  } else {
    outColor = reel(q);
  }
}
`;

/** Writes `text`'s glyph indices into `row` of the codes texture, blank-padded. */
function writeRow(codes: Uint8Array, row: number, text: string): void {
  const o = row * CODES_W;
  codes.fill(0, o, o + CODES_W);
  let i = 0;
  for (const ch of text) {
    if (i >= CODES_W) {
      break;
    }
    codes[o + i++] = glyphIndex(ch);
  }
}

/**
 * A teenager's bedroom in the mid-eighties, late at night: a beige home
 * computer and its CRT on a desk to one side, with a cassette recorder, tapes
 * and a joystick; posters of a neon sunset, a space scene and a sports car on
 * patterned wallpaper; a shelf with books, a radio and a lava lamp; a window
 * with blinds and the streetlight behind them; a bedside lamp and the bed. The
 * room is drawn once per resize. Each frame renders the computer's picture at
 * 320 x 200, lights the room with the screen's glow, the lava lamp, the
 * bedside lamp and any passing car's headlights, and draws the live parts:
 * the tube, the lava lamp's wax and the cassette's turning reels.
 */
export const bedroom80s = defineEffect(bedroom80sMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);
      const roomProgram = program(ROOM_FRAGMENT);
      const compProgram = program(COMPOSITE_FRAGMENT);
      const demoProgram = program(DEMO_FRAGMENT);
      const gadgetProgram = program(GADGET_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ru = createUniforms(gl, roomProgram, ["uRes", "uSide", "uK", "uPass"]);
      const cu = createUniforms(gl, compProgram, [
        "uBase",
        "uAlbedo",
        "uRes",
        "uSide",
        "uK",
        "uCrt",
        "uLamp",
        "uBed",
        "uHead",
      ]);
      const du = createUniforms(gl, demoProgram, [
        "uFont",
        "uCodes",
        "uMode",
        "uScroll",
        "uLen",
        "uWave",
        "uBars",
        "uStarT",
        "uStripe",
        "uCursor",
      ]);
      const gu = createUniforms(gl, gadgetProgram, [
        "uRes",
        "uKind",
        "uBox",
        "uVal",
        "uDemo",
        "uBlobs",
        "uBlobR2",
        "uLampRgb",
        "uLampW",
      ]);
      gl.useProgram(compProgram);
      cu.i1("uBase", 0);
      cu.i1("uAlbedo", 1);
      gl.useProgram(demoProgram);
      du.i1("uFont", 0);
      du.i1("uCodes", 1);
      gl.useProgram(gadgetProgram);
      gu.i1("uDemo", 0);
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
      const codes = new Uint8Array(CODES_W * CODE_ROWS);
      PROMPT_LINES.forEach((line, i) => {
        writeRow(codes, PROMPT_ROW + i, line);
      });
      writeRow(codes, LOADING_ROW, LOADING_LINE);
      const codesTex = scope.add(
        createDataTexture(gl, {
          width: CODES_W,
          height: CODE_ROWS,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: codes,
          filter: gl.NEAREST,
        }),
        delTex,
      );
      const demoTarget = createRenderTarget(gl, DEMO_W, DEMO_H, gl.RGBA8);
      if (!demoTarget) {
        throw new Error("1980s Bedroom: RGBA8 screen target is not renderable");
      }
      scope.own(demoTarget);

      let baseTarget: RenderTarget | null = null;
      let albedoTarget: RenderTarget | null = null;
      scope.defer(() => {
        baseTarget?.dispose();
        albedoTarget?.dispose();
      });
      let width = 1;
      let height = 1;
      let k = 1;
      // What the cached room and scroller were drawn for; NaN or null forces a redraw.
      let roomSide = Number.NaN;
      let scrollText: string | null = null;
      let scrollLen = 1;
      const lampRgb = unitRgbMemo();

      let time = 0;
      const modes = new Float64Array(3).fill(Number.NaN);
      const glowTarget: Rgb = [0, 0, 0];
      const glowShown: Rgb = [Number.NaN, 0, 0];
      let bed = Number.NaN;
      const reels = createReels();
      const blobs = makeBlobs(17).slice(0, LAMP_BLOBS);
      const blobData = new Float32Array(LAMP_BLOBS * 4);
      const blobR2 = new Float32Array(LAMP_BLOBS);
      const blobLife = new Float32Array(LAMP_BLOBS).fill(1);
      const lampW = (REF_H * LAMP_GLASS[2]) / LAMP_GLASS[3];

      /** Mirrors the room: 1, or -1 for the right-hand side. */
      let side = 1;
      /** Draws gadget `kind` in a scissor round its box, mirrored by `side` and scaled by `k`. Expects the gadget program bound. */
      const drawGadget = (kind: number, cx: number, cy: number, hw: number, hh: number) => {
        const x = side * cx * k;
        const y = cy * k;
        const w = hw * k;
        const h = hh * k;
        gu.i1("uKind", kind);
        gu.f4("uBox", x, y, w, h);
        if (scissorBox(gl, width, height, x, y, w, h)) {
          triangle.draw();
        }
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          baseTarget?.dispose();
          albedoTarget?.dispose();
          baseTarget = null;
          albedoTarget = null;
          baseTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          albedoTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          k = fitScale(width / height);
          roomSide = Number.NaN;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!baseTarget || !albedoTarget) {
            return;
          }
          side = p.side === "right" ? -1 : 1;

          // 1. The room, when the size or the side changes.
          if (side !== roomSide) {
            roomSide = side;
            gl.useProgram(roomProgram);
            ru.f2("uRes", width, height);
            ru.f1("uSide", side);
            ru.f1("uK", k);
            for (const [pass, target] of [
              [0, baseTarget],
              [1, albedoTarget],
            ] as const) {
              ru.i1("uPass", pass);
              target.bind();
              triangle.draw();
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 2. The scroller's glyphs, when its text changes.
          if (p.scroller !== scrollText) {
            scrollText = p.scroller;
            scrollLen = scrollerCodes(p.scroller, codes.subarray(0, CODES_W));
            gl.activeTexture(gl.TEXTURE1);
            updateDataTexture(gl, codesTex, CODES_W, CODE_ROWS, gl.RED, gl.UNSIGNED_BYTE, codes);
            gl.bindTexture(gl.TEXTURE_2D, null);
          }

          // 3. The screen's modes, the lights and the reels.
          stepModes(modes, p.screen, step);
          const phase = stripePhase(time);
          screenGlow(modes, phase, glowTarget);
          slewColor(glowShown, glowTarget, COMFORT_RATE, step);
          bed = stepFade(bed, p.bedside, step, BEDSIDE_FADE);
          stepReels(reels, p.playing, step);
          const sweep = p.cars ? sweepAt(time) : -1;

          // 4. The computer's picture.
          demoTarget.bind();
          gl.useProgram(demoProgram);
          du.f3("uMode", modes[0], modes[1], modes[2]);
          du.f1("uScroll", scrollOffset(time * SCROLL_SPEED, scrollLen));
          du.i1("uLen", scrollLen);
          du.f1("uWave", (time * WAVE_SPEED) % TAU);
          du.f3(
            "uBars",
            BAR_MID + BAR_SWING * Math.sin((TAU * time) / BAR_PERIOD),
            BAR_MID + BAR_SWING * Math.sin((TAU * time) / BAR_PERIOD + 2.1),
            BAR_MID + BAR_SWING * Math.sin((TAU * time) / BAR_PERIOD + 4.2),
          );
          du.f1("uStarT", time % STAR_PERIOD);
          du.f1("uStripe", phase);
          du.f1("uCursor", cursorLevel(time));
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, font);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, codesTex);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);

          // 5. The room, lit.
          const lamp = lampRgb(p.lamp);
          gl.useProgram(compProgram);
          cu.f2("uRes", width, height);
          cu.f1("uSide", side);
          cu.f1("uK", k);
          cu.f3("uCrt", glowShown[0] * CRT_GAIN, glowShown[1] * CRT_GAIN, glowShown[2] * CRT_GAIN);
          cu.f3("uLamp", lamp[0] * LAMP_GAIN, lamp[1] * LAMP_GAIN, lamp[2] * LAMP_GAIN);
          const b = bed * bed * (3 - 2 * bed) * BEDSIDE_GAIN;
          cu.f3("uBed", BEDSIDE_RGB[0] * b, BEDSIDE_RGB[1] * b, BEDSIDE_RGB[2] * b);
          // The patch's centre, and its brightness there.
          cu.f2("uHead", sweepPos(sweep), headlightAt(sweepPos(sweep), sweep));
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, baseTarget.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, albedoTarget.texture);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);

          // 6. The live parts, each in a scissor round its box.
          gl.useProgram(gadgetProgram);
          gu.f2("uRes", width, height);
          gl.bindTexture(gl.TEXTURE_2D, demoTarget.texture);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.enable(gl.SCISSOR_TEST);
          gu.f4("uVal", glowShown[0], glowShown[1], glowShown[2], 0);
          drawGadget(KIND_CRT, SCREEN[0], SCREEN[1], SCREEN[2], SCREEN[3]);
          fillBlobs(
            blobData,
            blobR2,
            blobs,
            LAMP_BLOBS,
            time,
            BASE_RADIUS * LAMP_BLOB_SIZE * REF_H,
            lampW,
            blobLife,
          );
          gl.uniform4fv(gu.loc.uBlobs, blobData);
          gl.uniform1fv(gu.loc.uBlobR2, blobR2);
          gu.f3("uLampRgb", lamp[0], lamp[1], lamp[2]);
          gu.f2("uLampW", lampW, LAMP_POOL_R * LAMP_POOL_R);
          drawGadget(KIND_LAMP, LAMP_GLASS[0], LAMP_GLASS[1], LAMP_GLASS[2], LAMP_GLASS[3]);
          // Mirrored, the reels turn the other way, as a mirror shows them.
          gu.f4("uVal", side * reels.angle, 0, 0, 0);
          for (const [rx, ry] of REELS) {
            drawGadget(KIND_REEL, rx, ry, REEL_R, REEL_R);
          }
          gl.bindTexture(gl.TEXTURE_2D, null);
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
