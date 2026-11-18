import { describe, expect, it } from "vitest";
import { MAX_PATTERN_HZ, MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { coastDistance, loadTestLandMask } from "../../test/land-mask";
import {
  cardRect,
  COLD,
  createDayClock,
  createForecast,
  createWeatherState,
  DESIGN_ASPECT,
  DRIFT_PER_DAY,
  evaluate,
  forecastDay,
  formatTemp,
  frontDistance,
  FRONT_POINTS,
  frontSymbols,
  ICON_SIZE,
  ISOBAR_STEP,
  MINUS,
  NAME_FONT,
  OCCLUDED,
  pressureAt,
  project,
  rainAt,
  REGIONS,
  ROLL_SECONDS,
  SEMICIRCLE,
  slotRoll,
  SYMBOL_STRIDE,
  toFahrenheit,
  TRIANGLE,
  viewWindow,
  WARM,
  WET_ICONS,
  WET_RAIN,
  dayName,
  dayTime,
  type CityForecast,
} from "./weathermap-sim";
import { MAX_PACE, MIN_PACE, REGION_OPTIONS, SEASON_OPTIONS } from "./weathermap.meta";

const REGION_IDS = REGION_OPTIONS.map((o) => o.value);
const SEASON_IDS = SEASON_OPTIONS.map((o) => o.value);
const SEEDS = [1, 77, 4242, 90210];

describe("weather sim", () => {
  it("is deterministic per seed", () => {
    const a = createWeatherState();
    const b = createWeatherState();
    evaluate(createForecast("british", 7), 3.3, a);
    evaluate(createForecast("british", 7), 3.3, b);
    expect(Array.from(a.systems)).toEqual(Array.from(b.systems));
    expect(Array.from(a.points)).toEqual(Array.from(b.points));
    expect(a.frontCount).toBe(b.frontCount);
    evaluate(createForecast("british", 8), 3.3, b);
    expect(Array.from(a.systems)).not.toEqual(Array.from(b.systems));
  });

  it.each(SEEDS)("gives the same forecast for the same seed and day (seed %i)", (seed) => {
    const first = forecastDay(createForecast("europe", seed), 4, "autumn", []);
    const again = forecastDay(createForecast("europe", seed), 4, "autumn", []);
    expect(again).toEqual(first);
  });

  it.each(SEEDS)("has fronts and both highs and lows over a run (seed %i)", (seed) => {
    const state = createWeatherState();
    const forecast = createForecast("british", seed);
    let fronts = 0;
    let highs = 0;
    let lows = 0;
    for (let day = 0; day < 30; day++) {
      evaluate(forecast, day, state);
      fronts += state.frontCount;
      for (let i = 0; i < state.systems.length; i += 7) {
        highs += state.systems[i + 2] > 5 ? 1 : 0;
        lows += state.systems[i + 2] < -5 ? 1 : 0;
      }
    }
    expect(fronts).toBeGreaterThan(30);
    expect(highs).toBeGreaterThan(10);
    expect(lows).toBeGreaterThan(10);
  });

  it("moves the systems smoothly as forecast time passes", () => {
    const forecast = createForecast("america", 3);
    const a = evaluate(forecast, 2, createWeatherState());
    const b = evaluate(forecast, 2.01, createWeatherState());
    for (let i = 0; i < a.systems.length; i += 7) {
      expect(Math.abs(b.systems[i] - a.systems[i])).toBeLessThan(0.002);
      expect(Math.abs(b.systems[i + 2] - a.systems[i + 2])).toBeLessThan(1);
    }
  });

  it("deepens the pressure along a front", () => {
    const forecast = createForecast("british", 11);
    const state = createWeatherState();
    let f = -1;
    for (let day = 0; day < 40 && f < 0; day++) {
      evaluate(forecast, day, state);
      f = state.alpha.subarray(0, state.frontCount).findIndex((a) => a > 0.5);
    }
    expect(f).toBeGreaterThanOrEqual(0);
    const o = f * FRONT_POINTS * 2;
    const x = state.points[o + 8];
    const y = state.points[o + 9];
    const fronts = state.frontCount;
    const on = pressureAt(state, x, y);
    state.frontCount = 0;
    const without = pressureAt(state, x, y);
    state.frontCount = fronts;
    expect(on).toBeLessThan(without - 1);
    expect(frontDistance(state, f, x, y)).toBeCloseTo(0, 9);
  });
});

describe("front symbols", () => {
  const out = new Float32Array(400 * SYMBOL_STRIDE);

  it.each(SEEDS.flatMap((seed) => [false, true].map((south) => [seed, south] as const)))(
    "face the right way (seed %i, southern %s)",
    (seed, south) => {
      const forecast = createForecast(south ? "australia" : "british", seed);
      const state = createWeatherState();
      let checked = 0;
      const wrong: string[] = [];
      for (let day = 0; day < 25; day += 0.5) {
        evaluate(forecast, day, state);
        const n = frontSymbols(state, out, 400);
        for (let s = 0; s < n; s++) {
          const q = s * SYMBOL_STRIDE;
          const [x, y, nx, ny, shape, kind] = out.subarray(q, q + 6);
          // Find the front this symbol sits on.
          let f = 0;
          while (f < state.frontCount && frontDistance(state, f, x, y) > 1e-5) {
            f++;
          }
          const wx = state.warmSector[2 * f] - x;
          const wy = state.warmSector[2 * f + 1] - y;
          const towardsWarm = nx * wx + ny * wy;
          // Cold fronts' triangles point into the warm sector; warm fronts'
          // semicircles point away from it, into the cold air ahead; occlusions
          // face east and polewards, as they travel.
          const right =
            f < state.frontCount &&
            state.kinds[f] === kind &&
            (kind === COLD
              ? shape === TRIANGLE && towardsWarm > 0
              : kind === WARM
                ? shape === SEMICIRCLE && towardsWarm < 0
                : kind === OCCLUDED && nx > 0 && (south ? ny : -ny) > 0);
          if (!right) {
            wrong.push(`day ${String(day)}: symbol ${String(s)} (front kind ${String(kind)})`);
          }
          checked++;
        }
      }
      expect(wrong).toEqual([]);
      expect(checked).toBeGreaterThan(50);
    },
  );

  it("alternates triangles and semicircles along an occlusion", () => {
    const state = createWeatherState();
    let shapes: number[] = [];
    for (let day = 0; day < 60 && shapes.length < 3; day++) {
      evaluate(createForecast("europe", 1), day, state);
      const n = frontSymbols(state, out, 400);
      shapes = [];
      for (let s = 0; s < n; s++) {
        if (out[s * SYMBOL_STRIDE + 5] === OCCLUDED) {
          shapes.push(out[s * SYMBOL_STRIDE + 4]);
        }
      }
    }
    expect(shapes.slice(0, 3)).toEqual([TRIANGLE, SEMICIRCLE, TRIANGLE]);
  });
});

describe("city forecasts", () => {
  const cases = REGION_IDS.flatMap((region) =>
    SEASON_IDS.map((season) => [region, season] as const),
  );

  it.each(cases)("match the weather at each city (%s, %s)", (region, season) => {
    const pt = [0, 0];
    const state = createWeatherState();
    const out: CityForecast[] = [];
    const icons = new Set<string>();
    const wrong: string[] = [];
    for (const seed of SEEDS) {
      const forecast = createForecast(region, seed);
      for (let day = 0; day < 20; day++) {
        forecastDay(forecast, day, season, out);
        evaluate(forecast, dayTime(day), state);
        REGIONS[region].cities.forEach((city, c) => {
          project(REGIONS[region], city.lat, city.lon, pt);
          const { icon } = out[c];
          icons.add(icon);
          const wet = WET_ICONS.has(icon);
          const rain = rainAt(state, pt[0], pt[1]);
          let underFront = false;
          for (let f = 0; f < state.frontCount; f++) {
            underFront ||= state.alpha[f] > 0.5 && frontDistance(state, f, pt[0], pt[1]) < 0.03;
          }
          const sunny = icon === "sun" || icon === "fog";
          if (
            wet !== rain >= WET_RAIN ||
            (underFront && !wet) ||
            (sunny && pressureAt(state, pt[0], pt[1]) <= 1015) ||
            (icon === "snow" && out[c].tempC > 2)
          ) {
            wrong.push(`seed ${String(seed)} day ${String(day)} ${city.name}: ${icon}`);
          }
        });
      }
    }
    expect(wrong).toEqual([]);
    expect(icons.size).toBeGreaterThanOrEqual(4);
  });

  it("is warmer in summer than in winter", () => {
    const mean = (season: "summer" | "winter") => {
      let sum = 0;
      let n = 0;
      for (const seed of SEEDS) {
        const forecast = createForecast("british", seed);
        for (let day = 0; day < 10; day++) {
          for (const c of forecastDay(forecast, day, season, [])) {
            sum += c.tempC;
            n++;
          }
        }
      }
      return sum / n;
    };
    expect(mean("summer") - mean("winter")).toBeGreaterThan(10);
  });

  it("snows only in the cold, and storms most in summer", () => {
    const count = (season: (typeof SEASON_IDS)[number], icon: string) => {
      let n = 0;
      for (const seed of [...SEEDS, 5, 6, 7, 8]) {
        const forecast = createForecast("europe", seed);
        for (let day = 0; day < 30; day++) {
          n += forecastDay(forecast, day, season, []).filter((c) => c.icon === icon).length;
        }
      }
      return n;
    };
    expect(count("summer", "snow")).toBe(0);
    expect(count("winter", "snow")).toBeGreaterThan(0);
    expect(count("summer", "thunder")).toBeGreaterThan(count("winter", "thunder"));
  });

  it("converts °C to °F", () => {
    expect([-40, 0, 37, 100].map((c) => toFahrenheit(c))).toEqual([-40, 32, 99, 212]);
    for (let c = -30; c <= 45; c++) {
      const f = toFahrenheit(c);
      expect(Number.isInteger(f)).toBe(true);
      expect(Math.abs(f - (c * 9) / 5 - 32)).toBeLessThanOrEqual(0.5);
      // Each °F reading reads back to its °C one.
      expect(Math.round(((f - 32) * 5) / 9)).toBe(c);
    }
  });

  it("writes temperatures with a minus sign", () => {
    expect(formatTemp(7)).toBe("7");
    expect(formatTemp(-3)).toBe(`${MINUS}3`);
    expect(formatTemp(104)).toBe("104");
  });
});

describe("regions", () => {
  const pt = [0, 0];
  const rect = [0, 0, 0, 0];

  it.each(REGION_IDS)("has 5-8 cities, on land and inside the frame at 16:9 (%s)", async (id) => {
    const mask = await loadTestLandMask();
    const region = REGIONS[id];
    expect(region.cities.length).toBeGreaterThanOrEqual(5);
    expect(region.cities.length).toBeLessThanOrEqual(8);
    const offLand = region.cities.filter((c) => coastDistance(mask, c.lat, c.lon) <= 0.25);
    expect(offLand).toEqual([]);
    const outside = region.cities.filter((city) => {
      project(region, city.lat, city.lon, pt);
      // A bold name is about 0.6 em per character.
      cardRect(pt[0], pt[1], city.left === true, city.name.length * 0.6 * NAME_FONT, rect);
      return rect[0] < 0.02 || rect[1] < 0.02 || rect[2] > DESIGN_ASPECT - 0.02 || rect[3] > 0.98;
    });
    expect(outside).toEqual([]);
  });

  it.each(REGION_IDS)("keeps its cities' cards apart at 16:9 (%s)", (id) => {
    const region = REGIONS[id];
    const rects = region.cities.map((city) => {
      project(region, city.lat, city.lon, pt);
      return cardRect(pt[0], pt[1], city.left === true, city.name.length * 0.6 * NAME_FONT, []);
    });
    const overlaps: string[] = [];
    rects.forEach((a, i) => {
      rects.forEach((b, j) => {
        const apart = a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1];
        if (j > i && !apart) {
          overlaps.push(`${region.cities[i].name} and ${region.cities[j].name}`);
        }
      });
    });
    expect(overlaps).toEqual([]);
  });

  it("frames 16:9 exactly, and shows more at the sides or above and below otherwise", () => {
    const exact = viewWindow(1920, 1080, []);
    expect(exact[0]).toBeCloseTo(0, 12);
    expect(exact[1]).toBe(0);
    expect(exact[2]).toBe(1 / 1080);
    const wide = viewWindow(2560, 1080, []);
    expect(wide[1]).toBe(0);
    expect(wide[0]).toBeLessThan(0);
    const tall = viewWindow(1080, 1920, []);
    expect(tall[0]).toBeCloseTo(0, 12);
    expect(tall[1]).toBeLessThan(0);
    expect(tall[2] * 1080).toBeCloseTo(DESIGN_ASPECT, 12);
  });

  it("keeps the icon size to the frame at 16:9", () => {
    expect(ICON_SIZE * 1080).toBeGreaterThan(80);
  });
});

