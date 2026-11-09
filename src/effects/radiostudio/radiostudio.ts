import { advanceGraph, createGraphWalk, walkWander } from "../graph-walk";
import { unitRgbMemo } from "../color";
import {
  beginFrame,
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
import { smoothstep } from "../math";
import { HASH32_GLSL } from "../noise";
import { defineEffect } from "../types";
import {
  BAR_SEGMENTS,
  createNeedle,
  createTape,
  MUSIC_SAMPLES,
  musicLevel,
  onAirTarget,
  packRadius,
  packStudioLayout,
  REEL_HUB,
  SIGN_RIM,
  stepBar,
  stepLight,
  stepNeedle,
  stepTape,
  STUDIO_SLOT,
  STUDIO_SLOTS,
  studioLayout,
  WINDOW_FRAME,
} from "./radiostudio-sim";
import { radiostudioMeta } from "./radiostudio.meta";
import { SDF2D_GLSL, OVER_GLSL } from "../sdf-glsl";
import { clockHands, CLOCK_HANDS_GLSL, CLOCK_MARKS_GLSL } from "../wall-clock";
import { createCanvasTexture, paintCanvas, SANS_FONT_STACK } from "../canvas-texture";

const g = glslFloat;
const SL = STUDIO_SLOT;

/** The downlights' colour; their strength varies over the booth. */
const LIGHT_RGB = [1, 0.88, 0.75] as const;
/** The foam's tint mask stores its light divided by this, to fit 8 bits. */
const MASK_RANGE = 4;
/** Seconds the foam colour must hold still before the booth is redrawn with it. */
const FOAM_SETTLE = 0.3;

/** A VU needle's pivot below its face's centre, and its swing either side of upright (radians), in face half-heights. */
const VU_PIVOT = 1.25;
const VU_SWING = 0.84;
/** Where the scale's red zone starts (share of the scale). */
const VU_RED = 0.72;
/** The sign's red glow on the walls, at full strength. */
const GLOW_RGB = [0.55, 0.06, 0.04] as const;
/** The sign's lettering: a system font stack, a bold grotesque. */
const FONT_FAMILY = SANS_FONT_STACK;
/** Largest text texture side, in texels. */
const MAX_TEXT_TEXELS = 2048;

const KIND_SIGN = 0;
const KIND_NEEDLE = 1;
const KIND_BAR = 2;
const KIND_REEL = 3;
const KIND_HANDS = 4;

const SHARED_GLSL = /* glsl */ `
${SDF2D_GLSL}
`;

/**
 * The booth, drawn once per resize or setting change with four samples per
 * pixel: the wedge foam, the wooden trim, the control-room window, the sign's
 * housing, the clock's face, the rack with its meters' faces, the records, the
 * tape machines' cabinets, the desk with its faders and turntable, and the
 * microphone on its sprung arm. Alpha is how much of the sign's red glow each
 * point catches (by distance, and by which way the foam's faces point).
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
/** 1 with the microphone on the left, -1 mirrored. */
uniform float uSide;
uniform vec3 uFoam;
/**
 * 1 for the booth. 0 draws only the light on the foam (everything over it
 * black), the mask that tints the foam while its colour changes.
 */
uniform float uOther;
uniform vec4 uL[${String(STUDIO_SLOTS)}];
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
${SHARED_GLSL}
#define SIGN uL[${String(SL.sign)}]
#define WIN uL[${String(SL.window)}]
#define RACK uL[${String(SL.rack)}]
#define METER0 uL[${String(SL.meter0)}]
#define METER1 uL[${String(SL.meter1)}]
#define BAR0 uL[${String(SL.bar0)}]
#define BAR1 uL[${String(SL.bar1)}]
#define DECK0 uL[${String(SL.deck0)}]
#define DECK1 uL[${String(SL.deck1)}]
#define REEL0 uL[${String(SL.reel0)}]
#define REEL1 uL[${String(SL.reel0 + 1)}]
#define REEL2 uL[${String(SL.reel0 + 2)}]
#define REEL3 uL[${String(SL.reel0 + 3)}]
#define CLOCK uL[${String(SL.clock)}]
#define MIC uL[${String(SL.mic)}]
#define ARM0 uL[${String(SL.arm0)}]
#define ARM1 uL[${String(SL.arm1)}]
#define RECORDS uL[${String(SL.records)}]
#define PLATTER uL[${String(SL.platter)}]
const float SIGN_RIM = ${g(SIGN_RIM)};
const float FRAME = ${g(WINDOW_FRAME)};
const float VU_PIVOT = ${g(VU_PIVOT)};
const float VU_SWING = ${g(VU_SWING)};
const float VU_RED = ${g(VU_RED)};
const vec3 WOOD = vec3(0.36, 0.2, 0.1);
const vec3 METAL = vec3(0.6, 0.61, 0.63);

vec3 col;
vec2 nrm;
float recv;
vec3 lightK;

/** Lays a surface of colour c over what's there, with coverage a, a tilt n and how much sign glow it catches. */
void lay(vec3 c, float a, vec2 n, float r) {
  col = mix(col, c * uOther, a);
  nrm = mix(nrm, n, a);
  recv = mix(recv, r, a);
}
/** A matte colour under the room's light. */
vec3 lit(vec3 c) {
  return c * lightK;
}
float rand(vec2 cell, uint salt) {
  uvec2 u = uvec2(ivec2(cell) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ salt))) / 4294967296.0;
}
/** Wood with its grain along q.x. */
vec3 wood(vec2 q) {
  float grain = sin(q.y * 650.0 + 5.0 * sin(q.x * 22.0 + q.y * 80.0)) * 0.06 + sin(q.y * 140.0 + q.x * 3.0) * 0.05;
  return WOOD * (0.9 + grain);
}

/** Warm downlights: one over the rack, one over the tape machines, a soft one high in the middle. */
vec3 lighting(vec2 f) {
  vec2 a = f - vec2(-0.62, 0.3);
  vec2 b = f - vec2(0.6, -0.08);
  float k = 0.45;
  k += 0.55 * exp(-dot(a, a) / 0.09);
  k += 0.45 * exp(-dot(b, b) / 0.11);
  k += 0.2 * exp(-f.x * f.x / 0.1 - (f.y - 0.5) * (f.y - 0.5) / 0.15);
  k *= 1.0 - 0.3 * smoothstep(0.3, 0.75, length(f * vec2(0.6, 1.0)));
  return vec3(${LIGHT_RGB.map((v) => g(v)).join(", ")}) * k;
}

/** Wedge foam: square tiles of four ridges, alternately across and upright, with dark seams. */
void foam(vec2 f) {
  const float T = 1.0 / 12.0;
  vec2 cell = floor(f / T);
  vec2 u = f / T - cell;
  bool across = mod(cell.x + cell.y, 2.0) < 0.5;
  float s = across ? u.y : u.x;
  float w = fract(s * 4.0);
  float h = 1.0 - abs(2.0 * w - 1.0);
  float side = w < 0.5 ? -1.0 : 1.0;
  vec2 n = across ? vec2(0.0, side) : vec2(side, 0.0);
  vec3 n3 = normalize(vec3(n * 0.9, 1.0));
  float diff = max(dot(n3, normalize(vec3(-0.25, 0.75, 0.6))), 0.0);
  float ao = 0.55 + 0.45 * smoothstep(0.0, 0.6, h);
  float e = min(min(u.x, 1.0 - u.x), min(u.y, 1.0 - u.y));
  float seam = 0.6 + 0.4 * smoothstep(0.0, 0.025, e);
  float vary = 0.92 + 0.16 * rand(cell, 7u);
  float grain = 0.96 + 0.08 * rand(floor(f * 900.0), 3u);
  col = lit(uFoam * (0.35 + 0.95 * diff) * ao * seam * vary * grain);
  nrm = n * 0.8;
  recv = 1.0;
}

