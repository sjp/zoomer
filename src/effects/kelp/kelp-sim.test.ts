import { describe, expect, it } from "vitest";
import {
  buildBladeProfiles,
  buildFronds,
  centreMask,
  createFish,
  createSnow,
  DENSITY_MAX,
  edgeWeight,
  FIRST_SCHOOL,
  FISH_FLOATS,
  FISH_LENGTH,
  FISH_PER_SCHOOL,
  fishInstances,
  FROND_FLOATS,
  FROND_STRIP,
  frondSway,
  KELP_SWELL,
  layerCount,
  LAYERS,
  MAX_FRONDS,
  MAX_SHAFTS,
  PALETTES,
  PROFILE_COLUMNS,
  PROFILE_ROWS,
  SCHOOL_INTERVAL_MAX,
  SCHOOL_INTERVAL_MIN,
  SEGMENTS,
  shaftUniforms,
  SNOW_COUNT,
  SNOW_FLOATS,
  snowInstances,
  STIPE,
  stepFish,
  stepSnow,
  SWAY_MAX,
  X_MARGIN,
} from "./kelp-sim";
import { advanceSwell } from "../sway";
import { firstDifference } from "../../test/bytes";

const layout = (seed: number, density: number) => {
  const data = new Float32Array(MAX_FRONDS * FROND_FLOATS);
  return { data, layout: buildFronds(seed, density, data) };
};

describe("buildFronds", () => {
  it("is deterministic per seed", () => {
    const a = layout(7, 1);
    const b = layout(7, 1);
    const c = layout(8, 1);
    expect(a.layout).toEqual(b.layout);
    expect(a.data).toEqual(b.data);
    expect(a.data).not.toEqual(c.data);
  });

  it("orders layers far to near and fits the batch at maximum density", () => {
    const { layout: l } = layout(3, DENSITY_MAX);
    expect(l.total).toBeLessThanOrEqual(MAX_FRONDS);
    expect(l.counts).toHaveLength(LAYERS.length);
    expect(l.starts[0]).toBe(0);
    for (let i = 0; i < LAYERS.length; i++) {
      expect(l.counts[i]).toBe(layerCount(LAYERS[i], DENSITY_MAX));
    }
    for (let i = 1; i < LAYERS.length; i++) {
      expect(l.starts[i]).toBe(l.starts[i - 1] + l.counts[i - 1]);
    }
  });

  it("keeps each layer's fronds as the first of its fronds at a higher density", () => {
    for (const seed of [0, 7, 42]) {
      const high = layout(seed, DENSITY_MAX);
      for (const density of [0.3, 1, 1.05, 2]) {
        const low = layout(seed, density);
        for (let l = 0; l < LAYERS.length; l++) {
          // The layer's first counts[l] fronds, as one run of floats.
          const run = (x: typeof low) =>
            x.data.subarray(
              x.layout.starts[l] * FROND_FLOATS,
              (x.layout.starts[l] + low.layout.counts[l]) * FROND_FLOATS,
            );
          const at = firstDifference(run(low), run(high));
          const frond = at === -1 ? -1 : Math.floor(at / FROND_FLOATS);
          expect(
            frond,
            `seed ${String(seed)}, density ${String(density)}, layer ${String(l)}`,
          ).toBe(-1);
        }
      }
    }
  });

  it("scales with density and never drops a layer", () => {
    expect(layout(1, 2).layout.total).toBeGreaterThan(layout(1, 1).layout.total);
    for (const c of layout(1, 0).layout.counts) {
      expect(c).toBeGreaterThanOrEqual(1);
    }
    expect(layout(1, Number.NaN).layout.total).toBe(layout(1, 1).layout.total);
  });

  it("keeps fronds inside the frame with sane traits", () => {
    for (const seed of [0, 1, 42, 999]) {
      const { data, layout: l } = layout(seed, 1.5);
      for (let li = 0; li < LAYERS.length; li++) {
        const layer = LAYERS[li];
        for (let k = 0; k < l.counts[li]; k++) {
          const o = (l.starts[li] + k) * FROND_FLOATS;
          expect(data[o]).toBeGreaterThanOrEqual(X_MARGIN);
          expect(data[o]).toBeLessThanOrEqual(1 - X_MARGIN);
          expect(data[o + 1]).toBeGreaterThanOrEqual(layer.heightMin);
          expect(data[o + 1]).toBeLessThanOrEqual(layer.heightMax);
          expect(data[o + 2]).toBeGreaterThan(0);
          expect(data[o + 3]).toBeGreaterThan(0);
          expect(data[o + 3]).toBeLessThan(1);
          expect(data[o + 5]).toBeGreaterThan(0);
          // Lean plus full sway keeps the tip within a modest share of the height.
          expect(Math.abs(data[o + 6]) + SWAY_MAX).toBeLessThan(0.25);
        }
      }
    }
  });

  it("leaves the centre third sparse", () => {
    let centre = 0;
    let total = 0;
    for (let seed = 0; seed < 20; seed++) {
      const { data, layout: l } = layout(seed, 2);
      for (let i = 0; i < l.total; i++) {
        const x = data[i * FROND_FLOATS];
        total++;
        if (x > 1 / 3 && x < 2 / 3) {
          centre++;
        }
      }
      // The nearest layer stays out of the middle entirely.
      const near = LAYERS.length - 1;
      for (let k = 0; k < l.counts[near]; k++) {
        const x = data[(l.starts[near] + k) * FROND_FLOATS];
        expect(centreMask(x)).toBeLessThan(1);
      }
    }
    // Uniform placement would put a third there.
    expect(centre / total).toBeLessThan(0.15);
  });
});

