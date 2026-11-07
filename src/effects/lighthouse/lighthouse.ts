import { hexToUnitRgb, unitRgbMemo } from "../color";
import { createChangeKey } from "../change-key";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import {
  advancePhase,
  beamAngle,
  CAP_HEIGHT,
  CAP_WIDTH,
  CLIFF_END,
  CLIFF_START,
  createBeamProjection,
  easeTilt,
  flareTotal,
  FOG_LAYERS,
  GALLERY_HEIGHT,
  GALLERY_OVERHANG,
  HORIZON,
  LAND_BUMPS,
  LAND_END,
  LAND_TOP,
  LANTERN_HEIGHT,
  LANTERN_WIDTH,
  lanternHeight,
  projectBeam,
  ROCK_END,
  ROCK_HEIGHT,
  ROCK_START,
  TOWER_D,
  TOWER_FOOT,
  TOWER_HEIGHT,
  TOWER_TOP,
  towerBase,
  Y_WATER,
} from "./lighthouse-sim";
import { lighthouseMeta } from "./lighthouse.meta";
import { createLowResTarget, qualityDivisor } from "../lowres";
import { clamp, wrap } from "../math";
import { buildPeriodicNoiseTexture, HASH32_GLSL } from "../noise";
import { createSpriteBatch, polygonStrip } from "../sprites";
import { defineEffect } from "../types";

const f = glslFloat;
const vec3 = (hex: string) =>
  `vec3(${hexToUnitRgb(hex)
    .map((v) => f(v))
    .join(", ")})`;

/** Sky, sea and fog are soft everywhere; the headland and tower are drawn sharp in the blit. */
const DIVISORS = { high: 2, balanced: 3, low: 4 } as const;
/** Fog noise texture side, and its two channels' lattice periods. */
const NOISE_SIZE = 128;
/** Fog noise tiles per height unit, across and up: banks wider than they are tall. */
const FOG_NX = 0.9;
const FOG_NY = 2.4;
/** Fog opacity per unit of the `fog` param. */
const FOG_GAIN = 2;
/** Slow vertical churn of the fog noise, tiles per second at drift 1. */
const FOG_CHURN = 0.004;
/** Sea glint drift, noise tiles per second: along the waves, and toward the viewer. */
const SEA_DRIFT_U = 0.004;
const SEA_DRIFT_V = 0.03;
/** How much the whole fog layer brightens at full flare. */
const FLARE_GLOW = 0.35;
/** Flare sprite: radius (height units) and peak added intensity, at rest and at full flare. */
const FLARE_RADIUS = [0.035, 0.11] as const;
const FLARE_LEVEL = [0.14, 0.4] as const;
/** Lantern room brightness at rest, and the extra when a beam faces the viewer. */
const LAMP_REST = 0.8;
const LAMP_FLARE = 0.2;
/** Star grid cell and dot radius, px at 1080p; peak star brightness. */
const STAR_CELL = 15;
const STAR_RADIUS = 0.9;
const STAR_LEVEL = 0.45;

const LANTERN_Y = lanternHeight();
const Y_LANTERN0 = TOWER_HEIGHT + GALLERY_HEIGHT;
const Y_CAP0 = Y_LANTERN0 + LANTERN_HEIGHT;
const TOWER_TOTAL = Y_CAP0 + CAP_HEIGHT;
const TOWER_BOX = Math.max(TOWER_FOOT, TOWER_TOP + GALLERY_OVERHANG) + 0.01;

/**
 * Low-res pass: sky, sea with faint glints and the lantern's reflection, the
 * beams' haze, and three fog layers lit by the beams. y up, in height units.
 * Alpha keeps the fog's transmittance, for the stars and the headland in the blit.
 */
const SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

/** Two octaves of tiling noise (RG). */
uniform sampler2D uNoise;
/** Low-res px to height units, x and y. */
uniform vec2 uInvLow;
/** Lantern centre, height units. */
uniform vec2 uLantern;
/** Per beam: on-screen direction (unit, y up), cosine of the half-angle, 1 / length. */
uniform vec4 uBeam[2];
/** Per beam: brightness (0 = off), and how far the wedge has opened into a round glow. */
uniform vec2 uBeamGain[2];
/** Per fog layer: noise u and v offsets. */
uniform vec2 uFogOff[3];
uniform float uFogAmount;
/** Extra fog brightness while a beam faces the viewer. */
uniform float uGlow;
uniform vec3 uBeamColor;
uniform vec2 uSeaOff;
/** Lantern brightness, for its reflection. */
uniform float uLamp;