/** The ceiling's wooden beam and two upright battens either side of the speaker. */
void trim(vec2 f) {
  float top = 0.455;
  vec3 beam = wood(vec2(f.x, f.y)) * (0.75 + 0.35 * smoothstep(top, top + 0.012, f.y));
  col *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.02, top - f.y));
  lay(lit(beam), cover(top - f.y), vec2(0.0, -0.5), 0.7);
  float bx = abs(f.x) - 0.3;
  float d = max(abs(bx) - 0.0055, f.y - top);
  col *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.01, abs(bx - 0.006) - 0.0055));
  vec3 batten = wood(vec2(f.y, f.x * 3.0)) * (0.8 + 0.3 * smoothstep(0.0055, -0.0055, bx));
  lay(lit(batten), cover(d), vec2(-sign(bx) * 0.3, 0.0), 0.7);
}

/** The dim control room through the glass: a desk, small lit screens, a lamp. No one is there. */
vec3 controlRoom(vec2 q, vec2 hs) {
  vec2 u = q / hs;
  vec3 c = vec3(0.028, 0.032, 0.045) * (0.8 + 0.35 * u.y);
  // Panels on the far wall.
  float panel = step(0.96, fract(q.x * 9.0 + 0.3));
  c *= 1.0 - 0.25 * panel;
  vec2 lamp = q - vec2(-0.12, hs.y);
  c += vec3(0.07, 0.05, 0.03) * exp(-dot(lamp, lamp) / 0.006);
  float deskY = -hs.y + 0.05;
  // Screens on the desk, and their glow on the wall.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 sc = vec2(-0.13 + 0.13 * fi, deskY + 0.032);
    vec3 glow = i == 1 ? vec3(0.16, 0.34, 0.22) : vec3(0.13, 0.27, 0.42);
    vec2 sq = q - sc;
    float ds = sdBox(sq, vec2(0.026, 0.017), 0.0015);
    c += glow * 0.12 * exp(-max(ds, 0.0) / 0.03);
    float stand = sdBox(q - vec2(sc.x, deskY + 0.008), vec2(0.0025, 0.008), 0.0);
    c = mix(c, vec3(0.02), cover(stand));
    c = mix(c, vec3(0.015), cover(ds - 0.002));
    vec2 su = sq / vec2(0.026, 0.017);
    float lines = step(0.5, fract(su.y * 3.5 + 0.25)) * step(abs(su.x + 0.1 * fi), 0.6 + 0.3 * sin(floor(su.y * 3.5) * 2.3 + fi));
    float wave = 1.0 - smoothstep(0.0, 0.08, abs(su.y + 0.55 - 0.15 * sin(su.x * 9.0 + fi * 2.0)));
    vec3 screen = glow * (0.55 + 0.3 * lines + 0.6 * wave * step(su.y, -0.2));
    c = mix(c, screen, cover(ds));
  }
  // The desk: a dark sloping top with tiny lit buttons, and its front.
  if (q.y < deskY) {
    vec3 d = vec3(0.022, 0.024, 0.03) * (0.7 + 0.6 * smoothstep(-hs.y, deskY, q.y));
    vec2 cell = floor(q / 0.009);
    vec2 cu = fract(q / 0.009) - 0.5;
    float r = rand(cell, 11u);
    if (q.y > deskY - 0.03 && r < 0.14) {
      vec3 led = r < 0.05 ? vec3(0.9, 0.5, 0.1) : r < 0.1 ? vec3(0.2, 0.8, 0.3) : vec3(0.85, 0.15, 0.1);
      d = mix(d, led * 0.45, cover(length(cu) * 0.009 - 0.0014));
    }
    c = mix(c, d, cover(q.y - deskY));
  }
  c += vec3(0.03, 0.035, 0.04) * (1.0 - smoothstep(0.0, 0.004, abs(q.y - deskY)));
  // Reflections on the glass: two soft diagonal streaks.
  float diag = q.x + q.y * 0.7;
  c += vec3(0.022, 0.024, 0.026) * (exp(-(diag - 0.06) * (diag - 0.06) / 0.000625) + 0.6 * exp(-(diag - 0.13) * (diag - 0.13) / 0.000144));
  return c;
}

void windowPane(vec2 f) {
  vec2 q = f - WIN.xy;
  vec2 hs = WIN.zw;
  float outer = sdBox(q, hs + FRAME, 0.003);
  if (outer > 0.04) {
    return;
  }
  col *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.02, sdBox(q - vec2(0.006, -0.01), hs + FRAME, 0.003)));
  bool level = hs.x - abs(q.x) > hs.y - abs(q.y);
  vec3 frame = level ? wood(q + 3.0) : wood(vec2(q.y, q.x) + 5.0);
  float rim = sdBox(q, hs, 0.0);
  frame *= 0.8 + 0.35 * smoothstep(FRAME, 0.0, abs(rim - FRAME * 0.5) * 2.0);
  lay(lit(frame), cover(outer), vec2(0.0), 0.6);
  // The sill.
  vec2 sq = q - vec2(0.0, -hs.y - FRAME - 0.004);
  float sill = sdBox(sq, vec2(hs.x + FRAME + 0.012, 0.007), 0.002);
  lay(lit(wood(sq + 1.0) * (0.8 + 0.4 * smoothstep(-0.007, 0.007, sq.y))), cover(sill), vec2(0.0, 0.5), 0.6);
  if (rim < px) {
    vec3 inside = controlRoom(q, hs);
    // The frame's shadow on the glass's inner edge.
    inside *= 0.6 + 0.4 * smoothstep(0.0, 0.006, -rim);
    lay(inside, cover(rim), vec2(0.0), 0.3);
  }
}

/** The ON AIR sign's housing and the rods that hang it; the lit face is drawn live. */
void signHousing(vec2 f) {
  vec2 q = f - SIGN.xy;
  vec2 hs = SIGN.zw + SIGN_RIM;
  for (int i = -1; i <= 1; i += 2) {
    float x = float(i) * hs.x * 0.7;
    float rod = sdSeg(q, vec2(x, hs.y), vec2(x, 0.6)) - 0.0022;
    lay(lit(METAL * (0.35 + 0.25 * smoothstep(0.0022, -0.0022, q.x - x))), cover(rod), vec2(0.0), 0.8);
  }
  col *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.02, sdBox(q - vec2(0.005, -0.012), hs, 0.008)));
  float d = sdBox(q, hs, 0.008);
  vec3 box = vec3(0.07, 0.065, 0.065) * (0.8 + 0.5 * smoothstep(-hs.y, hs.y, q.y));
  box += vec3(0.08) * (1.0 - smoothstep(0.0, 0.003, abs(d + 0.0025)));
  lay(lit(box), cover(d), vec2(0.0), 1.0);
  lay(vec3(0.08, 0.015, 0.012), cover(sdBox(q, SIGN.zw, 0.005)), vec2(0.0), 1.0);
}

