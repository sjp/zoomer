import type { Rgb } from "../color";
import { beginFrame, withScope } from "../gl";
import { createStreakRenderer } from "../streaks";
import { warpMeta, MAX_STARS } from "./warp.meta";
import { defineEffect } from "../types";
import { unitRgbMemo } from "../color";
import { createStarfield, type StarFrame } from "./warp-sim";

/**
 * Classic 3D starfield: stars stream past the camera and stretch into streaks.
 * Simulated on the CPU; drawn in WebGL2 as instanced, additively blended capsules.
 */
export const warp = defineEffect(warpMeta, {
  create(gl) {
    return withScope((scope) => {
      const streaks = scope.own(createStreakRenderer(gl, MAX_STARS, { chromatic: true }));
      const starRgb = unitRgbMemo();
      const tintRgb = unitRgbMemo();
      const backgroundRgb = unitRgbMemo();
      const zoom: Rgb = [1, 1, 1];
      const stars = createStarfield(MAX_STARS);
      const f: StarFrame = {
        width: 1,
        height: 1,
        scale: 1,
        speed: 0,
        count: 0,
        streak: 0,
        size: 0,
        tintAmount: 0,
        star: [1, 1, 1],
        tint: [1, 1, 1],
      };
      let width = 1;
      let height = 1;

      return {
        resize(v) {
          ({ width, height } = v);
          f.width = v.width;
          f.height = v.height;
          f.scale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          f.speed = p.speed;
          f.count = p.count;
          f.streak = p.streak;
          f.size = p.size;
          f.tintAmount = p.tintAmount;
          f.star = starRgb(p.starColor);
          f.tint = tintRgb(p.tint);
          const count = stars.step(dt, f, streaks.data);

          const bg = backgroundRgb(p.background);
          gl.clearColor(bg[0], bg[1], bg[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);

          // Additive blending. Lens-style aberration: each colour channel is scaled
          // about the centre by a slightly different amount (all three in one draw),
          // so channels recombine to the original colour where they overlap and leave
          // coloured fringes that grow towards the edges of the frame where they don't.
          streaks.upload(count);
          const ab = p.aberration * 0.03;
          zoom[0] = 1 + ab;
          zoom[2] = 1 - ab;
          streaks.draw(count, width, height, zoom);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
