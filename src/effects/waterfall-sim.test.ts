import { describe, expect, it } from "vitest";
import { createNoise } from "./noise";
import {
  buildStreakTexture,
  createFallLayout,
  createSpray,
  EDGE_WOBBLE,
  FALL_LENGTH,
  FALL_V0,
  fallEdges,
  fallLayout,
  fallSpeed,
  MAX_SPRAY,
  packPalette,
  PALETTE_KEYS,
  PALETTES,
  POOL_Y,
  scrollPhase,
  sprayAlpha,
  SPRAY_SINK,
  sprayCount,
  stepSpray,
  STREAK_H,
  STREAK_RATES,
  STREAK_W,
  streakSample,
  travelTime,
  wobblePhases,
} from "./waterfall-sim";

const ASPECTS = [4 / 3, 16 / 9, 21 / 9];

describe("speed profile", () => {
  it("starts at v0 and rises monotonically down the fall", () => {
    expect(fallSpeed(0)).toBe(FALL_V0);
    expect(travelTime(0)).toBe(0);
    let bad = 0;
    let v = fallSpeed(0);
    let t = travelTime(0);
    for (let s = 1; s <= FALL_LENGTH; s++) {
      const v2 = fallSpeed(s);
      const t2 = travelTime(s);
      if (!(v2 > v) || !(t2 > t)) bad++;
      v = v2;
      t = t2;
    }
    expect(bad).toBe(0);
  });

  it("travel time is the integral of 1 / speed", () => {
    let sum = 0;
    const h = 0.25;
    for (let s = 0; s < FALL_LENGTH; s += h) sum += h / fallSpeed(s + h / 2);
    expect(sum).toBeCloseTo(travelTime(FALL_LENGTH), 4);
  });
});

