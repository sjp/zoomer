import { createOsdDrawer, osdText, paintStamp } from "../camcorder-osd";
import { createCanvasTexture, paintCanvas } from "../canvas-texture";
import { createChangeKey } from "../change-key";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat as F,
  scopedProgram,
  withScope,
} from "../gl";
import { EASED_GRAIN_GLSL } from "../grain";
import { createLowResTarget } from "../lowres";
import { approach, clamp } from "../math";
import { HASH32_GLSL, hash32 } from "../noise";
import { SDF2D_GLSL } from "../sdf-glsl";
import { defineEffect } from "../types";
import {
  advanceTape,
  BAND_HALF,
  BAND_MIX,
  bandCentre,
  COVER_MIX,
  coverLevel,
  createTape,
  feetY,
  FIGURE_HEIGHT,
  figureX,
  GRAIN_HZ,
  HALL_HALF_WIDTH,
  hallFlipped,
  hallVanishX,
  HORIZON,
  jitterAt,
  JITTER_PX,
  type Place,
  placeParam,
  requestBurst,
  reseedTape,
  SPLIT,
  stampStart,
  STATIC_GAIN,
  STATIC_LIFT,
  STATIC_NOISE,
  stationDepth,
  troubleLevel,
  WOBBLE_AMP,
  WOBBLE_HZ,
  WOBBLE_WAVES,
} from "./staticfigure-sim";
import { staticfigureMeta } from "./staticfigure.meta";

const TAU = Math.PI * 2;
/** The tape plays back this many lines tall (at least), upscaled smoothly. */
const TAPE_LINES = 480;
/** Seconds a tape-wear change eases over (per full slider range), and the overlay's fade. */
const TAPE_EASE = 1;
const OVERLAY_FADE = 0.5;
/** Tape grain's depth at full wear (luma, peak), and the least at none. */
const GRAIN_DEPTH = 0.07;
const GRAIN_MIN = 0.015;
/** How far the colour lags the picture, frame heights: at no wear and at full. */
const BLEED_MIN = 0.002;
const BLEED_MAX = 0.007;
/** The burst's static re-seeds this many times a second. */
const STATIC_HZ = 15;
/** The head-switching strip at the bottom: its height (frame heights) and its tear's re-seeds a second. */
const HEAD_HEIGHT = 0.018;
const HEAD_HZ = 4;
/** On-screen display, in px at 1080p: text size and margin from the frame's edge. */
const OSD_PX = 34;
const OSD_MARGIN = 54;
/** The scenes' focal length: frame heights per unit of x / z. */
const FOCAL = 0.75;
/** Eye height, metres. */
const EYE = 1.6;

const PLACE_INDEX: Readonly<Record<Place, number>> = { field: 0, carpark: 1, hallway: 2 };

/**
 * The scene, painted once per resize, place, variation or swap into the tape's
 * low-res target: the field, the car park or the hallway, then the figure.
 * Coordinates are frame heights from the frame's centre, y up.
 */
const SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform int uPlace;
uniform uint uSeed;
/** Half the frame's width, frame heights. */
uniform float uHalf;
/** The side the fence or the lamp is on (-1, 1). */
uniform float uSide;
/** The hallway's vanishing point's x; the lamp's x. */
uniform vec2 uX;
/** The figure: x, feet y, height (frame heights), opacity. */
uniform vec4 uFig;
uniform float uTilt;
out vec4 outColor;
${SDF2D_GLSL}
${HASH32_GLSL}

const float FOCAL = ${F(FOCAL)};
const float EYE = ${F(EYE)};

float rand(vec2 cell, uint salt) {
  uvec2 u = uvec2(ivec2(floor(cell)) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ salt ^ uSeed))) / 4294967296.0;
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
float fbm(vec2 p, uint salt) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p, salt + uint(i) * 101u);
    p = p * 2.03 + vec2(17.1, 9.3);
    a *= 0.5;
  }
  return s / 0.9375;
}
/** A tapering stroke from a (width w0) to b (width w1). */
float stroke(vec2 p, vec2 a, vec2 b, float w0, float w1) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(w0, w1, h);
}
/** Coverage of a world-space line pattern: 1 within half-width w of a multiple of period, AA'd by footprint fw. */
float lines(float x, float period, float w, float fw) {
  float d = abs(fract(x / period + 0.5) - 0.5) * period;
  return clamp(0.5 - (d - w) / max(fw, 1e-4), 0.0, 1.0);
}

