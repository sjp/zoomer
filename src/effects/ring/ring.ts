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
  scopedProgram,
} from "../gl";
import { LAND_MASK_BIAS, LAND_MASK_GAIN, loadLandMask, uploadLandMask } from "../land-mask";
import { HASH32_GLSL } from "../noise";
import {
  buildClouds,
  buildSurface,
  CLOUD_H,
  CLOUD_SOFT,
  CLOUD_W,
  cloudShaping,
  SURFACE_H,
  SURFACE_W,
  WORLDS,
} from "../planet/planet-sim";
import { STAR_TINT_GLSL } from "../starfield";
import { defineEffect } from "../types";
import {
  CEILING_H,
  EYE_Y,
  FORWARD,
  HALF_W,
  INDICATOR_H,
  INDICATOR_HALF,
  INDICATOR_LAMP,
  INDICATOR_S,
  LIGHT_HALF,
  LIGHT_STEP,
  RING_R,
  SEATS,
  seatBoxes,
  TAN_HALF_FOV,
  UP,
  WINDOW_CORNER,
  WINDOW_FIRST,
  WINDOW_FRAME,
  WINDOW_HALF,
  WINDOW_STEP,
  WINDOW_Y0,
  WINDOW_Y1,
} from "./ring-layout";
import {
  advanceSpin,
  BODIES,
  bodyFrame,
  bodyInView,
  indicatorColour,
  spinAngle,
  START_PHASE,
  WASH,
} from "./ring-sim";
import { ringMeta } from "./ring.meta";
import { cameraRayGlsl, SUPERSAMPLE4_GLSL } from "../room-ray";

const g = glslFloat;
const v3 = (v: readonly number[]) => `vec3(${g(v[0])}, ${g(v[1])}, ${g(v[2])})`;

/** The wash mask is smooth, so it renders at a quarter of the canvas size. */
const WASH_DIVISOR = 4;
/** Glass and lamp coverage share the room's alpha: glass in [0, GLASS_A], the lamp above LAMP_A. */
const GLASS_A = 0.6;
const LAMP_A = 0.7;
/** Star grid cell (radians; at most one star per cell) and the share of cells with a star (of 256). */
const STAR_CELL = 0.012;
const STAR_SHARE = 70;
/** Star Gaussian radius, in 1080p pixels. */
const STAR_SIGMA = 0.75;
/** Planet texture seed: the cloud cover over the Earth and the Moon's light and dark ground. */
const BODY_SEED = 1;
/** Cloud amount over the Earth (the Planet effect's 0..1 `clouds`). */
const EARTH_CLOUDS = 0.55;
const WASH_EARTH: readonly number[] = [0.4, 0.62, 1.0];
const WASH_MOON: readonly number[] = [0.85, 0.88, 1.0];

const seatBoxList = SEATS.flatMap((seat) => seatBoxes(seat));
const SEAT_COUNT = SEATS.length;

/** Shared GLSL: camera rays, the ring's surfaces and the windows. */
const COMMON_GLSL = /* glsl */ `
const float RING_R = ${g(RING_R)};
const float CEIL_R = ${g(RING_R - CEILING_H)};
const float CEILING_H = ${g(CEILING_H)};
const float HALF_W = ${g(HALF_W)};
const float EYE_Y = ${g(EYE_Y)};
${cameraRayGlsl(FORWARD, UP, TAN_HALF_FOV)}
`;

