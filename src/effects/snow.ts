import { hexToRgb, mixRgb, unitRgbMemo } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createGradientBackground,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  withScope,
} from "./gl";
import { snowMeta, MAX_FLAKES } from "./snow.meta";
import { defineEffect } from "./types";
import { createFlakes, type FlakeFrame } from "./snow-sim";
import { createFlakeRenderer } from "./snowflakes";

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
      const flakeRenderer = scope.own(createFlakeRenderer(gl, MAX_FLAKES));
      const mistProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, MIST_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const mistU = createUniforms(gl, mistProgram, ["uHeight", "uMist", "uAmount"]);
      const triangle = scope.own(createFullscreenTriangle(gl));
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
          const visible = flakes.step(dt, f, flakeRenderer.data, flakeRenderer.stride);
          const nearStart = flakes.nearStart;

          background.draw(bgTop(p.backgroundTop), bgBottom(p.backgroundBottom));

          // Source-over with premultiplied output.
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          flakeRenderer.upload(visible);
          const color = flakeColor(p.color);

          // Far and mid layers, then the mist, then the near layer in front of it.
          if (nearStart > 0) {
            flakeRenderer.draw(0, nearStart, width, height, color);
          }
          if (p.mist > 0) {
            gl.useProgram(mistProgram);
            mistU.f1("uHeight", height);
            if (mistSet.bottom !== p.backgroundBottom || mistSet.color !== p.color) {
              // Mist is a lighter, slightly snow-tinted horizon colour.
              const mist = mixRgb(hexToRgb(p.backgroundBottom), hexToRgb(p.color), 0.45);
              // Channels are finite 0..255, so truncating matches the old `| 0`.
              mistU.f3(
                "uMist",
                Math.trunc(mist[0]) / 255,
                Math.trunc(mist[1]) / 255,
                Math.trunc(mist[2]) / 255,
              );
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
            flakeRenderer.draw(nearStart, visible - nearStart, width, height, color);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