// --- The field at dusk ---

vec3 field(vec2 p) {
  const float H = ${F(HORIZON.field)};
  vec3 col;
  if (p.y >= H) {
    float t = p.y - H;
    col = mix(vec3(0.62, 0.5, 0.42), vec3(0.4, 0.41, 0.46), smoothstep(0.0, 0.25, t));
    col = mix(col, vec3(0.25, 0.27, 0.32), smoothstep(0.2, 0.45, t));
    col *= 0.86 + 0.26 * fbm(vec2(p.x * 1.4, t * 6.0), 3u);
  } else {
    float g = H - p.y;
    col = mix(vec3(0.4, 0.38, 0.29), vec3(0.2, 0.22, 0.12), smoothstep(0.0, 0.3, g));
    // Long grass: streaks that grow nearer the camera, in wind-combed patches.
    float detail = smoothstep(0.0, 0.05, g);
    float streak = vnoise(vec2(p.x * 120.0 / (0.3 + 3.0 * g), p.y * 30.0 / (0.2 + g)), 11u);
    float clump = fbm(vec2(p.x * 1.5 / (g + 0.05), 1.0 / (g + 0.05)), 13u);
    col *= 0.8 + detail * (0.28 * streak + 0.3 * (clump - 0.5));
    col = mix(col, vec3(0.5, 0.45, 0.39), 0.5 * exp(-g * 28.0));
  }
  // The treeline along the horizon.
  float top = H + 0.018 + 0.04 * fbm(vec2(p.x * 2.6, 0.5), 5u) + 0.018 * vnoise(vec2(p.x * 45.0, 1.5), 7u)
    + 0.008 * vnoise(vec2(p.x * 120.0, 3.5), 8u);
  float tree = cover(p.y - top) * step(H - 0.004, p.y);
  col = mix(col, vec3(0.11, 0.12, 0.11) * (0.85 + 0.3 * vnoise(p * vec2(60.0, 40.0), 9u)), tree);
  // A fence on one side: posts going away from the camera, with two wires.
  float post = 1e3;
  float wire = 1e3;
  vec2 prevTop = vec2(0.0);
  vec2 prevMid = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    float z = i == 0 ? 3.6 : i == 1 ? 6.0 : i == 2 ? 9.5 : 15.0;
    float lean = (rand(vec2(float(i), 3.0), 21u) - 0.5) * 0.12;
    vec2 base = vec2(uSide * 2.2 * FOCAL / z, H - EYE * FOCAL / z);
    vec2 up = vec2(lean, 1.0) * 1.25 * FOCAL / z;
    float w = 0.07 * FOCAL / z;
    post = min(post, stroke(p, base, base + up, w, w * 0.8));
    vec2 tp = base + up * 0.92;
    vec2 mp = base + up * 0.5;
    if (i > 0) {
      wire = min(wire, sdSeg(p, prevTop, tp));
      wire = min(wire, sdSeg(p, prevMid, mp));
    }
    prevTop = tp;
    prevMid = mp;
  }
  col = mix(col, vec3(0.14, 0.12, 0.1), 0.7 * clamp(1.0 - (wire - 0.0003) / px, 0.0, 1.0));
  col = mix(col, vec3(0.16, 0.13, 0.1), cover(post));
  // Near grass in front of it all along the bottom.
  float blades = -0.4 + 0.05 * vnoise(vec2(p.x * 70.0, 0.5), 15u) + 0.035 * vnoise(vec2(p.x * 19.0, 2.5), 17u);
  col = mix(col, vec3(0.1, 0.11, 0.06), 0.85 * cover(p.y - blades));
  return col;
}

// --- The car park at night ---

