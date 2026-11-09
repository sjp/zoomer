import { describe, expect, it } from "vitest";
import {
  AGENT_FLOATS,
  AGENT_TIERS,
  agentCount,
  buildPaletteLut,
  calmMask,
  depositAmount,
  FOOD_COUNT,
  foodPositions,
  gridSize,
  LUT_SIZE,
  MAX_GRID,
  MAX_STEPS,
  MEAN_TRAIL,
  PALETTES,
  physarumStep,
  seedAgents,
  type StepClock,
  type StepConfig,
  STEP_RATE,
  stepSalt,
  takeSteps,
  TRAIL_MAX,
  turn,
  TURN_ANGLE,
  JITTER,
} from "./physarum-sim";
import { AGENT_OPTIONS, PALETTE_OPTIONS } from "./physarum.meta";
import { firstDifference } from "../../test/bytes";

const W = 48;
const H = 27;

function run(seed: number, steps: number, overrides: Partial<StepConfig> = {}) {
  const count = 600;
  const agents = seedAgents(seed, count, new Float32Array(count * AGENT_FLOATS));
  let trail = new Float32Array(W * H);
  let next = new Float32Array(W * H);
  const food = new Float32Array(FOOD_COUNT * 2);
  const cfg: StepConfig = {
    speed: 0.5,
    decay: 0.15,
    deposit: depositAmount(0.15, W * H, count),
    food,
    calmCentre: true,
    salt: 0,
    ...overrides,
  };
  const maxes: number[] = [];
  for (let s = 0; s < steps; s++) {
    if (cfg.food) {
      foodPositions(s / STEP_RATE, cfg.food);
    }
    cfg.salt = stepSalt(s);
    physarumStep(trail, next, W, H, agents, count, cfg);
    [trail, next] = [next, trail];
    maxes.push(Math.max(...trail));
  }
  return { agents, trail, count, cfg, maxes };
}

describe("physarumStep", () => {
  it("keeps agents in bounds, wrapping at the edges", () => {
    // Fast agents cross the edges many times in 200 steps.
    const { agents, count } = run(1, 200, { speed: 1.5 });
    let firstBad: { i: number; x: number; y: number; angle: number } | undefined;
    for (let i = 0; i < count && !firstBad; i++) {
      const o = i * AGENT_FLOATS;
      const [x, y, angle] = [agents[o], agents[o + 1], agents[o + 2]];
      if (!(x >= 0 && x < 1 && y >= 0 && y < 1 && angle >= 0 && angle < Math.PI * 2)) {
        firstBad = { i, x, y, angle };
      }
    }
    expect(firstBad).toBeUndefined();
  });

  it("keeps the trail bounded and non-negative under decay", () => {
    const { trail, maxes, cfg, count } = run(2, 300);
    let min = Infinity;
    let nonFinite = 0;
    for (const v of trail) {
      min = Math.min(min, v);
      if (!Number.isFinite(v)) {
        nonFinite++;
      }
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(nonFinite).toBe(0);
    // The diffuse pass clamps to TRAIL_MAX; at most every agent's deposit lands on top.
    expect(Math.max(...maxes)).toBeLessThanOrEqual(TRAIL_MAX + count * cfg.deposit);
    // The deposit normalisation holds the mean near MEAN_TRAIL (the calm centre's extra decay
    // pulls it a little lower).
    const mean = trail.reduce((a, b) => a + b, 0) / trail.length;
    expect(mean).toBeGreaterThan(MEAN_TRAIL * 0.5);
    expect(mean).toBeLessThan(MEAN_TRAIL * 1.2);
  });

  it("decays an empty-agent trail towards zero", () => {
    const trail = new Float32Array(W * H).fill(1);
    const out = new Float32Array(W * H);
    const cfg: StepConfig = {
      speed: 0.5,
      decay: 0.1,
      deposit: 0,
      food: null,
      calmCentre: false,
      salt: 0,
    };
    physarumStep(trail, out, W, H, new Float32Array(0), 0, cfg);
    for (const v of out) {
      expect(v).toBeCloseTo(0.9, 6);
    }
  });

  it("is deterministic per seed", () => {
    const a = run(7, 50);
    const b = run(7, 50);
    const c = run(8, 50);
    expect(firstDifference(a.agents, b.agents)).toBe(-1);
    expect(firstDifference(a.trail, b.trail)).toBe(-1);
    expect(firstDifference(a.agents, c.agents)).not.toBe(-1);
  });

  it("thins the calm centre", () => {
    const { trail } = run(3, 400);
    let centre = 0;
    let centreCells = 0;
    let sides = 0;
    let sideCells = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const m = calmMask((x + 0.5) / W, (y + 0.5) / H);
        if (m > 0.9) {
          centre += trail[y * W + x];
          centreCells++;
        } else if (m === 0) {
          sides += trail[y * W + x];
          sideCells++;
        }
      }
    }
    expect(centre / centreCells).toBeLessThan(sides / sideCells);
  });
});

