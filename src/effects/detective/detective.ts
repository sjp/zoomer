import { createCanvasTexture, paintCanvas, SERIF_FONT_STACK } from "../canvas-texture";
import { createChangeKey } from "../change-key";
import { createColorEase, type Rgb } from "../color";
import {
  LIT_CELLS,
  LIT_GAIN,
  STEAM_HEIGHT_DECAY,
  STEAM_OPACITY,
  STEAM_RADIUS,
  steamEmitter,
  type SteamEmitter,
  steamFlow,
  WISP_K,
  WISP_SPEED,
} from "../cup-steam";
import { buildGrainTexture, GRAIN_SIZE } from "../frost-texture";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat as f,
  type RenderTarget,
  scopedProgram,
  withScope,
} from "../gl";
import {
  DROP_CLEAR,
  DROP_DIR_GLSL,
  DROP_FRAGMENT,
  DROP_VERTEX,
  ENC_MID,
  OFFSET_RANGE,
} from "../glass-rain";
import {
  createRainSim,
  instanceCapacity,
  type RainSimConfig,
  type RainSimParams,
  stepRainSim,
  writeDropInstances,
} from "../glass-rain-sim";
import { EASED_GRAIN_GLSL } from "../grain";
import { lookup } from "../lookup";
import { clamp, wrap } from "../math";
import { createRng, HASH32_GLSL, VALUE_NOISE_GLSL } from "../noise";
import { sanitizeText } from "../params";
import { fitScale } from "../scene-layout";
import { createSmokeField } from "../smoke/smoke-field";
import { type Flow, simSteps, WAVE_COUNT, wavePhases } from "../smoke/smoke-sim";
import { createSpriteBatch, polygonStrip } from "../sprites";
import type { StepClock } from "../step-clock";
import { defineEffect } from "../types";
import {
  CUP_R,
  CUP_TOP,
  CUP_X,
  CUP_Z,
  FOCAL,
  PANEL_Y0,
  PANEL_Y1,
  PANEL_Z0,
  PANEL_Z1,
  project,
  ROOM_GLSL,
} from "./detective-room";
import {
  createFan,
  createSign,
  DOOR_CANVAS_H,
  DOOR_CANVAS_W,
  DOOR_LINE_HEIGHT,
  doorLines,
  fitDoorText,
  GRAIN_HZ,
  gateWeave,
  SIGN_LIGHT,
  stepFan,
  stepSign,
  STREET_LIGHT,
  TONE_FLOATS,
  TONES,
} from "./detective-sim";
import { detectiveMeta } from "./detective.meta";

/** Seconds a tone change eases over. */
const TONE_EASE = 1.2;
/** The lamp's light is stored over this range in the cached light map. */
const LAMP_RANGE = 4;

/** Light colours before the tone: the night's ambient, the lamp, the corridor behind the door, the street. */
const AMBIENT: Rgb = [0.19, 0.2, 0.235];
const LAMP_RGB: Rgb = [1, 0.8, 0.52];
const DOOR_RGB: Rgb = [0.95, 0.88, 0.7];
const STREET_RGB: Rgb = [0.72, 0.78, 0.92];

/** The rain on the window: sim px per metre of glass, and the drops' pools for a pane this size. */
const RAIN_PX_PER_M = 330;
const RAIN_CONFIG: Readonly<RainSimConfig> = {
  maxStatic: 900,
  maxTrails: 420,
  maxRunners: 14,
  cellSize: 16,
};
/** Glass width and height (m), for the rain's sim size. */
const GLASS_W = 1.45;
const GLASS_H = 1.5;
/** Refraction through the drops, as a share of Rain on a Window's. */
const REFRACTION = 0.5;
/** The view through the window: its target's size in texels. */
const VIEW_W = 150;
const VIEW_H = 156;

/** Steam: sim units per design px (small curls for a small cup), its box around the cup's rim (design px), grid cell. */
const STEAM_UNITS = 1 / 180;
const STEAM_BOX = [-85, -10, 85, 290] as const;
const STEAM_CELL = 3;
/** How much steam the cup gives (the shared emitter's 0..1), and the draft's gentle sway. */
const STEAM_AMOUNT = 0.55;
const STEAM_SWAY = 0.035;

const LUMA = "vec3(0.299, 0.587, 0.114)";

/**
 * The room, drawn once per resize (and when the door's lettering changes) in
 * two passes of this shader: pass 0 the albedo (alpha: how much of the
 * window's glass shows), pass 1 the light each pixel gets: the lamp's (over
 * LAMP_RANGE), the sign's through the blinds, the corridor's through the door,
 * and the ambient.
 */
const CACHE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uUnit;
uniform int uPass;
uniform sampler2D uFrost;
uniform sampler2D uLetters;
out vec4 outColor;
${VALUE_NOISE_GLSL}
${ROOM_GLSL}

struct Mat {
  vec3 alb;
  float glass;
  float lamp;
  float win;
  float door;
  float amb;
};

Mat mat(vec3 alb) {
  Mat m;
  m.alb = alb;
  m.glass = 0.0;
  m.lamp = 0.0;
  m.win = 0.0;
  m.door = 0.0;
  m.amb = 1.0;
  return m;
}

void over(inout Mat m, Mat o, float c) {
  m.alb = mix(m.alb, o.alb, c);
  m.glass = mix(m.glass, o.glass, c);
  m.lamp = mix(m.lamp, o.lamp, c);
  m.win = mix(m.win, o.win, c);
  m.door = mix(m.door, o.door, c);
  m.amb = mix(m.amb, o.amb, c);
}

