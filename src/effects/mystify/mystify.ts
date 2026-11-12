import { beginFrame, withScope } from "../gl";
import { createStreakRenderer } from "../streaks";
import { defineEffect } from "../types";
import { createMystify, MAX_STREAKS } from "./mystify-sim";
import { mystifyMeta } from "./mystify.meta";

/**
 * The Mystify screensaver: polygons whose corners bounce around a black screen,
 * each trailed by discrete echo outlines. Simulated on the CPU (`mystify-sim.ts`)
 * and drawn as one instanced draw of capsules. The capsules blend by per-channel
 * maximum, so corners where two edges meet and crossing lines don't brighten,
 * as with the original's solid lines, and Modern's glow under each line doesn't
 * stack where lines overlap.
 */
export const mystify = defineEffect(mystifyMeta, {
  create(gl) {
    return withScope((scope) => {
      const streaks = scope.own(createStreakRenderer(gl, MAX_STREAKS, { blend: "max" }));
      const sim = createMystify();
      let width = 1;
      let height = 1;
      let scale = 1;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          sim.step(dt, p, width / Math.max(1, height));
          const count = sim.write(streaks.data, width, height, scale);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          streaks.upload(count);
          streaks.draw(count, width, height);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
