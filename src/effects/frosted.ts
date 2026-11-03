import { hexToLinear } from "./blobs";
import { growLive, stepLife, trimLive } from "./fade";
import {
  blurWidth,
  buildGrainTexture,
  FLUTE_SQUASH,
  glassPreset,
  GRAIN_SIZE,
  shapeColor,
  writeShapeUniforms,
  type GlassPreset,
} from "./frosted-sim";
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
import { createLowResTarget, qualityDivisor } from "./lowres";
import { smoothstep } from "./math";
import { frostedMeta, MAX_SHAPES } from "./frosted.meta";
import { defineEffect } from "./types";

/** Gamma used to mix in (approximately) linear light; the shader re-encodes with 1/GAMMA. */
const GAMMA = 2.2;
/** Low-res divisors: the shapes are heavily blurred, so even "high" is 1/16 of the pixels. */
const DIVISORS = { high: 4, balanced: 6, low: 8 } as const;
/** Grain amplitudes (colour units per unit of texel deviation from mid-grey) at `frost` = 1. */
const GRAIN_FINE = 0.1;
const GRAIN_COARSE = 0.07;
/** Flute edge highlight: peak added colour, and Gaussian half-width in 1080p pixels. */
const HIGHLIGHT = 0.11;
const HIGHLIGHT_PX = 1.3;
/** Across-flute shading (one side of each flute a little lighter, the other darker). */
const FLUTE_SHADE = 0.035;
/** Smallest flute in 1080p pixels, whatever the param says. */
const MIN_FLUTE_PX = 8;
/** Sheen band: centre and width along the bottom-left to top-right diagonal (0..1). */
const SHEEN_CENTRE = 0.74;
const SHEEN_WIDTH = 0.2;
/** Seconds a glass-type change takes to cross-fade. */
const GLASS_FADE = 0.8;
/** Seconds a shape takes to fade in or out when the count changes. */
const SHAPE_FADE = 1.5;
/** Glass factors that cross-fade, in this order in the `glass*` arrays. */
const GLASS_KEYS = [
  "blur",
  "grain",
  "sheen",
  "flute",
  "milk",
] as const satisfies readonly (keyof GlassPreset)[];

const SHAPE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
/** Low-res pixel to frame-height units: (aspect / width, 1 / height). */
uniform vec2 uToUnits;
/** Centre x, y, cos, sin of the rotation. */
uniform vec4 uShapeA[${MAX_SHAPES}];
/** Capsule half-length, radius, ring half-thickness (0: solid), opacity. */
uniform vec4 uShapeB[${MAX_SHAPES}];
/** Linear-light colours. */
uniform vec3 uColors[${MAX_SHAPES}];
uniform vec3 uBase;
uniform int uCount;
/** Half-width of the edge falloff in frame-height units (> 0). */
uniform float uBlur;
out vec4 outColor;

const int MAX_SHAPES = ${MAX_SHAPES};
const float INV_GAMMA = ${glslFloat(1 / GAMMA)};

