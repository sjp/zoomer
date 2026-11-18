import { paintCanvas, SANS_FONT_STACK, createCanvasTexture } from "../canvas-texture";
import { createAircraft, generateCity, REF_HEIGHT, strobe } from "../city/city-sim";
import { COOL_RGB, createSkyline, type SkylineStyle, TV_RGB, WARM_RGB } from "../city/city-skyline";
import { createColorEase, type Rgb, unitRgbMemo } from "../color";
import { createCrossfadeSlots } from "../fade";
import {
  beginFrame,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  scopedProgram,
  withScope,
} from "../gl";
import { approach } from "../math";
import { HASH32_GLSL, VALUE_NOISE_GLSL } from "../noise";
import { sanitizeText } from "../params";
import { SDF2D_GLSL } from "../sdf-glsl";
import { createSpriteBatch } from "../sprites";
import { defineEffect } from "../types";
import {
  BACKDROP_CODE,
  backdropStyle,
  BAND_LIGHT_FLOATS,
  BAND_LIGHTS,
  bandLightLevel,
  BRIDGE_DECK,
  BRIDGE_SPACING,
  BRIDGE_X0,
  BRIDGE_X1,
  CITY_DENSITY,
  CITY_SEED,
  CITY_ZOOM,
  createApplause,
  createBandLights,
  CROSSFADE_SECONDS,
  DESK_CODE,
  DESK_RISE,
  DESK_RISE_FROM,
  DESK_RISE_TO,
  DESK_TOP_DEPTH,
  DESK_Y,
  fitTitle,
  FRAME_HW,
  FRAME_TOP,
  HORIZON,
  keyTint,
  SIGN_CENTRE,
  SIGN_HALF,
  stepApplause,
  type TalkLayout,
  talkLayout,
  TITLE_GLOW,
  TWINKLE_CYCLES,
  TWINKLE_DEPTH,
  TWINKLE_LOOP,
  WINDOW_RATE,
  APPLAUSE_PEAK,
} from "./talkshow-sim";
import { talkshowMeta } from "./talkshow.meta";

const g = glslFloat;

/** The painted skyline's picture: its rect in design units (x0, y0, x1, y1). */
const PIC_X0 = -FRAME_HW - 0.02;
const PIC_X1 = FRAME_HW + 0.02;
const PIC_Y0 = HORIZON - 0.01;
const PIC_Y1 = FRAME_TOP + 0.01;
/** The skyline's width in its reference px. */
const CITY_REF_WIDTH = Math.round(((PIC_X1 - PIC_X0) * REF_HEIGHT) / CITY_ZOOM);
/** The lit windows' layer and the band's lights render at 1/n of the frame's size. */
const LIGHTS_DIVISOR = 2;
const BOKEH_DIVISOR = 4;
/** The lit windows' layer redraws at most this often (Hz), and only while windows fade. */
const LIGHTS_RATE = 15;
/** Seconds the title takes to fade out when emptied, or back in. */
const TITLE_FADE = 0.6;
/** Seconds a title colour or desk change eases its letters over. */
const TITLE_EASE = 1;
const BRIDGE_LAMPS = Math.floor((BRIDGE_X1 - BRIDGE_X0) / BRIDGE_SPACING + 1e-6) + 1;

/** Each backdrop's sky, water and building colours. */
const NIGHT_BUILDING: Rgb = [0.07, 0.08, 0.15];
const NIGHT_HAZE: Rgb = [0.16, 0.18, 0.34];
const DUSK_BUILDING: Rgb = [0.2, 0.12, 0.2];
const DUSK_HAZE: Rgb = [0.75, 0.4, 0.42];
const NIGHT_WATER: Rgb = [0.025, 0.035, 0.08];
const DUSK_WATER: Rgb = [0.24, 0.13, 0.18];
const NIGHT_STEEL: Rgb = [0.13, 0.14, 0.23];
const DUSK_STEEL: Rgb = [0.3, 0.19, 0.27];
const UNLIT: Rgb = [0, 0, 0];
const BLACK: Rgb = [0, 0, 0];

const SHARED_GLSL = /* glsl */ `
${SDF2D_GLSL}
const float FRAME_HW = ${g(FRAME_HW)};
const float FRAME_TOP = ${g(FRAME_TOP)};
const float HORIZON = ${g(HORIZON)};
const float DESK_Y = ${g(DESK_Y)};
const float DESK_RISE = ${g(DESK_RISE)};
const float RISE_FROM = ${g(DESK_RISE_FROM)};
const float RISE_TO = ${g(DESK_RISE_TO)};
const float TOP_DEPTH = ${g(DESK_TOP_DEPTH)};
const float DECK = ${g(BRIDGE_DECK)};
const float LAMP_X0 = ${g(BRIDGE_X0)};
const float LAMP_SP = ${g(BRIDGE_SPACING)};
const float LAMP_N = ${g(BRIDGE_LAMPS)};
const vec3 LAMP = vec3(1.0, 0.78, 0.45);
float deskTopAt(float x) {
  return DESK_Y + DESK_RISE * smoothstep(RISE_FROM, RISE_TO, x);
}
/** Where the water at f reflects: mirrored about the horizon, stretched and wavering in painted ripples. */
vec2 mirrorAt(vec2 f) {
  float depth = HORIZON - f.y;
  return vec2(f.x + 0.0035 * sin(f.y * 240.0 + 3.0 * sin(f.x * 13.0)) * (0.4 + 6.0 * depth), HORIZON + depth * 1.15);
}
/** The bridge lamp nearest x, and its centre. */
float lampIndex(float x) {
  return clamp(floor((x - LAMP_X0) / LAMP_SP + 0.5), 0.0, LAMP_N - 1.0);
}
`;

