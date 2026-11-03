import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { createChangeKey } from "./change-key";
import { createLowResTarget, QUALITY_OPTIONS, qualityDivisor } from "./lowres";
import { clamp, wrap } from "./math";
import { buildPeriodicNoiseTexture, createRng, HASH32_GLSL } from "./noise";
import {
  bandSpeed,
  BIRD_FLOATS,
  COLUMNS,
  createFlock,
  DRIFT_SPEED,
  fillLayout,
  fillRidgeTable,
  LAYER_FLOATS,
  layerCount,
  MAX_BIRDS,
  MAX_LAYERS,
  MIN_LAYERS,
  PALETTE_OPTIONS,
  paletteFor,
  PAN_SPEED,
  parallax,
  SPAN,
  stepFlock,
  writeBirds,
} from "./ridges-sim";
import { createSpriteBatch } from "./sprites";
import { defineEffect } from "./types";

/** Low-res divisors: everything but the nearest ridge edge is soft. */
const DIVISORS = { high: 2, balanced: 3, low: 4 } as const;
/** Fog noise texture side, and its two channels' lattice periods. */
const NOISE_SIZE = 128;
/** Fog noise texture tiles per height unit, across and up: blobs about 0.5 wide, 0.15 tall. */
const FOG_NX = 0.5;
const FOG_NY = 1.6;
/** Fog rise speed per unit of `drift`, height units per second. */
const RISE_SPEED = 0.003;
/** Fog opacity per unit of the `fog` param. */
const FOG_GAIN = 2.2;
/** Height (height units) over which a ridge's foot lightens toward the fog, and by how much. */
const FOOT_DEPTH = 0.2;
const FOOT_LIGHTEN = 0.3;
/** Pine cells per period (whole, so the trees wrap with the pan), tallest pine and share of cells with one. */
const PINE_CELLS = 160;
const PINE_MAX = 0.028;
const PINE_DENSITY = 0.5;
/** Birds are a little hazed, as if a way off. */
const BIRD_HAZE = 0.35;
const BIRD_ALPHA = 0.9;

const HALF_TEXEL = 0.5 / COLUMNS;

/**
 * Low-res pass: sky, the ridges behind the nearest, and the fog bands. y up, in
 * height units. Walks the layers front to back to find the first ridge touching
 * the pixel, then shades it through the fog bands in front of it, nearest first.
 * Its edge is anti-aliased by blending in the layer (or sky) behind it.
 */
const SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

/** Ridge heights: one row per layer, one period across, REPEAT-wrapped. */
uniform sampler2D uTable;
/** Two octaves of tiling fog noise (RG). */
uniform sampler2D uNoise;
/** Per layer: table u offset (pan), table row v, haze, unused. */
uniform vec4 uLayer[${MAX_LAYERS}];
/** Per fog band: floor height, 1 / thickness, noise u and v offsets. */
uniform vec4 uBand[${MAX_LAYERS}];
uniform int uCount;
/** Low-res px to height units, x and y. */
uniform vec2 uInvLow;
/** Below the nearest ridge by more than this (height units), the composite covers it all. */
uniform float uMargin;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uFog;
uniform vec3 uInk;
uniform vec3 uSun;
/** Disc centre (height units), radius, and opacity (0 = no disc). */
uniform vec4 uSunDisc;
uniform float uFogAmount;

out vec4 outColor;

const int MAX_LAYERS = ${MAX_LAYERS};
const float INV_SPAN = ${glslFloat(1 / SPAN)};
const float FOG_NX = ${glslFloat(FOG_NX)};
const float FOG_NY = ${glslFloat(FOG_NY)};
const float FOOT_DEPTH = ${glslFloat(FOOT_DEPTH)};
const float FOOT_LIGHTEN = ${glslFloat(FOOT_LIGHTEN)};

