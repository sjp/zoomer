import { describe, expect, it } from "vitest";
import { BALLOON_FLOATS, paletteFor } from "../balloons/balloons-sim";
import { MAX_OTHERS } from "./balloonride.meta";
import {
  BURN_MAX,
  BURN_MIN,
  BURN_RAMP,
  buildLandscape,
  burnerGap,
  burnerGlow,
  createBurner,
  createLightEase,
  createOthers,
  FLICKER,
  flickerAt,
  FOCAL,
  GAP_SPREAD,
  GORES,
  HORIZON,
  LIGHT_FADE,
  MAX_GAP,
  MAX_SCHEME_COLOURS,
  MIN_GAP,
  OTHER_FADE,
  otherCount,
  primeBurner,
  RIVER_WIDTH,
  riverCentre,
  riverPhases,
  SCHEMES,
  schemeFor,
  stepBurner,
  stepOthers,
  sunOnScreen,
  timeFor,
  TIMES,
  writeOthers,
  YAW_MAX,
  yawAt,
} from "./balloonride-sim";

const SEEDS = [0, 7, 42, 999];

/** Runs a burner for `seconds`, returning each burn's start and end, and the largest glow step. */
function run(seed: number, gap: (t: number) => number, seconds: number, dt: number) {
  const b = createBurner(seed);
  primeBurner(b, gap(0), 5);
  const burns: { start: number; end: number; peak: number }[] = [];
  let last = burnerGlow(b);
  let maxStep = 0;
  let lo = last;
  let hi = last;
  let burning = false;
  for (let t = 0; t < seconds; t += dt) {
    stepBurner(b, dt, gap(t));
    const g = burnerGlow(b);
    // Checked once at the end: an `expect` per step dominates the run time.
    lo = Math.min(lo, g);
    hi = Math.max(hi, g);
    maxStep = Math.max(maxStep, Math.abs(g - last));
    last = g;
    if (b.age >= 0 && !burning) {
      burns.push({ start: t + dt, end: Number.NaN, peak: 0 });
      burning = true;
    } else if (b.age < 0 && burning) {
      burns[burns.length - 1].end = t + dt;
      burning = false;
    }
    if (burning) {
      const cur = burns[burns.length - 1];
      cur.peak = Math.max(cur.peak, g);
    }
  }
  expect(lo).toBeGreaterThanOrEqual(0);
  expect(hi).toBeLessThanOrEqual(1);
  return { burns, maxStep };
}

