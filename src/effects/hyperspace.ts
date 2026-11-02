import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  getUniforms,
  withScope,
} from "./gl";
import { createRgbCache, createStreakRenderer, STREAK_FLOATS } from "./streaks";
import { defineEffect } from "./types";
import { smoothstep } from "./math";

const MAX_STREAKS = 3000;

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
export const hyperspace = defineEffect({
  id: "hyperspace",
  name: "Hyperspace",
  description:
    "Stars stretch into a blue-white tunnel of light, with an optional jump in/out cycle.",
  context: "webgl2",
  params: {
    speed: { kind: "number", label: "Speed", min: 0.1, max: 5, step: 0.1, default: 1.5 },
    count: {
      kind: "number",
      label: "Streaks",
      min: 200,
      max: MAX_STREAKS,
      step: 100,
      default: 900,
    },
    stretch: { kind: "number", label: "Stretch", min: 0.05, max: 1, step: 0.01, default: 0.8 },
    width: { kind: "number", label: "Streak width", min: 0.5, max: 6, step: 0.1, default: 2 },
    color: { kind: "color", label: "Streak colour", default: "#d6e4ff" },
    glowColor: { kind: "color", label: "Glow colour", default: "#3060ff" },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, step: 0.01, default: 0.5 },
    mode: {
      kind: "select",
      label: "Jump",
      options: [
        { value: "cycle", label: "Auto cycle in/out" },
        { value: "in", label: "Jump to hyperspace" },
        { value: "out", label: "Drop to normal space" },
      ],
      default: "cycle",
    },
    jumpSeconds: {
      kind: "number",
      label: "Jump duration (s)",
      min: 0.3,
      max: 5,
      step: 0.1,
      default: 1.6,
    },
    cycleSeconds: {
      kind: "number",
      label: "Cycle length (s)",
      min: 6,
      max: 60,
      step: 1,
      default: 16,
    },
    flash: { kind: "boolean", label: "Flash on jump", default: true },
    background: { kind: "color", label: "Background", default: "#000005" },
  },
  create(gl) {
    return withScope((scope) => {
      const streaks = scope.own(createStreakRenderer(gl, MAX_STREAKS));
      const data = streaks.data;
      const triangle = scope.own(createFullscreenTriangle(gl));
      const bgProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, BACKGROUND_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const bgLoc = getUniforms(gl, bgProgram, [
        "uResolution",
        "uBackground",
        "uGlow",
        "uGlowAlpha",
        "uGlowRadius",
        "uFlash",
      ]);
      const streakRgb = createRgbCache();
      const glowRgb = createRgbCache();
      const backgroundRgb = createRgbCache();

      /** Unit direction of each streak; fixed for its lifetime. */
      const dirX = new Float32Array(MAX_STREAKS);
      const dirY = new Float32Array(MAX_STREAKS);
      const dist = new Float32Array(MAX_STREAKS);
      const pace = new Float32Array(MAX_STREAKS);
      const mix = new Float32Array(MAX_STREAKS);
      let width = 1;
      let height = 1;
      let scale = 1;
      let cycleTime = 0;
      /** Linear jump progress: 0 = normal space, 1 = full hyperspace. */
      let progress = -1;
      let flashLevel = 0;

      const spawn = (i: number, d: number) => {
        const angle = Math.random() * Math.PI * 2;
        dirX[i] = Math.cos(angle);
        dirY[i] = Math.sin(angle);
        dist[i] = d;
        pace[i] = 0.6 + Math.random() * 0.8;
        mix[i] = Math.random();
      };
      for (let i = 0; i < MAX_STREAKS; i++) spawn(i, Math.random());

      /** Whether the effect should currently be heading into hyperspace. */
      const wantHyperspace = (mode: string, cycleSeconds: number) => {
        if (mode === "in") return true;
        if (mode === "out") return false;
        // Auto cycle: normal space for the first quarter, hyperspace for the next 60%.
        const phase = (cycleTime % cycleSeconds) / cycleSeconds;
        return phase >= 0.25 && phase < 0.85;
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          cycleTime += dt;
          const target = wantHyperspace(p.mode, p.cycleSeconds) ? 1 : 0;
          // The first frame starts in its target state rather than jumping into it.
          if (progress < 0) progress = target;
          const before = progress;
          const stepSize = dt / p.jumpSeconds;
          progress =
            target > progress ? Math.min(1, progress + stepSize) : Math.max(0, progress - stepSize);
          // Flash as the jump in reaches full speed.
          if (before < 0.9 && progress >= 0.9) flashLevel = 1;
          flashLevel = Math.max(0, flashLevel - dt / 0.35);
          const jump = smoothstep(0, 1, progress);
          const flash = flashLevel;

          const cx = width / 2;
          const cy = height / 2;
          const radius = Math.hypot(width, height) / 2;

          // The flash is premultiplied white at amount A composited over the frame:
          // A + (1 - A) * min(1, bg + streaks) = min(1, A + (1 - A) * bg + (1 - A) * streaks)
          // for A in [0, 1], so it is folded into the background pass and the streak
          // colours instead of costing another full-screen blended pass.
          const flashAmount = p.flash ? flash * 0.6 : 0;
          const keep = 1 - flashAmount;
          const [gr, gg, gb] = glowRgb(p.glowColor);
          const [sr, sg, sb] = streakRgb(p.color);
          const halfWidth = (scale * p.width) / 2;
          const velocity = p.speed * (0.04 + jump);
          const n = Math.min(p.count, MAX_STREAKS);
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
            const alpha = Math.min(1, d * 3) * keep;
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

          const [br, bg, bb] = backgroundRgb(p.background);
          const glowAlpha = Math.max(0, p.glow) * (0.15 + 0.5 * jump);
          if (glowAlpha === 0 && flashAmount === 0) {
            // A flat 8-bit colour plus sub-LSB dither rounds back to itself, so a
            // (typically fast) clear gives the same pixels as the shader pass.
            gl.clearColor(br, bg, bb, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          } else {
            gl.useProgram(bgProgram);
            gl.uniform2f(bgLoc.uResolution, width, height);
            gl.uniform3f(bgLoc.uBackground, br, bg, bb);
            gl.uniform3f(bgLoc.uGlow, gr, gg, gb);
            gl.uniform1f(bgLoc.uGlowAlpha, glowAlpha);
            gl.uniform1f(bgLoc.uGlowRadius, Math.max(1, radius * 0.8));
            gl.uniform1f(bgLoc.uFlash, flashAmount);
            triangle.draw();
          }

          streaks.upload(n);
          streaks.draw(n, width, height);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
