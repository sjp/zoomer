import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeOffscreenCanvas } from "../test/offscreen-canvas";
import {
  breath,
  BREATH_A,
  buildNeonTubes,
  centrelineDistance,
  drawClip,
  FIELD_TEXEL,
  fieldGrid,
  glowField,
  glowGrid,
  GLOW_MARGIN,
  GLOW_TEXEL,
  placeClips,
  RIPPLE_A1,
  RIPPLE_A2,
  SHIMMER_PERIOD,
  shimmerAt,
  squaredDistance,
  tubeRadius,
  WARM_UP,
  warmUp,
} from "./neon-tubes";

describe("squaredDistance", () => {
  it("matches brute force on a random mask", () => {
    const w = 23;
    const h = 17;
    const mask = new Uint8Array(w * h);
    let s = 12345;
    for (let i = 0; i < mask.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      mask[i] = s % 11 === 0 ? 1 : 0;
    }
    const got = squaredDistance(mask, w, h, 1);
    let bad = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let j = 0; j < w * h; j++) {
          if (mask[j] !== 1) {
            continue;
          }
          const dx = (j % w) - x;
          const dy = Math.floor(j / w) - y;
          best = Math.min(best, dx * dx + dy * dy);
        }
        if (got[y * w + x] !== best) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("is infinite everywhere without a target", () => {
    expect([...squaredDistance(new Uint8Array(6), 3, 2, 1)].every((d) => d === Infinity)).toBe(
      true,
    );
  });
});

describe("centrelineDistance", () => {
  /** A horizontal band 6 texels tall across a 40 x 30 grid. */
  const band = () => {
    const mask = new Uint8Array(40 * 30);
    for (let y = 12; y < 18; y++) {
      mask.fill(1, y * 40, y * 40 + 40);
    }
    return mask;
  };

  it("measures from the stroke's middle and rises steadily away from it", () => {
    const { dist, halfStroke } = centrelineDistance(band(), 40, 30, 1000);
    expect(halfStroke).toBeCloseTo(3 * FIELD_TEXEL, 6);
    const column = Array.from({ length: 30 }, (_, y) => dist[y * 40 + 20]);
    // Smallest at the band's middle rows, then one texel more per row away from it.
    expect(Math.min(...column)).toBeCloseTo(0.5 * FIELD_TEXEL, 6);
    let ok = true;
    for (let y = 15; y < 29; y++) {
      if (Math.abs(column[y + 1] - column[y] - FIELD_TEXEL) > 1e-6) {
        ok = false;
      }
    }
    expect(ok).toBe(true);
  });

  it("clamps to the halo's reach and is flat for empty text", () => {
    const { dist } = centrelineDistance(band(), 40, 30, 6);
    expect(Math.max(...dist)).toBe(6);
    const empty = centrelineDistance(new Uint8Array(40 * 30), 40, 30, 9);
    expect(empty.halfStroke).toBe(0);
    expect([...empty.dist].every((d) => d === 9)).toBe(true);
  });
});

describe("glowField", () => {
  it("is soft, centred on the tubes and black at its edges", () => {
    const layout = { x: 0.6, y: 0.07, w: 0.5, h: 0.17, font: 0.14 };
    const radius = tubeRadius(layout.font);
    const field = fieldGrid(layout, radius);
    const dist = new Float32Array(field.cols * field.rows).fill(1000);
    // One tube along the middle row.
    const mid = Math.floor(field.rows / 2);
    dist.fill(0, mid * field.cols + field.pad, mid * field.cols + field.cols - field.pad);
    const glow = glowGrid(field);
    const g = glowField(dist, field, glow, radius);
    let edge = 0;
    for (let x = 0; x < glow.cols; x++) {
      edge = Math.max(edge, g[x], g[(glow.rows - 1) * glow.cols + x]);
    }
    for (let y = 0; y < glow.rows; y++) {
      edge = Math.max(edge, g[y * glow.cols], g[y * glow.cols + glow.cols - 1]);
    }
    expect(edge).toBe(0);
    const gy = Math.floor((mid * FIELD_TEXEL) / GLOW_TEXEL) + GLOW_MARGIN;
    const cx = Math.floor(glow.cols / 2);
    const centre = g[gy * glow.cols + cx];
    expect(centre).toBeGreaterThan(0);
    expect(g[(gy + 8) * glow.cols + cx]).toBeLessThan(centre);
    expect(Math.min(...g)).toBeGreaterThanOrEqual(0);
  });
});

describe("clips", () => {
  it("sit on the tubes, spread along the line", () => {
    const cols = 400;
    const rows = 40;
    const dist = new Float32Array(cols * rows).fill(100);
    for (let x = 30; x < 370; x++) {
      dist[20 * cols + x] = 0;
    }
    const clips = placeClips(dist, cols, 0, rows, 18, 5, 5);
    expect(clips.length).toBeGreaterThanOrEqual(2);
    expect(clips.every(([x, y]) => dist[y * cols + x] === 0)).toBe(true);
    expect(clips[0][0]).toBeLessThan(150);
    expect(clips[clips.length - 1][0]).toBeGreaterThan(250);
    expect(placeClips(new Float32Array(cols * rows).fill(100), cols, 0, rows, 18, 5, 5)).toEqual(
      [],
    );
  });

  it("draws an antialiased clip with a top-to-bottom shade", () => {
    const cols = 30;
    const rows = 30;
    const cover = new Float32Array(cols * rows);
    const shade = new Float32Array(cols * rows);
    drawClip(cover, shade, cols, rows, 15, 15, 6);
    expect(cover[15 * cols + 15]).toBe(1);
    expect(cover[0]).toBe(0);
    expect(shade[11 * cols + 15]).toBeLessThan(shade[19 * cols + 15]);
    expect(Math.max(...cover)).toBeLessThanOrEqual(1);
  });
});

describe("shimmer", () => {
  it("stays within 10% and changes slowly", () => {
    expect(RIPPLE_A1 + RIPPLE_A2 + BREATH_A).toBeLessThan(0.1);
    let worst = 0;
    let fastest = 0;
    const dt = 1 / 30;
    for (let x = 0; x < 2000; x += 97) {
      let prev = shimmerAt(x, 0, 1);
      for (let t = dt; t < SHIMMER_PERIOD; t += dt) {
        const s = shimmerAt(x, t, 1);
        worst = Math.max(worst, Math.abs(s - 1));
        fastest = Math.max(fastest, Math.abs(s - prev) / dt);
        prev = s;
      }
    }
    expect(worst).toBeLessThan(0.1);
    // Under 0.07 per second: no visible flicker.
    expect(fastest).toBeLessThan(0.07);
  });

  it("repeats seamlessly over its period, and is off at 0", () => {
    let gap = 0;
    for (let x = 0; x < 1000; x += 50) {
      for (let t = 0; t < 10; t += 0.7) {
        gap = Math.max(gap, Math.abs(shimmerAt(x, t, 1) - shimmerAt(x, t + SHIMMER_PERIOD, 1)));
      }
    }
    expect(gap).toBeLessThan(1e-9);
    expect(shimmerAt(123, 45, 0)).toBe(1);
    expect(breath(77, 0)).toBe(1);
  });
});

describe("warmUp", () => {
  it("rises smoothly and monotonically from 0 to 1", () => {
    let monotonic = true;
    let steepest = 0;
    let prev = warmUp(0);
    for (let t = 0.01; t <= WARM_UP + 1; t += 0.01) {
      const v = warmUp(t);
      if (v < prev) {
        monotonic = false;
      }
      steepest = Math.max(steepest, (v - prev) / 0.01);
      prev = v;
    }
    expect(warmUp(0)).toBe(0);
    expect(warmUp(WARM_UP)).toBe(1);
    expect(monotonic).toBe(true);
    expect(steepest).toBeLessThan(0.5);
  });
});

describe("buildNeonTubes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("places the field and glow round the lettering, with the tubes' size", () => {
    const layout = {
      x: 0.2,
      y: 0.1,
      w: 0.6,
      h: 0.12,
      font: 0.1,
      pitch: 1.2,
      align: "left" as const,
      anchor: 0.2,
    };
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const tubes = buildNeonTubes([{ text: "Hello", index: 0 }], layout, 4);
    const { field, glow, fieldBox, glowBox } = tubes;
    expect(field.data.length).toBe(field.cols * field.rows * 4);
    expect(glow.data.length).toBe(glow.cols * glow.rows * 2);
    expect(tubes.radius).toBe(tubeRadius(layout.font));
    // The field's box holds the lettering, and the glow's holds the field's.
    expect(fieldBox[0]).toBeLessThan(layout.x * 1080);
    expect(fieldBox[0] + 1 / fieldBox[2]).toBeGreaterThan((layout.x + layout.w) * 1080);
    expect(glowBox[0]).toBeLessThan(fieldBox[0]);
    expect(glowBox[1] + 1 / glowBox[3]).toBeGreaterThan(fieldBox[1] + 1 / fieldBox[3]);
  });
});