out vec4 outColor;

const float HORIZON = ${f(HORIZON)};
const float Y_WATER = ${f(Y_WATER)};
const vec3 SKY_TOP = ${vec3("#03050b")};
const vec3 SKY_HORIZON = ${vec3("#121c2e")};
const vec3 SEA_FAR = ${vec3("#0c1522")};
const vec3 SEA_NEAR = ${vec3("#03060a")};
const vec3 GLINT = ${vec3("#2c3a52")};
const vec3 FOG = ${vec3("#1b2433")};
const float FOG_NX = ${f(FOG_NX)};
const float FOG_NY = ${f(FOG_NY)};
const vec3 LAYER_C = vec3(${FOG_LAYERS.map((l) => f(l[0])).join(", ")});
const vec3 LAYER_INV = vec3(${FOG_LAYERS.map((l) => f(1 / l[1])).join(", ")});
const vec3 LAYER_GAIN = vec3(${FOG_LAYERS.map((l) => f(l[2])).join(", ")});
/** Beam light added in clear air, and in fog (times the fog's lumpiness). */
const float HAZE = 0.07;
/** Beam light caught by the sea glints, where a tilted beam reaches the water. */
const float SEA_LIT = 0.6;
const float FOG_LIT = 0.55;

/** Light from the beams at p: a soft wedge from the lantern per beam, fading with distance. */
float beamLight(vec2 p) {
  vec2 d = p - uLantern;
  float r = length(d);
  vec2 n = d / max(r, 1e-4);
  float sum = 0.0;
  for (int i = 0; i < 2; i++) {
    vec4 B = uBeam[i];
    vec2 G = uBeamGain[i];
    if (G.x <= 0.0) continue;
    float w = smoothstep(B.z, mix(B.z, 1.0, 0.6), dot(n, B.xy));
    w = mix(w, 1.0, G.y);
    sum += G.x * w * exp(-r * B.w);
  }
  return sum;
}

void main() {
  vec2 p = gl_FragCoord.xy * uInvLow;
  float lb = beamLight(p);
  /** The beam lights the air; over the water it shows mostly in the glints. */
  float air = 1.0;
  vec3 col;
  if (p.y >= HORIZON) {
    col = mix(SKY_HORIZON, SKY_TOP, smoothstep(HORIZON, 1.0, p.y));
  } else {
    float k = (HORIZON - p.y) * ${f(1 / HORIZON)};
    col = mix(SEA_FAR, SEA_NEAR, sqrt(k));
    // Glints in perspective: rows near the horizon are far, so their waves are small.
    float z = 1.0 / (HORIZON - p.y + 0.03);
    float n = textureLod(uNoise, vec2(p.x * z * 0.1 + uSeaOff.x, z * 0.35 + uSeaOff.y), 0.0).g;
    float glint = smoothstep(0.6, 0.85, n);
    // The lantern's reflection: a column below it, widening toward the viewer.
    float below = clamp((Y_WATER - p.y) * 40.0, 0.0, 1.0);
    float w = 0.012 + 0.2 * max(Y_WATER - p.y, 0.0);
    float dx = (p.x - uLantern.x) / w;
    float refl = below * exp(-dx * dx) * uLamp;
    col += glint * (GLINT * (1.0 - 0.6 * k) + uBeamColor * (0.3 * refl + SEA_LIT * lb)) + uBeamColor * (0.03 * refl);
    air = mix(0.3, 1.0, smoothstep(HORIZON - 0.12, HORIZON, p.y));
  }
  col += uBeamColor * (lb * HAZE * air);
  float T = 1.0;
  vec3 fogCol = FOG * (1.0 + uGlow);
  for (int k = 0; k < 3; k++) {
    float t = (p.y - LAYER_C[k]) * LAYER_INV[k];
    if (abs(t) >= 1.0) continue;
    float band = 1.0 - t * t;
    band *= band;
    vec2 n = textureLod(uNoise, vec2(p.x * FOG_NX, p.y * FOG_NY) + uFogOff[k], 0.0).rg;
    float v = smoothstep(0.25, 0.75, dot(n, vec2(0.65, 0.35)));
    float a = 1.0 - exp(-uFogAmount * LAYER_GAIN[k] * band * mix(0.15, 1.0, v));
    vec3 lit = fogCol + uBeamColor * (lb * FOG_LIT * (0.35 + v));
    col = mix(col, lit, a);
    T *= 1.0 - a;
  }
  outColor = vec4(col, T);
}
`;

/**
 * Full-res blit: upscales the scene, adds the stars where the fog thins, and
 * draws the headland and the tower over it with sharp, anti-aliased edges,
 * hazed by the fog in front of them.
 */
const COMPOSITE = /* glsl */ `
precision highp int;
uniform vec2 uMirror;
uniform float uBase;
uniform vec2 uPx;
uniform vec3 uLampColor;
uniform float uStars;
uniform float uStarCell;
uniform float uStarSharp;

