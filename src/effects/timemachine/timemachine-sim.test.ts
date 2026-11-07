import { describe, expect, it } from "vitest";
import { createSkyState } from "../horizon/horizon-sim";
import { createRng } from "../noise";
import { GLYPHS } from "../splitflap/splitflap-sim";
import { MAX_DAY_SECONDS, MIN_DAY_SECONDS } from "./timemachine.meta";
import {
  advanceCycles,
  AVERAGE_SKY,
  CHAIR_HALF,
  createSceneLayout,
  DISC_R,
  LEVER_LEAN,
  LEVER_LENGTH,
  PANEL_W,
  sceneLayout,
  bodyAt,
  civilFromDays,
  COUNTER_CELLS,
  counterDrums,
  counterGlyphs,
  createJourneyTime,
  createSeasonLook,
  CYCLES_PER_YEAR,
  DAYS_PER_CYCLE,
  daysFromCivil,
  daySeconds,
  discRate,
  HORIZON_Y,
  isLeapYear,
  journeyAt,
  LIGHT_CHANNELS,
  lightAt,
  lightChannels,
  lightSwing,
  luma,
  MAX_LIGHT_RATE,
  nightFrom,
  SEASON_BUCKETS,
  SEASON_KEYS,
  seasonAt,
  seasonBuckets,
  slewLight,
  START_PHASE,
  TIME_KEYS,
} from "./timemachine-sim";