vec3 carpark(vec2 p) {
  const float H = ${F(HORIZON.carpark)};
  vec3 sodium = vec3(1.0, 0.56, 0.2);
  float lampZ = 9.0;
  float lampX = uX.y * lampZ / FOCAL;
  vec2 base = vec2(uX.y, H - EYE * FOCAL / lampZ);
  vec2 head = base + vec2(0.0, 5.5 * FOCAL / lampZ);
  vec3 col;
  if (p.y >= H) {
    float t = p.y - H;
    col = mix(vec3(0.14, 0.11, 0.09), vec3(0.05, 0.05, 0.07), smoothstep(0.0, 0.3, t));
    col *= 0.9 + 0.2 * fbm(vec2(p.x * 1.2, t * 4.0), 3u);
    // A low wall and a dark hedge along the far side.
    float hedge = H + 0.01 + 0.03 * fbm(vec2(p.x * 3.0, 0.5), 5u) + 0.01 * vnoise(vec2(p.x * 40.0, 2.5), 6u);
    col = mix(col, vec3(0.06, 0.065, 0.06), cover(p.y - hedge));
    // The building's edge on the side away from the lamp.
    float edge = -uSide * uHalf * 0.6;
    float inside = -uSide * (p.x - edge);
    float roof = H + 0.3;
    float bld = cover(-inside) * cover(p.y - roof);
    vec3 wall = vec3(0.065, 0.06, 0.06) * (0.9 + 0.2 * vnoise(p * 50.0, 7u));
    // Its windows: a grid of panes, almost all dark.
    vec2 cell = vec2(inside / 0.05, (p.y - H) / 0.055);
    vec2 f = fract(cell);
    float pane = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.8) * step(1.0, cell.y);
    float lit = step(0.93, rand(floor(cell), 19u));
    wall = mix(wall, mix(vec3(0.035, 0.035, 0.04), vec3(0.32, 0.27, 0.17), lit), pane);
    col = mix(col, wall, bld);
  } else {
    float g = H - p.y;
    float z = EYE * FOCAL / g;
    float x = p.x * z / FOCAL;
    vec2 w = vec2(x, z);
    vec2 fw = vec2(fwidth(x), fwidth(z));
    float detail = smoothstep(0.0, 0.04, g);
    col = vec3(0.24, 0.23, 0.22) * (0.85 + detail * 0.25 * vnoise(w * 2.5, 11u));
    col *= 1.0 - 0.25 * smoothstep(0.55, 0.8, fbm(w * 0.25, 13u));
    // Two rows of bays.
    float row = smoothstep(7.8, 8.0, z) * (1.0 - smoothstep(13.0, 13.2, z))
      + smoothstep(17.8, 18.0, z) * (1.0 - smoothstep(23.0, 23.2, z));
    float paint = lines(x + 1.3, 2.6, 0.06, fw.x) * row;
    paint = max(paint, lines(z - 8.0, 5.0, 0.06, fw.y) * step(7.5, z) * step(z, 13.5));
    paint = max(paint, lines(z - 18.0, 5.0, 0.06, fw.y) * step(17.5, z) * step(z, 23.5));
    col = mix(col, vec3(0.52, 0.5, 0.43), 0.55 * paint * detail);
    // Light: dim everywhere, and the lamp's orange pool.
    vec2 d = (w - vec2(lampX, lampZ)) / vec2(6.5, 8.0);
    float pool = exp(-dot(d, d));
    col *= 0.55 + 3.0 * pool * sodium;
  }
  // The lamp: a pole, its head, and a faint glow round it.
  float pole = stroke(p, base, head, 0.08 * FOCAL / lampZ, 0.06 * FOCAL / lampZ);
  pole = min(pole, stroke(p, head, head + vec2(-uSide * 0.9, 0.05) * FOCAL / lampZ, 0.04 * FOCAL / lampZ, 0.04 * FOCAL / lampZ));
  col = mix(col, vec3(0.05, 0.045, 0.04), cover(pole));
  vec2 lamp = head + vec2(-uSide * 0.9, 0.0) * FOCAL / lampZ;
  float lh = sdBox(p - lamp, vec2(0.5, 0.1) * FOCAL / lampZ, 0.002);
  col = mix(col, vec3(1.0, 0.78, 0.48), cover(lh));
  vec2 q = (p - lamp) / vec2(1.0, 1.3);
  col += sodium * 0.22 * exp(-dot(q, q) / 0.004);
  // The light falling from it.
  float below = lamp.y - p.y;
  float cone = smoothstep(0.0, 0.05, below) * (1.0 - smoothstep(0.0, 0.25 * max(below, 1e-3) + 0.01, abs(p.x - lamp.x)));
  col += sodium * 0.035 * cone * step(0.0, below) * step(base.y, p.y);
  return col;
}