/**
 * The painted sky behind the skyline, into the picture target: night's deep
 * blue with a moon and stars, or dusk's glow with streaks of cloud. Alpha 0,
 * so the buildings drawn over it (opaque) leave their coverage in alpha.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform vec4 uRect;
uniform int uKind;
out vec4 outColor;
${HASH32_GLSL}
${SHARED_GLSL}
float rand(vec2 cell, uint salt) {
  uvec2 u = uvec2(ivec2(cell) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ salt))) / 4294967296.0;
}
float streak(vec2 f, float y, float w, float k) {
  float d = (f.y - y - 0.02 * sin(f.x * 3.0 + k)) / w;
  return exp(-d * d) * (0.5 + 0.5 * sin(f.x * 5.0 + k * 2.0));
}
void main() {
  vec2 f = mix(uRect.xy, uRect.zw, gl_FragCoord.xy / uRes);
  px = (uRect.w - uRect.y) / uRes.y;
  float h = clamp((f.y - HORIZON) / (FRAME_TOP - HORIZON), 0.0, 1.0);
  vec3 c;
  if (uKind == 1) {
    c = mix(vec3(0.98, 0.55, 0.28), vec3(0.74, 0.34, 0.44), smoothstep(0.0, 0.35, h));
    c = mix(c, vec3(0.2, 0.15, 0.36), smoothstep(0.3, 1.0, h));
    vec2 d = (f - vec2(-0.2, HORIZON + 0.03)) * vec2(0.7, 1.4);
    c += vec3(1.0, 0.68, 0.32) * 0.45 * exp(-length(d) / 0.09);
    c = mix(c, vec3(1.0, 0.74, 0.58), 0.35 * streak(f, HORIZON + 0.2, 0.016, 1.0));
    c = mix(c, vec3(0.95, 0.6, 0.6), 0.3 * streak(f, HORIZON + 0.32, 0.012, 4.0));
  } else {
    c = mix(vec3(0.13, 0.15, 0.32), vec3(0.025, 0.035, 0.1), pow(h, 0.7));
    vec2 m = f - vec2(-0.47, 0.27);
    float r = length(m);
    c += vec3(0.5, 0.55, 0.7) * 0.22 * exp(-r / 0.06);
    c = mix(c, vec3(0.92, 0.9, 0.78), cover(r - 0.03));
    c = mix(c, vec3(0.13, 0.15, 0.3), 0.6 * streak(f, 0.27, 0.01, 2.5) * smoothstep(0.08, 0.0, abs(f.x + 0.42)));
    vec2 cell = floor(f * 60.0);
    if (rand(cell, 1u) < 0.1) {
      vec2 sp = (cell + 0.2 + 0.6 * vec2(rand(cell, 2u), rand(cell, 3u))) / 60.0;
      vec2 sd = (f - sp) / 0.0016;
      float k = (0.25 + 0.5 * rand(cell, 4u)) * smoothstep(HORIZON + 0.15, HORIZON + 0.35, f.y);
      c += vec3(0.85, 0.88, 1.0) * k * exp(-dot(sd, sd));
    }
  }
  outColor = vec4(c, 0.0);
}
`;

/**
 * The studio, drawn once per resize and each backdrop, desk or microphone
 * change, with four samples a pixel: the panelled walls, the backdrop in its
 * gilded frame (the painted skyline with its water and bridge, or the velvet
 * curtain), lit by the truss's lamps with a hot spot under each, the band's
 * corner out of focus, the truss, the applause sign unlit, and the desk with
 * its mug and microphone. Alpha codes what the composite adds: half the
 * backdrop's share of the pixel (where its lit windows show), plus half the
 * open sky's share (where a light can cross it).
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uFit;
uniform sampler2D uPicture;
uniform sampler2D uSign;
uniform vec4 uPicRect;
uniform vec4 uSignRect;
uniform vec4 uBand;
/** The microphone's x, the mug's x, and whether the microphone is there. */
uniform vec3 uProps;
uniform int uBackdrop;
uniform int uDesk;
uniform vec3 uWater;
uniform vec3 uSteel;
out vec4 outColor;
${VALUE_NOISE_GLSL}
${DITHER_GLSL}
${SHARED_GLSL}

vec3 col;
float vis;
float skyv;

/** Lays a surface over what's there, with coverage a; it hides any backdrop under it. */
void lay(vec3 c, float a) {
  col = mix(col, c, a);
  vis *= 1.0 - a;
  skyv *= 1.0 - a;
}
vec4 pic(vec2 f) {
  return texture(uPicture, (f - uPicRect.xy) / (uPicRect.zw - uPicRect.xy));
}
vec3 chrome(float s) {
  float k = 0.5 + 0.5 * sin(s * 4.2 + 0.7);
  return mix(vec3(0.1, 0.1, 0.12), vec3(0.88, 0.88, 0.92), k * k);
}

/** The studio's walls: tall dark wooden panels in a warm wash, falling to black above the truss. */
vec3 walls(vec2 f) {
  vec3 c = vec3(0.075, 0.042, 0.03);
  // Distance from the panel's middle: its joints are at 0.08.
  float joint = abs(fract(f.x / 0.16) - 0.5) * 0.16;
  c *= 0.55 + 0.45 * smoothstep(0.079, 0.073, joint);
  c *= 0.85 + 0.25 * vnoise(vec2(f.x * 30.0, f.y * 3.0), 7.0);
  c *= 0.55 + 0.9 * exp(-(f.y + 0.05) * (f.y + 0.05) / 0.25);
  return c * (1.0 - 0.9 * smoothstep(0.42, 0.62, f.y));
}

/**
 * The bridge: deck, towers and cables in dark steel, a row of lamps along the
 * deck, and their reflections. Returns the steel's coverage, which hides the
 * windows behind it.
 */
float bridge(vec2 f, inout vec3 c) {
  float t1 = 0.24;
  float t2 = 0.6;
  float top = HORIZON + 0.25;
  float d = max(-0.02 - f.x, abs(f.y - DECK) - 0.003);
  d = min(d, sdSeg(f, vec2(-0.12, HORIZON + 0.001), vec2(-0.02, DECK)) - 0.003);
  for (int i = 0; i < 2; i++) {
    float tx = i == 0 ? t1 : t2;
    float w = mix(0.0065, 0.004, clamp((f.y - HORIZON) / (top - HORIZON), 0.0, 1.0));
    d = min(d, max(abs(f.x - tx) - w, max(f.y - top, HORIZON - 0.012 - f.y)));
  }
  float span = t2 - t1;
  float side = 0.6 * span;
  float y = -1.0;
  if (f.x >= t1 && f.x <= t2) {
    float k = (f.x - 0.5 * (t1 + t2)) / (0.5 * span);
    y = DECK + 0.012 + (top - DECK - 0.012) * k * k;
  } else if (f.x > t1 - side && f.x < t1) {
    float k = (f.x - (t1 - side)) / side;
    y = DECK + (top - DECK) * k * k;
  } else if (f.x > t2 && f.x < t2 + side) {
    float k = (t2 + side - f.x) / side;
    y = DECK + (top - DECK) * k * k;
  }
  if (y > -0.5) {
    d = min(d, abs(f.y - y) * 0.6 - 0.001);
  }
  float steel = cover(d);
  c = mix(c, uSteel * (0.8 + 0.4 * smoothstep(HORIZON, top, f.y)), steel);
  float k = lampIndex(f.x);
  vec2 q = f - vec2(LAMP_X0 + k * LAMP_SP, DECK + 0.006);
  c += LAMP * (1.1 * exp(-dot(q, q) / 0.0000048) + 0.15 * exp(-dot(q, q) / 0.00014));
  for (int i = 0; i < 2; i++) {
    vec2 r = f - vec2(i == 0 ? t1 : t2, top + 0.004);
    c += vec3(1.0, 0.15, 0.1) * 0.6 * exp(-dot(r, r) / 0.000006);
  }
  float depth = HORIZON - f.y;
  if (depth > 0.0) {
    float s = exp(-q.x * q.x / 0.0000064) * exp(-depth / 0.08) * (0.55 + 0.45 * sin(depth * 260.0 + k * 2.3));
    c += LAMP * 0.35 * s;
  }
  return steel;
}