${CLOCK_MARKS_GLSL}
/** The studio clock's face: a dark rim, a pale dial and its minute and hour marks. The hands are drawn live. */
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
  col *= 1.0 - 0.45 * (1.0 - smoothstep(R * 0.92, R * 1.18, length(q - vec2(0.006, -0.011))));
  float ang = atan(q.y, q.x);
  vec3 rim = vec3(0.06) + vec3(0.12) * max(0.0, cos(ang - 2.0)) * smoothstep(R, R * 0.93, r);
  lay(lit(rim), cover(r - R), vec2(0.0), 0.8);
  vec3 dial = vec3(0.9, 0.89, 0.85) * (0.86 + 0.14 * smoothstep(R * 0.9, 0.0, r));
  // Minute and hour marks, clockwise from twelve.
  float tick = clockMarks(q, R, 0.84, vec4(0.085, 0.018, 0.035, 0.006));
  dial = mix(dial, vec3(0.06), cover(tick));
  lay(lit(dial), cover(r - R * 0.9), vec2(0.0), 0.6);
  // The glass's glint.
  col += vec3(0.05 * uOther) * smoothstep(R * 0.9, R * 0.6, r) * smoothstep(0.3, 0.9, dot(normalize(q + 1e-5), vec2(-0.6, 0.8))) * smoothstep(R * 0.4, R * 0.8, r);
}

/** A VU meter's backlit face: its scale (black, then red) and the plate hiding the needle's pivot. */
void meterFace(vec2 f, vec4 m) {
  vec2 q = f - m.xy;
  q.x *= uSide;
  vec2 hs = m.zw;
  lay(vec3(0.02), cover(sdBox(q, hs + 0.005, 0.004)), vec2(0.0), 0.5);
  vec2 hot = q - vec2(0.0, -0.3 * hs.y);
  vec3 face = vec3(0.95, 0.82, 0.52) * (0.6 + 0.45 * exp(-dot(hot, hot) / (hs.y * hs.y * 1.5)));
  vec2 v = q - vec2(0.0, -VU_PIVOT * hs.y);
  float r = length(v) / hs.y;
  float th = atan(v.x, v.y);
  float pos = (th + VU_SWING) / (2.0 * VU_SWING);
  float inScale = step(-0.02, pos) * step(pos, 1.02);
  float arc = abs(r - 1.72) * hs.y - 0.0007;
  float red = abs(r - 1.79) * hs.y - 0.0035;
  float stepT = 0.1;
  float tk = abs(pos - floor(pos / stepT + 0.5) * stepT) * 2.0 * VU_SWING * length(v) - 0.0007;
  float tick = max(tk, abs(r - 1.82) * hs.y - 0.1 * hs.y);
  vec3 ink = pos > VU_RED ? vec3(0.75, 0.08, 0.05) : vec3(0.08);
  face = mix(face, vec3(0.08), cover(arc) * inScale * step(pos, VU_RED));
  face = mix(face, vec3(0.75, 0.08, 0.05), cover(red) * step(VU_RED, pos) * step(pos, 1.0));
  face = mix(face, ink, cover(tick) * inScale);
  // The plate along the bottom.
  float plate = q.y + 0.62 * hs.y;
  face = mix(face, vec3(0.05), cover(plate));
  // A glint on the glass.
  face += vec3(0.05) * smoothstep(0.2, 0.0, abs(q.x / hs.x + q.y / hs.y - 0.7));
  lay(face, cover(sdBox(q, hs, 0.002)), vec2(0.0), 0.3);
}

/** The equipment rack: meters, LED bars, knobs, buttons and a vent, in a dark cabinet. */
void rack(vec2 f) {
  vec2 q = f - RACK.xy;
  vec2 hs = RACK.zw;
  if (sdBox(q, hs, 0.0) > 0.04) {
    return;
  }
  col *= 1.0 - 0.5 * (1.0 - smoothstep(0.0, 0.025, sdBox(q - vec2(0.007, -0.012), hs, 0.004)));
  lay(lit(vec3(0.045)), cover(sdBox(q, hs, 0.004)), vec2(0.0), 0.7);
  float w = hs.x - 0.009;
  // Each unit: top and bottom (relative to the rack's centre) and its panel's colour.
  for (int i = 0; i < 5; i++) {
    float y1 = i == 0 ? 0.162 : i == 1 ? 0.046 : i == 2 ? -0.012 : i == 3 ? -0.074 : -0.12;
    float y0 = i == 0 ? 0.05 : i == 1 ? -0.008 : i == 2 ? -0.07 : i == 3 ? -0.116 : -0.162;
    vec3 pc = i == 2 ? vec3(0.3, 0.3, 0.31) : i == 4 ? vec3(0.14) : vec3(0.06);
    vec2 pq = q - vec2(0.0, 0.5 * (y0 + y1));
    vec2 ph = vec2(w, 0.5 * (y1 - y0));
    float d = sdBox(pq, ph, 0.0015);
    vec3 panel = pc * (0.85 + 0.3 * smoothstep(-ph.y, ph.y, pq.y));
    panel += vec3(0.06) * (1.0 - smoothstep(0.0, 0.0015, abs(pq.y - ph.y + 0.001)));
    // Screws at the ends.
    vec2 sq = vec2(abs(pq.x) - (w - 0.008), pq.y);
    panel = mix(panel, METAL * 0.5, cover(length(sq) - 0.0035));
    if (i == 2) {
      // Knobs with pointers.
      float kx = clamp(floor((q.x + w - 0.03) / 0.047 + 0.5), 0.0, 5.0);
      vec2 kq = pq - vec2(-w + 0.03 + kx * 0.047, 0.0);
      float kr = length(kq);
      panel = mix(panel, vec3(0.04), cover(kr - 0.0125));
      panel = mix(panel, METAL * (0.55 + 0.35 * smoothstep(0.01, -0.01, kq.x - kq.y)), cover(kr - 0.0095));
      float ka = -2.2 + 4.4 * rand(vec2(kx, 2.0), 5u);
      vec2 kd = vec2(sin(ka), cos(ka));
      panel = mix(panel, vec3(0.05), cover(sdSeg(kq, kd * 0.003, kd * 0.009) - 0.0012));
    } else if (i == 3) {
      // Square buttons, a few lit.
      float bx = clamp(floor((q.x + w - 0.024) / 0.03 + 0.5), 0.0, 8.0);
      vec2 bq = pq - vec2(-w + 0.024 + bx * 0.03, 0.0);
      float r = rand(vec2(bx, 3.0), 9u);
      vec3 on = r < 0.2 ? vec3(1.0, 0.6, 0.12) : r < 0.45 ? vec3(0.25, 0.9, 0.35) : vec3(0.0);
      float bd = sdBox(bq, vec2(0.0085), 0.0015);
      panel = mix(panel, vec3(0.13) + on * 0.6, cover(bd));
    } else if (i == 4) {
      panel *= 1.0 - 0.7 * cover(abs(fract(pq.y / 0.008) - 0.5) * 0.008 - 0.0015) * step(abs(pq.x), w - 0.025);
    }
    lay(lit(panel), cover(d), vec2(0.0), 0.7);
  }
  meterFace(f, METER0);
  meterFace(f, METER1);
  for (int i = 0; i < 2; i++) {
    vec4 b = i == 0 ? BAR0 : BAR1;
    lay(vec3(0.012), cover(sdBox(f - b.xy, b.zw + 0.002, 0.001)), vec2(0.0), 0.4);
  }
}

