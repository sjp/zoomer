import { describe, expect, it } from "vitest";
import type { StepClock } from "./reaction-sim";
import {
  draftAt,
  DRAFT_SPEED,
  DRAFT_WANDER,
  type Flow,
  MAX_STEPS,
  placeEmitters,
  SIM_DT,
  simSteps,
  SOURCES,
  sourceFor,
  splat,
  SPLAT_CUTOFF,
  streamFunction,
  turbulenceFlow,
  velocity,
  WAVE_COUNT,
  WAVE_PERIOD,
  wavePhases,
  wispFactor,
} from "./smoke-sim";
import { SOURCE_OPTIONS } from "./smoke.meta";

const flowFor = (turbulence: number, draft = 0.05): Flow => {
  const f: Flow = { rise: 0.13, draft, curl: 0, onset0: 0, onset1: 1 };
  turbulenceFlow(turbulence, 0.36, f);
  return f;
};

describe("velocity field", () => {
  const phases = new Float64Array(WAVE_COUNT);
  const v = new Float64Array(2);
  const at = (x: number, y: number, f: Flow, axis: 0 | 1) => {
    velocity(x, y, phases, f, v);
    return v[axis];
  };

  it.each([0, 0.5, 1])("is divergence-free at turbulence %s", (turbulence) => {
    const f = flowFor(turbulence);
    const h = 1e-4;
    for (const t of [0, 13.7, 101.2]) {
      wavePhases(t, phases);
      for (let i = 0; i < 200; i++) {
        const x = (i * 0.137) % 1.78;
        const y = ((i * 0.0731) % 1.1) - 0.05;
        const dudx = (at(x + h, y, f, 0) - at(x - h, y, f, 0)) / (2 * h);
        const dvdy = (at(x, y + h, f, 1) - at(x, y - h, f, 1)) / (2 * h);
        // Compare with the size of the gradients themselves.
        const scale = Math.abs(dudx) + Math.abs(dvdy) + 1e-3;
        expect(Math.abs(dudx + dvdy) / scale).toBeLessThan(1e-4);
      }
    }
  });

  it("is the curl of the stream function plus draft and buoyancy", () => {
    const f = flowFor(0.7, 0.03);
    wavePhases(42, phases);
    const h = 1e-5;
    for (let i = 0; i < 100; i++) {
      const x = (i * 0.211) % 1.78;
      const y = (i * 0.0917) % 1;
      const dpdy =
        (streamFunction(x, y + h, phases, f) - streamFunction(x, y - h, phases, f)) / (2 * h);
      const dpdx =
        (streamFunction(x + h, y, phases, f) - streamFunction(x - h, y, phases, f)) / (2 * h);
      velocity(x, y, phases, f, v);
      expect(v[0]).toBeCloseTo(dpdy + f.draft * y, 6);
      expect(v[1]).toBeCloseTo(-dpdx + f.rise, 6);
    }
  });

  it("is plain buoyancy below the onset, so the ribbon starts straight", () => {
    const f = flowFor(1, 0);
    wavePhases(7, phases);
    velocity(0.4, f.onset0 - 0.01, phases, f, v);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(f.rise);
  });

  it("breaks up sooner and harder with more turbulence", () => {
    const calm = flowFor(0);
    const rough = flowFor(1);
    expect(rough.onset0).toBeLessThan(calm.onset0);
    expect(rough.curl).toBeGreaterThan(calm.curl);
    expect(rough.onset0).toBeGreaterThan(0.36);
  });

  it("keeps eddies slower than the rise, so smoke never sinks for long", () => {
    // Worst case: every wave's contribution aligned (plus the onset slope term).
    const f = flowFor(1);
    let peak = 0;
    wavePhases(0, phases);
    for (let i = 0; i < 4000; i++) {
      velocity((i * 0.0123) % 1.78, (i * 0.00731) % 1, phases, f, v);
      peak = Math.max(peak, f.rise - v[1]);
    }
    expect(peak).toBeLessThan(f.rise * 1.5);
  });
});

describe("wavePhases", () => {
  it("wraps into [0, 2pi) and repeats every WAVE_PERIOD", () => {
    const a = new Float64Array(WAVE_COUNT);
    const b = new Float64Array(WAVE_COUNT);
    for (const t of [0, 12.5, 1e6 + 3.25]) {
      wavePhases(t, a);
      wavePhases(t + WAVE_PERIOD, b);
      for (let i = 0; i < WAVE_COUNT; i++) {
        expect(a[i]).toBeGreaterThanOrEqual(0);
        expect(a[i]).toBeLessThan(Math.PI * 2);
        expect(Math.abs(a[i] - b[i]) % (Math.PI * 2)).toBeLessThan(1e-6);
      }
    }
  });
});