/**
 * The painted skyline: sky and buildings from the picture, water reflecting
 * them below the horizon, and the bridge, on two seamed panels with a little
 * brush and canvas texture. Returns the open sky's share in sky, and how much
 * of the windows' light shows (all but where the bridge is) in windows.
 */
vec3 skylineBackdrop(vec2 f, out float sky, out float windows) {
  // Each panel is hung a hair out of register with the next.
  vec2 p = f + vec2(0.0, f.x > -0.5 ? 0.0015 : 0.0) - vec2(0.0, f.x > 0.43 ? 0.0025 : 0.0);
  vec3 c;
  if (p.y >= HORIZON) {
    vec4 s = pic(p);
    c = s.rgb;
    sky = 1.0 - s.a;
  } else {
    sky = 0.0;
    float depth = HORIZON - p.y;
    vec3 r = pic(mirrorAt(p)).rgb;
    c = mix(uWater, r, 0.15 + 0.25 * exp(-depth / 0.05));
    c *= 0.86 + 0.16 * sin(p.y * 300.0 + 2.0 * sin(p.x * 23.0)) * (0.6 + 0.4 * sin(p.x * 70.0 + p.y * 40.0));
  }
  // The embankment along the waterline, with its streetlamps.
  float e = abs(p.y - HORIZON + 0.004) - 0.004;
  c = mix(c, uSteel * 0.5, cover(e));
  vec2 sl = vec2(p.x - (floor(p.x / 0.034) + 0.5) * 0.034, p.y - HORIZON - 0.002);
  c += LAMP * 0.7 * exp(-dot(sl, sl) / 0.000003);
  windows = 1.0 - bridge(p, c);
  c *= 0.95 + 0.08 * vnoise(f * vec2(40.0, 110.0), 3.0) + 0.05 * (vnoise(f * 700.0, 5.0) - 0.5);
  float seam = min(abs(f.x + 0.5), abs(f.x - 0.43));
  c *= 1.0 - 0.12 * exp(-seam * seam / 0.00001) + 0.05 * exp(-(seam - 0.004) * (seam - 0.004) / 0.000004);
  return c;
}

/** The velvet curtain in deep folds, a scalloped pelmet with a gold fringe, and a spotlight's pool in the middle. */
vec3 curtain(vec2 f) {
  float fx = f.x + 0.012 * sin(f.y * 5.0 + f.x * 3.0);
  float fold = 0.5 + 0.5 * sin(fx * TAU * 6.0 + 0.8 * sin(fx * 5.0));
  vec3 c = vec3(0.34, 0.025, 0.05) * (0.2 + 0.95 * pow(fold, 1.4)) + vec3(0.32, 0.09, 0.1) * 0.45 * pow(fold, 10.0);
  c *= 0.92 + 0.12 * vnoise(vec2(fx * 50.0, f.y * 6.0), 9.0);
  vec2 d = (f - vec2(0.0, 0.04)) / vec2(0.42, 0.34);
  float r = length(d);
  c *= 0.4 + 1.1 * smoothstep(1.1, 0.8, r) + 0.5 * exp(-r * r * 2.0);
  float u = fract(f.x * 3.0) * 2.0 - 1.0;
  float edge = FRAME_TOP - 0.05 - 0.02 * (1.0 - u * u);
  vec3 pelmet = vec3(0.3, 0.02, 0.045) * (0.5 + 0.6 * smoothstep(edge, FRAME_TOP, f.y));
  pelmet = mix(pelmet, vec3(0.75, 0.55, 0.22), cover(abs(f.y - edge - 0.004) - 0.004));
  c *= 1.0 - 0.5 * exp(-max(edge - f.y, 0.0) / 0.012);
  return mix(c, pelmet, cover(edge - f.y));
}

/** How the truss's lamps light the backdrop: a hot spot under each, falling off to the frame's edges. */
float stageLight(vec2 f) {
  float l = 0.42;
  for (int i = 0; i < 4; i++) {
    float lx = (float(i) - 1.5) * 0.36;
    vec2 d = (f - vec2(lx, 0.18)) / vec2(0.2, 0.34);
    l += 0.5 * exp(-dot(d, d));
  }
  return l * (0.75 + 0.25 * smoothstep(-0.3, 0.3, f.y));
}

/** The walls, the backdrop in its gilded frame and, for the skyline, the window's mullions. */
void stage(vec2 f) {
  col = walls(f);
  vis = 0.0;
  skyv = 0.0;
  float inner = sdBox(f - vec2(0.0, (FRAME_TOP - 1.5) * 0.5), vec2(FRAME_HW, (FRAME_TOP + 1.5) * 0.5), 0.06);
  bool skyline = uBackdrop != 2;
  if (inner < 2.0 * px) {
    float s = 0.0;
    float w = 0.0;
    vec3 b = skyline ? skylineBackdrop(f, s, w) : curtain(f);
    b *= stageLight(f) * (skyline ? vec3(0.92, 0.96, 1.08) : vec3(1.05, 0.98, 0.95));
    b *= 1.0 - 0.5 * exp(inner / 0.022);
    float a = cover(inner);
    col = mix(col, b, a);
    if (skyline) {
      vis = a * w;
      skyv = a * s * w;
    }
  }
  if (skyline) {
    float m = max(abs(abs(f.x) - 0.34) - 0.008, f.y - FRAME_TOP);
    col *= 1.0 - 0.35 * exp(-max(m, 0.0) / 0.01) * step(0.0, f.x * sign(f.x) - 0.34);
    float t = clamp((abs(f.x) - 0.332) / 0.016, 0.0, 1.0);
    lay(vec3(0.3, 0.2, 0.1) * (0.5 + 0.6 * sin(t * 3.1416)), cover(m));
  }
  float t = clamp(inner / 0.036, 0.0, 1.0);
  vec3 gilt = vec3(0.5, 0.36, 0.15) * (0.35 + 0.75 * sin(t * 3.1416)) + vec3(0.4, 0.32, 0.18) * pow(sin(t * 3.1416), 12.0);
  gilt = mix(gilt, gilt * 0.5, cover(abs(t - 0.62) * 0.036 - 0.0012));
  lay(gilt, cover(abs(inner - 0.018) - 0.018));
  col *= 1.0 - 0.4 * exp(-max(inner - 0.036, 0.0) / 0.02) * step(0.036, inner);
}

