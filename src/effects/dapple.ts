import { unitRgbMemo } from "./color";
import {
  coverageThreshold,
  createRegionLayout,
  FRAME_DEPTH,
  FRAME_HALF,
  FRAME_SOFT,
  gustLevel,
  LAYER_COUNT,
  LAYERS,
  layoutRegion,
  MID_WEIGHT,
  NEAR_WEIGHT,
  NOISE_PERIOD,
  NOISE_SEEDS,
  NOISE_SIZE,
  POSITION_OPTIONS,
  REGION_SOFT,
  softnessWidth,
  sunBasis,
  swayOffset,
  DRIFT_SPEED,
} from "./dapple-sim";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { createLowResTarget, QUALITY_OPTIONS, qualityDivisor } from "./lowres";
import { approach, fract } from "./math";
import { buildPeriodicNoiseTexture, createNoise } from "./noise";
import { defineEffect } from "./types";

/** Low-res divisors: the light mask is smooth by design, and the upscale blur suits it. */
const DIVISORS = { high: 2, balanced: 3, low: 4 } as const;
/** Sky light on the wall (times the shadow tint) and the sun's added light (times its colour). */
const AMBIENT = 0.68;
const SUN_GAIN = 0.5;
/** Wall brightness at the bottom of the frame, relative to the top. */
const WALL_BOTTOM = 0.82;
/** Plaster texture: tile size in reference px and modulation amplitude. */
const PLASTER_TILE = 560;
const PLASTER_AMP = 0.03;
/** Far branches: darkest shade they cast, and the half-width of their very soft edge. */
const FAR_FLOOR = 0.25;
const FAR_SOFT = 0.16;
/** Seconds the sway and gust amounts take to follow their sliders end to end. */
const EASE = 1.5;

/**
 * Light mask at reduced resolution: three fetches of the canopy noise (near and
 * mid leaves summed and thresholded into spots, far branches as a very soft
 * dimming), times the soft region mask and the window-frame cross. The region and
 * frame maths match `regionMask` / `frameMask` in dapple-sim.ts.
 */
