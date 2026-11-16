import { describe, expect, it } from "vitest";
import {
  createGlowSchedule,
  EVENT_SIZE,
  FLICKER,
  type Genre,
  GENRE_EASE,
  lookLuminances,
  MAX_BOOST,
  MAX_EASE,
  MAX_LOOK,
  MAX_SHOT,
  MIN_EASE,
  MIN_FALL,
  MIN_REPEAT,
  MIN_RISE,
  MIN_SHOT,
  PEAK,
  REST,
  restartGlow,
  screenFlicker,
  shotRange,
  stepGlow,
} from "./monitorglow-schedule";

const GENRES: readonly Genre[] = ["adventure", "shooter", "racing", "horror", "cosy", "film"];
const DT = 1 / 60;
/** Ten minutes of show. */
const FRAMES = 36_000;

/** Brightness every frame for `frames` frames. */
function levels(seed: number, genre: Genre, intensity: number, frames = FRAMES): Float64Array {
  const s = createGlowSchedule(seed, genre, intensity);
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    stepGlow(s, DT, genre, intensity, seed);
    out[i] = s.level;
  }
  return out;
}

/** Start times of the runs where the brightness keeps moving one way by more than `least`. */
function swings(level: Float64Array, sign: 1 | -1, least: number): number[] {
  const starts: number[] = [];
  let i = 1;
  while (i < level.length) {
    if ((level[i] - level[i - 1]) * sign > 1e-12) {
      const from = i - 1;
      while (i < level.length && (level[i] - level[i - 1]) * sign > 1e-12) {
        i++;
      }
      if ((level[i - 1] - level[from]) * sign > least) {
        starts.push(from * DT);
      }
    } else {
      i++;
    }
  }
  return starts;
}

const cases = GENRES.flatMap((g) => [0.2, 0.7, 1].map((k) => [g, k] as const));

