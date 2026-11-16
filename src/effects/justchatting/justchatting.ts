import { BOOM_MIC_GLSL } from "../boom-mic";
import { createColorEase, unitRgbMemo } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat as F,
  type RenderTarget,
  resetUnpackState,
  scopedProgram,
  withScope,
} from "../gl";
import { approach, smoothstep } from "../math";
import { buildNeonTubes, measureLines, NEON_EMIT_GLSL } from "../neon-tubes";
import { HASH32_GLSL } from "../noise";
import { createSettledValue } from "../rebuild";
import { fitScale } from "../scene-layout";
import { SDF2D_GLSL } from "../sdf-glsl";
import { createStreamOverlays } from "../stream-overlay/overlay-layer";
import { advanceSwell, createSwell, swayGlsl } from "../sway";
import { defineEffect } from "../types";
import {
  fitSign,
  PLANT_BOTTOM,
  PLANT_LAYERS,
  PLANT_LEFT,
  PLANT_RIGHT,
  PLANT_TOP,
  PLAQUE_H,
  plantParts,
  signHum,
  signLine,
  signPlace,
} from "./justchatting-layout";
import { justchattingMeta } from "./justchatting.meta";

/** The light pass renders at 1/LIGHT_DIVISOR of the frame's size each way. */
const LIGHT_DIVISOR = 4;
/** The light target stores light divided by this, to fit 8 bits. */
const LIGHT_RANGE = 2;
/** The plant's layers are drawn at most this many pixels tall. */
const PLANT_MAX_PX = 1100;
/** Seconds the sign's text must hold still before its tubes are rebuilt. */
const INPUT_SETTLE = 0.3;
/** Most mounting clips on the sign. */
const MAX_CLIPS = 3;
/** Wall light per unit of the sign's blurred tube coverage. */
const NEON_GAIN = 9;
/** Seconds a side change cross-fades over, a time-of-day change eases over, and a sign colour eases. */
const SIDE_FADE = 1.5;
const TIME_EASE = 2;
const COLOUR_EASE = 1.2;
/** The room light at warmth 0 and 1. */
const COOL_LIGHT = [0.8, 0.84, 0.92] as const;
const WARM_LIGHT = [1, 0.76, 0.52] as const;
/** How far the plant's layers sway at their tips (design units), back to front. */
const SWAY_AMPLITUDE = [0.006, 0.008, 0.01] as const;
/** The plant's swell: slow, with a 12 s main sway. */
const SWELL = createSwell(120, [
  { cycles: 10, amplitude: 1, offset: 0 },
  { cycles: 7, amplitude: 0.6, offset: 0.27 },
  { cycles: 23, amplitude: 0.2, offset: 0.61 },
]);

const v4 = (a: number, b: number, c: number, d: number) =>
  `vec4(${F(a)}, ${F(b)}, ${F(c)}, ${F(d)})`;

const PLANT = plantParts();
const PLANT_W = PLANT_RIGHT - PLANT_LEFT;
const PLANT_H = PLANT_TOP - PLANT_BOTTOM;

/** Design units of a fragment (see fitScale): frame heights at 16:9, centred. */
const DESIGN_GLSL = /* glsl */ `
vec2 design(vec2 frag, vec2 res, float k) {
  return (frag - 0.5 * res) / (res.y * k);
}
`;

/**
 * Where things are, in the room's own layout (sign on the right; plant, window
 * and microphone on the left), from the frame's half width `halfW`.
 */
const PLACES_GLSL = /* glsl */ `
float halfW;
/** The window's inner edge and its sill. */
float windowX() { return -halfW + 0.235; }
const float SILL = -0.17;
/** The lamp's shade, on the shelf: centre, and the shade's top. */
vec2 lampAt() { return vec2(halfW - 0.115, 0.125); }
const float SHADE_TOP = 0.165;
`;

/**
 * The room, drawn once per resize with four samples per pixel, in two passes.
 * Pass 0: RGB is the surface's colour (albedo), A how much is in front of the
 * plant (the sofa, the throw and cushion, the microphone). Pass 1: R is the
 * window's glass, G the ring light's catchlight on the print, B the lamp
 * shade's own glow, and A how much of the spill light (lamp, window, neon)
 * reaches the surface.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uK;
uniform int uPass;
out vec4 outColor;
${SDF2D_GLSL}
${HASH32_GLSL}
${DESIGN_GLSL}
${PLACES_GLSL}
vec3 col;
float fg;
float recv;
float glass;
float catchLight;
float emit;

const vec3 WALL = vec3(0.68, 0.61, 0.53);
const vec3 VELVET = vec3(0.15, 0.33, 0.34);
const vec3 MUSTARD = vec3(0.78, 0.55, 0.18);
const vec3 KNIT = vec3(0.8, 0.74, 0.64);
const vec3 RUST = vec3(0.62, 0.3, 0.18);
const vec3 WALNUT = vec3(0.33, 0.2, 0.12);
const vec3 LINEN = vec3(0.86, 0.8, 0.68);
const vec3 BRASS = vec3(0.62, 0.5, 0.28);
const vec3 FRAME_PAINT = vec3(0.86, 0.84, 0.8);

float rand(vec2 cell, uint salt) {
  uvec2 u = uvec2(ivec2(cell) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ salt))) / 4294967296.0;
}

/** Paints colour c at coverage a, with how much spill light it gets. */
void lay(vec3 c, float a, float r) {
  col = mix(col, c, a);
  recv = mix(recv, r, a);
  glass *= 1.0 - a;
  catchLight *= 1.0 - a;
  emit *= 1.0 - a;
}
/** As lay, for something in front of the plant. */
void layFront(vec3 c, float a, float r) {
  lay(c, a, r);
  fg = mix(fg, 1.0, a);
}
void micLay(vec3 c, float a, float r) {
  layFront(c, a, r);
}
${BOOM_MIC_GLSL}

