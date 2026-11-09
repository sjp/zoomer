import { describe, expect, it } from "vitest";
import {
  advanceCycle,
  advanceDrift,
  CLEAR_FALLBACK_STEPS,
  COVER_B,
  createCycle,
  createStats,
  cycleFront,
  FRONT_BAND,
  GROW_FALLBACK_SECONDS,
  readStats,
  restartCycle,
  RETREAT_KILL,
  retreatKill,
  retreatSteps,
  SAMPLE_STEPS,
  sampleCycle,
  SETTLE_CHECKS,
  SETTLE_SAMPLES,
  STATS_SIZE,
  statsTile,
  wantsSample,
  DRIFT_PERIOD,
  driftedFeedKill,
  grayScottStep,
  LAP_CORNER,
  LAP_EDGE,
  makeSpots,
  pack16,
  type Preset,
  PRESETS,
  presetFor,
  SPOT_B,
  SPOT_COUNT,
  SPOT_U,
  unpack16,
} from "./reaction-sim";
import { PATTERN_OPTIONS } from "./reaction.meta";

const presets = Object.entries(PRESETS) as [string, Preset][];

describe("presets", () => {
  it.each(presets)("%s has F and k in the patterned range, drift included", (_, p) => {
    const out = new Float64Array(2);
    for (let i = 0; i < 64; i++) {
      driftedFeedKill(p, 1, (i / 64) * Math.PI * 2, out);
      expect(out[0]).toBeGreaterThan(0.01);
      expect(out[0]).toBeLessThan(0.1);
      expect(out[1]).toBeGreaterThan(0.045);
      expect(out[1]).toBeLessThan(0.07);
    }
    // The drift stays a small wander, not a jump to another family.
    expect(p.driftFeed).toBeLessThanOrEqual(p.feed * 0.1);
    expect(p.driftKill).toBeLessThanOrEqual(p.kill * 0.02);
  });

  it("lists every preset as a select option, and falls back to coral", () => {
    expect(PATTERN_OPTIONS.map((o) => o.value)).toEqual(Object.keys(PRESETS));
    expect(presetFor("labyrinth")).toBe(PRESETS.labyrinth);
    expect(presetFor("nope")).toBe(PRESETS.coral);
    expect(presetFor("toString")).toBe(PRESETS.coral);
  });

  // 10,000 Gray-Scott steps per preset: the simulation itself is the cost, so it gets
  // room for a loaded machine rather than fewer steps.
  it.each(presets)(
    "%s grows from a seed and sustains a pattern at the drift extremes",
    (_, p) => {
      const w = 40;
      const h = 40;
      const fk = new Float64Array(2);
      for (const phase of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        driftedFeedKill(p, 1, phase, fk);
        let u = new Float32Array(w * h);
        let b = new Float32Array(w * h);
        let u2 = new Float32Array(w * h);
        let b2 = new Float32Array(w * h);
        for (let y = 17; y < 23; y++) {
          for (let x = 17; x < 23; x++) {
            u[y * w + x] = SPOT_U;
            b[y * w + x] = SPOT_B;
          }
        }
        for (let s = 0; s < 2500; s++) {
          grayScottStep(u, b, w, h, fk[0], fk[1], u2, b2);
          [u, u2] = [u2, u];
          [b, b2] = [b2, b];
        }
        let cells = 0;
        let max = 0;
        for (const v of b) {
          if (v > 0.1) {
            cells++;
          }
          max = Math.max(max, v);
        }
        // Alive (not decayed to the blank state) and spread well past the 36-cell seed.
        expect(max).toBeGreaterThan(0.25);
        expect(cells).toBeGreaterThan(60);
      }
    },
    20_000,
  );
});