/** A cubby of records, spines out. */
void records(vec2 f) {
  vec2 q = f - RECORDS.xy;
  vec2 hs = RECORDS.zw;
  if (sdBox(q, hs, 0.0) > 0.04) {
    return;
  }
  col *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.02, sdBox(q - vec2(0.006, -0.01), hs, 0.003)));
  lay(lit(wood(q + 7.0) * 0.85), cover(sdBox(q, hs, 0.003)), vec2(0.0), 0.6);
  vec2 ih = hs - 0.011;
  float inner = sdBox(q, ih, 0.0);
  vec3 c = vec3(0.02);
  float pitch = 0.0068;
  float x = q.x + ih.x;
  float k = floor(x / pitch);
  float r = rand(vec2(k, 1.0), 13u);
  float top = ih.y - 0.004 - 0.016 * rand(vec2(k, 2.0), 13u);
  vec3 sleeve = r < 0.25 ? vec3(0.75, 0.7, 0.6) : r < 0.45 ? vec3(0.08) : r < 0.6 ? vec3(0.55, 0.14, 0.1) : r < 0.75 ? vec3(0.15, 0.25, 0.42) : r < 0.88 ? vec3(0.62, 0.45, 0.15) : vec3(0.3, 0.4, 0.3);
  float fx = fract(x / pitch);
  sleeve *= 0.7 + 0.4 * smoothstep(0.0, 0.6, fx) * smoothstep(1.0, 0.6, fx);
  float spine = max(q.y - top, max(x - (ih.x * 2.0 - 0.03), -x));
  c = mix(c, sleeve, cover(spine) * smoothstep(0.0, 0.12, fx) * smoothstep(1.0, 0.88, fx));
  c *= 0.55 + 0.45 * smoothstep(ih.y, ih.y - 0.03, q.y);
  lay(lit(c), cover(inner), vec2(0.0), 0.3);
}

/** A reel-to-reel machine's cabinet: the plate behind the reels, the heads, guides and tape, and its keys. */
void deck(vec2 f, vec4 dk, vec4 r0, vec4 r1) {
  vec2 q = f - dk.xy;
  vec2 hs = dk.zw;
  if (sdBox(q, hs, 0.0) > 0.04) {
    return;
  }
  col *= 1.0 - 0.5 * (1.0 - smoothstep(0.0, 0.025, sdBox(q - vec2(0.007, -0.012), hs, 0.006)));
  lay(lit(vec3(0.05)), cover(sdBox(q, hs, 0.006)), vec2(0.0), 0.6);
  float split = -0.03;
  vec2 ph = hs - 0.007;
  float brushed = 0.94 + 0.06 * rand(vec2(0.0, floor(f.y * 1400.0)), 17u);
  vec3 plate = vec3(0.5, 0.505, 0.52) * brushed * (0.85 + 0.2 * smoothstep(split, ph.y, q.y));
  vec3 c = mix(plate, vec3(0.06), step(q.y, split));
  // Shadows under the reels.
  for (int i = 0; i < 2; i++) {
    vec4 rl = i == 0 ? r0 : r1;
    c *= 1.0 - 0.5 * (1.0 - smoothstep(rl.z * 0.95, rl.z * 1.15, length(f - rl.xy - vec2(0.004, -0.007))));
  }
  // Tape: down from each reel round its guide, and across under the head.
  vec2 gl = vec2(-0.048, split - 0.038);
  vec2 gr = vec2(0.048, split - 0.038);
  float tape = min(sdSeg(q, r0.xy - dk.xy, gl + vec2(-0.006, 0.0)), sdSeg(q, r1.xy - dk.xy, gr + vec2(0.006, 0.0)));
  tape = min(tape, sdSeg(q, gl - vec2(0.0, 0.006), gr - vec2(0.0, 0.006)));
  c = mix(c, vec3(0.12, 0.075, 0.045), cover(tape - 0.0011));
  for (int i = 0; i < 2; i++) {
    vec2 gq = q - (i == 0 ? gl : gr);
    c = mix(c, METAL * (0.6 + 0.4 * smoothstep(0.004, -0.004, gq.x - gq.y)), cover(length(gq) - 0.006));
  }
  // The head block.
  vec2 hq = q - vec2(0.0, split - 0.045);
  c = mix(c, vec3(0.03), cover(sdBox(hq + vec2(-0.002, 0.003), vec2(0.026, 0.016), 0.003)));
  c = mix(c, vec3(0.2, 0.2, 0.22) * (0.8 + 0.4 * smoothstep(-0.016, 0.016, hq.y)), cover(sdBox(hq, vec2(0.026, 0.016), 0.003)));
  // Keys along the bottom, the play key lit.
  vec2 kq = q - vec2(0.0, -hs.y + 0.03);
  float kx = clamp(floor(kq.x / 0.022 + 0.5), -2.0, 2.0);
  vec2 kk = kq - vec2(kx * 0.022, 0.0);
  float kd = sdBox(kk, vec2(0.009, 0.007), 0.0015);
  vec3 key = kx == 1.0 ? vec3(0.3, 0.75, 0.35) : vec3(0.55, 0.55, 0.56) * (0.8 + 0.3 * smoothstep(-0.007, 0.007, kk.y));
  c = mix(c, key, cover(kd));
  // Two small knobs top-left of the keys.
  vec2 nq = vec2(abs(q.x) - hs.x + 0.025, q.y - (-hs.y + 0.065));
  c = mix(c, METAL * 0.6, cover(length(nq) - 0.006));
  lay(lit(c), cover(sdBox(q, ph, 0.003)), vec2(0.0), 0.6);
}

