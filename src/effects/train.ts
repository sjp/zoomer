import { cloudNoiseChannels } from "./clouds-sky";
import { hexToUnitRgb, type Rgb } from "./color";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat as F,
  withScope,
} from "./gl";
import { createSkyState, sampleSky } from "./horizon-sim";
import { createLowResTarget } from "./lowres";
import { clamp, fract, smoothstep } from "./math";
import { buildPeriodicNoiseTexture } from "./noise";
import {
  ARM_HALF,
  ARM_HALF_H,
  ARM_Y,
  BANK_CHANNELS,
  BANK_COLUMNS,
  BANK_PERIOD,
  BANK_Z,
  CAM_H,
  CLOUD_Z,
  createTimeState,
  createTrain,
  FAR_HILL_Z,
  FAR_LINE_Z,
  FAR_Y,
  FIELD_CHANNELS,
  FIELD_COLUMNS,
  FIELD_PERIOD,
  fillBankTable,
  fillFieldTable,
  fillHillTable,
  FOCAL,
  GROUND_SHIFT,
  HAZE_HALF,
  HILL_CHANNELS,
  HILL_COLUMNS,
  HILL_PERIOD,
  HORIZON_Y,
  HOUSE_FLOATS,
  HOUSE_MAX_H,
  HOUSE_Y,
  HOUSE_Z,
  lampAmount,
  MAX_HOUSES,
  MID_LINE_Z,
  MID_SHIFT,
  MID_Y,
  NEAR_HILL_Z,
  placeHouses,
  POLE_HALF_W,
  POLE_SPACING,
  POLE_TOP,
  POLE_Z,
  poleOffset,
  REF_HEIGHT,
  sampleTime,
  scrollOffset,
  shadeLayer,
  stepTime,
  stepTrain,
  SWAY_AMP,
  swayOffset,
  timeIndex,
  V_MAX,
  viewHouses,
  WIRE_DX,
  WIRE_HALF_W,
  WIRE_HIGH,
  WIRE_LOW,
  WIRE_SAG,
  WIRE_Y,
} from "./train-sim";
import { trainMeta } from "./train.meta";
import { defineEffect } from "./types";

/** Sky and hills pass: about 2 reference px per texel. Everything in it is soft or distant. */
const SKY_TEXEL_REF = 2;
const NOISE_SIZE = 256;
const NOISE_SEED = 7;
/** Cloud noise texture size on screen, reference px (wide, so the clouds are long and flat). */
const CLOUD_W = 2400;
const CLOUD_H = 900;
/** Cloud drift of their own, reference px per second leftwards. */
const CLOUD_WIND = 2;
/** Cloud cover threshold (on the octave sum, mean about 0.47) and its soft range. */
const CLOUD_TH = 0.505;
const CLOUD_SOFT = 0.06;
const SUN_RADIUS = 30;
/** Spacing of the crop rows along the track, world units. */
const CROP_ROW = 1.6;
const WORLD_K = FOCAL * CAM_H;

/** Window frame styles, reference px: side, top and bottom insets, corner radius, seal width and edge shade. */
const FRAMES = {
  carriage: { x: 78, top: 62, bottom: 104, radius: 84, seal: 11, shade: 0.32 },
  thin: { x: 20, top: 20, bottom: 20, radius: 34, seal: 8, shade: 0.18 },
} as const;

const C = hexToUnitRgb;
const HILL_FAR = C("#7d9a7e");
const HILL_NEAR = C("#5f8a52");
const FIELD = [C("#6b9a40"), C("#9bbb55"), C("#d6bd6a")] as const;
const HEDGE = C("#36522a");
const FOLIAGE_DARK = C("#2c4a22");
const FOLIAGE_LIT = C("#5a7f36");
const WALL = C("#e6dfcf");
const ROOF_TILE = C("#7a4836");
const ROOF_SLATE = C("#4c525c");
const WINDOW_DARK = C("#2c3138");
const WINDOW_LIT = C("#ffc865");
const BANK_LIT = C("#6a9a3c");
const BANK_DARK = C("#3f6a28");
const POLE = C("#5a4634");
const WIRE = C("#1c1a19");
const PANEL = C("#d9d0bf");
const SEAL = C("#2b2b2d");
const LAMP = C("#ffd8a0");
const SUN_LOW = C("#ff8a3a");
const SUN_HIGH = C("#fff4dc");

