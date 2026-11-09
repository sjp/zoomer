import { createChangeKey } from "../change-key";
import { generateCity } from "../city/city-sim";
import { createSkyline, type SkylineStyle, TV_RGB } from "../city/city-skyline";
import { type Rgb, unitRgbMemo } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  withScope,
  scissorBox,
} from "../gl";
import { createDayClock } from "../horizon/horizon-sim";
import { approach, smoothstep, wrap } from "../math";
import { HASH32_GLSL } from "../noise";
import { sanitizeText } from "../params";
import { defineEffect } from "../types";
import { drawLiveTag, drawLowerThird, drawTicker, type Graphic } from "./newsdesk-graphics";
import {
  clockText,
  dayMinute,
  DUSK_BLEND,
  duskTarget,
  type DeskLayout,
  deskLayout,
  graphicsLayout,
  type GraphicsLayout,
  litFraction,
  nightLevel,
  revealShown,
  revealStart,
  REVEAL_DELAY,
  skyColours,
  stepReveal,
  stepTicker,
  sunHeight,
  TICKER_ROW,
  tickerOffset,
  tickerSpeed,
  WALL_BEZEL,
} from "./newsdesk-sim";
import { newsdeskMeta } from "./newsdesk.meta";
import { SDF2D_GLSL } from "../sdf-glsl";
import { createCanvasTexture, type CanvasTexture } from "../canvas-texture";

const g = glslFloat;

/** The video wall's picture renders at 1/WALL_DIVISOR of its size on screen. */
const WALL_DIVISOR = 2;
/** The sky and buildings redraw at most this often (Hz): they change slowly. */
const SKY_RATE = 15;
/** The wall's picture: the shoreline's height (share of the wall), and the bridge deck above it. */
const HORIZON = 0.34;
const DECK = HORIZON + 0.055;
/** The skyline: its zoom, density and seed. */
const CITY_ZOOM = 0.8;
const CITY_DENSITY = 0.55;
const CITY_SEED = 0x6e657773;
/** Window toggles per second at rest, and per window short of the target. */
const WINDOW_RATE = 6;
const WINDOW_CATCH_UP = 0.3;
const WINDOW_RATE_MAX = 300;
/** Bridge traffic: car spacing (wall heights), speed (wall heights a second) and the cells before the pattern repeats. */
const CAR_SPACING = 0.03;
const CAR_SPEED = 0.028;
const CAR_CELLS = 256;
/** The wall's water and screens use phases that all repeat within this many seconds. */
const LOOP_SECONDS = 20 * Math.PI;
/** The LED wall's tiles across and down. */
const TILES_X = 12;
const TILES_Y = 4;
/** Seconds per light-strip pulse, and its depth. */
const STRIP_PERIOD = 9;
const STRIP_DEPTH = 0.15;
/** How far the lower third slides in from (frame heights). */
const SLIDE = 0.05;

/** Building and window colours by day and by night. */
const BUILDING_DAY: Rgb = [0.34, 0.4, 0.5];
const BUILDING_NIGHT: Rgb = [0.022, 0.028, 0.055];
const WARM: Rgb = [1, 0.74, 0.42];
const COOL: Rgb = [0.8, 0.88, 1];
const STEEL_DAY: Rgb = [0.42, 0.46, 0.52];
const STEEL_NIGHT: Rgb = [0.03, 0.035, 0.06];

const KIND_STRIP = 0;
const KIND_SCREEN = 1;
const KIND_GLOBE = 2;

const SHARED_GLSL = /* glsl */ `
${SDF2D_GLSL}
float rand(vec2 cell, uint salt) {
  uvec2 u = uvec2(ivec2(cell) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ salt))) / 4294967296.0;
}
`;

/**
 * The studio, drawn once per resize with four samples per pixel: the dark
 * backdrop and lighting truss, the glossy blue side pieces with their silver
 * trim, light strips, screen bezels and globe plate, the video wall's bezel,
 * the glossy floor, and the curved desk along the bottom. Alpha codes what
 * the composite adds: above 127/255, the wall's share of the pixel; below it,
 * how glossy the floor is there (for the wall's reflection).
 */
const SET_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
/** The wall's half width, top and bottom at the middle, and bulge. */
uniform vec4 uWall;
/** The desk's back edge at the middle, its curve, its lip, and the frame's half width. */
uniform vec4 uDesk;
uniform vec4 uStrips[4];
uniform vec4 uScreens[2];
uniform vec3 uGlobe;
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
${SHARED_GLSL}
const float BEZEL = ${g(WALL_BEZEL)};
const vec3 SILVER = vec3(0.64, 0.68, 0.74);

vec3 col;
float wallCov;
float gloss;

/** Lays a surface over what's there, with coverage a; it hides any wall or floor under it. */
void lay(vec3 c, float a) {
  col = mix(col, c, a);
  wallCov *= 1.0 - a;
  gloss *= 1.0 - a;
}
float wallS(float x) {
  float k = x / uWall.x;
  return min(1.0, k * k);
}
float wallTopAt(float x) {
  return uWall.y + uWall.w * wallS(x);
}
float wallBottomAt(float x) {
  return uWall.z - 0.8 * uWall.w * wallS(x);
}
float floorAt(float x) {
  return wallBottomAt(x) - BEZEL - 0.016;
}
float deskCurve(float x) {
  float k = x / uDesk.w;
  return uDesk.y * k * k;
}

/** The studio's darkness, bluer round the wall, with the lighting truss and its lamps up top. */
void backdrop(vec2 f) {
  float glow = exp(-(f.y - 0.1) * (f.y - 0.1) / 0.2) * exp(-f.x * f.x / 1.2);
  col = mix(vec3(0.006, 0.01, 0.026), vec3(0.03, 0.06, 0.15), glow);
  wallCov = 0.0;
  gloss = 0.0;
  // The truss: a dark bar with a silver edge.
  float bar = abs(f.y - 0.462) - 0.008;
  vec3 truss = vec3(0.05, 0.055, 0.065) + SILVER * 0.25 * (1.0 - smoothstep(0.0, 0.002, abs(f.y - 0.468)));
  lay(truss, cover(bar));
  // Lamps hanging from it, each with a soft cone of light below.
  float lx = (floor(f.x / 0.34 + 0.5)) * 0.34;
  vec2 q = f - vec2(lx, 0.437);
  col += vec3(0.05, 0.06, 0.09) * exp(-q.x * q.x / 0.004) * smoothstep(0.0, -0.25, q.y) * smoothstep(-0.4, -0.05, q.y);
  lay(vec3(0.04, 0.042, 0.05) * (0.8 + 0.4 * smoothstep(-0.015, 0.015, q.x)), cover(sdBox(q, vec2(0.016, 0.018), 0.004)));
  lay(vec3(0.95, 0.92, 0.85), cover(sdBox(q + vec2(0.0, 0.017), vec2(0.011, 0.0025), 0.002)));
}

