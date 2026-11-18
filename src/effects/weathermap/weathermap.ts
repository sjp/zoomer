import { createCanvasAtlas, SANS_FONT_STACK } from "../canvas-texture";
import { createChangeKey } from "../change-key";
import { createColorEase } from "../color";
import {
  BSPLINE_GLSL,
  CONTOUR_LEVEL_GLSL,
  ENCODE_HEIGHT_GLSL,
  heightDecodeScale,
} from "../contour-field";
import { createCrossfadeSlots, createFadeThrough } from "../fade";
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
  scopedProgram,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import {
  LAND_MASK_BIAS,
  LAND_MASK_GAIN,
  LAND_MASK_WIDTH,
  loadLandMask,
  uploadLandMask,
} from "../land-mask";
import { createLowResTarget } from "../lowres";
import { approach, clamp, fract, smoothstep } from "../math";
import { buildPeriodicNoiseTexture, VALUE_FBM_GLSL, VALUE_NOISE_GLSL } from "../noise";
import { createSpriteBatch } from "../sprites";
import { createTextLayer, setTextPalette, TEXT_PALETTE_FLOATS, TEXT_ROLES } from "../text-layer";
import { defineEffect } from "../types";
import { drawIcon, drawPressureLetter, type MapStyle } from "./weathermap-icons";
import {
  BASE_PRESSURE,
  BOX_DROP,
  BOX_FONT,
  BOX_GAP,
  BOX_HEIGHT,
  BOX_PAD,
  boxWidth,
  type CityForecast,
  createDayClock,
  createForecast,
  createWeatherState,
  dayName,
  DEGREE_CELL,
  DESIGN_ASPECT,
  DIGIT_CELL,
  DRIFT_PER_DAY,
  evaluate,
  type Forecast,
  forecastDay,
  formatTemp,
  FRONT_POINTS,
  frontSymbols,
  ICON_SIZE,
  ICONS,
  ISOBAR_STEP,
  LOW_RAIN_PEAK,
  LOW_RAIN_RADIUS,
  MAX_DIGITS,
  MINUS,
  NAME_DROP,
  NAME_FONT,
  PRESSURE_MIN,
  PRESSURE_RANGE,
  project,
  RAIN_PEAK,
  RAIN_WIDTH,
  REGIONS,
  ROLL_SECONDS,
  SEMICIRCLE,
  slotRoll,
  SYMBOL_STRIDE,
  SYSTEM_COUNT,
  SYSTEM_STRIDE,
  toFahrenheit,
  TROUGH_REACH,
  TROUGH_SLOPE,
  TROUGH_SOFT,
  viewWindow,
} from "./weathermap-sim";
import {
  MAX_PACE,
  MIN_PACE,
  REGION_OPTIONS,
  type RegionId,
  type SeasonId,
  SEASON_OPTIONS,
  weathermapMeta,
} from "./weathermap.meta";

/** Rows of the pressure and rain field, whatever the canvas size. */
const FIELD_ROWS = 270;
/** Fronts the field shader takes, nearest the frame first. */
const MAX_GPU_FRONTS = 9;
const SEGMENTS = FRONT_POINTS - 1;
const MAX_SYMBOLS = 160;
const MAX_SHAPES = MAX_GPU_FRONTS * SEGMENTS + MAX_SYMBOLS + 40;
const MAX_IMAGES = 64;
const MAX_TEXT_QUADS = 96;
/** Rain blob noise: texture size, and its tile in design units. */
const NOISE_SIZE = 64;
const NOISE_TILE = 0.9;

/** Fades, in seconds. */
const ICON_FADE = 0.8;
const BANNER_FADE = 0.6;
const STYLE_FADE = 1.2;
const MAP_FADE = 1.2;
const REGION_HALF = 0.6;
const RADAR_FADE = 1;

/** H and L letters' size, in design units. */
const LETTER_SIZE = 0.075;
/** Pressure systems show their letter from this strength (hPa), fully from the second. */
const LETTER_FROM = 7;
const LETTER_FULL = 11;
/** The day banner, in design units from the frame's top-left corner. */
const BANNER_MARGIN = 0.045;
const BANNER_HEIGHT = 0.078;
const BANNER_FONT = 0.046;
const BANNER_PAD = 0.03;
const ACCENT_WIDTH = 0.009;
/** The banner's text slots in the text atlas, in design units. */
const BANNER_SLOT = 0.32;
const NAME_SLOT = 0.3;

/**
 * A temperature box's colour for `c` °C, for the classic look: a hue ramp from
 * blue in the frost through green and amber to red in the heat (through hues
 * rather than mixing colours, which would muddy the middle).
 */
function tempColour(c: number, out: Float32Array, o: number) {
  const h = clamp(225 - (c + 5) * 6.6, 0, 235) / 60;
  const l = 0.43;
  const chroma = (1 - Math.abs(2 * l - 1)) * 0.7;
  const x = chroma * (1 - Math.abs((h % 2) - 1));
  const m = l - chroma / 2;
  const sector = Math.min(5, Math.floor(h));
  const r = sector === 0 || sector === 5 ? chroma : sector === 1 || sector === 4 ? x : 0;
  const g = sector === 1 || sector === 2 ? chroma : sector === 0 || sector === 3 ? x : 0;
  const b = sector === 3 || sector === 4 ? chroma : sector === 2 || sector === 5 ? x : 0;
  out[o] = r + m;
  out[o + 1] = g + m;
  out[o + 2] = b + m;
}

/** The overlay look of each style, as one block of floats so a style change eases. */
const S = {
  iso: 0,
  isoWidth: 3,
  isoAlpha: 4,
  glowAlpha: 5,
  glowRadius: 6,
  cold: 7,
  warm: 10,
  occluded: 13,
  frontWidth: 16,
  symbolSize: 17,
  rainAlpha: 18,
  rainLo: 19,
  rainMid: 22,
  rainHi: 25,
  boxTint: 28,
  gloss: 29,
  boxDark: 30,
  boxAlpha: 33,
  panel: 34,
  panelAlpha: 37,
  bannerText: 38,
  accentAlpha: 41,
  accent: 42,
  mix: 45,
  count: 46,
} as const;

const hexTriple = (hex: string) => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
];

interface OverlayStyle {
  iso: string;
  /** Widths in px at 1080p. */
  isoWidth: number;
  isoAlpha: number;
  glowAlpha: number;
  glowRadius: number;
  cold: string;
  warm: string;
  occluded: string;
  frontWidth: number;
  symbolSize: number;
  rainAlpha: number;
  rain: readonly [string, string, string];
  boxTint: number;
  gloss: number;
  boxDark: string;
  boxAlpha: number;
  panel: string;
  panelAlpha: number;
  bannerText: string;
  accentAlpha: number;
  accent: string;
}

function packStyle(s: OverlayStyle, mix: number): Float32Array {
  const v = new Float32Array(S.count);
  v.set(hexTriple(s.iso), S.iso);
  v[S.isoWidth] = s.isoWidth;
  v[S.isoAlpha] = s.isoAlpha;
  v[S.glowAlpha] = s.glowAlpha;
  v[S.glowRadius] = s.glowRadius;
  v.set(hexTriple(s.cold), S.cold);
  v.set(hexTriple(s.warm), S.warm);
  v.set(hexTriple(s.occluded), S.occluded);
  v[S.frontWidth] = s.frontWidth;
  v[S.symbolSize] = s.symbolSize;
  v[S.rainAlpha] = s.rainAlpha;
  v.set(hexTriple(s.rain[0]), S.rainLo);
  v.set(hexTriple(s.rain[1]), S.rainMid);
  v.set(hexTriple(s.rain[2]), S.rainHi);
  v[S.boxTint] = s.boxTint;
  v[S.gloss] = s.gloss;
  v.set(hexTriple(s.boxDark), S.boxDark);
  v[S.boxAlpha] = s.boxAlpha;
  v.set(hexTriple(s.panel), S.panel);
  v[S.panelAlpha] = s.panelAlpha;
  v.set(hexTriple(s.bannerText), S.bannerText);
  v[S.accentAlpha] = s.accentAlpha;
  v.set(hexTriple(s.accent), S.accent);
  v[S.mix] = mix;
  return v;
}

