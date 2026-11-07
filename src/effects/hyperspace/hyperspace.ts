import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  withScope,
} from "../gl";
import { createStreakRenderer, STREAK_FLOATS } from "../streaks";
import { hyperspaceMeta, MAX_STREAKS } from "./hyperspace.meta";
import { defineEffect } from "../types";
import { FADE_OUT, growLive, stepLife, trimLive } from "../fade";
import { smoothstep } from "../math";
import { unitRgbMemo } from "../color";
import { createJump } from "./hyperspace-sim";

/** Seconds a streak added by a higher count takes to fade in. */
const FADE_IN = 0.8;
/**
 * Fill budget: the streaks' quads may cover at most this many screens in total
 * at full jump, so wide streaks draw fewer of them rather than missing 4K/120.
 */
const FILL_SCREENS = 3;
/** Typical streak distance (0 = centre, 1 = corner) for the area estimate. */
const MEAN_DIST = 0.5;

/**
 * How many of `count` streaks to draw so their expected total area at full jump
 * (the worst case, so the count doesn't change mid-jump) stays within
 * `FILL_SCREENS` screens. `width` is the streak width param (1080p px) and
 * `refWidth` the screen width in 1080p reference px. Matches `frame`: length
 * `stretch * d * 0.9` half-diagonals, half-width `width / 2 * (0.3 + 1.2 d)`
 * plus half a pixel of anti-aliasing on each side.
 */
export function hyperspaceStreakCount(
  count: number,
  width: number,
  stretch: number,
  refWidth: number,
): number {
  const radius = Math.hypot(refWidth, 1080) / 2;
  const hw = (Math.max(0, width) / 2) * (0.3 + 1.2 * MEAN_DIST) + 0.5;
  const len = Math.max(0, stretch) * MEAN_DIST * 0.9 * radius;
  const perStreak = (len + 2 * hw) * 2 * hw;
  const fit = Math.floor((FILL_SCREENS * refWidth * 1080) / perStreak);
  return Math.max(1, Math.min(MAX_STREAKS, Math.floor(count), fit));
}

/**
 * Background colour with a radial glow that fades linearly to nothing at uGlowRadius,
 * with the jump flash folded in (see `frame`).
 */
const BACKGROUND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform vec3 uBackground;
uniform vec3 uGlow;
uniform float uGlowAlpha;
uniform float uGlowRadius;
/** Flash amount: white composited over the frame. */
uniform float uFlash;

out vec4 outColor;
${DITHER_GLSL}

