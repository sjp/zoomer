import type { Rgb } from "./color";
import { beginFrame } from "./gl";
import { createRgbCache, createStreakRenderer, STREAK_FLOATS } from "./streaks";
import { defineEffect } from "./types";

const MAX_STARS = 4000;

/**
 * Classic 3D starfield: stars stream past the camera and stretch into streaks.
 * Simulated on the CPU; drawn in WebGL2 as instanced, additively blended capsules.
 */
export const warp = defineEffect({
  id: "warp",
  name: "Warp Speed",
  description: "A starfield where stars stretch into streaks at faster-than-light speed.",
  context: "webgl2",
  params: {
    speed: { kind: "number", label: "Speed", min: 0, max: 10, step: 0.1, default: 3 },
    count: { kind: "number", label: "Stars", min: 100, max: MAX_STARS, step: 100, default: 1200 },
    streak: { kind: "number", label: "Streak length", min: 0, max: 1, step: 0.01, default: 0.35 },
    size: { kind: "number", label: "Star size", min: 0.5, max: 6, step: 0.1, default: 2 },
    starColor: { kind: "color", label: "Star colour", default: "#ffffff" },
    tint: { kind: "color", label: "Tint colour", default: "#8fb8ff" },
    tintAmount: {
      kind: "number",
      label: "Tint variation",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    aberration: {
      kind: "number",
      label: "Chromatic aberration",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.25,
    },
    background: { kind: "color", label: "Background", default: "#000008" },
  },
  create(gl) {
    const streaks = createStreakRenderer(gl, MAX_STARS, { chromatic: true });
    const starRgb = createRgbCache();
    const tintRgb = createRgbCache();
    const backgroundRgb = createRgbCache();
    const zoom: Rgb = [1, 1, 1];
    const data = streaks.data;
    const xs = new Float32Array(MAX_STARS);
    const ys = new Float32Array(MAX_STARS);
    const zs = new Float32Array(MAX_STARS);
    const mix = new Float32Array(MAX_STARS);
    let width = 1;
    let height = 1;
    let scale = 1;

    const spawn = (i: number, z: number) => {
      xs[i] = Math.random() * 2 - 1;
      ys[i] = Math.random() * 2 - 1;
      zs[i] = z;
      mix[i] = Math.random();
    };
    for (let i = 0; i < MAX_STARS; i++) spawn(i, Math.random());

    return {
      resize(v) {
        ({ width, height, scale } = v);
      },
      frame(dt, p) {
        beginFrame(gl, width, height);
        const cx = width / 2;
        const cy = height / 2;
        const focal = Math.max(width, height) / 2;
        const dz = p.speed * dt * 0.25;
        const tail = p.streak * p.speed * 0.03;
        const [sr, sg, sb] = starRgb(p.starColor);
        const [tr, tg, tb] = tintRgb(p.tint);
        const margin = 50 * scale;
        const sizePx = p.size * scale;

        const n = Math.min(p.count, MAX_STARS);
        let count = 0;
        for (let i = 0; i < n; i++) {
          let z = zs[i] - dz;
          if (z <= 0.01) {
            spawn(i, 1);
            z = 1;
          }
          zs[i] = z;

          const x = xs[i];
          const y = ys[i];
          const fz = focal / z;
          const hx = cx + x * fz;
          const hy = cy + y * fz;
          if (hx < -margin || hx > width + margin || hy < -margin || hy > height + margin) {
            spawn(i, 1);
            continue;
          }
          const fzt = focal / (z + tail);
          const depth = 1 - z;
          const alpha = Math.min(1, depth * 1.6);
          const t = mix[i] * p.tintAmount;
          const o = count * STREAK_FLOATS;
          data[o] = cx + x * fzt;
          data[o + 1] = cy + y * fzt;
          data[o + 2] = hx;
          data[o + 3] = hy;
          data[o + 4] = (sr + (tr - sr) * t) * alpha;
          data[o + 5] = (sg + (tg - sg) * t) * alpha;
          data[o + 6] = (sb + (tb - sb) * t) * alpha;
          data[o + 7] = Math.max(0.5, sizePx * (0.2 + depth)) / 2;
          count++;
        }

        const [br, bg, bb] = backgroundRgb(p.background);
        gl.clearColor(br, bg, bb, 1);
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
      dispose() {
        streaks.dispose();
      },
    };
  },
});