describe("streak texture", () => {
  it("tiles without a seam on both axes", () => {
    let worst = 0;
    for (const c of [0, 1] as const) {
      const noise = createNoise(c + 5);
      for (let k = 0; k <= 40; k++) {
        const a = k / 40;
        worst = Math.max(
          worst,
          Math.abs(streakSample(noise, c, 0, a) - streakSample(noise, c, 1, a)),
          Math.abs(streakSample(noise, c, a, 0) - streakSample(noise, c, a, 1)),
          Math.abs(streakSample(noise, c, a, 0.3) - streakSample(noise, c, a + 1, 2.3)),
        );
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("wraps from the last texel to the first as smoothly as between neighbours", () => {
    const data = buildStreakTexture();
    expect(data.length).toBe(STREAK_W * STREAK_H * 2);
    const at = (x: number, y: number, c: number) => data[(y * STREAK_W + x) * 2 + c];
    for (const c of [0, 1]) {
      let inner = 0;
      let seam = 0;
      for (let x = 0; x < STREAK_W; x++) {
        for (let y = 1; y < STREAK_H; y++)
          inner = Math.max(inner, Math.abs(at(x, y, c) - at(x, y - 1, c)));
        seam = Math.max(seam, Math.abs(at(x, 0, c) - at(x, STREAK_H - 1, c)));
      }
      let innerX = 0;
      let seamX = 0;
      for (let y = 0; y < STREAK_H; y++) {
        for (let x = 1; x < STREAK_W; x++)
          innerX = Math.max(innerX, Math.abs(at(x, y, c) - at(x - 1, y, c)));
        seamX = Math.max(seamX, Math.abs(at(0, y, c) - at(STREAK_W - 1, y, c)));
      }
      expect(seam).toBeLessThanOrEqual(inner);
      expect(seamX).toBeLessThanOrEqual(innerX);
    }
  });

  it("is longer along the fall than across it", () => {
    const data = buildStreakTexture();
    // Mean absolute step between neighbours, per texel, across vs along.
    let across = 0;
    let along = 0;
    for (let y = 1; y < STREAK_H; y++) {
      for (let x = 1; x < STREAK_W; x++) {
        const v = data[(y * STREAK_W + x) * 2];
        across += Math.abs(v - data[(y * STREAK_W + x - 1) * 2]);
        along += Math.abs(v - data[((y - 1) * STREAK_W + x) * 2]);
      }
    }
    expect(across).toBeGreaterThan(along * 2);
  });

  it("scroll phases stay in [0, 1) and match the unwrapped scroll modulo one tile", () => {
    let bad = 0;
    for (let t = 0; t < 1e6; t += 977.31) {
      for (const rate of STREAK_RATES) {
        const ph = scrollPhase(t, rate);
        const d = t * rate - ph;
        if (ph < 0 || ph >= 1 || Math.abs(d - Math.round(d)) > 1e-6) bad++;
      }
    }
    expect(bad).toBe(0);
  });
});

describe("layout", () => {
  it("keeps the whole band in the outer third at 4:3, 16:9 and 21:9", () => {
    const layout = createFallLayout();
    const edges = new Float64Array(2);
    const phases = new Float64Array(4);
    let bad = 0;
    for (const aspect of ASPECTS) {
      const w = 1080 * aspect;
      for (const flow of [0, 0.5, 1]) {
        fallLayout(layout, w, flow);
        if (layout.minX < 0 || layout.maxX > w / 3) bad++;
        for (let t = 0; t < 60; t += 1.7) {
          wobblePhases(phases, t);
          for (let s = 0; s <= FALL_LENGTH; s += 5) {
            fallEdges(edges, layout, s, phases);
            if (edges[0] < layout.minX || edges[1] > layout.maxX || edges[1] - edges[0] < 10) bad++;
          }
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("widens with flow and down the fall", () => {
    const a = fallLayout(createFallLayout(), 1920, 0.2);
    const b = fallLayout(createFallLayout(), 1920, 0.9);
    expect(b.halfTop).toBeGreaterThan(a.halfTop);
    expect(a.halfBottom).toBeGreaterThan(a.halfTop);
    expect(a.cx).toBe(b.cx);
  });

  it("wobble phases are wrapped and the edges move at most EDGE_WOBBLE", () => {
    const layout = fallLayout(createFallLayout(), 1920, 0.5);
    const phases = new Float64Array(4);
    const edges = new Float64Array(2);
    let bad = 0;
    for (let t = 0; t < 1e5; t += 313.7) {
      wobblePhases(phases, t);
      for (const ph of phases) if (ph < 0 || ph >= 2 * Math.PI + 1e-9) bad++;
      fallEdges(edges, layout, FALL_LENGTH, phases);
      if (Math.abs(edges[0] - (layout.cx - layout.halfBottom)) > EDGE_WOBBLE + 1e-9) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe("spray", () => {
  it("is deterministic per seed", () => {
    const layout = fallLayout(createFallLayout(), 1920, 0.6);
    const a = createSpray(4, layout);
    const b = createSpray(4, layout);
    const c = createSpray(5, layout);
    for (let i = 0; i < 30; i++) {
      stepSpray(a, 1 / 60, layout, sprayCount(0.6));
      stepSpray(b, 1 / 60, layout, sprayCount(0.6));
      stepSpray(c, 1 / 60, layout, sprayCount(0.6));
    }
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.y)).toEqual(Array.from(b.y));
    expect(Array.from(a.x)).not.toEqual(Array.from(c.x));
  });

  it("stays near the foot of the fall, on its side, at every aspect", () => {
    let bad = 0;
    for (const aspect of ASPECTS) {
      const w = 1080 * aspect;
      const layout = fallLayout(createFallLayout(), w, 1);
      const s = createSpray(1, layout);
      for (let i = 0; i < 600; i++) {
        stepSpray(s, 1 / 30, layout, sprayCount(1));
        for (let k = 0; k < MAX_SPRAY; k++) {
          if (s.age[k] >= s.life[k]) continue;
          const x = s.x[k];
          const y = s.y[k];
          if (
            !Number.isFinite(x) ||
            x < 0 ||
            x > w / 3 ||
            y < POOL_Y - 260 ||
            y > POOL_Y + SPRAY_SINK + 10
          )
            bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("keeps only the particles below the flow's count alive", () => {
    const layout = fallLayout(createFallLayout(), 1920, 0);
    const s = createSpray(2, layout);
    const count = sprayCount(0);
    for (let i = 0; i < 200; i++) stepSpray(s, 0.05, layout, count);
    let alive = 0;
    for (let k = 0; k < MAX_SPRAY; k++) if (s.age[k] < s.life[k]) alive++;
    expect(alive).toBeLessThanOrEqual(count);
    expect(alive).toBeGreaterThan(count * 0.9);
    expect(sprayCount(1)).toBe(MAX_SPRAY);
  });

  it("fades in and out", () => {
    expect(sprayAlpha(0)).toBe(0);
    expect(sprayAlpha(1)).toBe(0);
    expect(sprayAlpha(0.15)).toBeGreaterThan(sprayAlpha(0.03));
    expect(sprayAlpha(0.5)).toBeGreaterThan(sprayAlpha(0.9));
  });
});

describe("palettes", () => {
  it("packs every colour in key order", () => {
    for (const p of Object.values(PALETTES)) {
      const packed = packPalette(p);
      expect(packed.length).toBe(PALETTE_KEYS.length * 3);
      expect(packed[7 * 3]).toBeCloseTo(p.water[0], 6);
      expect(packed.every((v) => v >= 0 && v <= 1)).toBe(true);
    }
  });
});
