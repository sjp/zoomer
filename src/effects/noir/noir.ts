import { createChangeKey } from "../change-key";
import { generateCity } from "../city/city-sim";
import { createSkyline, type SkylineStyle, TV_RGB } from "../city/city-skyline";
import { SLAT_GAP_GLSL } from "../blinds/blinds-sim";
import type { Rgb } from "../color";
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
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { lowResSize } from "../lowres";
import { approach } from "../math";
import { createRng, HASH32_GLSL } from "../noise";
import { createSpriteBatch, polygonStrip } from "../sprites";
import { defineEffect } from "../types";
import {
  createRainSim,
  DEFAULT_CONFIG,
  instanceCapacity,
  type RainSimParams,
  resizeRainSim,
  stepRainSim,
  writeDropInstances,
} from "../windowrain/windowrain-sim";
import {
  DROP_CLEAR,
  DROP_DIR_GLSL,
  DROP_FRAGMENT,
  DROP_VERTEX,
  OFFSET_RANGE,
} from "../windowrain/windowrain-drops";
import { type AdvertSide, noirMeta } from "./noir.meta";
import {
  type AdvertRect,
  advertAt,
  advertGlow,
  advertPalette,
  advertPattern,
  ADVERT_PALETTES,
  advertRect,
  CAR_STRIDE,
  carLanes,
  carsAt,
  CITY_BASE,
  CITY_ZOOM,
  createAdvertState,
  createSearchState,
  type Lane,
  MAX_CARS,
  MAX_SIGNS,
  type Room,
  roomLayout,
  searchAt,
  SIGN_COLOURS,
  SIGN_STRIDE,
  signLayout,
  slatHalfGap,
} from "./noir-sim";

const f = glslFloat;

/** The view (sky, towers, advert, cars, searchlight) renders at 1/2 size: the rain softens it anyway. */
const VIEW_DIVISOR = 2;
/** The cached skyline redraws at most this often (Hz) while windows fade. */
const CACHE_RATE = 15;
/** Skyline density, lit share and window toggles per second. */
const DENSITY = 0.78;
const LIT = 0.36;
const ACTIVITY = 0.6;
/** Building, haze and window colours: blue-grey towers fading into orange smog. */
const BUILDING: Rgb = [0.04, 0.048, 0.072];
const HAZE: Rgb = [0.2, 0.12, 0.1];
const WARM: Rgb = [1, 0.84, 0.62];
const CYAN: Rgb = [0.35, 0.85, 1];
const WARMTH = 0.62;
/** Seconds after which the advert's patterns repeat exactly; their speeds are whole cycles of it. */
const ADVERT_LOOP = 120;
/** Seconds for the advert and searchlight to fade when switched, and per unit of traffic change. */
const ADVERT_EASE = 2;
const SEARCH_EASE = 1.5;
const TRAFFIC_EASE = 2;
/** Searchlight colour, its strength on the room's surfaces, and its haze over the view. */
const SEARCH_RGB: Rgb = [0.62, 0.66, 0.72];
const SEARCH_ROOM = 4;
/** The beam's spot on the window wall: its travel per spot width, and its radius, as fractions of the frame width. */
const SPOT_TRAVEL = 0.18;
const SPOT_RADIUS = 0.2;
const SEARCH_FLOOD = 0.06;
/** The city's own glow coming in through the blinds, and the advert's light at full strength. */
const CITY_GLOW: Rgb = [0.09, 0.1, 0.19];
const ADVERT_LIGHT = 0.75;
/** Refraction through the drops, as a share of Rain on a Window's: kept low so it doesn't shimmer. */
const REFRACTION = 0.45;
/** Searchlight source height above the frame (reference px). */
const BEAM_Y = -260;
/** Car glow quad half-size (reference px at depth 1). */
const CAR_HALF_X = 26;
const CAR_HALF_Y = 12;
const LIGHTS = 3;

/** Value noise and fbm, hashed with lowbias32 so every GPU agrees. */
const NOISE_GLSL = /* glsl */ `
${HASH32_GLSL}
float hash2(vec2 c, float s) {
  uvec2 u = uvec2(ivec2(floor(c)) + 65536);
  return float(hash32(u.x ^ hash32(u.y ^ hash32(uint(s) + 0x9e3779b9u)))) / 4294967296.0;
}
float vnoise(vec2 p, float s) {
  vec2 i = floor(p);
  vec2 t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  return mix(mix(hash2(i, s), hash2(i + vec2(1.0, 0.0), s), t.x),
             mix(hash2(i + vec2(0.0, 1.0), s), hash2(i + vec2(1.0, 1.0), s), t.x), t.y);
}
`;

