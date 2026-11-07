import { describe, expect, it } from "vitest";
import {
  APPROACH_DIST,
  BREAK,
  buildShapeTable,
  createWaveScheduler,
  foamStrength,
  layoutAxes,
  LIFETIME,
  MAX_WAVES,
  maxReach,
  packWaves,
  SHAPE_COLUMNS,
  SPACING_MIN,
  T_ACTIVE,
  T_APPROACH,
  T_STOP,
  WAVE_FLOATS,
  waterPalette,
  waveFront,
  waveWetness,
} from "./beach-sim";
import { LAYOUT_OPTIONS, MAX_WAVE_TIME, MIN_WAVE_TIME } from "./beach.meta";

describe("waveFront", () => {
  const reach = 0.12;
  it("is continuous across every phase", () => {
    const dt = 1e-4;
    let prev = waveFront(0, reach);
    let maxJump = 0;
    for (let t = dt; t < LIFETIME; t += dt) {
      const f = waveFront(t, reach);
      maxJump = Math.max(maxJump, Math.abs(f - prev));
      prev = f;
    }
    expect(maxJump).toBeLessThan(1e-3);
  });
  it("is bounded by the approach distance and the reach", () => {
    for (let t = -1; t < LIFETIME + 5; t += 0.01) {
      const f = waveFront(t, reach);
      expect(f).toBeGreaterThanOrEqual(-APPROACH_DIST - 1e-9);
      expect(f).toBeLessThanOrEqual(reach + 1e-9);
    }
  });
  it("breaks at the break point, peaks at the reach and returns to the shoreline", () => {
    expect(waveFront(0, reach)).toBeCloseTo(-APPROACH_DIST, 9);
    expect(waveFront(T_APPROACH, reach)).toBeCloseTo(-BREAK, 9);
    expect(waveFront(T_STOP, reach)).toBeCloseTo(reach, 9);
    expect(waveFront(T_ACTIVE, reach)).toBeCloseTo(0, 9);
    expect(waveFront(LIFETIME, reach)).toBe(0);
  });
  it("runs up then drains: rising until the stop, falling after", () => {
    for (let t = 0.01; t < T_STOP; t += 0.01) {
      expect(waveFront(t, reach)).toBeGreaterThan(waveFront(t - 0.01, reach));
    }
    for (let t = T_STOP + 0.01; t < T_ACTIVE; t += 0.01) {
      expect(waveFront(t, reach)).toBeLessThan(waveFront(t - 0.01, reach));
    }
  });
  it("tracks the highest point reached", () => {
    let max = -Infinity;
    for (let t = 0; t < LIFETIME; t += 0.01) {
      max = Math.max(max, waveFront(t, reach));
      expect(maxReach(t, reach)).toBeCloseTo(max, 9);
    }
  });
});

describe("waveWetness", () => {
  const reach = 0.15;
  it("decays monotonically once the wave has stopped", () => {
    for (const n of [0.01, 0.05, 0.1, 0.14]) {
      let prev = waveWetness(n, T_STOP, reach);
      expect(prev).toBe(1);
      for (let t = T_STOP + 0.05; t <= LIFETIME + 1; t += 0.05) {
        const w = waveWetness(n, t, reach);
        expect(w).toBeLessThanOrEqual(prev + 1e-12);
        expect(w).toBeGreaterThanOrEqual(0);
        prev = w;
      }
      expect(prev).toBe(0);
    }
  });
  it("dries higher sand first, since the sheet uncovers it earlier", () => {
    const t = T_ACTIVE + 2;
    expect(waveWetness(0.14, t, reach)).toBeLessThan(waveWetness(0.02, t, reach));
  });
  it("leaves sand above the reach dry", () => {
    expect(waveWetness(reach + 0.01, T_STOP + 1, reach)).toBe(0);
    expect(waveWetness(0.05, 1, reach)).toBe(0);
  });
});