/** The UTC date of day `n` since 1970-01-01, from the platform's calendar. */
const utcDate = (n: number) => {
  const d = new Date(n * 86400000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
};

/** The counter's text for `dayNumber`. */
const counterText = (dayNumber: number) => {
  const g = new Uint8Array(COUNTER_CELLS);
  counterGlyphs(dayNumber, g);
  return Array.from(g, (i) => GLYPHS[i]).join("");
};

/** Cycles that land `days` calendar days (plus a little) after setting off. */
const cyclesFor = (days: number) => (days + 0.5) / DAYS_PER_CYCLE;

describe("calendar", () => {
  it("matches the platform's Gregorian calendar, day by day", () => {
    const out = createJourneyTime();
    for (let n = -80000; n < 80000; n += 7) {
      civilFromDays(n, out);
      expect([out.year, out.month, out.day]).toEqual(utcDate(n));
      expect(daysFromCivil(out.year, out.month, out.day)).toBe(n);
    }
  });

  it("knows the leap years", () => {
    expect([1896, 1900, 2000, 2023, 2024].map((y) => isLeapYear(y))).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(daysFromCivil(2000, 3, 1) - daysFromCivil(2000, 2, 28)).toBe(2);
    expect(daysFromCivil(1900, 3, 1) - daysFromCivil(1900, 2, 28)).toBe(1);
  });

  it("works for years before the common era's first century", () => {
    const out = createJourneyTime();
    civilFromDays(daysFromCivil(4, 2, 29), out);
    expect([out.year, out.month, out.day]).toEqual([4, 2, 29]);
    civilFromDays(daysFromCivil(0, 12, 31) + 1, out);
    expect([out.year, out.month, out.day]).toEqual([1, 1, 1]);
  });
});

describe("journey", () => {
  it("sets off on 1 March of the starting year, before dawn", () => {
    const t = journeyAt(0, 1887, createJourneyTime());
    expect([t.year, t.month, t.day]).toEqual([1887, 3, 1]);
    expect(t.dayFraction).toBe(0);
    expect(t.dayPhase).toBeCloseTo(START_PHASE);
    expect(counterText(t.dayNumber)).toBe("01 MAR 1887");
  });

  it("advances through the months and leap years, one day at a time", () => {
    const t = createJourneyTime();
    for (const start of [1896, 1899, 1999, 2023]) {
      const first = daysFromCivil(start, 3, 1);
      for (let d = 0; d < 3 * 366; d++) {
        journeyAt(cyclesFor(d), start, t);
        expect(t.dayNumber).toBe(first + d);
        expect([t.year, t.month, t.day]).toEqual(utcDate(first + d));
      }
    }
  });

  it("runs back through the months and leap years too", () => {
    const t = createJourneyTime();
    for (const start of [1901, 2000, 2025]) {
      const first = daysFromCivil(start, 3, 1);
      for (let d = 1; d < 3 * 366; d++) {
        journeyAt(cyclesFor(-d), start, t);
        expect(t.dayNumber).toBe(first - d);
        expect([t.year, t.month, t.day]).toEqual(utcDate(first - d));
      }
    }
    // Going back from 1 March of a leap year lands on 29 February; of 1900, on the 28th.
    journeyAt(cyclesFor(-1), 2000, t);
    expect(counterText(t.dayNumber)).toBe("29 FEB 2000");
    journeyAt(cyclesFor(-1), 1900, t);
    expect(counterText(t.dayNumber)).toBe("28 FEB 1900");
  });

  it("goes round the year once every CYCLES_PER_YEAR sun crossings", () => {
    const t = journeyAt(CYCLES_PER_YEAR * 4, 1887, createJourneyTime());
    // Four mean Gregorian years from 1 March 1887 is 1 March 1891 or a day either side.
    expect(Math.abs(t.dayNumber - daysFromCivil(1891, 3, 1))).toBeLessThanOrEqual(1);
    expect(t.yearFraction).toBeGreaterThan(0.15);
    expect(t.yearFraction).toBeLessThan(0.17);
  });

  it("advances by direction and speed, clamping the speed to its range", () => {
    expect(advanceCycles(0, 10, 20, "forward")).toBeCloseTo(0.5);
    expect(advanceCycles(0, 10, 20, "backward")).toBeCloseTo(-0.5);
    expect(advanceCycles(1, 10, 1, "forward")).toBeCloseTo(1 + 10 / MIN_DAY_SECONDS);
    expect(advanceCycles(1, 10, 1e9, "forward")).toBeCloseTo(1 + 10 / MAX_DAY_SECONDS);
    expect(advanceCycles(1, Number.NaN, 20, "forward")).toBe(1);
    expect(advanceCycles(1, -1, 20, "forward")).toBe(1);
    expect(daySeconds(Number.NaN)).toBe(30);
  });
});

describe("date counter", () => {
  it("shows the day, the month and the year's last four digits", () => {
    expect(counterText(daysFromCivil(1887, 12, 31))).toBe("31 DEC 1887");
    expect(counterText(daysFromCivil(1887, 12, 31) + 1)).toBe("01 JAN 1888");
    expect(counterText(daysFromCivil(12, 7, 4))).toBe("04 JUL 0012");
    expect(counterText(daysFromCivil(10123, 7, 4))).toBe("04 JUL 0123");
  });

  it("rolls only the changing drums, over the end of the day, up going forwards", () => {
    const out = new Float32Array(COUNTER_CELLS * 3);
    const t = createJourneyTime();
    // 28 February 1887 → 1 March: the day, the month; not the year.
    const start = daysFromCivil(1887, 3, 1);
    const at = (dayNumber: number, fraction: number) =>
      journeyAt((dayNumber - start + fraction) / DAYS_PER_CYCLE, 1887, t);
    // At the slowest, a calendar day lasts long enough for a separate roll.
    at(start - 1, 0.1);
    counterDrums(t, MAX_DAY_SECONDS, "forward", out);
    for (let i = 0; i < COUNTER_CELLS; i++) {
      expect(out[i * 3 + 2]).toBe(0);
    }
    at(start - 1, 0.9999);
    counterDrums(t, MAX_DAY_SECONDS, "forward", out);
    const rolled = Array.from({ length: COUNTER_CELLS }, (_, i) => out[i * 3 + 2] > 0.99);
    expect(rolled).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    // The day's ones drum: 8 rolling to 1.
    expect(GLYPHS[out[3]]).toBe("8");
    expect(GLYPHS[out[4]]).toBe("1");
  });

  it("rolls down going backwards, towards the day before", () => {
    const out = new Float32Array(COUNTER_CELLS * 3);
    // Just after setting off, running backwards: 1 March is nearly over.
    const t = journeyAt(0.0001 / DAYS_PER_CYCLE, 1887, createJourneyTime());
    counterDrums(t, MAX_DAY_SECONDS, "backward", out);
    expect(GLYPHS[out[3]]).toBe("1");
    expect(GLYPHS[out[4]]).toBe("8");
    expect(out[5]).toBeLessThan(-0.99);
    // A moment later it reads 28 February.
    journeyAt(-0.0001 / DAYS_PER_CYCLE, 1887, t);
    expect(counterText(t.dayNumber)).toBe("28 FEB 1887");
  });

  it("rolls continuously when the days pass faster than a roll", () => {
    const out = new Float32Array(COUNTER_CELLS * 3);
    const t = createJourneyTime();
    t.dayNumber = daysFromCivil(1887, 3, 1);
    t.dayFraction = 0.5;
    counterDrums(t, MIN_DAY_SECONDS, "forward", out);
    expect(out[1 * 3 + 2]).toBeCloseTo(0.5);
  });
});

/** Every speed worth checking: the param's range, and slower and faster days beyond it. */
const SPEEDS = [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 45, 60, 90, 120];

describe("light and its strobe cap", () => {
  it("shows the full swing on slow days and a steady average on very fast ones", () => {
    expect(lightSwing(MAX_DAY_SECONDS)).toBe(1);
    expect(lightSwing(30)).toBeGreaterThan(0.6);
    expect(lightSwing(MIN_DAY_SECONDS)).toBeLessThan(0.2);
    expect(lightSwing(0)).toBe(0);
    const s = lightAt(0.3, 0, createSkyState());
    expect(s.zenith).toEqual(AVERAGE_SKY.zenith);
    expect(s.light).toEqual(AVERAGE_SKY.light);
  });

  it("is dark at midnight and bright at noon on a slow day", () => {
    const night = lightAt(0, MAX_DAY_SECONDS, createSkyState());
    const noon = lightAt(0.5, MAX_DAY_SECONDS, createSkyState());
    expect(luma(night.light)).toBeLessThan(0.15);
    expect(luma(noon.light)).toBeGreaterThan(0.9);
    expect(nightFrom(night)).toBe(1);
    expect(nightFrom(noon)).toBe(0);
  });

  it("keeps the time machine's sky keys in order through the day", () => {
    for (let i = 1; i < TIME_KEYS.length; i++) {
      expect(TIME_KEYS[i].hour).toBeGreaterThan(TIME_KEYS[i - 1].hour);
    }
    expect(TIME_KEYS[0].hour).toBeGreaterThanOrEqual(0);
    expect(TIME_KEYS[TIME_KEYS.length - 1].hour).toBeLessThan(24);
  });

  it("never changes any light channel faster than MAX_LIGHT_RATE per second, at any speed", () => {
    const dt = 1 / 240;
    const a = createSkyState();
    const ca = new Float32Array(LIGHT_CHANNELS);
    const cb = new Float32Array(LIGHT_CHANNELS);
    for (const speed of SPEEDS) {
      for (const direction of ["forward", "backward"]) {
        let cycles = 0;
        lightAt(journeyAt(cycles, 1887, createJourneyTime()).dayPhase, speed, a);
        lightChannels(a, ca);
        const t = createJourneyTime();
        // Two whole days, so every part of the day is checked.
        const steps = Math.ceil((2 * Math.max(speed, MIN_DAY_SECONDS)) / dt);
        let worst = 0;
        for (let i = 0; i < steps; i++) {
          // The pure model at speeds below the param's range too.
          cycles += ((direction === "backward" ? -1 : 1) * dt) / speed;
          lightAt(journeyAt(cycles, 1887, t).dayPhase, speed, a);
          lightChannels(a, cb);
          for (let k = 0; k < LIGHT_CHANNELS; k++) {
            worst = Math.max(worst, Math.abs(cb[k] - ca[k]) / dt);
          }
          ca.set(cb);
        }
        expect(worst, `speed ${String(speed)} ${direction}`).toBeLessThanOrEqual(MAX_LIGHT_RATE);
      }
    }
  });

  it("caps brightness well below any strobe: a full swing takes over a second, and cycles are slow", () => {
    // The fastest a full black-to-white change could happen, and the slowest a whole cycle takes.
    expect(1 / MAX_LIGHT_RATE).toBeGreaterThanOrEqual(1);
    const dt = 1 / 240;
    const s = createSkyState();
    for (const speed of SPEEDS) {
      // Sunlight brightness over four days.
      const n = Math.ceil((4 * speed) / dt);
      const values = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        lightAt((i * dt) / speed, speed, s);
        values[i] = luma(s.light);
      }
      // Any rise or fall within one second stays under MAX_LIGHT_RATE.
      const window = Math.round(1 / dt);
      let worst = 0;
      for (let i = window; i < n; i++) {
        worst = Math.max(worst, Math.abs(values[i] - values[i - window]));
      }
      expect(worst, `speed ${String(speed)}`).toBeLessThanOrEqual(MAX_LIGHT_RATE);
      // Count the brightness swings (turning points of more than 0.01): at most
      // two per day, so far fewer than 3 per second.
      let turns = 0;
      let dir = 0;
      let extreme = values[0];
      for (let i = 1; i < n; i++) {
        const v = values[i];
        if (dir >= 0 && v > extreme) {
          extreme = v;
        } else if (dir <= 0 && v < extreme) {
          extreme = v;
        } else if (Math.abs(v - extreme) > 0.01) {
          turns++;
          dir = v > extreme ? 1 : -1;
          extreme = v;
        }
      }
      const perSecond = turns / (n * dt);
      expect(perSecond, `speed ${String(speed)}`).toBeLessThanOrEqual(2 / speed + 0.01);
      expect(perSecond).toBeLessThan(3);
    }
  });

  it("slews the shown light so even sudden jumps ramp at MAX_LIGHT_RATE", () => {
    const rng = createRng(4);
    const shown = lightAt(0, MAX_DAY_SECONDS, createSkyState());
    const target = createSkyState();
    const before = new Float32Array(LIGHT_CHANNELS);
    const after = new Float32Array(LIGHT_CHANNELS);
    const dt = 1 / 60;
    for (let i = 0; i < 6000; i++) {
      // A new speed, direction or time every couple of seconds, at random.
      lightAt(rng(), 0.5 + rng() * 150, target);
      for (let j = 0; j < 120; j++) {
        lightChannels(shown, before);
        slewLight(shown, target, dt);
        lightChannels(shown, after);
        for (let k = 0; k < LIGHT_CHANNELS; k++) {
          expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(MAX_LIGHT_RATE * dt + 1e-6);
        }
      }
      i += 120;
    }
    // Given time, it arrives.
    lightAt(0.5, MAX_DAY_SECONDS, target);
    for (let j = 0; j < 600; j++) {
      slewLight(shown, target, dt);
    }
    lightChannels(shown, after);
    lightChannels(target, before);
    for (let k = 0; k < LIGHT_CHANNELS; k++) {
      expect(after[k]).toBeCloseTo(before[k], 5);
    }
  });

  it("ignores bad frame times", () => {
    const shown = lightAt(0, MAX_DAY_SECONDS, createSkyState());
    const target = lightAt(0.5, MAX_DAY_SECONDS, createSkyState());
    slewLight(shown, target, Number.POSITIVE_INFINITY);
    slewLight(shown, target, Number.NaN);
    expect(shown.light).toEqual(lightAt(0, MAX_DAY_SECONDS, createSkyState()).light);
  });
});