describe("the shot schedule", () => {
  it.each(GENRES.map((g) => [g]))("%s: palette and shot lengths fit the rules", (genre) => {
    for (const lum of lookLuminances(genre)) {
      expect(lum).toBeGreaterThan(0);
      expect(lum).toBeLessThanOrEqual(MAX_LOOK);
    }
    const [lo, hi] = shotRange(genre);
    expect(lo).toBeGreaterThanOrEqual(MIN_SHOT);
    expect(hi).toBeLessThanOrEqual(MAX_SHOT);
  });

  it.each(GENRES.map((g) => [g]))("%s is deterministic per seed", (genre) => {
    expect(levels(3, genre, 0.7, 3000)).toEqual(levels(3, genre, 0.7, 3000));
    expect(levels(3, genre, 0.7, 3000)).not.toEqual(levels(4, genre, 0.7, 3000));
  });

  it("restarts exactly as a new schedule starts", () => {
    const a = createGlowSchedule(0, "adventure", 0);
    for (let i = 0; i < 1000; i++) {
      stepGlow(a, DT, "adventure", 0, 0);
    }
    restartGlow(a, 6, "racing", 0.5);
    const b = createGlowSchedule(6, "racing", 0.5);
    for (let i = 0; i < 2000; i++) {
      stepGlow(a, DT, "racing", 0.5, 6);
      stepGlow(b, DT, "racing", 0.5, 6);
    }
    expect(a).toEqual(b);
  });

  it("doesn't depend on the frame rate", () => {
    const a = createGlowSchedule(9, "film", 0.7);
    const b = createGlowSchedule(9, "film", 0.7);
    for (let i = 0; i < 1800; i++) {
      stepGlow(a, 1 / 60, "film", 0.7, 9);
      stepGlow(a, 1 / 60, "film", 0.7, 9);
      stepGlow(b, 1 / 30, "film", 0.7, 9);
      expect(b.level).toBeCloseTo(a.level, 9);
    }
  });

  it.each(cases)("%s at intensity %s: shots and events keep their timing", (genre, k) => {
    const s = createGlowSchedule(5, genre, k);
    const bad: string[] = [];
    const check = (ok: boolean, what: string) => {
      if (!ok) {
        bad.push(`shot ${String(s.shot)}: ${what}`);
      }
    };
    let shot = s.shot;
    let events = 0;
    for (let i = 0; i < FRAMES; i++) {
      stepGlow(s, DT, genre, k, 5);
      if (s.shot === shot) {
        continue;
      }
      shot = s.shot;
      const length = s.end - s.start;
      check(length >= MIN_SHOT && length <= MAX_SHOT, `length ${String(length)}`);
      check(s.ease >= MIN_EASE && s.ease <= MAX_EASE, `ease ${String(s.ease)}`);
      let lastStart = s.start;
      let lastEnd = s.start + s.ease;
      for (let n = 0; n < s.eventCount; n++) {
        const e = s.events.subarray(n * EVENT_SIZE);
        check(e[1] >= MIN_RISE, "rise");
        check(e[3] >= MIN_FALL, "fall");
        check(e[4] <= MAX_BOOST, "boost");
        check(e[0] - lastStart >= MIN_REPEAT, "repeat");
        check(e[0] - lastEnd >= REST, "rest");
        lastStart = e[0];
        lastEnd = e[0] + e[1] + e[2] + e[3];
      }
      check(s.end - lastStart >= MIN_REPEAT, "repeat before the next shot");
      check(s.end - lastEnd >= REST, "rest before the next shot");
      events += s.eventCount;
    }
    expect(bad).toEqual([]);
    expect(shot).toBeGreaterThan(600 / MAX_SHOT);
    expect(events).toBeGreaterThan(genre === "shooter" ? 20 : 0);
  });

  it.each(cases)("%s at intensity %s: brightness ramps and peaks within limits", (genre, k) => {
    const level = levels(5, genre, k);
    // The smoothstep ramps peak at 1.5 times their average rate.
    const maxRise = (1.5 * MAX_BOOST * k) / MIN_RISE;
    const maxFall = (1.5 * MAX_BOOST * k) / MIN_FALL;
    let rise = 0;
    let fall = 0;
    let peak = 0;
    for (let i = 1; i < level.length; i++) {
      const rate = (level[i] - level[i - 1]) / DT;
      rise = Math.max(rise, rate);
      fall = Math.max(fall, -rate);
      peak = Math.max(peak, level[i]);
    }
    expect(rise).toBeLessThanOrEqual(maxRise * 1.01);
    expect(fall).toBeLessThanOrEqual(maxFall * 1.01);
    expect(peak).toBeLessThanOrEqual(PEAK * k + 1e-9);
  });

  it.each(cases)("%s at intensity %s: no brightness change repeats within 3 s", (genre, k) => {
    const level = levels(5, genre, k);
    for (const sign of [1, -1] as const) {
      const starts = swings(level, sign, 0.01 * k);
      expect(starts.length).toBeGreaterThan(5);
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(MIN_REPEAT - 2 * DT);
      }
    }
  });

  it("applies a new seed from the next shot", () => {
    const a = createGlowSchedule(1, "adventure", 0.7);
    const b = createGlowSchedule(1, "adventure", 0.7);
    const differ: number[] = [];
    for (;;) {
      stepGlow(a, DT, "adventure", 0.7, 1);
      stepGlow(b, DT, "adventure", 0.7, 2);
      if (a.shot > 0) {
        break;
      }
      if (b.level !== a.level) {
        differ.push(a.time);
      }
    }
    expect(differ).toEqual([]);
    expect(b.shot).toBe(1);
    expect(b.seed).toBe(2);
    expect(a.seed).toBe(1);
    expect(Array.from(b.to)).not.toEqual(Array.from(a.to));
  });

  it("eases a genre change over the shot under way, then latches it from the next", () => {
    const s = createGlowSchedule(2, "adventure", 1);
    for (let i = 0; i < 60; i++) {
      stepGlow(s, DT, "adventure", 1, 2);
    }
    const shot = s.shot;
    const before = Array.from(s.light);
    stepGlow(s, DT, "horror", 1, 2);
    expect(s.shot).toBe(shot);
    expect(s.genre).toBe("horror");
    expect(s.ease).toBeGreaterThanOrEqual(GENRE_EASE);
    // A frame in, it has barely moved.
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(s.light[c] - before[c])).toBeLessThan(0.01);
    }
    let last = s.level;
    for (let i = 0; i < 3 * 60; i++) {
      stepGlow(s, DT, "horror", 1, 2);
      expect(Math.abs(s.level - last) / DT).toBeLessThanOrEqual(
        (1.5 * MAX_BOOST) / MIN_FALL + 1e-6,
      );
      last = s.level;
    }
  });

  it("eases the intensity", () => {
    const s = createGlowSchedule(2, "cosy", 1);
    stepGlow(s, DT, "cosy", 1, 2);
    const full = s.level;
    stepGlow(s, DT, "cosy", 0.2, 2);
    expect(s.level).toBeGreaterThan(full * 0.95);
    for (let i = 0; i < 120; i++) {
      stepGlow(s, DT, "cosy", 0.2, 2);
    }
    expect(s.intensity).toBe(0.2);
  });

  it("keeps the ambient flicker under 3 %", () => {
    expect(FLICKER).toBeLessThan(0.03);
    for (let t = 0; t < 600; t += 0.05) {
      expect(Math.abs(screenFlicker(t) - 1)).toBeLessThanOrEqual(FLICKER);
    }
  });
});
