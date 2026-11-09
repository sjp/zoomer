import { describe, expect, it } from "vitest";
import {
  advanceRotors,
  BAND,
  COLUMNS,
  createFarm,
  fillHillColors,
  fillHillTable,
  HALF_WIDTH,
  HILL_LAYERS,
  HILLS,
  hillHeightAt,
  layoutFarm,
  PACKED,
  packPalette,
  PALETTE_FLOATS,
  PALETTES,
  paletteFor,
  silhouettesOverlap,
  SINK,
  SPAN,
  turbineCount,
  turbinesClash,
  TURBINE_FLOATS,
  writeTurbines,
  type Side,
} from "./windfarm-sim";
import { MAX_TURBINES, MIN_TURBINES, SIDE_OPTIONS, TIME_OPTIONS } from "./windfarm.meta";

const buildTable = (seed: number) => {
  const out = new Float32Array(HILL_LAYERS * COLUMNS);
  fillHillTable(out, seed);
  return out;
};

const ASPECTS = [16 / 9, 4 / 3, 21 / 9];
const SIDES = SIDE_OPTIONS.map((o) => o.value);

describe("palettes", () => {
  it("has one per time of day and falls back to midday", () => {
    expect(TIME_OPTIONS.map((o) => o.value).toSorted()).toEqual(Object.keys(PALETTES).toSorted());
    expect(paletteFor("evening")).toBe(PALETTES.evening);
    expect(paletteFor("nope")).toBe(PALETTES.midday);
    expect(paletteFor("toString")).toBe(PALETTES.midday);
  });

  it("fades the hills toward the haze with distance", () => {
    const out = new Float32Array(HILL_LAYERS * 3);
    fillHillColors(out, PALETTES.midday);
    const dist = (i: number) =>
      Math.hypot(...[0, 1, 2].map((c) => out[i * 3 + c] - PALETTES.midday.haze[c]));
    for (let i = 1; i < HILL_LAYERS; i++) {
      expect(dist(i)).toBeLessThan(dist(i - 1));
    }
  });

  it("packs every eased palette value into one block", () => {
    const out = new Float32Array(PALETTE_FLOATS).fill(Number.NaN);
    const pal = PALETTES.evening;
    packPalette(out, pal);
    expect(out.every((x) => Number.isFinite(x))).toBe(true);
    expect(Array.from(out.subarray(PACKED.haze, PACKED.haze + 3))).toEqual(
      pal.haze.map((c) => Math.fround(c)),
    );
    const hills = new Float32Array(HILL_LAYERS * 3);
    fillHillColors(hills, pal);
    expect(out.subarray(PACKED.hills, PACKED.scalars)).toEqual(hills);
    expect(out[PACKED.scalars]).toBe(Math.fround(pal.sunX));
    expect(out[PALETTE_FLOATS - 1]).toBe(Math.fround(pal.shadow));
  });
});

describe("hill table", () => {
  it("is deterministic per seed, fills each band and stacks farther layers higher", () => {
    const a = buildTable(3);
    expect(buildTable(3)).toEqual(a);
    expect(buildTable(4)).not.toEqual(a);
    for (let i = 0; i < HILL_LAYERS; i++) {
      const row = a.subarray(i * COLUMNS, (i + 1) * COLUMNS);
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of row) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      expect(lo).toBeCloseTo(HILLS[i].base, 5);
      expect(hi).toBeCloseTo(HILLS[i].base + HILLS[i].amp, 5);
    }
    const bases = HILLS.map((h) => h.base);
    expect(bases).toEqual([...bases].toSorted((x, y) => x - y));
  });

  it("wraps with its span", () => {
    const t = buildTable(1);
    let worst = 0;
    for (let x = 0; x < SPAN; x += 0.137) {
      for (let i = 0; i < HILL_LAYERS; i++) {
        worst = Math.max(worst, Math.abs(hillHeightAt(t, i, x + SPAN) - hillHeightAt(t, i, x)));
      }
    }
    expect(worst).toBeLessThan(1e-5);
  });
});

