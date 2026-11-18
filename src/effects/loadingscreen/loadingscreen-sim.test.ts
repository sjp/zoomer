import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import { BAR_MAX_WIDTH } from "./loadingscreen-hud";
import { TIP_LENGTH } from "./loadingscreen.meta";
import {
  CEILING,
  createDrift,
  createDriftWindow,
  createProgress,
  createProgressTrack,
  DEFAULT_TIPS,
  driftAt,
  driftWindow,
  EMBLEM_TURN_SECONDS,
  emblemAngle,
  LABELS,
  OVERSCAN,
  SEGMENT,
  steadyAt,
  tipAt,
  tipList,
} from "./loadingscreen-sim";

const SEEDS = [0, 1, 2, 7, 42, 999];
/** Samples per second when sweeping the curve. */
const RATE = 10;

/** The curve sampled every 1/RATE s for `seconds`. */
function sample(seed: number, seconds: number) {
  const track = createProgressTrack(seed);
  const p = createProgress();
  const values: number[] = [];
  const kinds: number[] = [];
  const labels: number[] = [];
  for (let i = 0; i <= seconds * RATE; i++) {
    track.at(i / RATE, p);
    values.push(p.value);
    kinds.push(p.kind);
    labels.push(p.label);
  }
  return { values, kinds, labels };
}

describe("never-finishing progress", () => {
  it.each(SEEDS)("is the same every time for seed %i, and differs between seeds", (seed) => {
    const a = sample(seed, 300).values;
    expect(sample(seed, 300).values).toEqual(a);
    expect(sample(seed + 1, 300).values).not.toEqual(a);
  });

  it.each(SEEDS)("stays within 0 and 99 %% for seed %i over an hour", (seed) => {
    const { values } = sample(seed, 3600);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(CEILING);
      expect(Math.floor(v)).toBeLessThanOrEqual(99);
    }
  });

  it.each(SEEDS)("stalls and slips back in every four minutes for seed %i", (seed) => {
    const { kinds } = sample(seed, 3600);
    const window = 240 * RATE;
    let lastStall = 0;
    let lastSlip = 0;
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] === SEGMENT.stall) {
        lastStall = i;
      }
      if (kinds[i] === SEGMENT.slip || kinds[i] === SEGMENT.reset) {
        lastSlip = i;
      }
      expect(i - lastStall).toBeLessThan(window);
      expect(i - lastSlip).toBeLessThan(window);
    }
  });

  it.each(SEEDS)("finishes phases and starts new ones for seed %i", (seed) => {
    const track = createProgressTrack(seed);
    const p = createProgress();
    track.at(3600, p);
    expect(p.phase).toBeGreaterThanOrEqual(6);
  });

  it.each(SEEDS)("labels its stretches for seed %i", (seed) => {
    const { kinds, labels } = sample(seed, 1200);
    const where = (kind: number) => labels.filter((_, i) => kinds[i] === kind);
    expect(Math.max(...labels)).toBeLessThan(LABELS.length);
    expect(new Set(where(SEGMENT.almost).map((l) => LABELS[l]))).toEqual(
      new Set(["Almost there…"]),
    );
    expect(where(SEGMENT.slip).length).toBeGreaterThan(0);
    expect(Math.min(...where(SEGMENT.slip))).toBeGreaterThan(2);
  });

  it.each(SEEDS)("never moves the bar's end faster than the codec limit, seed %i", (seed) => {
    const { values } = sample(seed, 3600);
    for (let i = 1; i < values.length; i++) {
      const perSecond = (Math.abs(values[i] - values[i - 1]) / 100) * RATE;
      expect((perSecond * BAR_MAX_WIDTH) / 30).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
    }
  });

  it("reads the same backwards as forwards", () => {
    const track = createProgressTrack(5);
    const p = createProgress();
    const late = track.at(900, p).value;
    const early = track.at(30, p).value;
    expect(createProgressTrack(5).at(30, createProgress()).value).toBe(early);
    expect(createProgressTrack(5).at(900, createProgress()).value).toBe(late);
  });
});

describe("steady progress", () => {
  it.each([1, 5, 30])("goes from 0 to 100 %% over a %i-minute loop and wraps", (minutes) => {
    const loop = minutes * 60;
    const p = createProgress();
    expect(steadyAt(0, loop, p).value).toBe(0);
    expect(steadyAt(loop * 0.5, loop, p).value).toBeGreaterThan(40);
    expect(steadyAt(loop * 0.5, loop, p).value).toBeLessThan(60);
    expect(steadyAt(loop - 5, loop, p).value).toBe(100);
    expect(steadyAt(loop, loop, p).value).toBe(0);
    expect(p.phase).toBe(1);
    expect(steadyAt(loop * 1.5, loop, createProgress()).value).toBeCloseTo(
      steadyAt(loop * 0.5, loop, createProgress()).value,
      6,
    );
    let last = 0;
    for (let t = 0; t <= loop * 2; t += 1 / RATE) {
      const v = steadyAt(t, loop, p).value;
      const perSecond = (Math.abs(v - last) / 100) * RATE;
      expect((perSecond * BAR_MAX_WIDTH) / 30).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
      last = v;
    }
  });
});

