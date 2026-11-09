import { createChangeKey } from "../change-key";
import { createColorEase } from "../color";
import { cloudNoiseChannels, coverageOpacity } from "../clouds/clouds-sky";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
} from "../gl";
import { createLowResTarget, qualityDivisor } from "../lowres";
import { clamp, wrap } from "../math";
import { buildPeriodicNoiseTexture } from "../noise";
import { createSpriteBatch } from "../sprites";
import { defineEffect } from "../types";
import {
  advanceRotors,
  BLADE,
  cloudThreshold,
  COLUMNS,
  createFarm,
  type FarmPalette,
  fillHillTable,
  HILL_LAYERS,
  HUB_X,
  HUB_Y,
  layoutFarm,
  PACKED,
  packPalette,
  PALETTE_FADE,
  PALETTE_FLOATS,
  paletteFor,
  SPAN,
  TOWER_FOOT,
  TOWER_TOP,
  writeTurbines,
  YAW_COS,
} from "./windfarm-sim";
import { MAX_TURBINES, SIDE_OPTIONS, windfarmMeta } from "./windfarm.meta";
import { PAINT_OVER_GLSL } from "../sdf-glsl";

const f = glslFloat;

/** Low-res divisors: sky, clouds and the far hills are all soft; the near ridge is drawn sharp. */
const DIVISORS = { high: 2, balanced: 3, low: 4 } as const;
/** Cloud noise texture side: a multiple of every octave's period (4..32). */
const NOISE_SIZE = 128;
const NOISE_SEED = 84;
const HALF_TEXEL = 0.5 / COLUMNS;

/** Height (height units) where the cloud layer's perspective converges, below the far hills. */
const HORIZON = 0.3;
/** Perspective of the cloud layer: depth 1 / (y - HORIZON + PERSP), and noise tiles per unit of depth. */
const PERSP = 0.25;
const CLOUD_X = 0.3;
const CLOUD_Y = 0.35;
/** Cloud drift at `wind` 1, noise tiles per second (a tile is ~3 frame heights overhead). */
const CLOUD_SPEED = 0.0035;
/** Cloud-shadow noise tiles per height unit on each hill layer, nearest first: farther looks smaller. */
const SHADOW_ZOOM = [0.55, 0.95, 1.5, 2.2];
/** Shadows are squashed along the slope, as if seen at a glancing angle. */
const SHADOW_STRETCH = 2.5;
/** Shadow edge: density band (unit variance) over which a shadow fades in, below and above the threshold. */
const SHADOW_SOFT_LO = 0.3;
const SHADOW_SOFT_HI = 1.8;
/** Half-width of the nearest ridge's antialiased edge (full-res px). */
const NEAR_EDGE = 1.25;
/** Shadow drift at `wind` 1, noise tiles per second. */
const SHADOW_SPEED = 0.005;
/** Brightening of a ridge's sunlit crest, and how far down it reaches (height units). */
const CREST = 0.08;
const CREST_DEPTH = 0.05;
/** Haze in the valley at each layer's foot, nearest first, and over what depth. */
const FOOT_HAZE = [0, 0.3, 0.4, 0.45];
const FOOT_DEPTH = 0.18;

/** Turbine geometry beyond what the layout needs (tower heights, from the foot, y up). */
const BLADE_ROOT = 0.03;
const BLADE_TIP = 0.007;
const HUB_R = 0.024;
const NACELLE_X = 0.035;
const NACELLE_HW = 0.055;
const NACELLE_HH = 0.022;
const NACELLE_R = 0.014;
/** Padding of the instance quads around the shapes, tower heights (>= 1 px at 1080p and up). */
const PAD = 0.03;
const ROTOR_BOTTOM = HUB_Y - BLADE - PAD;
const ROTOR_HALF = BLADE * YAW_COS + PAD;

/**
 * The instance outline, in tower heights from the foot: a thin box around the
 * lower tower, then a box around the rotor, joined by a degenerate pair so one
 * strip draws both. The two share an edge, so no pixel is shaded twice.
 */
const TURBINE_STRIP = [
  [-(TOWER_FOOT + PAD), -PAD],
  [TOWER_FOOT + PAD, -PAD],
  [-(TOWER_FOOT + PAD), ROTOR_BOTTOM],
  [TOWER_FOOT + PAD, ROTOR_BOTTOM],
  [TOWER_FOOT + PAD, ROTOR_BOTTOM],
  [HUB_X - ROTOR_HALF, ROTOR_BOTTOM],
  [HUB_X - ROTOR_HALF, ROTOR_BOTTOM],
  [HUB_X + ROTOR_HALF, ROTOR_BOTTOM],
  [HUB_X - ROTOR_HALF, HUB_Y + BLADE + PAD],
  [HUB_X + ROTOR_HALF, HUB_Y + BLADE + PAD],
].flat();

