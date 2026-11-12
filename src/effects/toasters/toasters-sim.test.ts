import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import {
  BOB,
  CELL,
  createFlock,
  DIR_X,
  DIR_Y,
  FLAP_CYCLE,
  FLAP_MAX,
  FLAP_MIN,
  flapCell,
  type FlockParams,
  LAYER_SIZE,
  maxEdgeSpeed,
  REF_HEIGHT,
  SLOTS,
  slotCentre,
  slotLife,
  slotSpeed,
  SPRITE_FLOATS,
  stepFlock,
  TOAST_CELL,
  writeSprites,
} from "./toasters-sim";
import {
  DONENESS_OPTIONS,
  MAX_SPEED,
  MAX_TOAST,
  MAX_TOASTERS,
  toastersMeta,
} from "./toasters.meta";

const REF_WIDTH = 1920;
const DT = 1 / 30;

const params = (over: Partial<FlockParams> = {}): FlockParams => ({
  toasters: 10,
  toast: 6,
  doneness: "mixed",
  speed: 1,
  seed: 1,
  ...over,
});

/** Half the sprite's drawn extent, bob included, reference px. */
const extent = (layer: number) => CELL * LAYER_SIZE[layer] * (0.5 + BOB);

describe("flight", () => {
  it("heads down and to the left, slower and smaller with depth", () => {
    expect(DIR_X).toBeLessThan(0);
    expect(DIR_Y).toBeGreaterThan(0);
    expect(Math.hypot(DIR_X, DIR_Y)).toBeCloseTo(1);
    const f = createFlock(3);
    stepFlock(f, 0, REF_WIDTH, params({ seed: 3 }));
    // A whole layer apart outweighs the per-sprite jitter.
    const misordered: string[] = [];
    for (let s = 0; s < SLOTS; s++) {
      for (let t = 0; t < SLOTS; t++) {
        if (f.layer[s] < f.layer[t] && !(slotSpeed(f, s, 1) > slotSpeed(f, t, 1))) {
          misordered.push(`${String(s)} vs ${String(t)}`);
        }
      }
    }
    expect(misordered).toEqual([]);
    expect(new Set(f.layer).size).toBe(LAYER_SIZE.length);
  });

  it("wraps only while wholly out of view, from bottom-left to top-right", () => {
    for (const seed of [1, 2, 3]) {
      const f = createFlock(seed);
      const p = params({ seed, toasters: MAX_TOASTERS, toast: MAX_TOAST, speed: MAX_SPEED });
      stepFlock(f, 0, REF_WIDTH, p);
      const before: [number, number] = [0, 0];
      const after: [number, number] = [0, 0];
      const prevU = new Float64Array(SLOTS);
      const prevV = new Float64Array(SLOTS);
      const prevX = new Float64Array(SLOTS);
      const prevY = new Float64Array(SLOTS);
      const problems: string[] = [];
      let wraps = 0;
      for (let step = 0; step < 6000; step++) {
        for (let s = 0; s < SLOTS; s++) {
          slotCentre(f, s, REF_WIDTH, before);
          prevU[s] = f.u[s];
          prevV[s] = f.v[s];
          prevX[s] = before[0];
          prevY[s] = before[1];
        }
        stepFlock(f, DT, REF_WIDTH, p);
        for (let s = 0; s < SLOTS; s++) {
          const jumpedX = f.u[s] - prevU[s] > 0.5;
          const jumpedY = prevV[s] - f.v[s] > 0.5;
          if (!jumpedX && !jumpedY) {
            continue;
          }
          wraps++;
          slotCentre(f, s, REF_WIDTH, after);
          const ext = extent(f.layer[s]);
          const outX = (x: number) => x < -ext || x > REF_WIDTH + ext;
          const outY = (y: number) => y < -ext || y > REF_HEIGHT + ext;
          // Leaving past the left edge re-enters past the right; past the bottom, above the top.
          const ok =
            (!jumpedX || (outX(prevX[s]) && outX(after[0]) && after[0] > prevX[s])) &&
            (!jumpedY || (outY(prevY[s]) && outY(after[1]) && after[1] < prevY[s]));
          if (!ok && problems.length < 5) {
            problems.push(
              `seed ${String(seed)} slot ${String(s)}: (${String(prevX[s])}, ${String(prevY[s])}) -> (${String(after[0])}, ${String(after[1])})`,
            );
          }
        }
      }
      expect(problems).toEqual([]);
      expect(wraps).toBeGreaterThan(50);
    }
  });

  it("moves no sprite edge faster than a codec can follow, at any speed", () => {
    const { min, max } = toastersMeta.params.speed;
    expect(max).toBe(MAX_SPEED);
    for (const speed of [min, 1, max, max * 10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pxPerReferenceFrame(maxEdgeSpeed(speed) / REF_HEIGHT)).toBeLessThanOrEqual(
        MAX_FEATURE_PX_PER_FRAME,
      );
    }
    // And the simulation stays within that bound, a frame at a time.
    const f = createFlock(5);
    const p = params({ seed: 5, toasters: MAX_TOASTERS, speed: MAX_SPEED });
    stepFlock(f, 0, REF_WIDTH, p);
    const a: [number, number] = [0, 0];
    const b: [number, number] = [0, 0];
    const limit = maxEdgeSpeed(MAX_SPEED) * DT + 1e-9;
    let worst = 0;
    const prevX = new Float64Array(MAX_TOASTERS);
    const prevY = new Float64Array(MAX_TOASTERS);
    const prevU = new Float64Array(MAX_TOASTERS);
    const prevV = new Float64Array(MAX_TOASTERS);
    for (let step = 0; step < 600; step++) {
      for (let s = 0; s < MAX_TOASTERS; s++) {
        slotCentre(f, s, REF_WIDTH, a);
        prevX[s] = a[0];
        prevY[s] = a[1];
        prevU[s] = f.u[s];
        prevV[s] = f.v[s];
      }
      stepFlock(f, DT, REF_WIDTH, p);
      for (let s = 0; s < MAX_TOASTERS; s++) {
        // Skip the off-screen wrap jumps.
        if (Math.abs(f.u[s] - prevU[s]) > 0.5 || Math.abs(f.v[s] - prevV[s]) > 0.5) {
          continue;
        }
        slotCentre(f, s, REF_WIDTH, b);
        worst = Math.max(worst, Math.hypot(b[0] - prevX[s], b[1] - prevY[s]));
      }
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(limit);
  });

  it("stands still at zero speed, but keeps flapping", () => {
    const f = createFlock(2);
    const p = params({ seed: 2, speed: 0 });
    stepFlock(f, 0, REF_WIDTH, p);
    const u = [...f.u];
    const v = [...f.v];
    const phase = [...f.flapPhase];
    for (let step = 0; step < 10; step++) {
      stepFlock(f, DT, REF_WIDTH, p);
    }
    expect([...f.u]).toEqual(u);
    expect([...f.v]).toEqual(v);
    expect([...f.flapPhase].slice(0, MAX_TOASTERS)).not.toEqual(phase.slice(0, MAX_TOASTERS));
  });

  it("is deterministic per seed", () => {
    const run = (seed: number) => {
      const f = createFlock(seed);
      for (let step = 0; step < 300; step++) {
        stepFlock(f, DT, REF_WIDTH, params({ seed }));
      }
      return [...f.u, ...f.v, ...f.flapPhase];
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });
});

describe("count changes", () => {
  it("keep existing sprites where they were, fading the added ones in", () => {
    const steady = createFlock(4);
    const changed = createFlock(4);
    const justAdded: number[] = [];
    for (let step = 0; step < 200; step++) {
      stepFlock(steady, DT, REF_WIDTH, params({ seed: 4, toasters: 5, toast: 3 }));
      const more = step >= 100;
      stepFlock(
        changed,
        DT,
        REF_WIDTH,
        params({ seed: 4, toasters: more ? 12 : 5, toast: more ? 9 : 3 }),
      );
      if (step === 100) {
        justAdded.push(slotLife(changed, 11), slotLife(changed, MAX_TOASTERS + 8));
      }
    }
    // Just added: barely visible.
    expect(Math.max(...justAdded)).toBeLessThan(0.1);
    for (let s = 0; s < SLOTS; s++) {
      expect(changed.u[s]).toBe(steady.u[s]);
      expect(changed.v[s]).toBe(steady.v[s]);
    }
    for (let s = 0; s < 5; s++) {
      expect(slotLife(changed, s)).toBe(1);
    }
    expect(slotLife(changed, 11)).toBe(1);
    expect(slotLife(changed, 12)).toBe(0);
    expect(slotLife(changed, MAX_TOASTERS + 8)).toBe(1);
    expect(slotLife(changed, MAX_TOASTERS + 9)).toBe(0);
  });

  it("fade removed sprites out rather than dropping them", () => {
    const f = createFlock(6);
    stepFlock(f, DT, REF_WIDTH, params({ seed: 6, toasters: 10 }));
    stepFlock(f, DT, REF_WIDTH, params({ seed: 6, toasters: 4 }));
    expect(slotLife(f, 8)).toBeGreaterThan(0.5);
    for (let step = 0; step < 60; step++) {
      stepFlock(f, DT, REF_WIDTH, params({ seed: 6, toasters: 4 }));
    }
    expect(slotLife(f, 8)).toBe(0);
    expect(slotLife(f, 3)).toBe(1);
  });

  it("show the full counts at once on the first frame", () => {
    const f = createFlock(1);
    stepFlock(f, 0, REF_WIDTH, params());
    const out = new Float32Array(SLOTS * SPRITE_FLOATS);
    expect(writeSprites(f, out, REF_WIDTH, 1)).toBe(16);
  });
});

describe("wings", () => {
  it("flap through up, mid, down, mid", () => {
    expect([0, 0.25, 0.5, 0.75].map((t) => flapCell(t))).toEqual([...FLAP_CYCLE]);
    expect(FLAP_CYCLE).toEqual([0, 1, 2, 1]);
    expect(flapCell(1.1)).toBe(0);
    expect(flapCell(-0.1)).toBe(1);
  });

  it("advance at each toaster's own rate, out of step with each other", () => {
    const f = createFlock(9);
    const p = params({ seed: 9, toasters: MAX_TOASTERS });
    stepFlock(f, 0, REF_WIDTH, p);
    const seconds = 10;
    const dt = 1 / 120;
    const changes = Array.from({ length: MAX_TOASTERS }, () => 0);
    const last = Array.from({ length: MAX_TOASTERS }, (_, s) => flapCell(f.flapPhase[s]));
    const startFrames = new Set(last);
    for (let step = 0; step < seconds / dt; step++) {
      stepFlock(f, dt, REF_WIDTH, p);
      for (let s = 0; s < MAX_TOASTERS; s++) {
        const c = flapCell(f.flapPhase[s]);
        if (c !== last[s]) {
          changes[s]++;
          last[s] = c;
        }
      }
    }
    const rates = new Set<number>();
    for (let s = 0; s < MAX_TOASTERS; s++) {
      const rate = f.flapRate[s];
      rates.add(rate);
      expect(rate).toBeGreaterThanOrEqual(FLAP_MIN);
      expect(rate).toBeLessThanOrEqual(FLAP_MAX);
      // Four frame changes per beat.
      expect(Math.abs(changes[s] - 4 * rate * seconds)).toBeLessThanOrEqual(2);
    }
    expect(rates.size).toBe(MAX_TOASTERS);
    // Not all in the same frame at the start.
    expect(startFrames.size).toBeGreaterThan(1);
    const phases = new Set([...f.flapPhase].slice(0, MAX_TOASTERS).map((v) => v.toFixed(3)));
    expect(phases.size).toBe(MAX_TOASTERS);
  });
});

describe("toast", () => {
  it("eases between doneness levels instead of switching", () => {
    const f = createFlock(1);
    stepFlock(f, 0, REF_WIDTH, params({ doneness: "light" }));
    for (let s = MAX_TOASTERS; s < SLOTS; s++) {
      expect(f.doneness[s]).toBe(0);
    }
    for (let step = 0; step < 30; step++) {
      stepFlock(f, DT, REF_WIDTH, params({ doneness: "dark" }));
    }
    for (let s = MAX_TOASTERS; s < SLOTS; s++) {
      expect(f.doneness[s]).toBeCloseTo(1, 5);
    }
    for (let step = 0; step < 40; step++) {
      stepFlock(f, DT, REF_WIDTH, params({ doneness: "dark" }));
    }
    for (let s = MAX_TOASTERS; s < SLOTS; s++) {
      expect(f.doneness[s]).toBe(2);
    }
  });

  it("has a level for every doneness option", () => {
    const levels = DONENESS_OPTIONS.map((o) => {
      const f = createFlock(1);
      stepFlock(f, 0, REF_WIDTH, params({ doneness: o.value }));
      return [...f.doneness].slice(MAX_TOASTERS).join(",");
    });
    expect(new Set(levels).size).toBe(DONENESS_OPTIONS.length);
  });

  it("mixes all three levels with doneness Mixed", () => {
    const f = createFlock(1);
    stepFlock(f, 0, REF_WIDTH, params({ doneness: "mixed" }));
    const levels = new Set([...f.doneness].slice(MAX_TOASTERS));
    expect(levels).toEqual(new Set([0, 1, 2]));
  });
});

describe("instances", () => {
  it("are written farthest first, with valid cells", () => {
    const f = createFlock(2);
    const p = params({ seed: 2, toasters: MAX_TOASTERS, toast: MAX_TOAST });
    for (let step = 0; step < 37; step++) {
      stepFlock(f, DT, REF_WIDTH, p);
    }
    const out = new Float32Array(SLOTS * SPRITE_FLOATS);
    const n = writeSprites(f, out, REF_WIDTH, 2);
    expect(n).toBe(SLOTS);
    for (let k = 0; k < n; k++) {
      const o = k * SPRITE_FLOATS;
      expect(out[o + 2]).toBeGreaterThanOrEqual(k > 0 ? out[o + 2 - SPRITE_FLOATS] : 0);
      expect(out[o + 3]).toBe(1);
      expect(out[o + 4]).toBeGreaterThanOrEqual(0);
      expect(out[o + 5]).toBeLessThanOrEqual(TOAST_CELL + 2);
      expect(out[o + 6]).toBeGreaterThanOrEqual(0);
      expect(out[o + 6]).toBeLessThanOrEqual(1);
    }
  });

  it("dip and return when the seed changes, with a new layout", () => {
    const f = createFlock(1);
    stepFlock(f, DT, REF_WIDTH, params({ seed: 1 }));
    const u = [...f.u];
    stepFlock(f, DT, REF_WIDTH, params({ seed: 2 }));
    expect(f.presence).toBeLessThan(1);
    expect(f.presence).toBeGreaterThan(0);
    for (let step = 0; step < 60; step++) {
      stepFlock(f, DT, REF_WIDTH, params({ seed: 2 }));
    }
    expect(f.presence).toBe(1);
    expect(f.seed).toBe(2);
    expect([...f.u]).not.toEqual(u);
  });
});