/** The sky behind the towers, into the cache: dark above, orange smog low down, with low clouds. */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uSeed;
out vec4 outColor;
${NOISE_GLSL}
${DITHER_GLSL}
void main() {
  vec2 frag = gl_FragCoord.xy;
  float y = 1.0 - frag.y / uResolution.y;
  float x = frag.x / uResolution.y;
  vec3 col = mix(vec3(0.01, 0.014, 0.036), vec3(0.05, 0.042, 0.075), smoothstep(0.0, 0.45, y));
  col = mix(col, vec3(0.3, 0.15, 0.07), smoothstep(0.32, 0.85, y));
  vec2 q = vec2(x * 2.2, y * 6.0) + uSeed;
  float n = 0.55 * vnoise(q, 1.0) + 0.3 * vnoise(q * 2.1, 2.0) + 0.15 * vnoise(q * 4.3, 3.0);
  float cloud = smoothstep(0.42, 0.8, n) * smoothstep(0.05, 0.45, y);
  col += cloud * mix(vec3(0.025, 0.022, 0.045), vec3(0.11, 0.055, 0.035), smoothstep(0.2, 0.7, y));
  outColor = vec4(col + dither8(frag), 1.0);
}
`;

/** Neon signs on the nearest towers, into the cache, in the skyline's reference px. */
const SIGN_GLOW = 16;
const SIGN_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Left, top, width, height (skyline reference px). */
layout(location = 1) in vec4 aSign;
/** Colour, then the glyph seed. */
layout(location = 2) in vec4 aInfo;
uniform vec2 uResolution;
uniform float uScale;
uniform vec2 uOffset;
out vec2 vLocal;
flat out vec2 vSize;
flat out vec4 vInfo;
${TO_CLIP_GLSL}
void main() {
  vec2 t = aCorner * 0.5 + 0.5;
  vec2 ref = aSign.xy - ${f(SIGN_GLOW)} + t * (aSign.zw + ${f(2 * SIGN_GLOW)});
  vLocal = ref - aSign.xy;
  vSize = aSign.zw;
  vInfo = aInfo;
  gl_Position = pxToClip(ref * uScale + uOffset, uResolution);
}
`;

/**
 * A column of made-up glyphs: each square cell turns on a seeded few of the
 * twelve strokes of a 3 x 3 lattice, inside a thin border, with a soft halo.
 */