/** The window at the left edge: frame, glass, and a linen curtain at its inner side. */
void windowWall(vec2 p) {
  float wx = windowX();
  if (p.x > wx + 0.09) {
    return;
  }
  // The recess's shadow round the frame.
  float outer = max(p.x - wx - 0.012, SILL - 0.03 - p.y);
  col *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.03, outer)) * step(0.0, outer);
  // The frame.
  float frame = max(p.x - wx, SILL - 0.025 - p.y);
  lay(FRAME_PAINT * (0.85 + 0.15 * smoothstep(SILL - 0.025, SILL, p.y)), cover(frame), 0.9);
  // The glass, split by a transom.
  float g = max(max(p.x - (wx - 0.022), SILL - p.y), -(abs(p.y - 0.26) - 0.011));
  float a = cover(g);
  col = mix(col, vec3(0.0), a);
  glass = mix(glass, 1.0, a);
  // The curtain, gathered in soft folds just inside the window.
  float cx = p.x - (wx - 0.012);
  float hem = -0.3;
  float d = max(abs(cx - 0.03) - 0.04 - 0.004 * sin(p.y * 40.0), hem - p.y);
  float fold = 0.5 + 0.5 * sin(cx * 190.0 + 1.3 * sin(p.y * 6.0));
  vec3 c = LINEN * (0.62 + 0.38 * fold) * (0.9 + 0.1 * smoothstep(hem, 0.4, p.y));
  lay(c, cover(d), 0.9);
}

/** Books, a lamp and the shelf they stand on, on the right. */
void shelf(vec2 p) {
  float x0 = halfW - 0.345;
  float x1 = halfW - 0.045;
  if (p.x < x0 - 0.04 || p.y < -0.1 || p.y > 0.2) {
    return;
  }
  // The shelf's shadow on the wall below and behind it.
  float under = sdBox(p - vec2(0.5 * (x0 + x1), -0.02), vec2(0.5 * (x1 - x0), 0.02), 0.02);
  col *= 1.0 - 0.3 * (1.0 - smoothstep(-0.02, 0.04, under));
  // Brackets and board.
  lay(WALNUT * 0.55, cover(sdBox(p - vec2(x0 + 0.04, -0.03), vec2(0.006, 0.026), 0.002)), 0.7);
  lay(WALNUT * 0.55, cover(sdBox(p - vec2(x1 - 0.04, -0.03), vec2(0.006, 0.026), 0.002)), 0.7);
  float board = sdBox(p - vec2(0.5 * (x0 + x1), -0.007), vec2(0.5 * (x1 - x0), 0.007), 0.002);
  lay(WALNUT * (0.8 + 0.3 * smoothstep(-0.014, 0.0, p.y)), cover(board), 0.8);
  // Books: upright spines in muted colours, then two lying flat.
  float x = x0 + 0.012;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    float w = 0.0065 + 0.0045 * rand(vec2(fi, 5.0), 13u);
    float h = 0.04 + 0.022 * rand(vec2(fi, 3.0), 11u);
    vec3 c = mix(vec3(0.55, 0.22, 0.18), vec3(0.2, 0.32, 0.38), rand(vec2(fi, 7.0), 17u));
    c = mix(c, vec3(0.75, 0.66, 0.5), step(0.7, rand(vec2(fi, 9.0), 19u)));
    vec2 q = p - vec2(x + w, h);
    float d = sdBox(q, vec2(w, h), 0.0015);
    float band = step(abs(q.y - 0.6 * h), 0.004) + step(abs(q.y + 0.75 * h), 0.003);
    vec3 spine = c * (0.75 + 0.35 * smoothstep(-w, w, q.x)) * (1.0 + 0.35 * min(band, 1.0));
    lay(spine, cover(d), 0.8);
    x += 2.0 * w + 0.0015;
  }
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    vec2 q = p - vec2(x + 0.05 - 0.004 * fi, 0.009 + 0.018 * fi);
    vec3 c = i == 0 ? vec3(0.3, 0.36, 0.3) : vec3(0.7, 0.6, 0.45);
    lay(c * (0.8 + 0.25 * smoothstep(-0.009, 0.009, q.y)), cover(sdBox(q, vec2(0.04 - 0.005 * fi, 0.009), 0.0015)), 0.8);
  }
  // The lamp: a brass base and stem, and a linen shade lit from inside.
  vec2 l = lampAt();
  lay(BRASS * 0.8, cover(sdBox(p - vec2(l.x, 0.006), vec2(0.026, 0.006), 0.005)), 0.8);
  lay(BRASS * (0.7 + 0.5 * smoothstep(0.004, -0.004, p.x - l.x)), cover(abs(p.x - l.x) - 0.004) * step(p.y, 0.09) * step(0.0, p.y), 0.8);
  vec2 s = p - l;
  float hy = 0.5 * (SHADE_TOP - 0.085);
  float sy = s.y - (SHADE_TOP - hy - l.y);
  float hw = mix(0.042, 0.028, clamp(sy / (2.0 * hy) + 0.5, 0.0, 1.0));
  float shade = max(abs(s.x) - hw, abs(sy) - hy);
  float a = cover(shade);
  if (a > 0.0) {
    lay(LINEN * 0.7, a, 0.3);
    // Brightest low down, where the bulb is.
    emit = mix(emit, 0.55 + 0.45 * smoothstep(hy, -hy, sy), a);
  }
}

