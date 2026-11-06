import {
  AMBIENT,
  createCandleLayout,
  createFlameMotion,
  draftAt,
  FLAME_CENTRE,
  FLAME_L,
  FLAME_W,
  flameAt,
  flameBaseY,
  layoutCandles,
  LIGHT_R,
  LIGHT_TINT,
  lightGain,
  lightY,
  SURF_GAIN,
  SURF_SQUASH,
  SURFACE_Y,
  WICK,
} from "./candle-sim";
import { type Rgb, unitRgbMemo } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { createLowResTarget } from "./lowres";
import { approach } from "./math";
import { createNoise } from "./noise";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { candlelightMeta, MAX_CANDLES } from "./candlelight.meta";
import { defineEffect } from "./types";

/** Low-res lighting pass: about 2 reference px per texel (divisor 4 at 4K). */
const LIGHT_TEXEL_REF = 2;
/** Flame reflections: drop below the candle base as a fraction of the flame's height above it. */
const REFL_SQUASH = 0.3;
/** Reflection blob half-sizes (1/e² ish), reference px. */
const REFL_SX = 9;
const REFL_SY = 20;
const REFL_COLOR = [1, 0.6, 0.26] as const;
const REFL_STRENGTH = 0.45;
/** Candle top ellipse half-height relative to the half-width (view from slightly above). */
const ELLIPSE = 0.2;
/** Melted rim wobble and raised rim edge, relative to the half-width. */
const MELT = 0.05;
const RIM_RAISE = 0.06;
/** Glow halo radius at a glow of 0 and 1, reference px. */
const GLOW_R = [60, 140] as const;
/** How fast the shared lean follows the draft curve, per second (smooths param changes). */
const LEAN_RATE = 1.5;

const vec3 = (c: readonly number[]) => `vec3(${c.map((v) => glslFloat(v)).join(", ")})`;

/**
 * Wall and table lighting at reduced resolution: the sum of up to 7 radial
 * falloffs (flattened on the table), times each flame's brightness, plus soft
 * flame reflections on the table. Mirrors `wallLightAt` / `surfaceLightAt`.
 * Per low-res pixel: 7 x (2 rcp + 1 exp2) and a few dozen ALU ops, no fetches.
 */