const SIGN_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vLocal;
flat in vec2 vSize;
flat in vec4 vInfo;
out vec4 outColor;
${HASH32_GLSL}
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
void main() {
  vec2 q = vLocal;
  vec2 outside = max(max(-q, q - vSize), 0.0);
  float d = length(outside);
  float glow = 0.2 * exp(-d * 0.2);
  float lit = 0.0;
  if (d <= 0.0) {
    float cell = vSize.x;
    float k = floor(q.y / cell);
    vec2 g = (vec2(q.x, q.y - k * cell) / cell - 0.2) / 0.6;
    float aa = max(fwidth(g.x), 1e-3);
    float best = 10.0;
    uint base = hash32(uint(vInfo.w) * 977u + uint(k) * 131u);
    for (int i = 0; i < 12; i++) {
      if (float(hash32(base + uint(i)) >> 8u) / 16777216.0 < 0.4) {
        int j = i < 6 ? i : i - 6;
        vec2 a = i < 6 ? vec2(float(j % 2), float(j / 2)) * 0.5 : vec2(float(j / 2), float(j % 2)) * 0.5;
        vec2 b = a + (i < 6 ? vec2(0.5, 0.0) : vec2(0.0, 0.5));
        best = min(best, segment(g, a, b));
      }
    }
    lit = 1.0 - smoothstep(0.1 - aa, 0.1 + aa, best);
    float edge = min(min(q.x, vSize.x - q.x), min(q.y, vSize.y - q.y));
    lit = max(lit, 0.45 * (1.0 - smoothstep(0.8, 1.8, edge)));
    glow += 0.06;
  }
  outColor = vec4(vInfo.rgb * (glow + 0.85 * lit), 0.0);
}
`;

/**
 * The view, each frame at 1/2 size: the cached sky and towers, the advert's
 * tower and screen, and the searchlight beam.
 */
const VIEW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uCache;
uniform vec2 uResolution;
/** Reference px per target px, x and y. */
uniform vec2 uRefPx;
/** Advert tower left, right, roof, and how far it has faded in. */
uniform vec4 uTower;
/** Advert screen left, right, top, bottom. */
uniform vec4 uScreen;
/** Patterns of the scene fading out and the one fading in, then the fade and the loop phase. */
uniform vec4 uScene;
uniform vec3 uA1;
uniform vec3 uA2;
uniform vec3 uB1;
uniform vec3 uB2;
/** The advert's average colour times its level, for its halo. */
uniform vec3 uGlow;
/** Beam source x, y (reference px), angle from straight down, strength. */
uniform vec4 uBeam;
uniform vec3 uFlood;
out vec4 outColor;
${DITHER_GLSL}

vec3 scene(float pattern, vec3 c1, vec3 c2, vec2 uv, float tau) {
  int k = int(pattern + 0.5);
  float v;
  if (k == 0) {
    v = 0.5 + 0.5 * sin((uv.x + 0.6 * uv.y) * 6.0 + 2.0 * tau);
  } else if (k == 1) {
    v = 0.5 + 0.5 * sin(length((uv - 0.5) * vec2(1.0, 1.6)) * 13.0 - 3.0 * tau);
  } else if (k == 2) {
    vec2 b1 = 0.5 + vec2(0.3 * sin(tau + 1.0), 0.3 * cos(2.0 * tau));
    vec2 b2 = 0.5 + vec2(0.32 * cos(tau + 2.5), 0.28 * sin(3.0 * tau + 0.7));
    v = exp(-dot(uv - b1, uv - b1) * 9.0) + exp(-dot(uv - b2, uv - b2) * 12.0);
  } else {
    v = uv.y + 0.14 * sin(uv.x * 5.0 + 2.0 * tau) + 0.08 * sin(uv.x * 9.0 - 3.0 * tau);
  }
  vec3 c = mix(c2, c1, clamp(v, 0.0, 1.0));
  vec2 e = min(uv, 1.0 - uv);
  return c * (0.5 + 0.5 * smoothstep(0.0, 0.14, min(e.x, e.y))) * 0.82;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = vec2(frag.x, uResolution.y - frag.y) * uRefPx;
  vec3 col = texture(uCache, frag / uResolution).rgb;

  if (uTower.w > 0.0) {
    vec2 near = clamp(p, uScreen.xz, uScreen.yw);
    float dist = length(p - near);
    if (p.x > uTower.x && p.x < uTower.y && p.y > uTower.z) {
      vec3 facade = vec3(0.014, 0.016, 0.026) + uGlow * 0.12 * exp(-dist * 0.025);
      // Faint floor lines down the facade.
      facade += vec3(0.01, 0.012, 0.02) * step(0.86, fract(p.y / 22.0)) * step(uScreen.w + 20.0, p.y);
      col = mix(col, facade, uTower.w);
    }
    if (dist <= 0.0) {
      vec2 uv = (p - uScreen.xz) / (uScreen.yw - uScreen.xz);
      vec3 a = scene(uScene.x, uA1, uA2, uv, uScene.w);
      vec3 b = scene(uScene.y, uB1, uB2, uv, uScene.w);
      col = mix(col, mix(a, b, uScene.z), uTower.w);
    } else {
      col += uGlow * 0.05 * exp(-dist * 0.012);
    }
  }

  // Blue-grey haze over everything, and the towers' lower floors sinking into orange smog.
  col = mix(col + vec3(0.008, 0.01, 0.016), vec3(0.26, 0.13, 0.07), 0.45 * smoothstep(380.0, 900.0, p.y));

  if (uBeam.w > 0.0) {
    vec2 d = vec2(sin(uBeam.z), cos(uBeam.z));
    vec2 v = p - uBeam.xy;
    float along = dot(v, d);
    if (along > 0.0) {
      float perp = abs(v.x * d.y - v.y * d.x);
      float w = 0.07 * along + 8.0;
      float k = exp(-2.0 * perp * perp / (w * w));
      col += vec3(0.55, 0.6, 0.68) * (k * uBeam.w * 0.2 / (1.0 + along * 0.0015));
    }
  }
  outColor = vec4(col + uFlood + dither8(frag), 1.0);
}
`;

/** Flying cars into the view, premultiplied: a dark body with white lights ahead and red behind. */
const CAR_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (target px), target px per reference px, direction (+1 right). */
layout(location = 1) in vec4 aCar;
/** Opacity, haze, 1 if behind the advert tower. */
layout(location = 2) in vec3 aMisc;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec3 vMisc;
flat out float vPx;
${TO_CLIP_GLSL}
void main() {
  vec2 half_ = vec2(${f(CAR_HALF_X)}, ${f(CAR_HALF_Y)});
  vLocal = aCorner * half_ * vec2(aCar.w, 1.0);
  vMisc = aMisc;
  vPx = 1.0 / max(aCar.z, 1e-3);
  gl_Position = pxToClip(aCar.xy + aCorner * half_ * aCar.z, uResolution);
}
`;

const CAR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec3 vMisc;
flat in float vPx;
uniform vec3 uHaze;
uniform vec2 uResolution;
uniform vec2 uRefPx;
uniform vec4 uTower;
out vec4 outColor;
float box(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec2 q = vLocal;
  float body = box(q, vec2(14.0, 3.2), 2.5);
  vec2 c = (q - vec2(-1.5, -3.0)) / vec2(7.0, 3.2);
  float cab = (length(c) - 1.0) * 3.0;
  float cov = clamp(0.5 - min(body, cab) / max(vPx, 0.3), 0.0, 1.0);
  float dh = length(q - vec2(13.5, 0.4));
  float dt = length(q - vec2(-13.6, 0.0));
  vec3 light = vec3(1.0, 0.95, 0.85) * (exp(-dh * dh * 0.45) + 0.22 * exp(-dh * 0.35))
    + vec3(1.0, 0.12, 0.08) * (exp(-dt * dt * 0.55) + 0.25 * exp(-dt * 0.4));
  float haze = vMisc.y;
  vec3 bodyCol = mix(vec3(0.008, 0.01, 0.018), uHaze, haze);
  float a = vMisc.x;
  if (vMisc.z > 0.5) {
    vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) * uRefPx;
    if (p.x > uTower.x && p.x < uTower.y && p.y > uTower.z) {
      a *= 1.0 - uTower.w;
    }
  }
  outColor = vec4((bodyCol * cov + light * (1.0 - 0.55 * haze)) * a, cov * a);
}
`;