/** The band's corner, out of focus: a warm haze, the riser's lit edge, a bass drum and two cymbals. */
void band(vec2 f) {
  float bx = uBand.x;
  vec2 hz = (f - vec2(bx + 0.02, -0.1)) / vec2(0.3, 0.26);
  col += vec3(0.2, 0.09, 0.04) * exp(-dot(hz, hz));
  float blur = 0.012;
  float rx = bx + 0.24;
  float riser = max(f.y + 0.215, f.x - rx);
  lay(vec3(0.05, 0.03, 0.025), 0.9 * smoothstep(blur, -blur, riser));
  col += vec3(1.0, 0.55, 0.2) * 0.3 * exp(-(f.y + 0.215) * (f.y + 0.215) / 0.00004) * smoothstep(rx + blur, rx - blur, f.x);
  float drum = length(f - vec2(bx + 0.03, -0.15)) - 0.07;
  lay(vec3(0.1, 0.05, 0.05), 0.92 * smoothstep(blur, -blur, drum));
  col += vec3(0.9, 0.5, 0.2) * 0.14 * exp(-drum * drum / 0.00008);
  for (int i = 0; i < 2; i++) {
    vec2 c0 = i == 0 ? vec2(bx + 0.13, -0.02) : vec2(bx - 0.1, 0.01);
    float a = i == 0 ? -0.12 : 0.15;
    vec2 q = f - c0;
    q = vec2(cos(a) * q.x + sin(a) * q.y, -sin(a) * q.x + cos(a) * q.y);
    float stand = max(abs(f.x - c0.x) - 0.002, f.y - c0.y);
    lay(vec3(0.06, 0.05, 0.05), 0.8 * smoothstep(blur * 0.6, -blur * 0.6, stand));
    float e = (length(q / vec2(0.065, 0.008)) - 1.0) * 0.008;
    vec3 brass = vec3(0.55, 0.38, 0.14) * (0.6 + 0.6 * smoothstep(-0.06, 0.06, q.x));
    lay(brass, 0.9 * smoothstep(blur * 0.5, -blur * 0.5, e));
  }
}

/** The lighting truss across the top, with its lamps hanging below. */
void truss(vec2 f) {
  const float Y0 = 0.448;
  const float Y1 = 0.478;
  if (f.y < 0.38 || f.y > Y1 + 0.01) {
    return;
  }
  float d = min(abs(f.y - Y0), abs(f.y - Y1)) - 0.0035;
  const float CW = 0.03;
  vec2 q = vec2(mod(f.x, CW), f.y);
  d = min(d, sdSeg(q, vec2(0.0, Y0), vec2(CW * 0.5, Y1)) - 0.0013);
  d = min(d, sdSeg(q, vec2(CW * 0.5, Y1), vec2(CW, Y0)) - 0.0013);
  lay(vec3(0.09, 0.09, 0.1) * (0.7 + 0.6 * smoothstep(Y0, Y1, f.y)), cover(d));
  float lx = (floor(f.x / 0.36) + 0.5) * 0.36;
  vec2 p = f - vec2(lx, 0.418);
  float yoke = max(abs(abs(p.x) - 0.021) - 0.002, abs(p.y - 0.012) - 0.018);
  yoke = min(yoke, sdBox(p - vec2(0.0, 0.03), vec2(0.023, 0.002), 0.001));
  lay(vec3(0.06), cover(yoke));
  float body = sdBox(p, vec2(0.017, 0.021), 0.006);
  vec3 can = vec3(0.04, 0.04, 0.045) * (0.7 + 0.8 * smoothstep(0.017, -0.017, p.x));
  lay(can, cover(body));
  vec2 l = (p - vec2(0.0, -0.017)) / vec2(0.013, 0.005);
  float lens = (length(l) - 1.0) * 0.005;
  lay(vec3(0.45, 0.38, 0.28), cover(lens));
}

/** The applause sign: a dark box hung from the truss, its letters unlit. */
void applauseSign(vec2 f) {
  vec2 p = f - uSignRect.xy;
  if (abs(p.x) > uSignRect.z + 0.02 || p.y < -uSignRect.w - 0.02) {
    return;
  }
  float wire = max(abs(abs(p.x) - uSignRect.z * 0.75) - 0.0012, max(-p.y, p.y - 0.06));
  lay(vec3(0.05), cover(wire));
  col *= 1.0 - 0.4 * exp(-max(sdBox(p + vec2(0.0, 0.006), uSignRect.zw + 0.008, 0.008), 0.0) / 0.01);
  float box = sdBox(p, uSignRect.zw + 0.008, 0.007);
  lay(vec3(0.06, 0.06, 0.07) + vec3(0.25) * cover(abs(box + 0.0012) - 0.0012), cover(box));
  float face = sdBox(p, uSignRect.zw, 0.004);
  vec2 uv = p / (2.0 * uSignRect.zw) + 0.5;
  float letters = texture(uSign, vec2(uv.x, 1.0 - uv.y)).r;
  lay(mix(vec3(0.07, 0.012, 0.012), vec3(0.24, 0.05, 0.04), letters), cover(face));
}

/** The desk's front and top surface, in wood, retro padding or glass. */
void desk(vec2 f) {
  float top = deskTopAt(f.x);
  float back = top + TOP_DEPTH;
  if (f.y > back + 0.02) {
    return;
  }
  float t = clamp((f.y - top) / TOP_DEPTH, 0.0, 1.0);
  float below = max(top - f.y, 0.0);
  vec3 surface;
  vec3 front;
  if (uDesk == 1) {
    surface = vec3(0.72, 0.6, 0.44) * (0.7 + 0.35 * t);
    float u = fract(f.x / 0.065) - 0.5;
    float pad = cos(u * 3.1416);
    front = vec3(0.62, 0.26, 0.06) * (0.3 + 0.8 * pow(pad, 0.6)) + vec3(0.3, 0.16, 0.06) * 0.5 * pow(pad, 14.0);
    front *= 0.95 - 0.35 * exp(-(below - 0.03) * (below - 0.03) / 0.00002);
    front *= 0.7 + 0.4 * exp(-f.x * f.x / 0.5);
    front = mix(front, chrome(below / 0.008 - 0.5), cover(below - 0.008));
  } else if (uDesk == 2) {
    surface = vec3(0.02, 0.025, 0.035) + vec3(0.12, 0.14, 0.17) * exp(-(t - 0.6) * (t - 0.6) / 0.02);
    front = vec3(0.022, 0.035, 0.055) + vec3(0.05, 0.07, 0.1) * smoothstep(0.3, 0.0, below);
    float s = fract((f.x * 0.55 + f.y) * 1.4);
    front += vec3(0.07, 0.09, 0.12) * exp(-(s - 0.5) * (s - 0.5) / 0.004);
    front += vec3(0.4, 0.65, 1.0) * (0.9 * exp(-(below - 0.004) * (below - 0.004) / 0.000006) + 0.12 * exp(-below / 0.03));
    float post = abs(fract(f.x / 0.5 + 0.5) - 0.5) * 0.5;
    front += vec3(0.02, 0.03, 0.04) * smoothstep(0.012, 0.004, post);
  } else {
    float warp = vnoise(f * vec2(2.0, 24.0), 2.0);
    float grain = vnoise(vec2(f.x * 3.0 + 1.6 * warp, f.y * 110.0), 4.0);
    vec3 wood = mix(vec3(0.19, 0.08, 0.033), vec3(0.4, 0.19, 0.075), grain);
    surface = wood * (0.95 + 0.5 * t) + vec3(0.12, 0.08, 0.05) * exp(-(t - 0.35) * (t - 0.35) / 0.015);
    float groove = abs(fract(f.x / 0.32 + 0.5) - 0.5) * 0.32;
    front = wood * (1.0 - 0.55 * smoothstep(0.004, 0.0015, groove));
    front += vec3(0.08, 0.04, 0.02) * smoothstep(0.004, 0.0015, abs(groove - 0.004)) * step(0.0, fract(f.x / 0.32 + 0.5) - 0.5);
    float lip = below / 0.022;
    front *= lip < 1.0 ? 1.2 + 0.35 * (1.0 - lip) : 0.75 + 0.15 * smoothstep(0.022, 0.03, below);
    front *= 0.62 + 0.55 * exp(-below / 0.12);
  }
  lay(surface, cover(f.y - back));
  lay(front, cover(f.y - top));
}