/** The framed print on the right: an abstract arch and sun on a pale mat, under glass. */
void framedPrint(vec2 p) {
  vec2 c = vec2(halfW - 0.47, 0.14);
  vec2 h = vec2(0.075, 0.105);
  vec2 q = p - c;
  if (abs(q.x) > h.x + 0.04 || abs(q.y) > h.y + 0.04) {
    return;
  }
  float outer = sdBox(q, h, 0.002);
  col *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.02, sdBox(q - vec2(0.008, -0.012), h, 0.01)));
  lay(vec3(0.06, 0.055, 0.05), cover(outer), 0.8);
  lay(vec3(0.88, 0.86, 0.82), cover(sdBox(q, h - 0.008, 0.0)), 0.8);
  vec2 ah = h - vec2(0.028);
  float art = sdBox(q, ah, 0.0);
  vec3 a = vec3(0.86, 0.76, 0.6);
  // A terracotta arch, a sage sun and a sand ground.
  vec2 arch = q - vec2(-0.012, -0.03);
  float ad = max(length(vec2(arch.x, max(arch.y, 0.0))) - 0.034, -arch.y - 0.045);
  a = mix(a, vec3(0.72, 0.36, 0.24), cover(ad));
  a = mix(a, vec3(0.5, 0.58, 0.44), cover(length(q - vec2(0.02, 0.04)) - 0.018));
  a = mix(a, vec3(0.78, 0.62, 0.42), cover(q.y + 0.05));
  lay(a, cover(art), 0.8);
  // The glass shows the ring light as a soft round catchlight, and a faint sheen.
  float inGlass = cover(sdBox(q, h - 0.008, 0.0));
  float spot = exp(-dot(q - vec2(-0.03, 0.045), q - vec2(-0.03, 0.045)) / 0.00035);
  float ring = smoothstep(0.004, 0.0, abs(length(q - vec2(-0.03, 0.045)) - 0.018));
  catchLight = mix(catchLight, 0.5 * spot + 0.35 * ring + 0.05, inGlass);
}

/**
 * The sofa's back at x, between arms whose inner sides are at +-inner: three
 * plump cushions. Returns its top, and in seam the distance to the nearest
 * join between cushions.
 */
float backTop(float x, float inner, out float seam) {
  float w = 2.0 * inner / 3.0;
  float f = (clamp(x, -inner, inner) + inner) / w;
  float c = min(floor(f), 2.0);
  float u = 2.0 * (f - c) - 1.0;
  float joint = fract(f);
  seam = abs(x) < inner - 0.01 ? min(joint, 1.0 - joint) * w : 1.0;
  return -0.25 + 0.014 * (1.0 - u * u);
}

/** The sofa across the bottom, with a throw over the left end and a cushion on the right. */
void sofa(vec2 p) {
  if (p.y > -0.18) {
    return;
  }
  float armX = halfW - 0.02;
  float seam;
  float top = backTop(p.x, armX - 0.1, seam);
  // A soft shadow on the wall just above it.
  col *= 1.0 - 0.28 * exp(-max(p.y - top, 0.0) / 0.025) * step(abs(p.x), armX + 0.1);
  float back = max(p.y - top, abs(p.x) - armX);
  vec3 v = VELVET * (0.65 + 0.35 * smoothstep(-0.5, top, p.y));
  // The cushions' rolled tops catch the light, and their joins sink in.
  v *= 1.0 + 0.5 * exp(-(top - p.y) / 0.02);
  v *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.012, seam));
  layFront(v, cover(back), 0.5);
  // The arms, rolled and lower, at both ends.
  vec2 q = vec2(abs(p.x) - armX, p.y + 0.43);
  float arm = sdBox(q, vec2(0.11, 0.12), 0.05);
  vec3 ac = VELVET * (0.7 + 0.45 * smoothstep(0.02, 0.12, q.y)) * (0.9 + 0.1 * smoothstep(0.1, -0.1, q.x));
  layFront(ac, cover(arm), 0.5);

  // The throw: a cream knit with rust stripes, draped over the back on the left.
  vec2 t = p - vec2(-0.58, 0.0);
  float hang = -0.47 + 0.02 * sin(t.x * 55.0);
  float throwD = max(max(abs(t.x) - 0.12 - 0.01 * (top - p.y), p.y - top - 0.008), hang - p.y);
  float rib = 0.5 + 0.5 * sin(t.x * 520.0);
  vec3 k = KNIT * (0.8 + 0.2 * rib);
  k = mix(k, RUST * (0.8 + 0.2 * rib), step(0.5, fract((p.y + 0.5) * 22.0)) * step(p.y, -0.32) * step(-0.43, p.y));
  k *= 0.75 + 0.3 * smoothstep(-0.5, top, p.y) + 0.15 * exp(-(top - p.y) / 0.015);
  layFront(k, cover(throwD), 0.5);
  // Its fringe.
  float fringe = max(abs(t.x) - 0.12, abs(p.y - hang + 0.012) - 0.012);
  layFront(KNIT * 0.7 * (0.7 + 0.3 * step(0.5, fract(t.x * 160.0))), cover(fringe), 0.5);

  // The cushion, leaning on the back at the right.
  vec2 c = p - vec2(0.6, -0.27);
  float r = -0.18;
  c = vec2(c.x * cos(r) - c.y * sin(r), c.x * sin(r) + c.y * cos(r));
  // Plump, so its sides curve in a little towards the corners.
  float cd = sdBox(c, vec2(0.075) - 0.012 * (c * c).yx / 0.0056, 0.032);
  vec3 cc = MUSTARD * (0.7 + 0.35 * smoothstep(-0.075, 0.075, c.y - 0.5 * c.x));
  // A woven diamond pattern, and its piping.
  vec2 dq = abs(fract(vec2(c.x + c.y, c.x - c.y) * 28.0) - 0.5);
  cc *= 0.92 + 0.12 * step(max(dq.x, dq.y), 0.15);
  cc = mix(cc, MUSTARD * 0.55, smoothstep(0.004, 0.0, abs(cd + 0.004)));
  layFront(cc, cover(cd), 0.5);
}