/**
 * The frame, each frame at full size. The window wall's glass shows the view,
 * refracted through the rain on it, with the slats in front; the frame,
 * mullions and the wall round them are dark. Elsewhere a ray finds the side
 * walls, ceiling or desk, lit by each light through the slats: the point is
 * traced back along the light to the window wall, where the openings and the
 * slats' 1D gap profile decide how much gets through.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uView;
uniform sampler2D uDrops;
uniform vec2 uResolution;
/** Reference px per device px. */
uniform float uRefPx;
/** Window wall left, right, top, bottom (reference px). */
uniform vec4 uWall;
/** Glass left, right, top, bottom. */
uniform vec4 uGlass;
/** Frame width, mullion centres, mullion half-width. */
uniform vec4 uFrame;
/** Slat pitch and half-gap (pitches). */
uniform vec2 uSlat;
/** Frame centre x, y (reference px), focal length (reference px), wall distance (m). */
uniform vec4 uCam;
/** Each light's travel direction, colour, and penumbra (pitches) at the window and growth per metre. */
uniform vec3 uLightDir[${String(LIGHTS)}];
uniform vec3 uLightCol[${String(LIGHTS)}];
uniform vec2 uLightPen[${String(LIGHTS)}];
/** The searchlight's spot on the window wall (the last light): x, y, radius (reference px). */
uniform vec3 uSpot;
/** All the light coming in, for the slats' lips and the dim bounce. */
uniform vec3 uWindowLight;
/** Refraction offset scale, decoded drop offset to uv. */
uniform vec2 uOffsetScale;
out vec4 outColor;
${SLAT_GAP_GLSL}
${DROP_DIR_GLSL}
${DITHER_GLSL}

/** 1 in the window's openings (the glass less the mullions) at reference point q, edges soft by \`soft\` px. */
float opening(vec2 q, float soft) {
  float s = max(soft, 0.5);
  float m = smoothstep(uGlass.x - s, uGlass.x + s, q.x) * (1.0 - smoothstep(uGlass.y - s, uGlass.y + s, q.x))
    * smoothstep(uGlass.z - s, uGlass.z + s, q.y) * (1.0 - smoothstep(uGlass.w - s, uGlass.w + s, q.y));
  float h = uFrame.w;
  return m * smoothstep(h - s, h + s, abs(q.x - uFrame.y)) * smoothstep(h - s, h + s, abs(q.x - uFrame.z));
}

/** Where a 3D point on the window wall shows, in reference px. */
vec2 onWall(vec3 Q) {
  return vec2(uCam.x + uCam.z * Q.x / uCam.w, uCam.y - uCam.z * Q.y / uCam.w);
}