const OVERLAY_STYLES: Readonly<Record<MapStyle, Float32Array>> = {
  classic: packStyle(
    {
      iso: "#ffffff",
      isoWidth: 3.2,
      isoAlpha: 0.92,
      glowAlpha: 0,
      glowRadius: 1,
      cold: "#1d4fd8",
      warm: "#d8231c",
      occluded: "#8a2fb8",
      frontWidth: 5.5,
      symbolSize: 24,
      rainAlpha: 0.72,
      rain: ["#3fbf3a", "#f2dc2a", "#e8352a"],
      boxTint: 1,
      gloss: 0,
      boxDark: "#16202c",
      boxAlpha: 1,
      panel: "#f4f6f9",
      panelAlpha: 0.96,
      bannerText: "#13305e",
      accentAlpha: 0,
      accent: "#3bc8ff",
    },
    0,
  ),
  modern: packStyle(
    {
      iso: "#bfe6ff",
      isoWidth: 1.3,
      isoAlpha: 0.85,
      glowAlpha: 0.32,
      glowRadius: 5,
      cold: "#4aa6ff",
      warm: "#ff5a4a",
      occluded: "#c27bff",
      frontWidth: 3.8,
      symbolSize: 22,
      rainAlpha: 0.6,
      rain: ["#2fd06a", "#ffd83a", "#ff4a3a"],
      boxTint: 0.35,
      gloss: 1,
      boxDark: "#121b26",
      boxAlpha: 0.9,
      panel: "#0f1b2a",
      panelAlpha: 0.82,
      bannerText: "#ffffff",
      accentAlpha: 1,
      accent: "#3bc8ff",
    },
    1,
  ),
};

interface MapLook {
  sea: string;
  seaDeep: string;
  land: string;
  landHigh: string;
  coast: string;
  /** Relief, coast line opacity, coast line width (mask texels) and vignette. */
  look: readonly [number, number, number, number];
  shadowAlpha: number;
}

const MAP_LOOKS: Readonly<Record<MapStyle, MapLook>> = {
  classic: {
    sea: "#3478c2",
    seaDeep: "#2a64a8",
    land: "#5ea34b",
    landHigh: "#5ea34b",
    coast: "#2e5e2a",
    look: [0, 0.35, 0.18, 0],
    shadowAlpha: 0.38,
  },
  modern: {
    sea: "#123250",
    seaDeep: "#081627",
    land: "#25302b",
    landHigh: "#38463e",
    coast: "#58c0e8",
    look: [1, 0.55, 0.14, 0.35],
    shadowAlpha: 0.55,
  },
};

/** Drop shadow of the land on the sea: offset (design units) and blur (mask texels per design unit of offset). */
const SHADOW_OFFSET = 0.006;
const SHADOW_BLUR = 0.006;

/** Bakes the map (land, sea, coast shadow and relief) for one region and style. */
const MAP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uMask;
uniform vec2 uMaskSize;
/** Design x, y at the canvas's top-left, design units per px, canvas height in px. */
uniform vec4 uView;
/** Centre longitude and latitude, degrees of latitude per design unit, 1 / cos(centre latitude). */
uniform vec4 uProj;
/** Coast anti-aliasing (mask texels), shadow blur (mask texels), shadow opacity. */
uniform vec3 uShade;
uniform vec3 uSea;
uniform vec3 uSeaDeep;
uniform vec3 uLand;
uniform vec3 uLandHigh;
uniform vec3 uCoast;
/** Relief, coast line opacity, coast line width (mask texels), vignette. */
uniform vec4 uLook;
out vec4 outColor;

const float HALF_ASPECT = ${glslFloat(DESIGN_ASPECT / 2)};
const float GAIN = ${glslFloat(LAND_MASK_GAIN)};
const float BIAS = ${glslFloat(LAND_MASK_BIAS)};
const vec2 MASK_TEXELS = vec2(${glslFloat(LAND_MASK_WIDTH)}, ${glslFloat(LAND_MASK_WIDTH / 2)});
const float SHADOW_OFFSET = ${glslFloat(SHADOW_OFFSET)};
${BSPLINE_GLSL}
${VALUE_NOISE_GLSL}
${VALUE_FBM_GLSL}
${DITHER_GLSL}

vec2 maskUv(vec2 d) {
  float lon = uProj.x + (d.x - HALF_ASPECT) * uProj.z * uProj.w;
  float lat = uProj.y - (d.y - 0.5) * uProj.z;
  return vec2(lon / 360.0 + 0.5, 0.5 - lat / 180.0);
}

/** Mask texels from the coast, positive on land, crinkled below the mask's resolution. */
float coast(vec2 d) {
  vec2 uv = maskUv(d);
  float sd = textureBSpline(uMask, uMaskSize, uv).r * GAIN - BIAS;
  return sd + (fbm(uv * MASK_TEXELS * 0.8, 3.0) - 0.5) * 1.3;
}

