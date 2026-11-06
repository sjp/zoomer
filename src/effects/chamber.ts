import {
  ALPHA,
  createChamber,
  createTrackPose,
  DRIFT_X,
  DRIFT_Y,
  MAX_POINTS,
  MAX_TRACKS,
  stepChamber,
  trackAt,
} from "./chamber-sim";
import { chamberMeta, type LightId } from "./chamber.meta";
import { lookup } from "./lookup";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  withScope,
} from "./gl";
import { fract } from "./math";
import { buildPeriodicNoiseTexture } from "./noise";
import { createStreakRenderer, STREAK_FLOATS } from "./streaks";
import { defineEffect } from "./types";

/** The tracks render into a buffer this many times smaller than the canvas; the upscale softens them. */
const TRACK_DIVISOR = 2;
/** Nested widths per segment, drawn with MAX blending for a soft, stepped profile. */
const LAYERS = 3;
/** Half width (times the core's) and brightness (times the core's) of the mid and halo layers. */
const MID_W = 1.9;
const MID_GAIN = 0.45;
const HALO_W = 3.6;
const HALO_GAIN = 0.16;
/** The outer layers widen by this much more (reference px) as a trail diffuses: the blur grows. */
const MID_BLUR = 2;
const HALO_BLUR = 6;
/** Alphas are drawn a little hotter in the core, so they read as thick and dense. */
const ALPHA_CORE_GAIN = 1.15;

/** Noise texture: size, and the reference px each of its two layers spans (they tile). */
const NOISE_SIZE = 128;
const MIST_TILE = [1500, 640] as const;
/** The finer layer drifts at this share of the coarse one, plus this much (reference px/s) upward. */
const MIST_FINE_SHARE = 0.6;
const MIST_FINE_RISE = 1.6;

const LIGHTS: Record<LightId, readonly [number, number, number]> = {
  white: [0.9, 0.94, 1],
  blue: [0.55, 0.74, 1],
  warm: [1, 0.8, 0.58],
};