vec3 throughSlats(vec3 P, vec3 N) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${String(LIGHTS)}; i++) {
    vec3 L = uLightDir[i];
    float lambert = dot(N, -L);
    if (lambert <= 0.0) {
      continue;
    }
    float s = (uCam.w - P.z) / -L.z;
    vec2 q = onWall(P - L * s);
    float pen = uLightPen[i].x + uLightPen[i].y * s;
    float m = opening(q, pen * uSlat.x);
    float g = slatGap((q.y - uGlass.z) / uSlat.x, pen, uSlat.y);
    if (i == ${String(LIGHTS - 1)}) {
      vec2 sp = (q - uSpot.xy) / uSpot.z;
      g *= exp(-dot(sp, sp));
    }
    sum += uLightCol[i] * (lambert * m * g);
  }
  return sum;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = vec2(frag.x, uResolution.y - frag.y) * uRefPx;
  vec2 uv = frag / uResolution;
  vec3 col;
  if (p.x > uWall.x && p.x < uWall.y && p.y > uWall.z && p.y < uWall.w) {
    vec2 o0 = uGlass.xz - uFrame.x;
    vec2 o1 = uGlass.yw + uFrame.x;
    bool framed = p.x > o0.x && p.x < o1.x && p.y > o0.y && p.y < o1.y;
    // The frame catches a little of the light on its inner edges; the wall only a faint bounce.
    float rim = framed ? exp(-min(min(p.x - o0.x, o1.x - p.x), min(p.y - o0.y, o1.y - p.y)) * 0.15) : 0.0;
    vec3 surround = framed
      ? vec3(0.022, 0.022, 0.027) + uWindowLight * (0.05 + 0.1 * (1.0 - rim))
      : vec3(0.014, 0.013, 0.017) + uWindowLight * 0.025;
    float glass = opening(p, 0.5 * uRefPx);
    col = surround;
    if (glass > 0.0) {
      vec4 d = texture(uDrops, uv);
      vec2 dir = dropDir(d);
      float cov = d.a;
      vec3 v = texture(uView, uv + dir * uOffsetScale).rgb * (1.0 + 0.1 * cov);
      float rimDrop = cov * (1.0 - smoothstep(0.0, 0.45, d.z));
      float spec = pow(max(d.z * 0.8 + dot(dir, vec2(0.35, -0.3)) * 0.3, 0.0), 30.0) * cov;
      v = v * (1.0 - 0.4 * rimDrop) * 0.94 + spec * (0.12 + uWindowLight * 0.6);
      // The slats, in front of the glass, with a thin lit lip on each.
      float n = (p.y - uGlass.z) / uSlat.x;
      float gap = slatGap(n, 1.5 * uRefPx / uSlat.x, uSlat.y);
      float e = (0.5 - uSlat.y - fract(n)) * uSlat.x;
      float lip = 1.0 - smoothstep(0.6, 2.6, e);
      vec3 slat = vec3(0.012, 0.012, 0.016) + uWindowLight * (0.03 + 0.22 * lip);
      col = mix(surround, mix(slat, v, gap), glass);
    }
  } else {
    // Into the room: side walls, ceiling or the desk below the window.
    vec3 r = vec3((p.x - uCam.x) / uCam.z, (uCam.y - p.y) / uCam.z, 1.0);
    float halfX = (uWall.y - uCam.x) / uCam.z * uCam.w;
    float ceiling = (uCam.y - uWall.z) / uCam.z * uCam.w;
    float desk = (uWall.w - uCam.y) / uCam.z * uCam.w;
    float t = 1e6;
    vec3 N = vec3(0.0, 0.0, -1.0);
    if (r.x < 0.0 && -halfX / r.x < t) { t = -halfX / r.x; N = vec3(1.0, 0.0, 0.0); }
    if (r.x > 0.0 && halfX / r.x < t) { t = halfX / r.x; N = vec3(-1.0, 0.0, 0.0); }
    if (r.y > 0.0 && ceiling / r.y < t) { t = ceiling / r.y; N = vec3(0.0, -1.0, 0.0); }
    if (r.y < 0.0 && -desk / r.y < t) { t = -desk / r.y; N = vec3(0.0, 1.0, 0.0); }
    vec3 P = r * t;
    bool isDesk = N.y > 0.5;
    vec3 albedo = isDesk ? vec3(0.15, 0.11, 0.09) : vec3(0.15, 0.14, 0.16);
    // Darker away from the window, and into the corners.
    float near = clamp(1.0 - (uCam.w - P.z) * 0.35, 0.3, 1.0);
    col = albedo * (throughSlats(P, N) + 0.012 + uWindowLight * 0.12 * near);
    if (isDesk) {
      // A glossy desk top mirrors the window, blurred and through the slats.
      vec3 vdir = normalize(r);
      vec3 R = reflect(vdir, N);
      float s = (uCam.w - P.z) / max(R.z, 1e-3);
      vec2 q = onWall(P + R * s);
      float m = opening(q, 6.0);
      float g = slatGap((q.y - uGlass.z) / uSlat.x, 0.25, uSlat.y);
      vec2 quv = vec2(q.x, uResolution.y * uRefPx - q.y) / (uResolution * uRefPx);
      float fres = 0.05 + 0.5 * pow(1.0 - abs(vdir.y), 5.0);
      col += texture(uView, quv).rgb * (m * g * fres * 0.5);
    }
  }
  outColor = vec4(col + dither8(frag), 1.0);
}
`;

/**
 * Neon-Noir Apartment. Per frame:
 * 1. the skyline (City at Night's buildings, a smoggy sky and neon signs) into
 *    a half-size cache, redrawn only on resize or seed and while windows fade;
 * 2. the view at half size: the cache, the advert and the searchlight beam in
 *    one pass, then the flying cars as small sprites;
 * 3. the rain's drop map (Rain on a Window's simulation and drop shaders);
 * 4. one full-size pass for the glass (refracting the view), the slats and the
 *    room, lit through the slats by the city, the advert and the searchlight.
 */
export const noir = defineEffect(noirMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const skyline = scope.own(createSkyline(gl));

      const skyProgram = program(FULLSCREEN_VERTEX, SKY_FRAGMENT);
      const skyU = createUniforms(gl, skyProgram, ["uResolution", "uSeed"]);
      const signProgram = program(SIGN_VERTEX, SIGN_FRAGMENT);
      const signU = createUniforms(gl, signProgram, ["uResolution", "uScale", "uOffset"]);
      const signs = scope.own(createSpriteBatch(gl, MAX_SIGNS, [4, 4]));
      const viewProgram = program(FULLSCREEN_VERTEX, VIEW_FRAGMENT);
      const viewU = createUniforms(gl, viewProgram, [
        "uCache",
        "uResolution",
        "uRefPx",
        "uTower",
        "uScreen",
        "uScene",
        "uA1",
        "uA2",
        "uB1",
        "uB2",
        "uGlow",
        "uBeam",
        "uFlood",
      ]);
      const carProgram = program(CAR_VERTEX, CAR_FRAGMENT);
      const carU = createUniforms(gl, carProgram, ["uResolution", "uHaze", "uRefPx", "uTower"]);
      const carBatch = scope.own(createSpriteBatch(gl, MAX_CARS, [4, 3]));
      const dropProgram = program(DROP_VERTEX, DROP_FRAGMENT);
      const dropU = createUniforms(gl, dropProgram, [
        "uResolution",
        "uInvScale",
        "uGrow",
        "uMargin",
      ]);
      const drops = scope.own(
        createSpriteBatch(
          gl,
          instanceCapacity(DEFAULT_CONFIG),
          [4, 1],
          [polygonStrip(8, Math.PI / 8)],
        ),
      );
      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const roomU = createUniforms(gl, roomProgram, [
        "uView",
        "uDrops",
        "uResolution",
        "uRefPx",
        "uWall",
        "uGlass",
        "uFrame",
        "uSlat",
        "uCam",
        "uLightDir",
        "uLightCol",
        "uLightPen",
        "uSpot",
        "uWindowLight",
        "uOffsetScale",
      ]);
      gl.useProgram(viewProgram);
      viewU.i1("uCache", 0);
      gl.useProgram(dropProgram);
      dropU.f1("uGrow", 1);
      gl.useProgram(roomProgram);
      roomU.i1("uView", 0);
      roomU.i1("uDrops", 1);
      gl.useProgram(null);

      let cache: RenderTarget | null = null;
      let view: RenderTarget | null = null;
      let dropMap: RenderTarget | null = null;
      const disposeTargets = () => {
        cache?.dispose();
        view?.dispose();
        dropMap?.dispose();
        cache = view = dropMap = null;
      };
      scope.defer(disposeTargets);
      const makeTarget = (w: number, h: number): RenderTarget => {
        const t = createRenderTarget(gl, w, h, gl.RGBA8);
        // RGBA8 is always colour-renderable in WebGL2.
        if (!t) {
          throw new Error("Neon-Noir Apartment: render target is not renderable");
        }
        return t;
      };

      const sim = createRainSim(1920, 1080, createRng(0x6e6f6972));
      const rainParams: RainSimParams = { rain: 0, speed: 1 };
      const style: SkylineStyle = {
        width: 1,
        height: 1,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        building: BUILDING,
        haze: HAZE,
        warmth: WARMTH,
        warm: WARM,
        cool: CYAN,
        tv: TV_RGB,
      };
      const layoutKey = createChangeKey(2);
      const signData = new Float32Array(MAX_SIGNS * SIGN_STRIDE);
      const carData = new Float32Array(MAX_CARS * CAR_STRIDE);
      const lightDir = new Float32Array(LIGHTS * 3);
      const lightCol = new Float32Array(LIGHTS * 3);
      const lightPen = new Float32Array([0.15, 0.5, 0.1, 0.35, 0.03, 0.05]);
      const windowLight: Rgb = [0, 0, 0];
      const glow: Rgb = [0, 0, 0];
      const glowPrev: Rgb = [0, 0, 0];
      const advert = createAdvertState();
      const search = createSearchState();
      const tower: AdvertRect = { towerX0: 0, towerX1: 0, towerY0: 0, x0: 0, x1: 0, y0: 0, y1: 0 };

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      let room: Room = roomLayout(refWidth);
      let lanes: Lane[] = [];
      let signCount = 0;
      let seed = 0;
      let cacheStale = true;
      let cacheTimer = 0;
      // CPU-only time, kept unwrapped in float64.
      let time = 0;
      let searchLevel = -1;
      let advertLevel = -1;
      let shownSide: AdvertSide = "left";
      let traffic = -1;

      const setLight = (i: number, x: number, y: number, z: number, c: Rgb, k: number) => {
        const len = Math.hypot(x, y, z);
        lightDir[i * 3] = x / len;
        lightDir[i * 3 + 1] = y / len;
        lightDir[i * 3 + 2] = z / len;
        lightCol[i * 3] = c[0] * k;
        lightCol[i * 3 + 1] = c[1] * k;
        lightCol[i * 3 + 2] = c[2] * k;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          refWidth = width / scale;
          disposeTargets();
          const vw = lowResSize(width, VIEW_DIVISOR);
          const vh = lowResSize(height, VIEW_DIVISOR);
          cache = makeTarget(vw, vh);
          view = makeTarget(vw, vh);
          dropMap = makeTarget(lowResSize(width, scale), lowResSize(height, scale));
          resizeRainSim(sim, refWidth, 1080);
          cacheStale = true;
          cacheTimer = Infinity;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!cache || !view || !dropMap) {
            return;
          }

          // Layout: the skyline, signs, lanes and room, when the seed or aspect changes.
          layoutKey.set(0, Math.floor(p.seed));
          layoutKey.set(1, refWidth);
          if (layoutKey.take()) {
            seed = Math.floor(p.seed);
            const city = generateCity(seed, DENSITY, refWidth / CITY_ZOOM);
            skyline.setLayout(city, seed, LIT);
            signCount = signLayout(city, seed, signData);
            const d = signs.data;
            for (let i = 0; i < signCount; i++) {
              const o = i * SIGN_STRIDE;
              const c = SIGN_COLOURS[signData[o + 4]];
              d.set(signData.subarray(o, o + 4), i * 8);
              d[i * 8 + 4] = c[0];
              d[i * 8 + 5] = c[1];
              d[i * 8 + 6] = c[2];
              d[i * 8 + 7] = signData[o + 5];
            }
            signs.upload(signCount);
            lanes = carLanes(seed, refWidth);
            room = roomLayout(refWidth);
            cacheStale = true;
            cacheTimer = Infinity;
          }

          // 1. The skyline cache.
          cacheStale = skyline.step(step, ACTIVITY) || cacheStale;
          cacheTimer += step;
          if (cacheStale && cacheTimer >= 1 / CACHE_RATE) {
            cacheTimer = 0;
            cacheStale = false;
            cache.bind();
            gl.useProgram(skyProgram);
            skyU.f2("uResolution", cache.width, cache.height);
            skyU.f1("uSeed", seed % 97);
            triangle.draw();
            const k = (cache.width / width) * scale;
            style.width = cache.width;
            style.height = cache.height;
            style.scale = k * CITY_ZOOM;
            style.offsetY = k * (CITY_BASE - 1080 * CITY_ZOOM);
            skyline.draw(style);
            if (signCount > 0) {
              gl.useProgram(signProgram);
              signU.f2("uResolution", cache.width, cache.height);
              signU.f1("uScale", style.scale);
              signU.f2("uOffset", 0, style.offsetY);
              gl.enable(gl.BLEND);
              gl.blendFunc(gl.ONE, gl.ONE);
              signs.draw(0, signCount);
              gl.disable(gl.BLEND);
            }
          }

          // 2. The view: advert, searchlight, cars.
          const rate = step;
          const side = p.advert === "right" ? "right" : p.advert === "left" ? "left" : "off";
          if (advertLevel < 0) {
            advertLevel = side === "off" ? 0 : 1;
            shownSide = side === "off" ? shownSide : side;
          }
          // Switching sides fades the advert out, then in on the other side.
          advertLevel = approach(advertLevel, side === shownSide ? 1 : 0, rate / ADVERT_EASE);
          if (advertLevel === 0 && side !== "off") {
            shownSide = side;
          }
          searchLevel = approach(
            searchLevel < 0 ? (p.search ? 1 : 0) : searchLevel,
            p.search ? 1 : 0,
            rate / SEARCH_EASE,
          );
          traffic = traffic < 0 ? p.traffic : approach(traffic, p.traffic, rate / TRAFFIC_EASE);

          advertAt(time, seed, advert);
          advertRect(shownSide, refWidth, tower);
          advertGlow(advert.scene, seed, glow);
          advertGlow(advert.prev, seed, glowPrev);
          for (let i = 0; i < 3; i++) {
            glow[i] = (glowPrev[i] + (glow[i] - glowPrev[i]) * advert.mix) * advertLevel;
          }
          searchAt(time, seed, search);
          const beam = search.beam * searchLevel;
          const inRoom = search.room * searchLevel;

          view.bind();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, cache.texture);
          gl.useProgram(viewProgram);
          const refX = width / view.width / scale;
          const refY = height / view.height / scale;
          viewU.f2("uResolution", view.width, view.height);
          viewU.f2("uRefPx", refX, refY);
          viewU.f4("uTower", tower.towerX0, tower.towerX1, tower.towerY0, advertLevel);
          viewU.f4("uScreen", tower.x0, tower.x1, tower.y0, tower.y1);
          const pa = ADVERT_PALETTES[advertPalette(advert.prev, seed)];
          const pb = ADVERT_PALETTES[advertPalette(advert.scene, seed)];
          viewU.f4(
            "uScene",
            advertPattern(advert.prev, seed),
            advertPattern(advert.scene, seed),
            advert.mix,
            ((time % ADVERT_LOOP) / ADVERT_LOOP) * Math.PI * 2,
          );
          viewU.v3("uA1", pa[0]);
          viewU.v3("uA2", pa[1]);
          viewU.v3("uB1", pb[0]);
          viewU.v3("uB2", pb[1]);
          viewU.v3("uGlow", glow);
          viewU.f4("uBeam", search.originX * refWidth, BEAM_Y, search.angle, beam);
          const flood = inRoom * SEARCH_FLOOD;
          viewU.f3("uFlood", SEARCH_RGB[0] * flood, SEARCH_RGB[1] * flood, SEARCH_RGB[2] * flood);
          triangle.draw();

          const n = carsAt(lanes, seed, traffic, time, refWidth, carData);
          if (n > 0) {
            const k = view.width / width;
            const d = carBatch.data;
            for (let i = 0; i < n; i++) {
              const o = i * CAR_STRIDE;
              const depth = carData[o + 2];
              // A slow hover, different for each car.
              const bob = 1.5 * depth * Math.sin(time * 0.6 + carData[o + 5] * 1.7);
              const s = i * 7;
              d[s] = carData[o] * scale * k;
              d[s + 1] = (carData[o + 1] + bob) * scale * k;
              d[s + 2] = depth * scale * k;
              d[s + 3] = carData[o + 3];
              d[s + 4] = carData[o + 4];
              d[s + 5] = 0.75 * (1 - depth);
              d[s + 6] = depth < 0.75 ? 1 : 0;
            }
            carBatch.upload(n);
            gl.useProgram(carProgram);
            carU.f2("uResolution", view.width, view.height);
            carU.v3("uHaze", HAZE);
            carU.f2("uRefPx", refX, refY);
            carU.f4("uTower", tower.towerX0, tower.towerX1, tower.towerY0, advertLevel);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            carBatch.draw(0, n);
            gl.disable(gl.BLEND);
          }

          // 3. The rain on the glass.
          rainParams.rain = p.rain;
          stepRainSim(sim, step, rainParams);
          const count = writeDropInstances(sim, drops.data, scale);
          drops.upload(count);
          dropMap.bind();
          gl.clearBufferfv(gl.COLOR, 0, DROP_CLEAR);
          if (count > 0) {
            gl.useProgram(dropProgram);
            dropU.f2("uResolution", width, height);
            dropU.f1("uInvScale", 1 / scale);
            dropU.f1("uMargin", width / dropMap.width);
            drops.draw(0, count);
          }

          // 4. Glass, slats and room.
          const s = shownSide === "right" ? -1 : 1;
          setLight(0, -0.35 * s, 0.15, -1, CITY_GLOW, 1);
          setLight(1, 0.5 * s, -0.22, -1, glow, ADVERT_LIGHT);
          setLight(2, search.slide, -0.55, -1, SEARCH_RGB, inRoom * SEARCH_ROOM);
          // The slats' lips and the bounce see the searchlight at its plain strength.
          for (let i = 0; i < 3; i++) {
            windowLight[i] = lightCol[i] + lightCol[3 + i] + lightCol[6 + i] / SEARCH_ROOM;
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, view.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, dropMap.texture);
          gl.useProgram(roomProgram);
          roomU.f2("uResolution", width, height);
          roomU.f1("uRefPx", 1 / scale);
          roomU.f4("uWall", room.wallX0, room.wallX1, room.wallY0, room.wallY1);
          roomU.f4("uGlass", room.glassX0, room.glassX1, room.glassY0, room.glassY1);
          roomU.f4("uFrame", room.frame, room.mullion1, room.mullion2, room.mullionHalf);
          roomU.f2("uSlat", room.pitch, slatHalfGap(p.blinds));
          roomU.f4("uCam", refWidth / 2, 540, room.focal, room.depth);
          gl.uniform3fv(roomU.loc.uLightDir, lightDir);
          gl.uniform3fv(roomU.loc.uLightCol, lightCol);
          gl.uniform2fv(roomU.loc.uLightPen, lightPen);
          roomU.f3(
            "uSpot",
            refWidth * (0.5 + SPOT_TRAVEL * search.spot),
            0.5 * (room.glassY0 + room.glassY1),
            refWidth * SPOT_RADIUS,
          );
          roomU.v3("uWindowLight", windowLight);
          roomU.f2(
            "uOffsetScale",
            (OFFSET_RANGE * REFRACTION * scale) / width,
            (OFFSET_RANGE * REFRACTION * scale) / height,
          );
          triangle.draw();
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