const LIGHT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res px -> reference px. */
uniform vec2 uPxToRef;
/** Per flame: light x, light y, candle base y (reference px), brightness (0 = unused). */
uniform vec4 uLights[${String(MAX_CANDLES)}];
uniform vec3 uWall;
uniform vec3 uSurface;
uniform float uGain;
uniform float uReflect;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy * uPxToRef;
  float wall = 0.0;
  float surf = 0.0;
  float refl = 0.0;
  for (int i = 0; i < ${String(MAX_CANDLES)}; i++) {
    vec4 l = uLights[i];
    vec2 d = (p - l.xy) * ${glslFloat(1 / LIGHT_R)};
    float q = 1.0 + dot(d, d);
    wall += l.w / (q * q);
    vec2 s = vec2(p.x - l.x, (p.y - l.z) * ${glslFloat(SURF_SQUASH)}) * ${glslFloat(1 / LIGHT_R)};
    float qs = 1.0 + dot(s, s);
    surf += l.w / (qs * qs);
    vec2 r = vec2(p.x - l.x, p.y - l.z + (l.y - l.z) * ${glslFloat(REFL_SQUASH)})
      * vec2(${glslFloat(1 / REFL_SX)}, ${glslFloat(1 / REFL_SY)});
    refl += l.w * exp2(-dot(r, r));
  }
  vec3 tint = ${vec3(LIGHT_TINT)};
  // A little contact shadow on the wall just above the table.
  float contact = 1.0 - 0.3 * exp2(-max(p.y - ${glslFloat(SURFACE_Y)}, 0.0) * ${glslFloat(1 / 14)});
  vec3 wallC = uWall * (${glslFloat(AMBIENT)} + tint * (wall * uGain)) * contact;
  // The table darkens towards the viewer.
  float depth = 0.55 + 0.45 * clamp(p.y * ${glslFloat(1 / SURFACE_Y)}, 0.0, 1.0);
  vec3 surfC = uSurface * (${glslFloat(AMBIENT)} + tint * (surf * uGain * ${glslFloat(SURF_GAIN)})) * depth
    + ${vec3(REFL_COLOR)} * (refl * uReflect);
  float onSurf = clamp(${glslFloat(SURFACE_Y)} - p.y + 0.5, 0.0, 1.0);
  outColor = vec4(mix(wallC, surfC, onSurf), 1.0);
}
`;

/** Device px (y up) to clip space. */
const TO_CLIP = /* glsl */ `
vec4 toClip(vec2 px, vec2 invRes) {
  return vec4(px * invRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Quad top above the candle's height: ellipse, rim and wick, in half-widths and px. */
const CANDLE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, base y, half-width, height (device px, y up). */
layout(location = 1) in vec4 aCandle;
/** Flame brightness, rim seed. */
layout(location = 2) in vec2 aLight;
uniform vec2 uInvRes;
uniform float uScale;
out vec2 vP;
flat out vec4 vCandle;
flat out float vSeed;
${TO_CLIP}
void main() {
  float hw = aCandle.z;
  float e = hw * ${glslFloat(ELLIPSE)};
  float top = aCandle.w + hw * ${glslFloat(ELLIPSE + 2 * MELT + RIM_RAISE)} + ${glslFloat(WICK)} * uScale + 2.0;
  vP = mix(vec2(-hw - 1.0, -e - 1.0), vec2(hw + 1.0, top), aCorner * 0.5 + 0.5);
  vCandle = vec4(hw, aCandle.w, e, aLight.x);
  vSeed = aLight.y;
  gl_Position = toClip(aCandle.xy + vP, uInvRes);
}
`;

/**
 * A pillar candle, shaded analytically: a cylinder whose wax glows from inside
 * near the top (subsurface), a bright translucent rim, a glowing molten pool in
 * the top ellipse with an uneven melted edge, and the wick. Premultiplied, over.
 */
const CANDLE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vP;
flat in vec4 vCandle;
flat in float vSeed;
uniform vec3 uWax;
uniform vec3 uWaxGlow;
uniform float uAmbient;
uniform float uScale;
out vec4 outColor;
void main() {
  float hw = vCandle.x;
  float h = vCandle.y;
  float e = vCandle.z;
  float b = vCandle.w;
  float u = clamp(vP.x / hw, -1.0, 1.0);
  float s = sqrt(1.0 - u * u);
  // Melted rim: uneven, raised towards the sides, and level with h at the wick.
  float p1 = vSeed * 6.2832;
  float p2 = vSeed * 19.0;
  float melt = hw * (${glslFloat(MELT)} * (0.6 * (sin(u * 5.0 + p1) - sin(p1)) + 0.4 * (sin(u * 11.0 + p2) - sin(p2)))
    + ${glslFloat(RIM_RAISE)} * u * u);
  float rimH = h + melt;
  float frontTop = rimH - e * s;
  float backTop = rimH + e * s;
  float cover = clamp(hw - abs(vP.x) + 0.5, 0.0, 1.0)
    * clamp(backTop - vP.y + 0.5, 0.0, 1.0)
    * clamp(vP.y + e * s + 0.5, 0.0, 1.0);
  // Body: round shading, warm subsurface glow fading down from the top, bright rim.
  float below = max(frontTop - vP.y, 0.0);
  float sss = exp2(-below / (hw * 0.8)) * (0.5 + 0.5 * s);
  float rim = exp2(-below / (hw * 0.08 + uScale));
  vec3 body = uWax * (uAmbient * (0.25 + 0.75 * s)) + uWaxGlow * (b * (0.75 * sss + 0.5 * rim));
  // Top: the molten pool, brightest at the translucent edge.
  float r = min(length(vec2(u, (vP.y - rimH) / e)), 1.0);
  vec3 pool = uWaxGlow * (b * (1.1 - 0.45 * r + 0.45 * smoothstep(0.7, 1.0, r)));
  vec3 col = mix(body, pool, clamp(vP.y - frontTop + 0.5, 0.0, 1.0));
  // Wick: dark, with a glowing tip.
  float wickTop = h + ${glslFloat(WICK)} * uScale;
  float wick = clamp(0.9 * uScale - abs(vP.x) + 0.5, 0.0, 1.0)
    * clamp(vP.y - h + 0.5, 0.0, 1.0) * clamp(wickTop - vP.y + 0.5, 0.0, 1.0);
  vec3 wickC = mix(vec3(0.03, 0.02, 0.015), vec3(1.0, 0.45, 0.1) * b,
    smoothstep(wickTop - 3.0 * uScale, wickTop, vP.y));
  col = mix(col, wickC, wick);
  float a = max(cover, wick);
  outColor = vec4(col * a, a);
}
`;

/**
 * A flame quad: x in device px from the flame base (unbent), y 0..1 up the
 * flame. The quad is sheared with the sway and widened by a quarter of it, which
 * covers the bend `sway * y^2` exactly.
 */
const FLAME_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Base x, base y, half-width, length (device px, y up). */
layout(location = 1) in vec4 aFlame;
/** Tip offset (device px), brightness. */
layout(location = 2) in vec2 aMotion;
uniform vec2 uInvRes;
out vec2 vQ;
flat out vec3 vF;
${TO_CLIP}
void main() {
  float y = mix(-0.06, 1.03, aCorner.y * 0.5 + 0.5);
  float span = aFlame.z * 1.1 + abs(aMotion.x) * 0.25 + 1.0;
  float x = aCorner.x * span + aMotion.x * y;
  vQ = vec2(x, y);
  vF = vec3(aFlame.z, aMotion.x, aMotion.y);
  gl_Position = toClip(aFlame.xy + vec2(x, y * aFlame.w), uInvRes);
}
`;

/**
 * Teardrop flame bent by the sway (x offset by sway * y^2): blue base, bright
 * yellow-white core, orange edge. Additive.
 */
const FLAME_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vQ;
flat in vec3 vF;
out vec4 outColor;
void main() {
  float y = vQ.y;
  float x = (vQ.x - vF.y * y * y) / vF.x;
  // Half-width profile: round base, pointed tip, 1 at y = 1/3.
  float w = 2.6 * sqrt(max(y, 0.0)) * max(1.0 - y, 0.0);
  float f = abs(x) / max(w, 1e-3);
  float inside = 1.0 - smoothstep(0.5, 1.0, f);
  float core = (1.0 - smoothstep(0.1, 0.6, f)) * smoothstep(0.08, 0.3, y) * (1.0 - smoothstep(0.4, 0.85, y));
  float blue = 1.0 - smoothstep(0.04, 0.3, y);
  vec3 c = vec3(1.0, 0.5, 0.12) * (0.85 * inside * (1.0 - core)) + vec3(1.0, 0.93, 0.75) * core;
  c = mix(c, vec3(0.2, 0.3, 0.95) * (0.45 * inside), blue * 0.85);
  outColor = vec4(c * vF.z, 0.0);
}
`;

/** Glow halo: an octagon (apothem 1 = radius) around the flame. */
const GLOW_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (device px, y up), strength. */
layout(location = 1) in vec4 aGlow;
uniform vec2 uInvRes;
out vec2 vLocal;
flat out float vAlpha;
${TO_CLIP}
void main() {
  vLocal = aCorner;
  vAlpha = aGlow.w;
  gl_Position = toClip(aGlow.xy + aCorner * aGlow.z, uInvRes);
}
`;

const GLOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vAlpha;
out vec4 outColor;
void main() {
  float d2 = dot(vLocal, vLocal);
  float a = max(0.0, 1.0 - d2);
  float g = a * a * (0.25 + 0.75 * exp2(-d2 * 7.0));
  outColor = vec4(vec3(1.0, 0.6, 0.25) * (g * vAlpha), 0.0);
}
`;

/**
 * A few pillar candles in a dark room, grouped toward the bottom corners: slowly
 * swaying teardrop flames, wax glowing near the top, and warm light pooling on
 * the wall and table, with soft reflections.
 */
export const candlelight = defineEffect(candlelightMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });

      const lightProgram = program(FULLSCREEN_VERTEX, LIGHT_FRAGMENT);
      const lu = createUniforms(gl, lightProgram, [
        "uPxToRef",
        "uLights",
        "uWall",
        "uSurface",
        "uGain",
        "uReflect",
      ]);
      const candleProgram = program(CANDLE_VERTEX, CANDLE_FRAGMENT);
      const cu = createUniforms(gl, candleProgram, [
        "uInvRes",
        "uScale",
        "uWax",
        "uWaxGlow",
        "uAmbient",
      ]);
      const flameProgram = program(FLAME_VERTEX, FLAME_FRAGMENT);
      const fu = createUniforms(gl, flameProgram, ["uInvRes"]);
      const glowProgram = program(GLOW_VERTEX, GLOW_FRAGMENT);
      const gu = createUniforms(gl, glowProgram, ["uInvRes"]);

      const candleBatch = scope.own(createSpriteBatch(gl, MAX_CANDLES, [4, 2]));
      const flameBatch = scope.own(createSpriteBatch(gl, MAX_CANDLES, [4, 2]));
      const glowBatch = scope.own(
        createSpriteBatch(gl, MAX_CANDLES, [4], [polygonStrip(8, Math.PI / 8)]),
      );

      const noise = createNoise(0xca4d1e);
      const layout = createCandleLayout();
      const motion = createFlameMotion();
      const lights = new Float32Array(MAX_CANDLES * 4);
      const wallRgb = unitRgbMemo();
      const waxRgb = unitRgbMemo();

      let width = 1;
      let height = 1;
      let scale = 1;
      /** CPU-only time, unwrapped (float64); nothing time-based is uploaded. */
      let time = 0;
      let lean = 0;
      let gain = 0;
      /** Inputs the layout was last built from. */
      let builtCount = -1;
      let builtLayout = "";
      let builtWidth = -1;
      let lastWall: Rgb | undefined;
      let lastWax: Rgb | undefined;

      return {
        resize(v) {
          ({ width, height, scale } = v);
          target.resize(width, height, Math.max(1, LIGHT_TEXEL_REF * scale));
          gl.useProgram(lightProgram);
          lu.f2(
            "uPxToRef",
            target.fullWidth / target.width / scale,
            target.fullHeight / target.height / scale,
          );
          gl.useProgram(candleProgram);
          cu.f2("uInvRes", 1 / width, 1 / height);
          cu.f1("uScale", scale);
          gl.useProgram(flameProgram);
          fu.f2("uInvRes", 1 / width, 1 / height);
          gl.useProgram(glowProgram);
          gu.f2("uInvRes", 1 / width, 1 / height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          const refWidth = width / scale;
          if (builtCount !== p.candles || builtLayout !== p.layout || builtWidth !== refWidth) {
            layoutCandles(layout, p.layout, p.candles, refWidth);
            gain = lightGain(layout);
            builtCount = p.candles;
            builtLayout = p.layout;
            builtWidth = refWidth;
          }
          const n = layout.count;
          // The lean follows the draft curve, rate-limited so a draft change can't jump it.
          lean = approach(lean, draftAt(noise, time, p.draft), dt * LEAN_RATE);
          const glowK = 0.35 + 0.65 * p.glow;
          const glowR = (GLOW_R[0] + (GLOW_R[1] - GLOW_R[0]) * p.glow) * scale;
          const glowA = 0.1 + 0.3 * p.glow;

          const cd = candleBatch.data;
          const fd = flameBatch.data;
          const gd = glowBatch.data;
          for (let i = 0; i < MAX_CANDLES; i++) {
            const o = i * 4;
            if (i >= n) {
              lights[o] = -1e4;
              lights[o + 1] = -1e4;
              lights[o + 2] = -1e4;
              lights[o + 3] = 0;
              continue;
            }
            flameAt(noise, i, time, p.flicker, lean, motion);
            const b = motion.bright[i];
            const x = layout.x[i];
            lights[o] = x;
            lights[o + 1] = lightY(layout, i);
            lights[o + 2] = layout.baseY[i];
            lights[o + 3] = b;

            const c = i * 6;
            cd[c] = x * scale;
            cd[c + 1] = layout.baseY[i] * scale;
            cd[c + 2] = layout.halfW[i] * scale;
            cd[c + 3] = layout.height[i] * scale;
            cd[c + 4] = b;
            cd[c + 5] = layout.seed[i];

            const len = FLAME_L * motion.stretch[i] * scale;
            const fy = flameBaseY(layout, i) * scale;
            fd[c] = x * scale;
            fd[c + 1] = fy;
            fd[c + 2] = FLAME_W * scale;
            fd[c + 3] = len;
            fd[c + 4] = Math.tan(motion.sway[i]) * len;
            fd[c + 5] = b;

            gd[o] = (x + Math.sin(motion.sway[i]) * FLAME_L * FLAME_CENTRE) * scale;
            gd[o + 1] = fy + len * FLAME_CENTRE;
            gd[o + 2] = glowR;
            gd[o + 3] = glowA * b;
          }

          // 1. Wall, table and reflections at low resolution, then upscaled.
          target.bind();
          gl.useProgram(lightProgram);
          const wall = wallRgb(p.wallColor);
          if (wall !== lastWall) {
            lastWall = wall;
            lu.v3("uWall", wall);
            lu.f3("uSurface", wall[0] * 0.85, wall[1] * 0.72, wall[2] * 0.6);
          }
          lu.f1("uGain", gain * glowK);
          lu.f1("uReflect", p.reflection ? REFL_STRENGTH : 0);
          gl.uniform4fv(lu.loc.uLights, lights);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();

          // 2. Candles, premultiplied over.
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(candleProgram);
          const wax = waxRgb(p.waxColor);
          if (wax !== lastWax) {
            lastWax = wax;
            cu.v3("uWax", wax);
            cu.f3("uWaxGlow", wax[0] * 1.1, wax[1] * 0.8, wax[2] * 0.5);
          }
          cu.f1("uAmbient", 0.28 + 0.3 * glowK);
          candleBatch.upload(n);
          candleBatch.draw(0, n);

          // 3. Glow halos, then flames, additive.
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.useProgram(glowProgram);
          glowBatch.upload(n);
          glowBatch.draw(0, n);
          gl.useProgram(flameProgram);
          flameBatch.upload(n);
          flameBatch.draw(0, n);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