describe("silhouettesOverlap", () => {
  it("catches discs, a disc against a tower, and towers", () => {
    expect(silhouettesOverlap(0, 0.3, 0.1, 0.05, 0.3, 0.1)).toBe(true);
    expect(silhouettesOverlap(0, 0.3, 0.1, 0.5, 0.3, 0.1)).toBe(false);
    // A small far turbine just beside a big near one's tower.
    expect(silhouettesOverlap(0.5, 0.05, 0.3, 0.52, 0.2, 0.05)).toBe(true);
    // ...and well clear of its rotor, above its hub.
    expect(silhouettesOverlap(0.5, 0.0, 0.1, 0.5, 0.4, 0.05)).toBe(false);
  });
});

describe("turbinesClash", () => {
  it("keeps whole silhouettes apart on one layer", () => {
    expect(turbinesClash(0, 0.3, 0.1, 2, 0.1, 0.3, 0.1, 2)).toBe(true);
    expect(turbinesClash(0, 0.3, 0.1, 2, 0.3, 0.3, 0.1, 2)).toBe(false);
  });

  it("lets near blades sweep in front of a far rotor but never hide its hub", () => {
    // Far hub (0.65, 0.45) inside the near disc but clear of its tower and hub.
    expect(turbinesClash(0.5, 0.1, 0.3, 0, 0.65, 0.4, 0.05, 3)).toBe(false);
    expect(turbinesClash(0.65, 0.4, 0.05, 3, 0.5, 0.1, 0.3, 0)).toBe(false);
    // Far hub right behind the near tower, or the near hub.
    expect(turbinesClash(0.5, 0.1, 0.3, 0, 0.51, 0.25, 0.05, 3)).toBe(true);
    expect(turbinesClash(0.5, 0.1, 0.3, 0, 0.52, 0.35, 0.05, 3)).toBe(true);
  });
});

describe("layoutFarm", () => {
  it("is deterministic per seed", () => {
    const t = buildTable(5);
    const a = createFarm();
    const b = createFarm();
    layoutFarm(a, t, 16 / 9, 9, "spread", 5);
    layoutFarm(b, t, 16 / 9, 9, "spread", 5);
    expect(b).toEqual(a);
    layoutFarm(b, t, 16 / 9, 9, "spread", 6);
    expect(b.x).not.toEqual(a.x);
  });

  it("stands every turbine on its ridge, clear of the others, sorted farthest first", () => {
    const farm = createFarm();
    let failures = 0;
    let placedTotal = 0;
    for (let seed = 0; seed < 8; seed++) {
      const t = buildTable(seed);
      for (const aspect of ASPECTS) {
        for (const side of SIDES) {
          for (const n of [MIN_TURBINES, 9, MAX_TURBINES]) {
            const placed = layoutFarm(farm, t, aspect, n, side, seed);
            placedTotal += placed;
            if (placed < 1 || placed > n || farm.count !== placed) {
              failures++;
            }
            for (let i = 0; i < placed; i++) {
              const ground = hillHeightAt(t, farm.layer[i], farm.x[i]);
              if (Math.abs(farm.base[i] + SINK * farm.size[i] - ground) > 1e-9) {
                failures++;
              }
              if (i > 0 && farm.layer[i] > farm.layer[i - 1]) {
                failures++;
              }
              if (farm.angle[i] < 0 || farm.angle[i] >= Math.PI * 2) {
                failures++;
              }
              for (let j = 0; j < i; j++) {
                const hit = turbinesClash(
                  farm.x[i],
                  farm.base[i],
                  farm.size[i],
                  farm.layer[i],
                  farm.x[j],
                  farm.base[j],
                  farm.size[j],
                  farm.layer[j],
                );
                if (hit) {
                  failures++;
                }
              }
            }
          }
        }
      }
    }
    expect(failures).toBe(0);
    // Most requests are met in full.
    expect(placedTotal).toBeGreaterThan(8 * ASPECTS.length * SIDES.length * 7);
  });

  it.each(SIDES)("keeps the central band clear (%s)", (side: Side) => {
    const farm = createFarm();
    let failures = 0;
    for (let seed = 0; seed < 12; seed++) {
      const t = buildTable(seed);
      for (const aspect of ASPECTS) {
        const placed = layoutFarm(farm, t, aspect, MAX_TURBINES, side, seed);
        for (let i = 0; i < placed; i++) {
          const hw = HALF_WIDTH * farm.size[i];
          const lo = farm.x[i] - hw;
          const hi = farm.x[i] + hw;
          const inBand = hi > aspect * BAND + 1e-9 && lo < aspect * (1 - BAND) - 1e-9;
          const wrongSide =
            (side === "left" && farm.x[i] > aspect / 2) ||
            (side === "right" && farm.x[i] < aspect / 2);
          if (inBand || wrongSide) {
            failures++;
          }
        }
      }
    }
    expect(failures).toBe(0);
  });

  it("places a fair number even on one side", () => {
    const farm = createFarm();
    const t = buildTable(7);
    expect(layoutFarm(farm, t, 16 / 9, MAX_TURBINES, "left", 7)).toBeGreaterThanOrEqual(6);
    expect(layoutFarm(farm, t, 16 / 9, MAX_TURBINES, "spread", 7)).toBeGreaterThanOrEqual(10);
  });

  it("clamps the count", () => {
    expect(turbineCount(0)).toBe(MIN_TURBINES);
    expect(turbineCount(8.6)).toBe(9);
    expect(turbineCount(99)).toBe(MAX_TURBINES);
    expect(turbineCount(Number.NaN)).toBe(MIN_TURBINES);
  });
});