describe("sun and moon", () => {
  it("rises at the left at six, peaks overhead at noon and sets at the right", () => {
    const p: [number, number] = [0, 0];
    bodyAt(0.25, false, p);
    expect(p[0]).toBeLessThan(0);
    expect(p[1]).toBeCloseTo(HORIZON_Y);
    bodyAt(0.5, false, p);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeGreaterThan(0.35);
    bodyAt(0.75, false, p);
    expect(p[0]).toBeGreaterThan(0);
    bodyAt(0, true, p);
    expect(p[1]).toBeGreaterThan(0.35);
  });
});

describe("seasons", () => {
  it("snows in winter, buds and blossoms in spring, is green in summer and gold in autumn", () => {
    const s = createSeasonLook();
    seasonAt(0.05, s);
    expect(s.snow).toBe(1);
    expect(s.foliage).toBe(0);
    seasonAt(0.27, s);
    expect(s.blossom).toBeGreaterThan(0.8);
    expect(s.snow).toBe(0);
    seasonAt(0.5, s);
    expect(s.foliage).toBe(1);
    expect(s.leaf[1]).toBeGreaterThan(s.leaf[0]);
    seasonAt(0.77, s);
    expect(s.leaf[0]).toBeGreaterThan(s.leaf[1]);
    expect(s.leaffall).toBe(1);
  });

  it("wraps smoothly round the new year", () => {
    const a = seasonAt(0.99999, createSeasonLook());
    const b = seasonAt(0.00001, createSeasonLook());
    expect(a.snow).toBeCloseTo(b.snow, 3);
    expect(a.grass[0]).toBeCloseTo(b.grass[0], 3);
  });

  it("keeps its keys in order and in range", () => {
    for (let i = 1; i < SEASON_KEYS.length; i++) {
      expect(SEASON_KEYS[i].at).toBeGreaterThan(SEASON_KEYS[i - 1].at);
    }
    for (const k of SEASON_KEYS) {
      for (const v of [
        k.foliage,
        k.blossom,
        k.snow,
        k.snowfall,
        k.leaffall,
        ...k.leaf,
        ...k.grass,
      ]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("changes no faster than the light may, even at the fastest speed", () => {
    // Years per second at the fastest speed.
    const rate = 1 / (MIN_DAY_SECONDS * CYCLES_PER_YEAR);
    const n = 20000;
    const a = createSeasonLook();
    const b = createSeasonLook();
    let worst = 0;
    for (let i = 0; i < n; i++) {
      seasonAt(i / n, a);
      seasonAt((i + 1) / n, b);
      const diffs = [
        b.foliage - a.foliage,
        b.blossom - a.blossom,
        b.snow - a.snow,
        ...[0, 1, 2].map((k) => b.leaf[k] - a.leaf[k]),
        ...[0, 1, 2].map((k) => b.grass[k] - a.grass[k]),
      ];
      for (const d of diffs) {
        worst = Math.max(worst, Math.abs(d) * n * rate);
      }
    }
    expect(worst).toBeLessThanOrEqual(MAX_LIGHT_RATE);
  });

  it("picks the two buckets either side of the time of year", () => {
    const out = { first: 0, second: 0, mix: 0 };
    seasonBuckets(0.5 + 0.25 / SEASON_BUCKETS, out);
    expect([out.first, out.second]).toEqual([SEASON_BUCKETS / 2, SEASON_BUCKETS / 2 + 1]);
    expect(out.mix).toBeCloseTo(0.25);
    seasonBuckets(1 - 0.5 / SEASON_BUCKETS, out);
    expect(out.first).toBe(SEASON_BUCKETS - 1);
    expect(out.second).toBe(0);
  });
});

describe("disc", () => {
  it("turns slowly, a little faster on faster days", () => {
    expect(discRate(MIN_DAY_SECONDS)).toBeGreaterThan(discRate(MAX_DAY_SECONDS));
    // Under a turn a quarter-minute even at the fastest.
    expect(discRate(MIN_DAY_SECONDS)).toBeLessThan((Math.PI * 2) / 15);
  });
});

describe("layout", () => {
  it("keeps the machine's parts in frame at 16:9 and the middle clear behind the speaker", () => {
    const l = sceneLayout(16 / 9, createSceneLayout());
    const half = 8 / 9;
    expect(l.panelX).toBeGreaterThan(-half);
    expect(l.panelX + PANEL_W).toBeLessThan(-CHAIR_HALF - 0.1);
    expect(l.leverX + Math.sin(LEVER_LEAN) * LEVER_LENGTH + 0.03).toBeLessThan(half);
    expect(l.leverX - Math.sin(LEVER_LEAN) * LEVER_LENGTH).toBeGreaterThan(CHAIR_HALF + 0.1);
    expect(l.discX + DISC_R).toBeLessThan(half);
    // The disc shows past the speaker on one side, its hub clear of the chair.
    expect(l.discX).toBeGreaterThan(CHAIR_HALF);
    expect(l.treeX).toBeLessThan(-CHAIR_HALF - 0.2);
  });

  it("draws the parts in from the edges of narrower frames", () => {
    const l = sceneLayout(4 / 3, createSceneLayout());
    expect(l.panelX).toBeGreaterThan(-2 / 3);
    expect(l.leverX).toBeLessThan(2 / 3 - 0.15);
    expect(l.discX + DISC_R).toBeLessThan(2 / 3);
  });
});