void main() {
  vec2 d = uView.xy + vec2(gl_FragCoord.x, uView.w - gl_FragCoord.y) * uView.z;
  float sd = coast(d);
  float land = smoothstep(-uShade.x, uShade.x, sd);
  vec3 sea = mix(uSeaDeep, uSea, smoothstep(-4.0, 0.0, sd));
  // Land casts a soft shadow down and right onto the sea.
  float shadow = smoothstep(-uShade.y, uShade.y, coast(d - vec2(SHADOW_OFFSET)));
  sea *= 1.0 - uShade.z * shadow;

  vec3 ground = uLand;
  if (uLook.x > 0.0) {
    // Hills a constant size on screen, whatever the region's scale.
    vec2 t = d * 7.0;
    float h = fbm(t, 7.0);
    float hx = fbm(t + vec2(0.15, 0.0), 7.0) - fbm(t - vec2(0.15, 0.0), 7.0);
    float hy = fbm(t + vec2(0.0, 0.15), 7.0) - fbm(t - vec2(0.0, 0.15), 7.0);
    float inland = smoothstep(0.0, 4.0, sd);
    // Lit from the top left.
    float shade = 1.0 + uLook.x * inland * (hx + hy) * 0.9;
    ground = mix(uLand, uLandHigh, uLook.x * inland * smoothstep(0.35, 0.75, h)) * shade;
  }
  vec3 col = mix(sea, ground, land);
  col = mix(col, uCoast, uLook.y * (1.0 - smoothstep(0.0, uLook.z, abs(sd))));
  vec2 v = (d - vec2(HALF_ASPECT, 0.5)) / vec2(HALF_ASPECT, 0.5);
  col *= 1.0 - uLook.w * 0.35 * min(dot(v, v), 1.5);
  outColor = vec4(clamp(col + dither8(gl_FragCoord.xy), 0.0, 1.0), 1.0);
}
`;

/** Pressure (encoded) and rain at reduced resolution, from the systems and fronts. */
const FIELD_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec4 uView;
uniform float uRows;
/** Per system: x, y, signed amplitude (hPa); quadratic form a, b, c and rain radius. */
uniform vec4 uSysA[${String(SYSTEM_COUNT)}];
uniform vec4 uSysB[${String(SYSTEM_COUNT)}];
/** Front segments, ${String(SEGMENTS)} per front: start and end. */
uniform vec4 uSeg[${String(MAX_GPU_FRONTS * SEGMENTS)}];
/** Per front: opacity, 1 / rain width, rain peak. */
uniform vec3 uFront[${String(MAX_GPU_FRONTS)}];
uniform int uFronts;
uniform sampler2D uNoise;
/** Noise offset (uv) and frequency (tiles per design unit). */
uniform vec3 uNoiseOff;
uniform float uFloat;
out vec4 outColor;

const float BASE = ${glslFloat(BASE_PRESSURE)};
const float PMIN = ${glslFloat(PRESSURE_MIN)};
const float PRANGE = ${glslFloat(PRESSURE_RANGE)};
const float LOW_RAIN_PEAK = ${glslFloat(LOW_RAIN_PEAK)};
const float SLOPE = ${glslFloat(TROUGH_SLOPE * TROUGH_REACH)};
const float REACH = ${glslFloat(TROUGH_REACH)};
const float SOFT2 = ${glslFloat(TROUGH_SOFT * TROUGH_SOFT)};
${ENCODE_HEIGHT_GLSL}

void main() {
  vec2 d = uView.xy + vec2(gl_FragCoord.x, uRows - gl_FragCoord.y) * uView.zw;
  float p = BASE;
  float rain = 0.0;
  for (int i = 0; i < ${String(SYSTEM_COUNT)}; i++) {
    vec4 a = uSysA[i];
    vec4 b = uSysB[i];
    vec2 q = d - a.xy;
    p += a.z * exp(-(b.x * q.x * q.x + 2.0 * b.y * q.x * q.y + b.z * q.y * q.y));
    if (a.z < 0.0) {
      rain = max(rain, LOW_RAIN_PEAK * smoothstep(8.0, 18.0, -a.z) * exp(-dot(q, q) / (b.w * b.w)));
    }
  }
  for (int f = 0; f < ${String(MAX_GPU_FRONTS)}; f++) {
    if (f >= uFronts) {
      break;
    }
    float dist = 1e9;
    for (int j = 0; j < ${String(SEGMENTS)}; j++) {
      vec4 s = uSeg[f * ${String(SEGMENTS)} + j];
      vec2 pa = d - s.xy;
      vec2 ba = s.zw - s.xy;
      float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-10), 0.0, 1.0);
      dist = min(dist, length(pa - t * ba));
    }
    vec3 info = uFront[f];
    p += info.x * SLOPE * (tanh(sqrt(dist * dist + SOFT2) / REACH) - 1.0);
    float w = dist * info.y;
    rain = max(rain, info.x * info.z * exp(-w * w));
  }
  // Break the rain into drifting blobs; the factor averages about 1.
  vec2 n = texture(uNoise, d * uNoiseOff.z - uNoiseOff.xy).rg;
  rain *= clamp(1.6 * (0.65 * n.x + 0.35 * n.y) + 0.2, 0.0, 1.5);
  outColor = vec4(encodeHeight((p - PMIN) / PRANGE, uFloat), clamp(rain, 0.0, 1.0), 1.0);
}
`;

/** Full-res composite: the map, the rain wash and the isobars. */
const COMPOSITE = /* glsl */ `
uniform sampler2D uMapA;
uniform sampler2D uMapB;
uniform float uMapMix;
uniform float uDecode;
uniform float uLevels;
/** Isobar half width (px), opacity, glow opacity and glow radius (px). */
uniform vec4 uIso;
uniform vec2 uCrowd;
uniform vec3 uIsoColor;
uniform float uIsoAlpha;
uniform float uRainAlpha;
uniform vec3 uRainLo;
uniform vec3 uRainMid;
uniform vec3 uRainHi;
${BSPLINE_GLSL}
${CONTOUR_LEVEL_GLSL}

vec4 composite(vec2 uv) {
  vec3 col = texture(uMapA, uv).rgb;
  if (uMapMix > 0.0) {
    col = mix(col, texture(uMapB, uv).rgb, uMapMix);
  }
  vec4 f = textureBSpline(uLowRes, uLowResSize, uv);
  float rain = f.b;
  vec3 rc = mix(uRainLo, uRainMid, smoothstep(0.46, 0.58, rain));
  rc = mix(rc, uRainHi, smoothstep(0.7, 0.82, rain));
  col = mix(col, rc, uRainAlpha * smoothstep(0.2, 0.3, rain));

  vec3 level = contourLevel((f.r + f.g * uDecode) * uLevels);
  float crowd = smoothstep(uCrowd.x, uCrowd.y, 1.0 / level.z);
  float line = clamp(uIso.x + 0.5 - abs(level.y), 0.0, 1.0) * uIso.y;
  float glow = uIso.z * exp(-(level.y * level.y) / (uIso.w * uIso.w));
  col = mix(col, uIsoColor, clamp(line + glow, 0.0, 1.0) * crowd * uIsoAlpha);
  return vec4(col, 1.0);
}
`;

/** Instanced SDF shapes: rounded boxes, front segments, triangles, semicircles and discs. */
const SHAPE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre and half size in px (y down). */
layout(location = 1) in vec4 aBox;
/** Local x axis (cos, sin), kind, corner radius in px. */
layout(location = 2) in vec4 aShape;
layout(location = 3) in vec4 aColor;
/** Edge softness in px, gloss. */
layout(location = 4) in vec2 aSoft;
/** Front segments: the previous segment's ends in px, so joints aren't drawn twice. */
layout(location = 5) in vec4 aPrev;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec4 vShape;
out vec4 vColor;
flat out vec2 vSoft;
out vec4 vPrev;
${TO_CLIP_GLSL}
void main() {
  vec2 ax = aShape.xy;
  vec2 ay = vec2(-ax.y, ax.x);
  vec2 local = aCorner * (aBox.zw + aSoft.x + 1.0);
  vLocal = local;
  vShape = vec4(aBox.zw, aShape.zw);
  vColor = aColor;
  vSoft = aSoft;
  vec2 a = aPrev.xy - aBox.xy;
  vec2 b = aPrev.zw - aBox.xy;
  vPrev = vec4(dot(a, ax), dot(a, ay), dot(b, ax), dot(b, ay));
  gl_Position = pxToClip(aBox.xy + local.x * ax + local.y * ay, uResolution);
}
`;

const SHAPE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vShape;
in vec4 vColor;
flat in vec2 vSoft;
in vec4 vPrev;
out vec4 outColor;

// Isosceles triangle with its apex at the origin and base at y = q.y (Inigo Quilez, MIT).
float sdTriangle(vec2 p, vec2 q) {
  p.x = abs(p.x);
  vec2 a = p - q * clamp(dot(p, q) / dot(q, q), 0.0, 1.0);
  vec2 b = p - q * vec2(clamp(p.x / q.x, 0.0, 1.0), 1.0);
  float s = -sign(q.y);
  vec2 d = min(vec2(dot(a, a), s * (p.x * q.y - p.y * q.x)), vec2(dot(b, b), s * (p.y - q.y)));
  return -sqrt(d.x) * sign(d.y);
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0));
}

void main() {
  vec2 p = vLocal;
  vec2 h = vShape.xy;
  float kind = vShape.z;
  float w = max(vSoft.x, 0.7);
  float d;
  float covered = 0.0;
  if (kind < 0.5) {
    vec2 q = abs(p) - h + vShape.w;
    d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - vShape.w;
  } else if (kind < 1.5) {
    d = length(vec2(max(abs(p.x) - (h.x - h.y), 0.0), p.y)) - h.y;
    // Leave out what the previous segment already covered.
    float prev = sdSegment(p, vPrev.xy, vPrev.zw) - h.y;
    covered = 1.0 - smoothstep(-w, w, prev);
    d = min(d, prev);
  } else if (kind < 2.5) {
    d = sdTriangle(vec2(p.x, h.y - p.y), h);
  } else if (kind < 3.5) {
    d = max(length(p) - h.x, -p.y);
  } else {
    d = length(p) - h.x;
  }
  float a = clamp(1.0 - smoothstep(-w, w, d) - covered, 0.0, 1.0) * vColor.a;
  vec3 c = vColor.rgb * (1.0 + vSoft.y * (0.2 - 0.32 * p.y / max(h.y, 1.0)));
  outColor = vec4(c * a, a);
}
`;