/** The side pieces: glossy deep blue lacquer in tall panels, silver trim along the inner edge and the top. */
void sides(vec2 f) {
  float ax = abs(f.x);
  float inner = uWall.x + BEZEL + 0.004;
  float top = 0.418;
  float bottom = floorAt(uWall.x);
  float d = max(inner - ax, max(f.y - top, bottom - f.y));
  if (d > 0.03) {
    return;
  }
  col *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.03, d));
  float u = ax - inner;
  vec3 c = vec3(0.022, 0.065, 0.18) * (0.65 + 0.55 * smoothstep(bottom, top, f.y));
  // A broad diagonal sheen and the top's lit edge.
  float diag = u - 0.07 - 0.3 * (f.y - 0.1);
  c += vec3(0.05, 0.08, 0.13) * exp(-diag * diag / 0.0006);
  c += vec3(0.03, 0.05, 0.08) * exp(-(f.y - 0.37) * (f.y - 0.37) / 0.001);
  // Grooves between the panels.
  float groove = abs(fract((f.y + 0.5) / 0.19) - 0.5) * 0.19;
  c *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.0025, groove));
  float trim = min(abs(u - 0.004) - 0.0032, abs(f.y - top + 0.004) - 0.004);
  c = mix(c, SILVER * (0.6 + 0.35 * smoothstep(-0.2, 0.4, f.y)), cover(trim));
  lay(c, cover(d));
}

/** The light strips' housings and dim cores (their glow is drawn live), the screens' bezels and the globe's plate. */
void fittings(vec2 f) {
  for (int i = 0; i < 4; i++) {
    vec4 s = uStrips[i];
    vec2 q = f - s.xy;
    lay(vec3(0.07, 0.075, 0.085), cover(sdBox(q, s.zw + 0.0035, 0.002)));
    lay(vec3(0.3, 0.45, 0.56), cover(sdBox(q, s.zw, s.z)));
  }
  for (int i = 0; i < 2; i++) {
    vec4 s = uScreens[i];
    vec2 q = f - s.xy;
    col *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.02, sdBox(q - vec2(0.004, -0.008), s.zw + 0.008, 0.006)));
    vec3 bezel = vec3(0.05, 0.055, 0.065) + SILVER * 0.35 * (1.0 - smoothstep(0.0, 0.0018, abs(sdBox(q, s.zw + 0.008, 0.006) + 0.001)));
    lay(bezel, cover(sdBox(q, s.zw + 0.008, 0.006)));
    lay(vec3(0.01, 0.02, 0.04), cover(sdBox(q, s.zw, 0.002)));
  }
  vec2 q = f - uGlobe.xy;
  float R = uGlobe.z;
  float r = length(q);
  col += vec3(0.03, 0.07, 0.16) * exp(-max(r - R * 1.15, 0.0) / 0.035);
  lay(SILVER * (0.45 + 0.35 * smoothstep(-R, R, q.y - q.x)), cover(r - R * 1.16));
  lay(vec3(0.015, 0.04, 0.11) * (1.0 + 0.6 * smoothstep(R * 1.1, 0.0, r)), cover(r - R * 1.1));
}

/** The video wall's bezel, and the wall's own share of the pixel. */
void wall(vec2 f) {
  float d = max(abs(f.x) - uWall.x, max(f.y - wallTopAt(f.x), wallBottomAt(f.x) - f.y));
  if (d > BEZEL + 0.03) {
    return;
  }
  col *= 1.0 - 0.45 * (1.0 - smoothstep(BEZEL, BEZEL + 0.03, d));
  vec3 bezel = vec3(0.05, 0.055, 0.065) + SILVER * 0.45 * (1.0 - smoothstep(0.0, 0.0018, abs(d - BEZEL + 0.0015)));
  lay(bezel, cover(d - BEZEL));
  float a = cover(d);
  col = mix(col, vec3(0.0), a);
  wallCov = a;
}

/** The glossy floor under the wall, with the strips' reflections and a blue line along its back. */
void studioFloor(vec2 f) {
  float fy = floorAt(f.x);
  if (f.y > fy + 0.01) {
    return;
  }
  vec3 c = vec3(0.01, 0.018, 0.045) * (0.6 + 0.6 * smoothstep(-0.5, fy, f.y));
  for (int i = 0; i < 4; i++) {
    vec4 s = uStrips[i];
    float dx = f.x - s.x;
    float below = fy - f.y;
    c += vec3(0.16, 0.28, 0.38) * 0.4 * exp(-dx * dx / 0.00004) * exp(-below / 0.07);
  }
  c += vec3(0.1, 0.25, 0.45) * 0.6 * (1.0 - smoothstep(0.0, 0.0025, abs(f.y - fy + 0.004)));
  float a = cover(f.y - fy);
  lay(c, a);
  gloss = a * smoothstep(uWall.x + 0.02, uWall.x - 0.05, abs(f.x));
}

/** The anchor desk's curved edge along the bottom: a glossy top with a silver rim, and a blue front with a light line. */
void desk(vec2 f) {
  float bend = deskCurve(f.x);
  float top = uDesk.x + bend;
  float lip = uDesk.z + bend;
  if (f.y > top + 0.03) {
    return;
  }
  col *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.03, f.y - top));
  float t = clamp((f.y - lip) / (top - lip), 0.0, 1.0);
  vec3 c = vec3(0.012, 0.022, 0.055) * (0.7 + 0.6 * t);
  c += vec3(0.05, 0.09, 0.17) * 0.6 * exp(-(t - 0.55) * (t - 0.55) / 0.015);
  c = mix(c, SILVER * 0.9, cover(abs(f.y - top + 0.003) - 0.003));
  if (f.y < lip + px) {
    vec3 p = vec3(0.025, 0.065, 0.17) * (0.5 + 0.5 * smoothstep(-0.5, lip, f.y));
    float ly = lip - 0.024;
    p += vec3(0.25, 0.55, 0.9) * (1.0 - smoothstep(0.0, 0.0022, abs(f.y - ly)));
    p += vec3(0.04, 0.1, 0.22) * exp(-abs(f.y - ly) / 0.01);
    p = mix(p, SILVER * 0.8, cover(abs(f.y - lip + 0.0025) - 0.0025));
    c = mix(c, p, cover(f.y - lip));
  }
  lay(c, cover(f.y - top));
}