describe("turn", () => {
  const noJitter = 0x8000 << 16;
  it("keeps straight when forward is strongest", () => {
    expect(turn(1, 0.5, 0.5, noJitter)).toBeCloseTo(0, 9);
  });
  it("turns towards the stronger side", () => {
    expect(turn(0.5, 1, 0.2, noJitter)).toBeCloseTo(TURN_ANGLE, 9);
    expect(turn(0.5, 0.2, 1, noJitter)).toBeCloseTo(-TURN_ANGLE, 9);
  });
  it("turns at random when forward is weakest", () => {
    expect(turn(0, 1, 1, noJitter)).toBeCloseTo(TURN_ANGLE, 9);
    expect(turn(0, 1, 1, noJitter | 1)).toBeCloseTo(-TURN_ANGLE, 9);
  });
  it("jitters by at most half of JITTER", () => {
    expect(Math.abs(turn(1, 0, 0, 0))).toBeLessThanOrEqual(JITTER / 2);
    expect(Math.abs(turn(1, 0, 0, 0xffff0000))).toBeLessThanOrEqual(JITTER / 2);
  });
});

describe("step clock", () => {
  it("runs STEP_RATE steps a second at display rate", () => {
    const clock: StepClock = { acc: 0 };
    let total = 0;
    for (let i = 0; i < 120; i++) {
      total += takeSteps(clock, STEP_RATE, 1 / 120, MAX_STEPS);
    }
    expect(total).toBe(STEP_RATE);
  });
  it("caps the steps in one long frame and drops the excess", () => {
    const clock: StepClock = { acc: 0 };
    expect(takeSteps(clock, STEP_RATE, 0.1, MAX_STEPS)).toBe(MAX_STEPS);
    expect(clock.acc).toBeLessThan(1);
    expect(takeSteps(clock, STEP_RATE, 10, MAX_STEPS)).toBe(MAX_STEPS);
    expect(takeSteps(clock, STEP_RATE, 0, MAX_STEPS)).toBe(0);
  });
});

describe("sizes and tiers", () => {
  it("gives the same grid at every resolution for the same reference cell", () => {
    expect(gridSize(1920, 1080, 3.75)).toEqual([512, 288]);
    expect(gridSize(3840, 2160, 7.5)).toEqual([512, 288]);
    expect(gridSize(100000, 10, 1)).toEqual([MAX_GRID, 10]);
    expect(gridSize(1, 1, 0)).toEqual([1, 1]);
  });

  it("lists every tier and falls back to medium", () => {
    expect(AGENT_OPTIONS.map((o) => o.value)).toEqual(Object.keys(AGENT_TIERS));
    expect(agentCount("high")).toBe(AGENT_TIERS.high.count);
    expect(agentCount("nope")).toBe(AGENT_TIERS.medium.count);
    expect(agentCount("constructor")).toBe(AGENT_TIERS.medium.count);
  });

  it("normalises the deposit to the mean trail level", () => {
    expect(depositAmount(0.1, 1000, 500) * 500).toBeCloseTo(MEAN_TRAIL * 0.1 * 1000, 9);
    expect(depositAmount(0.1, 1000, 0)).toBe(0);
  });
});

describe("palettes", () => {
  it.each(PALETTE_OPTIONS.map((o) => o.value))("%s runs dark to bright", (id) => {
    const lut = buildPaletteLut(id, new Uint8Array(LUT_SIZE * 4));
    const luma = (i: number) => lut[i * 4] * 0.3 + lut[i * 4 + 1] * 0.59 + lut[i * 4 + 2] * 0.11;
    expect(luma(0)).toBeLessThan(12);
    expect(luma(LUT_SIZE - 1)).toBeGreaterThan(200);
    for (let i = 1; i < LUT_SIZE; i++) {
      expect(luma(i)).toBeGreaterThanOrEqual(luma(i - 1) - 0.5);
    }
    for (let i = 0; i < LUT_SIZE; i++) {
      expect(lut[i * 4 + 3]).toBe(255);
    }
  });

  it("starts each palette at its first stop and falls back to gold", () => {
    const lut = buildPaletteLut("nope", new Uint8Array(LUT_SIZE * 4));
    expect([...lut.subarray(0, 4)]).toEqual([6, 5, 8, 255]);
    expect(PALETTES.gold.stops[0][1]).toBe("#060508");
  });
});

describe("food", () => {
  it("stays near the edges and out of the calm centre", () => {
    const out = new Float32Array(FOOD_COUNT * 2);
    for (let t = 0; t < 600; t += 0.7) {
      foodPositions(t, out);
      for (let i = 0; i < FOOD_COUNT; i++) {
        const x = out[i * 2];
        const y = out[i * 2 + 1];
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(1);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(1);
        expect(Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5))).toBeGreaterThan(0.3);
        expect(calmMask(x, y)).toBeLessThan(0.1);
      }
    }
  });

  it("drifts slowly", () => {
    const a = foodPositions(100, new Float32Array(FOOD_COUNT * 2));
    const b = foodPositions(100 + 1 / STEP_RATE, new Float32Array(FOOD_COUNT * 2));
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(a[i] - b[i])).toBeLessThan(0.001);
    }
  });
});