vec3 sky(vec2 p) {
  float t = smoothstep(0.3, 1.0, p.y);
  vec3 col = mix(uSkyHorizon, uSkyTop, t);
  float r = length(p - uSunDisc.xy);
  float disc = 1.0 - smoothstep(uSunDisc.z * 0.93, uSunDisc.z, r);
  float halo = 0.3 * exp(-r / (uSunDisc.z * 2.5));
  return mix(col, uSun, uSunDisc.w * max(disc, halo));
}

float ridge(float x, vec4 L) {
  return textureLod(uTable, vec2(x * INV_SPAN + L.x, L.y), 0.0).r;
}

/**
 * Share of the pixel (side px height units) at p covered by the ridge of layer L,
 * whose height at p.x is h: the signed distance to the edge, from the height gap
 * and the local slope, through a one-pixel ramp. Steep flanks would stair-step
 * on the height gap alone.
 */
float coverage(vec2 p, vec4 L, float h, float px) {
  float gap = h - p.y;
  // Far from the edge (beyond any slope the table holds), skip the slope fetches.
  if (abs(gap) > 12.0 * px) return gap > 0.0 ? 1.0 : 0.0;
  float s = (ridge(p.x + px, L) - ridge(p.x - px, L)) / (2.0 * px);
  return clamp(gap / (px * sqrt(1.0 + s * s)) + 0.5, 0.0, 1.0);
}

/** Layer \`hit\` (uCount for the sky) at p, seen through the fog bands in front of it. */
vec3 shade(vec2 p, int hit, float hh) {
  vec3 col;
  if (hit < uCount) {
    // Atmospheric perspective, and a lighter foot, as in an ink wash.
    col = mix(uInk, uFog, uLayer[hit].z);
    col = mix(col, uFog, FOOT_LIGHTEN * smoothstep(0.0, FOOT_DEPTH, hh - p.y));
  } else {
    col = sky(p);
  }
  // Fog bands in front of the hit, nearest first. Above its top a band adds
  // nothing and costs no fetch.
  float T = 1.0;
  for (int k = 0; k < MAX_LAYERS; k++) {
    if (k >= hit) break;
    vec4 B = uBand[k];
    float t = (p.y - B.x) * B.y;
    if (t >= 1.0) continue;
    float d = 1.0 - smoothstep(0.0, 1.0, t);
    vec2 n = textureLod(uNoise, vec2(p.x * FOG_NX + B.z, p.y * FOG_NY + B.w), 0.0).rg;
    float v = smoothstep(0.2, 0.8, dot(n, vec2(0.65, 0.35)));
    T *= exp(-uFogAmount * d * mix(0.1, 1.9, v));
    if (T < 0.01) break;
  }
  return mix(uFog, col, T);
}