describe("burner", () => {
  it("fires first a few seconds in, when primed", () => {
    const { burns } = run(7, () => 60, 30, 0.05);
    expect(burns[0].start).toBeGreaterThan(4.9);
    expect(burns[0].start).toBeLessThan(5.2);
  });

  it("respects its gap: every quiet spell is the gap give or take its spread", () => {
    const dt = 0.05;
    for (const seed of SEEDS) {
      for (const gap of [MIN_GAP, 35, MAX_GAP]) {
        const { burns } = run(seed, () => gap, 30 * gap, dt);
        expect(burns.length).toBeGreaterThan(20);
        for (let i = 1; i < burns.length; i++) {
          const quiet = burns[i].start - burns[i - 1].end;
          expect(quiet).toBeGreaterThanOrEqual(gap * (1 - GAP_SPREAD) - dt);
          expect(quiet).toBeLessThanOrEqual(gap * (1 + GAP_SPREAD) + 2 * dt);
        }
        for (const burn of burns) {
          if (Number.isNaN(burn.end)) {
            continue;
          }
          expect(burn.end - burn.start).toBeGreaterThanOrEqual(BURN_MIN - dt);
          expect(burn.end - burn.start).toBeLessThanOrEqual(BURN_MAX + 2 * dt);
          // Every burn comes up to (nearly) full glow.
          expect(burn.peak).toBeGreaterThan(0.97);
        }
      }
    }
  });

  it("ramps its glow continuously, never faster than the ramp allows", () => {
    // Smoothstep's steepest slope is 1.5 times its average.
    const dt = 1 / 60;
    for (const seed of SEEDS) {
      const { maxStep } = run(seed, () => 20, 2000, dt);
      expect(maxStep).toBeLessThanOrEqual((1.5 * dt) / BURN_RAMP + 1e-9);
      expect(maxStep).toBeGreaterThan(0);
    }
  });

  it("stays continuous while the gap param is changed", () => {
    const dt = 1 / 30;
    const gap = (t: number) => (Math.floor(t / 13) % 2 === 0 ? MIN_GAP : MAX_GAP);
    const { maxStep, burns } = run(3, gap, 3000, dt);
    expect(burns.length).toBeGreaterThan(5);
    expect(maxStep).toBeLessThanOrEqual((1.5 * dt) / BURN_RAMP + 1e-9);
  });

  it("is dark between burns and ignores bad steps", () => {
    const b = createBurner(1);
    expect(burnerGlow(b)).toBe(0);
    stepBurner(b, Number.NaN, 30);
    stepBurner(b, -5, 30);
    expect(b.quiet).toBe(0);
    expect(burnerGap(1)).toBe(MIN_GAP);
    expect(burnerGap(500)).toBe(MAX_GAP);
    expect(burnerGap(Number.NaN)).toBe(MIN_GAP);
  });

  it("flickers only softly", () => {
    for (let t = 0; t < 30; t += 0.01) {
      expect(Math.abs(flickerAt(t) - 1)).toBeLessThanOrEqual(FLICKER + 1e-12);
    }
  });
});

describe("view", () => {
  it("turns only a little", () => {
    for (let ph = 0; ph < 1; ph += 0.001) {
      expect(Math.abs(yawAt(ph))).toBeLessThanOrEqual(YAW_MAX + 1e-12);
    }
  });

  it("keeps a low sun in the frame's sky", () => {
    const sun: [number, number] = [0, 0];
    for (const time of ["sunrise", "sunset"] as const) {
      for (const yaw of [-YAW_MAX, 0, YAW_MAX]) {
        sunOnScreen(TIMES[time], yaw, sun);
        expect(Math.abs(sun[0])).toBeLessThan(16 / 9 / 2);
        expect(sun[1]).toBeGreaterThan(HORIZON);
        expect(sun[1]).toBeLessThan(0.25);
      }
    }
    expect(timeFor("nonsense")).toBe(TIMES.sunrise);
  });
});

describe("envelope schemes", () => {
  it("fit the shader's colours and close round the envelope", () => {
    const schemes = Object.values(SCHEMES);
    for (const scheme of schemes) {
      expect(scheme.colours.length).toBeGreaterThan(0);
      expect(scheme.colours.length).toBeLessThanOrEqual(MAX_SCHEME_COLOURS);
    }
    for (const scheme of schemes.filter((s) => !s.patch)) {
      expect(GORES % scheme.colours.length).toBe(0);
    }
    expect(schemeFor("nonsense")).toBe(SCHEMES.rainbow);
  });
});

describe("landscape", () => {
  const SIZE = 256;

  it("is deterministic per seed, and differs between seeds", () => {
    const a = buildLandscape(5, SIZE);
    expect(a.length).toBe(SIZE * SIZE * 4);
    expect(buildLandscape(5, SIZE)).toEqual(a);
    expect(buildLandscape(6, SIZE)).not.toEqual(a);
  });

  it("has the river where the shader's mist expects it, and it tiles", () => {
    const phases = riverPhases(9);
    const map = buildLandscape(9, SIZE);
    let water = 0;
    for (let y = 0; y < SIZE; y++) {
      const v = y / SIZE;
      expect(riverCentre(v + 1, phases)).toBeCloseTo(riverCentre(v, phases), 9);
      const x = Math.floor((((riverCentre(v, phases) % 1) + 1) % 1) * SIZE) % SIZE;
      const o = (y * SIZE + x) * 4;
      // Water is bluer than it is green, and flat.
      if (map[o + 2] > map[o + 1] && map[o + 3] === 0) {
        water++;
      }
    }
    expect(RIVER_WIDTH * SIZE).toBeGreaterThan(1);
    expect(water).toBeGreaterThan(SIZE * 0.8);
  });

  it("has hedges and trees standing up for the shadows", () => {
    const map = buildLandscape(2, SIZE);
    let tall = 0;
    for (let i = 3; i < map.length; i += 4) {
      if (map[i] > 100) {
        tall++;
      }
    }
    expect(tall / (SIZE * SIZE)).toBeGreaterThan(0.02);
    expect(tall / (SIZE * SIZE)).toBeLessThan(0.5);
  });
});