void main() {
  px = 1.0 / uRes.y;
  vec3 sum = vec3(0.0);
  float code = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    vec2 f = (gl_FragCoord.xy + o - 0.5 * uRes) / uRes.y;
    backdrop(f);
    sides(f);
    fittings(f);
    wall(f);
    studioFloor(f);
    desk(f);
    sum += col;
    code += wallCov > 0.0 ? 127.0 + 128.0 * wallCov : 127.0 - 127.0 * gloss;
  }
  outColor = vec4(sum * 0.25 + dither8(gl_FragCoord.xy), code * 0.25 / 255.0);
}
`;

/**
 * The wall's sky, at its reduced size: a gradient from the horizon colour up
 * to the zenith, the sun and its glow, thin streaks of cloud lit from below,
 * and stars at night. The skyline's buildings draw over it.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform vec3 uZenith;
uniform vec3 uHorizon;
/** The sun's centre, its disc's strength and its glow's strength. */
uniform vec4 uSun;
uniform vec3 uSunColor;
uniform float uNight;
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
${SHARED_GLSL}
const float HZ = ${g(HORIZON)};
void main() {
  px = 1.0 / uRes.y;
  vec2 p = gl_FragCoord.xy / uRes.y;
  float h = clamp((p.y - HZ) / (1.0 - HZ), 0.0, 1.0);
  vec3 c = mix(uHorizon, uZenith, pow(h, 0.65));
  vec2 d = p - uSun.xy;
  float r = length(d * vec2(0.8, 1.3));
  c += uSunColor * (0.45 * exp(-r / 0.2) + 0.35 * exp(-r / 0.05)) * uSun.w;
  // Thin streaks of cloud, lit by the low sun.
  float wa = uRes.x / uRes.y;
  float b0 = (p.y - HZ - 0.27) / 0.022;
  float b1 = (p.y - HZ - 0.16) / 0.014;
  float band = exp(-b0 * b0) * (0.5 + 0.5 * sin(p.x * 5.0 + 2.0 * sin(p.x * 1.7)));
  band += 0.7 * exp(-b1 * b1) * (0.5 + 0.5 * sin(p.x * 8.0 + 1.0 + 2.0 * sin(p.x * 2.9 + wa)));
  vec3 cloud = mix(uHorizon * 1.1, uSunColor, 0.45 * uSun.w);
  c = mix(c, cloud, band * 0.35 * (1.0 - 0.7 * uNight));
  // The sun's disc, sinking behind the buildings.
  c = mix(c, uSunColor * 1.15 + 0.1, cover(length(d) - 0.03) * uSun.z);
  // Stars, high up once it's dark.
  vec2 cell = floor(p * 90.0);
  if (rand(cell, 1u) < 0.12) {
    vec2 sp = (cell + 0.2 + 0.6 * vec2(rand(cell, 2u), rand(cell, 3u))) / 90.0;
    float sd = length(p - sp) * uRes.y;
    float k = uNight * uNight * (0.3 + 0.7 * rand(cell, 4u)) * smoothstep(HZ + 0.12, HZ + 0.4, p.y);
    c += vec3(0.75, 0.82, 1.0) * k * exp(-sd * sd / 0.8);
  }
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * The wall's picture, every frame at its reduced size: the sky and buildings,
 * the water below them reflecting them in slow ripples, the embankment and its
 * streetlights, and the suspension bridge with its lamps and traffic. Lamps
 * come on one by one as it gets dark, each at its own dusk level.
 */
const WALL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSky;
uniform vec2 uRes;
uniform float uDusk;
uniform float uNight;
uniform float uTime;
/** The two lanes' traffic offsets (wall heights). */
uniform vec2 uTraffic;
uniform vec3 uWater;
uniform vec3 uSteel;
out vec4 outColor;
${HASH32_GLSL}
${SHARED_GLSL}
const float HZ = ${g(HORIZON)};
const float DECK = ${g(DECK)};
const float CAR = ${g(CAR_SPACING)};
const vec3 LAMP = vec3(1.0, 0.74, 0.4);

/** Whether lamp k of a row is on (0..1): each comes on at its own point in the dusk. */
float lampOn(float k, uint salt) {
  float th = 0.42 + 0.3 * rand(vec2(k, 0.0), salt);
  return smoothstep(th, th + 0.05, uDusk);
}
float glow(vec2 d, float r) {
  float d2 = dot(d, d);
  return exp(-d2 / (r * r)) + 0.2 * exp(-d2 / (16.0 * r * r));
}
/** A lamp's reflection: a rippling streak down the water under x. */
float streak(float dx, float depth, float k) {
  return exp(-dx * dx / 0.000012) * exp(-depth / 0.07) * (0.55 + 0.45 * sin(depth * 300.0 + uTime * 1.5 + k * 2.3));
}

void main() {
  px = 1.0 / uRes.y;
  vec2 p = gl_FragCoord.xy / uRes.y;
  float wa = uRes.x / uRes.y;
  vec3 c;
  float depth = HZ - p.y;
  if (depth <= 0.0) {
    c = texelFetch(uSky, ivec2(gl_FragCoord.xy), 0).rgb;
  } else {
    float wob = 0.003 * sin(p.y * 210.0 + 1.3 * sin(p.x * 9.0) + uTime * 0.9) * (0.3 + 5.0 * depth);
    vec2 m = vec2(p.x + wob, HZ + depth * 1.15);
    vec3 r = texture(uSky, vec2(m.x / wa, m.y)).rgb;
    c = mix(uWater, r, 0.4 + 0.3 * exp(-depth / 0.05));
    c *= 0.93 + 0.1 * sin(p.y * 520.0 + 3.0 * sin(p.x * 40.0 + uTime * 0.5));
  }

  // The embankment and its streetlights, with their reflections.
  c = mix(c, uSteel * 0.55, cover(max(p.y - HZ, HZ - 0.011 - p.y)));
  float sk = floor(p.x / 0.028);
  float son = lampOn(sk, 3u);
  vec2 sl = vec2((sk + 0.5) * 0.028, HZ + 0.004);
  c += LAMP * son * glow(p - sl, 0.0022);
  if (depth > 0.011) {
    c += LAMP * 0.45 * son * streak(p.x - sl.x, depth - 0.011, sk);
  }

  // The suspension bridge: a deck from a ramp on the left, two towers and the cables.
  float x0 = 0.56 * wa;
  float t1 = 0.7 * wa;
  float t2 = 0.94 * wa;
  float top = DECK + 0.2;
  float d = max(x0 - p.x, abs(p.y - DECK + 0.0035) - 0.0035);
  d = min(d, sdSeg(p, vec2(0.5 * wa, HZ + 0.002), vec2(x0, DECK - 0.0035)) - 0.0035);
  for (int i = 0; i < 2; i++) {
    float tx = i == 0 ? t1 : t2;
    float w = mix(0.0062, 0.0038, clamp((p.y - HZ) / (top - HZ), 0.0, 1.0));
    d = min(d, max(abs(p.x - tx) - w, max(p.y - top, HZ - 0.022 - p.y)));
  }
  // The cable over x: a sagging main span, the side span down to the ramp, and one off to the right.
  float span = t2 - t1;
  float side = 0.6 * span;
  float cx = -1.0;
  float a = 0.0;
  float lo = DECK + 0.012;
  if (p.x >= t1 && p.x <= t2) {
    cx = (p.x - 0.5 * (t1 + t2)) / (0.5 * span);
    a = top - lo;
  } else if (p.x > t1 - side && p.x < t1) {
    cx = (p.x - (t1 - side)) / side;
    a = top - DECK;
    lo = DECK;
  } else if (p.x > t2 && p.x < t2 + side) {
    cx = (t2 + side - p.x) / side;
    a = top - DECK;
    lo = DECK;
  }
  if (cx > -1.0 || a > 0.0) {
    float y = lo + a * cx * cx;
    float slope = 2.0 * a * abs(cx) / (p.x >= t1 && p.x <= t2 ? 0.5 * span : side);
    float cd = abs(p.y - y) / sqrt(1.0 + slope * slope) - 0.0011;
    d = min(d, cd);
    // Hangers down to the deck, fainter.
    float hd = abs(fract(p.x / 0.014) - 0.5) * 0.014 - 0.0006;
    float hang = cover(max(hd, max(p.y - y, DECK - p.y)));
    c = mix(c, uSteel, 0.55 * hang);
    // Lights along the main cable at night.
    if (p.x >= t1 && p.x <= t2) {
      float lk = floor(p.x / 0.03);
      float lu = ((lk + 0.5) * 0.03 - 0.5 * (t1 + t2)) / (0.5 * span);
      vec2 lp = vec2((lk + 0.5) * 0.03, lo + a * lu * lu);
      c += vec3(0.85, 0.9, 1.0) * 0.7 * smoothstep(0.55, 0.75, uDusk) * glow(p - lp, 0.0016);
    }
  }
  c = mix(c, uSteel, cover(d));
  // Steady red lights on the towers' tops.
  for (int i = 0; i < 2; i++) {
    float tx = i == 0 ? t1 : t2;
    c += vec3(1.0, 0.15, 0.08) * (0.25 + 0.6 * uNight) * glow(p - vec2(tx, top + 0.004), 0.002);
  }
  // Lamps along the deck, and their reflections.
  if (p.x > x0) {
    float dk = floor(p.x / 0.022);
    float don = lampOn(dk, 7u);
    vec2 dl = vec2((dk + 0.5) * 0.022, DECK + 0.007);
    c += LAMP * 0.8 * don * glow(p - dl, 0.0018);
    if (depth > 0.011) {
      c += LAMP * 0.3 * don * streak(p.x - dl.x, depth - 0.011, dk + 50.0);
    }
    // Traffic: headlights heading right in the near lane, tail lights heading left in the far one.
    float fade = smoothstep(x0, x0 + 0.04, p.x) * (0.45 + 0.55 * uNight);
    for (int j = 0; j < 2; j++) {
      float dir = j == 0 ? 1.0 : -1.0;
      float s = p.x - dir * uTraffic[j];
      float k = floor(s / CAR);
      uint cell = uint(int(k) & ${String(CAR_CELLS - 1)});
      vec2 key = vec2(float(cell), float(j));
      if (rand(key, 11u) < 0.6) {
        float carX = (k + 0.5 + 0.3 * (rand(key, 13u) - 0.5)) * CAR + dir * uTraffic[j];
        vec2 q = p - vec2(carX, DECK + (j == 0 ? 0.0022 : 0.0042));
        vec3 lc = j == 0 ? vec3(1.0, 0.93, 0.78) : vec3(1.0, 0.16, 0.08);
        c += lc * fade * glow(q * vec2(0.7, 1.0), 0.0019);
      }
    }
  }
  outColor = vec4(c, 1.0);
}
`;