/** The desk along the bottom: a wooden lip, then the console with faders and lit buttons, and a turntable. */
void desk(vec2 f) {
  float top = ARM1.z;
  float lip = ARM1.w;
  if (f.y > top + 0.03) {
    return;
  }
  col *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.02, f.y - top));
  vec3 c = vec3(0.07, 0.072, 0.08) * (0.8 + 0.5 * smoothstep(top, lip, f.y));
  float ax = abs(f.x);
  float edge = 0.5 * uRes.x / uRes.y - 0.02;
  float turntable = PLATTER.x - PLATTER.z - 0.03;
  if (ax > 0.34 && ax < edge && !(f.x > turntable)) {
    float pitch = 0.042;
    float k = floor((ax - 0.34) / pitch);
    float lx = ax - 0.34 - (k + 0.5) * pitch;
    float mid = 0.5 * (top + lip) - 0.004;
    float slot = sdBox(vec2(lx, f.y - mid), vec2(0.0012, 0.022), 0.001);
    c = mix(c, vec3(0.01), cover(slot));
    float cy = mid - 0.018 + 0.036 * rand(vec2(k, sign(f.x)), 19u);
    vec2 cq = vec2(lx, f.y - cy);
    float cap = sdBox(cq, vec2(0.008, 0.0042), 0.001);
    c = mix(c, vec3(0.02), cover(sdBox(cq + vec2(-0.001, 0.002), vec2(0.008, 0.0042), 0.001)));
    c = mix(c, vec3(0.5, 0.5, 0.52) * (0.8 + 0.3 * smoothstep(-0.004, 0.004, cq.y)), cover(cap));
    c = mix(c, vec3(0.9), cover(abs(cq.y) - 0.0006) * step(abs(lx), 0.007));
    float r = rand(vec2(k, sign(f.x) + 5.0), 23u);
    vec3 glow = r < 0.25 ? vec3(1.0, 0.25, 0.15) : r < 0.5 ? vec3(0.3, 1.0, 0.4) : r < 0.65 ? vec3(1.0, 0.7, 0.2) : vec3(0.0);
    vec2 bq = vec2(lx, f.y - (top - 0.009));
    c = mix(c, vec3(0.12) + glow * 0.7, cover(sdBox(bq, vec2(0.0065, 0.0032), 0.001)));
    c += glow * 0.08 * exp(-dot(bq, bq) / 0.00006);
  }
  // The front lip.
  vec3 lipCol = wood(vec2(f.x, f.y) + 2.0) * (0.7 + 0.5 * smoothstep(lip - 0.006, lip, f.y));
  c = mix(c, lipCol, cover(f.y - lip));
  lay(c * lightK, cover(f.y - top), vec2(0.0, 0.6), 0.2);
  // The turntable on the desk.
  vec2 q = f - PLATTER.xy;
  vec2 pr = PLATTER.zw;
  vec2 plinthC = vec2(0.0, 0.5 * (lip + 0.004 - PLATTER.y + pr.y + 0.012));
  vec2 plinthH = vec2(pr.x + 0.026, 0.5 * (pr.y + 0.012 - lip - 0.004 + PLATTER.y));
  vec3 plinth = vec3(0.1, 0.08, 0.07) * (0.8 + 0.4 * smoothstep(-plinthH.y, plinthH.y, q.y - plinthC.y));
  plinth = mix(plinth, wood(q + 9.0) * 0.6, step(q.y - plinthC.y, -plinthH.y + 0.012));
  lay(lit(plinth), cover(sdBox(q - plinthC, plinthH, 0.002)), vec2(0.0, 0.5), 0.2);
  float e = length(q / pr);
  float ed = (e - 1.0) * pr.y;
  vec3 tt = METAL * 0.7;
  float rec = (e - 0.94) * pr.y;
  float ang = atan(q.y / pr.y, q.x / pr.x);
  vec3 vinyl = vec3(0.025) + vec3(0.07) * pow(abs(sin(ang + 0.6)), 8.0) * step(0.32, e);
  tt = mix(tt, vinyl, cover(rec));
  tt = mix(tt, vec3(0.7, 0.2, 0.12), cover((e - 0.3) * pr.y));
  tt = mix(tt, METAL, cover((e - 0.05) * pr.y));
  lay(lit(tt), cover(ed), vec2(0.0, 0.5), 0.2);
  vec2 pivot = vec2(pr.x + 0.012, pr.y * 0.6);
  vec2 head = vec2(pr.x * 0.45, -pr.y * 0.1);
  lay(lit(METAL * 0.8), cover(sdSeg(q, pivot, head) - 0.0016), vec2(0.0), 0.2);
  lay(lit(vec3(0.15)), cover(sdBox(q - head, vec2(0.0045, 0.0028), 0.001)), vec2(0.0), 0.2);
  lay(lit(METAL * 0.5), cover(length(q - pivot) - 0.0065), vec2(0.0), 0.2);
}

/** The broadcast microphone on its sprung boom arm, with its shadow on the wall. */
void mic(vec2 f) {
  // Nothing of it (or its shadow) reaches past these.
  if (f.x < ARM0.x - 0.03 || f.x > ARM1.x + 0.03) {
    return;
  }
  vec2 a0 = ARM0.xy;
  vec2 a1 = ARM0.zw;
  vec2 a2 = ARM1.xy;
  vec2 m = MIC.xy;
  vec2 mh = MIC.zw;
  vec2 bodyC = vec2(m.x, m.y - mh.y - 0.045);
  vec2 bodyH = vec2(0.022, 0.06);
  // Shadows on the wall, down and to the right.
  vec2 s = f - vec2(0.012, -0.02);
  float sd = min(sdSeg(s, a0, a1), sdSeg(s, a1, a2)) - 0.006;
  sd = min(sd, sdBox(s - m, mh, mh.x));
  sd = min(sd, sdBox(s - bodyC, bodyH + vec2(0.02, 0.0), 0.02));
  col *= 1.0 - 0.35 * (1.0 - smoothstep(-0.004, 0.02, sd));
  // The cable, sagging down to the desk.
  vec2 c0 = bodyC - vec2(0.0, bodyH.y);
  vec2 c2 = vec2(m.x - 0.06, ARM1.z);
  vec2 c1 = vec2(m.x + 0.02, 0.5 * (c0.y + c2.y) - 0.05);
  float cd = 1e3;
  vec2 prev = c0;
  for (int i = 1; i <= 6; i++) {
    float t = float(i) / 6.0;
    vec2 p = mix(mix(c0, c1, t), mix(c1, c2, t), t);
    cd = min(cd, sdSeg(f, prev, p));
    prev = p;
  }
  lay(lit(vec3(0.03)), cover(cd - 0.0028), vec2(0.0), 0.3);
  // The arm: two tubes with springs alongside, and the elbow.
  for (int i = 0; i < 2; i++) {
    vec2 p0 = i == 0 ? a0 : a1;
    vec2 p1 = i == 0 ? a1 : a2;
    vec2 dir = normalize(p1 - p0);
    vec2 n = vec2(-dir.y, dir.x);
    float along = dot(f - p0, dir);
    float acr = dot(f - p0, n);
    float tube = sdSeg(f, p0, p1) - 0.0048;
    vec3 tc = vec3(0.05) + vec3(0.18) * smoothstep(0.0048, 0.0, abs(acr - 0.0015)) * 0.6;
    lay(lit(tc), cover(tube), vec2(0.0), 0.4);
    float len = length(p1 - p0);
    vec2 s0 = p0 + dir * len * 0.2 + n * 0.0115;
    vec2 s1 = p0 + dir * len * 0.7 + n * 0.0115;
    float spring = sdSeg(f, s0, s1) - 0.0034;
    vec3 sc = METAL * (0.35 + 0.55 * pow(0.5 + 0.5 * sin(along * TAU / 0.0042), 2.0));
    lay(lit(sc), cover(spring), vec2(0.0), 0.4);
    float link = min(sdSeg(f, s0, s0 - n * 0.0115), sdSeg(f, s1, s1 - n * 0.0115)) - 0.0012;
    lay(lit(METAL * 0.5), cover(link), vec2(0.0), 0.4);
  }
  lay(lit(vec3(0.07)), cover(length(f - a1) - 0.011), vec2(0.0), 0.4);
  lay(lit(METAL * 0.55), cover(length(f - a1) - 0.004), vec2(0.0), 0.4);
  // The shock mount: a cage round the body, hung on elastic cords.
  vec2 bq = f - bodyC;
  float cage = min(sdBox(vec2(bq.x, abs(bq.y) - 0.03), vec2(0.045, 0.0028), 0.0015), sdBox(vec2(abs(bq.x) - 0.045, bq.y), vec2(0.0028, 0.033), 0.0015));
  float cords = 1e3;
  for (int i = -1; i <= 1; i += 2) {
    for (int j = -1; j <= 1; j += 2) {
      cords = min(cords, sdSeg(bq, vec2(float(i) * 0.045, float(j) * 0.03), vec2(float(i) * 0.02, float(-j) * 0.012)));
    }
  }
  // The yoke from the arm's tip to the cage.
  float yoke = sdSeg(f, a2, bodyC + vec2(0.045, 0.0)) - 0.003;
  lay(lit(vec3(0.07)), cover(min(cage, yoke)), vec2(0.0), 0.4);
  lay(lit(vec3(0.02)), cover(cords - 0.001), vec2(0.0), 0.3);
  // The body: a dark metal cylinder with a bright band.
  float bd = sdBox(bq, bodyH, 0.012);
  float cyl = bq.x / bodyH.x;
  vec3 body = vec3(0.12, 0.12, 0.13) * (0.55 + 0.6 * sqrt(max(0.0, 1.0 - cyl * cyl)) * smoothstep(1.0, -0.6, cyl));
  body = mix(body, METAL * (0.6 + 0.4 * smoothstep(0.6, -0.4, cyl)), step(abs(bq.y - bodyH.y + 0.012), 0.004));
  lay(lit(body), cover(bd), vec2(0.0), 0.3);
  lay(lit(vec3(0.02)), cover(cords - 0.001) * step(abs(bq.x), bodyH.x), vec2(0.0), 0.3);
  // The foam windscreen on top.
  vec2 wq = f - m;
  float wd = sdBox(wq, mh, mh.x);
  float wx = wq.x / mh.x;
  float stip = 0.85 + 0.3 * rand(floor(f * 520.0), 29u);
  vec3 wind = vec3(0.075, 0.075, 0.08) * stip * (0.5 + 0.75 * sqrt(max(0.0, 1.0 - wx * wx)) * smoothstep(1.1, -0.7, wx));
  wind *= 0.8 + 0.3 * smoothstep(-mh.y, mh.y, wq.y);
  lay(lit(wind), cover(wd), vec2(0.0), 0.5);
}

