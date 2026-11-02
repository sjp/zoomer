import { hexToRgb, mixRgb, type Rgb } from "./color";
import {
  beginFrame,
  createProgram,
  FULLSCREEN_VERTEX,
  getUniforms,
  createFullscreenTriangle,
  withScope,
} from "./gl";
import { createNoise, createRng } from "./noise";
import { createGradientBackground, createSpriteBatch, unitRgbMemo } from "./sprites";
import { defineEffect } from "./types";

const MAX_FLAKES = 1500;
/** Reference fall speed in px/s at 1080p for the middle layer at a speed of 1. */
const FALL_PX = 70;
/** Reference horizontal drift in px/s at 1080p for a wind (or gust) of 1. */
const WIND_PX = 120;
/** Reference sway amplitude in px at 1080p for a sway of 1. */
const SWAY_PX = 28;
/** Seconds a flake takes to fade in when the flake count is raised. */
const FADE_IN = 1.5;
const TAU = Math.PI * 2;

/**
 * Per depth layer (far, mid, near): size, fall pace, opacity, how much the
 * steady wind and the gusts push it, and how much of the flake count it gets.
 */
const LAYERS = [
  { size: 0.5, pace: 0.5, alpha: 0.5, wind: 0.55, gust: 0.35, share: 0.5 },
  { size: 1, pace: 0.8, alpha: 0.85, wind: 0.8, gust: 0.65, share: 0.32 },
  { size: 2.3, pace: 1.3, alpha: 0.75, wind: 1, gust: 1, share: 0.18 },
] as const;

/** Edge softness of each layer's sprite for a given depth blur. Mid is in focus. */
const layerSoftness = (layer: number, blur: number) =>
  layer === 0 ? 0.2 + blur * 0.3 : layer === 1 ? 0.12 + blur * 0.1 : 0.25 + blur * 0.75;

/** Sprite half-size relative to the flake radius, leaving room for the soft edge. */
const spritePad = (softness: number) => 1 + softness + 0.05;

/**
 * Vertex shader for flakes. Per flake: centre and quad half-size (device px,
 * y down; the x half-size narrows as the flake tumbles), opacity and edge softness.
 */
const FLAKE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec2 aLook;
uniform vec2 uResolution;
out vec2 vLocal;
flat out float vAlpha;
flat out float vSoftness;
void main() {
  // Grow the quad by a pixel so the anti-aliased edge of tiny flakes is never clipped.
  vec2 ext = aRect.zw + 1.0;
  vec2 px = aRect.xy + aCorner * ext;
  float pad = 1.0 + aLook.y + 0.05;
  vLocal = aCorner * pad * ext / aRect.zw;
  vAlpha = aLook.x;
  vSoftness = aLook.y;
  gl_Position = vec4(px.x / uResolution.x * 2.0 - 1.0, 1.0 - px.y / uResolution.y * 2.0, 0.0, 1.0);
}
`;

/**
 * One soft round flake: a disc whose edge fades over `softness` radii, slightly
 * whiter in the middle. Output is premultiplied for source-over blending.
 */
const FLAKE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vAlpha;
flat in float vSoftness;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float s = vSoftness;
  float inner = max(0.0, 1.0 - s);
  float outer = 1.0 + s;
  // At least about a pixel of anti-aliasing, as the old bilinear-scaled sprite had.
  float mid = 0.5 * (inner + outer);
  float hw = max(0.5 * (outer - inner), 0.5 * fwidth(d));
  // Blurring spreads the same light wider, so the peak drops a little.
  float a = (1.0 - smoothstep(mid - hw, mid + hw, d)) / (1.0 + s * 0.6) * vAlpha;
  vec3 color = mix(uColor, vec3(1.0), 0.35 * max(0.0, 1.0 - d));
  outColor = vec4(color * a, a);
}
`;