describe("other balloons", () => {
  it("clamps their count", () => {
    expect(otherCount(-3)).toBe(0);
    expect(otherCount(3.4)).toBe(3);
    expect(otherCount(99)).toBe(MAX_OTHERS);
    expect(otherCount(Number.NaN)).toBe(0);
  });

  it("fades in as many as asked for, farthest first, and fades them out", () => {
    const o = createOthers(4);
    const out = new Float32Array(MAX_OTHERS * BALLOON_FLOATS);
    const palette = paletteFor("classic");
    for (let t = 0; t < OTHER_FADE + 1; t += 0.1) {
      stepOthers(o, 0.1, 5);
    }
    const n = writeOthers(o, out, palette, 1920, 1080, 0);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(5);
    for (let k = 1; k < n; k++) {
      // Smaller (farther) ones are drawn first.
      expect(out[k * BALLOON_FLOATS + 2]).toBeGreaterThanOrEqual(out[(k - 1) * BALLOON_FLOATS + 2]);
    }
    for (let k = 0; k < n; k++) {
      const at = k * BALLOON_FLOATS;
      expect(out[at + 3]).toBeCloseTo(1, 9);
      // Near the horizon, never up in the envelope or down in the basket.
      const y = out[at + 1] / 1080 - 0.5;
      expect(y).toBeGreaterThan(HORIZON + FOCAL * Math.tan(-0.08));
      expect(y).toBeLessThan(0.3);
    }
    for (let t = 0; t < OTHER_FADE + 1; t += 0.1) {
      stepOthers(o, 0.1, 0);
    }
    expect(writeOthers(o, out, palette, 1920, 1080, 0)).toBe(0);
  });
});

describe("createLightEase", () => {
  it("starts at the target and eases a change of time of day", () => {
    const ease = createLightEase();
    expect(ease.step(TIMES.sunrise, 1 / 60)).toBe(TIMES.sunrise);
    const first = ease.step(TIMES.midday, 1 / 60);
    expect(first).not.toBe(TIMES.midday);
    // One frame in, the light has barely moved from sunrise.
    expect(Math.abs(first.sunElev - TIMES.sunrise.sunElev)).toBeLessThan(0.01);
    expect(Math.abs(first.base.zenith[0] - TIMES.sunrise.base.zenith[0])).toBeLessThan(0.01);
    let mid = first;
    for (let t = 1 / 60; t < LIGHT_FADE / 2; t += 1 / 60) {
      mid = ease.step(TIMES.midday, 1 / 60);
    }
    expect(mid.sunElev).toBeGreaterThan(TIMES.sunrise.sunElev + 0.2);
    expect(mid.sunElev).toBeLessThan(TIMES.midday.sunElev - 0.2);
    expect(mid.mist).toBeLessThan(TIMES.sunrise.mist);
    expect(mid.mist).toBeGreaterThan(TIMES.midday.mist);
    let end = mid;
    for (let t = 0; t < LIGHT_FADE; t += 1 / 60) {
      end = ease.step(TIMES.midday, 1 / 60);
    }
    expect(end).toBe(TIMES.midday);
  });
});