/** Textured sprites from the symbol atlas (premultiplied). */
const IMAGE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aBox;
layout(location = 2) in vec4 aUv;
layout(location = 3) in float aAlpha;
uniform vec2 uResolution;
out vec2 vUv;
out float vAlpha;
${TO_CLIP_GLSL}
void main() {
  vUv = mix(aUv.xy, aUv.zw, aCorner * 0.5 + 0.5);
  vAlpha = aAlpha;
  gl_Position = pxToClip(aBox.xy + aCorner * aBox.zw, uResolution);
}
`;

const IMAGE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D uAtlas;
in vec2 vUv;
in float vAlpha;
out vec4 outColor;
void main() {
  outColor = texture(uAtlas, vUv) * vAlpha;
}
`;

/** Shape kinds, as the shape shader reads them. */
const BOX = 0;
const SEGMENT = 1;
const TRIANGLE_SHAPE = 2;
const SEMICIRCLE_SHAPE = 3;

const STYLE_IDS: readonly MapStyle[] = ["classic", "modern"];
/** Symbol atlas cells per style: the icons, then H and L. */
const CELLS_PER_STYLE = ICONS.length + 2;
const ATLAS_COLUMNS = 5;
/** Text atlas glyphs: the digits, the minus sign and the degree sign. */
const GLYPHS = "0123456789" + MINUS;

const REGION_IDS: readonly RegionId[] = REGION_OPTIONS.map((o) => o.value);
const SEASON_IDS: readonly SeasonId[] = SEASON_OPTIONS.map((o) => o.value);
const regionId = (v: string): RegionId => REGION_IDS.find((r) => r === v) ?? "british";
const seasonId = (v: string): SeasonId => SEASON_IDS.find((s) => s === v) ?? "autumn";
const styleId = (v: string): MapStyle => (v === "modern" ? "modern" : "classic");

interface MapSlot {
  target: RenderTarget | null;
  region: RegionId;
  style: MapStyle;
}

/**
 * A TV weather map for the speaker to present in front of: the region's land
 * and sea baked once per region, style and size; a reduced-resolution field of
 * pressure and rain from the drifting systems, drawn as isobars and a radar
 * wash in one full-res pass; fronts and their symbols as instanced SDF shapes;
 * and the cities' icons, temperature boxes and names, with the day banner, as
 * sprites from two canvas atlases. Every `pace` seconds the forecast moves on a
 * day: the icons cross-fade and the temperatures roll digit by digit.
 */