const MASK_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uNoise;
/** Reference-unit position (1080 tall, y down) = gl_FragCoord.xy * xy + zw. */
uniform vec4 uPix;
/** Reference px to sun coordinates (column-major mat2). */
uniform vec4 uBasis;
/** Per-layer uv per sun-coordinate px. */
uniform vec3 uScale;
/** Per-layer uv offsets: near (xy), mid (zw), far. */
uniform vec4 uOff01;
uniform vec2 uOff2;
/** Spot threshold minus and plus the softness. */
uniform vec2 uSpot;
/** Top band edge y, side edge x, side (+1, -1, 0), side band width. */
uniform vec4 uRegion;
/** Window-frame cross centre and depth (0: off). */
uniform vec3 uFrame;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy * uPix.xy + uPix.zw;
  vec2 q = mat2(uBasis) * p;
  float nNear = texture(uNoise, q * uScale.x + uOff01.xy).r;
  float nMid = texture(uNoise, q * uScale.y + uOff01.zw).g;
  float nFar = texture(uNoise, q * uScale.z + uOff2).b;
  float spots = smoothstep(uSpot.x, uSpot.y,
    ${glslFloat(NEAR_WEIGHT)} * nNear + ${glslFloat(MID_WEIGHT)} * nMid);
  float far = mix(${glslFloat(FAR_FLOOR)}, 1.0,
    smoothstep(${glslFloat(0.5 - FAR_SOFT)}, ${glslFloat(0.5 + FAR_SOFT)}, nFar));
  float top = 1.0 - smoothstep(uRegion.x - ${glslFloat(REGION_SOFT)}, uRegion.x + ${glslFloat(REGION_SOFT)}, p.y);
  float d = (uRegion.y - p.x) * uRegion.z;
  float side = abs(uRegion.z)
    * (1.0 - smoothstep(uRegion.w - ${glslFloat(REGION_SOFT)}, uRegion.w + ${glslFloat(REGION_SOFT)}, d));
  float region = 1.0 - (1.0 - top) * (1.0 - side);
  vec2 f = abs(p - uFrame.xy);
  float bar = 1.0 - smoothstep(${glslFloat(FRAME_HALF - FRAME_SOFT)}, ${glslFloat(FRAME_HALF + FRAME_SOFT)}, min(f.x, f.y));
  outColor = vec4(spots * far * region * (1.0 - uFrame.z * bar), 0.0, 0.0, 1.0);
}
`;

/** Full-res wall: one upscaled mask fetch, one plaster fetch, the gradient and the colours. */
const COMPOSITE = /* glsl */ `
uniform sampler2D uNoiseTex;
/** Full-res reference-unit position, as uPix in the mask pass. */
uniform vec4 uPixFull;
/** Wall in sky light (shade), and the sun's added light on the wall. */
uniform vec3 uShade;
uniform vec3 uSun;
vec4 composite(vec2 uv) {
  float light = texture(uLowRes, uv).r;
  vec2 p = gl_FragCoord.xy * uPixFull.xy + uPixFull.zw;
  float plaster = 1.0
    + (texture(uNoiseTex, p * ${glslFloat(1 / PLASTER_TILE)}).a - 0.5) * ${glslFloat(PLASTER_AMP)};
  float g = mix(1.0, ${glslFloat(WALL_BOTTOM)}, clamp(p.y * ${glslFloat(1 / 1080)}, 0.0, 1.0));
  return vec4((uShade + uSun * light) * (g * plaster), 1.0);
}
`;

/**
 * Komorebi: sun through a tree canopy outside a window throws soft, slightly
 * elliptical dapples onto a plain wall, swaying gently in a breeze. A light mask
 * of three noise fetches at 1/4-1/16 of the pixels, composited onto the wall in
 * the upscale pass with one plaster fetch.
 */
export const dapple = defineEffect({
  id: "dapple",
  name: "Dappled sunlight",
  description:
    "Soft, swaying dapples of sunlight through leaves on a plain wall, with the odd gust of wind. Very low power.",
  params: {
    wallColor: { kind: "color", label: "Wall colour", default: "#e6ddd0" },
    lightColor: { kind: "color", label: "Sunlight colour", default: "#ffdcaa" },
    shadowTint: { kind: "color", label: "Shadow tint", default: "#b8c4d8" },
    coverage: { kind: "number", label: "Coverage", min: 0, max: 1, step: 0.01, default: 0.35 },
    softness: { kind: "number", label: "Softness", min: 0, max: 1, step: 0.01, default: 0.5 },
    sway: { kind: "number", label: "Sway", min: 0, max: 1, step: 0.01, default: 0.5 },
    gusts: { kind: "number", label: "Gusts", min: 0, max: 1, step: 0.01, default: 0.4 },
    position: {
      kind: "select",
      label: "Position",
      options: POSITION_OPTIONS,
      default: "topRight",
    },
    sunAngle: {
      kind: "number",
      label: "Sun angle (degrees)",
      min: -45,
      max: 45,
      step: 1,
      default: 20,
    },
    windowFrame: { kind: "boolean", label: "Window frame", default: false },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, MASK_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const u = createUniforms(gl, program, [
        "uNoise",
        "uPix",
        "uBasis",
        "uScale",
        "uOff01",
        "uOff2",
        "uSpot",
        "uRegion",
        "uFrame",
      ]);
      gl.useProgram(program);
      u.i1("uNoise", 0);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const cu = createUniforms(gl, target.program, ["uNoiseTex", "uPixFull", "uShade", "uSun"]);
      gl.useProgram(target.program);
      cu.i1("uNoiseTex", 1);

      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(
            NOISE_SIZE,
            NOISE_SEEDS.map((seed) => ({ period: NOISE_PERIOD, seed })),
          ),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );

      const wallRgb = unitRgbMemo();
      const lightRgb = unitRgbMemo();
      const tintRgb = unitRgbMemo();
      const noise = createNoise(35);
      const region = createRegionLayout();
      const basis = new Float32Array(4);
      const sway = new Float64Array(2);
      const off = new Float64Array(LAYER_COUNT * 2);
      /** Per-layer uv per px, and a fixed random base offset that decorrelates the layers. */
      const layerScale = LAYERS.map((l) => 1 / (l.cell * NOISE_PERIOD));
      const layerBase = [0.13, 0.57, 0.81, 0.29, 0.44, 0.06];

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      // CPU-only time, kept unwrapped in float64.
      let time = 0;
      let swayNow = Number.NaN;
      let gustsNow = Number.NaN;

      return {
        resize(v) {
          ({ width, height } = v);
          scale = v.scale > 0 ? v.scale : height / 1080;
          refWidth = width / scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          // Ease the motion sliders so a change never jerks the pattern.
          swayNow = Number.isNaN(swayNow) ? p.sway : approach(swayNow, p.sway, step / EASE);
          gustsNow = Number.isNaN(gustsNow) ? p.gusts : approach(gustsNow, p.gusts, step / EASE);
          const gust = gustLevel(noise, time, gustsNow);

          sunBasis(basis, p.sunAngle);
          const b0 = basis[0];
          const b1 = basis[1];
          const b2 = basis[2];
          const b3 = basis[3];
          for (let i = 0; i < LAYER_COUNT; i++) {
            swayOffset(sway, noise, i, time, swayNow, gust);
            // The pattern moves by +offset on the wall, so sample at p - offset.
            const ox = sway[0] + time * DRIFT_SPEED * LAYERS[i].drift;
            const oy = sway[1];
            const s = layerScale[i];
            off[i * 2] = fract(layerBase[i * 2] - s * (b0 * ox + b2 * oy));
            off[i * 2 + 1] = fract(layerBase[i * 2 + 1] - s * (b1 * ox + b3 * oy));
          }

          target.resize(width, height, qualityDivisor(p.quality, DIVISORS));
          const lw = target.width;
          const lh = target.height;
          layoutRegion(region, p.position, refWidth);
          const sw = softnessWidth(p.softness);
          const t = coverageThreshold(p.coverage, sw);

          gl.useProgram(program);
          u.f4("uPix", refWidth / lw, -1080 / lh, 0, 1080);
          u.f4("uBasis", b0, b1, b2, b3);
          u.f3("uScale", layerScale[0], layerScale[1], layerScale[2]);
          u.f4("uOff01", off[0], off[1], off[2], off[3]);
          u.f2("uOff2", off[4], off[5]);
          u.f2("uSpot", t - sw, t + sw);
          u.f4("uRegion", region.topY, region.edgeX, region.side, region.sideW);
          u.f3("uFrame", region.frameX, region.frameY, p.windowFrame ? FRAME_DEPTH : 0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          target.bind();
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);

          // Wall composite at full resolution.
          const wall = wallRgb(p.wallColor);
          const light = lightRgb(p.lightColor);
          const tint = tintRgb(p.shadowTint);
          gl.useProgram(target.program);
          const inv = 1 / scale;
          cu.f4("uPixFull", inv, -inv, 0, height * inv);
          cu.f3(
            "uShade",
            wall[0] * tint[0] * AMBIENT,
            wall[1] * tint[1] * AMBIENT,
            wall[2] * tint[2] * AMBIENT,
          );
          cu.f3(
            "uSun",
            wall[0] * light[0] * SUN_GAIN,
            wall[1] * light[1] * SUN_GAIN,
            wall[2] * light[2] * SUN_GAIN,
          );
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          target.blit();
          // Unbind the low-res texture so it is never sampled while it is a render target.
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
