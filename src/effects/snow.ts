import { hexToRgb, mixRgb, type Rgb, unitRgbMemo } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createGradientBackground,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { createSpriteBatch } from "./sprites";
import { snowMeta, MAX_FLAKES } from "./snow.meta";
import { defineEffect } from "./types";
import { createFlakes, type FlakeFrame, PAD_MARGIN } from "./snow-sim";

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
${TO_CLIP_GLSL}
void main() {
  // Grow the quad by a pixel so the anti-aliased edge of tiny flakes is never clipped.
  vec2 ext = aRect.zw + 1.0;
  vec2 px = aRect.xy + aCorner * ext;
  // spritePad(softness), as in TS.
  float pad = 1.0 + aLook.y + ${glslFloat(PAD_MARGIN)};
  vLocal = aCorner * pad * ext / aRect.zw;
  vAlpha = aLook.x;
  vSoftness = aLook.y;
  gl_Position = pxToClip(px, uResolution);
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
${DITHER_GLSL}
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
  outColor = vec4(uMist * a + a * dither8(gl_FragCoord.xy), a);
}
`;

/**
 * Gentle night snowfall in three depth layers: small, dim, slow flakes far
 * away and large, soft, faster flakes up close, all swaying in a gusty breeze.
 */
export const snow = defineEffect(snowMeta, {
  create(gl) {
    return withScope((scope) => {
      const flakeProgram = scope.add(createProgram(gl, FLAKE_VERTEX, FLAKE_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const flakeU = createUniforms(gl, flakeProgram, ["uResolution", "uColor"]);
      const mistProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, MIST_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const mistU = createUniforms(gl, mistProgram, ["uHeight", "uMist", "uAmount"]);
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
      /** Mist colour inputs last derived from. */
      const mistSet = { bottom: "", color: "" };

      let width = 1;
      let height = 1;
      let refWidth = 1920;
      const flakes = createFlakes(MAX_FLAKES, refWidth);
      const f: FlakeFrame = {
        refWidth,
        scale: 1,
        count: 0,
        speed: 0,
        wind: 0,
        gustiness: 0,
        sway: 0,
        size: 0,
        depthBlur: 0,
        brightness: 0,
      };

      const bindFlakeProgram = (color: Rgb) => {
        gl.useProgram(flakeProgram);
        flakeU.f2("uResolution", width, height);
        flakeU.v3("uColor", color);
      };

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          flakes.rescaleX(newRefWidth / refWidth);
          ({ width, height } = v);
          refWidth = f.refWidth = newRefWidth;
          f.scale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          f.count = p.count;
          f.speed = p.speed;
          f.wind = p.wind;
          f.gustiness = p.gustiness;
          f.sway = p.sway;
          f.size = p.size;
          f.depthBlur = p.depthBlur;
          f.brightness = p.brightness;
          const visible = flakes.step(dt, f, batch.data, batch.stride);
          const nearStart = flakes.nearStart;

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
            mistU.f1("uHeight", height);
            if (mistSet.bottom !== p.backgroundBottom || mistSet.color !== p.color) {
              // Mist is a lighter, slightly snow-tinted horizon colour.
              const mist = mixRgb(hexToRgb(p.backgroundBottom), hexToRgb(p.color), 0.45);
              mistU.f3("uMist", (mist[0] | 0) / 255, (mist[1] | 0) / 255, (mist[2] | 0) / 255);
              mistSet.bottom = p.backgroundBottom;
              mistSet.color = p.color;
            }
            mistU.f1("uAmount", Math.min(1, p.mist));
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