const float HORIZON = ${f(HORIZON)};
const float Y_WATER = ${f(Y_WATER)};
const float LAND_TOP = ${f(LAND_TOP)};
const float LAND_END = ${f(LAND_END)};
const float LAND_MAX = ${f(LAND_TOP + ROCK_HEIGHT + 0.02)};
const vec3 INK = ${vec3("#04060a")};
const vec3 TOWER_DARK = ${vec3("#090d14")};
const vec3 TOWER_LIGHT = ${vec3("#151b26")};
const vec3 STAR_COLOR = ${vec3("#c8d2ff")};
/** How much of the fog in front shows over the land and tower. */
const float LAND_FOG = 0.7;
const float TOWER_D = ${f(TOWER_D)};
const float TOWER_BOX = ${f(TOWER_BOX)};
const float TOWER_HEIGHT = ${f(TOWER_HEIGHT)};
const float TOWER_FOOT = ${f(TOWER_FOOT)};
const float TOWER_TOP = ${f(TOWER_TOP)};
const float Y_LANTERN0 = ${f(Y_LANTERN0)};
const float Y_CAP0 = ${f(Y_CAP0)};
const float TOWER_TOTAL = ${f(TOWER_TOTAL)};
const float STRIPES = ${f(2 / TOWER_HEIGHT)};

${HASH32_GLSL}

/** Mirrors headlandHeight in lighthouse-sim.ts. */
float headland(float d) {
  float bumps = ${f(LAND_BUMPS[0])} * sin(d * ${f(LAND_BUMPS[1])} + ${f(LAND_BUMPS[2])})
    + ${f(LAND_BUMPS[3])} * sin(d * ${f(LAND_BUMPS[4])} + ${f(LAND_BUMPS[5])});
  float cliff = 1.0 - smoothstep(${f(CLIFF_START)}, ${f(CLIFF_END)}, d);
  float rocks = 1.0 - smoothstep(${f(ROCK_START)}, ${f(ROCK_END)}, d);
  return Y_WATER - 0.01 + (LAND_TOP - Y_WATER + bumps) * cliff + ${f(ROCK_HEIGHT)} * rocks;
}

/** Coverage of a box (half-width hw, from y0 to y1) at q, with a one-pixel ramp. */
float box(vec2 q, float hw, float y0, float y1) {
  float e = min(hw - abs(q.x), min(q.y - y0, y1 - q.y));
  return clamp(e * uPx.y + 0.5, 0.0, 1.0);
}

/** One dim star in some cells of a pixel grid. */
float star(vec2 frag) {
  vec2 cell = floor(frag / uStarCell);
  uint h = hash32(uint(cell.x) * 1973u + uint(cell.y) * 9277u + 26699u);
  if ((h & 0xffu) > 40u) return 0.0;
  vec2 jitter = vec2(float((h >> 8) & 0xffu), float((h >> 16) & 0xffu)) * (0.6 / 255.0);
  vec2 dd = frag - (cell + 0.2 + jitter) * uStarCell;
  float b = 0.25 + 0.75 * float(h >> 24) * (1.0 / 255.0);
  return b * b * exp(-dot(dd, dd) * uStarSharp);
}