// --- The hallway ---

vec3 hallway(vec2 p) {
  const float H = ${F(HORIZON.hallway)};
  const float W = ${F(HALL_HALF_WIDTH * EYE)};
  const float CEIL = 1.1;
  const float END = 24.0;
  vec2 d = vec2(p.x - uX.x, p.y - H);
  float zw = W * FOCAL / max(abs(d.x), 1e-5);
  float zf = d.y < 0.0 ? EYE * FOCAL / -d.y : CEIL * FOCAL / max(d.y, 1e-5);
  float z = min(min(zw, zf), END);
  vec3 col;
  float light;
  // Fine lines fade out down the hallway, where they would crowd together.
  float near = 1.0 - smoothstep(8.0, 18.0, z);
  // Light from the ceiling panels, one every 4 m, evening out with distance.
  float bay = mix(0.5, 0.5 + 0.5 * cos(6.2831853 * (z - 2.0) / 4.0), near);
  if (z >= END) {
    // The far end: a pale wall lit from a stairwell, with double doors.
    vec2 e = d * END / FOCAL;
    col = vec3(0.6, 0.6, 0.54);
    float door = sdBox(e - vec2(0.0, -EYE + 1.05), vec2(0.8, 1.05), 0.0);
    col = mix(col, vec3(0.34, 0.3, 0.24), cover(door * FOCAL / END));
    light = 4.0;
  } else if (zf < zw) {
    float x = d.x * z / FOCAL;
    vec2 fw = vec2(fwidth(x), fwidth(z));
    if (d.y < 0.0) {
      // Lino: big pale tiles, a worn path down the middle and the panels' sheen.
      vec2 t = vec2(x, z) / 0.6;
      float checker = mod(floor(t.x) + floor(t.y), 2.0);
      col = mix(vec3(0.44, 0.42, 0.35), vec3(0.38, 0.37, 0.31), checker);
      col *= 1.0 - 0.15 * near * max(lines(x, 0.6, 0.0, fw.x * 1.5), lines(z, 0.6, 0.0, fw.y * 1.5));
      col *= 0.92 + 0.12 * vnoise(vec2(x, z) * 3.0, 11u);
      col += vec3(0.12) * exp(-x * x * 6.0) * bay * bay;
    } else {
      // Ceiling tiles, and the light panels down the middle.
      col = vec3(0.58, 0.57, 0.53);
      col *= 1.0 - 0.2 * near * max(lines(x, 0.6, 0.0, fw.x * 1.5), lines(z, 0.6, 0.0, fw.y * 1.5));
      float zp = mod(z - 1.4, 4.0);
      float panel = step(abs(x), 0.3) * step(zp, 1.2);
      float dead = step(0.8, rand(vec2(floor((z - 1.4) / 4.0), 1.0), 23u));
      col = mix(col, mix(vec3(1.0, 1.0, 0.94), vec3(0.5, 0.5, 0.47), dead), panel);
    }
    light = 0.4 + 0.6 * bay;
  } else {
    // The walls: cream above a green dado, with doors every few metres.
    float y = d.y * z / FOCAL;
    float side = sign(d.x);
    vec2 fw = vec2(fwidth(z), fwidth(y));
    col = y < -EYE + 1.0 ? vec3(0.3, 0.38, 0.31) : vec3(0.62, 0.6, 0.52);
    col *= 1.0 - 0.3 * near * clamp(1.0 - abs(y + EYE - 1.0) / max(fw.y * 1.5, 0.01), 0.0, 1.0);
    col *= 0.94 + 0.1 * vnoise(vec2(z, y) * 2.0, side > 0.0 ? 29u : 31u);
    float offset = side > 0.0 ? 1.5 : 4.5;
    float k = floor((z - offset) / 6.0);
    float u = z - offset - k * 6.0;
    float doorD = max(abs(u - 0.5) - 0.5, max(y - (-EYE + 2.1), -EYE - y));
    float frame = max(abs(u - 0.5) - 0.58, max(y - (-EYE + 2.18), -EYE - y));
    float fwz = max(fw.x, fw.y) * 1.5;
    float inFrame = clamp(0.5 - frame / fwz, 0.0, 1.0);
    float inDoor = clamp(0.5 - doorD / fwz, 0.0, 1.0);
    vec3 wood = mix(vec3(0.27, 0.19, 0.12), vec3(0.2, 0.2, 0.22), step(0.6, rand(vec2(k, side), 37u)));
    col = mix(col, vec3(0.48, 0.44, 0.38), inFrame);
    col = mix(col, wood, inDoor);
    // A small dark window in the door.
    float glass = max(abs(u - 0.5) - 0.12, abs(y - (-EYE + 1.55)) - 0.25);
    col = mix(col, vec3(0.08, 0.09, 0.1), inDoor * clamp(0.5 - glass / fwz, 0.0, 1.0));
    light = 0.4 + 0.6 * bay;
  }
  // Further away, dimmer.
  col *= light * mix(1.0, 0.25, smoothstep(3.0, 22.0, z));
  return col;
}