/**
 * The corridor, ray-traced once per resize or settings change: floor, ceiling
 * and walls of the ring, the seats, the windows' frames and glass and the wall
 * indicator. Four samples per pixel for smooth edges.
 *
 * Pass 0 writes the colour, with alpha marking the window glass's coverage
 * (0..GLASS_A) or the indicator lamp's (LAMP_A..1). Pass 1 writes the floor
 * mask the planet's light washes over.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uMirror;
uniform vec3 uAccent;
uniform int uPass;
out vec4 outColor;
${COMMON_GLSL}
const int SEATS = ${String(SEAT_COUNT)};
const float SEAT_A[${String(SEAT_COUNT)}] = float[](${SEATS.map((s) => g(s.s / RING_R)).join(", ")});
const vec3 BOX_LO[${String(2 * SEAT_COUNT)}] = vec3[](${seatBoxList.map((b) => v3(b.slice(0, 3))).join(", ")});
const vec3 BOX_HI[${String(2 * SEAT_COUNT)}] = vec3[](${seatBoxList.map((b) => v3(b.slice(3, 6))).join(", ")});
const vec3 WHITE = vec3(0.9, 0.9, 0.88);
const vec3 PANEL = vec3(1.0, 0.99, 0.95);

// Rotates (y, z) about the ring's axis by angle a (cosine c, sine s): forward
// along the ring is positive.
vec3 turn(vec3 p, float c, float s) {
  float vy = p.y - RING_R;
  return vec3(p.x, RING_R + vy * c - p.z * s, p.z * c + vy * s);
}
vec3 turnDir(vec3 d, float c, float s) {
  return vec3(d.x, d.y * c - d.z * s, d.z * c + d.y * s);
}

// Distance along d (from the eye) to a cylinder about the ring's axis: the far
// root from inside, the near root from outside. -1 on a miss.
float cylHit(vec3 d, float r, bool far) {
  float oy = EYE_Y - RING_R;
  float a = d.y * d.y + d.z * d.z;
  float b = oy * d.y;
  float c = oy * oy - r * r;
  float disc = b * b - a * c;
  if (a <= 0.0 || disc < 0.0) {
    return -1.0;
  }
  float t = (far ? -b + sqrt(disc) : -b - sqrt(disc)) / a;
  return t > 0.0 ? t : -1.0;
}

// Ring position (s, h) of a point.
vec2 ringCoords(vec3 p) {
  float vy = p.y - RING_R;
  return vec2(RING_R * atan(p.z, -vy), RING_R - length(vec2(vy, p.z)));
}

float sdRound(vec2 p, vec2 half_, float r) {
  vec2 q = abs(p) - half_ + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float windowDist(vec2 sh) {
  float k = max(0.0, floor((sh.x - ${g(WINDOW_FIRST)}) / ${g(WINDOW_STEP)} + 0.5));
  vec2 p = vec2(sh.x - ${g(WINDOW_FIRST)} - k * ${g(WINDOW_STEP)}, sh.y - ${g((WINDOW_Y0 + WINDOW_Y1) / 2)});
  return sdRound(p, vec2(${g(WINDOW_HALF)}, ${g((WINDOW_Y1 - WINDOW_Y0) / 2)}), ${g(WINDOW_CORNER)});
}

float sdBox(vec3 p, vec3 lo, vec3 hi) {
  vec3 q = abs(p - 0.5 * (lo + hi)) - 0.5 * (hi - lo);
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// Contact shadow from the seats on a nearby surface point.
float seatShadow(vec3 p) {
  float k = 1.0;
  for (int i = 0; i < SEATS; i++) {
    float a = SEAT_A[i];
    vec3 q = turn(p, cos(a), sin(a));
    float d = min(sdBox(q, BOX_LO[2 * i], BOX_HI[2 * i]), sdBox(q, BOX_LO[2 * i + 1], BOX_HI[2 * i + 1]));
    k *= 1.0 - 0.5 * exp(-max(d, 0.0) / 0.1);
  }
  return k;
}

// Slab test; returns the entry distance (or -1) and the entry face's normal.
float boxHit(vec3 o, vec3 d, vec3 lo, vec3 hi, out vec3 n) {
  vec3 inv = 1.0 / d;
  vec3 t0 = (lo - o) * inv;
  vec3 t1 = (hi - o) * inv;
  vec3 tn = min(t0, t1);
  vec3 tf = max(t0, t1);
  float enter = max(max(tn.x, tn.y), tn.z);
  float leave = min(min(tf.x, tf.y), tf.z);
  n = vec3(0.0);
  if (enter > leave || enter <= 0.0) {
    return -1.0;
  }
  if (enter == tn.x) {
    n.x = -sign(d.x);
  } else if (enter == tn.y) {
    n.y = -sign(d.y);
  } else {
    n.z = -sign(d.z);
  }
  return enter;
}

// Upholstery: the accent colour, lit from above, with soft rounded edges and a
// seam between modules.
vec3 seatColour(vec3 q, vec3 n, vec3 lo, vec3 hi) {
  vec3 a = min(q - lo, hi - q);
  float edge = n.x != 0.0 ? min(a.y, a.z) : (n.y != 0.0 ? min(a.x, a.z) : min(a.x, a.y));
  float light = 0.55 + 0.35 * n.y + 0.12 * abs(n.x);
  light *= 0.72 + 0.28 * smoothstep(0.0, 0.05, edge);
  light *= 0.65 + 0.35 * smoothstep(0.0, 0.18, q.y);
  float seam = abs(fract(q.z / 0.75 + 0.5) - 0.5) * 0.75;
  if (hi.z - lo.z > 1.0 && seam < 0.008 && n.z == 0.0) {
    light *= 0.6;
  }
  return uAccent * light;
}

// One ray: colour, plus glass and lamp coverage and the wash mask.
vec3 shade(vec3 d, out float glass, out float lamp, out float wash) {
  glass = 0.0;
  lamp = 0.0;
  wash = 0.0;
  vec3 eye = vec3(0.0, EYE_Y, 0.0);
  float t = cylHit(d, RING_R, true);
  int kind = 0;
  float tc = cylHit(d, CEIL_R, false);
  if (tc > 0.0 && tc < t) {
    t = tc;
    kind = 1;
  }
  if (abs(d.x) > 1e-6) {
    float tw = HALF_W / abs(d.x);
    if (tw < t) {
      t = tw;
      kind = d.x > 0.0 ? 3 : 2;
    }
  }
  // Seats, each in its own frame turned back to the floor under the camera.
  vec3 seatCol = vec3(0.0);
  vec3 sd = d + vec3(1e-7);
  for (int i = 0; i < SEATS; i++) {
    float c = cos(SEAT_A[i]);
    float s = sin(SEAT_A[i]);
    vec3 o = turn(eye, c, s);
    vec3 dl = turnDir(sd, c, s);
    for (int j = 0; j < 2; j++) {
      vec3 n;
      vec3 lo = BOX_LO[2 * i + j];
      vec3 hi = BOX_HI[2 * i + j];
      float tb = boxHit(o, dl, lo, hi, n);
      if (tb > 0.0 && tb < t) {
        t = tb;
        kind = 4;
        vec3 q = o + dl * tb;
        seatCol = seatColour(q, n, lo, hi);
        // Seats on the window side catch the planet's light on their tops.
        wash = q.x > 0.0 ? 0.8 * exp(-(HALF_W - q.x) / 1.1) * max(n.y, 0.0) : 0.0;
      }
    }
  }
  float far = mix(1.0, 0.9, smoothstep(6.0, 30.0, t));
  if (kind == 4) {
    return seatCol * far;
  }
  vec3 p = eye + d * t;
  vec2 sh = ringCoords(p);
  if (kind == 0) {
    // Floor: pale grey panels, darker where it meets the walls and under seats.
    float across = HALF_W - abs(p.x);
    float seam = abs(fract(sh.x / ${g(LIGHT_STEP)} + 0.5) - 0.5) * ${g(LIGHT_STEP)};
    float lseam = abs(abs(p.x) - 0.65);
    vec3 albedo = vec3(0.8, 0.8, 0.79) * (seam < 0.006 || lseam < 0.005 ? 0.78 : 1.0);
    float ao = (1.0 - 0.42 * exp(-across / 0.2)) * seatShadow(p);
    wash = p.x > 0.0 ? exp(-across / 1.1) * (0.6 + 0.4 * cos(6.28318530718 * (sh.x - ${g(WINDOW_FIRST + 0.6)}) / ${g(WINDOW_STEP)})) : 0.0;
    return albedo * 0.95 * ao * far;
  }
  if (kind == 1) {
    // Ceiling: a band of glowing panels down the middle, plain white either side.
    float across = HALF_W - abs(p.x);
    float cell = abs(fract(sh.x / ${g(LIGHT_STEP)}) - 0.5) * ${g(LIGHT_STEP)};
    if (abs(p.x) < ${g(LIGHT_HALF)}) {
      bool frame = cell > ${g(LIGHT_STEP / 2 - 0.05)} || abs(p.x) > ${g(LIGHT_HALF - 0.05)};
      return frame ? WHITE * 0.7 : PANEL * (0.96 - 0.05 * smoothstep(0.0, ${g(LIGHT_HALF)}, abs(p.x)));
    }
    float ao = 1.0 - 0.3 * exp(-across / 0.2);
    return WHITE * 0.8 * ao * far;
  }
  // Walls: white panels with a grey kick plate, darker at the floor and ceiling.
  float h = sh.y;
  float light = 0.84 + 0.08 * smoothstep(0.0, CEILING_H, h);
  float ao = (1.0 - 0.38 * exp(-h / 0.18)) * (1.0 - 0.3 * exp(-(CEILING_H - h) / 0.18)) * seatShadow(p);
  vec3 albedo = h < 0.14 ? vec3(0.62, 0.62, 0.62) : WHITE;
  if (abs(h - 2.68) < 0.006) {
    albedo *= 0.8;
  }
  if (kind == 2) {
    // The windowless wall: seams, and the small indicator.
    float seam = abs(fract(sh.x / ${g(LIGHT_STEP)} + 0.5) - 0.5) * ${g(LIGHT_STEP)};
    albedo *= seam < 0.005 ? 0.8 : 1.0;
    vec2 ip = sh - vec2(${g(INDICATOR_S)}, ${g(INDICATOR_H)});
    float box = sdRound(ip, vec2(${g(INDICATOR_HALF[0])}, ${g(INDICATOR_HALF[1])}), 0.02);
    vec3 col = albedo * light * ao;
    if (box < 0.01) {
      col = box < 0.0 ? vec3(0.66, 0.67, 0.68) * light : col * 0.7;
      float lampD = length(ip - vec2(0.0, 0.03)) - ${g(INDICATOR_LAMP)};
      if (lampD < 0.0) {
        lamp = 1.0;
        col = vec3(0.12);
      } else if (lampD < 0.008) {
        col *= 0.6;
      }
      // Two small slots below the lamp.
      if (abs(ip.x) < 0.035 && (abs(ip.y + 0.05) < 0.004 || abs(ip.y + 0.07) < 0.004)) {
        col *= 0.55;
      }
    }
    wash = 0.2;
    return col * far;
  }
  // The window wall: thick white frames round the glass, seams between bays.
  float wd = windowDist(sh);
  if (wd < 0.0) {
    glass = 1.0;
    float v = (h - ${g(WINDOW_Y0)}) / ${g(WINDOW_Y1 - WINDOW_Y0)};
    return vec3(0.025, 0.027, 0.03) + vec3(0.03) * smoothstep(0.55, 1.0, v) + vec3(0.02) * exp(wd / 0.02);
  }
  if (wd < ${g(WINDOW_FRAME)}) {
    // Raised and rounded: lit where it faces up, shaded where it faces down.
    vec2 gr = vec2(windowDist(sh + vec2(0.01, 0.0)) - wd, windowDist(sh + vec2(0.0, 0.01)) - wd) / 0.01;
    float u = wd / ${g(WINDOW_FRAME)};
    float slope = cos(u * 3.14159265);
    float shadeF = 1.0 - 0.22 * slope * gr.y;
    float gasket = smoothstep(0.006, 0.014, wd);
    wash = 0.4;
    return mix(vec3(0.3), WHITE * 0.97 * shadeF * light, gasket) * far;
  }
  float bay = abs(fract((sh.x - ${g(WINDOW_FIRST)}) / ${g(WINDOW_STEP)}) - 0.5) * ${g(WINDOW_STEP)};
  albedo *= abs(bay - ${g(WINDOW_STEP / 2)}) < 0.005 ? 0.8 : 1.0;
  wash = 0.25;
  return albedo * light * ao * far;
}

${SUPERSAMPLE4_GLSL}
void main() {
  float aspect = uResolution.x / uResolution.y;
  if (uPass == 1) {
    vec2 ndc = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
    ndc.x *= uMirror;
    float glass;
    float lamp;
    float wash;
    shade(rayDir(ndc, aspect), glass, lamp, wash);
    outColor = vec4(wash, 0.0, 0.0, 1.0);
    return;
  }
  vec3 acc = vec3(0.0);
  float glassAcc = 0.0;
  float lampAcc = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 ndc = (gl_FragCoord.xy + SS4_OFFSETS[i]) / uResolution * 2.0 - 1.0;
    ndc.x *= uMirror;
    float glass;
    float lamp;
    float wash;
    acc += shade(rayDir(ndc, aspect), glass, lamp, wash) * 0.25;
    glassAcc += glass * 0.25;
    lampAcc += lamp * 0.25;
  }
  float a = lampAcc > 0.0 ? ${g(LAMP_A)} + ${g(1 - LAMP_A)} * lampAcc : ${g(GLASS_A)} * glassAcc;
  outColor = vec4(acc, a);
}
`;

/**
 * Per frame: the cached corridor, the planet's wash over its floor mask, the
 * indicator lamp, and through the glass the turning sky: hashed stars on a
 * grid of rings about the ring's axis, and the Earth (land mask and cloud
 * texture) or the Moon, lit by a fixed sun.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uRoom;
uniform sampler2D uWash;
uniform sampler2D uMask;
uniform sampler2D uClouds;
uniform sampler2D uSurface;
uniform vec2 uResolution;
uniform float uMirror;
// Cosine and sine of the station's turn.
uniform vec2 uSpin;
// 0 none, 1 Earth, 2 Moon.
uniform int uBody;
// Body centre (sky frame) and angular radius.
uniform vec4 uCentre;
uniform vec3 uSun;
uniform vec3 uBX;
uniform vec3 uBY;
uniform vec3 uBZ;
uniform vec2 uCloud;
uniform vec3 uWashCol;
uniform vec3 uLamp;
// Radians per pixel at the centre, and 1 / (2 sigma^2) for the stars (radians^-2).
uniform vec2 uStar;
out vec4 outColor;
${COMMON_GLSL}
${HASH32_GLSL}
${DITHER_GLSL}
${STAR_TINT_GLSL}
const float TAU = 6.28318530718;
const float INV_TAU = 0.15915494309189535;
const float INV_PI = 0.3183098861837907;
const float CELL = ${g(STAR_CELL)};
const vec3 OCEAN = vec3(0.025, 0.07, 0.19);
const vec3 ATMO = vec3(0.3, 0.55, 1.0);

vec3 stars(vec3 d) {
  float th = acos(clamp(d.x, -1.0, 1.0));
  float ph = atan(d.y, d.z);
  float ring = floor(th / CELL);
  float n = max(1.0, floor(TAU * sin((ring + 0.5) * CELL) / CELL));
  float sector = mod(floor((ph * INV_TAU + 0.5) * n), n);
  uint h = hash32(uint(ring) * 0x9e3779b9u ^ hash32(uint(sector) + 0x632be5abu));
  if (float(h & 255u) >= ${g(STAR_SHARE)}) {
    return vec3(0.0);
  }
  vec2 at = vec2(float((h >> 8) & 255u), float((h >> 16) & 255u)) / 255.0;
  float sth = (ring + 0.2 + 0.6 * at.x) * CELL;
  float sph = ((sector + 0.2 + 0.6 * at.y) / n - 0.5) * TAU;
  float dph = ph - sph;
  dph -= TAU * floor(dph * INV_TAU + 0.5);
  vec2 q = vec2(th - sth, dph * sin(th));
  float b = float(h >> 24) / 255.0;
  return starTint(at.x * 2.0, 0.5) * ((0.05 + 1.2 * b * b * b) * exp(-dot(q, q) * uStar.y));
}

vec3 body(vec3 d, vec3 back) {
  vec3 P = uCentre.xyz;
  float sr = sin(uCentre.w);
  float cd = dot(d, P);
  vec3 q = (d - P * cd) / sr;
  float r = cd > 0.0 ? length(q) : 1e3;
  if (r > 1.3) {
    return back;
  }
  float aa = uStar.x / sr;
  float cover = clamp((1.0 - r) / aa + 0.5, 0.0, 1.0);
  vec3 e = q / max(r, 1.0);
  float mu = sqrt(max(0.0, 1.0 - dot(e, e)));
  vec3 N = e - P * mu;
  float ndl = dot(N, uSun);
  vec3 atmo = uBody == 1 ? ATMO * smoothstep(-0.25, 0.3, ndl) : vec3(0.0);
  vec3 halo = atmo * 0.45 * exp(-max(r - 1.0, 0.0) * 28.0);
  if (cover <= 0.0) {
    return back + halo;
  }
  vec3 B = vec3(dot(uBX, N), dot(uBY, N), dot(uBZ, N));
  // Mirrored windows mirror the picture; flip longitude back so the map isn't.
  float lon = atan(B.x * uMirror, B.z);
  float lat = asin(clamp(B.y, -1.0, 1.0));
  float alat = abs(lat);
  vec3 surf;
  float cloud = 0.0;
  if (uBody == 1) {
    float m = texture(uMask, vec2(lon * INV_TAU + 0.5, 0.5 - lat * INV_PI)).r * ${g(LAND_MASK_GAIN)} - ${g(LAND_MASK_BIAS)};
    float land = smoothstep(-1.0, 1.0, m);
    float arid = exp(-pow((alat - 0.42) / 0.16, 2.0));
    vec3 ground = mix(vec3(0.13, 0.2, 0.08), vec3(0.45, 0.38, 0.25), arid);
    ground = mix(ground, vec3(0.86, 0.88, 0.9), smoothstep(1.08, 1.18, alat));
    surf = mix(OCEAN, ground, land);
    surf = mix(surf, vec3(0.86, 0.9, 0.94), smoothstep(1.22, 1.3, alat));
    float c = texture(uClouds, vec2(lon * INV_TAU, lat * INV_PI + 0.5)).r;
    cloud = smoothstep(uCloud.x, uCloud.x + ${g(CLOUD_SOFT)}, c) * uCloud.y;
  } else {
    vec3 s = texture(uSurface, vec2(lon * INV_TAU, lat * INV_PI + 0.5)).rgb;
    surf = vec3(1.0, 0.98, 0.95) * (0.12 + 0.62 * dot(s, vec3(0.3, 0.59, 0.11)));
  }
  surf = mix(surf, vec3(0.92), cloud);
  vec3 lit = surf * (0.008 + 0.95 * max(ndl, 0.0)) + atmo * 0.55 * pow(1.0 - mu, 3.0);
  return mix(back, lit, cover) + halo * (1.0 - cover);
}

void main() {
  vec4 room = texelFetch(uRoom, ivec2(gl_FragCoord.xy), 0);
  vec3 col = room.rgb + uWashCol * texture(uWash, gl_FragCoord.xy / uResolution).r;
  if (room.a > 0.002) {
    if (room.a < ${g((GLASS_A + LAMP_A) / 2)}) {
      // Through the glass: the station frame turned back into the sky's.
      vec2 ndc = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
      ndc.x *= uMirror;
      vec3 d = normalize(rayDir(ndc, uResolution.x / uResolution.y));
      vec3 sky = vec3(d.x, d.y * uSpin.x - d.z * uSpin.y, d.z * uSpin.x + d.y * uSpin.y);
      vec3 view = vec3(0.002, 0.003, 0.008) + stars(sky);
      if (uBody > 0) {
        view = body(sky, view);
      }
      col += view * (room.a / ${g(GLASS_A)});
    } else {
      col += uLamp * ((room.a - ${g(LAMP_A)}) / ${g(1 - LAMP_A)});
    }
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

const FRAMES = { earth: bodyFrame(BODIES.earth), moon: bodyFrame(BODIES.moon) };

/**
 * Inside the rotating wheel of a space station: a white corridor curving up
 * and out of sight, a row of tall windows down one wall, and outside the stars
 * wheeling past as the station turns, with the Earth or the Moon rising and
 * setting through the windows and washing the floor with faint blue light.
 */