describe("rotors", () => {
  it("turn continuously, stay wrapped, and stop without wind", () => {
    const farm = createFarm();
    layoutFarm(farm, buildTable(2), 16 / 9, 9, "spread", 2);
    const TAU = Math.PI * 2;
    const prev = Float64Array.from(farm.angle);
    let failures = 0;
    let wraps = 0;
    for (let f = 0; f < 3000; f++) {
      advanceRotors(farm, 1 / 60, 3);
      for (let i = 0; i < farm.count; i++) {
        const a = farm.angle[i];
        if (!(a >= 0 && a < TAU)) {
          failures++;
        }
        // Clockwise: the step, taken modulo a turn, is small and negative.
        let d = a - prev[i];
        if (d > Math.PI) {
          d -= TAU;
          wraps++;
        }
        if (!(d < 0 && d > -0.1)) {
          failures++;
        }
        prev[i] = a;
      }
    }
    expect(failures).toBe(0);
    expect(wraps).toBeGreaterThan(0);
    const still = Float64Array.from(farm.angle);
    advanceRotors(farm, 1, 0);
    expect(farm.angle).toEqual(still);
  });

  it("stays well under one turn per second at the default wind", () => {
    const farm = createFarm();
    layoutFarm(farm, buildTable(2), 16 / 9, 9, "spread", 2);
    const before = Float64Array.from(farm.angle);
    advanceRotors(farm, 1, 1);
    let worst = 0;
    for (let i = 0; i < farm.count; i++) {
      const d = (before[i] - farm.angle[i] + Math.PI * 2) % (Math.PI * 2);
      worst = Math.max(worst, d / (Math.PI * 2));
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(0.5);
  });

  it("writes one instance per turbine", () => {
    const farm = createFarm();
    const placed = layoutFarm(farm, buildTable(2), 16 / 9, 9, "spread", 2);
    const out = new Float32Array(MAX_TURBINES * TURBINE_FLOATS);
    expect(writeTurbines(farm, out, 1080)).toBe(placed);
    expect(out[0]).toBeCloseTo(farm.x[0] * 1080, 2);
    expect(out[2]).toBeCloseTo(farm.size[0] * 1080, 2);
    expect(out[5]).toBe(farm.layer[0]);
  });
});
