import { describe, expect, it } from "vitest";
import { GENRE_PALETTES } from "./monitorglow/monitorglow-schedule";
import {
  createShotSchedule,
  EVENT_SIZE,
  FLICKER,
  MAX_BOOST,
  MAX_EASE,
  MAX_LOOK,
  MAX_SHOT,
  MIN_EASE,
  MIN_FALL,
  MIN_REPEAT,
  MIN_RISE,
  MIN_SHOT,
  PALETTE_EASE,
  PEAK,
  REST,
  restartShots,
  screenFlicker,
  type ShotPalette,
  stepShots,
} from "./shot-schedule";

/** Every palette the effects use, by name. */
const PALETTES: Readonly<Record<string, ShotPalette>> = {
  ...GENRE_PALETTES,
};
const NAMES = Object.keys(PALETTES);
/** The palette with the most events. */
const BUSY = PALETTES.shooter;

const DT = 1 / 60;
/** Ten minutes of show. */
const FRAMES = 36_000;

/** Brightness every frame for `frames` frames. */
function levels(seed: number, name: string, intensity: number, frames = FRAMES): Float64Array {
  const palette = PALETTES[name];
  const s = createShotSchedule(seed, palette, intensity);
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    stepShots(s, DT, palette, intensity, seed);
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

const cases = NAMES.flatMap((g) => [0.2, 0.7, 1].map((k) => [g, k] as const));

describe("the shot schedule", () => {
  it.each(NAMES.map((n) => [n]))("%s: palette and shot lengths fit the rules", (name) => {
    for (const lum of PALETTES[name].lums) {
      expect(lum).toBeGreaterThan(0);
      expect(lum).toBeLessThanOrEqual(MAX_LOOK);
    }
    const [lo, hi] = PALETTES[name].def.shot;
    expect(lo).toBeGreaterThanOrEqual(MIN_SHOT);
    expect(hi).toBeLessThanOrEqual(MAX_SHOT);
  });

  it.each(NAMES.map((n) => [n]))("%s is deterministic per seed", (name) => {
    expect(levels(3, name, 0.7, 3000)).toEqual(levels(3, name, 0.7, 3000));
    expect(levels(3, name, 0.7, 3000)).not.toEqual(levels(4, name, 0.7, 3000));
  });

  it("restarts exactly as a new schedule starts", () => {
    const { adventure, racing } = GENRE_PALETTES;
    const a = createShotSchedule(0, adventure, 0);
    for (let i = 0; i < 1000; i++) {
      stepShots(a, DT, adventure, 0, 0);
    }
    restartShots(a, 6, racing, 0.5);
    const b = createShotSchedule(6, racing, 0.5);
    for (let i = 0; i < 2000; i++) {
      stepShots(a, DT, racing, 0.5, 6);
      stepShots(b, DT, racing, 0.5, 6);
    }
    expect(a).toEqual(b);
  });

  it("doesn't depend on the frame rate", () => {
    const film = GENRE_PALETTES.film;
    const a = createShotSchedule(9, film, 0.7);
    const b = createShotSchedule(9, film, 0.7);
    for (let i = 0; i < 1800; i++) {
      stepShots(a, 1 / 60, film, 0.7, 9);
      stepShots(a, 1 / 60, film, 0.7, 9);
      stepShots(b, 1 / 30, film, 0.7, 9);
      expect(b.level).toBeCloseTo(a.level, 9);
    }
  });

  it.each(cases)("%s at intensity %s: shots and events keep their timing", (name, k) => {
    const palette = PALETTES[name];
    const s = createShotSchedule(5, palette, k);
    const bad: string[] = [];
    const check = (ok: boolean, what: string) => {
      if (!ok) {
        bad.push(`shot ${String(s.shot)}: ${what}`);
      }
    };
    let shot = s.shot;
    let events = 0;
    for (let i = 0; i < FRAMES; i++) {
      stepShots(s, DT, palette, k, 5);
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
    expect(events).toBeGreaterThan(palette === BUSY ? 20 : 0);
  });

  it.each(cases)("%s at intensity %s: brightness ramps and peaks within limits", (name, k) => {
    const level = levels(5, name, k);
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

  it.each(cases)("%s at intensity %s: no brightness change repeats within 3 s", (name, k) => {
    const level = levels(5, name, k);
    for (const sign of [1, -1] as const) {
      const starts = swings(level, sign, 0.01 * k);
      expect(starts.length).toBeGreaterThan(5);
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(MIN_REPEAT - 2 * DT);
      }
    }
  });

  it("applies a new seed from the next shot", () => {
    const adventure = GENRE_PALETTES.adventure;
    const a = createShotSchedule(1, adventure, 0.7);
    const b = createShotSchedule(1, adventure, 0.7);
    const differ: number[] = [];
    for (;;) {
      stepShots(a, DT, adventure, 0.7, 1);
      stepShots(b, DT, adventure, 0.7, 2);
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

  it("eases a palette change over the shot under way, then latches it from the next", () => {
    const { adventure, horror } = GENRE_PALETTES;
    const s = createShotSchedule(2, adventure, 1);
    for (let i = 0; i < 60; i++) {
      stepShots(s, DT, adventure, 1, 2);
    }
    const shot = s.shot;
    const before = Array.from(s.light);
    stepShots(s, DT, horror, 1, 2);
    expect(s.shot).toBe(shot);
    expect(s.palette).toBe(horror);
    expect(s.ease).toBeGreaterThanOrEqual(PALETTE_EASE);
    // A frame in, it has barely moved.
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(s.light[c] - before[c])).toBeLessThan(0.01);
    }
    let last = s.level;
    for (let i = 0; i < 3 * 60; i++) {
      stepShots(s, DT, horror, 1, 2);
      expect(Math.abs(s.level - last) / DT).toBeLessThanOrEqual(
        (1.5 * MAX_BOOST) / MIN_FALL + 1e-6,
      );
      last = s.level;
    }
  });

  it("eases the intensity", () => {
    const cosy = GENRE_PALETTES.cosy;
    const s = createShotSchedule(2, cosy, 1);
    stepShots(s, DT, cosy, 1, 2);
    const full = s.level;
    stepShots(s, DT, cosy, 0.2, 2);
    expect(s.level).toBeGreaterThan(full * 0.95);
    for (let i = 0; i < 120; i++) {
      stepShots(s, DT, cosy, 0.2, 2);
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