/** The mug on the desk's far end, with its handle and a contact shadow. */
void mug(vec2 f) {
  float x = uProps.y;
  vec2 p = f - vec2(x, deskTopAt(x) + 0.012 + 0.032);
  if (abs(p.x) > 0.06 || abs(p.y) > 0.06) {
    return;
  }
  vec2 s = (p + vec2(0.0, 0.032)) / vec2(0.035, 0.006);
  col *= 1.0 - 0.4 * exp(-dot(s, s));
  vec3 blue = vec3(0.11, 0.19, 0.42);
  float handle = max(abs(length((p - vec2(0.024, 0.002)) / vec2(1.0, 1.15)) - 0.014) - 0.0042, 0.022 - p.x);
  lay(blue * 0.6, cover(handle));
  float body = sdBox(p, vec2(0.024, 0.032), 0.004);
  float k = clamp(p.x / 0.024, -1.0, 1.0);
  vec3 c = blue * (0.45 + 0.65 * sqrt(1.0 - k * k) * (1.0 - 0.35 * k)) + vec3(0.3) * exp(-(k + 0.45) * (k + 0.45) / 0.01);
  lay(c, cover(body));
  vec2 r = (p - vec2(0.0, 0.032)) / vec2(0.024, 0.006);
  lay(vec3(0.05, 0.025, 0.015), cover((length(r) - 0.82) * 0.006));
}

/** The old-fashioned desk microphone: a weighted round base, a short stem and a chrome capsule with its grille. */
void mic(vec2 f) {
  float on = uProps.z;
  float x = uProps.x;
  vec2 p = f - vec2(x, deskTopAt(x) + 0.012);
  if (on <= 0.0 || abs(p.x) > 0.07 || p.y < -0.03 || p.y > 0.18) {
    return;
  }
  vec2 s = p / vec2(0.045, 0.009);
  col *= 1.0 - 0.4 * on * exp(-dot(s, s));
  float base = max((length(p / vec2(0.036, 0.01)) - 1.0) * 0.01, -p.y);
  lay(chrome(p.x / 0.036) * 0.8, cover(base) * on);
  float plate = (length((p - vec2(0.0, 0.002)) / vec2(0.036, 0.01)) - 1.0) * 0.01;
  lay(chrome(p.x / 0.036 + 0.6) * 0.7, cover(plate) * on);
  float stem = sdBox(p - vec2(0.0, 0.038), vec2(0.0032, 0.036), 0.001);
  lay(chrome(p.x / 0.0032), cover(stem) * on);
  float ring = abs(length(p - vec2(0.0, 0.074)) - 0.012) - 0.0025;
  lay(chrome(p.x / 0.012) * 0.8, cover(max(ring, p.y - 0.074)) * on);
  vec2 q = p - vec2(-0.004, 0.112);
  const float A = 0.14;
  q = vec2(cos(A) * q.x - sin(A) * q.y, sin(A) * q.x + cos(A) * q.y);
  float cap = sdBox(q, vec2(0.021, 0.04), 0.019);
  vec3 c = chrome(q.x / 0.021);
  float grille = sdBox(q, vec2(0.014, 0.029), 0.012);
  float slot = abs(fract(q.y / 0.0055) - 0.5) * 2.0;
  c *= mix(1.0, 0.45 + 0.55 * smoothstep(0.35, 0.65, slot), cover(grille));
  lay(c, cover(cap) * on);
}

void main() {
  px = 1.0 / (uRes.y * uFit);
  vec3 sum = vec3(0.0);
  float code = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    vec2 f = (gl_FragCoord.xy + o - 0.5 * uRes) * px;
    stage(f);
    band(f);
    truss(f);
    applauseSign(f);
    desk(f);
    mug(f);
    mic(f);
    sum += col;
    code += 0.5 * vis + 0.5 * skyv;
  }
  outColor = vec4(sum * 0.25 + dither8(gl_FragCoord.xy), code * 0.25);
}
`;

/** The band's lights: soft discs, added into the bokeh layer. */
const BOKEH_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (0..1 of the layer), radius (layer px) and brightness. */
layout(location = 1) in vec4 aLight;
layout(location = 2) in vec3 aColor;
uniform vec2 uSize;
out vec2 vLocal;
flat out vec3 vColor;
void main() {
  float r = aLight.z + 1.0;
  vLocal = aCorner * (r / aLight.z);
  vColor = aColor * aLight.w;
  gl_Position = vec4(((aLight.xy * uSize + aCorner * r) / uSize) * 2.0 - 1.0, 0.0, 1.0);
}
`;