const TABLE_GLSL = /* glsl */ `
const int LAYERS = ${String(HILL_LAYERS)};
const float INV_SPAN = ${f(1 / SPAN)};
const float HALF_TEXEL = ${f(HALF_TEXEL)};
const float CREST = ${f(CREST)};
const float CREST_DEPTH = ${f(CREST_DEPTH)};

/** Hill layer i's height at x (height units). */
float ridge(float x, int i) {
  return textureLod(uTable, vec2(x * INV_SPAN + HALF_TEXEL, (float(i) + 0.5) / float(LAYERS)), 0.0).r;
}

/** Sunlit crest: brightest at the ridge line, fading over CREST_DEPTH below it. */
float crest(float below) {
  return 1.0 + CREST * (1.0 - smoothstep(0.0, CREST_DEPTH, below));
}
`;

/**
 * Low-res pass: sky, clouds, and the hill layers behind the nearest, with cloud
 * shadows. y up, in height units. Walks the layers front to back to find the
 * first touching the pixel and anti-aliases its edge against what lies behind,
 * as in Misty Ridges. Alpha carries the cloud shadow on the nearest layer, which
 * the full-res composite draws.
 */
const SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uTable;
/** Four octaves of tiling noise (RGBA). */
uniform sampler2D uNoise;
/** Low-res px to height units, x and y. */
uniform vec2 uInvLow;
/** Band around the nearest ridge line (height units) where the composite needs its shadow. */
uniform float uMargin;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uGlow;
/** Sun glow centre (height units), radius, strength. */
uniform vec4 uSun;
uniform vec3 uCloudLight;
uniform vec3 uCloudShade;
/** Cloud noise offset (u, v), density threshold, opacity (0 = clear sky). */
uniform vec4 uCloud;
/** Shadow noise offset (u, v), darkness, unused. */
uniform vec4 uShadow;
/** Each layer's colour, nearest first. */
uniform vec3 uHill[${String(HILL_LAYERS)}];
uniform vec3 uHaze;

out vec4 outColor;

${TABLE_GLSL}
const vec4 OCT = vec4(0.5, 0.25, 0.125, 0.0625);
/** Mean of dot(texel, OCT) for mid-grey texels, and the gain to unit variance. */
const float MEAN = 0.46875;
const float NORM = 10.0;
/** Shadows skip the finest octave and damp the next, so their edges stay soft. */
const vec4 SHADOW_OCT = vec4(0.62, 0.3, 0.08, 0.0);
const float SHADOW_MEAN = 0.5;
const float SHADOW_NORM = 8.3;
const float SHADOW_SOFT_LO = ${f(SHADOW_SOFT_LO)};
const float SHADOW_SOFT_HI = ${f(SHADOW_SOFT_HI)};
const float HORIZON = ${f(HORIZON)};
const float PERSP = ${f(PERSP)};
const float CLOUD_X = ${f(CLOUD_X)};
const float CLOUD_Y = ${f(CLOUD_Y)};
const float SHADOW_STRETCH = ${f(SHADOW_STRETCH)};
const float FOOT_DEPTH = ${f(FOOT_DEPTH)};
const float ZOOM[LAYERS] = float[LAYERS](${SHADOW_ZOOM.map((v) => f(v)).join(", ")});
const float FOOT[LAYERS] = float[LAYERS](${FOOT_HAZE.map((v) => f(v)).join(", ")});

/** Four-octave cloud density at q, unit variance. */
float density(vec2 q) {
  return (dot(textureLod(uNoise, q, 0.0), OCT) - MEAN) * NORM;
}

/** Cloud shadow (0..1) on layer i at p, h being the layer's ridge height there. */
float shadowAt(vec2 p, int i, float h) {
  float z = ZOOM[i];
  vec2 q = vec2(p.x * z, (h - p.y) * z * SHADOW_STRETCH + float(i) * 0.29) + uShadow.xy;
  float d = (dot(textureLod(uNoise, q, 0.0), SHADOW_OCT) - SHADOW_MEAN) * SHADOW_NORM;
  return smoothstep(uCloud.z - SHADOW_SOFT_LO, uCloud.z + SHADOW_SOFT_HI, d) * uCloud.w;
}