/**
 * Sky, clouds and hills at low resolution: the horizon-to-zenith gradient with
 * the sun's glow and disc, clouds from one coarse and one detail fetch of the
 * tiling noise, and two hill ridges from the hill table (one fetch each),
 * edge-covered from derivatives. Everything is shifted by the carriage sway.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uHills;
uniform sampler2D uNoise;
/** Low-res px -> reference px. */
uniform vec2 uPxToRef;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSunColor;
/** Sun x, y (reference px), radius (reference px), glow strength. */
uniform vec4 uSun;
/** Far and near hill scroll (periods), cloud scroll (periods), sway (reference px). */
uniform vec4 uScroll;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
/** Cloud vertical offset (texture units). */
uniform float uCloudY;
uniform vec3 uHillFar;
uniform vec3 uHillNear;
out vec4 outColor;
const vec4 OCT = vec4(0.5, 0.25, 0.125, 0.0625);
const float MEAN = 0.46875;

float coverage(float d) {
  float g = length(vec2(dFdx(d), dFdy(d)));
  return clamp(d / max(g, 0.001) + 0.5, 0.0, 1.0);
}

void main() {
  vec2 p = gl_FragCoord.xy * uPxToRef;
  p.y -= uScroll.w;
  float t = clamp((p.y - ${F(HORIZON_Y)}) * ${F(1 / (REF_HEIGHT - HORIZON_Y))}, 0.0, 1.0);
  t = t * (2.0 - t);
  vec3 col = mix(uHorizon, uZenith, t);
  float dist = length(p - uSun.xy);
  float d = dist * ${F(1 / REF_HEIGHT)};
  float glow = uSun.w * (0.5 * exp2(-9.0 * d) + 0.5 * exp2(-2.2 * d) * (1.0 - 0.7 * t));
  col = mix(col, uGlow, min(glow, 1.0));
  col = mix(col, uSunColor, clamp((uSun.z - dist) / uPxToRef.x + 0.5, 0.0, 1.0));

  if (p.y > ${F(HORIZON_Y + 60)}) {
    vec2 q = vec2(p.x * ${F(1 / CLOUD_W)} + uScroll.z, p.y * ${F(1 / CLOUD_H)} + uCloudY);
    float n = dot(textureLod(uNoise, q, 0.0), OCT);
    float m = dot(textureLod(uNoise, q * 3.0 + vec2(0.37, 0.61), 0.0), OCT);
    float v = n + 0.35 * (m - MEAN);
    float dens = smoothstep(${F(CLOUD_TH)}, ${F(CLOUD_TH + CLOUD_SOFT)}, v)
      * smoothstep(${F(HORIZON_Y + 60)}, ${F(HORIZON_Y + 320)}, p.y);
    vec3 cc = mix(uCloudLit, uCloudShade, 0.2 + 0.55 * smoothstep(${F(CLOUD_TH + 0.02)}, ${F(CLOUD_TH + 0.14)}, v));
    col = mix(col, cc, 0.9 * dens);
  }

  float u = p.x * ${F(1 / HILL_PERIOD)};
  float far = ${F(HORIZON_Y)} + textureLod(uHills, vec2(u + uScroll.x, 0.5), 0.0).r - p.y;
  float near = ${F(HORIZON_Y)} + textureLod(uHills, vec2(u + uScroll.y, 0.5), 0.0).g - p.y;
  float cFar = coverage(far);
  float cNear = coverage(near);
  col = mix(col, uHillFar * (1.0 - 0.08 * (1.0 - exp2(-max(far, 0.0) * 0.04))), cFar);
  col = mix(col, uHillNear * (1.0 - 0.12 * (1.0 - exp2(-max(near, 0.0) * 0.04))), cNear);
  outColor = vec4(col, 1.0);
}
`;

/**
 * The fields at full resolution, inside a scissor over the bottom of the frame,
 * premultiplied over the sky: the far tree line and the mid hedgerow (one table
 * fetch each, at their own depth), the ground between them as a perspective
 * plane (one fetch, so hedges between fields converge on the vanishing point
 * and nearer ground scrolls faster), the farmhouses (analytic, a few in view),
 * and the embankment (one fetch). Silhouettes are edge-covered from derivatives.
 */
const NEAR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uFields;
uniform sampler2D uBank;
/** Device px per reference px. */
uniform float uScale;
/** View centre x (reference px), sway (reference px), ground scroll (world units, wrapped), embankment scroll (periods). */
uniform vec4 uView;
uniform vec3 uField0;
uniform vec3 uField1;
uniform vec3 uField2;
uniform vec3 uHedge;
uniform vec3 uHaze;
uniform vec3 uFarDark;
uniform vec3 uFarLit;
uniform vec3 uMidDark;
uniform vec3 uMidLit;
uniform vec3 uBankLit;
uniform vec3 uBankDark;
uniform vec3 uWall;
uniform vec3 uRoofTile;
uniform vec3 uRoofSlate;
uniform vec3 uWindowDark;
uniform vec3 uWindowLit;
/** Per house in view: centre x, half width, wall height, roof height (reference px). */
uniform vec4 uHouse[${MAX_HOUSES}];
/** Per house: window light, roof tone, unused, unused. */
uniform vec4 uHouseLook[${MAX_HOUSES}];
uniform int uHouseCount;
out vec4 outColor;
${DITHER_GLSL}

float coverage(float d) {
  float g = length(vec2(dFdx(d), dFdy(d)));
  return clamp(d / max(g, 0.001) + 0.5, 0.0, 1.0);
}

vec3 fieldColor(float tone) {
  return tone < 0.5 ? mix(uField0, uField1, tone * 2.0) : mix(uField1, uField2, tone * 2.0 - 1.0);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / uScale;
  p.y -= uView.y;
  float dx = p.x - uView.x;
  vec4 far = texture(uFields, vec2((dx * ${F(FAR_LINE_Z / FOCAL)} + uView.z) * ${F(1 / FIELD_PERIOD)}, 0.5));
  vec4 mid = texture(uFields, vec2((dx * ${F(MID_LINE_Z / FOCAL)} + uView.z) * ${F(1 / FIELD_PERIOD)} + ${F(MID_SHIFT)}, 0.5));
  float z = ${F(WORLD_K)} / max(${F(HORIZON_Y)} - p.y, ${F(WORLD_K / FAR_LINE_Z)});
  vec4 g = texture(uFields, vec2((dx * z * ${F(1 / FOCAL)} + uView.z) * ${F(1 / FIELD_PERIOD)} + ${F(GROUND_SHIFT)}, 0.5));
  vec2 bank = texture(uBank, vec2(p.x * ${F(1 / BANK_PERIOD)} + uView.w, 0.5)).rg;

  // Crop rows along the track: static on screen, faded out where they would be finer than a few px.
  float rows = ${F(WORLD_K * CROP_ROW)} / (z * z) * uScale;
  float row = 0.5 + 0.5 * sin(z * ${F((2 * Math.PI) / CROP_ROW)} + g.g * 20.0);
  vec3 ground = fieldColor(g.g) * (1.0 - 0.07 * smoothstep(3.0, 8.0, rows) * row);
  ground = mix(ground, uHedge, g.b);
  ground = mix(ground, uHaze, 1.0 - exp2(-z * ${F(1 / HAZE_HALF)}));

  // The far tree line, with the ground in front of it.
  float farTop = ${F(FAR_Y)} + far.r * ${F(FOCAL / FAR_LINE_Z)};
  float cFar = coverage((farTop - p.y) * uScale);
  vec3 farCol = mix(ground, mix(uFarDark, uFarLit, far.a), clamp((p.y - ${F(FAR_Y)}) * uScale + 0.5, 0.0, 1.0));
  vec3 col = farCol * cFar;
  float a = cFar;

  // Farmhouses: a wall with two windows under a hipped roof.
  for (int i = 0; i < ${MAX_HOUSES}; i++) {
    if (i >= uHouseCount) break;
    vec4 h = uHouse[i];
    vec2 q = vec2(p.x - h.x, p.y - ${F(HOUSE_Y)});
    float ax = abs(q.x);
    float top = h.z + h.w;
    if (ax > h.y * 1.3 + 2.0 || q.y < -2.0 || q.y > top + 2.0) continue;
    float eave = h.y * 1.15;
    float slope = 0.72 * eave / h.w;
    float roofHalf = eave - slope * clamp(q.y - h.z, 0.0, h.w);
    float side = q.y < h.z ? h.y - ax : (roofHalf - ax) * inversesqrt(1.0 + slope * slope);
    float c = clamp(min(min(side, top - q.y), q.y) * uScale + 0.5, 0.0, 1.0);
    vec4 look = uHouseLook[i];
    vec2 w = vec2(abs(ax - h.y * 0.5), abs(q.y - h.z * 0.55));
    vec2 wc = clamp((vec2(h.y * 0.17, h.z * 0.16) - w) * uScale + 0.5, 0.0, 1.0);
    vec3 wall = mix(uWall, mix(uWindowDark, uWindowLit, look.x), wc.x * wc.y);
    vec3 hc = q.y < h.z ? wall : mix(uRoofTile, uRoofSlate, step(0.5, look.y));
    col = mix(col, hc, c);
    a = mix(a, 1.0, c);
  }

  // The mid hedgerow, with the nearer ground in front of it.
  float midTop = ${F(MID_Y)} + mid.r * ${F(FOCAL / MID_LINE_Z)};
  float cMid = coverage((midTop - p.y) * uScale);
  vec3 midCol = mix(ground, mix(uMidDark, uMidLit, mid.a), clamp((p.y - ${F(MID_Y)}) * uScale + 0.5, 0.0, 1.0));
  col = mix(col, midCol, cMid);
  a = mix(a, 1.0, cMid);

  // The embankment: streaky grass, lit along its top.
  float below = bank.r - p.y;
  float cBank = coverage(below * uScale);
  vec3 bankCol = mix(uBankLit, uBankDark, bank.g) * (0.72 + 0.28 * exp2(-max(below, 0.0) * 0.03));
  col = mix(col, bankCol, cBank);
  a = mix(a, 1.0, cBank);
  outColor = vec4(col + dither8(frag) * a, a);
}
`;