/**
 * One full-screen pass: the dark chamber, the mist (two drifting fetches of a
 * small tiling noise texture), the side light, and the low-res track buffer
 * (one bilinear fetch), all tinted by the light. Dithered.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
in vec2 vUv;
uniform sampler2D uNoise;
uniform sampler2D uTracks;
uniform float uScale;
uniform float uInvRefWidth;
/** Texture offsets of the coarse (xy) and fine (zw) mist layers. */
uniform vec4 uOffset;
uniform float uMist;
uniform vec3 uLight;
out vec4 outColor;
${DITHER_GLSL}
const vec3 BASE = vec3(0.006, 0.007, 0.009);
void main() {
  vec2 p = gl_FragCoord.xy / uScale;
  // Lit from the left: brightest at that edge, falling off across the chamber.
  float side = exp2(-p.x * uInvRefWidth * 3.5);
  float a = texture(uNoise, p * ${glslFloat(1 / MIST_TILE[0])} + uOffset.xy).r;
  float b = texture(uNoise, p * ${glslFloat(1 / MIST_TILE[1])} + uOffset.zw).g;
  float mist = uMist * smoothstep(0.35, 0.85, a * 0.65 + b * 0.35);
  float tracks = texture(uTracks, vUv).r;
  vec3 col = BASE + uLight * (side * (0.022 + 0.12 * mist) + 0.014 * mist + tracks * (0.6 + 0.4 * side));
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A cloud chamber: particle tracks appear at random (a seeded Poisson
 * schedule), bloom along their paths and diffuse away, drifting with a faint,
 * side-lit mist. Tracks are polylines built at spawn, drawn each frame as
 * nested capsules with MAX blending into a half-resolution buffer (joints and
 * crossings don't stack, and the upscale softens them), then composited with
 * the mist in one full-screen pass.
 */
export const chamber = defineEffect(chamberMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const u = createUniforms(gl, program, [
        "uNoise",
        "uTracks",
        "uScale",
        "uInvRefWidth",
        "uOffset",
        "uMist",
        "uLight",
      ]);
      gl.useProgram(program);
      u.i1("uNoise", 0);
      u.i1("uTracks", 1);
      gl.useProgram(null);

      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, [
            { period: 4, seed: 9001 },
            { period: 8, seed: 9002 },
          ]),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const streaks = scope.own(
        createStreakRenderer(gl, MAX_TRACKS * (MAX_POINTS - 1) * LAYERS, { blend: "max" }),
      );

      let target: RenderTarget | null = null;
      scope.defer(() => target?.dispose());

      const pose = createTrackPose();
      let sim = createChamber(0);
      let simSeed = Number.NaN;

      let width = 1;
      let height = 1;
      let scale = 1;
      /** Reference px to track-buffer px, per axis. */
      let sx = 1;
      let sy = 1;
      let bufferHeight = 1;
      /** CPU-only time, unwrapped float64. */
      let time = 0;

      /** Streaks written this frame. */
      let n = 0;
      /** Writes a mono streak from a to b (reference px, y up) at brightness k, `halfW` reference px. */
      const put = (ax: number, ay: number, bx: number, by: number, k: number, halfW: number) => {
        const d = streaks.data;
        const o = n++ * STREAK_FLOATS;
        d[o] = ax * sx;
        d[o + 1] = bufferHeight - ay * sy;
        d[o + 2] = bx * sx;
        d[o + 3] = bufferHeight - by * sy;
        d[o + 4] = k;
        d[o + 5] = k;
        d[o + 6] = k;
        d[o + 7] = halfW * sy;
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
          const tw = Math.max(1, Math.ceil(width / TRACK_DIVISOR));
          const th = Math.max(1, Math.ceil(height / TRACK_DIVISOR));
          if (!target || target.width !== tw || target.height !== th) {
            target?.dispose();
            target = null;
            target =
              createRenderTarget(gl, tw, th, gl.R8) ?? createRenderTarget(gl, tw, th, gl.RGBA8);
            if (!target) throw new Error("Cloud Chamber: no renderable track buffer");
          }
          sx = (scale * tw) / width;
          sy = (scale * th) / height;
          bufferHeight = th;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += Math.max(0, dt);
          const seed = Math.floor(p.seed);
          if (seed !== simSeed) {
            sim = createChamber(seed);
            simSeed = seed;
          }
          const refWidth = width / scale;
          stepChamber(sim, time, p.rate, p.mix, p.magnetic, refWidth);

          // 1. Tracks, as nested capsules, revealed along their paths.
          n = 0;
          for (let i = 0; i < sim.count; i++) {
            const tr = sim.list[i];
            trackAt(tr, time, pose);
            if (!(pose.brightness > 0)) continue;
            const core = pose.brightness * (tr.kind === ALPHA ? ALPHA_CORE_GAIN : 1);
            const w = pose.halfWidth;
            const midW = w * MID_W + MID_BLUR * pose.spread;
            const haloW = w * HALO_W + HALO_BLUR * pose.spread;
            const pts = tr.pts;
            const dist = tr.dist;
            for (let j = 0; j + 1 < tr.count; j++) {
              const d0 = dist[j];
              if (d0 >= pose.reveal) break;
              const x0 = pts[2 * j] + pose.dx;
              const y0 = pts[2 * j + 1] + pose.dy;
              let x1 = pts[2 * j + 2] + pose.dx;
              let y1 = pts[2 * j + 3] + pose.dy;
              const d1 = dist[j + 1];
              if (d1 > pose.reveal) {
                const f = (pose.reveal - d0) / (d1 - d0);
                x1 = x0 + (x1 - x0) * f;
                y1 = y0 + (y1 - y0) * f;
              }
              put(x0, y0, x1, y1, Math.min(1, core), w);
              put(x0, y0, x1, y1, pose.brightness * MID_GAIN, midW);
              put(x0, y0, x1, y1, pose.brightness * HALO_GAIN, haloW);
            }
          }
          const buffer = target;
          if (buffer) {
            buffer.bind();
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            if (n > 0) {
              streaks.upload(n);
              streaks.draw(n, buffer.width, buffer.height);
              gl.disable(gl.BLEND);
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 2. Chamber, mist and tracks in one pass.
          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, buffer ? buffer.texture : null);
          gl.activeTexture(gl.TEXTURE0);
          const light = lookup(LIGHTS, p.light, "white");
          u.f1("uScale", scale);
          u.f1("uInvRefWidth", 1 / refWidth);
          // The mist drifts with the trails; the fine layer a little slower and rising, so it evolves.
          u.f4(
            "uOffset",
            fract((-DRIFT_X * time) / MIST_TILE[0]),
            fract((-DRIFT_Y * time) / MIST_TILE[0]),
            fract((-DRIFT_X * MIST_FINE_SHARE * time) / MIST_TILE[1]),
            fract((-(DRIFT_Y * MIST_FINE_SHARE + MIST_FINE_RISE) * time) / MIST_TILE[1]),
          );
          u.f1("uMist", p.mist);
          u.f3("uLight", light[0], light[1], light[2]);
          triangle.draw();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