// --- The figure ---

/** Signed distance to the figure, in its heights: feet at the origin, head at about 1. */
float figure(vec2 q) {
  float d = stroke(q, vec2(-0.03, 0.5), vec2(-0.036, 0.0), 0.022, 0.013);
  d = min(d, stroke(q, vec2(0.03, 0.5), vec2(0.036, 0.0), 0.022, 0.013));
  d = min(d, stroke(q, vec2(0.0, 0.785), vec2(0.0, 0.48), 0.055, 0.04));
  for (int i = 0; i < 2; i++) {
    float s = i == 0 ? -1.0 : 1.0;
    vec2 sh = vec2(s * 0.062, 0.77);
    vec2 el = vec2(s * 0.083, 0.55);
    vec2 ha = vec2(s * 0.088, 0.3);
    d = min(d, stroke(q, sh, el, 0.018, 0.014));
    d = min(d, stroke(q, el, ha, 0.014, 0.01));
    d = min(d, stroke(q, ha, ha + vec2(s * 0.008, -0.06), 0.009, 0.003));
  }
  // The head, tilted about the neck.
  vec2 neck = vec2(0.0, 0.82);
  float c = cos(uTilt);
  float sn = sin(uTilt);
  vec2 h = mat2(c, sn, -sn, c) * (q - neck);
  d = min(d, stroke(h, vec2(0.0, -0.04), vec2(0.0, 0.03), 0.016, 0.014));
  vec2 e = (h - vec2(0.0, 0.08)) / vec2(0.042, 0.06);
  d = min(d, (length(e) - 1.0) * 0.042);
  return d;
}

void main() {
  px = 1.0 / uRes.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) * px;
  vec3 col = uPlace == 0 ? field(p) : uPlace == 1 ? carpark(p) : hallway(p);
  if (uFig.w > 0.0) {
    vec2 q = (p - uFig.xy) / uFig.z;
    float soft = (0.0035 + 1.5 * px) / uFig.z;
    float a = 1.0 - smoothstep(-soft, soft, figure(q));
    // In the field, its feet are lost in the grass.
    a *= uPlace == 0 ? smoothstep(0.0, 0.12, q.y) : 1.0;
    col = mix(col, vec3(0.025, 0.024, 0.028), a * uFig.w);
  }
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/**
 * The tape pass, upscaling the scene to the screen: vertical jitter, the
 * head-switching tear at the bottom, colour that lags the picture, slow luma
 * grain, a burst's static, band, tracking wobble and colour split, then the
 * washed-out grade and a vignette.
 */