vec3 hill(vec2 p, int i, float h) {
  float below = h - p.y;
  vec3 col = uHill[i] * crest(below);
  col = mix(col, uHaze, FOOT[i] * smoothstep(0.0, FOOT_DEPTH, below));
  return col * (1.0 - uShadow.z * shadowAt(p, i, h));
}

vec3 sky(vec2 p) {
  vec3 col = mix(uSkyHorizon, uSkyTop, smoothstep(HORIZON, 1.0, p.y));
  float r = length(p - uSun.xy);
  float glow = uSun.w * exp(-r / uSun.z);
  col = mix(col, uGlow, glow);
  if (uCloud.w <= 0.0) return col;
  // A flat cloud layer in perspective: smaller and slower toward the horizon.
  float z = 1.0 / (max(p.y - HORIZON, 0.0) + PERSP);
  vec2 q = vec2(p.x * z * CLOUD_X, z * CLOUD_Y) + uCloud.xy;
  float d = density(q) + 0.35 * density(q * 2.73 + vec2(0.37, 0.61));
  float a = smoothstep(uCloud.z, uCloud.z + 0.7, d) * uCloud.w;
  float thick = smoothstep(uCloud.z + 0.3, uCloud.z + 2.2, d);
  vec3 c = mix(uCloudLight, uCloudShade, 0.7 * thick);
  c = mix(c, uGlow, 0.5 * glow);
  // Distant clouds melt into the haze.
  c = mix(c, col, 0.5 * (1.0 - smoothstep(HORIZON, HORIZON + 0.35, p.y)));
  return mix(col, c, a);
}

/** Share of the pixel (side px height units) at p covered by layer i, whose height there is h. */
float coverage(vec2 p, int i, float h, float px) {
  float gap = h - p.y;
  if (abs(gap) > 12.0 * px) return gap > 0.0 ? 1.0 : 0.0;
  float s = (ridge(p.x + px, i) - ridge(p.x - px, i)) / (2.0 * px);
  return clamp(gap / (px * sqrt(1.0 + s * s)) + 0.5, 0.0, 1.0);
}

void main() {
  vec2 p = gl_FragCoord.xy * uInvLow;
  float px = uInvLow.y;
  float h0 = ridge(p.x, 0);
  float light0 = 1.0;
  if (p.y < h0 + uMargin) light0 = 1.0 - uShadow.z * shadowAt(p, 0, h0);
  // Deep under the nearest ridge, the composite paints over everything but the shadow.
  if (p.y < h0 - uMargin) {
    outColor = vec4(uHill[0], light0);
    return;
  }
  int hit = LAYERS;
  float hh = 0.0;
  float cover = 1.0;
  int back = LAYERS;
  float bh = 0.0;
  for (int i = 1; i < LAYERS; i++) {
    float h = ridge(p.x, i);
    if (hit == LAYERS) {
      float c = coverage(p, i, h, px);
      if (c <= 0.0) continue;
      hit = i;
      hh = h;
      cover = c;
      if (c >= 1.0) break;
    } else if (p.y < h) {
      back = i;
      bh = h;
      break;
    }
  }
  vec3 col = hit < LAYERS ? hill(p, hit, hh) : sky(p);
  if (cover < 1.0) col = mix(back < LAYERS ? hill(p, back, bh) : sky(p), col, cover);
  outColor = vec4(col, light0);
}
`;

/**
 * Full-res blit: upscales the scene and draws the nearest hill over it with a
 * crisp but softened edge, shaded by the cloud shadow the low-res pass left in alpha.
 */
const COMPOSITE = /* glsl */ `
uniform sampler2D uTable;
/** 1 / canvas height, canvas height (px). */
uniform vec2 uNear;
const float NEAR_EDGE = ${f(NEAR_EDGE)};
uniform vec3 uHill0;
${TABLE_GLSL}