/** Ground mist: the mist colour fading in over the bottom 40% of the frame. */
const MIST_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uHeight;
uniform vec3 uMist;
uniform float uAmount;
out vec4 outColor;
void main() {
  float y = uHeight - gl_FragCoord.y;
  float t = (y - 0.6 * uHeight) / (0.4 * uHeight);
  // Smooth S-curve fitted to the old piecewise-linear ramp (0, 0.25 at t = 0.45,
  // 0.7 at 0.8, 0.85 at 1): its slope changes showed as Mach bands, horizontal
  // lines that dither can't hide.
  float s = smoothstep(0.0, 1.0, t);
  float a = 0.85 * s * sqrt(s) * uAmount;
  // The mist blends over the dithered sky, scaling its dither by (1 - a), and its
  // own ramp is undithered: add the same IGN pattern scaled by a, so the total stays
  // +-0.5 LSB and the bottom of the frame doesn't band again.
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  outColor = vec4(uMist * a + a * (n - 0.5) / 255.0, a);
}
`;

/**
 * Gentle night snowfall in three depth layers: small, dim, slow flakes far
 * away and large, soft, faster flakes up close, all swaying in a gusty breeze.
 */
export const snow = defineEffect({
  id: "snow",
  name: "Snowfall",
  description:
    "Gentle snow drifting down through a night sky, with soft near flakes and a gusty breeze.",
  params: {
    count: { kind: "number", label: "Flakes", min: 50, max: MAX_FLAKES, step: 10, default: 420 },
    size: { kind: "number", label: "Flake size", min: 1, max: 10, step: 0.1, default: 3.5 },
    speed: { kind: "number", label: "Fall speed", min: 0, max: 4, step: 0.05, default: 1 },
    wind: {
      kind: "number",
      label: "Wind (negative = left)",
      min: -2,
      max: 2,
      step: 0.05,
      default: 0.2,
    },
    gustiness: { kind: "number", label: "Gustiness", min: 0, max: 1, step: 0.01, default: 0.35 },
    sway: { kind: "number", label: "Sway", min: 0, max: 1, step: 0.01, default: 0.5 },
    depthBlur: {
      kind: "number",
      label: "Depth blur (near flake softness)",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    color: { kind: "color", label: "Flake colour", default: "#eef4ff" },
    brightness: {
      kind: "number",
      label: "Flake brightness",
      min: 0.2,
      max: 1.5,
      step: 0.05,
      default: 0.9,
    },
    backgroundTop: { kind: "color", label: "Sky top colour", default: "#040a1c" },
    backgroundBottom: { kind: "color", label: "Horizon colour", default: "#1a2b4d" },
    mist: { kind: "number", label: "Ground mist", min: 0, max: 1, step: 0.01, default: 0.25 },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const flakeProgram = scope.add(createProgram(gl, FLAKE_VERTEX, FLAKE_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const flakeLoc = getUniforms(gl, flakeProgram, ["uResolution", "uColor"]);
      const mistProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, MIST_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const mistLoc = getUniforms(gl, mistProgram, ["uHeight", "uMist", "uAmount"]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      // Per flake: centre x, centre y, half-width, half-height, then opacity and softness.
      const batch = scope.own(createSpriteBatch(gl, MAX_FLAKES, [4, 2]));
      const background = scope.own(createGradientBackground(gl));
      const bgTop = unitRgbMemo();
      const bgBottom = unitRgbMemo();
      const flakeColor = unitRgbMemo();
      /**
       * Inputs the uniforms were last set from (they are per-program state, and these
       * programs are ours alone). Colours are memoised references.
       */
      const flakeSet = { width: 0, height: 0, color: null as Rgb | null };
      const mistSet = { height: 0, bottom: "", color: "", amount: Number.NaN };

      const rng = createRng(0x5e0f);
      const noise = createNoise(0x5e0f);

      // Positions are in reference units (1 = 1080 device-independent pixels).
      const xs = new Float32Array(MAX_FLAKES);
      const ys = new Float32Array(MAX_FLAKES);
      const layer = new Uint8Array(MAX_FLAKES);
      const sizeJitter = new Float32Array(MAX_FLAKES);
      const paceJitter = new Float32Array(MAX_FLAKES);
      const shade = new Float32Array(MAX_FLAKES);
      const swayRate = new Float32Array(MAX_FLAKES);
      const swayPhase = new Float32Array(MAX_FLAKES);
      const tumbleRate = new Float32Array(MAX_FLAKES);
      const tumblePhase = new Float32Array(MAX_FLAKES);
      const life = new Float32Array(MAX_FLAKES);

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      // Kept unwrapped so sway phases never jump; doubles stay precise for weeks.
      let time = 0;
      let prevCount = 0;

      // Interleave layers by index so any flake count keeps the same proportions.
      const pattern: number[] = [];
      for (let l = 0; l < LAYERS.length; l++) {
        for (let k = 0; k < Math.round(LAYERS[l].share * 50); k++) pattern.push(l);
      }
      for (let i = pattern.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pattern[i], pattern[j]] = [pattern[j], pattern[i]];
      }

      for (let i = 0; i < MAX_FLAKES; i++) {
        layer[i] = pattern[i % pattern.length];
        xs[i] = rng() * refWidth;
        ys[i] = rng() * 1080;
        sizeJitter[i] = 0.7 + rng() * 0.6;
        paceJitter[i] = 0.8 + rng() * 0.4;
        shade[i] = 0.7 + rng() * 0.3;
        swayRate[i] = TAU * (0.12 + rng() * 0.22);
        swayPhase[i] = rng() * TAU;
        tumbleRate[i] = (0.4 + rng() * 0.8) * (rng() < 0.5 ? -1 : 1);
        tumblePhase[i] = rng() * TAU;
      }

      const bindFlakeProgram = (color: Rgb) => {
        gl.useProgram(flakeProgram);
        if (flakeSet.width !== width || flakeSet.height !== height) {
          gl.uniform2f(flakeLoc.uResolution, width, height);
          flakeSet.width = width;
          flakeSet.height = height;
        }
        if (flakeSet.color !== color) {
          gl.uniform3fv(flakeLoc.uColor, color);
          flakeSet.color = color;
        }
      };

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          const k = newRefWidth / refWidth;
          for (let i = 0; i < MAX_FLAKES; i++) xs[i] *= k;
          ({ width, height, scale } = v);
          refWidth = newRefWidth;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;

          const n = Math.min(p.count, MAX_FLAKES);
          for (let i = prevCount; i < n; i++) life[i] = 0;
          prevCount = n;
          const fadeStep = dt / FADE_IN;

          // One slow, smooth gust signal shared by the whole scene.
          const gust = noise.noise2(time * 0.07, 0.5) * 0.7 + noise.noise2(time * 0.19, 9.3) * 0.3;
          const gustPx = gust * p.gustiness * WIND_PX * 1.4;
          const windPx = p.wind * WIND_PX;
          const fallPx = p.speed * FALL_PX;
          const swayPx = p.sway * SWAY_PX;

          const data = batch.data;
          const stride = batch.stride;
          let visible = 0;
          /** First instance of the near layer, which is drawn in front of the mist. */
          let nearStart = 0;
          for (let l = 0; l < LAYERS.length; l++) {
            if (l === 2) nearStart = visible;
            const L = LAYERS[l];
            const softness = layerSoftness(l, p.depthBlur);
            const pad = spritePad(softness);
            const baseRadius = p.size * L.size;
            const amp = swayPx * (0.5 + L.size * 0.4);
            // Wrap once fully off-screen (including sway), so the jump is never visible.
            const margin = (baseRadius * pad + amp) * 1.3;
            const spanX = refWidth + margin * 2;
            const spanY = 1080 + margin * 2;
            const vxLayer = windPx * L.wind;
            const alphaLayer = L.alpha * p.brightness;

            for (let i = 0; i < n; i++) {
              if (layer[i] !== l) continue;

              // A little local variation so the flakes don't move as one sheet.
              const local = noise.noise2(xs[i] * 0.0007 + time * 0.05, ys[i] * 0.0009);
              const vx = vxLayer + gustPx * L.gust * (1 + local * 0.4);
              const vy = fallPx * L.pace * paceJitter[i];
              let x = xs[i] + vx * dt;
              let y = ys[i] + vy * dt;
              if (x < -margin) x += spanX;
              else if (x > refWidth + margin) x -= spanX;
              if (y > 1080 + margin) {
                y -= spanY;
                x = -margin + rng() * spanX;
              } else if (y < -margin) y += spanY;
              xs[i] = x;
              ys[i] = y;

              const life01 = Math.min(1, life[i] + fadeStep);
              life[i] = life01;

              // Tumbling: the flake turns edge-on now and then, narrowing and dimming.
              const tumble = Math.cos(time * tumbleRate[i] + tumblePhase[i]);
              const turn = 0.8 + 0.2 * Math.abs(tumble);
              const alpha = alphaLayer * shade[i] * (0.85 + 0.15 * turn) * life01 * life01;
              if (alpha <= 0.003) continue;

              const sx = x + Math.sin(time * swayRate[i] + swayPhase[i]) * amp * sizeJitter[i];
              const half = baseRadius * sizeJitter[i] * pad * scale;
              const o = visible * stride;
              data[o] = sx * scale;
              data[o + 1] = y * scale;
              data[o + 2] = half * turn;
              data[o + 3] = half;
              data[o + 4] = Math.min(1, alpha);
              data[o + 5] = softness;
              visible++;
            }
          }

          background.draw(bgTop(p.backgroundTop), bgBottom(p.backgroundBottom));

          // Source-over with premultiplied output.
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          batch.upload(visible);
          const color = flakeColor(p.color);

          // Far and mid layers, then the mist, then the near layer in front of it.
          if (nearStart > 0) {
            bindFlakeProgram(color);
            batch.draw(0, nearStart);
          }
          if (p.mist > 0) {
            gl.useProgram(mistProgram);
            if (mistSet.height !== height) {
              gl.uniform1f(mistLoc.uHeight, height);
              mistSet.height = height;
            }
            if (mistSet.bottom !== p.backgroundBottom || mistSet.color !== p.color) {
              // Mist is a lighter, slightly snow-tinted horizon colour.
              const mist = mixRgb(hexToRgb(p.backgroundBottom), hexToRgb(p.color), 0.45);
              gl.uniform3f(
                mistLoc.uMist,
                (mist[0] | 0) / 255,
                (mist[1] | 0) / 255,
                (mist[2] | 0) / 255,
              );
              mistSet.bottom = p.backgroundBottom;
              mistSet.color = p.color;
            }
            const amount = Math.min(1, p.mist);
            if (mistSet.amount !== amount) {
              gl.uniform1f(mistLoc.uAmount, amount);
              mistSet.amount = amount;
            }
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(0, 0, width, Math.ceil(height * 0.4) + 1);
            triangle.draw();
            gl.disable(gl.SCISSOR_TEST);
          }
          if (visible > nearStart) {
            bindFlakeProgram(color);
            batch.draw(nearStart, visible - nearStart);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
