import { unitRgbMemo } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { lowResSize, qualityDivisor } from "./lowres";
import { wrap } from "./math";
import type { StepClock } from "./reaction-sim";
import { createSmokeField } from "./smoke-field";
import {
  draftAt,
  type Flow,
  placeEmitters,
  simSteps,
  SMOKE_DIVISORS,
  sourceFor,
  turbulenceFlow,
  WAVE_COUNT,
  wavePhases,
} from "./smoke-sim";
import { smokeMeta } from "./smoke.meta";
import { defineEffect } from "./types";

/** Density fades this many times faster at the top of the canvas than at the bottom. */
const HEIGHT_DECAY = 1.5;
/** Smallest splat radius, in grid cells, so a thin ribbon survives a coarse grid. */
const MIN_RADIUS_CELLS = 0.9;
/** Wisps per height unit along a wide (tea) source, and their drift (rad/s). */
const WISP_K = 110;
const WISP_SPEED = 0.6;
/** Density to opacity: alpha = 1 - exp(-OPACITY * density). */
const OPACITY = 2.6;
/** Lit-edge gain per unit of density drop towards the light. */
const LIT_GAIN = 7;
/** Offset of the lit-edge fetch towards the light, in grid cells. */
const LIT_CELLS = 1.5;
/** Light pool: height of its centre, its sideways offset from the source, and its 1/(2 sigma^2). */
const POOL_Y = 0.55;
const POOL_OFFSET = 0.22;
const POOL_FALLOFF = 2;
/** Light direction (towards the light, for the side the light is on) before normalising. */
const LIGHT_DIR_X = 0.9;
const LIGHT_DIR_Y = 0.44;