vec4 room(vec2 f) {
  lightK = lighting(f);
  foam(f);
  trim(f);
  windowPane(f);
  signHousing(f);
  clockFace(f);
  rack(f);
  records(f);
  deck(f, DECK0, REEL0, REEL1);
  deck(f, DECK1, REEL2, REEL3);
  desk(f);
  mic(f);
  // How much of the sign's glow lands here.
  vec2 q = f - SIGN.xy;
  float ds = max(sdBox(q, SIGN.zw + SIGN_RIM, 0.008), 0.0);
  vec2 toSign = normalize(-q + vec2(0.0, 1e-4));
  float fall = 0.7 * exp(-ds / 0.03) + 0.5 * exp(-ds / 0.12);
  float facing = clamp(0.65 + 0.6 * dot(nrm, toSign), 0.0, 1.4);
  return vec4(col, clamp(fall * facing * recv, 0.0, 1.0));
}

void main() {
  px = 1.0 / uRes.y;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    vec2 f = (gl_FragCoord.xy + o - 0.5 * uRes) / uRes.y;
    sum += room(vec2(f.x * uSide, f.y));
  }
  sum *= 0.25;
  outColor = uOther > 0.5
    ? vec4(sum.rgb + dither8(gl_FragCoord.xy), sum.a)
    : vec4(sum.r * ${g(1 / MASK_RANGE)}, 0.0, 0.0, 1.0);
}
`;

/**
 * Every frame: the cached booth, plus the sign's red glow on it. While the foam
 * colour changes, the booth is cached without the foam and the foam is tinted
 * here from its light mask (\`uTint\`: the colour times the light and the mask's
 * range, and 1 in w while it applies).
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uMask;
uniform vec4 uTint;
uniform float uGlow;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec4 r = texelFetch(uRoom, ivec2(gl_FragCoord.xy), 0);
  if (uTint.w > 0.5) {
    r.rgb += uTint.rgb * texelFetch(uMask, ivec2(gl_FragCoord.xy), 0).r;
  }
  vec3 glow = vec3(${g(GLOW_RGB[0])}, ${g(GLOW_RGB[1])}, ${g(GLOW_RGB[2])});
  outColor = vec4(r.rgb + glow * (uGlow * r.a) + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * The small live parts, each drawn premultiplied in a scissor round its box:
 * the sign's lit face, a VU needle, an LED bar, a tape reel and the clock's
 * hands.
 */
const GADGET_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform int uKind;
/** The part's centre and half size (frame units), or centre and radius. */
uniform vec4 uBox;
uniform vec4 uVal;
uniform sampler2D uText;
out vec4 outColor;
${SHARED_GLSL}
const float VU_PIVOT = ${g(VU_PIVOT)};

/** Premultiplied src over dst. */
${OVER_GLSL}

/** The sign's face: dark red glass with grey letters, lit up to red with white letters by uVal.x. */
vec4 signFace(vec2 q) {
  vec2 hs = uBox.zw;
  float d = sdBox(q, hs, 0.005);
  vec2 uv = q / hs * 0.5 + 0.5;
  vec4 t = texture(uText, vec2(uv.x, 1.0 - uv.y));
  float L = uVal.x;
  vec3 off = vec3(0.085, 0.018, 0.016) * (0.8 + 0.4 * uv.y) + vec3(0.1, 0.075, 0.075) * t.r;
  vec2 c = q / hs;
  float centre = (1.0 - 0.5 * c.x * c.x) * (1.0 - 0.6 * c.y * c.y);
  vec3 on = vec3(0.8, 0.07, 0.045) * (0.6 + 0.45 * centre) + vec3(0.55, 0.16, 0.12) * t.g;
  on = mix(on, vec3(1.0, 0.94, 0.9), t.r);
  vec3 col = mix(off, on, L);
  col *= 0.7 + 0.3 * smoothstep(0.0, 0.006, -d);
  float a = cover(d);
  return vec4(col * a, a);
}

float needleShape(vec2 v, vec2 dir, float len, float w) {
  float along = dot(v, dir);
  float across = abs(v.x * dir.y - v.y * dir.x);
  return max(across - w, max(0.35 * len - along, along - len));
}

/** A VU needle at angle uVal.x from upright, pivoting below the face, hidden by its bottom plate. */
vec4 vuNeedle(vec2 q) {
  vec2 hs = uBox.zw;
  vec2 v = q - vec2(0.0, -VU_PIVOT * hs.y);
  vec2 dir = vec2(sin(uVal.x), cos(uVal.x));
  float len = 1.95 * hs.y;
  float clip = cover(-0.62 * hs.y - q.y) * cover(sdBox(q, hs, 0.002));
  float sh = clamp(0.5 - needleShape(v - vec2(0.0012, -0.0018), dir, len, 0.0008) / (2.5 * px), 0.0, 1.0) * 0.3;
  float n = cover(needleShape(v, dir, len, 0.0007));
  vec4 o = vec4(0.0, 0.0, 0.0, sh);
  o = over(vec4(vec3(0.03) * n, n), o);
  return o * clip;
}

/** An LED bar of segments, lit from the left up to uVal.x: green, then amber, then red. */
vec4 ledBar(vec2 q) {
  vec2 hs = uBox.zw;
  float n = ${g(BAR_SEGMENTS)};
  float seg = 2.0 * hs.x / n;
  float u = (q.x + hs.x) / seg;
  float i = clamp(floor(u), 0.0, n - 1.0);
  float d = sdBox(vec2((u - i - 0.5) * seg, q.y), vec2(0.5 * seg - 0.0011, hs.y - 0.0012), 0.0004);
  vec3 c = i < n * 0.69 ? vec3(0.2, 0.95, 0.3) : i < n * 0.88 ? vec3(1.0, 0.68, 0.1) : vec3(1.0, 0.16, 0.1);
  float lit = step((i + 0.5) / n, uVal.x);
  c *= mix(0.08, 1.0, lit);
  float a = cover(d);
  return vec4(c * a, a);
}

/** A tape reel turned to uVal.x radians, its pack of tape uVal.y of its radius, seen through three holes in the flange. */
vec4 reel(vec2 q) {
  float R = uBox.z;
  float r = length(q);
  float cs = cos(uVal.x);
  float sn = sin(uVal.x);
  vec2 qr = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
  float hole = 1e3;
  for (int k = 0; k < 3; k++) {
    float a = float(k) * TAU / 3.0 + 0.5;
    hole = min(hole, length(qr - 0.6 * R * vec2(cos(a), sin(a))) - 0.25 * R);
  }
  float pack = uVal.y * R;
  vec3 tape = vec3(0.1, 0.068, 0.048) * (0.8 + 0.3 * smoothstep(pack * 0.5, pack, r));
  tape += vec3(0.04, 0.03, 0.02) * (1.0 - smoothstep(0.0, 0.0025, abs(r - pack + 0.0015)));
  vec3 behind = mix(vec3(0.045), tape, cover(r - pack));
  float phi = atan(q.y, q.x);
  vec3 flange = vec3(0.62, 0.63, 0.65) * (0.7 + 0.25 * cos(2.0 * (phi - 0.8))) * (0.85 + 0.15 * smoothstep(R, 0.3 * R, r));
  flange *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.0025, R - r));
  flange *= 0.75 + 0.25 * smoothstep(0.0, 0.003, hole);
  vec3 c = mix(flange, behind, cover(hole));
  // The hub, its three driving slots turning with the reel, and the spindle.
  float hub = r - ${g(REEL_HUB * 0.72)} * R;
  vec3 hc = vec3(0.16, 0.16, 0.17);
  float notch = 1e3;
  for (int k = 0; k < 3; k++) {
    float a = float(k) * TAU / 3.0;
    vec2 d = vec2(cos(a), sin(a));
    notch = min(notch, sdBox(vec2(dot(qr, d) - 0.13 * R, dot(qr, vec2(-d.y, d.x))), vec2(0.045 * R, 0.022 * R), 0.0));
  }
  hc = mix(hc, vec3(0.03), cover(notch));
  hc = mix(hc, vec3(0.75), cover(r - 0.06 * R));
  c = mix(c, hc, cover(hub));
  float a = cover(r - R);
  return vec4(c * a, a);
}

${CLOCK_HANDS_GLSL}

/** The clock's hands at uVal.xyz (hour, minute, second; clockwise from twelve), with their shadows. */
vec4 clockHands(vec2 q) {
  return clockHandsAt(q, uVal.xyz, uBox.z, vec3(0.05), vec3(0.85, 0.08, 0.06), true);
}

void main() {
  px = 1.0 / uRes.y;
  vec2 f = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 q = f - uBox.xy;
  if (uKind == ${String(KIND_SIGN)}) {
    outColor = signFace(q);
  } else if (uKind == ${String(KIND_NEEDLE)}) {
    outColor = vuNeedle(q);
  } else if (uKind == ${String(KIND_BAR)}) {
    outColor = ledBar(q);
  } else if (uKind == ${String(KIND_REEL)}) {
    outColor = reel(q);
  } else {
    outColor = clockHands(q);
  }
}
`;