describe("edgeWeight", () => {
  it("is highest at the edges and suppressed in the middle", () => {
    expect(edgeWeight(0, 0.2)).toBeCloseTo(1);
    expect(edgeWeight(1, 0.2)).toBeCloseTo(1);
    expect(edgeWeight(0.5, 0.2)).toBeCloseTo(0.6 * 0.2);
    expect(edgeWeight(0.5, 0)).toBe(0);
    expect(centreMask(0.1)).toBe(0);
    expect(centreMask(0.5)).toBe(1);
  });
});

describe("frondSway", () => {
  it("is zero at the base and bounded by the swell", () => {
    let baseMoves: { phase: number; sway: number } | undefined;
    let tooFar: { phase: number; t: number; swell: number; sway: number } | undefined;
    for (let i = 0; i < 300; i++) {
      const phase = i / 300;
      const base = Math.abs(frondSway(phase, 0.2, 3, 0, 1, 1));
      if (!(base === 0) && baseMoves === undefined) {
        baseMoves = { phase, sway: base };
      }
      for (let t = 0; t <= 1; t += 0.05) {
        for (const swell of [0, 0.3, 1]) {
          const sway = Math.abs(frondSway(phase, 0.2, 3, t, swell, 0.8));
          if (!(sway <= swell * SWAY_MAX * 0.8 + 1e-12) && tooFar === undefined) {
            tooFar = { phase, t, swell, sway };
          }
        }
      }
    }
    expect(baseMoves).toBeUndefined();
    expect(tooFar).toBeUndefined();
  });

  it("is continuous in time", () => {
    let phase = 0;
    let prev = frondSway(phase, 0.1, 2.5, 1, 1, 1);
    for (let i = 0; i < 120 * 130; i++) {
      phase = advanceSwell(KELP_SWELL, phase, 1 / 120);
      const next = frondSway(phase, 0.1, 2.5, 1, 1, 1);
      expect(Math.abs(next - prev)).toBeLessThan(0.002);
      prev = next;
    }
  });
});

describe("blade profiles", () => {
  it("are within [STIPE, 1] and have blades on both sides", () => {
    const p = buildBladeProfiles(58);
    expect(p).toHaveLength(PROFILE_COLUMNS * PROFILE_ROWS * 2);
    for (const v of p) {
      expect(v).toBeGreaterThanOrEqual(Math.fround(STIPE));
      expect(v).toBeLessThanOrEqual(1);
    }
    for (let r = 0; r < PROFILE_ROWS; r++) {
      let left = 0;
      let right = 0;
      for (let c = 0; c < PROFILE_COLUMNS; c++) {
        const o = (r * PROFILE_COLUMNS + c) * 2;
        left = Math.max(left, p[o]);
        right = Math.max(right, p[o + 1]);
      }
      expect(left).toBeGreaterThan(0.4);
      expect(right).toBeGreaterThan(0.4);
    }
    expect(buildBladeProfiles(58)).toEqual(p);
  });

  it("has a strip of SEGMENTS + 1 vertex pairs", () => {
    expect(FROND_STRIP).toHaveLength((SEGMENTS + 1) * 4);
  });
});