vec4 composite(vec2 uv) {
  vec4 c = texture(uLowRes, uv);
  vec2 p = gl_FragCoord.xy * uNear.x;
  float h = ridge(p.x, 0);
  float cover = smoothstep(-NEAR_EDGE, NEAR_EDGE, (h - p.y) * uNear.y);
  if (cover <= 0.0) return vec4(c.rgb, 1.0);
  vec3 near = uHill0 * crest(h - p.y) * c.a;
  return vec4(mix(c.rgb, near, cover), 1.0);
}
`;

const TURBINE_VERTEX = /* glsl */ `#version 300 es
/** Outline corner, tower heights from the foot. */
layout(location = 0) in vec2 aCorner;
/** Foot x, foot y (px, y up), tower height (px), rotor angle (radians). */
layout(location = 1) in vec4 aTurbine;
/** Haze, hill layer, unused, unused. */
layout(location = 2) in vec4 aLook;
uniform vec2 uInvRes;
out vec2 vLocal;
flat out vec2 vDir;
flat out float vPx;
flat out float vHaze;
flat out int vLayer;
void main() {
  vLocal = aCorner;
  vDir = vec2(cos(aTurbine.w), sin(aTurbine.w));
  vPx = 1.0 / aTurbine.z;
  vHaze = aLook.x;
  vLayer = int(aLook.y + 0.5);
  vec2 px = aTurbine.xy + aCorner * aTurbine.z;
  gl_Position = vec4(px * uInvRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * One turbine, analytically at full resolution: tapered tower, nacelle, three
 * blades in the (foreshortened) rotor plane, and the spinner, composited front
 * over back with a one-pixel ramp. Hidden behind every hill from its own layer
 * forward (the per-turbine depth mask), then hazed by distance.
 */
const TURBINE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vLocal;
flat in vec2 vDir;
flat in float vPx;
flat in float vHaze;
flat in int vLayer;
uniform sampler2D uTable;
/** 1 / canvas height, canvas height (px). */
uniform vec2 uNear;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uHaze;
/** Unit light direction: across (x), and toward the viewer (y). */
uniform vec2 uLight;
out vec4 outColor;

${TABLE_GLSL}
const vec2 HUB = vec2(${f(HUB_X)}, ${f(HUB_Y)});
const float HUB_Y = ${f(HUB_Y)};
const float BLADE = ${f(BLADE)};
const float INV_YAW = ${f(1 / YAW_COS)};
const float BLADE_ROOT = ${f(BLADE_ROOT)};
const float BLADE_TIP = ${f(BLADE_TIP)};
const float HUB_R = ${f(HUB_R)};
const float TOWER_FOOT = ${f(TOWER_FOOT)};
const float TOWER_TOP = ${f(TOWER_TOP)};
const vec2 NACELLE = vec2(${f(NACELLE_X)}, ${f(HUB_Y + 0.008)});
const vec2 NACELLE_HALF = vec2(${f(NACELLE_HW)}, ${f(NACELLE_HH)});
const float NACELLE_R = ${f(NACELLE_R)};
/** cos and sin of 120 degrees, between the blades. */
const float C3 = -0.5;
const float S3 = 0.8660254;

/** Coverage of a shape at signed distance d (tower heights), over one pixel. */
float cover(float d) {
  return clamp(0.5 - d / vPx, 0.0, 1.0);
}

/** Signed distance to a blade pointing along dir from the hub, in the rotor plane. */
float blade(vec2 r, vec2 dir) {
  float t = dot(r, dir);
  float s = dot(r, vec2(-dir.y, dir.x));
  float w = mix(BLADE_ROOT, BLADE_TIP, clamp(t / BLADE, 0.0, 1.0));
  // The chord bulges to the trailing side, as on a real blade.
  return max(abs(s - 0.3 * w) - w, max(0.5 * HUB_R - t, t - BLADE));
}

${PAINT_OVER_GLSL}

void main() {
  vec2 q = vLocal;
  vec4 acc = vec4(0.0);

  // Tower: a tapered cylinder, lit across its width.
  float tw = mix(TOWER_FOOT, TOWER_TOP, clamp(q.y / HUB_Y, 0.0, 1.0));
  float across = clamp(q.x / tw, -1.0, 1.0);
  float lam = across * uLight.x + sqrt(1.0 - across * across) * uLight.y;
  over(acc, mix(uShade, uLit, clamp(0.35 + 0.65 * lam, 0.0, 1.0)), cover(max(abs(q.x) - tw, q.y - HUB_Y)));

  // Nacelle: a rounded box behind the hub, its top catching the light.
  vec2 b = abs(q - NACELLE) - NACELLE_HALF + NACELLE_R;
  float dn = length(max(b, 0.0)) + min(max(b.x, b.y), 0.0) - NACELLE_R;
  float top = smoothstep(-NACELLE_HALF.y, NACELLE_HALF.y, q.y - NACELLE.y);
  over(acc, mix(uShade, uLit, 0.55 + 0.4 * top), cover(dn));

  // Blades, in rotor-plane coordinates (x un-foreshortened).
  vec2 r = (q - HUB) * vec2(INV_YAW, 1.0);
  vec2 d0 = vDir;
  vec2 d1 = vec2(d0.x * C3 - d0.y * S3, d0.x * S3 + d0.y * C3);
  vec2 d2 = vec2(d0.x * C3 + d0.y * S3, -d0.x * S3 + d0.y * C3);
  over(acc, mix(uShade, uLit, 0.8 + 0.2 * dot(d0, uLight)), cover(blade(r, d0)));
  over(acc, mix(uShade, uLit, 0.8 + 0.2 * dot(d1, uLight)), cover(blade(r, d1)));
  over(acc, mix(uShade, uLit, 0.8 + 0.2 * dot(d2, uLight)), cover(blade(r, d2)));

  // Spinner.
  over(acc, mix(uShade, uLit, 0.85), cover(length(q - HUB) - HUB_R));

  if (acc.a <= 0.0) {
    outColor = vec4(0.0);
    return;
  }

  // Depth mask: behind every hill from its own layer forward.
  vec2 p = gl_FragCoord.xy * uNear.x;
  float vis = 1.0;
  for (int j = 0; j < LAYERS; j++) {
    if (j > vLayer) break;
    vis *= clamp((p.y - ridge(p.x, j)) * uNear.y + 0.5, 0.0, 1.0);
  }
  vec3 col = mix(acc.rgb / acc.a, uHaze, vHaze);
  outColor = vec4(col, acc.a * vis);
}
`;

/** Index of a side select value; unknown values fall back to "spread" (0). A loop, so nothing is allocated. */
function sideIndex(id: string): number {
  for (let i = 0; i < SIDE_OPTIONS.length; i++) {
    if (SIDE_OPTIONS[i].value === id) {
      return i;
    }
  }
  return 0;
}

/**
 * White wind turbines on rolling hills under a drifting sky. The hill profiles
 * live in a periodic column table (as in Misty Ridges); sky, clouds, the far hills
 * and their cloud shadows render at reduced resolution, the blit draws the
 * nearest hill sharp, and the turbines are drawn analytically at full resolution,
 * one instance each over a tight outline, behind the hills in front of them.
 */
export const windfarm = defineEffect(windfarmMeta, {
  create(gl) {
    return withScope((scope) => {
      const scene = scopedProgram(gl, scope, FULLSCREEN_VERTEX, SCENE_FRAGMENT);
      const turbineProgram = scopedProgram(gl, scope, TURBINE_VERTEX, TURBINE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const table = scope.own(
        createColumnTable(gl, COLUMNS, 1, { rows: HILL_LAYERS, wrap: gl.REPEAT }),
      );
      const noiseTexture = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, cloudNoiseChannels(NOISE_SEED)),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const turbines = scope.own(createSpriteBatch(gl, MAX_TURBINES, [4, 4], [TURBINE_STRIP]));

      const u = createUniforms(gl, scene, [
        "uTable",
        "uNoise",
        "uInvLow",
        "uMargin",
        "uSkyTop",
        "uSkyHorizon",
        "uGlow",
        "uSun",
        "uCloudLight",
        "uCloudShade",
        "uCloud",
        "uShadow",
        "uHill",
        "uHaze",
      ]);
      const cu = createUniforms(gl, target.program, ["uTable", "uNear", "uHill0"]);
      const tu = createUniforms(gl, turbineProgram, [
        "uTable",
        "uInvRes",
        "uNear",
        "uLit",
        "uShade",
        "uHaze",
        "uLight",
      ]);
      // The table stays on unit 1 and the noise on unit 2; the blit owns unit 0.
      gl.useProgram(scene);
      u.i1("uTable", 1);
      u.i1("uNoise", 2);
      gl.useProgram(target.program);
      cu.i1("uTable", 1);
      gl.useProgram(turbineProgram);
      tu.i1("uTable", 1);
      gl.useProgram(null);

      const farm = createFarm();
      const palTarget = new Float32Array(PALETTE_FLOATS);
      const palEase = createColorEase(PALETTE_FLOATS);
      const view = (at: number, n = 3) => palEase.value.subarray(at, at + n);
      const skyTop = view(PACKED.skyTop);
      const skyHorizon = view(PACKED.skyHorizon);
      const glow = view(PACKED.glow);
      const cloudLight = view(PACKED.cloudLight);
      const cloudShade = view(PACKED.cloudShade);
      const haze = view(PACKED.haze);
      const turbineLit = view(PACKED.turbineLit);
      const turbineShade = view(PACKED.turbineShade);
      const hills = view(PACKED.hills, HILL_LAYERS * 3);
      /** Whether the hill colours on the GPU are the settled ones. */
      let hillsSent = false;
      const tableKey = createChangeKey(1);
      const layoutKey = createChangeKey(4);
      const sizeKey = createChangeKey(3);
      let palette: FarmPalette | null = null;
      /** Cloud and shadow noise offsets, wrapped to the texture's period. */
      let cloudU = 0;
      let shadowU = 0;

      let width = 1;
      let height = 1;
      /** Set by `track` when a scene uniform uploads, meaning the cached scene is stale. */
      let changed = false;
      const track = (uploaded: boolean) => {
        if (uploaded) {
          changed = true;
        }
      };

      return {
        resize(v) {
          ({ width, height } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          changed = false;
          const aspect = width / height;
          const pal = paletteFor(p.timeOfDay);
          const wind = Number.isFinite(p.wind) ? Math.max(0, p.wind) : 0;
          const cover = Number.isFinite(p.clouds) ? clamp(p.clouds, 0, 1) : 0;

          const divisor = qualityDivisor(p.quality, DIVISORS);
          sizeKey.set(0, width);
          sizeKey.set(1, height);
          sizeKey.set(2, divisor);
          if (sizeKey.take()) {
            target.resize(width, height, divisor);
            changed = true;
          }

          gl.activeTexture(gl.TEXTURE1);
          tableKey.set(0, p.seed);
          if (tableKey.take()) {
            fillHillTable(table.data, p.seed);
            table.upload();
            layoutKey.invalidate();
            changed = true;
          } else {
            gl.bindTexture(gl.TEXTURE_2D, table.texture);
          }
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
          gl.activeTexture(gl.TEXTURE0);

          const side = sideIndex(p.side);
          layoutKey.set(0, p.turbines);
          layoutKey.set(1, side);
          layoutKey.set(2, p.seed);
          layoutKey.set(3, aspect);
          if (layoutKey.take()) {
            layoutFarm(farm, table.data, aspect, p.turbines, SIDE_OPTIONS[side].value, p.seed);
          }
          advanceRotors(farm, dt, wind);
          cloudU = wrap(cloudU - dt * wind * CLOUD_SPEED, 0, 1);
          shadowU = wrap(shadowU - dt * wind * SHADOW_SPEED, 0, 1);

          gl.useProgram(scene);
          if (pal !== palette) {
            palette = pal;
            packPalette(palTarget, pal);
          }
          const v = palEase.step(palTarget, dt, PALETTE_FADE);
          const k = PACKED.scalars;
          if (palEase.moving || !hillsSent) {
            hillsSent = !palEase.moving;
            gl.uniform3fv(u.loc.uHill, hills);
            changed = true;
          }
          track(u.f2("uInvLow", aspect / target.width, 1 / target.height));
          track(u.f1("uMargin", 2.5 / target.height));
          track(u.v3("uSkyTop", skyTop));
          track(u.v3("uSkyHorizon", skyHorizon));
          track(u.v3("uGlow", glow));
          track(u.f4("uSun", v[k] * aspect, v[k + 1], v[k + 2], v[k + 3]));
          track(u.v3("uCloudLight", cloudLight));
          track(u.v3("uCloudShade", cloudShade));
          track(u.f4("uCloud", cloudU, 0.21, cloudThreshold(cover), coverageOpacity(cover)));
          track(u.f4("uShadow", shadowU, 0.53, v[k + 5], 0));
          track(u.v3("uHaze", haze));

          // With no wind, nothing in the scene moves and the cached one stands.
          if (changed) {
            target.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }

          gl.useProgram(target.program);
          cu.f2("uNear", 1 / height, height);
          cu.v3("uHill0", hills);
          target.blit();

          const count = writeTurbines(farm, turbines.data, height);
          if (count === 0) {
            return;
          }
          turbines.upload(count);
          gl.useProgram(turbineProgram);
          tu.f2("uInvRes", 1 / width, 1 / height);
          tu.f2("uNear", 1 / height, height);
          tu.v3("uLit", turbineLit);
          tu.v3("uShade", turbineShade);
          tu.v3("uHaze", haze);
          const lx = v[k + 4];
          const ly = 0.6;
          const len = Math.hypot(lx, ly);
          tu.f2("uLight", lx / len, ly / len);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          turbines.draw(0, count);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