float cover(float sd, float aa) {
  return clamp(0.5 - sd / aa, 0.0, 1.0);
}
float sdBox(vec2 p, vec2 c, vec2 h) {
  vec2 q = abs(p - c) - h;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
float sdRBox(vec2 p, vec2 c, vec2 h, float r) {
  return sdBox(p, c, h - r) - r;
}
float sdEll(vec2 p, vec2 c, vec2 r) {
  return (length((p - c) / r) - 1.0) * min(r.x, r.y);
}
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

/** The lamp's light at P: strong below its shade, a faint glow elsewhere. */
float lampAt(vec3 P, vec3 N) {
  vec3 v = LAMP_P - P;
  float d2 = dot(v, v);
  vec3 l = v * inversesqrt(max(d2, 1e-6));
  float cone = mix(0.15, 1.0, smoothstep(0.05, 0.45, l.y));
  return max(dot(N, l), 0.0) * cone * 0.5 / (0.04 + d2);
}

/** The corridor's light spilling through the door's glass onto P. */
float doorSpill(vec3 P, vec3 N) {
  vec3 v = vec3(-HALF_W, 0.3, DOOR.x) - P;
  float d2 = dot(v, v);
  float facing = max(dot(N, v * inversesqrt(max(d2, 1e-6))), 0.0);
  return facing * 0.05 / (0.15 + d2);
}

/** Old wallpaper: a muted stripe and a few stains, at wall coordinates q (m). */
vec3 wallpaper(vec2 q) {
  float stripe = 0.5 + 0.5 * cos(q.x * 39.27);
  float stain = vnoise(q * vec2(2.0, 1.2), 3.0);
  return vec3(0.4, 0.41, 0.35) * (0.92 + 0.06 * stripe + 0.12 * (stain - 0.5));
}

/** Dark wood with its grain along q.x. */
vec3 wood(vec2 q, vec3 c) {
  float g = vnoise(vec2(q.x * 3.0, q.y * 60.0), 5.0) * 0.6 + vnoise(vec2(q.x * 9.0, q.y * 180.0), 7.0) * 0.4;
  return c * (0.78 + 0.4 * g);
}

/** A wall below the dado rail: wood panels; above it, wallpaper. h along the wall, y up. */
vec3 wall(vec2 q, float aa) {
  if (q.y < -0.43) {
    vec3 c = wood(vec2(q.y, q.x), vec3(0.26, 0.17, 0.11));
    float joint = abs(fract(q.x / 0.55) - 0.5) * 0.55;
    c *= 0.6 + 0.4 * smoothstep(0.004, 0.004 + aa, abs(joint - 0.275));
    float rail = smoothstep(-0.49, -0.47, q.y);
    return mix(c, vec3(0.34, 0.23, 0.15), rail);
  }
  return wallpaper(q);
}

/** Ambient light: darker into the room's corners and edges. */
float ambientAt(vec3 P, int id) {
  vec3 e = vec3(HALF_W - abs(P.x), CEILING - P.y, DEPTH - P.z);
  if (id == 0) e.z = 9.0;
  if (id == 1 || id == 2) e.x = 9.0;
  if (id == 3) e.y = 9.0;
  float m = min(min(e.x, e.y), e.z);
  float floorDist = P.y - FLOOR;
  return (0.55 + 0.45 * smoothstep(0.0, 0.8, m)) * (0.75 + 0.25 * smoothstep(0.0, 1.2, floorDist));
}

/** The framed picture on the back wall, hung a little crooked. */
void picture(inout Mat m, vec2 q, float aa) {
  float a = 0.05;
  vec2 c = vec2(-1.08, 0.42);
  vec2 p = mat2(cos(a), sin(a), -sin(a), cos(a)) * (q - c);
  float outer = sdBox(p, vec2(0.0), vec2(0.3, 0.22));
  if (outer > aa) return;
  float inner = sdBox(p, vec2(0.0), vec2(0.25, 0.17));
  // A harbour at dusk: pale sky, dark hills, a ship's dark hull.
  vec3 print = mix(vec3(0.62, 0.6, 0.55), vec3(0.78, 0.76, 0.7), smoothstep(-0.1, 0.17, p.y));
  float hills = p.y - (-0.04 + 0.04 * sin(p.x * 11.0) + 0.02 * sin(p.x * 23.0 + 1.0));
  print = mix(vec3(0.22, 0.22, 0.2), print, smoothstep(-aa, aa, hills));
  float hull = sdBox(p, vec2(0.05, -0.08), vec2(0.09, 0.018));
  float mast = sdBox(p, vec2(0.05, -0.0), vec2(0.004, 0.07));
  print = mix(print, vec3(0.12), cover(min(hull, mast), aa));
  Mat o = mat(mix(wood(p.yx, vec3(0.2, 0.13, 0.08)), print, cover(inner, aa)));
  // The frame's shadow on the wall, down and to the right.
  float shadow = sdBox(p, vec2(0.012, -0.018), vec2(0.3, 0.22));
  m.amb *= 1.0 - 0.45 * cover(shadow, 0.02);
  m.win *= 1.0 - 0.6 * cover(shadow, 0.01);
  o.amb = m.amb;
  o.win = m.win;
  over(m, o, cover(outer, aa));
}

/** The door, its frame and its frosted glass panel, on the left wall. q = (z, y). */
void door(inout Mat m, vec2 q, float aa) {
  float casing = sdBox(q, vec2(DOOR.x, 0.5 * (FLOOR + DOOR.z + 0.06)), vec2(DOOR.y + 0.06, 0.5 * (DOOR.z + 0.06 - FLOOR)));
  if (casing > aa) return;
  Mat c = mat(wood(q.yx, vec3(0.36, 0.25, 0.16)) * (0.8 + 0.4 * smoothstep(0.0, 0.03, -casing)));
  c.amb = m.amb * 1.2;
  c.lamp = m.lamp;
  over(m, c, cover(casing, aa));
  // The corridor's light leaks round the door's edges.
  float gap = sdBox(q, vec2(DOOR.x, 0.5 * (FLOOR + DOOR.z)), vec2(DOOR.y + 0.008, 0.5 * (DOOR.z - FLOOR) + 0.008));
  m.door = max(m.door, 0.5 * cover(gap, aa));
  float slab = sdBox(q, vec2(DOOR.x, 0.5 * (FLOOR + DOOR.z)), vec2(DOOR.y, 0.5 * (DOOR.z - FLOOR)));
  vec3 dark = wood(q.yx, vec3(0.22, 0.14, 0.09));
  // A sunk panel below the glass.
  float low = sdBox(q, vec2(DOOR.x, -0.82), vec2(DOOR.y - 0.14, 0.5));
  dark *= 1.0 - 0.3 * smoothstep(aa, 0.0, abs(low) - 0.008);
  Mat s = mat(dark);
  s.amb = m.amb * 1.15;
  s.lamp = m.lamp;
  over(m, s, cover(slab, aa));
  float knob = length(q - vec2(DOOR.x - DOOR.y + 0.09, -0.42)) - 0.032;
  Mat k = mat(vec3(0.62, 0.48, 0.24));
  k.amb = m.amb * 1.4;
  k.lamp = m.lamp * 2.5;
  k.door = 0.06;
  over(m, k, cover(knob, aa));
  // The frosted glass, lit from the corridor; the lettering, painted outside, reads backwards here.
  float glass = sdBox(q, vec2(0.5 * (${f(PANEL_Z0)} + ${f(PANEL_Z1)}), 0.5 * (${f(PANEL_Y0)} + ${f(PANEL_Y1)})),
    vec2(0.5 * (${f(PANEL_Z1)} - ${f(PANEL_Z0)}), 0.5 * (${f(PANEL_Y1)} - ${f(PANEL_Y0)})));
  if (glass < aa) {
    vec2 fr = texture(uFrost, q * 1.3).rg - 0.5;
    vec2 uv = vec2((${f(PANEL_Z1)} - q.x) / ${f(PANEL_Z1 - PANEL_Z0)}, (${f(PANEL_Y1)} - q.y) / ${f(PANEL_Y1 - PANEL_Y0)});
    float paint = texture(uLetters, uv).a;
    // The corridor lamp behind the glass: brightest a little above the middle.
    float glow = 0.8 + 0.2 * smoothstep(0.75, 0.0, length((uv - vec2(0.5, 0.4)) * vec2(1.0, 1.3)));
    // A thin dark bead holds the glass in.
    float bead = smoothstep(0.0, 0.012, -glass);
    Mat g = mat(vec3(0.82, 0.83, 0.8) * (1.0 + 0.25 * fr.y + 0.1 * fr.x) * (0.35 + 0.65 * bead));
    g.amb = 0.3;
    g.door = glow * (1.0 + 0.3 * fr.y) * (1.0 - 0.94 * paint) * (0.2 + 0.8 * bead);
    over(m, g, cover(glass, aa));
  }
}

/**
 * The window on the right wall: its frame, a sill, and the blinds in front of
 * the glass, slats half closed on two ladder tapes. q = (z, y).
 */
void window(inout Mat m, vec2 q, float aa) {
  float frame = sdBox(q, vec2(0.5 * (WIN.x + WIN.y), 0.5 * (WIN.z + WIN.w)),
    vec2(0.5 * (WIN.y - WIN.x) + WIN_FRAME, 0.5 * (WIN.w - WIN.z) + WIN_FRAME));
  float sill = sdBox(q, vec2(0.5 * (WIN.x + WIN.y), WIN.z - WIN_FRAME - 0.02), vec2(0.5 * (WIN.y - WIN.x) + 0.14, 0.025));
  if (min(frame, sill) > aa) return;
  Mat w = mat(wood(q.yx, vec3(0.28, 0.19, 0.12)));
  w.amb = m.amb;
  w.lamp = m.lamp;
  // The frame's inner edges catch a little of the light from outside.
  float edge = -frame;
  w.win = 0.12 * (1.0 - smoothstep(0.0, WIN_FRAME, edge));
  over(m, w, cover(min(frame, sill), aa));
  float inside = inBox(q, vec2(WIN.x, WIN.z), vec2(WIN.y, WIN.w), 0.5 * aa);
  if (inside <= 0.0) return;
  float n = (q.y - WIN.z) / SLAT_PITCH;
  float gap = slatGap(n, 1.5 * aa / SLAT_PITCH, SLAT_HALF_GAP);
  // The slat edge just below each gap catches the light coming through.
  float e = (0.5 - SLAT_HALF_GAP - fract(n)) * SLAT_PITCH;
  float lip = 1.0 - smoothstep(0.002, 0.016, e);
  float tapeZ = min(abs(q.x - (WIN.x + 0.3)), abs(q.x - (WIN.y - 0.3)));
  float tape = 1.0 - smoothstep(0.009, 0.009 + aa, tapeZ);
  Mat s = mat(vec3(0.34, 0.33, 0.3) * (0.8 + 0.2 * fract(n)));
  s.amb = 0.3;
  s.win = 0.04 + 0.5 * lip;
  s.glass = gap * (1.0 - tape);
  over(m, s, inside);
}

/** The filing cabinet against the back wall, left: its front, side and top. P on it, N its face. */
Mat cabinet(vec3 P, vec3 N, float aa) {
  Mat m = mat(vec3(0.33, 0.35, 0.3));
  if (N.z < -0.5) {
    // Four drawers, each with a handle and a label holder.
    float y = (P.y - ${f(-1.45)}) / ${f(-0.12 + 1.45)} * 4.0;
    float k = fract(y);
    float seam = smoothstep(aa * 4.0, 0.0, min(k, 1.0 - k) * ${f((-0.12 + 1.45) / 4)});
    m.alb *= 1.0 - 0.6 * seam;
    vec2 q = vec2(P.x - (-1.985), (k - 0.62) * ${f((-0.12 + 1.45) / 4)});
    float handle = sdBox(q, vec2(0.0, -0.03), vec2(0.07, 0.012));
    float label = sdBox(q, vec2(0.0, 0.05), vec2(0.05, 0.022));
    m.alb = mix(m.alb, vec3(0.7, 0.68, 0.6), cover(label, aa));
    m.alb = mix(m.alb, vec3(0.55, 0.55, 0.52), cover(handle, aa));
  } else if (N.y > 0.5) {
    m.alb *= 1.15;
  } else {
    m.alb *= 0.8;
  }
  return m;
}

/** Ray against the cabinet's box: its depth (or -1) and its face's normal. */
float cabinetHit(vec3 r, out vec3 N) {
  vec3 lo = vec3(-2.25, FLOOR, 3.38);
  vec3 hi = vec3(-1.72, -0.12, DEPTH);
  vec3 inv = 1.0 / r;
  vec3 a = lo * inv;
  vec3 b = hi * inv;
  vec3 tn = min(a, b);
  vec3 tf = max(a, b);
  float t0 = max(max(tn.x, tn.y), tn.z);
  float t1 = min(min(tf.x, tf.y), tf.z);
  N = vec3(0.0);
  if (t1 < t0 || t0 <= 0.0) return -1.0;
  if (t0 == tn.z) N = vec3(0.0, 0.0, -1.0);
  else if (t0 == tn.x) N = vec3(1.0, 0.0, 0.0);
  else N = vec3(0.0, 1.0, 0.0);
  return t0;
}

/** The hat stand by the back wall, left, a fedora on top and a trench coat on a hook. q = (x, y) in its plane. */
void hatStand(inout Mat m, vec2 q, float aa, vec3 P) {
  const float X = -1.58;
  float pole = sdBox(q, vec2(X, -0.5), vec2(0.016, 0.95));
  float hooks = min(sdSeg(q, vec2(X, 0.33), vec2(X - 0.1, 0.4)), sdSeg(q, vec2(X, 0.33), vec2(X + 0.1, 0.4))) - 0.008;
  float crown = sdRBox(q, vec2(X + 0.02, 0.5), vec2(0.1, 0.06), 0.035);
  crown = max(crown, -sdEll(q, vec2(X + 0.02, 0.575), vec2(0.045, 0.025)));
  float brim = sdEll(q, vec2(X + 0.02, 0.44), vec2(0.18, 0.022));
  float hat = min(crown, brim);
  float band = sdBox(q, vec2(X + 0.02, 0.465), vec2(0.1, 0.012));
  // The coat: narrow at the hook, falling wide, belt and a lapel line.
  float tq = clamp((0.36 - q.y) / 1.1, 0.0, 1.0);
  float halfW = mix(0.07, 0.25, sqrt(tq));
  float coat = max(abs(q.x - (X - 0.1) - 0.02 * tq) - halfW, max(q.y - 0.37, -0.74 - q.y));
  coat = min(coat, length(q - vec2(X - 0.1, 0.3)) - 0.075);
  float fold = abs(q.x - (X - 0.1) - 0.03 - 0.05 * tq);
  float any = min(min(pole, hooks), min(hat, coat));
  if (any > aa) return;
  float lamp = lampAt(P, vec3(0.0, 0.0, -1.0));
  Mat w = mat(vec3(0.22, 0.15, 0.1));
  w.lamp = lamp;
  w.amb = 0.85;
  over(m, w, cover(min(pole, hooks), aa));
  Mat c = mat(vec3(0.42, 0.37, 0.28) * (0.8 + 0.25 * smoothstep(0.0, 0.03, fold) - 0.15 * tq));
  c.alb *= 1.0 - 0.35 * cover(abs(q.y + 0.18) - 0.02, aa);
  c.lamp = lamp;
  c.amb = 0.85;
  over(m, c, cover(coat, aa));
  Mat h = mat(vec3(0.2, 0.2, 0.22));
  h.alb *= 1.0 - 0.6 * cover(band, aa);
  h.lamp = lamp;
  h.amb = 0.85;
  over(m, h, cover(hat, aa));
}

/** The banker's lamp at the left of the desk: green glass shade, brass stem, glowing underside. q in its plane (m). */
void lamp(inout Mat m, vec2 q, float aa) {
  vec2 c = LAMP_P.xy;
  float base = min(sdRBox(q, vec2(c.x, DESK_Y + 0.016), vec2(0.075, 0.016), 0.012),
    sdEll(q, vec2(c.x, DESK_Y + 0.032), vec2(0.035, 0.014)));
  float stem = sdBox(q, vec2(c.x, 0.5 * (DESK_Y + c.y)), vec2(0.007, 0.5 * (c.y - DESK_Y)));
  float shade = max(sdEll(q, c, vec2(0.13, 0.068)), c.y - q.y);
  float rim = sdRBox(q, c + vec2(0.0, 0.004), vec2(0.133, 0.006), 0.004);
  float chain = min(sdBox(q, c + vec2(0.07, -0.03), vec2(0.0018, 0.03)), length(q - c - vec2(0.07, -0.062)) - 0.006);
  float any = min(min(base, stem), min(min(shade, rim), chain));
  if (any > aa) return;
  Mat brass = mat(vec3(0.6, 0.45, 0.2) * (0.8 + 0.4 * smoothstep(0.03, 0.0, abs(q.x - c.x + 0.02))));
  brass.lamp = 0.35;
  over(m, brass, cover(min(min(base, stem), chain), aa));
  // The shade's green glass, lit through from the bulb inside, brightest low in its middle.
  float y = clamp((q.y - c.y) / 0.068, 0.0, 1.0);
  float x = (q.x - c.x) / 0.13;
  Mat g = mat(vec3(0.1, 0.4, 0.2) * (0.6 + 0.7 * (1.0 - x * x)) * (1.15 - 0.6 * y));
  g.lamp = 0.5;
  g.amb = 0.5;
  over(m, g, cover(shade, aa));
  Mat r = mat(vec3(0.7, 0.55, 0.28));
  r.lamp = 1.2;
  over(m, r, cover(rim, aa));
  // The bulb's glare under the rim.
  float bulb = sdEll(q, c - vec2(0.0, 0.006), vec2(0.1, 0.007));
  Mat b = mat(vec3(1.0, 0.95, 0.85));
  b.lamp = ${f(LAMP_RANGE)};
  over(m, b, cover(bulb, aa * 2.0));
}

/** The stack of case folders behind the lamp. q in its plane (m). */
void folders(inout Mat m, vec2 q, float aa, float lampK) {
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 c = vec2(-1.14 + 0.012 * sin(fi * 2.3), -0.538 + 0.016 * fi);
    float a = 0.03 * sin(fi * 1.7 + 0.4);
    vec2 p = mat2(cos(a), sin(a), -sin(a), cos(a)) * (q - c);
    float slab = sdBox(p, vec2(0.0), vec2(0.2, 0.0075));
    float tab = sdBox(p, vec2(0.1 - 0.06 * fi, 0.009), vec2(0.035, 0.005));
    float papers = sdBox(p, vec2(0.01, 0.0), vec2(0.19, 0.003));
    Mat o = mat(mix(vec3(0.72, 0.6, 0.38), vec3(0.62, 0.52, 0.34), fract(fi * 0.5)));
    o.alb = mix(o.alb, vec3(0.85, 0.83, 0.78), cover(papers, aa));
    o.lamp = lampK;
    over(m, o, cover(min(slab, tab), aa));
  }
}