describe("drift path", () => {
  it("is closed: one period returns to the start", () => {
    const p = PRESETS.coral;
    const a = new Float64Array(2);
    const b = new Float64Array(2);
    driftedFeedKill(p, 1, 0, a);
    let phase = 0;
    const dt = 1 / 60;
    for (let t = 0; t < DRIFT_PERIOD * 60; t++) {
      phase = advanceDrift(phase, dt);
    }
    driftedFeedKill(p, 1, phase, b);
    expect(b[0]).toBeCloseTo(a[0], 6);
    expect(b[1]).toBeCloseTo(a[1], 6);
  });

  it("is continuous, including across the phase wrap", () => {
    const p = PRESETS.stripes;
    const prev = new Float64Array(2);
    const next = new Float64Array(2);
    let phase = advanceDrift(0, DRIFT_PERIOD - 0.5);
    driftedFeedKill(p, 1, phase, prev);
    for (let i = 0; i < 120; i++) {
      phase = advanceDrift(phase, 1 / 60);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(Math.PI * 2);
      driftedFeedKill(p, 1, phase, next);
      expect(Math.abs(next[0] - prev[0])).toBeLessThan(1e-5);
      expect(Math.abs(next[1] - prev[1])).toBeLessThan(1e-5);
      prev.set(next);
    }
  });

  it("sits at the preset with no drift", () => {
    const out = new Float64Array(2);
    driftedFeedKill(PRESETS.mitosis, 0, 1.234, out);
    expect([...out]).toEqual([PRESETS.mitosis.feed, PRESETS.mitosis.kill]);
  });
});

describe("makeSpots", () => {
  it("is deterministic per seed and keeps spots off the middle third", () => {
    const a = new Float32Array(SPOT_COUNT * 3);
    const b = new Float32Array(SPOT_COUNT * 3);
    makeSpots(3, a);
    makeSpots(3, b);
    expect(a).toEqual(b);
    makeSpots(4, b);
    expect(a).not.toEqual(b);
    for (let i = 0; i < SPOT_COUNT; i++) {
      const x = a[i * 3];
      expect(x < 1 / 3 || x > 2 / 3).toBe(true);
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
      expect(a[i * 3 + 1]).toBeGreaterThan(0);
      expect(a[i * 3 + 1]).toBeLessThan(1);
      expect(a[i * 3 + 2]).toBeGreaterThanOrEqual(3);
      expect(a[i * 3 + 2]).toBeLessThanOrEqual(6);
    }
  });
});

describe("pack16", () => {
  it("round-trips to within half a 16-bit step and clamps", () => {
    const out = new Float64Array(2);
    for (const v of [0, 1e-5, 0.1234567, 0.5, 0.99999, 1]) {
      pack16(v, out, 0);
      expect(out[0]).toBeGreaterThanOrEqual(0);
      expect(out[0]).toBeLessThanOrEqual(1);
      expect(Math.abs(unpack16(out[0], out[1]) - v)).toBeLessThanOrEqual(0.5 / 65535 + 1e-12);
    }
    pack16(2, out, 0);
    expect(unpack16(out[0], out[1])).toBe(1);
    pack16(-1, out, 0);
    expect(unpack16(out[0], out[1])).toBe(0);
  });
});

describe("grayScottStep", () => {
  it("leaves the blank state (A = 1, B = 0) blank", () => {
    const u = new Float32Array(9);
    const b = new Float32Array(9);
    const ou = new Float32Array(9).fill(7);
    const ob = new Float32Array(9).fill(7);
    grayScottStep(u, b, 3, 3, 0.05, 0.06, ou, ob);
    expect([...ou, ...ob].every((v) => v === 0)).toBe(true);
  });

  it("matches the documented update on a 3x3 grid", () => {
    // A single B cell in the middle, A = 1 everywhere (u = 0).
    const u = new Float32Array(9);
    const b = new Float32Array(9);
    b[4] = 0.5;
    const ou = new Float32Array(9);
    const ob = new Float32Array(9);
    const F = 0.05;
    const k = 0.06;
    grayScottStep(u, b, 3, 3, F, k, ou, ob);
    // Centre: lap(b) = -0.5; react = 1 * 0.25.
    expect(ob[4]).toBeCloseTo(0.5 + 0.5 * -0.5 + 0.25 - (F + k) * 0.5, 6);
    expect(ou[4]).toBeCloseTo(0.25, 6);
    // Edge neighbour: lap(b) = 0.2 * 0.5; no B there, so no reaction.
    expect(ob[1]).toBeCloseTo(0.5 * LAP_EDGE * 0.5, 6);
    expect(ou[1]).toBe(0);
    // Corner: lap(b) = 0.05 * 0.5.
    expect(ob[0]).toBeCloseTo(0.5 * LAP_CORNER * 0.5, 6);
  });
});