const BOKEH_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float a = (1.0 - smoothstep(0.82, 1.0, d)) * (0.75 + 0.3 * d * d);
  outColor = vec4(vColor * a, 0.0);
}
`;

/**
 * Every frame, at full size: the cached studio (two while a change
 * cross-fades), the backdrop's lit windows from their layer (mirrored in the
 * water), the bridge lamps' twinkle, a light crossing the sky, the band's
 * lights, the key light's colour on the desk, the title and the applause sign.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uLights;
uniform sampler2D uBokeh;
uniform sampler2D uTitle;
uniform sampler2D uSign;
uniform vec2 uRes;
uniform float uFit;
uniform float uMix;
/** Each cache's lit-window brightness. */
uniform vec2 uWin;
uniform vec4 uPicRect;
uniform vec4 uBand;
uniform vec4 uTitleRect;
uniform vec4 uSignRect;
uniform float uTime;
/** The crossing light: x, y, its steady glow and its strobe. */
uniform vec4 uPlane;
uniform vec3 uKey;
/** The title's colour and glow, and its opacity. */
uniform vec4 uTitleColor;
uniform float uTitleAlpha;
uniform float uApplause;
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
${SHARED_GLSL}
const float TWINKLE = ${g(TWINKLE_DEPTH)};
const float LOOP = ${g(TWINKLE_LOOP)};
const float CYCLES_LO = ${g(TWINKLE_CYCLES[0])};
const float CYCLES_HI = ${g(TWINKLE_CYCLES[1])};
const float PEAK = ${g(APPLAUSE_PEAK)};

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  px = 1.0 / (uRes.y * uFit);
  vec2 f = (gl_FragCoord.xy - 0.5 * uRes) * px;
  vec4 a = texelFetch(uA, fc, 0);
  vec3 c = a.rgb;
  float vis = min(1.0, 2.0 * a.a) * uWin.x;
  float sky = clamp(2.0 * a.a - 1.0, 0.0, 1.0);
  if (uMix > 0.0) {
    vec4 b = texelFetch(uB, fc, 0);
    c = mix(c, b.rgb, uMix);
    vis = mix(vis, min(1.0, 2.0 * b.a) * uWin.y, uMix);
    sky = mix(sky, clamp(2.0 * b.a - 1.0, 0.0, 1.0), uMix);
  }

  if (vis > 0.0) {
    vec2 q = f;
    float k = 1.0;
    float depth = HORIZON - f.y;
    if (depth > 0.0) {
      q = mirrorAt(f);
      k = 0.3 * exp(-depth / 0.06);
    }
    vec2 uv = (q - uPicRect.xy) / (uPicRect.zw - uPicRect.xy);
    c += max(textureLod(uLights, uv, 0.0).rgb - 0.006, 0.0) * vis * k;
    float dy = f.y - DECK - 0.006;
    if (abs(dy) < 0.012) {
      float i = lampIndex(f.x);
      vec2 d = vec2(f.x - LAMP_X0 - i * LAMP_SP, dy);
      float h = float(hash32(uint(i) * 0x9e3779b1u + 7u)) / 4294967296.0;
      float cycles = floor(mix(CYCLES_LO, CYCLES_HI + 1.0, h));
      float tw = sin(TAU * (uTime * cycles / LOOP + h));
      c += LAMP * TWINKLE * tw * exp(-dot(d, d) / 0.000006) * vis;
    }
  }
  if (uPlane.z > 0.0 && sky > 0.0) {
    vec2 d = (f - uPlane.xy) / 0.0022;
    float r2 = dot(d, d);
    c += (vec3(1.0, 0.35, 0.3) * uPlane.z * exp(-r2) + vec3(1.0) * uPlane.w * exp(-r2 * 0.3)) * sky;
  }

  float deskMask = cover(f.y - deskTopAt(f.x) - TOP_DEPTH);
  vec2 bq = (f - uBand.xy) / uBand.zw;
  if (abs(bq.x) < 1.0 && abs(bq.y) < 1.0) {
    c += textureLod(uBokeh, bq * 0.5 + 0.5, 0.0).rgb * (1.0 - deskMask);
  }
  c *= mix(vec3(1.0), uKey, deskMask);

  vec2 tq = (f - uTitleRect.xy) / uTitleRect.zw;
  if (uTitleAlpha > 0.0 && abs(tq.x) < 1.0 && abs(tq.y) < 1.0) {
    vec4 t = textureLod(uTitle, vec2(tq.x * 0.5 + 0.5, 0.5 - tq.y * 0.5), 0.0);
    float halo = max(t.g - t.r, 0.0);
    c = mix(c, uTitleColor.rgb * 1.05, t.r * uTitleAlpha);
    c += uTitleColor.rgb * halo * uTitleColor.a * 0.6 * uTitleAlpha;
  }

  if (uApplause > 0.0) {
    vec2 p = f - uSignRect.xy;
    vec3 red = vec3(1.0, 0.24, 0.16);
    float box = sdBox(p, uSignRect.zw, 0.004);
    c += red * 0.12 * uApplause * exp(-max(box, 0.0) / 0.03) * step(0.0, box);
    vec2 sq = p / uSignRect.zw;
    if (abs(sq.x) < 1.0 && abs(sq.y) < 1.0) {
      vec4 t = textureLod(uSign, vec2(sq.x * 0.5 + 0.5, 0.5 - sq.y * 0.5), 0.0);
      c += red * (0.25 + PEAK * t.r + 0.5 * max(t.g - t.r, 0.0)) * uApplause;
    }
  }
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** One cached studio: its render, what it shows and how bright its windows are. */
interface Slot {
  target: RenderTarget | null;
  key: number;
  windows: number;
}

/** The cache key for a backdrop, desk and microphone setting. */
const slotKey = (backdrop: string, desk: string, mic: boolean) =>
  (BACKDROP_CODE[backdrop] ?? 0) * 8 + (DESK_CODE[desk] ?? 0) * 2 + (mic ? 1 : 0);

/**
 * The host's chair on a late-night talk show: a wooden desk along the bottom
 * with a mug and a vintage microphone at its far end, a painted skyline (or a
 * velvet curtain) behind, framed in gilt under a lighting truss, and the
 * band's corner glowing out of focus on the left. The backdrop's windows
 * change now and then, its bridge lamps twinkle, a light crosses the sky, the
 * band's lights breathe, and an applause sign can light up between cues.
 *
 * The studio is drawn once per resize or change of backdrop, desk or
 * microphone (cross-fading from the old one over 1.2 s). Each frame: the lit
 * windows' layer at half size only while windows fade, the band's lights at
 * quarter size, and one full-size composite.
 */
export const talkshow = defineEffect(talkshowMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);
      const skyProgram = program(SKY_FRAGMENT);
      const roomProgram = program(ROOM_FRAGMENT);
      const compProgram = program(COMPOSITE_FRAGMENT);
      const bokehProgram = scopedProgram(gl, scope, BOKEH_VERTEX, BOKEH_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const skyline = scope.own(createSkyline(gl));
      const bokeh = scope.own(createSpriteBatch(gl, BAND_LIGHTS, [4, 3]));
      const ku = createUniforms(gl, skyProgram, ["uRes", "uRect", "uKind"]);
      const ru = createUniforms(gl, roomProgram, [
        "uRes",
        "uFit",
        "uPicture",
        "uSign",
        "uPicRect",
        "uSignRect",
        "uBand",
        "uProps",
        "uBackdrop",
        "uDesk",
        "uWater",
        "uSteel",
      ]);
      const cu = createUniforms(gl, compProgram, [
        "uA",
        "uB",
        "uLights",
        "uBokeh",
        "uTitle",
        "uSign",
        "uRes",
        "uFit",
        "uMix",
        "uWin",
        "uPicRect",
        "uBand",
        "uTitleRect",
        "uSignRect",
        "uTime",
        "uPlane",
        "uKey",
        "uTitleColor",
        "uTitleAlpha",
        "uApplause",
      ]);
      const bu = createUniforms(gl, bokehProgram, ["uSize"]);
      gl.useProgram(roomProgram);
      ru.i1("uPicture", 0);
      ru.i1("uSign", 1);
      gl.useProgram(compProgram);
      cu.i1("uA", 0);
      cu.i1("uB", 1);
      cu.i1("uLights", 2);
      cu.i1("uBokeh", 3);
      cu.i1("uTitle", 4);
      cu.i1("uSign", 5);
      gl.useProgram(null);

      const titleTex = createCanvasTexture(gl, scope);
      const signTex = createCanvasTexture(gl, scope);

      const slots: [Slot, Slot] = [
        { target: null, key: -1, windows: 0 },
        { target: null, key: -1, windows: 0 },
      ];
      const release = (s: Slot) => {
        s.target?.dispose();
        s.target = null;
        s.key = -1;
      };
      const fade = createCrossfadeSlots(slots, CROSSFADE_SECONDS, release);
      let lightsTarget: RenderTarget | null = null;
      let bokehTarget: RenderTarget | null = null;
      const disposeTargets = () => {
        release(slots[0]);
        release(slots[1]);
        lightsTarget?.dispose();
        bokehTarget?.dispose();
        lightsTarget = bokehTarget = null;
      };
      scope.defer(disposeTargets);

      const style: SkylineStyle = {
        width: 1,
        height: 1,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        building: NIGHT_BUILDING,
        haze: NIGHT_HAZE,
        warmth: 0.75,
        warm: UNLIT,
        cool: UNLIT,
        tv: UNLIT,
      };
      const bandLights = createBandLights(CITY_SEED);
      const applause = createApplause(CITY_SEED);
      const plane = createAircraft(CITY_SEED);
      const titleRgb = unitRgbMemo();
      const titleEase = createColorEase(4);
      const titleTarget = new Float32Array(4);
      const key = new Float32Array(3);
      skyline.setLayout(
        generateCity(CITY_SEED, CITY_DENSITY, CITY_REF_WIDTH),
        CITY_SEED,
        backdropStyle("night").lit,
      );

      let width = 1;
      let height = 1;
      let layout: TalkLayout = talkLayout(16 / 9);
      // CPU-only time, kept unwrapped in float64.
      let time = 0;
      let lightsStale = true;
      let lightsTimer = Infinity;
      let rawTitle: string | null = null;
      let titleStale = true;
      let title = "";
      let titleLevel = 0;
      let titleShown = false;
      let titleSeen = false;
      let litFraction = backdropStyle("night").lit;

      /** Pixels per design unit. */
      const unit = () => height * layout.fit;

      /** Sets `style` to draw the skyline into a w x h target covering the picture's rect. */
      const placeSkyline = (w: number, h: number) => {
        const k = h / (PIC_Y1 - PIC_Y0);
        style.width = w;
        style.height = h;
        style.scale = (CITY_ZOOM / REF_HEIGHT) * k;
        style.offsetX = 0;
        style.offsetY = (PIC_Y1 - HORIZON) * k - REF_HEIGHT * style.scale;
      };

      /** Paints the title's letters (red) and glow (green) on black, fitted to its rect on the desk. */
      const paintTitle = () => {
        const [, , hw, hh] = layout.title;
        const w = Math.max(8, Math.round(2 * hw * unit()));
        const h = Math.max(4, Math.round(2 * hh * unit()));
        const canvas =
          title === ""
            ? null
            : paintCanvas(w, h, (ctx) => {
                const font = (size: number) => `bold ${String(size)}px ${SANS_FONT_STACK}`;
                const size = fitTitle(title, w, h, (text, s) => {
                  ctx.font = font(s);
                  return (ctx.measureText(text) as TextMetrics | undefined)?.width ?? 0;
                });
                ctx.fillStyle = "#000";
                ctx.fillRect(0, 0, w, h);
                ctx.font = font(size);
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.shadowColor = "#0f0";
                ctx.shadowBlur = Math.max(2, size * 0.35);
                ctx.fillStyle = "#0f0";
                ctx.fillText(title, w / 2, h / 2);
                ctx.shadowBlur = 0;
                ctx.globalCompositeOperation = "lighter";
                ctx.fillStyle = "#f00";
                ctx.fillText(title, w / 2, h / 2);
              });
        if (canvas) {
          titleTex.upload(canvas);
        }
      };

      /** Paints the applause sign's letters (red) and glow (green), to its face's size. */
      const paintSign = () => {
        const w = Math.max(8, Math.round(2 * SIGN_HALF[0] * unit()));
        const h = Math.max(4, Math.round(2 * SIGN_HALF[1] * unit()));
        const canvas = paintCanvas(w, h, (ctx) => {
          const word = "APPLAUSE";
          const font = (size: number) => `bold ${String(size)}px ${SANS_FONT_STACK}`;
          const size = fitTitle(word, w, h, (text, s) => {
            ctx.font = font(s);
            return (ctx.measureText(text) as TextMetrics | undefined)?.width ?? 0;
          });
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, w, h);
          ctx.font = font(size);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.shadowColor = "#0f0";
          ctx.shadowBlur = Math.max(2, size * 0.4);
          ctx.fillStyle = "#0f0";
          ctx.fillText(word, w / 2, h / 2);
          ctx.shadowBlur = 0;
          ctx.globalCompositeOperation = "lighter";
          ctx.fillStyle = "#f00";
          ctx.fillText(word, w / 2, h / 2);
        });
        signTex.upload(canvas);
      };

      /** Draws the studio with these settings into `slot`. */
      const bake = (slot: Slot, backdrop: string, desk: string, mic: boolean) => {
        slot.key = slotKey(backdrop, desk, mic);
        const bs = backdropStyle(backdrop);
        slot.windows = bs.windows;
        slot.target ??= createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
        if (!slot.target) {
          return;
        }
        const dusk = backdrop === "dusk";
        let picture: RenderTarget | null = null;
        if (bs.skyline) {
          const u = unit();
          const pw = Math.max(1, Math.round((PIC_X1 - PIC_X0) * u));
          const ph = Math.max(1, Math.round((PIC_Y1 - PIC_Y0) * u));
          picture = createRenderTarget(gl, pw, ph, gl.RGBA8);
          if (picture) {
            picture.bind();
            gl.useProgram(skyProgram);
            ku.f2("uRes", pw, ph);
            ku.f4("uRect", PIC_X0, PIC_Y0, PIC_X1, PIC_Y1);
            ku.i1("uKind", dusk ? 1 : 0);
            triangle.draw();
            placeSkyline(pw, ph);
            style.building = dusk ? DUSK_BUILDING : NIGHT_BUILDING;
            style.haze = dusk ? DUSK_HAZE : NIGHT_HAZE;
            style.warm = UNLIT;
            style.cool = UNLIT;
            style.tv = UNLIT;
            skyline.draw(style);
          }
        }
        slot.target.bind();
        gl.useProgram(roomProgram);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, signTex.texture);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, picture ? picture.texture : null);
        ru.f2("uRes", width, height);
        ru.f1("uFit", layout.fit);
        ru.f4("uPicRect", PIC_X0, PIC_Y0, PIC_X1, PIC_Y1);
        ru.f4("uSignRect", SIGN_CENTRE[0], SIGN_CENTRE[1], SIGN_HALF[0], SIGN_HALF[1]);
        ru.f4("uBand", layout.band[0], layout.band[1], layout.band[2], layout.band[3]);
        ru.f3("uProps", layout.micX, layout.mugX, mic ? 1 : 0);
        ru.i1("uBackdrop", BACKDROP_CODE[backdrop] ?? 0);
        ru.i1("uDesk", DESK_CODE[desk] ?? 0);
        ru.v3("uWater", dusk ? DUSK_WATER : NIGHT_WATER);
        ru.v3("uSteel", dusk ? DUSK_STEEL : NIGHT_STEEL);
        triangle.draw();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        picture?.dispose();
      };

      /** Redraws the lit windows' layer: only the windows' light, on black. */
      const drawLights = () => {
        if (!lightsTarget) {
          return;
        }
        lightsTarget.bind();
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        placeSkyline(lightsTarget.width, lightsTarget.height);
        style.building = BLACK;
        style.haze = BLACK;
        style.warm = WARM_RGB;
        style.cool = COOL_RGB;
        style.tv = TV_RGB;
        skyline.draw(style);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
      };

      /** Draws the band's breathing lights into their layer. */
      const drawBokeh = () => {
        if (!bokehTarget) {
          return;
        }
        const w = bokehTarget.width;
        const h = bokehTarget.height;
        const r = unit() / BOKEH_DIVISOR;
        const d = bokeh.data;
        for (let i = 0; i < BAND_LIGHTS; i++) {
          const s = i * BAND_LIGHT_FLOATS;
          const o = i * 7;
          d[o] = bandLights[s];
          d[o + 1] = bandLights[s + 1];
          d[o + 2] = Math.max(1, bandLights[s + 2] * r);
          d[o + 3] = bandLightLevel(bandLights, i, time);
          d[o + 4] = bandLights[s + 3];
          d[o + 5] = bandLights[s + 4];
          d[o + 6] = bandLights[s + 5];
        }
        bokeh.upload(BAND_LIGHTS);
        bokehTarget.bind();
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(bokehProgram);
        bu.f2("uSize", w, h);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        bokeh.draw(0, BAND_LIGHTS);
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          layout = talkLayout(width / height);
          disposeTargets();
          const u = unit();
          lightsTarget = createRenderTarget(
            gl,
            Math.max(1, Math.round(((PIC_X1 - PIC_X0) * u) / LIGHTS_DIVISOR)),
            Math.max(1, Math.round(((PIC_Y1 - PIC_Y0) * u) / LIGHTS_DIVISOR)),
            gl.RGBA8,
          );
          bokehTarget = createRenderTarget(
            gl,
            Math.max(1, Math.round((2 * layout.band[2] * u) / BOKEH_DIVISOR)),
            Math.max(1, Math.round((2 * layout.band[3] * u) / BOKEH_DIVISOR)),
            gl.RGBA8,
          );
          lightsStale = true;
          lightsTimer = Infinity;
          titleStale = true;
          paintSign();
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;

          // 1. The studio: bake it after a resize, or cross-fade to a changed one.
          fade.step(step);
          const want = slotKey(p.backdrop, p.desk, p.mic);
          if (!fade.current.target) {
            bake(fade.current, p.backdrop, p.desk, p.mic);
          } else if (!fade.fading && fade.current.key !== want) {
            bake(fade.next, p.backdrop, p.desk, p.mic);
            fade.start();
          }
          const current = fade.current;
          const next = fade.next;
          if (!current.target) {
            return;
          }

          // 2. The windows: a few change now and then; their layer redraws only while they fade.
          const lit = backdropStyle(p.backdrop).lit;
          if (lit !== litFraction) {
            litFraction = lit;
            skyline.windows.setTarget(lit, true);
          }
          lightsStale = skyline.step(step, WINDOW_RATE) || lightsStale;
          lightsTimer += step;
          const showWindows = current.windows > 0 || (fade.fading && next.windows > 0);
          if (lightsStale && showWindows && lightsTimer >= 1 / LIGHTS_RATE) {
            lightsStale = false;
            lightsTimer = 0;
            drawLights();
          }

          // 3. The band's lights.
          drawBokeh();

          // 4. The title: repaint it only when it's edited.
          if (p.title !== rawTitle || titleStale) {
            rawTitle = p.title;
            titleStale = false;
            const text = sanitizeText(talkshowMeta.params.title, p.title).trim();
            titleShown = text !== "";
            // An empty title fades out with its old letters.
            if (titleShown) {
              title = text;
              paintTitle();
            }
            if (!titleSeen) {
              titleSeen = true;
              titleLevel = titleShown ? 1 : 0;
            }
          }
          titleLevel = approach(titleLevel, titleShown ? 1 : 0, step / TITLE_FADE);
          const tc = titleRgb(p.titleColor);
          titleTarget[0] = tc[0];
          titleTarget[1] = tc[1];
          titleTarget[2] = tc[2];
          titleTarget[3] = TITLE_GLOW[p.desk] ?? TITLE_GLOW.wood;
          const titleColor = titleEase.step(titleTarget, step, TITLE_EASE);

          // 5. The applause sign and the light crossing the sky.
          const cue = stepApplause(applause, step, p.applause);
          plane.step(step, CITY_REF_WIDTH, true);

          // 6. Everything together.
          gl.useProgram(compProgram);
          gl.activeTexture(gl.TEXTURE5);
          gl.bindTexture(gl.TEXTURE_2D, signTex.texture);
          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_2D, titleTex.texture);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, bokehTarget ? bokehTarget.texture : null);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, lightsTarget ? lightsTarget.texture : null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, fade.fading && next.target ? next.target.texture : null);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, current.target.texture);
          cu.f2("uRes", width, height);
          cu.f1("uFit", layout.fit);
          cu.f1("uMix", fade.fading && next.target ? fade.mix : 0);
          cu.f2("uWin", current.windows, next.windows);
          cu.f4("uPicRect", PIC_X0, PIC_Y0, PIC_X1, PIC_Y1);
          cu.f4("uBand", layout.band[0], layout.band[1], layout.band[2], layout.band[3]);
          cu.f4("uTitleRect", layout.title[0], layout.title[1], layout.title[2], layout.title[3]);
          cu.f4("uSignRect", SIGN_CENTRE[0], SIGN_CENTRE[1], SIGN_HALF[0], SIGN_HALF[1]);
          cu.f1("uTime", time % TWINKLE_LOOP);
          if (plane.active) {
            const x = PIC_X0 + (plane.x / CITY_REF_WIDTH) * (PIC_X1 - PIC_X0);
            const y = FRAME_TOP - 0.05 - ((plane.y / REF_HEIGHT - 0.06) / 0.22) * 0.14;
            cu.f4("uPlane", x, y, 0.35, 0.8 * strobe(plane.age));
          } else {
            cu.f4("uPlane", 0, 0, 0, 0);
          }
          cu.v3("uKey", keyTint(p.warmth, key));
          cu.f4("uTitleColor", titleColor[0], titleColor[1], titleColor[2], titleColor[3]);
          cu.f1("uTitleAlpha", titleLevel);
          cu.f1("uApplause", cue);
          triangle.draw();
          for (let unitIndex = 5; unitIndex >= 0; unitIndex--) {
            gl.activeTexture(gl.TEXTURE0 + unitIndex);
            gl.bindTexture(gl.TEXTURE_2D, null);
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