void main() {
  vec2 p = gl_FragCoord.xy * uToUnits;
  vec3 c = uBase;
  for (int i = 0; i < MAX_SHAPES; i++) {
    if (i >= uCount) break;
    vec4 a = uShapeA[i];
    vec4 b = uShapeB[i];
    vec2 q = p - a.xy;
    q = vec2(a.z * q.x + a.w * q.y, a.z * q.y - a.w * q.x);
    q.x -= clamp(q.x, -b.x, b.x);
    float d = length(q) - b.y;
    if (b.z > 0.0) d = abs(d) - b.z;
    float cover = 1.0 - smoothstep(-uBlur, uBlur, d);
    c = mix(c, uColors[i], cover * b.w);
  }
  outColor = vec4(pow(c, vec3(INV_GAMMA)), 1.0);
}
`;

/** Full-res glass: one (lens-offset) fetch of the shapes, one grain fetch, sheen, highlight. */
const COMPOSITE = /* glsl */ `
uniform sampler2D uGrainTex;
/** Device pixel to grain-texture uv. */
uniform float uGrainScale;
/** Fine and coarse grain amplitudes. */
uniform vec2 uGrain;
/** 1 / flute width in device pixels. */
uniform float uFluteInv;
/** Peak lens offset in uv.x units (0 unless reeded). */
uniform float uFluteAmp;
/** Flute width / highlight half-width. */
uniform float uEdgeScale;
uniform float uHighlight;
uniform float uShade;
/** uv to the 0..1 diagonal coordinate. */
uniform vec2 uSheenDir;
/** Sheen band centre, 1 / width, strength. */
uniform vec3 uSheen;
uniform float uMilk;
const float PI = 3.14159265;
vec4 composite(vec2 uv) {
  float u = fract(gl_FragCoord.x * uFluteInv) - 0.5;
  float s = sin(PI * u);
  vec3 c = texture(uLowRes, vec2(uv.x + uFluteAmp * s, uv.y)).rgb;
  float e = (0.5 - abs(u)) * uEdgeScale;
  vec2 g = texture(uGrainTex, gl_FragCoord.xy * uGrainScale).rg - 0.5;
  float sd = (dot(uv, uSheenDir) - uSheen.x) * uSheen.y;
  float lift = uHighlight * exp2(-e * e) + uShade * s + dot(g, uGrain) + uSheen.z * exp2(-sd * sd);
  return vec4(mix(c, vec3(1.0), uMilk) + lift, 1.0);
}
`;

/**
 * Frosted glass: a few soft coloured shapes (discs, capsules, a ring) drifting
 * behind a pane of frosted, reeded or clear-ish glass. The shapes are drawn
 * already blurred (wide smoothstep edges on their SDFs) into a 1/6-res target,
 * only when they move; the full-res pass adds the glass in one go: a static grain
 * texture, a soft diagonal sheen, and for reeded glass a per-flute lens offset of
 * the single shapes fetch plus a thin edge highlight.
 */
export const frosted = defineEffect(frostedMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, SHAPE_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const u = createUniforms(gl, program, [
        "uToUnits",
        "uShapeA",
        "uShapeB",
        "uColors",
        "uBase",
        "uCount",
        "uBlur",
      ]);
      const cu = createUniforms(gl, target.program, [
        "uGrainTex",
        "uGrainScale",
        "uGrain",
        "uFluteInv",
        "uFluteAmp",
        "uEdgeScale",
        "uHighlight",
        "uShade",
        "uSheenDir",
        "uSheen",
        "uMilk",
      ]);
      gl.useProgram(target.program);
      cu.i1("uGrainTex", 1);

      const grainTex = scope.add(
        createDataTexture(gl, {
          width: GRAIN_SIZE,
          height: GRAIN_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildGrainTexture(),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );

      const shapeA = new Float32Array(MAX_SHAPES * 4);
      const shapeB = new Float32Array(MAX_SHAPES * 4);
      const scratch = [0, 0, 0];
      const colorData = new Float32Array(MAX_SHAPES * 3);
      const custom = ["", "", ""];
      const life = new Float32Array(MAX_SHAPES);
      const weight = new Float32Array(MAX_SHAPES);
      /** Shapes drawn: the count plus any still fading out; NaN before the first frame. */
      let live = Number.NaN;
      /** Glass factors now, and where the current cross-fade started. */
      const glassNow = new Float64Array(GLASS_KEYS.length);
      const glassFrom = new Float64Array(GLASS_KEYS.length);
      let glassTo: GlassPreset = glassPreset("frosted");
      let glassMix = 1;
      let lastGlass = "";

      let width = 1;
      let height = 1;
      let aspect = 1;
      let scale = 1;
      /** Sim seconds (speed-scaled), float64; positions are computed on the CPU. */
      let time = 0;
      let renderedTime = Number.NaN;
      let lastLw = 0;
      let lastLh = 0;
      let lastAspect = 0;
      let lastPalette = "";
      let lastC1 = "";
      let lastC2 = "";
      let lastC3 = "";
      let lastBg = "";

      return {
        resize(v) {
          width = v.width;
          height = v.height;
          aspect = width / Math.max(1, height);
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step * (Number.isFinite(p.speed) ? Math.max(0, p.speed) : 0);
          let invalid = time !== renderedTime;

          // Glass type: cross-fade every factor from wherever it is now.
          if (p.glass !== lastGlass) {
            const first = lastGlass === "";
            lastGlass = p.glass;
            glassTo = glassPreset(p.glass);
            for (let k = 0; k < GLASS_KEYS.length; k++) {
              glassFrom[k] = first ? glassTo[GLASS_KEYS[k]] : glassNow[k];
            }
            glassMix = first ? 1 : 0;
          }
          glassMix = Math.min(1, glassMix + step / GLASS_FADE);
          const ease = smoothstep(0, 1, glassMix);
          for (let k = 0; k < GLASS_KEYS.length; k++) {
            glassNow[k] = glassFrom[k] + (glassTo[GLASS_KEYS[k]] - glassFrom[k]) * ease;
          }

          // Shapes pass, into the low-res target, only when something changed.
          target.resize(width, height, qualityDivisor(p.quality, DIVISORS));
          const lw = target.width;
          const lh = target.height;
          gl.useProgram(program);
          if (lw !== lastLw || lh !== lastLh || aspect !== lastAspect) {
            lastLw = lw;
            lastLh = lh;
            lastAspect = aspect;
            u.f2("uToUnits", aspect / lw, 1 / lh);
            invalid = true;
          }
          if (u.f1("uBlur", blurWidth(p.blur, glassNow[0], 2 / lh))) invalid = true;

          const want = Math.max(2, Math.min(MAX_SHAPES, Math.round(p.shapes) || 2));
          if (Number.isNaN(live)) {
            // Start with the shapes shown rather than fading them all in.
            life.fill(1);
            live = want;
          }
          const count = (live = growLive(life, live, want));
          const fadeStep = step / SHAPE_FADE;
          for (let i = 0; i < count; i++) {
            const before = life[i];
            const l = stepLife(life, i, want, fadeStep, fadeStep);
            weight[i] = smoothstep(0, 1, l);
            if (l !== before) invalid = true;
          }
          live = trimLive(life, live, want);
          if (u.i1("uCount", count)) invalid = true;

          if (
            p.palette !== lastPalette ||
            p.color1 !== lastC1 ||
            p.color2 !== lastC2 ||
            p.color3 !== lastC3
          ) {
            lastPalette = p.palette;
            custom[0] = lastC1 = p.color1;
            custom[1] = lastC2 = p.color2;
            custom[2] = lastC3 = p.color3;
            for (let i = 0; i < MAX_SHAPES; i++) {
              colorData.set(hexToLinear(shapeColor(p.palette, custom, i)), i * 3);
            }
            gl.uniform3fv(u.loc.uColors, colorData);
            invalid = true;
          }
          if (p.background !== lastBg) {
            lastBg = p.background;
            u.v3("uBase", hexToLinear(p.background));
            invalid = true;
          }

          if (invalid) {
            writeShapeUniforms(shapeA, shapeB, count, time, aspect, weight, scratch);
            gl.uniform4fv(u.loc.uShapeA, shapeA);
            gl.uniform4fv(u.loc.uShapeB, shapeB);
            target.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            renderedTime = time;
          }

          // Glass composite at full resolution.
          gl.useProgram(target.program);
          const flutePx = Math.max(MIN_FLUTE_PX, p.fluteWidth || 0) * scale;
          const flute = glassNow[3];
          const frost = Number.isFinite(p.frost) ? Math.min(1, Math.max(0, p.frost)) : 0;
          const grain = frost * glassNow[1];
          cu.f1("uFluteInv", 1 / flutePx);
          cu.f1("uFluteAmp", ((FLUTE_SQUASH / Math.PI) * flutePx * flute) / Math.max(1, width));
          cu.f1("uEdgeScale", flutePx / (HIGHLIGHT_PX * scale));
          cu.f1("uHighlight", HIGHLIGHT * flute);
          cu.f1("uShade", FLUTE_SHADE * flute);
          cu.f1("uGrainScale", 1 / (GRAIN_SIZE * scale));
          cu.f2("uGrain", GRAIN_FINE * grain, GRAIN_COARSE * grain);
          cu.f2("uSheenDir", aspect / (aspect + 1), 1 / (aspect + 1));
          cu.f3("uSheen", SHEEN_CENTRE, 1 / SHEEN_WIDTH, glassNow[2]);
          cu.f1("uMilk", glassNow[4]);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, grainTex);
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