/** The rotary telephone at the right of the desk. q in its plane (m). */
void phone(inout Mat m, vec2 q, float aa, float lampK) {
  vec2 c = vec2(0.95, -0.55);
  float body = max(sdEll(q, c + vec2(0.0, 0.0), vec2(0.12, 0.1)), c.y - q.y);
  body = min(body, sdRBox(q, c + vec2(0.0, 0.012), vec2(0.125, 0.014), 0.01));
  float cradle = sdBox(q, c + vec2(0.0, 0.1), vec2(0.06, 0.012));
  float handset = min(sdRBox(q, c + vec2(0.0, 0.125), vec2(0.15, 0.014), 0.012),
    min(sdEll(q, c + vec2(-0.13, 0.125), vec2(0.045, 0.028)), sdEll(q, c + vec2(0.13, 0.125), vec2(0.045, 0.028))));
  float dial = length((q - c - vec2(0.0, 0.045)) / vec2(1.0, 0.7)) - 0.05;
  float any = min(min(body, cradle), min(handset, dial));
  if (any > aa) return;
  Mat b = mat(vec3(0.06, 0.06, 0.065));
  // Bakelite's gloss: a highlight across the top of the body and handset.
  float gloss = smoothstep(0.04, 0.0, abs(q.y - (c.y + 0.07)) - 0.004) * smoothstep(0.1, 0.0, abs(q.x - c.x + 0.03));
  b.alb += gloss * 0.25;
  b.lamp = lampK;
  over(m, b, cover(min(min(body, cradle), handset), aa));
  vec2 dq = (q - c - vec2(0.0, 0.045)) / vec2(1.0, 0.7);
  float ring = length(dq);
  float ang = atan(dq.y, dq.x);
  float holes = abs(fract(ang / 6.2832 * 12.0) - 0.5) * 0.4 - 0.065;
  holes = max(holes, abs(ring - 0.034) - 0.009);
  vec3 face = mix(vec3(0.75, 0.72, 0.65), vec3(0.08), cover(holes, aa));
  face = mix(face, vec3(0.9, 0.88, 0.8), cover(ring - 0.014, aa));
  Mat d = mat(face);
  d.lamp = lampK;
  over(m, d, cover(dial, aa));
}