vec4 composite(vec2 uv) {
  vec4 lo = texture(uLowRes, uv);
  vec3 c = lo.rgb;
  // Fog in front of the land and tower.
  float haze = LAND_FOG * (1.0 - lo.a);
  vec2 p = gl_FragCoord.xy * uPx.x;
  if (uStars > 0.0 && p.y > HORIZON + 0.05) {
    float fade = smoothstep(HORIZON + 0.05, HORIZON + 0.35, p.y);
    c += STAR_COLOR * (uStars * lo.a * fade * star(gl_FragCoord.xy));
  }
  // Distance from the headland's frame edge.
  float d = p.x * uMirror.x + uMirror.y;
  if (d < LAND_END && p.y < LAND_MAX && p.y > Y_WATER - 0.01) {
    float h = headland(d);
    float s = (headland(d + uPx.x) - headland(d - uPx.x)) * 0.5 * uPx.y;
    float gap = (h - p.y) / sqrt(1.0 + s * s);
    float cover = clamp(min(gap, p.y - Y_WATER) * uPx.y + 0.5, 0.0, 1.0);
    c = mix(c, mix(INK, lo.rgb, haze), cover);
  }
  vec2 q = vec2(d - TOWER_D, p.y - uBase);
  if (abs(q.x) < TOWER_BOX && q.y > -0.02 && q.y < TOWER_TOTAL + 0.01) {
    float hw = mix(TOWER_FOOT, TOWER_TOP, clamp(q.y / TOWER_HEIGHT, 0.0, 1.0));
    float body = box(q, hw, -0.02, TOWER_HEIGHT);
    float gallery = box(q, TOWER_TOP + ${f(GALLERY_OVERHANG)}, TOWER_HEIGHT, Y_LANTERN0);
    float lantern = box(q, TOWER_TOP * ${f(LANTERN_WIDTH)}, Y_LANTERN0, Y_CAP0);
    float capHw = TOWER_TOP * ${f(CAP_WIDTH)} * (1.0 - (q.y - Y_CAP0) * ${f(1 / CAP_HEIGHT)});
    float cap = box(q, capHw, Y_CAP0, TOWER_TOTAL);
    vec3 stripe = mix(TOWER_DARK, TOWER_LIGHT, step(0.5, fract(q.y * STRIPES)));
    c = mix(c, mix(stripe, lo.rgb, haze), body);
    c = mix(c, mix(TOWER_DARK, lo.rgb, haze), max(gallery, cap));
    c = mix(c, mix(uLampColor, lo.rgb, 0.3 * haze), lantern);
  }
  return vec4(c, 1.0);
}
`;

/** Flare: a soft round glow on an octagon at the lantern, added to the frame. */
const FLARE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (px, y down) and radius (px). */
layout(location = 1) in vec4 aFlare;
uniform vec2 uResolution;
out vec2 vLocal;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  gl_Position = pxToClip(aFlare.xy + aCorner * aFlare.z, uResolution);
}
`;

const FLARE_EDGE = Math.exp(-4);