describe("foamStrength", () => {
  it("is bounded and gone by the end of the wave's life", () => {
    for (let t = 0; t < LIFETIME; t += 0.05) {
      const f = foamStrength(t);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    expect(foamStrength(LIFETIME)).toBe(0);
  });
});

describe("createWaveScheduler", () => {
  it("keeps waves spaced and never overflows", () => {
    for (const waveTime of [MIN_WAVE_TIME, 9, MAX_WAVE_TIME, 1]) {
      const sched = createWaveScheduler(3);
      const starts: number[] = [];
      let last = Number.NaN;
      let maxCount = 0;
      let minCount = Infinity;
      let maxAge = 0;
      for (let i = 0; i < 20000; i++) {
        sched.step(0.1 * ((i % 7) / 7), waveTime, 0.1);
        maxCount = Math.max(maxCount, sched.count);
        minCount = Math.min(minCount, sched.count);
        const newest = sched.waves[sched.count - 1].start;
        if (newest !== last) {
          starts.push(newest);
          last = newest;
        }
        maxAge = Math.max(maxAge, sched.time - sched.waves[0].start);
      }
      expect(maxCount).toBeLessThanOrEqual(MAX_WAVES);
      expect(minCount).toBeGreaterThan(0);
      expect(maxAge).toBeLessThan(LIFETIME);
      const minGap = Math.max(MIN_WAVE_TIME, Math.min(waveTime, MAX_WAVE_TIME)) * SPACING_MIN;
      let minSeen = Infinity;
      for (let k = 1; k < starts.length; k++) {
        minSeen = Math.min(minSeen, starts[k] - starts[k - 1]);
      }
      expect(minSeen).toBeGreaterThanOrEqual(minGap - 1e-9);
      expect(starts.length).toBeGreaterThan(10);
    }
  });
  it("fits a full lifetime of waves in its slots at the shortest spacing", () => {
    expect(MAX_WAVES * MIN_WAVE_TIME * SPACING_MIN).toBeGreaterThanOrEqual(LIFETIME);
  });
  it("starts a wave on the first step and keeps waves oldest first", () => {
    const sched = createWaveScheduler(1);
    sched.step(0, 9, 0.1);
    expect(sched.count).toBe(1);
    for (let i = 0; i < 500; i++) {
      sched.step(0.1, 6, 0.1);
    }
    for (let k = 1; k < sched.count; k++) {
      expect(sched.waves[k].start).toBeGreaterThan(sched.waves[k - 1].start);
    }
  });
  it("gives each wave unit-length shape weights", () => {
    const sched = createWaveScheduler(9);
    for (let i = 0; i < 300; i++) {
      sched.step(0.1, 6, 0.1);
      const w = sched.waves[sched.count - 1].weights;
      expect(Math.hypot(w[0], w[1], w[2], w[3])).toBeCloseTo(1, 9);
    }
  });
});

describe("packWaves", () => {
  it("packs each live wave's front and offsets", () => {
    const sched = createWaveScheduler(2);
    for (let i = 0; i < 300; i++) {
      sched.step(0.1, 7, 0.12);
    }
    const out = new Float32Array(MAX_WAVES * WAVE_FLOATS);
    const offsets = new Float32Array(MAX_WAVES * 2);
    const n = packWaves(sched, 1, out, offsets);
    expect(n).toBe(sched.count);
    for (let i = 0; i < n; i++) {
      const w = sched.waves[i];
      expect(out[i * WAVE_FLOATS]).toBeCloseTo(waveFront(sched.time - w.start, w.reach), 5);
      expect(offsets[i * 2]).toBeCloseTo(w.offX, 6);
      expect(
        out.slice(i * WAVE_FLOATS, (i + 1) * WAVE_FLOATS).every((v) => Number.isFinite(v)),
      ).toBe(true);
    }
  });
});

describe("layoutAxes", () => {
  it("returns a unit landward axis with the screen centre on the sand", () => {
    const out = new Float32Array(3);
    for (const { value } of LAYOUT_OPTIONS) {
      const aspect = 16 / 9;
      layoutAxes(value, aspect, out);
      expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 6);
      const n = (aspect / 2) * out[0] + 0.5 * out[1] - out[2];
      expect(n).toBeGreaterThan(0.2);
    }
  });
});

describe("buildShapeTable", () => {
  it("fills four bounded channels", () => {
    const t = buildShapeTable(54);
    expect(t.length).toBe(SHAPE_COLUMNS * 4);
    for (const v of t) {
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
    expect(t.some((v) => Math.abs(v) > 0.1)).toBe(true);
  });
});

describe("waterPalette", () => {
  it("falls back to Tropical", () => {
    expect(waterPalette("constructor")).toBe(waterPalette("tropical"));
    expect(waterPalette("dusk")).not.toBe(waterPalette("tropical"));
  });
});