/** The coffee cup on its saucer. q in its plane (m). */
void cup(inout Mat m, vec2 q, float aa, float lampK) {
  vec2 c = vec2(${f(CUP_X)}, ${f(CUP_TOP)});
  float saucer = sdEll(q, vec2(c.x, -0.545), vec2(0.085, 0.013));
  float body = max(sdRBox(q, vec2(c.x, -0.505), vec2(${f(CUP_R)}, 0.035), 0.018), q.y - c.y);
  float handle = abs(length((q - vec2(c.x + 0.05, -0.5)) / vec2(0.8, 1.0)) - 0.016) - 0.005;
  float rim = sdEll(q, c, vec2(${f(CUP_R)}, 0.009));
  float coffee = sdEll(q, c - vec2(0.0, 0.001), vec2(${f(CUP_R - 0.005)}, 0.006));
  float any = min(min(saucer, body), min(handle, rim));
  if (any > aa) return;
  float x = (q.x - c.x) / ${f(CUP_R)};
  Mat w = mat(vec3(0.86, 0.85, 0.8) * (0.75 + 0.3 * (1.0 - x * x)));
  w.lamp = lampK;
  over(m, w, cover(min(min(saucer, body), handle), aa));
  over(m, w, cover(rim, aa));
  Mat k = mat(vec3(0.1, 0.06, 0.04));
  k.lamp = lampK;
  over(m, k, cover(coffee, aa));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 d = (frag - 0.5 * uRes) / uUnit;
  vec3 r = vec3(d / FOCAL, 1.0);
  if (r.x == 0.0) r.x = 1e-7;
  // Metres per device px at depth 1.
  float px = 1.0 / (uUnit * FOCAL);
  vec3 N;
  int id;
  float t = roomHit(r, N, id);
  vec3 cn;
  float tc = cabinetHit(r, cn);
  bool isCabinet = tc > 0.0 && tc < t;
  if (isCabinet) {
    t = tc;
    N = cn;
  }
  vec3 P = r * t;
  // A pixel's footprint on the surface, widened where it is seen edge on.
  float aa = px * t / max(abs(dot(N, normalize(r))), 0.15);
  Mat m;
  if (isCabinet) {
    m = cabinet(P, N, aa);
  } else if (id == 3) {
    m = mat(vec3(0.5, 0.49, 0.46) * (0.9 + 0.15 * vnoise(P.xz * 2.5, 11.0)));
    // The cornice along the walls.
    float edge = min(min(HALF_W - abs(P.x), DEPTH - P.z), 9.0);
    m.alb *= 0.85 + 0.25 * smoothstep(0.02, 0.05, edge) - 0.15 * smoothstep(0.05, 0.12, edge) * (1.0 - smoothstep(0.12, 0.2, edge));
  } else if (id == 4) {
    m = mat(wood(P.xz, vec3(0.16, 0.1, 0.07)));
  } else if (id == 5) {
    vec3 c = wood(vec2(P.x, P.z), vec3(0.3, 0.17, 0.1));
    float blotter = sdBox(P.xz, vec2(0.0, 1.12), vec2(0.42, 0.2));
    c = mix(c, vec3(0.13, 0.2, 0.14) * (0.9 + 0.2 * vnoise(P.xz * 20.0, 13.0)), cover(blotter, aa));
    // The rounded far edge catches the light.
    c *= 1.0 + 0.5 * smoothstep(0.03, 0.0, DESK_Z - P.z);
    m = mat(c);
  } else {
    vec2 q = id == 0 ? P.xy : id == 1 ? vec2(P.z, P.y) : vec2(-P.z, P.y);
    m = mat(wall(q, aa));
  }
  m.amb = ambientAt(P, isCabinet ? 7 : id);
  m.lamp = lampAt(P, N);
  m.win = throughBlinds(P, N, aa);
  m.door = doorSpill(P, N);
  if (!isCabinet) {
    if (id == 0) picture(m, P.xy, aa);
    if (id == 1) door(m, P.zy, aa);
    if (id == 2) window(m, P.zy, aa);
  }

  // The hat stand, then what's on the desk, each a flat cut-out at its depth.
  const float HAT_Z = 3.6;
  if (HAT_Z < t) {
    vec3 H = r * HAT_Z;
    hatStand(m, H.xy, px * HAT_Z, H);
  }
  vec3 F = r * 1.32;
  float lampF = lampAt(F, normalize(vec3(0.0, 0.4, -1.0)));
  folders(m, F.xy, px * 1.32, lampF);
  vec3 L = r * LAMP_P.z;
  lamp(m, L.xy, px * LAMP_P.z);
  vec3 T = r * 1.12;
  phone(m, T.xy, px * 1.12, lampAt(T, normalize(vec3(-0.4, 0.3, -1.0))));
  vec3 C = r * ${f(CUP_Z)};
  cup(m, C.xy, px * ${f(CUP_Z)}, lampAt(C, normalize(vec3(-0.5, 0.3, -1.0))));

  if (uPass == 0) {
    outColor = vec4(m.alb, m.glass);
  } else {
    outColor = vec4(m.lamp / ${f(LAMP_RANGE)}, m.win, m.door, m.amb);
  }
}
`;

/**
 * The view through the window, drawn once into a small target over the
 * glass (u across it, v up): a wet night sky over the dark blocks across the
 * street, their lit windows and the street lamps below, all out of focus.
 */
const VIEW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uSize;
out vec4 outColor;
${VALUE_NOISE_GLSL}
void main() {
  vec2 g = gl_FragCoord.xy / uSize;
  vec3 c = mix(vec3(0.1, 0.1, 0.115), vec3(0.03, 0.032, 0.04), smoothstep(0.1, 1.0, g.y));
  c += 0.025 * (vnoise(g * vec2(3.0, 5.0), 2.0) - 0.5);
  // Blocks across the street, their rooflines soft with distance and rain.
  float x = g.x * 4.0 + 0.3;
  float k = floor(x);
  float roof = 0.55 + 0.32 * hash2(vec2(k, 1.0), 3.0);
  float edge = abs(fract(x) - 0.5) * 2.0;
  roof -= 0.06 * smoothstep(0.85, 1.0, edge);
  float block = smoothstep(roof + 0.02, roof - 0.02, g.y);
  vec3 b = vec3(0.022, 0.023, 0.028) * (0.8 + 0.4 * hash2(vec2(k, 2.0), 3.0));
  vec2 wc = vec2(g.x * 26.0, g.y * 30.0);
  vec2 cell = floor(wc);
  vec2 fr = fract(wc) - 0.5;
  float lit = step(0.7, hash2(cell, 7.0)) * step(g.y, roof - 0.04);
  b += lit * exp(-dot(fr, fr) * 7.0) * (0.3 + 0.5 * hash2(cell, 9.0)) * vec3(0.62, 0.52, 0.36);
  c = mix(c, b, block);
  // Street lamps far below, and the wet street's glow.
  for (int i = 0; i < 3; i++) {
    vec2 p = vec2(0.18 + 0.33 * float(i), 0.04);
    vec2 q = (g - p) * vec2(1.0, 1.6);
    c += vec3(0.55, 0.5, 0.4) * 0.35 * exp(-dot(q, q) * 90.0);
  }
  c += vec3(0.05, 0.05, 0.05) * smoothstep(0.3, 0.0, g.y);
  outColor = vec4(c, 1.0);
}
`;