describe("life cycle", () => {
  const W = 200;

  it("ramps the extra kill in behind the front", () => {
    expect(retreatKill(0.5, -1)).toBe(0);
    expect(retreatKill(0.5, 0)).toBe(0);
    expect(retreatKill(0.5, FRONT_BAND)).toBeCloseTo(RETREAT_KILL, 12);
    expect(retreatKill(0.1, 0.5)).toBe(0);
    expect(retreatKill(0.9, 1 + FRONT_BAND)).toBeCloseTo(RETREAT_KILL, 12);
    // Symmetric about the centre line.
    expect(retreatKill(0.3, 0.5)).toBeCloseTo(retreatKill(0.7, 0.5), 12);
  });

  it("runs grow, hold, retreat and clear on its fallbacks without readbacks", () => {
    const c = createCycle();
    const run = (steps: number, dt = 0) => {
      let reseed = false;
      for (let i = 0; i < steps; i += 10) {
        reseed = advanceCycle(c, 10, dt, W, 3, true) || reseed;
      }
      return reseed;
    };
    expect(cycleFront(c, W)).toBeLessThan(-FRONT_BAND);
    // Growth is capped in seconds of running simulation; paused time doesn't count.
    for (let i = 0; i < 1000; i++) {
      advanceCycle(c, 0, 1, W, 3, true);
    }
    expect(c.phase).toBe("grow");
    for (let i = 0; i < GROW_FALLBACK_SECONDS - 1; i++) {
      advanceCycle(c, 1, 1, W, 3, true);
    }
    expect(c.phase).toBe("grow");
    advanceCycle(c, 1, 1, W, 3, true);
    expect(c.phase).toBe("hold");
    // The hold counts seconds, but only while stepping.
    for (let i = 0; i < 100; i++) {
      advanceCycle(c, 0, 1, W, 3, true);
    }
    expect(c.phase).toBe("hold");
    for (let i = 0; i < 31; i++) {
      advanceCycle(c, 1, 0.1, W, 3, true);
    }
    expect(c.phase).toBe("retreat");
    // The front sweeps out from the centre, past the edges.
    let prev = cycleFront(c, W);
    expect(prev).toBeLessThan(0.01);
    while (c.phase === "retreat") {
      run(10);
      const f = cycleFront(c, W);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
    expect(c.phase).toBe("clear");
    expect(cycleFront(c, W)).toBeCloseTo(1 + FRONT_BAND, 12);
    expect(run(CLEAR_FALLBACK_STEPS - 10)).toBe(false);
    expect(run(10)).toBe(true);
    restartCycle(c);
    expect(c.phase).toBe("grow");
    expect(retreatSteps(W)).toBeGreaterThan(W);
  });

  it("stays put when regrowing is off", () => {
    const c = createCycle();
    for (let i = 0; i < 1000; i++) {
      advanceCycle(c, 1000, 1, W, 0, false);
    }
    expect(c.phase).toBe("grow");
    expect(cycleFront(c, W)).toBeLessThan(-FRONT_BAND);
  });

  it("holds once every tile is still, and reseeds once the grid is empty", () => {
    const c = createCycle();
    const st = createStats();
    const sample = (cov: number, maxB = 0.4) => {
      for (let i = 0; i < SAMPLE_STEPS; i++) {
        advanceCycle(c, 1, 0, W, 5, true);
      }
      expect(wantsSample(c)).toBe(true);
      st.tiles.fill(cov);
      st.coverage = cov;
      st.maxB = maxB;
      return sampleCycle(c, st, true);
    };
    // Growing: coverage climbs fast.
    for (let k = 0; k < 10; k++) {
      expect(sample(0.05 * k + 0.05)).toBe(false);
    }
    expect(c.phase).toBe("grow");
    // A few clusters still growing keep it growing...
    for (let k = 0; k < SETTLE_SAMPLES + SETTLE_CHECKS; k++) {
      for (let i = 0; i < SAMPLE_STEPS; i++) {
        advanceCycle(c, 1, 0, W, 5, true);
      }
      st.tiles.fill(0.5);
      for (let t = 0; t < 40; t++) {
        st.tiles[t * 25] = 0.1 * k;
      }
      st.coverage = 0.5;
      sampleCycle(c, st, true);
    }
    expect(c.phase).toBe("grow");
    // ...but one noisy tile doesn't.
    for (let k = 0; k < SETTLE_SAMPLES + SETTLE_CHECKS && c.phase === "grow"; k++) {
      for (let i = 0; i < SAMPLE_STEPS; i++) {
        advanceCycle(c, 1, 0, W, 5, true);
      }
      st.tiles.fill(0.5);
      st.tiles[7] = k % 2;
      sampleCycle(c, st, true);
    }
    expect(c.phase).toBe("hold");
    restartCycle(c);
    for (let k = 0; k < 10; k++) {
      expect(sample(0.05 * k + 0.05)).toBe(false);
    }
    // Settled: the same coverage everywhere.
    for (let k = 0; k < SETTLE_SAMPLES + SETTLE_CHECKS && c.phase === "grow"; k++) {
      sample(0.5);
    }
    expect(c.phase).toBe("hold");
    expect(wantsSample(c)).toBe(false);

    // Clearing: reseeds only when nothing is left.
    c.phase = "clear";
    expect(sample(0.01, 0.2)).toBe(false);
    expect(sample(0, 0.01)).toBe(true);

    // A pattern that dies out by itself while growing reseeds too.
    restartCycle(c);
    expect(sample(0, 0)).toBe(false);
    expect(sample(0, 0)).toBe(true);
  });

  it("reads the stats texels, skipping tiles past the grid", () => {
    const bytes = new Uint8Array(STATS_SIZE * STATS_SIZE * 4);
    bytes.set([255, 100, 255, 255], 0);
    bytes.set([0, 10, 255, 255], 4);
    bytes.set([200, 250, 0, 0], 8);
    const st = readStats(bytes, createStats());
    expect(st.coverage).toBeCloseTo(0.5, 9);
    expect(st.maxB).toBeCloseTo(100 / 255, 9);
    expect(st.tiles[0]).toBe(1);
    expect(st.tiles[2]).toBe(-1);
    expect(statsTile(200, 100)).toEqual([40, 40]);
    expect(statsTile(2048, 1152)[0] * STATS_SIZE).toBeGreaterThanOrEqual(2048);
  });

  it("grows, retreats to nothing and asks for a reseed on the CPU twin", () => {
    const w = 120;
    const h = 68;
    let u = new Float32Array(w * h);
    let b = new Float32Array(w * h);
    let u2 = new Float32Array(w * h);
    let b2 = new Float32Array(w * h);
    const spots = new Float32Array(SPOT_COUNT * 3);
    makeSpots(3, spots);
    for (let s = 0; s < SPOT_COUNT; s++) {
      const [cx, cy, r] = [spots[s * 3] * w, spots[s * 3 + 1] * h, spots[s * 3 + 2]];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < r * r) {
            u[y * w + x] = SPOT_U;
            b[y * w + x] = SPOT_B;
          }
        }
      }
    }
    const [tx, ty] = statsTile(w, h);
    const st = createStats();
    const measure = () => {
      st.tiles.fill(-1);
      let sum = 0;
      let n = 0;
      let max = 0;
      for (let j = 0; j * ty < h; j++) {
        for (let i = 0; i * tx < w; i++) {
          let lit = 0;
          let cells = 0;
          for (let y = j * ty; y < Math.min(h, (j + 1) * ty); y++) {
            for (let x = i * tx; x < Math.min(w, (i + 1) * tx); x++) {
              cells++;
              if (b[y * w + x] > COVER_B) {
                lit++;
              }
              max = Math.max(max, b[y * w + x]);
            }
          }
          st.tiles[j * STATS_SIZE + i] = lit / cells;
          sum += lit / cells;
          n++;
        }
      }
      st.coverage = sum / n;
      st.maxB = max;
    };
    const c = createCycle();
    const p = PRESETS.coral;
    const phases: string[] = [];
    let held = 0;
    let reseed = false;
    for (let t = 0; t < 40000 && !reseed; t++) {
      grayScottStep(u, b, w, h, p.feed, p.kill, u2, b2, cycleFront(c, w));
      [u, u2] = [u2, u];
      [b, b2] = [b2, b];
      reseed = advanceCycle(c, 1, 1 / 240, w, 2, true);
      if (wantsSample(c)) {
        measure();
        reseed = sampleCycle(c, st, true) || reseed;
      }
      if (phases[phases.length - 1] !== c.phase) {
        phases.push(c.phase);
        if (c.phase === "hold") {
          measure();
          held = st.coverage;
        }
      }
    }
    expect(phases).toEqual(["grow", "hold", "retreat", "clear"]);
    // It held a real pattern, settled before the growth fallback, and left nothing.
    expect(held).toBeGreaterThan(0.4);
    expect(reseed).toBe(true);
    measure();
    expect(st.maxB).toBeLessThan(0.03);
  }, 30000);
});