const FLARE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
/** Beam colour times peak intensity. */
uniform vec3 uColor;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float g = max(exp(-4.0 * dot(vLocal, vLocal)) - ${f(FLARE_EDGE)}, 0.0) * ${f(1 / (1 - FLARE_EDGE))};
  outColor = vec4(uColor * g + dither8(gl_FragCoord.xy) * min(g * 8.0, 1.0), 0.0);
}
`;

/**
 * A lighthouse on a headland at night, its beam sweeping through drifting sea
 * fog. The beam's rotation is projected to a 2D wedge on the CPU; sky, sea and
 * fog render in one low-res pass, the headland and tower sharp in the blit, and
 * the flare as an additive sprite at the lantern.
 */
export const lighthouse = defineEffect(lighthouseMeta, {
  create(gl) {
    return withScope((scope) => {
      const scene = scope.add(createProgram(gl, FULLSCREEN_VERTEX, SCENE_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const flareProgram = scope.add(createProgram(gl, FLARE_VERTEX, FLARE_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const noiseTexture = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, [
            { period: 4, seed: 59 },
            { period: 8, seed: 61 },
          ]),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const flareBatch = scope.own(createSpriteBatch(gl, 1, [4], [polygonStrip(8, Math.PI / 8)]));

      const u = createUniforms(gl, scene, [
        "uNoise",
        "uInvLow",
        "uLantern",
        "uBeam",
        "uBeamGain",
        "uFogOff",
        "uFogAmount",
        "uGlow",
        "uBeamColor",
        "uSeaOff",
        "uLamp",
      ]);
      const cu = createUniforms(gl, target.program, [
        "uMirror",
        "uBase",
        "uPx",
        "uLampColor",
        "uStars",
        "uStarCell",
        "uStarSharp",
      ]);
      const fu = createUniforms(gl, flareProgram, ["uResolution", "uColor"]);
      gl.useProgram(scene);
      u.i1("uNoise", 0);
      gl.useProgram(null);

      const beamColor = unitRgbMemo();
      const beamData = new Float32Array(8);
      const gainData = new Float32Array(4);
      const fogOff = new Float32Array(6);
      /** Fog and sea noise offsets, wrapped to the noise's period (1). */
      const fogU = new Float64Array(FOG_LAYERS.length);
      const fogV = new Float64Array(FOG_LAYERS.length);
      let seaU = 0;
      let seaV = 0;
      /** Rotation, in turns; starts side-on. */
      let phase = 0.25;
      /** Drawn tilt, degrees below level: eases toward the param. NaN until the first frame. */
      let tilt = Number.NaN;
      const proj = createBeamProjection();
      const sizeKey = createChangeKey(3);

      let width = 1;
      let height = 1;
      let scale = 1;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          const divisor = qualityDivisor(p.quality, DIVISORS);
          sizeKey.set(0, width);
          sizeKey.set(1, height);
          sizeKey.set(2, divisor);
          if (sizeKey.take()) {
            target.resize(width, height, divisor);
          }

          phase = advancePhase(phase, dt, clamp(p.period, 1, 600));
          tilt = easeTilt(tilt, p.tilt, dt);
          const beams = p.beams === "two" ? 2 : 1;
          const left = p.side === "left";
          const lanternX = left ? TOWER_D : aspect - TOWER_D;
          for (let i = 0; i < 2; i++) {
            const o = i * 4;
            if (i < beams) {
              projectBeam(beamAngle(phase, i), proj, tilt);
              beamData[o] = proj.dirX;
              beamData[o + 1] = proj.dirY;
              beamData[o + 2] = proj.cosHalf;
              beamData[o + 3] = 1 / proj.length;
              gainData[i * 2] = proj.brightness;
              gainData[i * 2 + 1] = proj.roundness;
            } else {
              beamData.fill(0, o, o + 4);
              gainData.fill(0, i * 2, i * 2 + 2);
            }
          }
          const facing = flareTotal(phase, beams, tilt);
          const flare = facing * clamp(p.flare, 0, 1);
          const lamp = LAMP_REST + LAMP_FLARE * facing;
          const color = beamColor(p.beamColor);

          const drift = Math.max(0, p.drift);
          for (let k = 0; k < FOG_LAYERS.length; k++) {
            const speed = FOG_LAYERS[k][3];
            fogU[k] = wrap(fogU[k] + dt * drift * speed, 0, 1);
            fogV[k] = wrap(fogV[k] + dt * drift * FOG_CHURN * (k % 2 === 0 ? 1 : -1), 0, 1);
            fogOff[k * 2] = fogU[k];
            fogOff[k * 2 + 1] = wrap(fogV[k] + k * 0.37, 0, 1);
          }
          seaU = wrap(seaU + dt * SEA_DRIFT_U, 0, 1);
          seaV = wrap(seaV + dt * SEA_DRIFT_V, 0, 1);

          gl.useProgram(scene);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
          gl.uniform4fv(u.loc.uBeam, beamData);
          gl.uniform2fv(u.loc.uBeamGain, gainData);
          gl.uniform2fv(u.loc.uFogOff, fogOff);
          u.f2("uInvLow", aspect / target.width, 1 / target.height);
          u.f2("uLantern", lanternX, LANTERN_Y);
          u.f1("uFogAmount", clamp(p.fog, 0, 1) * FOG_GAIN);
          u.f1("uGlow", FLARE_GLOW * flare);
          u.v3("uBeamColor", color);
          u.f2("uSeaOff", seaU, seaV);
          u.f1("uLamp", lamp);
          target.bind();
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);

          gl.useProgram(target.program);
          cu.f2("uMirror", left ? 1 : -1, left ? 0 : aspect);
          cu.f1("uBase", towerBase());
          cu.f2("uPx", 1 / height, height);
          cu.f3("uLampColor", color[0] * lamp, color[1] * lamp, color[2] * lamp);
          cu.f1("uStars", p.stars ? STAR_LEVEL : 0);
          cu.f1("uStarCell", STAR_CELL * scale);
          const r = Math.max(STAR_RADIUS * scale, 0.6);
          cu.f1("uStarSharp", 1 / (r * r));
          target.blit();

          // The flare: always a small glow round the lantern, blooming as a beam faces the viewer.
          const radius = (FLARE_RADIUS[0] + (FLARE_RADIUS[1] - FLARE_RADIUS[0]) * flare) * height;
          const level = FLARE_LEVEL[0] + (FLARE_LEVEL[1] - FLARE_LEVEL[0]) * flare;
          const fd = flareBatch.data;
          fd[0] = lanternX * height;
          fd[1] = (1 - LANTERN_Y) * height;
          fd[2] = radius;
          fd[3] = 0;
          flareBatch.upload(1);
          gl.useProgram(flareProgram);
          fu.f2("uResolution", width, height);
          fu.f3("uColor", color[0] * level, color[1] * level, color[2] * level);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          flareBatch.draw(0, 1);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