export const weathermap = defineEffect(weathermapMeta, {
  create(gl) {
    return withScope((scope) => {
      const mapProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, MAP_FRAGMENT);
      const fieldProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FIELD_FRAGMENT);
      const shapeProgram = scopedProgram(gl, scope, SHAPE_VERTEX, SHAPE_FRAGMENT);
      const imageProgram = scopedProgram(gl, scope, IMAGE_VERTEX, IMAGE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const field = scope.own(createLowResTarget(gl, { format: "rgba16f", composite: COMPOSITE }));
      const shapes = scope.own(createSpriteBatch(gl, MAX_SHAPES, [4, 4, 4, 2, 4]));
      const images = scope.own(createSpriteBatch(gl, MAX_IMAGES, [4, 4, 1]));
      const symbolAtlas = createCanvasAtlas(gl, scope);
      const text = createTextLayer(gl, scope, MAX_TEXT_QUADS);

      const mu = createUniforms(gl, mapProgram, [
        "uMask",
        "uMaskSize",
        "uView",
        "uProj",
        "uShade",
        "uSea",
        "uSeaDeep",
        "uLand",
        "uLandHigh",
        "uCoast",
        "uLook",
      ]);
      const fu = createUniforms(gl, fieldProgram, [
        "uView",
        "uRows",
        "uSysA",
        "uSysB",
        "uSeg",
        "uFront",
        "uFronts",
        "uNoise",
        "uNoiseOff",
        "uFloat",
      ]);
      const cu = createUniforms(gl, field.program, [
        "uMapA",
        "uMapB",
        "uMapMix",
        "uDecode",
        "uLevels",
        "uIso",
        "uCrowd",
        "uIsoColor",
        "uIsoAlpha",
        "uRainAlpha",
        "uRainLo",
        "uRainMid",
        "uRainHi",
      ]);
      const su = createUniforms(gl, shapeProgram, ["uResolution"]);
      const iu = createUniforms(gl, imageProgram, ["uResolution", "uAtlas"]);
      gl.useProgram(mapProgram);
      mu.i1("uMask", 0);
      gl.useProgram(fieldProgram);
      fu.i1("uNoise", 0);
      gl.useProgram(field.program);
      cu.i1("uMapA", 1);
      cu.i1("uMapB", 2);
      gl.useProgram(imageProgram);
      iu.i1("uAtlas", 0);

      // Until the land mask loads, a single "far out at sea" texel.
      const mask = scope.add(
        createDataTexture(gl, {
          width: 1,
          height: 1,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: new Uint8Array([0]),
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      let maskW = 1;
      let maskH = 1;
      let maskLoads = 0;
      const maskImage = loadLandMask(scope, "Weather Forecast Map");
      const noise = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, [
            { period: 4, seed: 2027 },
            { period: 8, seed: 2029 },
          ]),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      // Map caches, cross-fading on a region or style change.
      const slotA: MapSlot = { target: null, region: "british", style: "classic" };
      const slotB: MapSlot = { target: null, region: "british", style: "classic" };
      const releaseSlot = (slot: MapSlot) => {
        slot.target?.dispose();
        slot.target = null;
      };
      scope.defer(() => {
        releaseSlot(slotA);
        releaseSlot(slotB);
      });
      const maps = createCrossfadeSlots<MapSlot>([slotA, slotB], MAP_FADE, releaseSlot);

      let width = 1;
      let height = 1;
      /** Design window: left, top, units per px. */
      const view = [0, 0, 1];
      /** Px per design unit, and px per 1080p px. */
      let ppu = 1080;
      let k = 1;
      let sized = false;

      // The forecast.
      const startWeekday = new Date().getDay();
      const seedBase = 2026;
      let forecasts = 0;
      let forecast: Forecast = createForecast("british", seedBase);
      let shownRegion: RegionId | null = null;
      const clock = createDayClock(25, MIN_PACE, MAX_PACE);
      const state = createWeatherState();
      const regionFade = createFadeThrough(REGION_HALF);
      let today: CityForecast[] = [];
      let yesterday: CityForecast[] = [];
      let iconT = ICON_FADE;
      let units = "c";
      // Temperatures: rolling from one text to another.
      const fromText: string[] = [];
      const toText: string[] = [];
      const fromC = new Float64Array(8);
      const toC = new Float64Array(8);
      let rollT = ROLL_SECONDS;
      // Banner: two text slots cross-fading.
      const bannerText = ["", ""];
      const bannerWidth = [0, 0];
      let bannerSlot = 0;
      let bannerT = BANNER_FADE;
      let bannerDirty = [true, true];
      let namesDirty = true;
      let glyphsDirty = true;
      let atlasDirty = true;
      /** Card positions in px: icon centres. */
      const cityPx = new Float64Array(16);
      const pt = [0, 0];

      const style = createColorEase(S.count);
      let radarMix = 1;
      const symbols = new Float32Array(MAX_SYMBOLS * SYMBOL_STRIDE);
      const sysA = new Float32Array(SYSTEM_COUNT * 4);
      const sysB = new Float32Array(SYSTEM_COUNT * 4);
      const segs = new Float32Array(MAX_GPU_FRONTS * SEGMENTS * 4);
      const frontInfo = new Float32Array(MAX_GPU_FRONTS * 3);
      const gpuFront = new Int32Array(MAX_GPU_FRONTS);
      const palette = new Float32Array(TEXT_PALETTE_FLOATS);
      const shadowPalette = new Float32Array(TEXT_PALETTE_FLOATS);
      const white = [1, 1, 1];
      const black = [0, 0, 0];
      const colour = new Float32Array(3);
      const mapKey = createChangeKey(3);

      const tempIn = (c: number) => (units === "f" ? toFahrenheit(c) : c);

      const placeCities = () => {
        const region = forecast.region;
        region.cities.forEach((city, c) => {
          project(region, city.lat, city.lon, pt);
          cityPx[2 * c] = Math.round((pt[0] - view[0]) * ppu);
          cityPx[2 * c + 1] = Math.round((pt[1] - view[1]) * ppu);
        });
      };

      const startForecast = (id: RegionId, season: SeasonId, pace: number) => {
        forecast = createForecast(id, seedBase + forecasts * 7919);
        forecasts++;
        shownRegion = id;
        clock.reset(pace);
        today = forecastDay(forecast, 0, season, []);
        yesterday = today.map((c) => ({ ...c }));
        iconT = ICON_FADE;
        fromText.length = 0;
        toText.length = 0;
        today.forEach((c, i) => {
          const t = formatTemp(tempIn(c.tempC));
          fromText[i] = t;
          toText[i] = t;
          fromC[i] = c.tempC;
          toC[i] = c.tempC;
        });
        rollT = ROLL_SECONDS;
        bannerText[bannerSlot] = dayName(startWeekday, 0);
        bannerText[1 - bannerSlot] = "";
        bannerDirty = [true, true];
        bannerT = BANNER_FADE;
        namesDirty = true;
        placeCities();
      };

      /** Starts the temperatures rolling to their values in today's forecast and the current units. */
      const rollTemps = () => {
        today.forEach((c, i) => {
          fromText[i] = toText[i];
          fromC[i] = toC[i];
          toText[i] = formatTemp(tempIn(c.tempC));
          toC[i] = c.tempC;
        });
        rollT = 0;
      };

      const nextDay = (season: SeasonId) => {
        const prev = yesterday;
        yesterday = today;
        today = forecastDay(forecast, clock.day, season, prev);
        iconT = 0;
        rollTemps();
        bannerSlot = 1 - bannerSlot;
        bannerText[bannerSlot] = dayName(startWeekday, clock.day);
        bannerDirty[bannerSlot] = true;
        bannerT = 0;
      };

      // ---- Atlases ----------------------------------------------------------------

      let cell = 1;
      const drawSymbolAtlas = () => {
        cell = Math.ceil(ICON_SIZE * ppu * 1.3);
        const rows = Math.ceil((CELLS_PER_STYLE * STYLE_IDS.length) / ATLAS_COLUMNS);
        if (!symbolAtlas.resize(cell * ATLAS_COLUMNS, cell * rows)) {
          return;
        }
        symbolAtlas.clear(0, 0, symbolAtlas.width, symbolAtlas.height);
        const ctx = symbolAtlas.ctx;
        if (!ctx) {
          return;
        }
        STYLE_IDS.forEach((s, si) => {
          for (let i = 0; i < CELLS_PER_STYLE; i++) {
            const n = si * CELLS_PER_STYLE + i;
            const x = (n % ATLAS_COLUMNS) * cell + cell / 2;
            const y = Math.floor(n / ATLAS_COLUMNS) * cell + cell / 2;
            if (i < ICONS.length) {
              drawIcon(ctx, ICONS[i], s, x, y, ICON_SIZE * ppu);
            } else {
              drawPressureLetter(ctx, i === ICONS.length ? "H" : "L", s, x, y, LETTER_SIZE * ppu);
            }
          }
        });
        symbolAtlas.flush();
      };

      // Text atlas rows: glyphs, then the names two to a row, then the two banner slots.
      let glyphW = 1;
      let glyphH = 1;
      let degreeW = 1;
      let nameW = 1;
      let nameH = 1;
      let bannerW = 1;
      let bannerH = 1;
      const namesTop = () => glyphH;
      const bannerTop = () => glyphH + 4 * nameH;
      const sizeText = () => {
        glyphW = Math.ceil(DIGIT_CELL * ppu);
        degreeW = Math.ceil(DEGREE_CELL * ppu);
        glyphH = Math.ceil(BOX_HEIGHT * ppu);
        nameW = Math.ceil(NAME_SLOT * ppu);
        nameH = Math.ceil(NAME_FONT * 1.7 * ppu);
        bannerW = Math.ceil(BANNER_SLOT * ppu);
        bannerH = Math.ceil(BANNER_FONT * 1.6 * ppu);
        const w = Math.max(glyphW * GLYPHS.length + degreeW, 2 * nameW, 2 * bannerW);
        text.resize(w, glyphH + 4 * nameH + bannerH);
        glyphsDirty = true;
        namesDirty = true;
        bannerDirty = [true, true];
      };

      const drawText = () => {
        const ctx = text.ctx;
        if (!ctx) {
          return;
        }
        if (glyphsDirty) {
          glyphsDirty = false;
          text.clear(0, 0, glyphW * GLYPHS.length + degreeW, glyphH);
          const font = `700 ${String(Math.round(BOX_FONT * ppu))}px ${SANS_FONT_STACK}`;
          for (let i = 0; i < GLYPHS.length; i++) {
            text.fill(
              GLYPHS[i],
              (i + 0.5) * glyphW,
              glyphH / 2,
              TEXT_ROLES.inverse,
              font,
              glyphW,
              "center",
            );
          }
          const small = `700 ${String(Math.round(BOX_FONT * 0.8 * ppu))}px ${SANS_FONT_STACK}`;
          text.fill(
            "°",
            GLYPHS.length * glyphW + 0.45 * degreeW,
            glyphH * 0.42,
            TEXT_ROLES.inverse,
            small,
            degreeW,
            "center",
          );
        }
        if (namesDirty) {
          namesDirty = false;
          text.clear(0, namesTop(), 2 * nameW, 4 * nameH);
          const font = `700 ${String(Math.round(NAME_FONT * ppu))}px ${SANS_FONT_STACK}`;
          forecast.region.cities.forEach((city, c) => {
            const x = (c % 2) * nameW + nameW / 2;
            const y = namesTop() + Math.floor(c / 2) * nameH + nameH / 2;
            text.fill(city.name, x, y, TEXT_ROLES.primary, font, nameW, "center");
          });
        }
        for (let s = 0; s < 2; s++) {
          if (!bannerDirty[s]) {
            continue;
          }
          bannerDirty[s] = false;
          text.clear(s * bannerW, bannerTop(), bannerW, bannerH);
          const font = `700 ${String(Math.round(BANNER_FONT * ppu))}px ${SANS_FONT_STACK}`;
          text.fill(
            bannerText[s],
            s * bannerW,
            bannerTop() + bannerH / 2,
            TEXT_ROLES.muted,
            font,
            bannerW,
            "left",
          );
          ctx.font = font;
          // Stand-in canvases (tests) measure nothing.
          const metrics = ctx.measureText(bannerText[s]) as TextMetrics | undefined;
          bannerWidth[s] =
            bannerText[s] === "" ? 0 : Math.min(bannerW, metrics?.width ?? 0.6 * bannerW);
        }
        text.flush();
      };

      // ---- Map ---------------------------------------------------------------------

      const drawMap = (slot: MapSlot) => {
        slot.target ??= createRenderTarget(gl, width, height, gl.RGBA8);
        if (!slot.target) {
          return;
        }
        const region = REGIONS[slot.region];
        const look = MAP_LOOKS[slot.style];
        slot.target.bind();
        gl.useProgram(mapProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, mask);
        mu.f2("uMaskSize", maskW, maskH);
        mu.f4("uView", view[0], view[1], view[2], height);
        mu.f4(
          "uProj",
          region.lon,
          region.lat,
          region.span,
          1 / Math.cos((region.lat * Math.PI) / 180),
        );
        // Mask texels per design unit, from its latitude scale.
        const texels = (region.span * maskH) / 180;
        const perPx = texels * view[2];
        mu.f3(
          "uShade",
          Math.max(0.02, 0.75 * perPx),
          Math.max(0.02, SHADOW_BLUR * texels),
          look.shadowAlpha,
        );
        mu.rgb("uSea", look.sea);
        mu.rgb("uSeaDeep", look.seaDeep);
        mu.rgb("uLand", look.land);
        mu.rgb("uLandHigh", look.landHigh);
        mu.rgb("uCoast", look.coast);
        mu.f4(
          "uLook",
          look.look[0],
          look.look[1],
          Math.max(look.look[2], 1.2 * perPx),
          look.look[3],
        );
        triangle.draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      };

      const updateMap = (region: RegionId, mapStyle: MapStyle) => {
        mapKey.set(0, REGION_IDS.indexOf(region));
        mapKey.set(1, STYLE_IDS.indexOf(mapStyle));
        // When the mask arrives, the plain sea fades to the map.
        mapKey.set(2, maskLoads);
        const current = maps.current;
        if (!current.target) {
          current.region = region;
          current.style = mapStyle;
          drawMap(current);
          mapKey.take();
        } else if (!maps.fading && mapKey.take()) {
          const next = maps.next;
          next.region = region;
          next.style = mapStyle;
          drawMap(next);
          maps.start();
        }
      };

      // ---- Per-frame geometry --------------------------------------------------------

      let shapeCount = 0;
      const pushShape = (
        cx: number,
        cy: number,
        hw: number,
        hh: number,
        ax: number,
        ay: number,
        kind: number,
        radius: number,
        rgb: ArrayLike<number>,
        ro: number,
        alpha: number,
        soft: number,
        gloss: number,
      ) => {
        if (shapeCount >= MAX_SHAPES || !(alpha > 0.002)) {
          return -1;
        }
        const d = shapes.data;
        const o = shapeCount * shapes.stride;
        d[o] = cx;
        d[o + 1] = cy;
        d[o + 2] = hw;
        d[o + 3] = hh;
        d[o + 4] = ax;
        d[o + 5] = ay;
        d[o + 6] = kind;
        d[o + 7] = radius;
        d[o + 8] = rgb[ro];
        d[o + 9] = rgb[ro + 1];
        d[o + 10] = rgb[ro + 2];
        d[o + 11] = alpha;
        d[o + 12] = soft;
        d[o + 13] = gloss;
        // No previous segment: far away.
        d[o + 14] = -1e5;
        d[o + 15] = -1e5;
        d[o + 16] = -1e5;
        d[o + 17] = -1e5;
        return shapeCount++;
      };

      let imageCount = 0;
      const pushImage = (cx: number, cy: number, half: number, index: number, alpha: number) => {
        if (imageCount >= MAX_IMAGES || !(alpha > 0.002)) {
          return;
        }
        const aw = symbolAtlas.width || 1;
        const ah = symbolAtlas.height || 1;
        const col = index % ATLAS_COLUMNS;
        const row = Math.floor(index / ATLAS_COLUMNS);
        const d = images.data;
        const o = imageCount * images.stride;
        d[o] = cx;
        d[o + 1] = cy;
        d[o + 2] = half;
        d[o + 3] = half;
        d[o + 4] = (col * cell) / aw;
        d[o + 5] = (row * cell) / ah;
        d[o + 6] = ((col + 1) * cell) / aw;
        d[o + 7] = ((row + 1) * cell) / ah;
        d[o + 8] = alpha;
        imageCount++;
      };

      const toPxX = (x: number) => (x - view[0]) * ppu;
      const toPxY = (y: number) => (y - view[1]) * ppu;

      /** Front lines and symbols. */
      const pushFronts = (ov: number, s: Float32Array) => {
        const lineR = 0.5 * s[S.frontWidth] * k;
        for (let f = 0; f < state.frontCount; f++) {
          const alpha = state.alpha[f] * ov;
          if (!(alpha > 0.002)) {
            continue;
          }
          const ro = state.kinds[f] === 0 ? S.cold : state.kinds[f] === 1 ? S.warm : S.occluded;
          const o = f * FRONT_POINTS * 2;
          let prev = -1;
          for (let j = 0; j < SEGMENTS; j++) {
            const ax = toPxX(state.points[o + 2 * j]);
            const ay = toPxY(state.points[o + 2 * j + 1]);
            const bx = toPxX(state.points[o + 2 * j + 2]);
            const by = toPxY(state.points[o + 2 * j + 3]);
            const len = Math.hypot(bx - ax, by - ay);
            if (!(len > 0)) {
              continue;
            }
            const i = pushShape(
              (ax + bx) / 2,
              (ay + by) / 2,
              len / 2 + lineR,
              lineR,
              (bx - ax) / len,
              (by - ay) / len,
              SEGMENT,
              0,
              s,
              ro,
              alpha,
              0,
              0,
            );
            if (i >= 0 && prev >= 0) {
              const d = shapes.data;
              const q = i * shapes.stride + 14;
              const pq = prev * shapes.stride;
              // The previous segment's ends, back from its centre and axis.
              const half = d[pq + 2] - d[pq + 3];
              d[q] = d[pq] - d[pq + 4] * half;
              d[q + 1] = d[pq + 1] - d[pq + 5] * half;
              d[q + 2] = d[pq] + d[pq + 4] * half;
              d[q + 3] = d[pq + 1] + d[pq + 5] * half;
            }
            prev = i;
          }
        }
        const n = frontSymbols(state, symbols, MAX_SYMBOLS);
        const size = s[S.symbolSize] * k;
        for (let i = 0; i < n; i++) {
          const q = i * SYMBOL_STRIDE;
          const kind = symbols[q + 5];
          const ro = kind === 0 ? S.cold : kind === 1 ? S.warm : S.occluded;
          const nx = symbols[q + 2];
          const ny = symbols[q + 3];
          const semi = symbols[q + 4] === SEMICIRCLE;
          pushShape(
            toPxX(symbols[q]),
            toPxY(symbols[q + 1]),
            semi ? 0.62 * size : 0.72 * size,
            semi ? 0.62 * size : size,
            ny,
            -nx,
            semi ? SEMICIRCLE_SHAPE : TRIANGLE_SHAPE,
            0,
            s,
            ro,
            symbols[q + 6] * ov,
            0,
            0,
          );
        }
      };

      const pushLetters = (ov: number, mix: number) => {
        const half = cell / 2;
        for (let i = 0; i < SYSTEM_COUNT; i++) {
          const o = i * SYSTEM_STRIDE;
          const amp = state.systems[o + 2];
          const a = smoothstep(LETTER_FROM, LETTER_FULL, Math.abs(amp)) * ov;
          if (!(a > 0.002)) {
            continue;
          }
          const x = toPxX(state.systems[o]);
          const y = toPxY(state.systems[o + 1]);
          if (x < -half || y < -half || x > width + half || y > height + half) {
            continue;
          }
          // Fade out under a city's icon rather than peek out round it.
          let near = Infinity;
          for (let c = 0; c < today.length; c++) {
            near = Math.min(near, Math.hypot(x - cityPx[2 * c], y - cityPx[2 * c + 1]));
          }
          const clear = smoothstep(0.5, 1.1, near / (ICON_SIZE * ppu));
          const letter = ICONS.length + (amp > 0 ? 0 : 1);
          pushImage(x, y, half, letter, a * clear * (1 - mix));
          pushImage(x, y, half, CELLS_PER_STYLE + letter, a * clear * mix);
        }
      };

      const boxColour = new Float32Array(3);
      const pushCards = (ov: number, s: Float32Array) => {
        const cities = forecast.region.cities;
        const roll = smoothstep(0, 1, rollT / ROLL_SECONDS);
        const bh = BOX_HEIGHT * ppu;
        for (let c = 0; c < cities.length; c++) {
          const x = cityPx[2 * c];
          const y = cityPx[2 * c + 1];
          const fromW = boxWidth(fromText[c].length);
          const toW = boxWidth(toText[c].length);
          const w = (fromW + (toW - fromW) * roll) * ppu;
          const gap = BOX_GAP * ppu;
          const cx = cities[c].left === true ? x - gap - w / 2 : x + gap + w / 2;
          const cy = y + BOX_DROP * ppu;
          tempColour(fromC[c] + (toC[c] - fromC[c]) * roll, colour, 0);
          const tint = s[S.boxTint];
          for (let q = 0; q < 3; q++) {
            boxColour[q] = s[S.boxDark + q] + (colour[q] - s[S.boxDark + q]) * tint;
          }
          pushShape(
            cx + 2 * k,
            cy + 3 * k,
            w / 2,
            bh / 2,
            1,
            0,
            BOX,
            0.22 * bh,
            black,
            0,
            0.35 * ov,
            4 * k,
            0,
          );
          pushShape(
            cx,
            cy,
            w / 2,
            bh / 2,
            1,
            0,
            BOX,
            0.22 * bh,
            boxColour,
            0,
            s[S.boxAlpha] * ov,
            0,
            s[S.gloss],
          );
        }
        // Banner panel.
        const t = smoothstep(0, 1, bannerT / BANNER_FADE);
        const tw =
          bannerWidth[1 - bannerSlot] + (bannerWidth[bannerSlot] - bannerWidth[1 - bannerSlot]) * t;
        const pw = tw + 2 * BANNER_PAD * ppu;
        const ph = BANNER_HEIGHT * ppu;
        const px = BANNER_MARGIN * ppu + pw / 2;
        const py = BANNER_MARGIN * ppu + ph / 2;
        if (tw > 0) {
          pushShape(
            px + 2 * k,
            py + 3 * k,
            pw / 2,
            ph / 2,
            1,
            0,
            BOX,
            0.18 * ph,
            black,
            0,
            0.3 * ov,
            5 * k,
            0,
          );
          pushShape(
            px,
            py,
            pw / 2,
            ph / 2,
            1,
            0,
            BOX,
            0.18 * ph,
            s,
            S.panel,
            s[S.panelAlpha] * ov,
            0,
            0.6 * s[S.gloss],
          );
          const aw = ACCENT_WIDTH * ppu;
          pushShape(
            px - pw / 2 + aw / 2 + 0.25 * aw,
            py,
            aw / 2,
            ph * 0.32,
            1,
            0,
            BOX,
            aw / 2,
            s,
            S.accent,
            s[S.accentAlpha] * ov,
            0,
            0,
          );
        }
      };

      const pushIcons = (ov: number, mix: number) => {
        const fade = smoothstep(0, 1, iconT / ICON_FADE);
        const half = cell / 2;
        for (let c = 0; c < today.length; c++) {
          const x = cityPx[2 * c];
          const y = cityPx[2 * c + 1];
          const now = ICONS.indexOf(today[c].icon);
          const before = ICONS.indexOf(yesterday[c].icon);
          for (let si = 0; si < 2; si++) {
            const w = (si === 0 ? 1 - mix : mix) * ov;
            const base = si * CELLS_PER_STYLE;
            if (fade < 1 && before !== now) {
              pushImage(x, y, half, base + before, w * (1 - fade));
              pushImage(x, y, half, base + now, w * fade);
            } else {
              pushImage(x, y, half, base + now, w);
            }
          }
        }
      };

      /** Queues the temperature digits, names (or their shadows) and banner text. */
      const queueText = (ov: number, shadow: boolean) => {
        const off = shadow ? Math.max(1, Math.round(1.5 * k)) : 0;
        const cities = forecast.region.cities;
        const roll = smoothstep(0, 1, rollT / ROLL_SECONDS);
        const gy = namesTop();
        for (let c = 0; c < cities.length; c++) {
          const x = cityPx[2 * c];
          const y = cityPx[2 * c + 1];
          // Name, centred under the icon.
          const nx = (c % 2) * nameW;
          const ny = gy + Math.floor(c / 2) * nameH;
          text.quad(
            nx,
            ny,
            nameW,
            nameH,
            Math.round(x - nameW / 2) + off,
            Math.round(y + NAME_DROP * ppu - nameH / 2) + off,
            nameW,
            nameH,
            (shadow ? 0.7 : 1) * ov,
          );
          if (shadow) {
            continue;
          }
          // Temperature: digits right-aligned before the degree sign, each rolling up to its new value.
          const fromW = boxWidth(fromText[c].length);
          const toW = boxWidth(toText[c].length);
          const w = (fromW + (toW - fromW) * roll) * ppu;
          const gap = BOX_GAP * ppu;
          const right = cities[c].left === true ? x - gap : x + gap + w;
          const top = Math.round(y + BOX_DROP * ppu - glyphH / 2);
          const pad = BOX_PAD * ppu;
          const degX = Math.round(right - pad - DEGREE_CELL * ppu);
          text.quad(GLYPHS.length * glyphW, 0, degreeW, glyphH, degX, top, degreeW, glyphH, ov);
          const a = fromText[c];
          const b = toText[c];
          const slots = Math.min(MAX_DIGITS, Math.max(a.length, b.length));
          for (let j = 0; j < slots; j++) {
            const ga = GLYPHS.indexOf(a[a.length - 1 - j] ?? " ");
            const gb = GLYPHS.indexOf(b[b.length - 1 - j] ?? " ");
            const gx = Math.round(degX - (j + 1) * DIGIT_CELL * ppu);
            const r = ga === gb ? 1 : slotRoll(rollT, j);
            const shift = Math.round(r * glyphH);
            // The old glyph moves up and out of the box, the new one up into it.
            if (ga >= 0 && shift < glyphH) {
              text.quad(
                ga * glyphW,
                shift,
                glyphW,
                glyphH - shift,
                gx,
                top,
                glyphW,
                glyphH - shift,
                ov,
              );
            }
            if (gb >= 0 && shift > 0) {
              text.quad(gb * glyphW, 0, glyphW, shift, gx, top + glyphH - shift, glyphW, shift, ov);
            }
          }
        }
        // Banner text, cross-fading between days.
        const t = smoothstep(0, 1, bannerT / BANNER_FADE);
        const bx = Math.round((BANNER_MARGIN + BANNER_PAD) * ppu) + off;
        const by = Math.round((BANNER_MARGIN + BANNER_HEIGHT / 2) * ppu - bannerH / 2) + off;
        for (let s = 0; s < 2; s++) {
          const a = (s === bannerSlot ? t : 1 - t) * ov * (shadow ? 0 : 1);
          text.quad(s * bannerW, bannerTop(), bannerW, bannerH, bx, by, bannerW, bannerH, a);
        }
      };

      return {
        resize(v) {
          width = Math.max(1, Math.floor(v.width));
          height = Math.max(1, Math.floor(v.height));
          viewWindow(width, height, view);
          ppu = 1 / view[2];
          k = ppu / 1080;
          field.resize(width, height, Math.max(1, height / FIELD_ROWS));
          // Remake the map caches at the new size, keeping what they show.
          for (const slot of [slotA, slotB]) {
            if (slot.target) {
              slot.target.dispose();
              slot.target = null;
              drawMap(slot);
            }
          }
          atlasDirty = true;
          sizeText();
          if (shownRegion !== null) {
            placeCities();
          }
          sized = true;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          if (!sized) {
            return;
          }
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const region = regionId(p.region);
          const season = seasonId(p.season);
          const mapStyle = styleId(p.style);

          gl.activeTexture(gl.TEXTURE0);
          const image = maskImage.take();
          if (image) {
            gl.bindTexture(gl.TEXTURE_2D, mask);
            uploadLandMask(gl, image);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            maskW = image.naturalWidth || LAND_MASK_WIDTH;
            maskH = image.naturalHeight || LAND_MASK_WIDTH / 2;
            maskLoads++;
          }

          // A region change fades the forecast out, starts a new one and fades it in.
          if (shownRegion === null) {
            units = p.units;
            startForecast(region, season, p.pace);
          } else if (region !== shownRegion && regionFade.idle) {
            regionFade.start();
          }
          if (regionFade.step(step)) {
            startForecast(region, season, p.pace);
          }
          const ov = regionFade.alpha;
          if (clock.step(step, p.pace)) {
            nextDay(season);
          }
          if (p.units !== units) {
            units = p.units;
            rollTemps();
          }
          iconT += step;
          rollT += step;
          bannerT += step;
          const s = style.step(OVERLAY_STYLES[mapStyle], step, STYLE_FADE);
          const mix = s[S.mix];
          radarMix = approach(radarMix, p.radar ? 1 : 0, step / RADAR_FADE);
          evaluate(forecast, clock.tau, state);

          if (atlasDirty) {
            atlasDirty = false;
            drawSymbolAtlas();
          }
          drawText();

          updateMap(region, mapStyle);
          maps.step(step);

          // Pressure and rain field.
          const sys = state.systems;
          for (let i = 0; i < SYSTEM_COUNT; i++) {
            const o = i * SYSTEM_STRIDE;
            sysA[4 * i] = sys[o];
            sysA[4 * i + 1] = sys[o + 1];
            sysA[4 * i + 2] = sys[o + 2];
            sysA[4 * i + 3] = 0;
            sysB[4 * i] = sys[o + 3];
            sysB[4 * i + 1] = sys[o + 4];
            sysB[4 * i + 2] = sys[o + 5];
            sysB[4 * i + 3] = LOW_RAIN_RADIUS * sys[o + 6];
          }
          // The fronts nearest the frame, if there are more than the shader takes.
          const x0 = view[0] - 0.3;
          const y0 = view[1] - 0.3;
          const x1 = view[0] + width * view[2] + 0.3;
          const y1 = view[1] + height * view[2] + 0.3;
          let fronts = 0;
          for (let f = 0; f < state.frontCount && fronts < MAX_GPU_FRONTS; f++) {
            if (!(state.alpha[f] > 0)) {
              continue;
            }
            const o = f * FRONT_POINTS * 2;
            let inside = false;
            for (let j = 0; j < FRONT_POINTS && !inside; j++) {
              const x = state.points[o + 2 * j];
              const y = state.points[o + 2 * j + 1];
              inside = x > x0 && x < x1 && y > y0 && y < y1;
            }
            if (inside) {
              gpuFront[fronts++] = f;
            }
          }
          for (let g = 0; g < fronts; g++) {
            const f = gpuFront[g];
            const o = f * FRONT_POINTS * 2;
            for (let j = 0; j < SEGMENTS; j++) {
              const q = (g * SEGMENTS + j) * 4;
              segs[q] = state.points[o + 2 * j];
              segs[q + 1] = state.points[o + 2 * j + 1];
              segs[q + 2] = state.points[o + 2 * j + 2];
              segs[q + 3] = state.points[o + 2 * j + 3];
            }
            frontInfo[3 * g] = state.alpha[f];
            frontInfo[3 * g + 1] = 1 / RAIN_WIDTH[state.kinds[f]];
            frontInfo[3 * g + 2] = RAIN_PEAK[state.kinds[f]];
          }
          field.bind();
          gl.useProgram(fieldProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noise);
          const lw = field.width || 1;
          const lh = field.height || 1;
          fu.f4("uView", view[0], view[1], (view[2] * width) / lw, (view[2] * height) / lh);
          fu.f1("uRows", lh);
          gl.uniform4fv(fu.loc.uSysA, sysA);
          gl.uniform4fv(fu.loc.uSysB, sysB);
          if (fronts > 0) {
            gl.uniform4fv(fu.loc.uSeg, segs, 0, fronts * SEGMENTS * 4);
            gl.uniform3fv(fu.loc.uFront, frontInfo, 0, fronts * 3);
          }
          fu.i1("uFronts", fronts);
          const drift = (clock.tau * DRIFT_PER_DAY) / NOISE_TILE;
          fu.f3("uNoiseOff", fract(drift), 0, 1 / NOISE_TILE);
          fu.f1("uFloat", field.isFloat ? 1 : 0);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);

          // Map, rain and isobars.
          gl.useProgram(field.program);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, maps.current.target?.texture ?? null);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, maps.fading ? (maps.next.target?.texture ?? null) : null);
          cu.f1("uMapMix", maps.fading ? smoothstep(0, 1, maps.mix) : 0);
          cu.f1("uDecode", heightDecodeScale(field.isFloat));
          cu.f1("uLevels", PRESSURE_RANGE / ISOBAR_STEP);
          const hw = Math.max(0.5, 0.5 * s[S.isoWidth] * k);
          cu.f4("uIso", hw, s[S.isoAlpha], s[S.glowAlpha], Math.max(0.5, s[S.glowRadius] * k));
          cu.f2("uCrowd", 3 * hw + 1, 6 * hw + 2);
          cu.f3("uIsoColor", s[S.iso], s[S.iso + 1], s[S.iso + 2]);
          cu.f1("uIsoAlpha", ov);
          cu.f1("uRainAlpha", s[S.rainAlpha] * radarMix * ov);
          cu.f3("uRainLo", s[S.rainLo], s[S.rainLo + 1], s[S.rainLo + 2]);
          cu.f3("uRainMid", s[S.rainMid], s[S.rainMid + 1], s[S.rainMid + 2]);
          cu.f3("uRainHi", s[S.rainHi], s[S.rainHi + 1], s[S.rainHi + 2]);
          field.blit();
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);

          // Overlays: fronts, letters, cards, icons, then text.
          shapeCount = 0;
          imageCount = 0;
          pushFronts(ov, s);
          const frontShapes = shapeCount;
          pushLetters(ov, mix);
          const letterImages = imageCount;
          pushCards(ov, s);
          pushIcons(ov, mix);
          shapes.upload(shapeCount);
          images.upload(imageCount);

          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(shapeProgram);
          su.f2("uResolution", width, height);
          shapes.draw(0, frontShapes);
          gl.useProgram(imageProgram);
          iu.f2("uResolution", width, height);
          gl.bindTexture(gl.TEXTURE_2D, symbolAtlas.texture);
          images.draw(0, letterImages);
          gl.useProgram(shapeProgram);
          shapes.draw(frontShapes, shapeCount - frontShapes);
          gl.useProgram(imageProgram);
          gl.bindTexture(gl.TEXTURE_2D, symbolAtlas.texture);
          images.draw(letterImages, imageCount - letterImages);
          gl.bindTexture(gl.TEXTURE_2D, null);

          setTextPalette(shadowPalette, black, black, black, black, black);
          queueText(ov, true);
          text.draw(width, height, shadowPalette);
          setTextPalette(
            palette,
            white,
            s.subarray(S.bannerText, S.bannerText + 3),
            black,
            black,
            white,
          );
          queueText(ov, false);
          text.draw(width, height, palette);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
