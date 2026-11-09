import { unitRgbMemo } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
  createPingPong,
} from "../gl";
import { createFlowField } from "./flowfield-field";
import { createNoise, createRng, hash32, HASH32_GLSL } from "../noise";
import { flowfieldMeta, MAX_PARTICLES } from "./flowfield.meta";
import { defineEffect } from "../types";
import { smoothstep } from "../math";
import { FADE_OUT, growLive, stepLife, trimLive } from "../fade";

/** Reference particle speed in px/s at 1080p for a speed of 1. */
const SPEED_PX = 90;
/** Noise frequency per reference pixel for a field detail of 1 (about 1.7 cells per screen height). */
const FIELD_FREQ = 0.0016;
/** Noise time units per second for a field change speed of 1. */
const EVOLVE_RATE = 0.08;
/** Particle lifespan range in seconds, and how long the fade in/out at each end lasts. */
const LIFE_MIN = 4;
const LIFE_SPREAD = 6;
const LIFE_FADE = 1;
/**
 * Extra pull towards empty, as a fraction of the remaining distance to full per
 * second (the 2D version burned two 8-bit levels every 0.1s). Besides the
 * exponential fade this guarantees faint residue reaches exactly empty.
 */
const CLEAN_RATE = 20 / 255;
/** Floats per particle segment instance: x0, y0, x1, y1, colour t, alpha. */
const STRIDE = 6;
const TAU = Math.PI * 2;

/**
 * One anti-aliased line segment per instance, expanded from gl_VertexID into a
 * quad with butt ends. Positions are canvas pixels with y down.
 */
const SEGMENT_VERTEX = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec4 aSeg;
layout(location = 1) in vec2 aStyle;

uniform vec2 uResolution;
uniform float uHalfWidth;

out float vSide;
out float vT;
out float vAlpha;