void main() {
  float r = length(gl_FragCoord.xy - 0.5 * uResolution);
  float a = uGlowAlpha * (1.0 - clamp(r / uGlowRadius, 0.0, 1.0));
  vec3 c = mix(uBackground, uGlow, a);
  c = uFlash + (1.0 - uFlash) * c;
  // Sub-LSB dither hides banding in the wide, shallow gradient.
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Radial light streaks with a jump cycle: drifting stars stretch into a tunnel
 * of light with a flash on entry, then drop back to stars. Simulated on the CPU;
 * drawn in WebGL2 as a full-screen background pass plus instanced capsules.
 */
export const hyperspace = defineEffect(hyperspaceMeta, {
  create(gl) {
    return withScope((scope) => {
      const streaks = scope.own(createStreakRenderer(gl, MAX_STREAKS));
      const data = streaks.data;
      const triangle = scope.own(createFullscreenTriangle(gl));
      const bgProgram = scope.add(
        createProgram(gl, FULLSCREEN_VERTEX, BACKGROUND_FRAGMENT),
        (p) => {
          gl.deleteProgram(p);
        },
      );
      const bgU = createUniforms(gl, bgProgram, [
        "uResolution",
        "uBackground",
        "uGlow",
        "uGlowAlpha",
        "uGlowRadius",
        "uFlash",
      ]);
      const streakRgb = unitRgbMemo();
      const glowRgb = unitRgbMemo();
      const backgroundRgb = unitRgbMemo();

      /** Unit direction of each streak; fixed for its lifetime. */
      const dirX = new Float32Array(MAX_STREAKS);
      const dirY = new Float32Array(MAX_STREAKS);
      const dist = new Float32Array(MAX_STREAKS);
      const pace = new Float32Array(MAX_STREAKS);
      const mix = new Float32Array(MAX_STREAKS);
      const life = new Float32Array(MAX_STREAKS);
      /** Streaks simulated: the count plus any still fading out after it dropped. */
      let live = 0;
      let width = 1;
      let height = 1;
      let scale = 1;
      const jumpCycle = createJump();

      const spawn = (i: number, d: number) => {
        const angle = Math.random() * Math.PI * 2;
        dirX[i] = Math.cos(angle);
        dirY[i] = Math.sin(angle);
        dist[i] = d;
        pace[i] = 0.6 + Math.random() * 0.8;
        mix[i] = Math.random();
      };
      for (let i = 0; i < MAX_STREAKS; i++) {
        spawn(i, Math.random());
      }

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          jumpCycle.step(dt, p.mode, p.jumpSeconds, p.cycleSeconds);
          const jump = smoothstep(0, 1, jumpCycle.progress);
          const flash = jumpCycle.flash;

          const cx = width / 2;
          const cy = height / 2;
          const radius = Math.hypot(width, height) / 2;

          // The flash is premultiplied white at amount A composited over the frame:
          // A + (1 - A) * min(1, bg + streaks) = min(1, A + (1 - A) * bg + (1 - A) * streaks)
          // for A in [0, 1], so it is folded into the background pass and the streak
          // colours instead of costing another full-screen blended pass.
          const flashAmount = p.flash ? flash * 0.6 : 0;
          const keep = 1 - flashAmount;
          const glow = glowRgb(p.glowColor);
          const streak = streakRgb(p.color);
          const gr = glow[0];
          const gg = glow[1];
          const gb = glow[2];
          const sr = streak[0];
          const sg = streak[1];
          const sb = streak[2];
          const halfWidth = (scale * p.width) / 2;
          const velocity = p.speed * (0.04 + jump);
          // Wider, longer streaks draw fewer of them, keeping the blended area within budget.
          const wanted = hyperspaceStreakCount(p.count, p.width, p.stretch, width / scale);
          const n = (live = growLive(life, live, wanted));
          const fadeStep = dt / FADE_IN;
          const outStep = dt / FADE_OUT;
          for (let i = 0; i < n; i++) {
            let d = dist[i] + dt * velocity * pace[i] * (0.1 + dist[i]);
            if (d > 1.1) {
              spawn(i, 0.02 + Math.random() * 0.25);
              d = dist[i];
            }
            dist[i] = d;
            const len = 0.003 + jump * p.stretch * d * 0.9;
            const t = Math.max(0, d - len);
            const dx = dirX[i] * radius;
            const dy = dirY[i] * radius;
            // Added streaks appear mid-flight, so they fade in rather than pop.
            const alpha = Math.min(1, d * 3) * keep * stepLife(life, i, wanted, fadeStep, outStep);
            const m = mix[i] * 0.5;
            const o = i * STREAK_FLOATS;
            data[o] = cx + dx * t;
            data[o + 1] = cy + dy * t;
            data[o + 2] = cx + dx * d;
            data[o + 3] = cy + dy * d;
            data[o + 4] = (sr + (gr - sr) * m) * alpha;
            data[o + 5] = (sg + (gg - sg) * m) * alpha;
            data[o + 6] = (sb + (gb - sb) * m) * alpha;
            data[o + 7] = halfWidth * (0.3 + d * 1.2);
          }
          live = trimLive(life, live, wanted);

          const bg = backgroundRgb(p.background);
          const glowAlpha = Math.max(0, p.glow) * (0.15 + 0.5 * jump);
          if (glowAlpha === 0 && flashAmount === 0) {
            // A flat 8-bit colour plus sub-LSB dither rounds back to itself, so a
            // (typically fast) clear gives the same pixels as the shader pass.
            gl.clearColor(bg[0], bg[1], bg[2], 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          } else {
            gl.useProgram(bgProgram);
            bgU.f2("uResolution", width, height);
            bgU.v3("uBackground", bg);
            bgU.v3("uGlow", glow);
            bgU.f1("uGlowAlpha", glowAlpha);
            bgU.f1("uGlowRadius", Math.max(1, radius * 0.8));
            bgU.f1("uFlash", flashAmount);
            triangle.draw();
          }

          streaks.upload(n);
          streaks.draw(n, width, height);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