const TAPE_COMPOSITE = /* glsl */ `
uniform float uAspect;
/** Jitter (uv), colour lag (uv x), colour split (uv x), grain depth. */
uniform vec4 uTape;
/** The heavy static's mix, the band's mix, the band's centre (uv y), its half height (uv). */
uniform vec4 uStatic;
/** The wobble: swing (uv x), phase, waves (radians per uv y). */
uniform vec3 uWobble;
uniform vec2 uGrainMix;
uniform uint uGrainSeed;
uniform uint uStaticSeed;
uniform uint uHeadSeed;
${HASH32_GLSL}
${EASED_GRAIN_GLSL}
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float HEAD = ${F(HEAD_HEIGHT)};
const float LIFT = ${F(STATIC_LIFT)};
const float NOISE = ${F(STATIC_NOISE)};
const float GAIN = ${F(STATIC_GAIN)};
float rand01(uint a, uint b) {
  return float(hash32(a * 0x9e3779b9u ^ hash32(b)) >> 8) * (1.0 / 16777216.0);
}
vec4 composite(vec2 uv) {
  vec2 q = uv;
  q.y += uTape.x;
  float row = floor(clamp(q.y, 0.0, 1.0) * uLowResSize.y);
  // Tracking wobble, and the band tearing its rows sideways.
  float shift = uWobble.x * sin(q.y * uWobble.z + uWobble.y);
  float bd = (uv.y - uStatic.z) / uStatic.w;
  float band = uStatic.y * exp(-bd * bd);
  shift += band * 0.012 * (rand01(uint(row), uStaticSeed) - 0.5);
  // Head switching: the bottom rows torn to the right.
  float hs = 1.0 - smoothstep(0.0, HEAD, q.y);
  shift += hs * (0.004 + 0.012 * rand01(uint(row), uHeadSeed));
  q.x += shift;
  vec3 c = texture(uLowRes, q).rgb;
  float y = dot(c, LUMA);
  // Colour lags the picture (and splits further in a burst).
  vec2 lag = vec2(uTape.y + uTape.z, 0.0);
  vec3 c1 = texture(uLowRes, q - lag).rgb;
  vec3 c2 = texture(uLowRes, q - 2.0 * lag).rgb;
  vec3 cc = (c + c1 + c2) * (1.0 / 3.0);
  vec3 chroma = cc - dot(cc, LUMA);
  uvec2 cell = uvec2(clamp(q, 0.0, 1.0) * (uLowResSize - 1.0));
  y += uTape.w * easedGrain(cell, uGrainSeed, uGrainMix);
  y += hs * 0.2 * (rand01(cell.x / 3u, cell.y ^ uHeadSeed) - 0.5);
  if (uStatic.x + uStatic.y > 0.0) {
    float m = 1.0 - (1.0 - uStatic.x) * (1.0 - band);
    // Static: the picture blurred sideways, lifted, with streaky luma noise.
    float dx = 0.02 / uAspect;
    float b = 0.25 * (dot(texture(uLowRes, q + vec2(dx, 0.0)).rgb, LUMA)
      + dot(texture(uLowRes, q - vec2(dx, 0.0)).rgb, LUMA)
      + dot(texture(uLowRes, q + vec2(2.5 * dx, 0.0)).rgb, LUMA)
      + dot(texture(uLowRes, q - vec2(2.5 * dx, 0.0)).rgb, LUMA));
    float n = rand01(cell.x / 2u + cell.y * 7919u, uStaticSeed) - 0.5;
    float s = b + LIFT + (GAIN * b + NOISE) * n;
    y = mix(y, s, m);
    chroma *= 1.0 - m;
  }
  vec3 col = y + chroma * 0.75;
  // Washed out: lifted blacks, dulled whites, a faint green-yellow cast.
  col = (0.045 + 0.88 * col) * vec3(0.98, 1.0, 0.92);
  vec2 v = uv - 0.5;
  float r = length(v * vec2(uAspect, 1.0)) / length(vec2(0.5 * uAspect, 0.5));
  col *= 1.0 - 0.45 * smoothstep(0.35, 1.0, r);
  return vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/** Paints "PLAY" and its arrow. */
function paintPlay(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  const px = h / 1.3;
  osdText(ctx, px, h * 0.08, h * 0.12, "PLAY", "left");
  // Monospaced glyphs are about 0.6 em wide.
  const x = h * 0.08 + px * (4 * 0.6 + 0.45);
  const top = h * 0.12 + px * 0.12;
  const size = px * 0.72;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x + size * 0.85, top + size / 2);
  ctx.lineTo(x, top + size);
  ctx.closePath();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, px * 0.14);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
  ctx.stroke();
  ctx.fillStyle = "#f4f4ee";
  ctx.fill();
}

/** Which side variation `seed` puts the field's fence and the car park's lamp on. */
const sceneSide = (seed: number) => ((hash32(Math.floor(seed) ^ 0x4c1f) & 1) === 1 ? 1 : -1);

/**
 * Static Figure: a worn videotape of an empty place. The scene (and the figure,
 * when it's there) is painted once into a low-res target at tape resolution;
 * each frame one full-screen pass plays it back with the tape's wear and any
 * burst of static, and the on-screen display is drawn over it. The figure moves
 * only at a burst's height, under heavy static.
 */
export const staticfigure = defineEffect(staticfigureMeta, {
  create(gl) {
    return withScope((scope) => {
      const sceneProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, SCENE_FRAGMENT);
      const su = createUniforms(gl, sceneProgram, [
        "uRes",
        "uPlace",
        "uSeed",
        "uHalf",
        "uSide",
        "uX",
        "uFig",
        "uTilt",
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl, { composite: TAPE_COMPOSITE, keep: true }));
      const tu = createUniforms(gl, target.program, [
        "uAspect",
        "uTape",
        "uStatic",
        "uWobble",
        "uGrainMix",
        "uGrainSeed",
        "uStaticSeed",
        "uHeadSeed",
      ]);
      const osd = createOsdDrawer(gl, scope);
      const stampTex = createCanvasTexture(gl, scope, { premultiply: true });
      const playTex = createCanvasTexture(gl, scope, { premultiply: true });
      let stampCtx: OffscreenCanvasRenderingContext2D | null = null;
      /** Overlay sizes in px: text line, stamp width and height, PLAY label width and height, margin. */
      let osdSize = 0;
      let stampW = 1;
      let stampH = 1;
      let playW = 1;
      let playH = 1;
      let margin = 0;
      let stampSecond = Number.NaN;

      /** What the painted scene shows: place, variation and the figure's station. */
      const key = createChangeKey(3);
      let tape = createTape(1);
      let place: Place = "field";
      let seed = Number.NaN;
      /** Seconds the current place has been on tape, for the date stamp, and its start. */
      let placeTime = 0;
      let stampBase = 0;
      let wear = Number.NaN;
      let overlayAlpha = Number.NaN;
      let wobblePhase = 0;

      let width = 1;
      let height = 1;
      let scale = 1;

      const layoutOverlay = () => {
        const size = Math.max(4, Math.round(OSD_PX * Math.max(scale, 0.01)));
        if (size === osdSize) {
          return;
        }
        osdSize = size;
        margin = Math.round(OSD_MARGIN * scale);
        stampW = Math.round(size * 7.4);
        stampH = Math.round(size * 2.6);
        playW = Math.round(size * 4.6);
        playH = Math.round(size * 1.3);
        // Kept to repaint each second; null without OffscreenCanvas (tests, old browsers).
        stampCtx = paintCanvas(stampW, stampH, () => undefined)?.getContext("2d") ?? null;
        stampSecond = Number.NaN;
        const play = paintCanvas(playW, playH, (ctx) => {
          paintPlay(ctx, playW, playH);
        });
        if (play) {
          playTex.upload(play);
        }
      };

      const paintScene = () => {
        const aspect = width / Math.max(1, height);
        const flipped = hallFlipped(seed);
        const depth: number = stationDepth(tape.station);
        let fx = 0;
        let fy = 0;
        let fh = 1;
        let fa = 0;
        if (depth >= 0) {
          const s = tape.station;
          fx = figureX(place, depth, tape.side[s], tape.u[s], aspect, flipped);
          fy = feetY(place, depth);
          fh = FIGURE_HEIGHT[depth];
          fa = Number.isFinite(fx) ? 1 : 0;
        }
        target.bind();
        gl.useProgram(sceneProgram);
        su.f2("uRes", target.width, target.height);
        su.i1("uPlace", PLACE_INDEX[place]);
        su.u1("uSeed", hash32(Math.floor(seed) ^ 0x9d2c5680));
        su.f1("uHalf", aspect / 2);
        const side = sceneSide(seed);
        su.f1("uSide", side);
        su.f2("uX", hallVanishX(aspect, flipped), side * 0.3 * aspect);
        su.f4("uFig", Number.isFinite(fx) ? fx : 0, fy, fh, fa);
        su.f1("uTilt", depth >= 0 ? tape.tilt[tape.station] : 0);
        triangle.draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale;
        },
        frame(dt, p) {
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          if (Number.isNaN(seed)) {
            seed = p.seed;
            tape = createTape(seed);
            place = placeParam(p.place);
            stampBase = stampStart(seed, place);
            wear = clamp(p.tape, 0, 1);
            overlayAlpha = p.overlay ? 1 : 0;
          }
          // A new place or variation waits for a burst of static to hide it.
          const wantPlace = placeParam(p.place);
          if (wantPlace !== place || p.seed !== seed) {
            requestBurst(tape);
          }
          if (advanceTape(tape, step, p.interval, p.presence)) {
            if (p.seed !== seed) {
              seed = p.seed;
              reseedTape(tape, seed);
              placeTime = 0;
              stampBase = stampStart(seed, wantPlace);
            }
            if (wantPlace !== place) {
              place = wantPlace;
              placeTime = 0;
              stampBase = stampStart(seed, place);
            }
          }
          placeTime += step;
          wear = approach(
            wear,
            clamp(Number.isFinite(p.tape) ? p.tape : 0.5, 0, 1),
            step / TAPE_EASE,
          );
          overlayAlpha = approach(overlayAlpha, p.overlay ? 1 : 0, step / OVERLAY_FADE);
          wobblePhase = (wobblePhase + step * WOBBLE_HZ * TAU) % TAU;

          beginFrame(gl, width, height);
          target.resize(width, height, Math.max(1, height / TAPE_LINES));
          key.set(0, PLACE_INDEX[place]);
          key.set(1, seed);
          key.set(2, tape.station);
          if (target.needsRedraw(key)) {
            paintScene();
          }

          // Play the tape back.
          const aspect = width / height;
          const trouble = troubleLevel(tape);
          const cover = coverLevel(tape);
          const t = tape.time;
          const jitter = jitterAt(t, seed, wear) * Math.max(1, Math.round(JITTER_PX * scale));
          const g = t * GRAIN_HZ;
          const ease = (g - Math.floor(g)) * (Math.PI / 2);
          gl.useProgram(target.program);
          tu.f1("uAspect", aspect);
          tu.f4(
            "uTape",
            jitter / height,
            (BLEED_MIN + (BLEED_MAX - BLEED_MIN) * wear) / aspect,
            (tape.split * SPLIT * trouble) / aspect,
            GRAIN_MIN + (GRAIN_DEPTH - GRAIN_MIN) * wear,
          );
          tu.f4("uStatic", COVER_MIX * cover, BAND_MIX * trouble, bandCentre(tape), BAND_HALF);
          tu.f3("uWobble", (WOBBLE_AMP * trouble) / aspect, wobblePhase, WOBBLE_WAVES * TAU);
          tu.f2("uGrainMix", Math.cos(ease), Math.sin(ease));
          tu.u1("uGrainSeed", Math.floor(g) >>> 0);
          tu.u1("uStaticSeed", (tape.noise + Math.floor(t * STATIC_HZ)) >>> 0);
          tu.u1("uHeadSeed", (Math.floor(t * HEAD_HZ) * 0x2545) >>> 0);
          target.blit();
          gl.bindTexture(gl.TEXTURE_2D, null);

          // The player's display: PLAY top left, the date stamp bottom right.
          if (overlayAlpha <= 0) {
            return;
          }
          layoutOverlay();
          const second = Math.floor(placeTime);
          if (stampCtx && second !== stampSecond) {
            stampSecond = second;
            paintStamp(stampCtx, stampW, stampH, stampBase + second * 1000);
            stampTex.upload(stampCtx.canvas);
          }
          osd.begin();
          osd.draw(playTex.texture, margin, margin, playW, playH, overlayAlpha, height);
          osd.draw(
            stampTex.texture,
            width - margin - stampW,
            height - margin - stampH,
            stampW,
            stampH,
            overlayAlpha,
            height,
          );
          osd.end(width, height);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