describe("motion limits", () => {
  it.each(SEEDS)("isobars cross any point well under the pattern limit (seed %i)", (seed) => {
    const forecast = createForecast("british", seed);
    const a = createWeatherState();
    const b = createWeatherState();
    // At the fastest pace, one 1/30 s frame of forecast time.
    const dt = 1 / 30;
    const dTau = dt / MIN_PACE;
    let worst = 0;
    for (let day = 0; day < 20; day += 0.25) {
      evaluate(forecast, day, a);
      evaluate(forecast, day + dTau, b);
      for (let y = 0; y <= 1; y += 0.05) {
        for (let x = 0; x <= DESIGN_ASPECT; x += 0.05) {
          const rate = Math.abs(pressureAt(b, x, y) - pressureAt(a, x, y)) / dt / ISOBAR_STEP;
          worst = Math.max(worst, rate);
        }
      }
    }
    expect(worst).toBeLessThan(MAX_PATTERN_HZ / 2);
  });

  it("moves fronts and symbols a few pixels a second at the fastest pace", () => {
    const pxPerSecond = (DRIFT_PER_DAY * 1.04 * 1080) / MIN_PACE;
    expect(pxPerSecond).toBeLessThan(12);
    expect(pxPerSecond / 30).toBeLessThan(MAX_FEATURE_PX_PER_FRAME);
  });
});