describe("tips", () => {
  it("has built-in tips that fit a tip line", () => {
    expect(DEFAULT_TIPS.length).toBeGreaterThanOrEqual(8);
    for (const tip of DEFAULT_TIPS) {
      expect(Array.from(tip).length).toBeLessThanOrEqual(TIP_LENGTH);
    }
  });

  it("uses the owner's tips when set, ignoring blank lines", () => {
    expect(tipList("")).toEqual(DEFAULT_TIPS);
    expect(tipList(" \n\n")).toEqual(DEFAULT_TIPS);
    expect(tipList("  One \n\n Two\n ")).toEqual(["One", "Two"]);
  });

  it.each([
    [1, 3],
    [2, 3],
    [3, 3],
    [5, 3],
    [8, 7],
    [14, 7],
  ])("cycles through all %i tips before repeating (seed %i)", (count, seed) => {
    for (let cycle = 0; cycle < 5; cycle++) {
      const seen = new Set<number>();
      for (let pos = 0; pos < count; pos++) {
        seen.add(tipAt(seed, cycle * count + pos, count));
      }
      expect(seen.size).toBe(count);
    }
  });

  it.each([2, 3, 4, 14])("never shows the same one of %i tips twice in a row", (count) => {
    for (const seed of SEEDS) {
      for (let slot = 1; slot < count * 12; slot++) {
        expect(tipAt(seed, slot, count)).not.toBe(tipAt(seed, slot - 1, count));
      }
    }
  });

  it("orders the tips by seed", () => {
    const order = (seed: number) => Array.from({ length: 14 }, (_, i) => tipAt(seed, i, 14));
    expect(order(1)).toEqual(order(1));
    expect(order(1)).not.toEqual(order(2));
  });
});

describe("drift", () => {
  it.each(SEEDS)("keeps the window inside the painting for seed %i", (seed) => {
    const d = createDrift();
    const w = createDriftWindow();
    for (let t = 0; t < 240; t += 0.5) {
      driftWindow(driftAt(seed, t, d), w);
      expect(w.u0).toBeGreaterThanOrEqual(0);
      expect(w.v0).toBeGreaterThanOrEqual(0);
      expect(w.u0 + w.size).toBeLessThanOrEqual(1);
      expect(w.v0 + w.size).toBeLessThanOrEqual(1);
    }
  });

  it.each([16 / 9, 21 / 9, 32 / 9, 4 / 3, 9 / 16])(
    "moves slower than the codec limit at aspect %f",
    (aspect) => {
      for (const seed of SEEDS) {
        const d = createDrift();
        const a = createDriftWindow();
        const b = createDriftWindow();
        const dt = 1 / 30;
        for (let t = 0; t < 120; t += 0.25) {
          driftWindow(driftAt(seed, t, d), a);
          driftWindow(driftAt(seed, t + dt, d), b);
          // Any painting point's screen motion in frame heights: the window's
          // corners move the most (a zoom moves the far corner too).
          const frameW = aspect;
          for (const [cu, cv] of [
            [0, 0],
            [1, 1],
            [0, 1],
            [1, 0],
          ]) {
            const pu = a.u0 + cu * a.size;
            const pv = a.v0 + cv * a.size;
            const du = ((pu - b.u0) / b.size - cu) * frameW;
            const dv = (pv - b.v0) / b.size - cv;
            expect(pxPerReferenceFrame(Math.hypot(du, dv) * 30)).toBeLessThan(1);
          }
        }
      }
    },
  );

  it("drifts somewhere, and differently for different seeds", () => {
    const a = driftWindow(driftAt(1, 0, createDrift()), createDriftWindow());
    const b = driftWindow(driftAt(1, 60, createDrift()), createDriftWindow());
    const c = driftWindow(driftAt(2, 0, createDrift()), createDriftWindow());
    expect(Math.hypot(a.u0 - b.u0, a.v0 - b.v0)).toBeGreaterThan(0.01);
    expect(Math.hypot(a.u0 - c.u0, a.v0 - c.v0)).toBeGreaterThan(0.001);
    expect(OVERSCAN).toBeGreaterThan(1);
  });
});

describe("emblem", () => {
  it("turns no faster than once every two seconds", () => {
    expect(EMBLEM_TURN_SECONDS).toBeGreaterThanOrEqual(2);
    const dt = 1 / 120;
    for (let t = 0; t < 10; t += dt) {
      let step = emblemAngle(t + dt) - emblemAngle(t);
      if (step < 0) {
        step += Math.PI * 2;
      }
      expect(step / dt / (Math.PI * 2)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("stays in range for large times", () => {
    const a = emblemAngle(1e7 + 0.3);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(Math.PI * 2);
  });
});