const vec2 CORNERS[6] = vec2[6](
  vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(0.0, 1.0),
  vec2(0.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
);
${TO_CLIP_GLSL}
void main() {
  vec2 c = CORNERS[gl_VertexID];
  vec2 p0 = aSeg.xy;
  vec2 p1 = aSeg.zw;
  vec2 d = p1 - p0;
  float len = length(d);
  d = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  // One extra pixel each side for the anti-aliased edge.
  float extent = uHalfWidth + 1.0;
  vec2 pos = mix(p0, p1, c.x) + n * (c.y * extent);
  vSide = c.y * extent;
  vT = aStyle.x;
  vAlpha = aStyle.y;
  gl_Position = pxToClip(pos, uResolution);
}
`;

const SEGMENT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in float vSide;
in float vT;
in float vAlpha;

uniform float uHalfWidth;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform float uThree;
uniform float uLight;

out vec4 outColor;

void main() {
  // Exact coverage of a one-pixel box across the line.
  float coverage = clamp(min(vSide + 0.5, uHalfWidth) - max(vSide - 0.5, -uHalfWidth), 0.0, 1.0);
  vec3 color = uThree > 0.5
    ? (vT < 0.5 ? mix(uColor1, uColor2, vT * 2.0) : mix(uColor2, uColor3, vT * 2.0 - 1.0))
    : mix(uColor1, uColor2, vT);
  // The light layer is stored inverted, so its empty value is zero as well.
  if (uLight > 0.5) color = 1.0 - color;
  outColor = vec4(color, vAlpha * coverage);
}
`;

/**
 * Fades the trail layer towards empty (zero): v * keep - clean * (1 - v). The
 * result is stochastically rounded to a whole level of the fixed-point target, so
 * slow fades progress at the exact average rate instead of stalling above empty.
 */
const FADE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
/**
 * The fade in target levels, as one multiply-add: (v * keep - clean * (1 - v)) *
 * levels = v * x + y.
 */
uniform vec2 uFade;
/** 1 / levels of the target format: 1023 for 10-bit, 255 for 8-bit. */
uniform float uInvLevels;
/** Per-frame hash seed, so the rounding noise changes every frame. */
uniform uint uSeed;
uniform uint uStride;

out vec4 outColor;

${HASH32_GLSL}
void main() {
  uvec2 q = uvec2(gl_FragCoord.xy);
  vec3 v = texelFetch(uPrev, ivec2(q), 0).rgb;
  float r = float(hash32(q.y * uStride + q.x + uSeed) >> 8u) * (1.0 / 16777216.0);
  v = floor(v * uFade.x + uFade.y + r) * uInvLevels;
  outColor = vec4(max(v, 0.0), 1.0);
}
`;

/**
 * The fade pass's `uFade` for a frame of `dt` seconds into a target with `levels`
 * steps (255 or 1023), written to `out`: the trail decays with a time constant from
 * 0.1s (`trail` 0) to 3s (`trail` 1), plus the CLEAN_RATE pull towards empty.
 */
export function fadeTerms(dt: number, trail: number, levels: number, out: Float64Array): void {
  const tau = 0.1 * Math.pow(30, trail);
  const keep = Math.exp(-dt / tau);
  const clean = Math.min(1, dt * CLEAN_RATE);
  out[0] = (keep + clean) * levels;
  out[1] = -clean * levels;
}

/**
 * Screens (dark) or multiplies (light, from the inverted layer) the trails over the
 * background. Both are bg + k * l: k = 1 - bg for screen, -bg for multiply.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uLayer;
uniform vec3 uBackground;
uniform vec3 uLayerScale;

out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec3 l = texelFetch(uLayer, ivec2(gl_FragCoord.xy), 0).rgb;
  // Sub-LSB dither carries the 10-bit layer's extra precision into the 8-bit
  // canvas, so faint tails fade smoothly instead of stepping on dark backgrounds.
  outColor = vec4(uBackground + uLayerScale * l + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Generative-art streams: thousands of particles drift along a slowly evolving
 * noise vector field and leave silky fading trails.
 *
 * Particles are simulated on the CPU, steering by a bilinear lookup into the noise
 * field baked on a small lattice that scrolls through time (see flowfield-field.ts)
 * rather than by evaluating 3D noise per particle; each frame's movement is
 * uploaded as one instanced batch of anti-aliased segments. Trails live on a ping-ponged offscreen
 * layer (RGB10_A2, else RGBA8) whose empty value is zero. Each
 * frame a pass fades the previous layer into the other one, the new segments are
 * blended on top, and the layer is screened over the background (dark backgrounds)
 * or, stored inverted, multiplied over it (light backgrounds), so the visible frame
 * is repainted in full and the background stays clean.
 *
 * At 4K the effect is bound by memory bandwidth, so the layer is 32 bits per pixel
 * rather than half float: 10 bits per channel plus stochastic rounding in the fade
 * keeps long faint trails smooth, and the composite to the 8-bit canvas hides any
 * difference. The fade target is invalidated first, as it is fully overwritten, so
 * tiled GPUs need not load its stale contents.
 */
export const flowfield = defineEffect(flowfieldMeta, {
  create(gl) {
    return withScope((scope) => {
      const xs = new Float32Array(MAX_PARTICLES);
      const ys = new Float32Array(MAX_PARTICLES);
      const ages = new Float32Array(MAX_PARTICLES);
      const lives = new Float32Array(MAX_PARTICLES);
      /** Count fade (see `fade.ts`): particles removed by a lower count fade out first. */
      const countFade = new Float32Array(MAX_PARTICLES).fill(1);
      const rands = new Float32Array(MAX_PARTICLES);
      const instances = new Float32Array(MAX_PARTICLES * STRIDE);
      /** `uFade` for this frame, from `fadeTerms`. */
      const fadeOut = new Float64Array(2);

      const segProgram = scopedProgram(gl, scope, SEGMENT_VERTEX, SEGMENT_FRAGMENT);
      const fadeProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FADE_FRAGMENT);
      const compProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const seg = createUniforms(gl, segProgram, [
        "uResolution",
        "uHalfWidth",
        "uColor1",
        "uColor2",
        "uColor3",
        "uThree",
        "uLight",
      ]);
      const fade = createUniforms(gl, fadeProgram, [
        "uPrev",
        "uFade",
        "uInvLevels",
        "uSeed",
        "uStride",
      ]);
      const comp = createUniforms(gl, compProgram, ["uLayer", "uBackground", "uLayerScale"]);
      // Uniforms live in their programs, so the samplers only need setting once.
      gl.useProgram(fadeProgram);
      fade.i1("uPrev", 0);
      gl.useProgram(compProgram);
      comp.i1("uLayer", 0);
      gl.useProgram(null);
      const triangle = scope.own(createFullscreenTriangle(gl));

      const vao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const instanceBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, instances.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, STRIDE * 4, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE * 4, 16);
      gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      /** 10-bit layers avoid 8-bit grain in long, faint trails at the same bandwidth. */
      let use10 = true;
      /** The trail layer, ping-ponged each frame; `src` holds the latest. */
      const layers = scope.own(createPingPong(gl, gl.RGB10_A2, { filter: gl.NEAREST }));

      let width = 1;
      let height = 1;
      let scale = 1;
      let time = 0;
      let frameNo = 0;
      /** Particles simulated: the count plus any still fading out after it dropped. */
      let active = 0;
      let seedKey = Number.NaN;
      let noise3 = createNoise(1).noise3;
      const field = createFlowField();
      let rng = createRng(1);
      /** Whether the trail layer is in light mode, or undefined to clear it. */
      let lightMode: boolean | undefined;
      const EMPTY = new Float32Array([0, 0, 0, 1]);
      const INVALIDATE = [gl.COLOR_ATTACHMENT0];
      const background = unitRgbMemo();

      /**
       * (Re)creates both layer targets at the canvas size; the next frame clears them.
       * A failed allocation isn't retried until the size changes, so a size past
       * MAX_TEXTURE_SIZE or out of memory doesn't reallocate every frame.
       */
      const ensureTargets = () => {
        if (layers.width === width && layers.height === height) {
          return;
        }
        if (!layers.resize(width, height) && use10) {
          // 10-bit not renderable after all: carry on in 8-bit.
          use10 = false;
          layers.resize(width, height, { format: gl.RGBA8 });
        }
        if (!layers.ready) {
          console.warn(
            `flowfield: can't allocate ${String(width)}x${String(height)} trail layers; drawing nothing`,
          );
        }
        lightMode = undefined;
      };

      const spawn = (i: number, randomAge: boolean) => {
        xs[i] = rng() * width;
        ys[i] = rng() * height;
        lives[i] = LIFE_MIN + rng() * LIFE_SPREAD;
        ages[i] = randomAge ? rng() * lives[i] : 0;
        rands[i] = rng();
      };

      /**
       * New field and particles, all at random ages. The first `count` count as
       * active already, so the frame doesn't respawn them fresh: that would line their
       * ages up, fading them all in together and later dying together.
       */
      const reseed = (seed: number, count: number) => {
        noise3 = createNoise(seed * 131 + 17).noise3;
        rng = createRng(seed * 7907 + 3);
        for (let i = 0; i < MAX_PARTICLES; i++) {
          spawn(i, true);
        }
        active = Math.min(Math.round(count), MAX_PARTICLES);
        countFade.fill(1, 0, active);
        lightMode = undefined;
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
          width = Math.max(1, Math.round(width));
          height = Math.max(1, Math.round(height));
          // Resizing clears the layer; respawn so no trail spans the old and new size.
          for (let i = 0; i < MAX_PARTICLES; i++) {
            spawn(i, true);
          }
          lightMode = undefined;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          if (p.seed !== seedKey) {
            seedKey = p.seed;
            reseed(p.seed, p.count);
          }
          ensureTargets();
          if (!layers.ready) {
            return;
          }

          gl.activeTexture(gl.TEXTURE0);

          const bg = background(p.background);
          const light = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2] > 140 / 255;
          if (light !== lightMode) {
            lightMode = light;
            for (const t of [layers.src, layers.dst]) {
              gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
              gl.clearBufferfv(gl.COLOR, 0, EMPTY);
            }
          }

          // Fade the previous layer into the other target. The time constant spans 0.1s to 3s.
          const { src, dst } = layers;
          layers.swap();
          gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
          // Every pixel is overwritten below, so the old contents need not be loaded.
          gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE);
          gl.useProgram(fadeProgram);
          gl.bindTexture(gl.TEXTURE_2D, src.texture);
          const levels = use10 ? 1023 : 255;
          fadeTerms(dt, p.trail, levels, fadeOut);
          fade.f2("uFade", fadeOut[0], fadeOut[1]);
          fade.f1("uInvLevels", 1 / levels);
          frameNo = (frameNo + 1) >>> 0;
          fade.u1("uSeed", hash32(frameNo));
          fade.u1("uStride", width);
          triangle.draw();

          // Newly enabled particles start fresh so they fade in where they appear.
          const target = Math.min(Math.round(p.count), MAX_PARTICLES);
          for (let i = active; i < target; i++) {
            spawn(i, false);
          }
          const n = (active = growLive(countFade, active, target));
          const fadeStep = dt / FADE_OUT;

          time += dt * p.evolve * EVOLVE_RATE;
          const freq = (p.fieldScale * FIELD_FREQ) / scale;
          const swirl = TAU * p.turbulence;
          const step = p.speed * SPEED_PX * scale * dt;
          const margin = 10 * scale;
          const byAngle = p.colorBy === "angle";
          let count = 0;
          // The particles stay within the margin wherever the field is read.
          field.update(
            noise3,
            -margin * freq,
            -margin * freq,
            (width + margin) * freq,
            (height + margin) * freq,
            time,
          );

          for (let i = 0; i < n; i++) {
            const kept = stepLife(countFade, i, target, fadeStep, fadeStep);
            const age = ages[i] + dt;
            const x = xs[i];
            const y = ys[i];
            if (
              age >= lives[i] ||
              x < -margin ||
              x > width + margin ||
              y < -margin ||
              y > height + margin
            ) {
              spawn(i, false);
              continue;
            }
            ages[i] = age;
            const angle = field.sample(x * freq, y * freq) * swirl;
            const cos = Math.cos(angle);
            const nx = x + cos * step;
            const ny = y + Math.sin(angle) * step;
            xs[i] = nx;
            ys[i] = ny;

            const life = lives[i];
            const f =
              smoothstep(0, LIFE_FADE, age) * smoothstep(life, life - LIFE_FADE, age) * kept;
            if (f <= 0 || step === 0) {
              continue;
            }
            const o = count * STRIDE;
            instances[o] = x;
            instances[o + 1] = y;
            instances[o + 2] = nx;
            instances[o + 3] = ny;
            // Map direction smoothly around the circle: colour 1 one way, colour 3 the other.
            instances[o + 4] = byAngle ? 0.5 - 0.5 * cos : rands[i];
            instances[o + 5] = p.opacity * f;
            count++;
          }
          active = trimLive(countFade, active, target);

          if (count > 0) {
            gl.enable(gl.BLEND);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(segProgram);
            seg.f2("uResolution", width, height);
            seg.f1("uHalfWidth", Math.max(0.5, p.lineWidth * scale) / 2);
            seg.rgb("uColor1", p.color1);
            seg.rgb("uColor2", p.color2);
            seg.rgb("uColor3", p.color3);
            seg.f1("uThree", p.useColor3 ? 1 : 0);
            seg.f1("uLight", light ? 1 : 0);
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * STRIDE);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
            gl.bindVertexArray(null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            gl.disable(gl.BLEND);
          }

          // Full repaint of the visible canvas: the layer composited over the background.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.useProgram(compProgram);
          gl.bindTexture(gl.TEXTURE_2D, dst.texture);
          comp.v3("uBackground", bg);
          if (light) {
            comp.f3("uLayerScale", -bg[0], -bg[1], -bg[2]);
          } else {
            comp.f3("uLayerScale", 1 - bg[0], 1 - bg[1], 1 - bg[2]);
          }
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