/**
 * Every frame, at full size: the cached room relit by the sign through the
 * blinds (with the fan's shadow), the lamp, the corridor and the night; the
 * window's glass showing the city through the rain; the fan itself; then the
 * film: tone, vignette and grain, with a slight gate weave.
 */
const FRAME_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uAlbedo;
uniform sampler2D uLight;
uniform sampler2D uView;
uniform sampler2D uDrops;
uniform vec2 uRes;
uniform float uUnit;
/** The gate weave, device px. */
uniform vec2 uWeave;
uniform vec3 uAmb;
uniform vec3 uLamp;
uniform vec3 uWin;
uniform vec3 uDoor;
/** The sign's glow over the view, low down. */
uniform vec3 uGlow;
/** The blades' angle: cosine, sine. */
uniform vec2 uFan;
/** 1 while there are drops on the glass. */
uniform float uRainOn;
/** Decoded drop offset to view uv. */
uniform vec2 uOffsetScale;
/** Colour kept (0: black and white), then the print's tint. */
uniform vec4 uTone;
/** Grain depth. */
uniform float uGrain;
uniform uint uGrainSeed;
out vec4 outColor;
${HASH32_GLSL}
${EASED_GRAIN_GLSL}
${ROOM_GLSL}
${DROP_DIR_GLSL}
${DITHER_GLSL}

