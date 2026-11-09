import { createBubbles, MODES, type BubbleFrame } from "./bubbles-sim";
import { unitRgbMemo } from "../color";
import { type Beam, BEAM_FRAGMENT, BEAM_VERTEX, writeBeamInstance } from "../fireflies/fireflies";
import {
  beginFrame,
  createGradientBackground,
  createUniforms,
  withScope,
  scopedProgram,
} from "../gl";
import { bubbleVertex, BUBBLE_FRAGMENT } from "../bubble-sprites";
import { createSpriteBatch, polygonStrip, QUAD } from "../sprites";
import { bubblesMeta, MAX_BUBBLES } from "./bubbles.meta";
import { defineEffect } from "../types";

const SHAFTS = 3;
/** Base shaft brightness (fraction of the light colour at a shaft's brightest point). */
const SHAFT_STRENGTH = 0.13;
/** Shaft x at the top (fraction of the width), half-width (px at 1080p) and intensity. */
const SHAFT_LAYOUT = [
  [0.12, 85, 1],
  [0.27, 50, 0.7],
  [0.84, 70, 0.85],
] as const;
/** Shafts lean this much (dx per dy) and sway this much either side as the surface moves. */
const SHAFT_SLOPE = 0.2;
const SHAFT_SWAY = 0.04;

/**
 * Bubbles rising through a tinted liquid: an aquarium, a glass of champagne or a
 * cola. A gradient, up to three additive light shafts from the surface and one
 * instanced draw of octagons, shaded analytically.
 */
export const bubbles = defineEffect(bubblesMeta, {
  create(gl) {
    return withScope((scope) => {
      // Per bubble: x, y, semi-major, opacity; softness, extent; then the spin pair.
      const batch = scope.own(
        createSpriteBatch(gl, MAX_BUBBLES, [4, 2], [polygonStrip(8, Math.PI / 8)], {
          rotation: true,
        }),
      );
      const program = scopedProgram(gl, scope, bubbleVertex(batch.spinLocation), BUBBLE_FRAGMENT);
      const u = createUniforms(gl, program, ["uResolution", "uLight", "uShade"]);
      const beamProgram = scopedProgram(gl, scope, BEAM_VERTEX, BEAM_FRAGMENT);
      const beamU = createUniforms(gl, beamProgram, ["uResolution", "uColor"]);
      // Per shaft: x0, slope, half-width; y0, y1, intensity.
      const beamBatch = scope.own(createSpriteBatch(gl, SHAFTS, [3, 3], [QUAD]));
      const background = scope.own(createGradientBackground(gl));
      const topRgb = unitRgbMemo();
      const bottomRgb = unitRgbMemo();
      const lightRgb = unitRgbMemo();
      const shade: [number, number, number] = [0, 0, 0];
      const beams: Beam[] = SHAFT_LAYOUT.map(() => ({
        x0: 0,
        slope: SHAFT_SLOPE,
        halfWidth: 1,
        y0: -20,
        y1: 860,
        intensity: 0,
      }));

      let width = 1;
      let height = 1;
      let refWidth = 1920;
      // CPU-only, unwrapped in float64.
      let time = 0;
      const sim = createBubbles(MAX_BUBBLES, refWidth);
      const f: BubbleFrame = {
        refWidth,
        scale: 1,
        mode: MODES.aquarium,
        count: 0,
        size: 0,
        speed: 0,
        streams: true,
      };

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          sim.rescaleX(newRefWidth / refWidth);
          ({ width, height } = v);
          refWidth = f.refWidth = newRefWidth;
          f.scale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          const mode = MODES[p.mode] ?? MODES.aquarium;
          f.mode = mode;
          f.count = p.count;
          f.size = p.size;
          f.speed = p.speed;
          f.streams = p.streams;
          const visible = sim.step(dt, f, batch.data, batch.stride);

          const top = topRgb(p.customColors ? p.liquidTop : mode.top);
          const bottom = bottomRgb(p.customColors ? p.liquidBottom : mode.bottom);
          const light = lightRgb(mode.light);
          background.draw(top, bottom);

          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          const shaftGain = p.shafts * mode.shafts * SHAFT_STRENGTH;
          if (shaftGain > 0) {
            gl.blendFunc(gl.ONE, gl.ONE);
            const bd = beamBatch.data;
            const bs = beamBatch.stride;
            for (let b = 0; b < SHAFTS; b++) {
              const L = SHAFT_LAYOUT[b];
              const beam = beams[b];
              // The surface moves, so the shafts sway and breathe slowly.
              const sway = SHAFT_SWAY * Math.sin(time * 0.13 + b * 1.7);
              beam.slope = SHAFT_SLOPE + sway;
              beam.x0 = L[0] * refWidth + sway * 300;
              beam.halfWidth = L[1];
              beam.intensity = L[2];
              const breathe = 0.8 + 0.2 * Math.sin(time * 0.29 + b * 2.3);
              writeBeamInstance(bd, b * bs, beam, f.scale, shaftGain * breathe);
            }
            beamBatch.upload(SHAFTS);
            gl.useProgram(beamProgram);
            beamU.f2("uResolution", width, height);
            beamU.v3("uColor", light);
            beamBatch.draw(0, SHAFTS);
          }

          if (visible > 0) {
            // Source-over with premultiplied output: the body darkens what is behind,
            // where alpha > 0, and the rim and highlights add light (rgb beyond rgb * a),
            // all in one draw and one program.
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            batch.upload(visible);
            gl.useProgram(program);
            shade[0] = bottom[0] * 0.3;
            shade[1] = bottom[1] * 0.3;
            shade[2] = bottom[2] * 0.3;
            u.f2("uResolution", width, height);
            u.v3("uLight", light);
            u.v3("uShade", shade);
            batch.draw(0, visible);
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