/**
 * A DJ's booth in a radio studio: wedge foam on the walls, a red ON AIR sign
 * high on one side, a broadcast microphone on a sprung arm on the other, a
 * rack of meters, a shelf of records, two reel-to-reel machines under the
 * window into the producer's dim control room, a studio clock, and the desk's
 * edge with its faders along the bottom. The booth is drawn once per resize
 * or setting change (a foam colour being dragged is tinted in the composite);
 * each frame adds the sign's glow and redraws a few small live parts: the
 * sign's face (fading on and off with the light), the VU needles and LED bars
 * dancing to a random music-like envelope, the turning reels and the clock's
 * hands.
 */
export const radiostudio = defineEffect(radiostudioMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);
      const roomProgram = program(ROOM_FRAGMENT);
      const compProgram = program(COMPOSITE_FRAGMENT);
      const gadgetProgram = program(GADGET_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ru = createUniforms(gl, roomProgram, ["uRes", "uSide", "uFoam", "uOther", "uL"]);
      const cu = createUniforms(gl, compProgram, ["uRoom", "uMask", "uTint", "uGlow"]);
      const gu = createUniforms(gl, gadgetProgram, ["uRes", "uKind", "uBox", "uVal", "uText"]);
      gl.useProgram(compProgram);
      cu.i1("uRoom", 0);
      cu.i1("uMask", 1);
      gl.useProgram(gadgetProgram);
      gu.i1("uText", 0);
      gl.useProgram(null);

      const signText = createCanvasTexture(gl, scope);
      const textTex = signText.texture;
      const uploadText = signText.upload;

      /**
       * Draws the sign's text white on black at the face's size in pixels: red
       * is the letters, green a soft glow round them. Capitals, centred, sized
       * to fit the face.
       */
      const drawText = (text: string, pw: number, ph: number) => {
        const line = text.toUpperCase().trim();
        if (line === "") {
          uploadText(null);
          return;
        }
        uploadText(
          paintCanvas(pw, ph, (ctx) => {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, pw, ph);
            let size = 100;
            ctx.font = `bold ${String(size)}px ${FONT_FAMILY}`;
            // Typed loosely: the tests' fake 2D context returns undefined from every method.
            const metrics = ctx.measureText(line) as TextMetrics | undefined;
            const width = metrics?.width;
            const em = typeof width === "number" && width > 0 ? width / size : 0.68 * line.length;
            const capRatio = 0.72;
            size = Math.min((0.5 * ph) / capRatio, (0.84 * pw) / Math.max(em, 0.01));
            ctx.font = `bold ${String(size)}px ${FONT_FAMILY}`;
            ctx.textAlign = "center";
            ctx.textBaseline = "alphabetic";
            ctx.globalCompositeOperation = "lighter";
            const x = pw / 2;
            const y = ph / 2 + (capRatio * size) / 2;
            ctx.shadowColor = "#0f0";
            ctx.shadowBlur = ph * 0.12;
            ctx.fillStyle = "#0f0";
            ctx.fillText(line, x, y);
            ctx.shadowBlur = 0;
            ctx.shadowColor = "transparent";
            ctx.fillStyle = "#f00";
            ctx.fillText(line, x, y);
          }),
        );
      };

      let roomTarget: RenderTarget | null = null;
      /** The foam's light mask, made the first time the foam colour changes. */
      let maskTarget: RenderTarget | null = null;
      scope.defer(() => {
        roomTarget?.dispose();
        maskTarget?.dispose();
      });
      /** Whether the cached booth leaves the foam out, for the composite to tint. */
      let tinting = false;
      /** Seconds since the foam colour last changed. */
      let foamStill = 0;
      let width = 1;
      let height = 1;
      let layout = studioLayout(16 / 9);
      const slots = new Float32Array(STUDIO_SLOTS * 4);
      // What the cached booth and sign text were drawn for; NaN or null forces a redraw.
      let roomSide = Number.NaN;
      let roomFoam = "";
      let roomClock: boolean | null = null;
      let textW = 0;
      let textH = 0;
      let textValue: string | null = null;
      const foamRgb = unitRgbMemo();

      let light = Number.NaN;
      let time = 0;
      const walk = createGraphWalk(2, 136);
      const needles = [createNeedle(), createNeedle()];
      const bars = new Float64Array(2);
      const tapes = [createTape(0.35), createTape(0.7)];
      const day = createDayClock();
      const hands = new Float64Array(3);

      /** Draws the booth (or with `other` 0, the foam's light mask) into `target`. */
      const drawRoom = (
        target: RenderTarget,
        foamR: number,
        foamG: number,
        foamB: number,
        other: number,
        side: number,
      ) => {
        gl.useProgram(roomProgram);
        ru.f2("uRes", width, height);
        ru.f1("uSide", side);
        ru.f3("uFoam", foamR, foamG, foamB);
        ru.f1("uOther", other);
        gl.uniform4fv(ru.loc.uL, slots);
        target.bind();
        triangle.draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
      };

      /** Mirrors the room: 1, or -1 with the mic on the right. */
      let side = 1;
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
          maskTarget?.dispose();
          maskTarget = null;
          tinting = false;
          layout = studioLayout(width / height);
          roomSide = Number.NaN;
          textValue = null;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!roomTarget) {
            return;
          }
          side = p.mic === "right" ? -1 : 1;
          const foam = foamRgb(p.foam);

          // 1. The booth, when the size or a setting it shows changes. A new
          // foam colour alone is tinted in the composite (step 4) until it
          // holds still, so dragging the colour doesn't redraw the booth.
          foamStill = p.foam === roomFoam ? foamStill + step : 0;
          if (side !== roomSide || p.clock !== roomClock) {
            roomSide = side;
            roomClock = p.clock;
            roomFoam = p.foam;
            packStudioLayout(layout, p.clock, slots);
            drawRoom(roomTarget, foam[0], foam[1], foam[2], 1, side);
            tinting = false;
          } else if (p.foam !== roomFoam) {
            roomFoam = p.foam;
            if (!tinting) {
              // Allocates only the first time the room is tinted.
              maskTarget ??= createRenderTarget(gl, width, height, gl.R8, { filter: gl.NEAREST });
              if (maskTarget) {
                drawRoom(roomTarget, 0, 0, 0, 1, side);
                drawRoom(maskTarget, 1, 1, 1, 0, side);
                tinting = true;
              } else {
                drawRoom(roomTarget, foam[0], foam[1], foam[2], 1, side);
              }
            }
          } else if (tinting && foamStill >= FOAM_SETTLE) {
            drawRoom(roomTarget, foam[0], foam[1], foam[2], 1, side);
            tinting = false;
          }

          // 2. The sign's text, when it or the face's size changes.
          const [, , shw, shh] = layout.sign;
          const pw = Math.max(1, Math.min(MAX_TEXT_TEXELS, Math.round(2 * shw * height)));
          const ph = Math.max(1, Math.min(MAX_TEXT_TEXELS, Math.round(2 * shh * height)));
          if (pw !== textW || ph !== textH || p.sign !== textValue) {
            textW = pw;
            textH = ph;
            textValue = p.sign;
            drawText(p.sign, pw, ph);
          }

          // 3. The light, the meters, the reels and the clock.
          const target = onAirTarget(p.onAir, time);
          light = Number.isNaN(light) ? target : stepLight(light, target, step);
          const shown = smoothstep(0, 1, light);
          advanceGraph(walk, time);
          for (let i = 0; i < 2; i++) {
            const level = musicLevel(walkWander(walk, i, MUSIC_SAMPLES), shown);
            stepNeedle(needles[i], level, step);
            bars[i] = stepBar(bars[i], level, step);
          }
          for (const tape of tapes) {
            stepTape(tape, step, shown);
          }
          clockHands(day.step(step, "local", 0, 0), hands);

          // 4. The booth and the sign's glow on it.
          gl.useProgram(compProgram);
          cu.f1("uGlow", shown);
          if (tinting && maskTarget) {
            const k = MASK_RANGE;
            cu.f4(
              "uTint",
              foam[0] * LIGHT_RGB[0] * k,
              foam[1] * LIGHT_RGB[1] * k,
              foam[2] * LIGHT_RGB[2] * k,
              1,
            );
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, maskTarget.texture);
          } else {
            cu.f4("uTint", 0, 0, 0, 0);
          }
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, roomTarget.texture);
          triangle.draw();

          // 5. The live parts, each in a scissor round its box.
          gl.useProgram(gadgetProgram);
          gu.f2("uRes", width, height);
          gl.bindTexture(gl.TEXTURE_2D, textTex);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.enable(gl.SCISSOR_TEST);
          const [sx, sy] = layout.sign;
          gu.f4("uVal", shown, 0, 0, 0);
          drawGadget(KIND_SIGN, sx, sy, shw, shh);
          for (let i = 0; i < 2; i++) {
            const m = layout.meters[i];
            gu.f4("uVal", (2 * needles[i].pos - 1) * VU_SWING, 0, 0, 0);
            drawGadget(KIND_NEEDLE, m[0], m[1], m[2], m[3]);
            const b = layout.bars[i];
            gu.f4("uVal", bars[i], 0, 0, 0);
            drawGadget(KIND_BAR, b[0], b[1], b[2], b[3]);
          }
          for (let i = 0; i < 4; i++) {
            const [rx, ry, rr] = layout.reels[i];
            const tape = tapes[i >> 1];
            const right = (i & 1) === 1;
            const angle = right ? tape.right : tape.left;
            const fill = right ? tape.fill : 1 - tape.fill;
            gu.f4("uVal", angle, packRadius(fill), 0, 0);
            drawGadget(KIND_REEL, rx, ry, rr, rr);
          }
          if (p.clock) {
            const [cx, cy, cr] = layout.clock;
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