export const ring = defineEffect(ringMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);
      const roomProgram = program(ROOM_FRAGMENT);
      const compProgram = program(COMPOSITE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ru = createUniforms(gl, roomProgram, ["uResolution", "uMirror", "uAccent", "uPass"]);
      const cu = createUniforms(gl, compProgram, [
        "uRoom",
        "uWash",
        "uMask",
        "uClouds",
        "uSurface",
        "uResolution",
        "uMirror",
        "uSpin",
        "uBody",
        "uCentre",
        "uSun",
        "uBX",
        "uBY",
        "uBZ",
        "uCloud",
        "uWashCol",
        "uLamp",
        "uStar",
      ]);
      gl.useProgram(compProgram);
      cu.i1("uRoom", 0);
      cu.i1("uWash", 1);
      cu.i1("uMask", 2);
      cu.i1("uClouds", 3);
      cu.i1("uSurface", 4);
      gl.useProgram(null);

      const texture = (
        w: number,
        h: number,
        internalFormat: GLenum,
        format: GLenum,
        data: Uint8Array,
      ) => {
        const tex = scope.add(
          createDataTexture(gl, {
            width: w,
            height: h,
            internalFormat,
            format,
            type: gl.UNSIGNED_BYTE,
            data,
            wrap: gl.REPEAT,
          }),
          (t) => {
            gl.deleteTexture(t);
          },
        );
        // Longitude repeats; latitude stops at the poles.
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
      };
      // Until the land mask loads: one "far out at sea" texel.
      const maskTex = texture(1, 1, gl.R8, gl.RED, new Uint8Array([0]));
      const maskImage = loadLandMask(scope, "Station Ring");
      // The Earth's clouds and the Moon's ground are built when first needed.
      const cloudData = new Uint8Array(CLOUD_W * CLOUD_H * 4);
      const surfaceData = new Uint8Array(SURFACE_W * SURFACE_H * 4);
      const cloudTex = texture(CLOUD_W, CLOUD_H, gl.RGBA8, gl.RGBA, cloudData);
      const surfaceTex = texture(SURFACE_W, SURFACE_H, gl.RGBA8, gl.RGBA, surfaceData);
      let cloudsBuilt = false;
      let surfaceBuilt = false;
      const shaping = cloudShaping(EARTH_CLOUDS, WORLDS.earth, new Float64Array(2));

      let room: RenderTarget | null = null;
      let washTarget: RenderTarget | null = null;
      scope.defer(() => {
        room?.dispose();
        washTarget?.dispose();
      });
      let width = 1;
      let height = 1;
      let scale = 1;
      let roomKey = "";
      let time = 0;
      let phase = START_PHASE;
      const lamp: [number, number, number] = [0, 0, 0];

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale;
          room?.dispose();
          washTarget?.dispose();
          room = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          washTarget = createRenderTarget(
            gl,
            Math.max(1, Math.ceil(width / WASH_DIVISOR)),
            Math.max(1, Math.ceil(height / WASH_DIVISOR)),
            gl.R8,
          );
          roomKey = "";
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          phase = advanceSpin(phase, step, p.spin);
          if (!room || !washTarget) {
            return;
          }
          const mirror = p.windows === "left" ? -1 : 1;

          // 1. The corridor and its wash mask, when they may have changed.
          const key = `${String(mirror)}|${p.accent}`;
          if (key !== roomKey) {
            gl.useProgram(roomProgram);
            ru.f1("uMirror", mirror);
            ru.rgb("uAccent", p.accent);
            if (!roomKey.startsWith(`${String(mirror)}|`)) {
              washTarget.bind();
              ru.f2("uResolution", washTarget.width, washTarget.height);
              ru.i1("uPass", 1);
              triangle.draw();
            }
            room.bind();
            ru.f2("uResolution", width, height);
            ru.i1("uPass", 0);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
            roomKey = key;
          }

          // 2. The body's textures, when first needed.
          const bodyId = p.body === "earth" || p.body === "moon" ? p.body : "none";
          if (bodyId === "earth" && !cloudsBuilt) {
            cloudsBuilt = true;
            buildClouds("earth", BODY_SEED, cloudData);
            gl.activeTexture(gl.TEXTURE3);
            updateDataTexture(gl, cloudTex, CLOUD_W, CLOUD_H, gl.RGBA, gl.UNSIGNED_BYTE, cloudData);
          }
          if (bodyId === "moon" && !surfaceBuilt) {
            surfaceBuilt = true;
            buildSurface("desert", BODY_SEED, surfaceData);
            gl.activeTexture(gl.TEXTURE4);
            updateDataTexture(
              gl,
              surfaceTex,
              SURFACE_W,
              SURFACE_H,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              surfaceData,
            );
          }

          // 3. Composite.
          gl.useProgram(compProgram);
          const angle = spinAngle(phase);
          cu.f2("uResolution", width, height);
          cu.f1("uMirror", mirror);
          cu.f2("uSpin", Math.cos(angle), Math.sin(angle));
          const pxAngle = (2 * TAN_HALF_FOV) / height;
          const sigma = STAR_SIGMA * Math.max(scale, 0.5) * pxAngle;
          cu.f2("uStar", pxAngle, 1 / (2 * sigma * sigma));
          if (bodyId === "none") {
            cu.i1("uBody", 0);
            cu.f3("uWashCol", 0, 0, 0);
          } else {
            const spec = BODIES[bodyId];
            const f = FRAMES[bodyId];
            cu.i1("uBody", bodyId === "earth" ? 1 : 2);
            cu.f4("uCentre", f.centre[0], f.centre[1], f.centre[2], spec.radius);
            cu.f3("uSun", f.sun[0], f.sun[1], f.sun[2]);
            cu.f3("uBX", f.basis[0], f.basis[1], f.basis[2]);
            cu.f3("uBY", f.basis[3], f.basis[4], f.basis[5]);
            cu.f3("uBZ", f.basis[6], f.basis[7], f.basis[8]);
            cu.f2("uCloud", shaping[0], shaping[1]);
            const w = WASH[bodyId] * bodyInView(phase, spec.radius);
            const c = bodyId === "earth" ? WASH_EARTH : WASH_MOON;
            cu.f3("uWashCol", c[0] * w, c[1] * w, c[2] * w);
          }
          indicatorColour(time, lamp);
          cu.f3("uLamp", lamp[0] * 0.9, lamp[1] * 0.9, lamp[2] * 0.9);

          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_2D, surfaceTex);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, cloudTex);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, maskTex);
          const image = maskImage.take();
          if (image) {
            uploadLandMask(gl, image);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
          }
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, washTarget.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, room.texture);
          triangle.draw();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
