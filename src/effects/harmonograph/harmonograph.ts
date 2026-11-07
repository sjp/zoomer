import { unitRgbMemo } from "../color";
import {
  beginFrame,
  createProgram,
  createUniforms,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import {
  createHarmonograph,
  FADE_HOLD,
  FIGURE_SEGMENTS,
  PALETTE_STOPS,
  SEG_FLOATS,
  TIME_PERIOD,
} from "./harmonograph-sim";
import { approach } from "../math";
import { createRng } from "../noise";
import { harmonographMeta } from "./harmonograph.meta";
import { defineEffect } from "../types";

/**
 * Segments in the ring: two full figures (one drawing, one fading) plus slack.
 * 16384 × 24 bytes = 384 KiB of instance data, uploaded a few segments per frame.
 */
const MAX_SEGMENTS = 16384;
if (MAX_SEGMENTS < 2.5 * FIGURE_SEGMENTS) {
  throw new Error("Harmonograph: ring too small");
}

/** Glow radius beyond the line's edge, in 1080p pixels. */
const GLOW_RADIUS = 9;
/** Peak glow brightness at glow = 1. */
const GLOW_PEAK = 0.4;
/** How quickly the pen-tip highlight decays with segment age, per second. */
const TIP_RATE = 2.5;
/** Fraction of the frame the figure's box spans and where it sits (x centre). */
const POSITIONS: Record<string, readonly [cx: number, extentX: number]> = {
  centre: [0.5, 0.42],
  left: [0.31, 0.27],
  right: [0.69, 0.27],
};
/** Vertical half-extent of the figure as a fraction of the height. */
const EXTENT_Y = 0.44;
/** Widest the figure's half-width may be, as a multiple of the height (portrait-safe). */
const MAX_EXTENT_X = 0.85;

/** Four cyclic palette stops each, in linear 0..1 RGB (premultiplied by nothing). */
const PALETTES: Record<string, Float32Array> = {
  neon: new Float32Array([1, 0.24, 0.67, 0.58, 0.32, 1, 0.16, 0.62, 1, 0.05, 0.95, 0.82]),
  ember: new Float32Array([1, 0.32, 0.08, 1, 0.58, 0.14, 1, 0.84, 0.42, 0.92, 0.2, 0.22]),
  ocean: new Float32Array([0.1, 0.5, 0.95, 0.2, 0.82, 0.88, 0.45, 0.95, 0.78, 0.3, 0.42, 1]),
  mono: new Float32Array([0.92, 0.94, 1, 0.74, 0.78, 0.88, 1, 1, 1, 0.8, 0.84, 0.95]),
};

const VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSegment;
layout(location = 2) in vec2 aMeta;

uniform vec2 uResolution;
uniform vec2 uCenter;
uniform vec2 uExtent;
uniform float uTime;
uniform float uHoldAge;
uniform float uFadeAge;
uniform float uRadius;
uniform float uGain;
uniform float uGlow;
uniform vec3 uPalette[${String(PALETTE_STOPS)}];

out vec2 vLocal;
flat out float vLength;
flat out vec3 vColor;

${TO_CLIP_GLSL}

void main() {
  vec2 a = uCenter + aSegment.xy * uExtent;
  vec2 b = uCenter + aSegment.zw * uExtent;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);

  // Birth times wrap at TIME_PERIOD, which is longer than any fade.
  float age = uTime - aMeta.x;
  if (age < 0.0) age += ${glslFloat(TIME_PERIOD)};
  float fade = 1.0 - smoothstep(uHoldAge, uFadeAge, age);

  // Cyclic palette lookup, eased between stops.
  float ph = aMeta.y;
  int i = int(floor(ph)) % ${String(PALETTE_STOPS)};
  int j = (i + 1) % ${String(PALETTE_STOPS)};
  float f = fract(ph);
  vec3 color = mix(uPalette[i], uPalette[j], f * f * (3.0 - 2.0 * f));
  // The newest segments (the pen tip) run brighter and whiter.
  float tip = exp(-age * ${glslFloat(TIP_RATE)});
  color = mix(color, vec3(1.0), 0.5 * tip) * (1.0 + 0.6 * tip);

  // The glow pass overlaps many segments; scale each so the sum along the line
  // is about uGain (a capsule's soft profile integrates to 2R/3 along its axis).
  float overlap = mix(1.0, min(1.0, 1.5 * len / uRadius), uGlow);
  vColor = color * (fade * uGain * overlap);

  float ext = uRadius + 0.5;
  float u = aCorner.x < 0.0 ? -ext : len + ext;
  float v = aCorner.y * ext;
  vLocal = vec2(u, v);
  vLength = len;
  // Collapse fully faded segments so they rasterise nothing.
  gl_Position = fade > 0.0 ? pxToClip(a + dir * u + nrm * v, uResolution) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
flat in float vLength;
flat in vec3 vColor;

uniform float uRadius;
uniform float uGlow;

out vec4 outColor;

void main() {
  float dx = vLocal.x - clamp(vLocal.x, 0.0, vLength);
  float dist = length(vec2(dx, vLocal.y));
  float hard = clamp(uRadius + 0.5 - dist, 0.0, 1.0);
  float soft = max(1.0 - dist / (uRadius + 0.5), 0.0);
  float c = mix(hard, soft * soft, uGlow);
  outColor = vec4(vColor * c, c);
}
`;

/**
 * A harmonograph: a pen moved by decaying pendulums draws looping figures that
 * slowly fade while the next one draws. The curve is sampled on the CPU into a
 * ring of fixed-length segments (only new ones are uploaded each frame) and
 * drawn as instanced capsules, faded by age in the vertex shader: once wide,
 * soft and additive for the glow, then once thin with MAX blending, so joints
 * and crossings don't double up.
 */
export const harmonograph = defineEffect(harmonographMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, VERTEX, FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const u = createUniforms(gl, program, [
        "uResolution",
        "uCenter",
        "uExtent",
        "uTime",
        "uHoldAge",
        "uFadeAge",
        "uRadius",
        "uGain",
        "uGlow",
        "uPalette",
      ]);
      const backgroundRgb = unitRgbMemo();
      const rng = createRng(Math.floor(Math.random() * 0x100000000));
      const sim = createHarmonograph(MAX_SEGMENTS, rng, 0.4);
      const data = sim.data;

      const vao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const cornerBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      const instanceBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      const stride = SEG_FLOATS * 4;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribDivisor(2, 1);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      /** Points the instance attributes at `first` and draws `count` segments from there. */
      function drawRange(first: number, count: number) {
        if (count <= 0) {
          return;
        }
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, first * stride);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, first * stride + 16);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      }

      /** Draws every live segment: one or two ranges, depending on whether they wrap. */
      function drawLive() {
        const live = sim.live;
        const head = sim.head;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
        if (live <= head) {
          drawRange(head - live, live);
        } else {
          drawRange(MAX_SEGMENTS - (live - head), live - head);
          drawRange(0, head);
        }
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }

      /** Uploads the slots written since the last upload (one or two ranges). */
      function upload() {
        const n = sim.dirtyCount;
        if (n === 0) {
          return;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
        if (n >= MAX_SEGMENTS) {
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
        } else {
          const start = sim.dirtyStart;
          const first = Math.min(n, MAX_SEGMENTS - start);
          gl.bufferSubData(
            gl.ARRAY_BUFFER,
            start * stride,
            data,
            start * SEG_FLOATS,
            first * SEG_FLOATS,
          );
          if (first < n) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, (n - first) * SEG_FLOATS);
          }
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        sim.clearDirty();
      }

      const settings = { drawTime: 75, complexity: 0.4 };
      let width = 1;
      let height = 1;
      let scale = 1;
      let started = false;
      let palette = "";
      // Eased placement, as fractions of the frame, so a position change glides.
      let cx = POSITIONS.centre[0];
      let ex = POSITIONS.centre[1];

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          settings.drawTime = p.drawTime;
          settings.complexity = p.complexity;
          if (!started) {
            // Start with a fifth of the first figure already drawn, not a blank frame.
            started = true;
            const warm = 0.2 * p.drawTime;
            for (let t = 0; t < warm; t += 0.1) {
              sim.step(0.1, settings);
            }
          }
          sim.step(dt, settings);
          upload();

          const target = POSITIONS[p.position] ?? POSITIONS.centre;
          cx = approach(cx, target[0], dt * 0.15);
          ex = approach(ex, target[1], dt * 0.1);

          const bg = backgroundRgb(p.background);
          gl.clearColor(bg[0], bg[1], bg[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          if (sim.live === 0) {
            return;
          }

          gl.useProgram(program);
          if (palette !== p.palette) {
            palette = p.palette;
            gl.uniform3fv(u.loc.uPalette, PALETTES[palette] ?? PALETTES.neon);
          }
          u.f2("uResolution", width, height);
          u.f2("uCenter", cx * width, 0.5 * height);
          u.f2("uExtent", Math.min(ex * width, MAX_EXTENT_X * height), EXTENT_Y * height);
          u.f1("uTime", sim.time % TIME_PERIOD);
          u.f1("uHoldAge", FADE_HOLD * sim.fadeAge);
          u.f1("uFadeAge", sim.fadeAge);

          gl.enable(gl.BLEND);
          const half = (p.lineWidth * scale) / 2;
          const radius = Math.max(half, 0.5);
          if (p.glow > 0) {
            // Glow: wide, soft and additive.
            gl.blendFunc(gl.ONE, gl.ONE);
            u.f1("uRadius", radius + GLOW_RADIUS * scale);
            u.f1("uGain", GLOW_PEAK * p.glow);
            u.f1("uGlow", 1);
            drawLive();
          }
          // Core line: MAX blending, so overlapping joints and crossings don't stack.
          // Lines thinner than a pixel draw a pixel wide at proportionally lower intensity.
          gl.blendEquation(gl.MAX);
          u.f1("uRadius", radius);
          u.f1("uGain", half / radius);
          u.f1("uGlow", 0);
          drawLive();
          gl.blendEquation(gl.FUNC_ADD);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