void main() {
  vec2 p = gl_FragCoord.xy * uInvLow;
  float px = uInvLow.y;
  // Deep under the nearest ridge, the full-res composite paints over everything.
  float h0 = ridge(p.x, uLayer[0]);
  if (p.y < h0 - uMargin) {
    outColor = vec4(uInk, 1.0);
    return;
  }
  // The first ridge touching the pixel, its coverage, and the first ridge behind
  // it that covers the pixel's centre (or the sky), which shows through its edge.
  int hit = uCount;
  float hh = 0.0;
  float cover = 1.0;
  int back = uCount;
  float bh = 0.0;
  for (int i = 1; i < MAX_LAYERS; i++) {
    if (i >= uCount) break;
    float h = ridge(p.x, uLayer[i]);
    if (hit == uCount) {
      float c = coverage(p, uLayer[i], h, px);
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
  vec3 col = shade(p, hit, hh);
  if (cover < 1.0) col = mix(shade(p, back, bh), col, cover);
  outColor = vec4(col, 1.0);
}
`;

/**
 * Full-res blit: upscales the low-res scene and draws the nearest ridge (and its
 * pines) over it with a sharp, anti-aliased edge from the same table.
 */
const COMPOSITE = /* glsl */ `
${HASH32_GLSL}
uniform sampler2D uTable;
/** Nearest layer: table u offset, table row v, 1 / canvas height, canvas height (px). */
uniform vec4 uNear;
uniform vec3 uInk;
uniform vec3 uFog;
/** Share of pine cells with a tree (0 = none), and the seed. */
uniform vec2 uPine;

const float INV_SPAN = ${glslFloat(1 / SPAN)};
const float SPAN = ${glslFloat(SPAN)};
const float HALF_TEXEL = ${glslFloat(HALF_TEXEL)};
const float PINE_CELLS = ${glslFloat(PINE_CELLS)};
const float CELL = ${glslFloat(SPAN / PINE_CELLS)};
const float PINE_MAX = ${glslFloat(PINE_MAX)};
const float FOOT_DEPTH = ${glslFloat(FOOT_DEPTH)};
const float FOOT_LIGHTEN = ${glslFloat(FOOT_LIGHTEN)};

vec4 composite(vec2 uv) {
  vec3 c = texture(uLowRes, uv).rgb;
  vec2 p = gl_FragCoord.xy * uNear.z;
  float u = p.x * INV_SPAN + uNear.x;
  float h = textureLod(uTable, vec2(u, uNear.y), 0.0).r;
  float cover = clamp((h - p.y) * uNear.w + 0.5, 0.0, 1.0);
  float tree = 0.0;
  if (uPine.x > 0.0 && cover < 1.0 && p.y < h + PINE_MAX) {
    // x in table space (height units); cells repeat every period, like the table.
    float xt = (u - HALF_TEXEL) * SPAN;
    float cell = floor(xt / CELL);
    uint id = uint(mod(cell, PINE_CELLS));
    uint hsh = hash32(id * 2654435761u + uint(uPine.y));
    if (float(hsh & 0xffffu) * (1.0 / 65535.0) < uPine.x) {
      float r1 = float((hsh >> 16) & 0xffu) * (1.0 / 255.0);
      float r2 = float(hsh >> 24) * (1.0 / 255.0);
      float cx = (cell + 0.35 + 0.3 * r1) * CELL;
      float th = mix(0.45, 1.0, r2) * PINE_MAX;
      // Sunk a little, so the trunk meets the slope on both sides.
      float base = textureLod(uTable, vec2(cx * INV_SPAN + HALF_TEXEL, uNear.y), 0.0).r - 0.004;
      float yr = max((p.y - base) / th, 0.0);
      // A cone with three tiers of branches.
      float w = th * 0.28 * (1.0 - yr) * (0.72 + 0.28 * fract(yr * 3.0));
      tree = clamp((w - abs(xt - cx)) * uNear.w + 0.5, 0.0, 1.0);
    }
  }
  vec3 ink = mix(uInk, uFog, FOOT_LIGHTEN * smoothstep(0.0, FOOT_DEPTH, h - p.y));
  return vec4(mix(c, ink, max(cover, tree)), 1.0);
}
`;

/**
 * Birds: a thin V, five points per side, its wings lifted or lowered by
 * `aBird.w` with a slight droop toward the tips.
 */
const BIRD_VERTEX = /* glsl */ `#version 300 es
/** x along the wings (-1..1), y the side of the stroke (+-1). */
layout(location = 0) in vec2 aCorner;
/** Centre (px, y up), half-span (px), wing lift. */
layout(location = 1) in vec4 aBird;
uniform vec2 uInvRes;
/** Half the stroke width, px. */
uniform float uThick;
out float vSide;
void main() {
  float ax = abs(aCorner.x);
  float y = aBird.z * (aBird.w * ax - 0.25 * ax * ax);
  vec2 px = aBird.xy + vec2(aCorner.x * aBird.z, y + aCorner.y * uThick);
  vSide = aCorner.y;
  gl_Position = vec4(px * uInvRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

const BIRD_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in float vSide;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  outColor = vec4(uColor.rgb, uColor.a * (1.0 - smoothstep(0.4, 1.0, abs(vSide))));
}
`;

/** The bird V as a triangle strip: (x, side) pairs from wingtip to wingtip. */
const BIRD_STRIP = [-1, -0.5, 0, 0.5, 1].flatMap((x) => [x, 1, x, -1]);

/**
 * Steep ridges receding into mist, in the style of an ink-wash painting. Ridge
 * heights depend only on x, so they live in a periodic column table built on the
 * CPU; the sky, the far ridges and the drifting fog bands render at reduced
 * resolution, and the blit draws the nearest ridge and its pines sharp at full
 * resolution. A few birds glide across now and then.
 */
export const ridges = defineEffect({
  id: "ridges",
  name: "Misty Ridges",
  description:
    "Steep mountain ridges fading into the distance like an ink-wash painting, with banks of fog drifting between them.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "ink" },
    layers: {
      kind: "number",
      label: "Layers",
      min: MIN_LAYERS,
      max: MAX_LAYERS,
      step: 1,
      default: 6,
    },
    peaks: {
      kind: "number",
      label: "Peaks (rolling to jagged)",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.7,
    },
    fog: { kind: "number", label: "Fog", min: 0, max: 1, step: 0.01, default: 0.6 },
    drift: { kind: "number", label: "Fog drift", min: 0, max: 3, step: 0.05, default: 1 },
    pan: { kind: "number", label: "Pan", min: 0, max: 3, step: 0.05, default: 0.3 },
    sun: { kind: "boolean", label: "Sun or moon", default: true },
    pines: { kind: "boolean", label: "Pines", default: true },
    birds: { kind: "boolean", label: "Birds", default: true },
    seed: { kind: "number", label: "Seed", min: 1, max: 100, step: 1, default: 1 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const scene = scope.add(createProgram(gl, FULLSCREEN_VERTEX, SCENE_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const birdProgram = scope.add(createProgram(gl, BIRD_VERTEX, BIRD_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const triangle = scope.own(createFullscreenTriangle(gl));
      const table = scope.own(
        createColumnTable(gl, COLUMNS, 1, { rows: MAX_LAYERS, wrap: gl.REPEAT }),
      );
      const noiseTexture = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, [
            { period: 4, seed: 37 },
            { period: 8, seed: 41 },
          ]),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const birds = scope.own(createSpriteBatch(gl, MAX_BIRDS, [BIRD_FLOATS], [BIRD_STRIP]));

      const u = createUniforms(gl, scene, [
        "uTable",
        "uNoise",
        "uLayer",
        "uBand",
        "uCount",
        "uInvLow",
        "uMargin",
        "uSkyTop",
        "uSkyHorizon",
        "uFog",
        "uInk",
        "uSun",
        "uSunDisc",
        "uFogAmount",
      ]);
      const cu = createUniforms(gl, target.program, ["uTable", "uNear", "uInk", "uFog", "uPine"]);
      const bu = createUniforms(gl, birdProgram, ["uInvRes", "uThick", "uColor"]);
      gl.useProgram(scene);
      u.i1("uTable", 0);
      u.i1("uNoise", 1);
      gl.useProgram(target.program);
      cu.i1("uTable", 1);
      gl.useProgram(null);

      const layers = new Float32Array(MAX_LAYERS * LAYER_FLOATS);
      const bands = new Float32Array(MAX_LAYERS * LAYER_FLOATS);
      /** Pan offset per layer (height units, wrapped to SPAN), fog noise offsets per band (wrapped to 1). */
      const offsets = new Float64Array(MAX_LAYERS);
      const bandU = new Float64Array(MAX_LAYERS);
      const bandV = new Float64Array(MAX_LAYERS);
      const tableKey = createChangeKey(3);
      const layoutKey = createChangeKey(1);
      const sizeKey = createChangeKey(3);
      const flock = createFlock();
      const rand = createRng(Math.random() * 0xffffffff);
      const birdColor = new Float32Array(3);

      let width = 1;
      let height = 1;
      let scale = 1;
      /** Set by `track` when a scene uniform uploads, meaning the cached scene is stale. */
      let changed = false;
      const track = (uploaded: boolean) => {
        if (uploaded) changed = true;
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          changed = false;
          const n = layerCount(p.layers);
          const pal = paletteFor(p.palette);
          const aspect = width / height;

          const divisor = qualityDivisor(p.quality, DIVISORS);
          sizeKey.set(0, width);
          sizeKey.set(1, height);
          sizeKey.set(2, divisor);
          if (sizeKey.take()) {
            target.resize(width, height, divisor);
            changed = true;
          }

          gl.useProgram(scene);
          gl.activeTexture(gl.TEXTURE0);
          tableKey.set(0, n);
          tableKey.set(1, p.seed);
          tableKey.set(2, p.peaks);
          if (tableKey.take()) {
            fillRidgeTable(table.data, n, p.seed, p.peaks);
            table.upload();
            changed = true;
          } else {
            gl.bindTexture(gl.TEXTURE_2D, table.texture);
          }
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
          gl.activeTexture(gl.TEXTURE0);

          layoutKey.set(0, n);
          if (layoutKey.take()) {
            fillLayout(layers, bands, n);
            changed = true;
          }
          // Pan and drift, wrapped on the CPU to the table's and the noise's period.
          const pan = Math.max(0, p.pan);
          const drift = Math.max(0, p.drift);
          const animating = pan > 0 || drift > 0;
          for (let i = 0; i < n; i++) {
            const panStep = dt * pan * PAN_SPEED * parallax(i, n);
            offsets[i] = wrap(offsets[i] + panStep, 0, SPAN);
            bandU[i] = wrap(
              bandU[i] + (panStep + dt * drift * DRIFT_SPEED * bandSpeed(i, n)) * FOG_NX,
              0,
              1,
            );
            bandV[i] = wrap(bandV[i] - dt * drift * RISE_SPEED * FOG_NY, 0, 1);
            const o = i * LAYER_FLOATS;
            layers[o] = offsets[i] / SPAN + HALF_TEXEL;
            bands[o + 2] = bandU[i];
            bands[o + 3] = wrap(bandV[i] + i * 0.37, 0, 1);
          }
          if (animating || changed) {
            gl.uniform4fv(u.loc.uLayer, layers);
            gl.uniform4fv(u.loc.uBand, bands);
          }
          track(u.i1("uCount", n));
          track(u.f2("uInvLow", aspect / target.width, 1 / target.height));
          track(u.f1("uMargin", 2.5 / target.height));
          track(u.v3("uSkyTop", pal.skyTop));
          track(u.v3("uSkyHorizon", pal.skyHorizon));
          track(u.v3("uFog", pal.fog));
          track(u.v3("uInk", pal.ink));
          track(u.v3("uSun", pal.sun));
          track(u.f4("uSunDisc", aspect * 0.8, 0.74, pal.sunRadius, p.sun ? pal.sunStrength : 0));
          track(u.f1("uFogAmount", clamp(p.fog, 0, 1) * FOG_GAIN));

          // With nothing moving, the cached scene stands.
          if (animating || changed) {
            target.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }

          gl.useProgram(target.program);
          cu.f4("uNear", layers[0], layers[1], 1 / height, height);
          cu.v3("uInk", pal.ink);
          cu.v3("uFog", pal.fog);
          cu.f2("uPine", p.pines ? PINE_DENSITY : 0, Math.floor(clamp(p.seed, 0, 1e6)));
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, table.texture);
          target.blit();

          if (!p.birds) {
            flock.count = 0;
            flock.wait = 6;
            return;
          }
          stepFlock(flock, dt, aspect, rand);
          const count = writeBirds(flock, birds.data, height, scale);
          if (count === 0) return;
          birds.upload(count);
          gl.useProgram(birdProgram);
          bu.f2("uInvRes", 1 / width, 1 / height);
          bu.f1("uThick", 0.9 * scale + 0.35);
          for (let c = 0; c < 3; c++) {
            birdColor[c] = pal.ink[c] + (pal.fog[c] - pal.ink[c]) * BIRD_HAZE;
          }
          bu.f4("uColor", birdColor[0], birdColor[1], birdColor[2], BIRD_ALPHA);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          birds.draw(0, count);
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