/**
 * The full-res overlay, premultiplied over everything: the telegraph poles and
 * their three sagging wires (analytic, so the wires stay anti-aliased with no
 * joints), then the glass (a soft shade towards the frame and a faint, static
 * reflection) and the carriage frame around the window. All ALU, no fetches.
 */
const OVERLAY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uScale;
/** Pole scroll (reference px, wrapped to the spacing), sway (reference px), poles on, sunlit side (-1 or 1). */
uniform vec4 uPole;
uniform vec3 uPoleColor;
uniform vec3 uWireColor;
/** Window centre and half size, reference px. */
uniform vec4 uWin;
/** Corner radius, seal width, frame on, edge shade. */
uniform vec4 uWinStyle;
uniform vec3 uPanel;
uniform vec3 uSeal;
uniform vec3 uReflect;
out vec4 outColor;
${DITHER_GLSL}
const float WIRE_DX[3] = float[](${WIRE_DX.map(F).join(", ")});
const float WIRE_Y[3] = float[](${WIRE_Y.map(F).join(", ")});
const float WIRE_SAG4[3] = float[](${WIRE_SAG.map((s) => F(4 * s)).join(", ")});

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / uScale;
  vec3 col = vec3(0.0);
  float a = 0.0;

  if (uPole.z > 0.5) {
    vec2 s = vec2(p.x + uPole.x, p.y - uPole.y);
    float px = s.x - floor(s.x * ${F(1 / POLE_SPACING)} + 0.5) * ${F(POLE_SPACING)};
    float cPole = clamp(min(${F(POLE_HALF_W)} - abs(px), ${F(POLE_TOP)} - s.y) * uScale + 0.5, 0.0, 1.0);
    float cArm = clamp(min(${F(ARM_HALF)} - abs(px), ${F(ARM_HALF_H)} - abs(s.y - ${F(ARM_Y)})) * uScale + 0.5, 0.0, 1.0);
    float c = max(cPole, cArm);
    vec3 pc = uPoleColor * (0.85 + 0.25 * clamp(px * ${F(1 / POLE_HALF_W)}, -1.0, 1.0) * uPole.w);
    col = pc * c;
    a = c;
    if (s.y > ${F(WIRE_LOW - 4)} && s.y < ${F(WIRE_HIGH + 4)}) {
      for (int w = 0; w < 3; w++) {
        float t = fract((s.x - WIRE_DX[w]) * ${F(1 / POLE_SPACING)});
        float y = WIRE_Y[w] - WIRE_SAG4[w] * t * (1.0 - t);
        float slope = WIRE_SAG4[w] * (1.0 - 2.0 * t) * ${F(1 / POLE_SPACING)};
        float d = abs(s.y - y) * inversesqrt(1.0 + slope * slope);
        float cw = clamp((${F(WIRE_HALF_W)} - d) * uScale + 0.5, 0.0, 1.0);
        col = mix(col, uWireColor, cw);
        a = mix(a, 1.0, cw);
      }
    }
  }

  if (uWinStyle.z > 0.5) {
    float r = uWinStyle.x;
    float seal = uWinStyle.y;
    vec2 q = abs(p - uWin.xy) - (uWin.zw - r);
    // Distance outwards from the edge of the glass, reference px.
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    float shade = uWinStyle.w * exp2(min(d, 0.0) * ${F(1 / 45)});
    col *= 1.0 - shade;
    a = shade + a * (1.0 - shade);
    vec2 w = (p - uWin.xy) / uWin.zw;
    float band = w.x * 0.45 + w.y * 0.9;
    float sheen = 0.55 * (1.0 - smoothstep(0.0, 0.35, abs(band - 0.25)))
      + 0.3 * (1.0 - smoothstep(0.0, 0.08, abs(band - 0.85)));
    col += uReflect * (0.45 + sheen);

    // Rubber seal (a rounded bead), then the panel with a raised lip, a soft
    // shadow and the light from the window falling on it.
    float bead = sin(clamp(d / seal, 0.0, 1.0) * 3.14159265);
    vec3 sealCol = uSeal * (0.7 + 0.6 * bead);
    float e = d - seal;
    float lip = 1.0 - smoothstep(3.0, 9.0, e);
    float shadow = smoothstep(9.0, 16.0, e) * (1.0 - smoothstep(16.0, 90.0, e));
    float glow = exp2(-max(e, 0.0) * ${F(1 / 90)}) * (p.y < uWin.y - uWin.w ? 1.0 : 0.45);
    vec3 panel = uPanel * (1.0 + 0.12 * lip - 0.1 * shadow + 0.14 * glow) * (1.03 - 0.08 * p.y * ${F(1 / REF_HEIGHT)});
    vec3 frameCol = mix(sealCol, panel, clamp(e * uScale + 0.5, 0.0, 1.0));
    float cFrame = clamp(d * uScale + 0.5, 0.0, 1.0);
    col = mix(col, frameCol, cFrame);
    a = mix(a, 1.0, cFrame);
  }
  outColor = vec4(col + dither8(frag) * a, a);
}
`;

/**
 * Looking out of a slow train: hills, fields with hedgerows, trees and the odd
 * farmhouse, a grassy embankment and telegraph poles slide past at speeds set
 * by their depth, under a sky for the chosen time of day, framed by the
 * carriage window.
 */
export const train = defineEffect(trainMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const sky = scope.own(createLowResTarget(gl));
      const program = (fs: string) =>
        scope.add(createProgram(gl, FULLSCREEN_VERTEX, fs), (p) => gl.deleteProgram(p));
      const skyProgram = program(SKY_FRAGMENT);
      const su = createUniforms(gl, skyProgram, [
        "uHills",
        "uNoise",
        "uPxToRef",
        "uZenith",
        "uHorizon",
        "uGlow",
        "uSunColor",
        "uSun",
        "uScroll",
        "uCloudLit",
        "uCloudShade",
        "uCloudY",
        "uHillFar",
        "uHillNear",
      ]);
      const nearProgram = program(NEAR_FRAGMENT);
      const nu = createUniforms(gl, nearProgram, [
        "uFields",
        "uBank",
        "uScale",
        "uView",
        "uField0",
        "uField1",
        "uField2",
        "uHedge",
        "uHaze",
        "uFarDark",
        "uFarLit",
        "uMidDark",
        "uMidLit",
        "uBankLit",
        "uBankDark",
        "uWall",
        "uRoofTile",
        "uRoofSlate",
        "uWindowDark",
        "uWindowLit",
        "uHouse",
        "uHouseLook",
        "uHouseCount",
      ]);
      const overlayProgram = program(OVERLAY_FRAGMENT);
      const ou = createUniforms(gl, overlayProgram, [
        "uScale",
        "uPole",
        "uPoleColor",
        "uWireColor",
        "uWin",
        "uWinStyle",
        "uPanel",
        "uSeal",
        "uReflect",
      ]);

      const hills = scope.own(
        createColumnTable(gl, HILL_COLUMNS, HILL_CHANNELS, { wrap: gl.REPEAT }),
      );
      const fields = scope.own(
        createColumnTable(gl, FIELD_COLUMNS, FIELD_CHANNELS, { wrap: gl.REPEAT }),
      );
      const bank = scope.own(
        createColumnTable(gl, BANK_COLUMNS, BANK_CHANNELS, { wrap: gl.REPEAT }),
      );
      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, cloudNoiseChannels(NOISE_SEED)),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );

      gl.useProgram(skyProgram);
      su.i1("uHills", 0);
      su.i1("uNoise", 1);
      gl.useProgram(nearProgram);
      nu.i1("uFields", 0);
      nu.i1("uBank", 1);
      nu.v3("uWindowLit", WINDOW_LIT);
      gl.useProgram(null);

      const trainState = createTrain();
      const timeState = createTimeState();
      const look = { hour: 0, sunX: 0, sunY: 0 };
      const skyState = createSkyState();
      const houses = new Float64Array(MAX_HOUSES * HOUSE_FLOATS);
      const houseView = new Float32Array(MAX_HOUSES * 4);
      const houseLook = new Float32Array(MAX_HOUSES * 4);
      const rgb = (): Rgb => [0, 0, 0];
      const c1 = rgb();
      const c2 = rgb();
      const cloudLit = rgb();
      const cloudShade = rgb();
      const sunColor = rgb();
      const panelLight = rgb();
      let tableSeed = Number.NaN;
      /** Highest point of the near pass, reference px before sway. */
      let nearTop = REF_HEIGHT;

      let width = 1;
      let height = 1;
      let scale = 1;
      /** CPU-only time, unwrapped float64. */
      let time = 0;

      return {
        resize(v) {
          ({ width, height, scale } = v);
          sky.resize(width, height, Math.max(1, SKY_TEXEL_REF * scale));
          gl.useProgram(skyProgram);
          su.f2("uPxToRef", sky.fullWidth / sky.width / scale, sky.fullHeight / sky.height / scale);
          gl.useProgram(null);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Math.max(0, dt);
          time += step;
          const refWidth = width / scale;
          const cx = refWidth / 2;
          const seed = Math.floor(p.seed);
          const pos = stepTrain(trainState, step, p.speed, p.direction === "right" ? -1 : 1);
          sampleTime(stepTime(timeState, step, timeIndex(p.timeOfDay)), look);
          sampleSky(look.hour / 24, skyState);
          const { light, horizon, zenith } = skyState;
          const lamp = lampAmount(light);
          const sway = swayOffset(time, p.sway, trainState.v / V_MAX);

          gl.activeTexture(gl.TEXTURE0);
          if (seed !== tableSeed) {
            tableSeed = seed;
            fillHillTable(hills.data, seed);
            hills.upload();
            const maxField = fillFieldTable(fields.data, seed);
            fields.upload();
            const maxBank = fillBankTable(bank.data, seed);
            bank.upload();
            placeHouses(houses, seed);
            nearTop = Math.max(
              FAR_Y + (maxField * FOCAL) / FAR_LINE_Z,
              MID_Y + (maxField * FOCAL) / MID_LINE_Z,
              HOUSE_Y + (HOUSE_MAX_H * FOCAL) / HOUSE_Z,
              maxBank,
            );
          }

          // 1. Sky, clouds and hills, low resolution, upscaled with dither.
          sky.bind();
          gl.useProgram(skyProgram);
          gl.bindTexture(gl.TEXTURE_2D, hills.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          gl.activeTexture(gl.TEXTURE0);
          su.v3("uZenith", zenith);
          su.v3("uHorizon", horizon);
          su.v3("uGlow", skyState.glow);
          const sunMix = smoothstep(0.35, 0.8, look.sunY);
          for (let c = 0; c < 3; c++) {
            sunColor[c] = SUN_LOW[c] + (SUN_HIGH[c] - SUN_LOW[c]) * sunMix;
            const lit = Math.min(
              1,
              zenith[c] +
                (1 - zenith[c]) * (0.55 * (1 - lamp) + 0.08) +
                0.3 * skyState.glow[c] * skyState.glowStrength,
            );
            cloudLit[c] = lit;
            cloudShade[c] = lit + (zenith[c] - lit) * 0.45;
          }
          su.v3("uSunColor", sunColor);
          su.f4(
            "uSun",
            look.sunX * refWidth,
            look.sunY * REF_HEIGHT,
            SUN_RADIUS,
            skyState.glowStrength,
          );
          su.f4(
            "uScroll",
            scrollOffset(pos, FAR_HILL_Z, HILL_PERIOD),
            scrollOffset(pos, NEAR_HILL_Z, HILL_PERIOD),
            fract(((pos * FOCAL) / CLOUD_Z + CLOUD_WIND * time) / CLOUD_W),
            sway,
          );
          su.v3("uCloudLit", cloudLit);
          su.v3("uCloudShade", cloudShade);
          su.f1("uCloudY", fract(seed * 0.618034));
          su.v3("uHillFar", shadeLayer(c1, HILL_FAR, light, horizon, FAR_HILL_Z));
          su.v3("uHillNear", shadeLayer(c1, HILL_NEAR, light, horizon, NEAR_HILL_Z));
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          sky.blit();

          // 2. Fields, houses and the embankment over the bottom of the frame.
          gl.useProgram(nearProgram);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, bank.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, fields.texture);
          nu.f1("uScale", scale);
          nu.f4(
            "uView",
            cx,
            sway,
            fract(pos / FIELD_PERIOD) * FIELD_PERIOD,
            scrollOffset(pos, BANK_Z, BANK_PERIOD),
          );
          nu.v3("uField0", shadeLayer(c1, FIELD[0], light, horizon, 0));
          nu.v3("uField1", shadeLayer(c1, FIELD[1], light, horizon, 0));
          nu.v3("uField2", shadeLayer(c1, FIELD[2], light, horizon, 0));
          nu.v3("uHedge", shadeLayer(c1, HEDGE, light, horizon, 0));
          nu.v3("uHaze", horizon);
          nu.v3("uFarDark", shadeLayer(c1, FOLIAGE_DARK, light, horizon, FAR_LINE_Z));
          nu.v3("uFarLit", shadeLayer(c1, FOLIAGE_LIT, light, horizon, FAR_LINE_Z));
          nu.v3("uMidDark", shadeLayer(c1, FOLIAGE_DARK, light, horizon, MID_LINE_Z));
          nu.v3("uMidLit", shadeLayer(c1, FOLIAGE_LIT, light, horizon, MID_LINE_Z));
          nu.v3("uBankLit", shadeLayer(c1, BANK_LIT, light, horizon, BANK_Z));
          nu.v3("uBankDark", shadeLayer(c1, BANK_DARK, light, horizon, BANK_Z));
          nu.v3("uWall", shadeLayer(c1, WALL, light, horizon, HOUSE_Z));
          nu.v3("uRoofTile", shadeLayer(c1, ROOF_TILE, light, horizon, HOUSE_Z));
          nu.v3("uRoofSlate", shadeLayer(c1, ROOF_SLATE, light, horizon, HOUSE_Z));
          nu.v3("uWindowDark", shadeLayer(c1, WINDOW_DARK, light, horizon, HOUSE_Z));
          const houseCount = viewHouses(houses, pos, refWidth, lamp, houseView, houseLook);
          nu.i1("uHouseCount", houseCount);
          if (houseCount > 0) {
            gl.uniform4fv(nu.loc.uHouse, houseView);
            gl.uniform4fv(nu.loc.uHouseLook, houseLook);
          }
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, 0, width, Math.min(height, Math.ceil((nearTop + SWAY_AMP + 3) * scale)));
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          triangle.draw();
          gl.disable(gl.SCISSOR_TEST);

          // 3. Poles and wires, the glass and the window frame.
          const frame = p.frame === "carriage" || p.frame === "thin" ? FRAMES[p.frame] : null;
          if (p.poles || frame) {
            gl.useProgram(overlayProgram);
            ou.f1("uScale", scale);
            ou.f4("uPole", poleOffset(pos), sway, p.poles ? 1 : 0, look.sunX < 0.5 ? -1 : 1);
            ou.v3("uPoleColor", shadeLayer(c1, POLE, light, horizon, POLE_Z));
            ou.v3("uWireColor", shadeLayer(c1, WIRE, light, horizon, POLE_Z));
            if (frame) {
              const top = REF_HEIGHT - frame.top;
              ou.f4("uWin", cx, (frame.bottom + top) / 2, cx - frame.x, (top - frame.bottom) / 2);
              ou.f4("uWinStyle", frame.radius, frame.seal, 1, frame.shade);
              for (let c = 0; c < 3; c++) {
                panelLight[c] = clamp(
                  (light[c] * 0.55 + 0.1) * (1 - lamp) + LAMP[c] * 0.6 * lamp,
                  0,
                  1,
                );
                c2[c] = (0.03 * (light[0] + light[1] + light[2])) / 3;
                c2[c] += (LAMP[c] * 0.07 - c2[c]) * lamp;
              }
              ou.f3(
                "uPanel",
                PANEL[0] * panelLight[0],
                PANEL[1] * panelLight[1],
                PANEL[2] * panelLight[2],
              );
              ou.f3(
                "uSeal",
                SEAL[0] * panelLight[0],
                SEAL[1] * panelLight[1],
                SEAL[2] * panelLight[2],
              );
              ou.v3("uReflect", c2);
            } else {
              ou.f4("uWinStyle", 1, 1, 0, 0);
            }
            triangle.draw();
          }
          gl.disable(gl.BLEND);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