describe("shafts", () => {
  it("stay inside the frame and wrap seamlessly", () => {
    const a = new Float32Array(MAX_SHAFTS * 4);
    const b = new Float32Array(MAX_SHAFTS * 4);
    const n = shaftUniforms(0, 1920, 1080, a);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(MAX_SHAFTS);
    shaftUniforms(1, 1920, 1080, b);
    for (let i = 0; i < n * 4; i++) {
      expect(b[i]).toBeCloseTo(a[i], 3);
    }
    for (let k = 0; k < 50; k++) {
      shaftUniforms(k / 50, 1920, 1080, a);
      for (let i = 0; i < n; i++) {
        expect(a[i * 4]).toBeGreaterThan(0);
        expect(a[i * 4]).toBeLessThan(1920);
      }
    }
  });
});

describe("fish", () => {
  const aspect = 16 / 9;

  it("spawns the first school after its delay, then respects the interval", () => {
    const f = createFish(5);
    const spawnTimes: number[] = [];
    const dt = 1 / 30;
    let t = 0;
    for (let i = 0; i < 30 * 1200; i++) {
      const before = f.spawned;
      stepFish(f, dt, aspect);
      t += dt;
      if (f.spawned !== before) {
        spawnTimes.push(t);
      }
    }
    expect(spawnTimes[0]).toBeGreaterThanOrEqual(FIRST_SCHOOL - 1e-6);
    expect(spawnTimes.length).toBeGreaterThan(5);
    for (let i = 1; i < spawnTimes.length; i++) {
      const gap = spawnTimes[i] - spawnTimes[i - 1];
      expect(gap).toBeGreaterThanOrEqual(SCHOOL_INTERVAL_MIN - 1e-6);
      expect(gap).toBeLessThanOrEqual(SCHOOL_INTERVAL_MAX + 1);
    }
  });

  it("leaves the frame before despawning", () => {
    const f = createFish(9);
    const out = new Float32Array(FISH_PER_SCHOOL * FISH_FLOATS);
    let wasActive = false;
    let despawns = 0;
    /** How far outside the frame the least-departed fish was at each despawn (heights). */
    let minOutside = Infinity;
    const counts = new Set<number>();
    for (let i = 0; i < 30 * 600; i++) {
      if (f.active) {
        counts.add(fishInstances(f, aspect, out));
      }
      const lastX = f.x;
      const dir = f.dir;
      stepFish(f, 1 / 30, aspect);
      if (wasActive && !f.active) {
        despawns++;
        for (let k = 0; k < FISH_PER_SCHOOL; k++) {
          const x = lastX + f.dx[k];
          const outside = dir > 0 ? x - FISH_LENGTH - aspect : -(x + FISH_LENGTH);
          minOutside = Math.min(minOutside, outside);
        }
      }
      wasActive = f.active;
    }
    expect(despawns).toBeGreaterThan(2);
    expect(minOutside).toBeGreaterThan(-0.01);
    expect([...counts]).toEqual([FISH_PER_SCHOOL]);
  });

  it("writes nothing while no school is crossing", () => {
    const f = createFish(1);
    expect(fishInstances(f, aspect, new Float32Array(FISH_PER_SCHOOL * FISH_FLOATS))).toBe(0);
  });
});

describe("marine snow", () => {
  it("sinks, wraps and stays in the frame", () => {
    const s = createSnow(3);
    const out = new Float32Array(SNOW_COUNT * SNOW_FLOATS);
    for (let i = 0; i < 60 * 300; i++) {
      stepSnow(s, 1 / 60);
    }
    const n = snowInstances(s, 16 / 9, out);
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const o = i * SNOW_FLOATS;
      expect(out[o + 1]).toBeGreaterThanOrEqual(-0.03);
      expect(out[o + 1]).toBeLessThanOrEqual(1.03);
      expect(out[o + 3]).toBeGreaterThanOrEqual(0);
      expect(out[o + 3]).toBeLessThanOrEqual(1);
    }
  });
});

describe("palettes", () => {
  it("keep colours in range", () => {
    for (const p of Object.values(PALETTES)) {
      for (const c of Object.values(p)) {
        for (const v of c) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