void room(vec2 p) {
  col = WALL * (0.92 + 0.08 * smoothstep(-0.5, 0.5, p.y));
  // A faint, broad plaster mottle.
  col *= 0.97 + 0.04 * rand(floor(p * 18.0), 3u) * 0.5 + 0.02 * sin(p.x * 9.0 + 2.0 * sin(p.y * 7.0));
  fg = 0.0;
  recv = 1.0;
  glass = 0.0;
  catchLight = 0.0;
  emit = 0.0;
  windowWall(p);
  shelf(p);
  framedPrint(p);
  sofa(p);
  boomMic(p, vec2(-0.61, 0.53), vec2(-0.53, 0.31), vec2(-0.372, 0.02), vec2(-0.42, 0.115), vec2(0.033, 0.068), vec2(-0.48, -0.62));
}

void main() {
  halfW = 0.5 * uRes.x / (uRes.y * uK);
  px = 1.0 / (uRes.y * uK);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    room(design(gl_FragCoord.xy + o, uRes, uK));
    sum += uPass == 0 ? vec4(col, fg) : vec4(glass, catchLight, emit, recv);
  }
  outColor = clamp(sum * 0.25, 0.0, 1.0);
}
`;

const LEAF_COUNT = PLANT.leaves.length;
const STEM_COUNT = PLANT.stems.length;

/**
 * The plant's layers, drawn once per resize side by side into one target
 * (premultiplied): its stems, then its leaves, each a pointed oval with a
 * midrib, drooping at the tip. The plant's geometry is baked in as constants.
 */
const PLANT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uCell;
out vec4 outColor;
${SDF2D_GLSL}
const vec4 LEAF_A[${String(LEAF_COUNT)}] = vec4[${String(LEAF_COUNT)}](
  ${PLANT.leaves.map((l) => v4(l.x, l.y, l.angle, l.length)).join(",\n  ")}
);
const vec4 LEAF_B[${String(LEAF_COUNT)}] = vec4[${String(LEAF_COUNT)}](
  ${PLANT.leaves.map((l) => v4(l.width, l.droop, l.tint, l.layer)).join(",\n  ")}
);
const vec4 STEM_A[${String(STEM_COUNT)}] = vec4[${String(STEM_COUNT)}](
  ${PLANT.stems.map((s) => v4(s.points[0], s.points[1], s.points[2], s.points[3])).join(",\n  ")}
);
const vec4 STEM_B[${String(STEM_COUNT)}] = vec4[${String(STEM_COUNT)}](
  ${PLANT.stems.map((s) => v4(s.points[4], s.points[5], s.layer, 0)).join(",\n  ")}
);

vec4 acc;
void paint(vec3 c, float a) {
  acc = vec4(c, 1.0) * a + acc * (1.0 - a);
}

void main() {
  float layer = floor(gl_FragCoord.x / uCell.x);
  vec2 f = vec2(gl_FragCoord.x - layer * uCell.x, gl_FragCoord.y) / uCell;
  vec2 p = vec2(${F(PLANT_LEFT)}, ${F(PLANT_BOTTOM)}) + f * vec2(${F(PLANT_W)}, ${F(PLANT_H)});
  px = ${F(PLANT_H)} / uCell.y;
  // Back layers sit deeper in the room: a little darker.
  float depth = 0.72 + 0.14 * layer;
  acc = vec4(0.0);
  for (int i = 0; i < ${String(STEM_COUNT)}; i++) {
    if (STEM_B[i].z != layer) {
      continue;
    }
    vec2 a = STEM_A[i].xy;
    vec2 c = STEM_A[i].zw;
    vec2 b = STEM_B[i].xy;
    float d = 1e3;
    float along = 0.0;
    vec2 prev = a;
    for (int j = 1; j <= 8; j++) {
      float t = float(j) / 8.0;
      vec2 q = mix(mix(a, c, t), mix(c, b, t), t);
      float dj = sdSeg(p, prev, q);
      if (dj < d) {
        d = dj;
        along = t;
      }
      prev = q;
    }
    paint(vec3(0.16, 0.19, 0.09) * depth, cover(d - mix(0.0045, 0.002, along)));
  }
  for (int i = 0; i < ${String(LEAF_COUNT)}; i++) {
    vec4 la = LEAF_A[i];
    vec4 lb = LEAF_B[i];
    if (lb.w != layer) {
      continue;
    }
    vec2 dir = vec2(cos(la.z), sin(la.z));
    vec2 n = vec2(-dir.y, dir.x);
    vec2 d = p - la.xy;
    float u = dot(d, dir);
    float t = u / la.w;
    if (t < -0.05 || t > 1.05) {
      continue;
    }
    float v = dot(d, n) - lb.y * la.w * t * t;
    float tc = clamp(t, 0.0, 1.0);
    float hw = 0.5 * lb.x * pow(max(sin(3.14159265 * tc), 0.0), 0.7) * (1.0 - 0.2 * tc);
    float sd = max(abs(v) - hw, max(-u, u - la.w));
    float a = cover(sd);
    if (a <= 0.0) {
      continue;
    }
    vec3 g = vec3(0.11, 0.27, 0.1) * lb.z * depth;
    // One half catches more light; a gloss along the lit edge; a pale midrib.
    float side = v / max(hw, 1e-4);
    g *= 1.0 + 0.16 * side;
    g += vec3(0.05, 0.08, 0.04) * smoothstep(0.45, 0.95, side) * (1.0 - tc);
    float rib = (1.0 - smoothstep(0.0012, 0.0028, abs(v))) * step(0.04, t) * step(t, 0.92);
    g = mix(g, g * 1.5 + vec3(0.03, 0.04, 0.02), 0.7 * rib);
    // Veins, faint.
    g *= 1.0 - 0.06 * smoothstep(0.6, 1.0, sin((u - 0.7 * abs(v)) * 380.0));
    paint(g, a);
  }
  outColor = acc;
}
`;