/**
 * Every frame: the cached studio with the video wall's picture mapped onto
 * its curve, seen through the LED panels' faint pixel grid with the seams
 * between their tiles, and the picture's soft reflection in the floor.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSet;
uniform sampler2D uWallTex;
uniform vec2 uRes;
uniform vec4 uWall;
/** The LED pitch in pixels. */
uniform float uPitch;
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
${SHARED_GLSL}
void main() {
  vec4 s = texelFetch(uSet, ivec2(gl_FragCoord.xy), 0);
  vec3 c = s.rgb;
  float code = floor(s.a * 255.0 + 0.5);
  vec2 f = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float k = min(1.0, (f.x / uWall.x) * (f.x / uWall.x));
  float top = uWall.y + uWall.w * k;
  float bottom = uWall.z - 0.8 * uWall.w * k;
  float u = 0.5 + 0.5 * f.x / uWall.x;
  // The wall's tiles, and how many pixels each spans, outside any branch.
  vec2 tq = vec2(u, (f.y - bottom) / (top - bottom)) * vec2(${g(TILES_X)}, ${g(TILES_Y)});
  vec2 tw = max(fwidth(tq), vec2(1e-5));
  if (code > 127.5) {
    float cov = (code - 127.0) / 128.0;
    vec2 uv = tq / vec2(${g(TILES_X)}, ${g(TILES_Y)});
    vec3 w = texture(uWallTex, uv).rgb;
    vec2 e = (0.5 - abs(fract(tq) - 0.5)) / tw;
    w *= 0.5 + 0.5 * smoothstep(0.3, 1.3, min(e.x, e.y));
    w *= 0.97 + 0.06 * rand(floor(tq), 5u);
    vec2 lc = fract(gl_FragCoord.xy / uPitch) - 0.5;
    w *= 0.94 + 0.06 * smoothstep(0.5, 0.2, length(lc));
    c = mix(c, w * 0.95, cov);
  } else if (code < 126.5) {
    float gloss = (127.0 - code) / 127.0;
    float d = max(bottom - f.y, 0.0);
    vec2 uv = vec2(u, d * 1.3 / (top - bottom));
    vec3 m = 0.5 * (texture(uWallTex, uv).rgb + texture(uWallTex, uv + vec2(0.0, 0.035)).rgb);
    c += m * gloss * 0.3 * exp(-d / 0.08);
  }
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * The small live parts, each drawn premultiplied in a scissor round its box: a
 * light strip's gentle glow (added), a small screen's slow abstract graphics,
 * and the globe's turning wireframe (added).
 */
const GADGET_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform int uKind;
/** The part's centre and half size, or centre and radius (frame units). */
uniform vec4 uBox;
/** Strip: its brightness. Screen: the loop's phase (radians) and which screen. Globe: its turn (radians). */
uniform vec4 uVal;
out vec4 outColor;
${HASH32_GLSL}
${SHARED_GLSL}

vec4 strip(vec2 q) {
  vec2 hs = uBox.zw;
  float ends = smoothstep(0.0, 0.03, hs.y - abs(q.y));
  float core = cover(sdBox(q, vec2(0.0045, hs.y), 0.0045));
  vec3 c = vec3(0.55, 0.78, 1.0) * core * 0.6 + vec3(0.1, 0.22, 0.42) * exp(-abs(q.x) / 0.01) * ends;
  return vec4(c * uVal.x, 0.0);
}

vec4 screen(vec2 q) {
  vec2 hs = uBox.zw;
  vec2 v = q / hs;
  float t = uVal.x;
  vec3 c = vec3(0.02, 0.06, 0.16) * (0.8 + 0.4 * v.y);
  // A faint grid.
  vec2 gq = abs(fract(v * vec2(4.0, 3.0)) - 0.5);
  c += vec3(0.03, 0.06, 0.1) * step(0.47, max(gq.x, gq.y));
  if (uVal.y < 0.5) {
    // Bars rising and falling slowly, in blues and a little silver.
    float i = floor((v.x + 1.0) * 4.0);
    float bx = fract((v.x + 1.0) * 4.0);
    float h = -0.75 + 1.25 * (0.5 + 0.5 * sin(t * (1.0 + mod(i, 3.0)) + i * 1.7));
    float bar = step(0.18, bx) * step(bx, 0.82) * step(-0.85, v.y) * step(v.y, h);
    vec3 bc = mod(i, 3.0) < 0.5 ? vec3(0.75, 0.82, 0.92) : vec3(0.2, 0.5, 0.95);
    c = mix(c, bc * (0.6 + 0.4 * (v.y + 1.0) * 0.5), bar);
  } else {
    // Two soft lines drifting across, like a slow chart.
    for (int k = 0; k < 2; k++) {
      float fk = float(k);
      float y = 0.35 * sin(v.x * (2.0 + fk) + t * (1.0 + fk) + fk * 2.0) + 0.25 * sin(v.x * 5.0 - t * 2.0) * (0.5 - fk * 0.3) - 0.1 + 0.2 * fk;
      vec3 lc = k == 0 ? vec3(0.35, 0.75, 1.0) : vec3(0.9, 0.85, 0.7);
      float ld = (v.y - y) * hs.y / (1.6 * px);
      c += lc * 0.8 * exp(-ld * ld);
    }
  }
  // A glint across the glass.
  c += vec3(0.04) * smoothstep(0.15, 0.0, abs(v.x + v.y * 0.6 - 0.5));
  float a = cover(sdBox(q, hs, 0.002));
  return vec4(c * a, a);
}

vec4 globe(vec2 q) {
  float R = uBox.z;
  float r = length(q);
  vec3 blue = vec3(0.35, 0.65, 1.0);
  vec3 c = blue * 0.12 * exp(-abs(r - R) / 0.012);
  if (r < R) {
    float z = sqrt(R * R - r * r);
    // Latitude lines: horizontal at the sphere's heights.
    float lat = asin(clamp(q.y / R, -1.0, 1.0));
    float ls = TAU / 12.0;
    float dl = abs(fract(lat / ls + 0.5) - 0.5) * ls * R * cos(lat);
    float lines = cover(dl - 0.0007);
    // Meridians on the near side, then fainter on the far side, turning.
    for (int k = 0; k < 2; k++) {
      float lon = atan(q.x, k == 0 ? z : -z) + uVal.x;
      float dm = abs(fract(lon / ls + 0.5) - 0.5) * ls * z;
      lines = max(lines, cover(dm - 0.0007) * (k == 0 ? 1.0 : 0.35));
    }
    float shade = 0.15 + 0.12 * smoothstep(R, 0.0, length(q - vec2(-0.3, 0.35) * R));
    c += blue * (shade * 0.5 + lines * 0.75);
    c += vec3(0.7, 0.85, 1.0) * lines * 0.2;
  }
  c += blue * 0.5 * cover(abs(r - R) - 0.0009);
  return vec4(c, 0.0);
}

void main() {
  px = 1.0 / uRes.y;
  vec2 f = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 q = f - uBox.xy;
  if (uKind == ${String(KIND_STRIP)}) {
    outColor = strip(q);
  } else if (uKind == ${String(KIND_SCREEN)}) {
    outColor = screen(q);
  } else {
    outColor = globe(q);
  }
}
`;

/** A canvas-drawn graphic, copied texel for texel to pixel uOrigin and faded by uAlpha. */
const BLIT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex;
uniform ivec2 uOrigin;
uniform float uAlpha;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uTex, 0);
  ivec2 p = ivec2(gl_FragCoord.xy) - uOrigin;
  if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) {
    outColor = vec4(0.0);
    return;
  }
  outColor = texelFetch(uTex, ivec2(p.x, size.y - 1 - p.y), 0) * uAlpha;
}
`;

/**
 * The ticker strip along the bottom: dark blue glass with an accent line along
 * its top, and the text strip scrolled a whole number of texels, so the
 * letters stay crisp.
 */
const TICKER_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex;
uniform vec2 uRes;
/** The strip's bottom row on screen (may be below 0 while it slides in) and its height. */
uniform int uBase;
uniform int uRowH;
uniform int uOffset;
uniform int uPeriod;
uniform vec3 uAccent;
uniform float uAlpha;
uniform bool uText;
out vec4 outColor;
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int py = fc.y - uBase;
  float t = (float(py) + 0.5) / float(uRowH);
  vec3 c = mix(vec3(0.012, 0.025, 0.07), vec3(0.04, 0.075, 0.17), t);
  float line = max(2.0, float(uRowH) * 0.06);
  c = mix(c, uAccent, step(float(uRowH) - line, float(py)));
  if (uText) {
    int i = (fc.x + uOffset) % uPeriod;
    vec4 tx = texelFetch(uTex, ivec2(i % ${String(TICKER_ROW)}, (i / ${String(TICKER_ROW)}) * uRowH + uRowH - 1 - py), 0);
    // Fade the text in and out at the frame's edges.
    float edge = smoothstep(0.0, 0.03, min(gl_FragCoord.x, uRes.x - gl_FragCoord.x) / uRes.x);
    c = c * (1.0 - tx.a * edge) + tx.rgb * edge;
  }
  outColor = vec4(c * uAlpha, uAlpha);
}
`;

/** One canvas graphic's texture and what it was last drawn for. */
interface Overlay {
  texture: CanvasTexture;
  width: number;
  height: number;
  /** Whether it holds a drawing. */
  ready: boolean;
}

/**
 * The anchor's chair at the evening news: a dark blue studio with glossy blue
 * and silver set pieces, light strips, small screens and a glowing globe at the
 * sides, and a big curved LED video wall behind showing a city on the water at
 * dusk. The sky slides from sunset into night and back over ten minutes while
 * windows, streetlights and bridge lamps come on one by one and traffic
 * crosses the bridge. Over it all: a lower third with the speaker's name and
 * title, a slow ticker, and a LIVE tag with the local time.
 *
 * The studio is drawn once per resize. The wall's sky and buildings redraw at
 * most 15 times a second at half size, its water, bridge and lights every
 * frame at half size; then one full-size pass maps the wall onto its curve.
 * The graphics are canvas-drawn textures, redrawn only when their text
 * changes, and the ticker scrolls whole pixels.
 */
export const newsdesk = defineEffect(newsdeskMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) =>
        scope.add(createProgram(gl, FULLSCREEN_VERTEX, fs), (p) => {
          gl.deleteProgram(p);
        });
      const setProgram = program(SET_FRAGMENT);
      const skyProgram = program(SKY_FRAGMENT);
      const wallProgram = program(WALL_FRAGMENT);
      const compProgram = program(COMPOSITE_FRAGMENT);
      const gadgetProgram = program(GADGET_FRAGMENT);
      const blitProgram = program(BLIT_FRAGMENT);
      const tickerProgram = program(TICKER_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const skyline = scope.own(createSkyline(gl));
      const su = createUniforms(gl, setProgram, [
        "uRes",
        "uWall",
        "uDesk",
        "uStrips",
        "uScreens",
        "uGlobe",
      ]);
      const ku = createUniforms(gl, skyProgram, [
        "uRes",
        "uZenith",
        "uHorizon",
        "uSun",
        "uSunColor",
        "uNight",
      ]);
      const wu = createUniforms(gl, wallProgram, [
        "uSky",
        "uRes",
        "uDusk",
        "uNight",
        "uTime",
        "uTraffic",
        "uWater",
        "uSteel",
      ]);
      const cu = createUniforms(gl, compProgram, ["uSet", "uWallTex", "uRes", "uWall", "uPitch"]);
      const gu = createUniforms(gl, gadgetProgram, ["uRes", "uKind", "uBox", "uVal"]);
      const bu = createUniforms(gl, blitProgram, ["uTex", "uOrigin", "uAlpha"]);
      const tu = createUniforms(gl, tickerProgram, [
        "uTex",
        "uRes",
        "uBase",
        "uRowH",
        "uOffset",
        "uPeriod",
        "uAccent",
        "uAlpha",
        "uText",
      ]);
      gl.useProgram(wallProgram);
      wu.i1("uSky", 0);
      gl.useProgram(compProgram);
      cu.i1("uSet", 0);
      cu.i1("uWallTex", 1);
      gl.useProgram(blitProgram);
      bu.i1("uTex", 0);
      gl.useProgram(tickerProgram);
      tu.i1("uTex", 0);
      gl.useProgram(null);

      const overlay = (): Overlay => ({
        texture: createCanvasTexture(gl, scope, { filter: gl.NEAREST, premultiply: true }),
        width: 1,
        height: 1,
        ready: false,
      });
      const lowerThird = overlay();
      const tickerTex = overlay();
      const liveTag = overlay();
      /** Uploads a graphic premultiplied, or marks the overlay empty. */
      const upload = (o: Overlay, gfx: Graphic | null) => {
        o.ready = gfx !== null;
        if (!gfx) {
          return;
        }
        o.texture.upload(gfx.canvas);
        o.width = gfx.width;
        o.height = gfx.height;
      };

      let setTarget: RenderTarget | null = null;
      let skyTarget: RenderTarget | null = null;
      let wallTarget: RenderTarget | null = null;
      const disposeTargets = () => {
        setTarget?.dispose();
        skyTarget?.dispose();
        wallTarget?.dispose();
        setTarget = skyTarget = wallTarget = null;
      };
      scope.defer(disposeTargets);

      const style: SkylineStyle = {
        width: 1,
        height: 1,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        building: [0, 0, 0],
        haze: [0, 0, 0],
        warmth: 0.7,
        warm: [0, 0, 0],
        cool: [0, 0, 0],
        tv: [0, 0, 0],
      };
      const zenith: Rgb = [0, 0, 0];
      const horizon: Rgb = [0, 0, 0];
      const sunColor: Rgb = [0, 0, 0];
      const water: Rgb = [0, 0, 0];
      const steel: Rgb = [0, 0, 0];
      const accentRgb = unitRgbMemo();
      const layoutKey = createChangeKey(1);
      const stripData = new Float32Array(16);
      const screenData = new Float32Array(8);
      const day = createDayClock();

      let width = 1;
      let height = 1;
      let scale = 1;
      let layout: DeskLayout = deskLayout(16 / 9);
      let gfx: GraphicsLayout = graphicsLayout(16 / 9);
      let setStale = true;
      let skyStale = true;
      let skyTimer = Infinity;
      // CPU-only time, kept unwrapped in float64.
      let time = 0;
      let dusk = Number.NaN;
      let skyDusk = Number.NaN;
      let traffic0 = 0;
      let traffic1 = 0;
      let tickerPos = 0;
      let tickerPeriod = 1;
      let tickerRowH = 1;
      let nameLevel = revealStart(REVEAL_DELAY);
      let tickerLevel = revealStart(REVEAL_DELAY + 0.4);
      let liveLevel = revealStart(REVEAL_DELAY + 0.2);
      // The text params as last seen, and their sanitised values.
      let rawName: string | null = null;
      let rawTitle: string | null = null;
      let rawAccent: string | null = null;
      let rawTicker: string | null = null;
      let lowerStale = true;
      let tickerStale = true;
      let name = "";
      let ticker = "";
      let liveMinute = -1;

      const mixRgb = (a: Rgb, b: Rgb, t: number, out: Rgb) => {
        out[0] = a[0] + (b[0] - a[0]) * t;
        out[1] = a[1] + (b[1] - a[1]) * t;
        out[2] = a[2] + (b[2] - a[2]) * t;
      };
      const scaleRgb = (a: Rgb, k: number, out: Rgb) => {
        out[0] = a[0] * k;
        out[1] = a[1] * k;
        out[2] = a[2] * k;
      };
      /** Pixel x and y of frame point (x, y). */
      const pxX = (x: number) => x * height + width / 2;
      const pxY = (y: number) => y * height + height / 2;
      /** Draws the bound gadget program over a scissor round box (cx, cy, hw, hh). */
      const drawGadget = (cx: number, cy: number, hw: number, hh: number) => {
        if (scissorBox(gl, width, height, cx, cy, hw, hh)) {
          triangle.draw();
        }
      };
      /** Copies an overlay to pixel (x, y), faded by alpha. Expects the blit program bound and blending on. */
      const blit = (o: Overlay, x: number, y: number, alpha: number) => {
        const x0 = Math.max(0, x);
        const y0 = Math.max(0, y);
        const x1 = Math.min(width, x + o.width);
        const y1 = Math.min(height, y + o.height);
        if (!o.ready || alpha <= 0 || x1 <= x0 || y1 <= y0) {
          return;
        }
        gl.bindTexture(gl.TEXTURE_2D, o.texture.texture);
        bu.f1("uAlpha", alpha);
        gl.uniform2i(bu.loc.uOrigin, x, y);
        gl.scissor(x0, y0, x1 - x0, y1 - y0);
        triangle.draw();
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          disposeTargets();
          layout = deskLayout(width / height);
          gfx = graphicsLayout(width / height);
          setTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          const top = layout.wallTop + layout.bulge;
          const ww = Math.max(1, Math.round((2 * layout.wallHw * height) / WALL_DIVISOR));
          const wh = Math.max(1, Math.round(((top - layout.wallBottom) * height) / WALL_DIVISOR));
          skyTarget = createRenderTarget(gl, ww, wh, gl.RGBA8);
          wallTarget = createRenderTarget(gl, ww, wh, gl.RGBA8);
          setStale = true;
          skyStale = true;
          skyTimer = Infinity;
          lowerStale = true;
          tickerStale = true;
          liveMinute = -1;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!setTarget || !skyTarget || !wallTarget) {
            return;
          }

          // 1. The studio, once per resize.
          if (setStale) {
            setStale = false;
            const l = layout;
            l.strips.forEach((s, i) => {
              stripData.set(s, i * 4);
            });
            l.screens.forEach((s, i) => {
              screenData.set(s, i * 4);
            });
            gl.useProgram(setProgram);
            su.f2("uRes", width, height);
            su.f4("uWall", l.wallHw, l.wallTop, l.wallBottom, l.bulge);
            su.f4("uDesk", l.deskTop, l.deskCurve, l.deskLip, l.aspect / 2);
            gl.uniform4fv(su.loc.uStrips, stripData);
            gl.uniform4fv(su.loc.uScreens, screenData);
            su.f3("uGlobe", l.globe[0], l.globe[1], l.globe[2]);
            setTarget.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 2. The dusk, blending smoothly into a new setting.
          const target = duskTarget(p.skyline, time);
          dusk = Number.isNaN(dusk) ? target : approach(dusk, target, step / DUSK_BLEND);
          const night = nightLevel(dusk);

          // 3. The skyline, laid out for the wall's shape, and its windows coming on with the dark.
          const sw = skyTarget.width;
          const sh = skyTarget.height;
          const refWidth = Math.round(((sw / sh) * 1080) / CITY_ZOOM);
          layoutKey.set(0, refWidth);
          if (layoutKey.take()) {
            skyline.setLayout(
              generateCity(CITY_SEED, CITY_DENSITY, refWidth),
              CITY_SEED,
              litFraction(dusk),
            );
            skyStale = true;
          }
          const windows = skyline.windows;
          windows.setTarget(litFraction(dusk));
          const short = Math.abs(windows.litCount - litFraction(dusk) * windows.windowCount);
          const rate = Math.min(WINDOW_RATE_MAX, WINDOW_RATE + WINDOW_CATCH_UP * short);
          skyStale = skyline.step(step, rate) || skyStale || Math.abs(dusk - skyDusk) > 0.002;

          // 4. The sky and buildings, at most SKY_RATE times a second.
          skyColours(dusk, zenith, horizon);
          skyTimer += step;
          if (skyStale && skyTimer >= 1 / SKY_RATE) {
            skyTimer = 0;
            skyStale = false;
            skyDusk = dusk;
            const sun = sunHeight(dusk);
            const low = smoothstep(0.35, 0, sun);
            sunColor[0] = 1;
            sunColor[1] = 0.93 - 0.42 * low;
            sunColor[2] = 0.8 - 0.62 * low;
            skyTarget.bind();
            gl.useProgram(skyProgram);
            ku.f2("uRes", sw, sh);
            ku.v3("uZenith", zenith);
            ku.v3("uHorizon", horizon);
            ku.f4(
              "uSun",
              0.2 * (sw / sh),
              HORIZON + sun,
              smoothstep(-0.03, 0.03, sun),
              smoothstep(-0.3, 0.05, sun),
            );
            ku.v3("uSunColor", sunColor);
            ku.f1("uNight", night);
            triangle.draw();
            const k = sh / 1080;
            style.width = sw;
            style.height = sh;
            style.scale = k * CITY_ZOOM;
            style.offsetY = k * ((1 - HORIZON) * 1080 - 1080 * CITY_ZOOM);
            mixRgb(BUILDING_DAY, BUILDING_NIGHT, smoothstep(0.15, 0.75, dusk), style.building);
            style.haze = horizon;
            const lamp = 0.2 + 0.8 * night;
            scaleRgb(WARM, lamp, style.warm);
            scaleRgb(COOL, lamp, style.cool);
            scaleRgb(TV_RGB, lamp, style.tv);
            skyline.draw(style);
          }

          // 5. The wall's water, bridge, lamps and traffic.
          traffic0 = wrap(traffic0 + step * CAR_SPEED, 0, CAR_SPACING * CAR_CELLS);
          traffic1 = wrap(traffic1 + step * CAR_SPEED * 0.85, 0, CAR_SPACING * CAR_CELLS);
          const loop = time % LOOP_SECONDS;
          mixRgb(zenith, horizon, 0.35, water);
          scaleRgb(water, 0.5, water);
          mixRgb(STEEL_DAY, STEEL_NIGHT, smoothstep(0.15, 0.75, dusk), steel);
          wallTarget.bind();
          gl.useProgram(wallProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, skyTarget.texture);
          wu.f2("uRes", sw, sh);
          wu.f1("uDusk", dusk);
          wu.f1("uNight", night);
          wu.f1("uTime", loop);
          wu.f2("uTraffic", traffic0, traffic1);
          wu.v3("uWater", water);
          wu.v3("uSteel", steel);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);

          // 6. The studio with the wall on its curve.
          gl.useProgram(compProgram);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, wallTarget.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, setTarget.texture);
          cu.f2("uRes", width, height);
          cu.f4("uWall", layout.wallHw, layout.wallTop, layout.wallBottom, layout.bulge);
          cu.f1("uPitch", Math.max(2, Math.round(3 * scale)));
          triangle.draw();
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);

          // 7. The strips, screens and globe.
          gl.useProgram(gadgetProgram);
          gu.f2("uRes", width, height);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.enable(gl.SCISSOR_TEST);
          gu.i1("uKind", KIND_STRIP);
          for (let i = 0; i < layout.strips.length; i++) {
            const [x, y, , hh] = layout.strips[i];
            const pulse =
              1 -
              STRIP_DEPTH * (0.5 + 0.5 * Math.sin((2 * Math.PI * time) / STRIP_PERIOD + i * 1.9));
            gu.f4("uBox", x, y, 0.04, hh);
            gu.f4("uVal", pulse, 0, 0, 0);
            drawGadget(x, y, 0.04, hh);
          }
          gu.i1("uKind", KIND_SCREEN);
          for (let i = 0; i < 2; i++) {
            const [x, y, hw, hh] = layout.screens[i];
            gu.f4("uBox", x, y, hw, hh);
            gu.f4("uVal", (2 * Math.PI * (time % 60)) / 60 + i * 2.1, i, 0, 0);
            drawGadget(x, y, hw, hh);
          }
          const [gx, gy, gr] = layout.globe;
          gu.i1("uKind", KIND_GLOBE);
          gu.f4("uBox", gx, gy, gr, gr);
          gu.f4("uVal", (2 * Math.PI * (time % 90)) / 90, 0, 0, 0);
          drawGadget(gx, gy, gr * 1.3, gr * 1.3);

          // 8. The graphics: redraw any whose text, colour or size changed.
          if (p.name !== rawName || p.title !== rawTitle || p.accent !== rawAccent || lowerStale) {
            rawName = p.name;
            rawTitle = p.title;
            rawAccent = p.accent;
            lowerStale = false;
            name = sanitizeText(newsdeskMeta.params.name, p.name).trim();
            const title = sanitizeText(newsdeskMeta.params.title, p.title).trim();
            // An empty name hides the lower third: keep the last drawing to fade out.
            if (name !== "") {
              upload(lowerThird, drawLowerThird(name, title, accentRgb(p.accent), gfx, height));
            }
          }
          if (p.ticker !== rawTicker || tickerStale) {
            rawTicker = p.ticker;
            tickerStale = false;
            ticker = sanitizeText(newsdeskMeta.params.ticker, p.ticker).trim();
            const strip = ticker === "" ? null : drawTicker(ticker, gfx, height);
            if (strip) {
              upload(tickerTex, strip);
              tickerPeriod = strip.period;
              tickerRowH = strip.rowH;
              tickerPos = wrap(tickerPos, 0, tickerPeriod);
            }
          }
          const minute = dayMinute(day.step(step, "local", 0, 0));
          if (p.live && minute !== liveMinute) {
            liveMinute = minute;
            upload(liveTag, drawLiveTag(clockText(minute / 1440), gfx, height));
          }
          const accent = accentRgb(p.accent);
          nameLevel = stepReveal(nameLevel, name !== "", step);
          tickerLevel = stepReveal(tickerLevel, ticker !== "", step);
          liveLevel = stepReveal(liveLevel, p.live, step);
          const nameShown = revealShown(nameLevel);
          const tickerShown = revealShown(tickerLevel);
          const liveShown = revealShown(liveLevel);
          tickerPos = stepTicker(tickerPos, step, tickerSpeed(scale, p.tickerSpeed), tickerPeriod);

          // The ticker strip, sliding up from below.
          const rowH = Math.max(4, Math.round(gfx.tickerH * height));
          if (tickerShown > 0) {
            const base = -Math.round((1 - tickerShown) * rowH);
            const y1 = Math.min(height, base + rowH);
            if (y1 > 0) {
              gl.useProgram(tickerProgram);
              gl.bindTexture(gl.TEXTURE_2D, tickerTex.texture.texture);
              tu.f2("uRes", width, height);
              tu.i1("uBase", base);
              tu.i1("uRowH", rowH);
              const text = tickerTex.ready && tickerRowH === rowH;
              tu.i1("uText", text ? 1 : 0);
              tu.i1("uPeriod", Math.max(1, tickerPeriod));
              tu.i1("uOffset", tickerOffset(tickerPos, tickerPeriod));
              tu.v3("uAccent", accent);
              tu.f1("uAlpha", tickerShown);
              gl.scissor(0, 0, width, y1);
              triangle.draw();
            }
          }

          // The lower third, sliding in from the left; the LIVE tag fading in at the top.
          gl.useProgram(blitProgram);
          if (nameShown > 0) {
            const bottom = gfx.bottomNoTicker + (gfx.bottom - gfx.bottomNoTicker) * tickerShown;
            const x = Math.round(pxX(gfx.left - SLIDE * (1 - nameShown)));
            blit(lowerThird, x, Math.round(pxY(bottom)), nameShown);
          }
          if (liveShown > 0) {
            const x = Math.round(pxX(gfx.liveX));
            blit(liveTag, x, Math.round(pxY(gfx.liveY)) - liveTag.height, liveShown);
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