void main() {
  vec2 frag = gl_FragCoord.xy + uWeave;
  vec2 uv = frag / uRes;
  vec4 a = texture(uAlbedo, uv);
  vec4 l = texture(uLight, uv);
  vec2 d = (frag - 0.5 * uRes) / uUnit;
  vec3 r = vec3(d / FOCAL, 1.0);
  float shade = 1.0;
  if (l.g > 0.002 && r.y > 0.0) {
    vec3 N;
    int id;
    vec3 P = r * roomHit(r, N, id);
    if (P.y > FAN.y) {
      // The fan's shadow: trace the light back to the blades' plane.
      float s = (P.y - FAN.y) / FAN_LIGHT.y;
      vec3 Q = P - FAN_LIGHT * s;
      shade = 1.0 - 0.9 * fanBlades(Q.xz - FAN.xz, uFan, 0.006 + 0.01 * s);
    }
  }
  vec3 col = a.rgb * (uAmb * l.a + uLamp * l.r + uWin * (l.g * shade) + uDoor * l.b);
  if (a.a > 0.003) {
    float t = HALF_W / max(r.x, 1e-4);
    vec3 P = r * t;
    vec2 g = vec2((WIN.y - P.z) / (WIN.y - WIN.x), (P.y - WIN.z) / (WIN.w - WIN.z));
    vec4 dm = uRainOn > 0.5 ? texture(uDrops, g) : vec4(${f(ENC_MID)}, ${f(ENC_MID)}, 0.0, 0.0);
    vec2 dir = dropDir(dm);
    float cov = dm.a;
    vec2 gv = g + dir * uOffsetScale;
    vec3 v = texture(uView, gv).rgb * 1.3 + uGlow * smoothstep(0.85, 0.0, gv.y);
    v *= 1.0 + 0.12 * cov;
    float rim = cov * (1.0 - smoothstep(0.0, 0.45, dm.z));
    float spec = pow(max(dm.z * 0.8 + dot(dir, vec2(0.35, -0.3)) * 0.3, 0.0), 30.0) * cov;
    v = v * (1.0 - 0.4 * rim) + spec * (0.06 + 0.3 * uWin);
    col = mix(col, v, a.a);
  }
  if (r.y > 0.0) {
    // The fan, seen from below: its blades in their plane, the motor and the rod up to the ceiling.
    float tf = FAN.y / r.y;
    vec3 Q = r * tf;
    vec2 q = Q.xz - FAN.xz;
    vec3 fanCol = vec3(0.05, 0.045, 0.04) * (uAmb * 3.0 + uLamp * 0.01 + uWin * 0.15);
    if (dot(q, q) < (FAN_R + 0.05) * (FAN_R + 0.05)) {
      float s = 0.7 * tf * max(1.0, tf / FAN.y) / (FOCAL * uUnit);
      col = mix(col, fanCol, fanBlades(q, uFan, s));
    }
    vec3 R = r * FAN.z;
    float px = FAN.z / (FOCAL * uUnit);
    float rod = max(abs(R.x - FAN.x) - 0.012, max(FAN.y - R.y, R.y - CEILING));
    float motor = length((R.xy - FAN.xy + vec2(0.0, 0.035)) / vec2(1.0, 0.55)) - 0.085;
    col = mix(col, fanCol * 1.4, clamp(0.5 - min(rod, motor) / px, 0.0, 1.0));
  }

  // The film: tone, a soft shoulder, vignette and grain.
  float y = dot(col, ${LUMA});
  col = mix(vec3(y), col, uTone.x) * uTone.yzw;
  col = col / (1.0 + 0.3 * col) * 1.4;
  vec2 c = (gl_FragCoord.xy / uRes - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  col *= 1.0 - 0.42 * smoothstep(0.3, 1.05, length(c));
  uvec2 cell = uvec2(gl_FragCoord.xy / max(uUnit * 1.5, 1.0));
  col += uGrain * grainAt(cell, uGrainSeed) * (0.4 + 0.6 * sqrt(clamp(y, 0.0, 1.0)));
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * The cup's steam over the frame, in its box, premultiplied: density to
 * opacity with a lit edge (as Steaming Mug draws it), toned and vignetted on
 * the CPU.
 */
const STEAM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uField;
uniform vec2 uRes;
uniform float uUnit;
uniform vec2 uWeave;
/** Steam box: x0, y0 (design px from the centre, y up), 1 / width, 1 / height. */
uniform vec4 uBox;
uniform vec2 uLitStep;
uniform vec3 uLight;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 p = (gl_FragCoord.xy + uWeave - 0.5 * uRes) / uUnit;
  vec2 uv = (p - uBox.xy) * uBox.zw;
  float d = texture(uField, uv).r;
  float toLight = texture(uField, uv + uLitStep).r;
  float fade = smoothstep(0.02, 0.1, uv.y) * (1.0 - smoothstep(0.4, 1.0, uv.y))
    * smoothstep(0.0, 0.15, uv.x) * smoothstep(0.0, 0.15, 1.0 - uv.x);
  float alpha = (1.0 - exp(-${f(STEAM_OPACITY)} * d)) * fade * 0.8;
  float lit = clamp((d - toLight) * ${f(LIT_GAIN)}, 0.0, 1.0);
  vec3 c = uLight * (0.55 + 0.45 * lit);
  outColor = vec4((c + dither8(gl_FragCoord.xy)) * alpha, alpha);
}
`;

/**
 * 1940s Detective Office. The room (walls, window, door, furniture, the desk
 * and what's on it) is one ray-cast pass cached on resize into an albedo map
 * and a light map, the door's lettering painted on a canvas. Per frame:
 * the rain's drop map over the window's glass (Rain on a Window's
 * simulation, sized to the pane), the steam's density field (Steaming Mug's
 * settings for the shared smoke model), one full-size pass that relights the
 * room with the blinking sign, the fan's turning shadow, the lamp and the
 * corridor, draws the glass and the fan and applies the film look, then the
 * steam in its box.
 */
export const detective = defineEffect(detectiveMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);
      const triangle = scope.own(createFullscreenTriangle(gl));

      const cacheProgram = program(CACHE_FRAGMENT);
      const cu = createUniforms(gl, cacheProgram, ["uRes", "uUnit", "uPass", "uFrost", "uLetters"]);
      const viewProgram = program(VIEW_FRAGMENT);
      const vu = createUniforms(gl, viewProgram, ["uSize"]);
      const frameProgram = program(FRAME_FRAGMENT);
      const fu = createUniforms(gl, frameProgram, [
        "uAlbedo",
        "uLight",
        "uView",
        "uDrops",
        "uRes",
        "uUnit",
        "uWeave",
        "uAmb",
        "uLamp",
        "uWin",
        "uDoor",
        "uGlow",
        "uFan",
        "uRainOn",
        "uOffsetScale",
        "uTone",
        "uGrain",
        "uGrainSeed",
      ]);
      const steamProgram = program(STEAM_FRAGMENT);
      const su = createUniforms(gl, steamProgram, [
        "uField",
        "uRes",
        "uUnit",
        "uWeave",
        "uBox",
        "uLitStep",
        "uLight",
      ]);
      const dropProgram = scopedProgram(gl, scope, DROP_VERTEX, DROP_FRAGMENT);
      const du = createUniforms(gl, dropProgram, ["uResolution", "uInvScale", "uGrow", "uMargin"]);
      gl.useProgram(cacheProgram);
      cu.i1("uFrost", 0);
      cu.i1("uLetters", 1);
      gl.useProgram(frameProgram);
      fu.i1("uAlbedo", 0);
      fu.i1("uLight", 1);
      fu.i1("uView", 2);
      fu.i1("uDrops", 3);
      gl.useProgram(steamProgram);
      su.i1("uField", 0);
      gl.useProgram(dropProgram);
      du.f1("uGrow", 1);
      du.f1("uInvScale", 1);
      gl.useProgram(null);

      const frost = scope.add(
        createDataTexture(gl, {
          width: GRAIN_SIZE,
          height: GRAIN_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildGrainTexture(),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const letters = createCanvasTexture(gl, scope, { premultiply: true });

      // The rain on the pane, in sim px over the glass.
      const rainW = GLASS_W * RAIN_PX_PER_M;
      const rainH = GLASS_H * RAIN_PX_PER_M;
      const sim = createRainSim(rainW, rainH, createRng(0x64657465), RAIN_CONFIG);
      const rainParams: RainSimParams = { rain: 0, speed: 1 };
      const drops = scope.own(
        createSpriteBatch(
          gl,
          instanceCapacity(RAIN_CONFIG),
          [4, 1],
          [polygonStrip(8, Math.PI / 8)],
        ),
      );
      let dropCount = 0;

      // The cup's steam.
      const field = createSmokeField(gl, scope, "detective");
      const adv = field.uniforms;
      const phases = new Float32Array(WAVE_COUNT);
      const flow: Flow = steamFlow({ rise: 0, draft: 0, curl: 0, onset0: 0, onset1: 1 });
      const emitter: SteamEmitter = steamEmitter(STEAM_AMOUNT, { strength: 0, life: 1, wisp: 0 });
      const clock: StepClock = { acc: 0 };
      const steamW = STEAM_BOX[2] - STEAM_BOX[0];
      const steamH = STEAM_BOX[3] - STEAM_BOX[1];
      const cupAt = project(CUP_X, CUP_TOP, CUP_Z, new Float64Array(2));
      const cupR = (CUP_R * FOCAL) / CUP_Z;

      let albedo: RenderTarget | null = null;
      let light: RenderTarget | null = null;
      let view: RenderTarget | null = null;
      let dropMap: RenderTarget | null = null;
      const disposeTargets = () => {
        albedo?.dispose();
        light?.dispose();
        dropMap?.dispose();
        albedo = light = dropMap = null;
      };
      scope.defer(() => {
        disposeTargets();
        view?.dispose();
      });
      const makeTarget = (w: number, h: number): RenderTarget => {
        const t = createRenderTarget(gl, w, h, gl.RGBA8);
        // RGBA8 is always colour-renderable in WebGL2.
        if (!t) {
          throw new Error("1940s Detective Office: render target is not renderable");
        }
        return t;
      };

      const doorDef = detectiveMeta.params.door;
      const doorKey = createChangeKey(1);
      const sizes: number[] = [];
      const paintDoor = (text: string) => {
        const lines = doorLines(sanitizeText(doorDef, text));
        const font = (size: number) => `700 ${String(size)}px ${SERIF_FONT_STACK}`;
        const canvas = paintCanvas(DOOR_CANVAS_W, DOOR_CANVAS_H, (ctx) => {
          fitDoorText(
            lines,
            (line, size) => {
              ctx.font = font(size);
              // Stand-in canvases (in tests) may measure nothing.
              return (ctx.measureText(line) as TextMetrics | undefined)?.width ?? 0;
            },
            sizes,
          );
          let total = 0;
          for (const s of sizes) {
            total += s * DOOR_LINE_HEIGHT;
          }
          let y = (DOOR_CANVAS_H - total) / 2;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#000";
          for (let i = 0; i < lines.length; i++) {
            const h = sizes[i] * DOOR_LINE_HEIGHT;
            ctx.font = font(sizes[i]);
            ctx.fillText(lines[i], DOOR_CANVAS_W / 2, y + h / 2);
            y += h;
          }
        });
        letters.upload(canvas);
      };

      const sign = createSign(5);
      const fan = createFan();
      const tone = createColorEase(TONE_FLOATS);
      const weave = new Float64Array(2);
      const win: Rgb = [0, 0, 0];
      const glow: Rgb = [0, 0, 0];

      let width = 1;
      let height = 1;
      let scale = 1;
      let unit = 1;
      let cacheStale = true;
      let viewDrawn = false;
      // CPU-only time, kept unwrapped in float64.
      let time = 0;

      const drawCache = () => {
        if (!albedo || !light) {
          return;
        }
        gl.useProgram(cacheProgram);
        cu.f2("uRes", width, height);
        cu.f1("uUnit", unit);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, letters.texture);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, frost);
        albedo.bind();
        cu.i1("uPass", 0);
        triangle.draw();
        light.bind();
        cu.i1("uPass", 1);
        triangle.draw();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          unit = scale * fitScale(width / height);
          disposeTargets();
          albedo = makeTarget(width, height);
          light = makeTarget(width, height);
          const q = clamp(0.9 * unit, 0.25, 1);
          dropMap = makeTarget(
            Math.max(1, Math.round(rainW * q)),
            Math.max(1, Math.round(rainH * q)),
          );
          cacheStale = true;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!albedo || !light || !dropMap) {
            return;
          }

          // The door's lettering, repainted only when edited, and the cache.
          doorKey.setString(0, p.door);
          if (doorKey.take()) {
            paintDoor(p.door);
            cacheStale = true;
          }
          if (!viewDrawn) {
            view ??= makeTarget(VIEW_W, VIEW_H);
            view.bind();
            gl.useProgram(viewProgram);
            vu.f2("uSize", VIEW_W, VIEW_H);
            triangle.draw();
            viewDrawn = true;
          }
          if (cacheStale) {
            cacheStale = false;
            drawCache();
          }

          // The rain on the glass. With none wanted and no drops left, it all stops.
          if (p.rain > 0 || dropCount > 0) {
            rainParams.rain = p.rain;
            stepRainSim(sim, step, rainParams);
            dropCount = writeDropInstances(sim, drops.data, 1);
            if (dropCount > 0) {
              drops.upload(dropCount);
              dropMap.bind();
              gl.clearBufferfv(gl.COLOR, 0, DROP_CLEAR);
              gl.useProgram(dropProgram);
              du.f2("uResolution", rainW, rainH);
              du.f1("uMargin", rainW / dropMap.width);
              drops.draw(0, dropCount);
            }
          }

          // The steam's field, in fixed steps.
          gl.activeTexture(gl.TEXTURE0);
          const hasSteam = field.resize(
            Math.ceil(steamW / STEAM_CELL),
            Math.ceil(steamH / STEAM_CELL),
          );
          const n = simSteps(clock, step);
          if (hasSteam && n > 0) {
            gl.useProgram(field.program);
            wavePhases(time, phases);
            flow.draft = STEAM_SWAY * Math.sin((2 * Math.PI * time) / 37);
            const k = STEAM_UNITS;
            const region0 = STEAM_BOX[0] * k;
            const regionW = steamW * k;
            const radius = Math.max(STEAM_RADIUS, (0.9 * regionW) / field.width);
            adv.f4("uRegion", region0, STEAM_BOX[1] * k, regionW, steamH * k);
            adv.f4("uPhase", phases[0], phases[1], phases[2], phases[3]);
            adv.f3("uFlow", flow.rise, flow.draft, flow.curl);
            adv.f2("uOnset", flow.onset0, 1 / (flow.onset1 - flow.onset0));
            adv.f4("uEmit0", 0, 0, 0.6 * cupR * k, emitter.strength);
            adv.f4("uEmit1", 0, 0, 0, 0);
            adv.f1("uInvR2", 1 / (radius * radius));
            adv.f3("uWisp", WISP_K, wrap(time * WISP_SPEED, 0, Math.PI * 2), emitter.wisp);
            adv.f2("uDecay", 1 / emitter.life, STEAM_HEIGHT_DECAY);
            field.advance(n);
          }

          // The light: the sign through the blinds, and the tone.
          const level = stepSign(sign, step, p.sign);
          stepFan(fan, step, p.fan);
          const t = tone.step(lookup(TONES, p.tone, "mono"), step, TONE_EASE);
          for (let i = 0; i < 3; i++) {
            const signRgb = t[4 + i] * level;
            win[i] = STREET_RGB[i] * STREET_LIGHT + signRgb * SIGN_LIGHT;
            glow[i] = 0.04 + signRgb * 0.5;
          }
          gateWeave(time, weave);

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, dropMap.texture);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, view?.texture ?? null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, light.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, albedo.texture);
          gl.useProgram(frameProgram);
          fu.f2("uRes", width, height);
          fu.f1("uUnit", unit);
          fu.f2("uWeave", weave[0] * scale, weave[1] * scale);
          fu.f3("uAmb", AMBIENT[0], AMBIENT[1], AMBIENT[2]);
          fu.f3(
            "uLamp",
            LAMP_RGB[0] * LAMP_RANGE,
            LAMP_RGB[1] * LAMP_RANGE,
            LAMP_RGB[2] * LAMP_RANGE,
          );
          fu.v3("uWin", win);
          fu.f3("uDoor", DOOR_RGB[0], DOOR_RGB[1], DOOR_RGB[2]);
          fu.v3("uGlow", glow);
          const angle = fan.angle * 2 * Math.PI;
          fu.f2("uFan", Math.cos(angle), Math.sin(angle));
          fu.f1("uRainOn", dropCount > 0 ? 1 : 0);
          fu.f2(
            "uOffsetScale",
            (OFFSET_RANGE * REFRACTION) / rainW,
            (OFFSET_RANGE * REFRACTION) / rainH,
          );
          fu.f4("uTone", t[0], t[1], t[2], t[3]);
          fu.f1("uGrain", clamp(p.grain, 0, 1) * 0.1);
          fu.u1("uGrainSeed", Math.floor(time * GRAIN_HZ) >>> 0);
          triangle.draw();

          // The steam, over it in its box.
          const tex = field.texture;
          if (tex) {
            const x0 = cupAt[0] + STEAM_BOX[0];
            const y0 = cupAt[1] + STEAM_BOX[1];
            const sx = Math.max(0, Math.floor(width / 2 + x0 * unit - 2));
            const sy = Math.max(0, Math.floor(height / 2 + y0 * unit - 2));
            const ex = Math.min(width, Math.ceil(width / 2 + (x0 + steamW) * unit + 2));
            const ey = Math.min(height, Math.ceil(height / 2 + (y0 + steamH) * unit + 2));
            if (ex > sx && ey > sy) {
              gl.enable(gl.SCISSOR_TEST);
              gl.scissor(sx, sy, ex - sx, ey - sy);
              gl.enable(gl.BLEND);
              gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
              gl.useProgram(steamProgram);
              gl.bindTexture(gl.TEXTURE_2D, tex);
              su.f2("uRes", width, height);
              su.f1("uUnit", unit);
              su.f2("uWeave", weave[0] * scale, weave[1] * scale);
              su.f4("uBox", x0, y0, 1 / steamW, 1 / steamH);
              su.f2("uLitStep", (-0.6 * LIT_CELLS) / field.width, (0.8 * LIT_CELLS) / field.height);
              // Pale grey, toned like the frame and dimmed by the vignette at the cup.
              const v = 0.62;
              su.f3("uLight", 0.32 * v * t[1], 0.32 * v * t[2], 0.32 * v * t[3]);
              triangle.draw();
              gl.disable(gl.BLEND);
              gl.disable(gl.SCISSOR_TEST);
            }
          }
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