/**
 * At reduced resolution, when the time of day changes: the light the lamp and
 * the window throw on the room, in the room's own layout.
 */
const LIGHT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uLow;
uniform float uK;
/** 0 for evening, 1 for night. */
uniform float uNight;
out vec4 outColor;
${DESIGN_GLSL}
${PLACES_GLSL}
const vec3 LAMP = vec3(1.0, 0.62, 0.3);
void main() {
  halfW = 0.5 * uRes.x / (uRes.y * uK);
  vec2 p = design(gl_FragCoord.xy * (uRes / uLow), uRes, uK);
  // The lamp: a glow round its shade, and light out of its top and bottom.
  vec2 l = lampAt();
  vec2 d = p - l;
  float r2 = dot(d, d);
  float lamp = 0.55 * exp(-r2 / 0.006) + 0.22 / (1.0 + r2 / 0.03);
  float up = p.y - SHADE_TOP;
  float cone = smoothstep(0.03 + 0.55 * up, 0.02 + 0.4 * up, abs(d.x));
  lamp += 0.35 * cone * step(0.0, up) * exp(-up / 0.18);
  lamp += 0.25 * smoothstep(0.045, 0.03, abs(d.x)) * step(-0.08, d.y) * step(d.y, -0.04);
  // The window: dusk or night light falling across the wall from the left.
  vec3 w = mix(vec3(0.95, 0.52, 0.36) * 0.45, vec3(0.28, 0.36, 0.7) * 0.22, uNight);
  float wd = max(p.x - windowX(), 0.0);
  float win = (0.75 * exp(-wd / 0.1) + 0.25 * exp(-wd / 0.45)) * smoothstep(SILL - 0.15, SILL + 0.05, p.y);
  vec3 light = LAMP * lamp + w * win;
  outColor = vec4(min(light / ${F(LIGHT_RANGE)}, vec3(1.0)), 1.0);
}
`;

/**
 * Every frame: the cached room, lit (room light by warmth, the ring light's
 * falloff, and the lamp, window and neon spill), the sky in the window, the
 * catchlight and lamp glow, the swaying plant, and the sign's plaque and
 * tubes. While the sign changes side, both layouts are shaded and mixed; the
 * room reads its own cache mirrored for the sign on the left, but the sign's
 * lettering never mirrors.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uFx;
uniform sampler2D uLight;
uniform sampler2D uPlant;
uniform sampler2D uField;
uniform sampler2D uGlow;
uniform vec2 uRes;
uniform float uK;
/** 0 with the sign on the right, 1 on the left, between while it changes side. */
uniform float uMix;
uniform float uNight;
uniform vec3 uRoomLight;
/** The sign's colour, times its brightness; uLit is the brightness alone. */
uniform vec3 uSign;
uniform float uLit;
/** The plaque on the right: centre x, top, half width; w is 1 when there is a sign. */
uniform vec4 uPlaque;
/** Field and glow boxes: left, top (reference px), then 1 / width, 1 / height. */
uniform vec4 uFieldBox;
uniform vec4 uGlowBox;
uniform vec4 uTube;
uniform float uSway;
out vec4 outColor;
${SDF2D_GLSL}
${HASH32_GLSL}
${DESIGN_GLSL}
${PLACES_GLSL}
${DITHER_GLSL}
${NEON_EMIT_GLSL}
${swayGlsl(SWELL)}
const vec3 RING = vec3(0.86, 0.92, 1.0);
const vec3 LAMP_GLOW = vec3(1.0, 0.72, 0.42);

float rand(vec2 cell, uint salt) {
  uvec2 u = uvec2(ivec2(cell) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ salt))) / 4294967296.0;
}

/** The sky through the window, with a skyline: dusk, or night with more lit windows. */
vec3 sky(vec2 p) {
  float v = clamp((p.y - SILL) / 0.75, 0.0, 1.0);
  vec3 eve = mix(vec3(0.98, 0.62, 0.42), vec3(0.32, 0.3, 0.56), smoothstep(0.0, 1.0, v));
  eve = mix(eve, vec3(1.0, 0.78, 0.5), 0.5 * exp(-v / 0.08));
  vec3 night = mix(vec3(0.1, 0.11, 0.22), vec3(0.015, 0.02, 0.06), smoothstep(0.0, 0.8, v));
  vec3 c = mix(eve, night, uNight);
  float column = floor((p.x + 4.0) / 0.034);
  float h = SILL + 0.02 + 0.1 * rand(vec2(column, 1.0), 5u);
  if (p.y < h) {
    vec3 b = mix(vec3(0.16, 0.11, 0.18), vec3(0.02, 0.02, 0.035), uNight);
    vec2 cell = floor(p / vec2(0.0075, 0.009));
    vec2 inCell = fract(p / vec2(0.0075, 0.009));
    float on = step(0.72, rand(cell, 7u)) * step(0.25, inCell.x) * step(inCell.x, 0.75) * step(0.3, inCell.y) * step(inCell.y, 0.75);
    b += vec3(1.0, 0.75, 0.45) * on * mix(0.12, 0.45, uNight) * step(p.y, h - 0.008);
    c = mix(c, b, clamp((h - p.y) / px, 0.0, 1.0));
  }
  return c;
}

/** The frame with the sign on the right (flip 1), or mirrored to the left (flip -1). */
vec3 shade(float flip) {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec2 uv = gl_FragCoord.xy / uRes;
  if (flip < 0.0) {
    t.x = int(uRes.x) - 1 - t.x;
    uv.x = 1.0 - uv.x;
  }
  vec4 r = texelFetch(uRoom, t, 0);
  vec4 fx = texelFetch(uFx, t, 0);
  vec2 p0 = design(gl_FragCoord.xy, uRes, uK);
  vec2 p = vec2(p0.x * flip, p0.y);

  // The sign's light on the wall: its blurred tubes, never mirrored.
  vec2 corner = vec2(flip * uPlaque.x - uPlaque.z, uPlaque.y);
  vec2 q = (vec2(p0.x, -p0.y) - vec2(corner.x, -corner.y)) * ${F(1080)};
  vec3 neon = vec3(0.0);
  if (uPlaque.w > 0.5) {
    neon = uSign * texture(uGlow, (q - uGlowBox.xy) * uGlowBox.zw).r * ${F(NEON_GAIN)};
  }

  vec3 ambient = uRoomLight * (0.5 + 0.16 * smoothstep(-0.5, 0.5, p.y)) * (1.0 - 0.18 * smoothstep(0.4, 1.0, abs(p.x) / halfW));
  vec2 rc = p - vec2(0.0, 0.12);
  vec3 ring = RING * 0.2 * exp(-dot(rc, rc) / 0.45);
  vec3 spill = texture(uLight, uv).rgb * ${F(LIGHT_RANGE)} + neon;
  vec3 col = r.rgb * (ambient + ring + spill * fx.a);
  col = mix(col, sky(p), fx.r);
  col += RING * 0.7 * fx.g + LAMP_GLOW * 0.95 * fx.b;

  // The plant, its layers swaying, behind whatever is in front of it.
  vec2 pl = vec2(p.x + halfW, p.y);
  if (pl.x > ${F(PLANT_LEFT)} && pl.x < ${F(PLANT_RIGHT)} && p.y > ${F(PLANT_BOTTOM)} && p.y < ${F(PLANT_TOP)}) {
    vec3 plantLight = ambient + 0.6 * ring + 0.75 * spill;
    float h = clamp((p.y + 0.42) / ${F(PLANT_TOP + 0.42)}, 0.0, 1.0);
    float front = 1.0 - r.a;
    // A soft shadow of the middle layer on the wall.
    vec2 sp = pl - vec2(0.018, -0.022);
    vec2 su = (sp - vec2(${F(PLANT_LEFT)}, ${F(PLANT_BOTTOM)})) / vec2(${F(PLANT_W)}, ${F(PLANT_H)});
    float sh = texture(uPlant, vec2((1.0 + clamp(su.x, 0.0, 1.0)) / ${F(PLANT_LAYERS)}, su.y)).a;
    col *= 1.0 - 0.3 * sh * front * fx.a;
    for (int i = 0; i < ${String(PLANT_LAYERS)}; i++) {
      float amp = i == 0 ? ${F(SWAY_AMPLITUDE[0])} : i == 1 ? ${F(SWAY_AMPLITUDE[1])} : ${F(SWAY_AMPLITUDE[2])};
      float dx = amp * swayOffset(uSway + 0.29 * float(i), h, 1.2);
      vec2 u = (pl - vec2(${F(PLANT_LEFT)} + dx, ${F(PLANT_BOTTOM)})) / vec2(${F(PLANT_W)}, ${F(PLANT_H)});
      if (u.x <= 0.0 || u.x >= 1.0) {
        continue;
      }
      vec4 leaf = texture(uPlant, vec2((float(i) + u.x) / ${F(PLANT_LAYERS)}, u.y));
      col = col * (1.0 - leaf.a * front) + leaf.rgb * plantLight * front;
    }
  }

  // The sign: a clear acrylic plaque on standoffs, and the tubes on it.
  if (uPlaque.w > 0.5) {
    vec2 c = vec2(flip * uPlaque.x, uPlaque.y - ${F(PLAQUE_H / 2)});
    vec2 h = vec2(uPlaque.z, ${F(PLAQUE_H / 2)});
    float d = sdBox(p0 - c, h, 0.012);
    if (d < 0.03) {
      float a = cover(d);
      vec3 plate = col * 0.85 + 0.02 + uSign * 0.05;
      float re = (d + 0.0025) / 0.0018;
      float rim = exp(-re * re);
      col = mix(col, plate, 0.75 * a) + (uSign * 0.25 + 0.05) * rim * a;
      vec2 s = abs(p0 - c) - (h - 0.018);
      col = mix(col, vec3(0.55, 0.55, 0.57) * (ambient + neon), cover(length(s) - 0.0055));
      // Faint shadow of the plaque on the wall.
      col *= 1.0 - 0.18 * (1.0 - a) * (1.0 - smoothstep(0.0, 0.02, sdBox(p0 - c - vec2(0.006, -0.008), h, 0.012)));
      vec2 fu = (q - uFieldBox.xy) * uFieldBox.zw;
      if (all(greaterThanEqual(fu, vec2(0.0))) && all(lessThanEqual(fu, vec2(1.0)))) {
        vec4 f = texture(uField, fu);
        float body = 1.0 - smoothstep(uTube.x - uTube.w, uTube.x + uTube.w, f.r);
        vec3 clip = vec3(0.12, 0.12, 0.13) * mix(1.3, 0.45, f.a) * (0.4 + 2.0 * neon);
        col = mix(col, clip, f.b * (1.0 - body));
        col = mix(col, vec3(0.08, 0.085, 0.09), body * (1.0 - uLit) * 0.7);
        col += neonEmit(f.r, uSign, uTube);
      }
    }
  }
  return col;
}

void main() {
  halfW = 0.5 * uRes.x / (uRes.y * uK);
  px = 1.0 / (uRes.y * uK);
  vec3 col;
  if (uMix <= 0.0) {
    col = shade(1.0);
  } else if (uMix >= 1.0) {
    col = shade(-1.0);
  } else {
    col = mix(shade(1.0), shade(-1.0), uMix);
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A cosy corner to chat in: a sofa behind the speaker, a neon sign with the
 * user's words high on one side, and on the other a tall leafy plant by the
 * window and a broadcast microphone on its arm; a shelf of books with a warm
 * lamp and a framed print under the sign.
 *
 * The room is drawn once per resize (sign on the right; the left-hand layout
 * reads it mirrored), with a second cache of the window, catchlight, lamp
 * glow and how much light each surface gets. The plant's three layers are
 * drawn once per resize too, and sway as they're sampled. The lamp's and
 * window's light renders at reduced resolution when the time of day changes,
 * and the sign's tubes rebuild on the CPU only when its text does. Each frame
 * is one full-screen pass, then the stream overlays on top.
 */
export const justchatting = defineEffect(justchattingMeta, {
  create(gl) {
    return withScope((scope) => {
      const roomProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const plantProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, PLANT_FRAGMENT);
      const lightProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, LIGHT_FRAGMENT);
      const compositeProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ru = createUniforms(gl, roomProgram, ["uRes", "uK", "uPass"]);
      const pu = createUniforms(gl, plantProgram, ["uCell"]);
      const lu = createUniforms(gl, lightProgram, ["uRes", "uLow", "uK", "uNight"]);
      const cu = createUniforms(gl, compositeProgram, [
        "uRoom",
        "uFx",
        "uLight",
        "uPlant",
        "uField",
        "uGlow",
        "uRes",
        "uK",
        "uMix",
        "uNight",
        "uRoomLight",
        "uSign",
        "uLit",
        "uPlaque",
        "uFieldBox",
        "uGlowBox",
        "uTube",
        "uSway",
      ]);
      gl.useProgram(compositeProgram);
      cu.i1("uRoom", 0);
      cu.i1("uFx", 1);
      cu.i1("uLight", 2);
      cu.i1("uPlant", 3);
      cu.i1("uField", 4);
      cu.i1("uGlow", 5);
      gl.useProgram(null);
      const overlays = createStreamOverlays(gl, scope);

      const fieldTex = scope.add(gl.createTexture(), (t) => {
        gl.deleteTexture(t);
      });
      const glowTex = scope.add(gl.createTexture(), (t) => {
        gl.deleteTexture(t);
      });
      const upload = (
        tex: WebGLTexture,
        w: number,
        h: number,
        internal: GLenum,
        format: GLenum,
        data: Float32Array,
      ) => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        resetUnpackState(gl);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.FLOAT, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
      };
      // Start with blank textures, so nothing samples an incomplete one.
      upload(fieldTex, 1, 1, gl.RGBA16F, gl.RGBA, new Float32Array(4));
      upload(glowTex, 1, 1, gl.RG16F, gl.RG, new Float32Array(2));

      let roomTarget: RenderTarget | null = null;
      let fxTarget: RenderTarget | null = null;
      let plantTarget: RenderTarget | null = null;
      let lightTarget: RenderTarget | null = null;
      scope.defer(() => {
        roomTarget?.dispose();
        fxTarget?.dispose();
        plantTarget?.dispose();
        lightTarget?.dispose();
      });
      let width = 1;
      let height = 1;
      let lowWidth = 1;
      let lowHeight = 1;
      let cellWidth = 1;
      let cellHeight = 1;
      let k = 1;
      let scale = 1;
      let roomDrawn = false;
      let lightNight = -1;
      let time = 0;
      let place = signPlace(16 / 9, 1);
      let swayPhase = 0;
      /** Side cross-fade progress (0 on the right, 1 on the left), and night's (0 evening, 1 night). */
      let side = -1;
      let night = -1;

      // The sign, as last built: its plaque's half width, and the tubes' boxes.
      let builtText: string | undefined;
      let hasSign = false;
      let plaqueHalf = 0.1;
      const fieldBox = [0, 0, 1, 1];
      const glowBox = [0, 0, 1, 1];
      const tube = [1, 1, 0.45, 1];
      const settledText = createSettledValue<string>(INPUT_SETTLE);
      const signRgb = unitRgbMemo();
      const signEase = createColorEase(3);

      const bindUnit = (unit: number, tex: WebGLTexture | null) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
      };

      const buildSign = (text: string) => {
        const line = signLine(text);
        hasSign = line.length > 0;
        if (!hasSign) {
          return;
        }
        const fit = fitSign(measureLines([line])[0]);
        plaqueHalf = 0.5 * fit.plaqueW;
        const tubes = buildNeonTubes([{ text: line, index: 0 }], fit.lettering, MAX_CLIPS);
        upload(fieldTex, tubes.field.cols, tubes.field.rows, gl.RGBA16F, gl.RGBA, tubes.field.data);
        upload(glowTex, tubes.glow.cols, tubes.glow.rows, gl.RG16F, gl.RG, tubes.glow.data);
        fieldBox.splice(0, 4, ...tubes.fieldBox);
        glowBox.splice(0, 4, ...tubes.glowBox);
        tube[0] = tubes.radius;
        tube[1] = tubes.reach;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          k = fitScale(width / height);
          place = signPlace(width / height, 1);
          scale = (height * k) / 1080;
          lowWidth = Math.max(1, Math.ceil(width / LIGHT_DIVISOR));
          lowHeight = Math.max(1, Math.ceil(height / LIGHT_DIVISOR));
          // The plant's cells: its box at the frame's scale, capped in height.
          const plantPx = PLANT_H * height * k;
          const res = Math.min(1, PLANT_MAX_PX / plantPx);
          cellHeight = Math.max(1, Math.round(plantPx * res));
          cellWidth = Math.max(1, Math.round((PLANT_W / PLANT_H) * cellHeight));
          roomTarget?.dispose();
          roomTarget = null;
          roomTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          fxTarget?.dispose();
          fxTarget = null;
          fxTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          plantTarget?.dispose();
          plantTarget = null;
          plantTarget = createRenderTarget(gl, cellWidth * PLANT_LAYERS, cellHeight, gl.RGBA8);
          lightTarget?.dispose();
          lightTarget = null;
          lightTarget = createRenderTarget(gl, lowWidth, lowHeight, gl.RGBA8);
          roomDrawn = false;
          lightNight = -1;
          overlays.resize(v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
          time += step;
          swayPhase = advanceSwell(SWELL, swayPhase, step);
          const sideTarget = p.signSide === "right" ? 0 : 1;
          side = side < 0 ? sideTarget : approach(side, sideTarget, step / SIDE_FADE);
          const nightTarget = p.time === "night" ? 1 : 0;
          night = night < 0 ? nightTarget : approach(night, nightTarget, step / TIME_EASE);
          const nightMix = smoothstep(0, 1, night);

          // Typing rebuilds the sign once it pauses.
          const text = settledText.update(p.sign, dt);
          if (text !== builtText) {
            builtText = text;
            buildSign(text);
          }
          const lit = signHum(time);
          const colour = signEase.step(signRgb(p.signColor), step, COLOUR_EASE);
          const warmth = Math.min(1, Math.max(0, p.warmth));

          if (roomTarget && fxTarget && plantTarget && lightTarget) {
            // 1. The room and its light cache, and the plant, once per resize.
            if (!roomDrawn) {
              roomDrawn = true;
              gl.useProgram(roomProgram);
              ru.f2("uRes", width, height);
              ru.f1("uK", k);
              ru.i1("uPass", 0);
              roomTarget.bind();
              triangle.draw();
              ru.i1("uPass", 1);
              fxTarget.bind();
              triangle.draw();
              gl.useProgram(plantProgram);
              pu.f2("uCell", cellWidth, cellHeight);
              plantTarget.bind();
              triangle.draw();
            }

            // 2. The lamp's and window's light, when the time of day moves.
            if (nightMix !== lightNight) {
              lightNight = nightMix;
              gl.useProgram(lightProgram);
              lu.f2("uRes", width, height);
              lu.f2("uLow", lowWidth, lowHeight);
              lu.f1("uK", k);
              lu.f1("uNight", nightMix);
              lightTarget.bind();
              triangle.draw();
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);

            // 3. The room, lit, with the plant and the sign.
            gl.useProgram(compositeProgram);
            cu.f2("uRes", width, height);
            cu.f1("uK", k);
            cu.f1("uMix", smoothstep(0, 1, side));
            cu.f1("uNight", nightMix);
            cu.f3(
              "uRoomLight",
              COOL_LIGHT[0] + (WARM_LIGHT[0] - COOL_LIGHT[0]) * warmth,
              COOL_LIGHT[1] + (WARM_LIGHT[1] - COOL_LIGHT[1]) * warmth,
              COOL_LIGHT[2] + (WARM_LIGHT[2] - COOL_LIGHT[2]) * warmth,
            );
            cu.f3("uSign", colour[0] * lit, colour[1] * lit, colour[2] * lit);
            cu.f1("uLit", lit);
            cu.f4("uPlaque", place.x, place.top, plaqueHalf, hasSign ? 1 : 0);
            cu.f4("uFieldBox", fieldBox[0], fieldBox[1], fieldBox[2], fieldBox[3]);
            cu.f4("uGlowBox", glowBox[0], glowBox[1], glowBox[2], glowBox[3]);
            cu.f4("uTube", tube[0], tube[1], tube[2], Math.max(0.5, 0.7 / scale));
            cu.f1("uSway", swayPhase);
            bindUnit(0, roomTarget.texture);
            bindUnit(1, fxTarget.texture);
            bindUnit(2, lightTarget.texture);
            bindUnit(3, plantTarget.texture);
            bindUnit(4, fieldTex);
            bindUnit(5, glowTex);
            triangle.draw();
            for (let i = 5; i >= 0; i--) {
              bindUnit(i, null);
            }
          }

          // 4. The stream overlays, last.
          overlays.frame(dt, p);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