/**
 * Full-resolution composite: background with a soft pool of light, the source
 * props (incense sticks or a cup), then the smoke (density to alpha, and the
 * drop in density towards the light for the lit edge: two bilinear fetches),
 * then the embers' glow, and dither.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uField;
uniform float uAspect;
/** One device pixel in height units, for antialiased prop edges. */
uniform float uPx;
/** uv offset of the lit-edge fetch, towards the light. */
uniform vec2 uLightStep;
/** Light pool centre (height units), and +1 if the light is to the right, -1 if left. */
uniform vec3 uLight;
uniform vec3 uBg;
uniform vec3 uSmoke;
/** Incense tips: x, y (height units), 1 if drawn, ember brightness. */
uniform vec4 uTip0;
uniform vec4 uTip1;
/** Cup: x, rim height, 1 if drawn. */
uniform vec3 uCup;
in vec2 vUv;
out vec4 outColor;
${DITHER_GLSL}
const vec3 WARM = vec3(0.10, 0.075, 0.05);
const vec3 DENSE = vec3(0.93, 0.93, 0.94);
const vec3 STICK = vec3(0.16, 0.09, 0.06);
const vec3 CERAMIC = vec3(0.20, 0.19, 0.18);
const vec3 EMBER = vec3(1.0, 0.42, 0.12);
const float STICK_BASE = 0.06;
float coverage(float sdf) { return clamp(0.5 - sdf / uPx, 0.0, 1.0); }
float sdRoundBox(vec2 q, vec2 halfSize, float r) {
  vec2 d = abs(q) - halfSize + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
vec3 stick(vec3 col, vec2 p, vec4 tip, float pool) {
  float y = clamp(p.y, STICK_BASE, tip.y);
  float sdf = length(p - vec2(tip.x, y)) - 0.0018;
  float holder = sdRoundBox(p - vec2(tip.x, STICK_BASE), vec2(0.028, 0.01), 0.01);
  float cov = max(coverage(sdf), coverage(holder)) * tip.z;
  return mix(col, STICK * (0.35 + pool), cov);
}
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  vec2 q = p - uLight.xy;
  float pool = exp(-dot(q, q) * ${glslFloat(POOL_FALLOFF)});
  vec3 col = uBg * (0.45 + 1.4 * pool) + WARM * pool;

  col = stick(col, p, uTip0, pool);
  col = stick(col, p, uTip1, pool);
  if (uCup.z > 0.0) {
    vec2 body = vec2(uCup.x, uCup.y - 0.075);
    float side = uLight.z;
    float handle = abs(length(p - vec2(uCup.x - side * 0.06, uCup.y - 0.07)) - 0.03) - 0.007;
    float cup = sdRoundBox(p - body, vec2(0.055, 0.075), 0.014);
    float saucer = sdRoundBox(p - vec2(uCup.x, uCup.y - 0.155), vec2(0.1, 0.008), 0.008);
    float sdf = min(min(handle, cup), saucer);
    // Rim light on the side facing the light, just inside the edge.
    float rim = smoothstep(-0.012, 0.0, sdf) * clamp(side * (p.x - uCup.x) * 12.0, 0.0, 1.0);
    vec3 ceramic = CERAMIC * (0.25 + 0.8 * pool) + rim * pool * 0.25;
    col = mix(col, ceramic, coverage(sdf));
  }

  float d = texture(uField, vUv).r;
  float toLight = texture(uField, vUv + uLightStep).r;
  float alpha = (1.0 - exp(-${glslFloat(OPACITY)} * d)) * (1.0 - smoothstep(0.8, 1.0, vUv.y));
  float lit = clamp((d - toLight) * ${glslFloat(LIT_GAIN)}, 0.0, 1.0);
  vec3 smoke = mix(uSmoke, DENSE, smoothstep(0.3, 0.9, d));
  smoke *= 0.3 + 0.7 * pool + 0.8 * lit;
  col = mix(col, smoke, alpha);

  vec2 e0 = p - uTip0.xy;
  vec2 e1 = p - uTip1.xy;
  float r0 = dot(e0, e0);
  float r1 = dot(e1, e1);
  float glow = uTip0.z * uTip0.w * (exp(-r0 * 40000.0) + 0.2 * exp(-r0 * 2200.0))
    + uTip1.z * uTip1.w * (exp(-r1 * 40000.0) + 0.2 * exp(-r1 * 2200.0));
  col += EMBER * glow;

  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Thin wisps of incense smoke (or tea steam) rising against a dark, side-lit
 * background.
 *
 * Stateful: the smoke is a density field in two ping-ponged low-resolution
 * targets (1/4 to 1/16 of the pixels), R16F when half floats are renderable,
 * else R8 with stochastic rounding. Each fixed 1/60 s step (at most MAX_STEPS
 * per frame) advects it along an analytic, divergence-free velocity (buoyancy,
 * a draft that leans the column, and curl noise growing with height), fades it,
 * and splats the sources back in. A full-resolution pass composites it over the
 * background with a lit edge facing the light. Resizes and quality changes clear
 * the field rather than resampling it.
 */
export const smoke = defineEffect(smokeMeta, {
  create(gl) {
    return withScope((scope) => {
      const field = createSmokeField(gl, scope, "smoke");
      const adv = field.uniforms;
      const compositeProgram = scope.add(
        createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT),
        (p) => {
          gl.deleteProgram(p);
        },
      );
      const comp = createUniforms(gl, compositeProgram, [
        "uField",
        "uAspect",
        "uPx",
        "uLightStep",
        "uLight",
        "uBg",
        "uSmoke",
        "uTip0",
        "uTip1",
        "uCup",
      ]);
      gl.useProgram(compositeProgram);
      comp.i1("uField", 0);
      gl.useProgram(null);
      const triangle = scope.own(createFullscreenTriangle(gl));

      let width = 1;
      let height = 1;
      /** Seconds since create, unwrapped (float64); only wrapped phases reach the GPU. */
      let time = 0;
      const clock: StepClock = { acc: 0 };
      const phases = new Float32Array(WAVE_COUNT);
      const emit = new Float64Array(4);
      const flow: Flow = { rise: 0, draft: 0, curl: 0, onset0: 0, onset1: 1 };
      const background = unitRgbMemo();

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const divisor = qualityDivisor(p.quality, SMOKE_DIVISORS);
          const w = lowResSize(width, divisor);
          const h = lowResSize(height, divisor);
          if (!field.resize(w, h)) {
            const c = background(p.background);
            gl.clearColor(c[0], c[1], c[2], 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            return;
          }

          time += Number.isFinite(dt) && dt > 0 ? dt : 0;
          const aspect = width / height;
          const preset = sourceFor(p.source);
          const count = placeEmitters(preset, p.sourceX, aspect, emit);
          const second = count > 1;
          const strength = p.density;
          gl.activeTexture(gl.TEXTURE0);

          const n = simSteps(clock, dt);
          if (n > 0) {
            gl.useProgram(field.program);
            wavePhases(time, phases);
            flow.rise = preset.rise;
            flow.draft = draftAt(p.draft, time);
            turbulenceFlow(p.turbulence, emit[1], flow);
            const radius = Math.max(preset.radius, MIN_RADIUS_CELLS / h);
            adv.f4("uRegion", 0, 0, aspect, 1);
            adv.f4("uPhase", phases[0], phases[1], phases[2], phases[3]);
            adv.f3("uFlow", flow.rise, flow.draft, flow.curl);
            adv.f2("uOnset", flow.onset0, 1 / (flow.onset1 - flow.onset0));
            adv.f4("uEmit0", emit[0], emit[1], preset.halfWidth, strength);
            adv.f4("uEmit1", emit[2], emit[3], preset.halfWidth, second ? strength : 0);
            adv.f1("uInvR2", 1 / (radius * radius));
            adv.f3("uWisp", WISP_K, wrap(time * WISP_SPEED, 0, Math.PI * 2), preset.wisp);
            adv.f2("uDecay", 1 / preset.life, HEIGHT_DECAY);
            field.advance(n);
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(compositeProgram);
          gl.bindTexture(gl.TEXTURE_2D, field.texture);
          // The light is on the outer side of the source, away from the speaker.
          const side = p.sourceX < 0.5 ? -1 : 1;
          const dirLen = Math.hypot(LIGHT_DIR_X, LIGHT_DIR_Y);
          comp.f1("uAspect", aspect);
          comp.f1("uPx", 1 / height);
          comp.f2(
            "uLightStep",
            ((side * LIGHT_DIR_X) / dirLen) * (LIT_CELLS / field.width),
            (LIGHT_DIR_Y / dirLen) * (LIT_CELLS / field.height),
          );
          comp.f3(
            "uLight",
            Math.min(aspect, Math.max(0, emit[0] + side * POOL_OFFSET)),
            POOL_Y,
            side,
          );
          comp.rgb("uBg", p.background);
          comp.rgb("uSmoke", p.smokeColor);
          const sticks = preset.prop === "sticks" ? 1 : 0;
          // Embers breathe slowly; float64 time is fine for CPU-side sines.
          const ember = 0.8 + 0.2 * Math.sin(time * 1.3) * Math.sin(time * 0.37 + 1);
          comp.f4("uTip0", emit[0], emit[1], sticks, ember);
          comp.f4("uTip1", emit[2], emit[3], second ? sticks : 0, ember);
          comp.f3("uCup", emit[0], emit[1], preset.prop === "cup" ? 1 : 0);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