describe("splat", () => {
  it.each([
    [0, 0.0035],
    [0.04, 0.006],
  ])("is bounded and normalised (half-width %s, radius %s)", (halfWidth, radius) => {
    expect(splat(0, 0, halfWidth, radius)).toBeCloseTo(1, 12);
    expect(splat(halfWidth, 0, halfWidth, radius)).toBeCloseTo(1, 12);
    let prev = 1;
    for (let i = 0; i <= 100; i++) {
      const d = (i / 100) * radius * (SPLAT_CUTOFF + 1);
      const s = splat(halfWidth + d, 0, halfWidth, radius);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(prev + 1e-15);
      prev = s;
      // Round: the same at the same distance in any direction.
      expect(splat(-halfWidth, -d, halfWidth, radius)).toBeCloseTo(s, 12);
    }
    expect(splat(halfWidth + radius * SPLAT_CUTOFF, 0, halfWidth, radius)).toBe(0);
    expect(splat(0, radius * SPLAT_CUTOFF * 1.01, halfWidth, radius)).toBe(0);
  });

  it("keeps the wisp factor within [1 - amount, 1]", () => {
    for (let i = 0; i < 100; i++) {
      const w = wispFactor(i * 0.01, 120, i * 0.3, 0.85);
      expect(w).toBeGreaterThanOrEqual(0.15 - 1e-12);
      expect(w).toBeLessThanOrEqual(1);
    }
    expect(wispFactor(0.3, 120, 2, 0)).toBe(1);
  });
});

describe("simSteps", () => {
  it("never runs more than the cap, and keeps the carried fraction in [0, 1)", () => {
    const clock: StepClock = { acc: 0 };
    for (const dt of [0, 1 / 240, 1 / 120, 1 / 60, 1 / 30, 0.1, 1, 1e6, Number.NaN, -1]) {
      for (let i = 0; i < 20; i++) {
        const n = simSteps(clock, dt);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(MAX_STEPS);
        expect(clock.acc).toBeGreaterThanOrEqual(0);
        expect(clock.acc).toBeLessThan(1);
      }
    }
  });

  it("keeps simulated time in step with real time at ordinary frame rates", () => {
    for (const dt of [1 / 144, 1 / 120, 1 / 60, 1 / 30]) {
      const clock: StepClock = { acc: 0 };
      let steps = 0;
      const frames = Math.round(10 / dt);
      for (let i = 0; i < frames; i++) steps += simSteps(clock, dt);
      expect(Math.abs(steps * SIM_DT - frames * dt)).toBeLessThanOrEqual(SIM_DT + 1e-9);
    }
  });

  it("drops the backlog of a hitch instead of catching up later", () => {
    const clock: StepClock = { acc: 0 };
    expect(simSteps(clock, 10)).toBe(MAX_STEPS);
    expect(simSteps(clock, 1 / 60)).toBeLessThanOrEqual(1);
  });
});

describe("sources", () => {
  it("lists every preset and falls back to incense", () => {
    expect(SOURCE_OPTIONS.map((o) => o.value)).toEqual(Object.keys(SOURCES));
    expect(sourceFor("nope")).toBe(SOURCES.incense);
    expect(sourceFor("tea")).toBe(SOURCES.tea);
  });

  it("places emitters inside the canvas, the second away from the centre", () => {
    const out = new Float64Array(4);
    const aspect = 16 / 9;
    for (const sx of [0, 0.2, 0.8, 1]) {
      const n = placeEmitters(SOURCES.two, sx, aspect, out);
      expect(n).toBe(2);
      for (let i = 0; i < n; i++) {
        expect(out[i * 2]).toBeGreaterThanOrEqual(0);
        expect(out[i * 2]).toBeLessThanOrEqual(aspect);
      }
      const centre = aspect / 2;
      expect(Math.abs(out[2] - centre)).toBeGreaterThanOrEqual(Math.abs(out[0] - centre));
    }
    expect(placeEmitters(SOURCES.incense, 0.2, aspect, out)).toBe(1);
  });
});

describe("draftAt", () => {
  it("leans with the param and wanders within a small band", () => {
    for (let t = 0; t < 2000; t += 3.7) {
      for (const d of [-1, 0, 1]) {
        const v = draftAt(d, t);
        expect(Math.abs(v - d * DRAFT_SPEED)).toBeLessThanOrEqual(DRAFT_WANDER + 1e-12);
      }
    }
  });
});