describe("day clock", () => {
  it("steps to the next day every pace seconds, latching a new pace per day", () => {
    const clock = createDayClock(20, MIN_PACE, MAX_PACE);
    expect(clock.step(10, 40)).toBe(false);
    expect(clock.tau).toBeCloseTo(0.5, 12);
    expect(clock.step(10, 40)).toBe(true);
    expect(clock.day).toBe(1);
    expect(clock.pace).toBe(40);
    expect(clock.step(39, 10)).toBe(false);
    expect(clock.step(1, 10)).toBe(true);
    expect(clock.pace).toBe(10);
  });

  it("clamps the pace and survives long and bad steps", () => {
    const clock = createDayClock(1, MIN_PACE, MAX_PACE);
    expect(clock.pace).toBe(MIN_PACE);
    expect(clock.step(35, 1000)).toBe(true);
    expect(clock.day).toBe(1);
    expect(clock.pace).toBe(MAX_PACE);
    expect(clock.step(Number.NaN, 25)).toBe(false);
    clock.reset(25);
    expect(clock.day).toBe(0);
    expect(clock.tau).toBe(0);
  });

  it("names the days in order", () => {
    expect([0, 1, 2, 7].map((d) => dayName(5, d))).toEqual([
      "Friday",
      "Saturday",
      "Sunday",
      "Friday",
    ]);
  });
});

describe("temperature roll", () => {
  it("rolls the units first and every digit within the roll time", () => {
    expect(slotRoll(0, 0)).toBe(0);
    expect(slotRoll(0.2, 0)).toBeGreaterThan(slotRoll(0.2, 1));
    expect(slotRoll(0.2, 1)).toBeGreaterThan(slotRoll(0.2, 2));
    for (let slot = 0; slot < 3; slot++) {
      expect(slotRoll(ROLL_SECONDS, slot)).toBe(1);
    }
  });
});
