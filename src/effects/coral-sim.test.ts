import { describe, expect, it } from "vitest";
import {
  advanceCaustics,
  buildReef,
  CAUSTIC_RATES,
  CENTER_HEIGHT,
  createReef,
  cycleSeed,
  heightAt,
  INSTANCE_FLOATS,
  KIND_CAPSULE,
  KIND_DISC,
  LAST_ARRIVAL,
  layoutColonies,
  MAX_INSTANCES,
  PALETTES,
  paletteFor,
  SLOTS,
  type Reef,
} from "./coral-sim";
import { PALETTE_OPTIONS } from "./coral.meta";
import { createRng } from "./noise";

const ASPECT = 16 / 9;
const HEIGHT = 0.45;
const SEEDS = [1, 42, 777, 123456];
const reefs = SEEDS.map((s) => buildReef(s, ASPECT, 1, HEIGHT));

const field = (reef: Reef, i: number, k: number) => reef.data[i * INSTANCE_FLOATS + k];

describe("heightAt", () => {
  it("is lowest in the centre and reaches the param at the edges", () => {
    expect(heightAt(ASPECT / 2, ASPECT, HEIGHT)).toBeCloseTo(CENTER_HEIGHT);
    expect(heightAt(0, ASPECT, HEIGHT)).toBeCloseTo(HEIGHT);
    expect(heightAt(ASPECT, ASPECT, HEIGHT)).toBeCloseTo(HEIGHT);
    expect(heightAt(ASPECT * 0.25, ASPECT, HEIGHT)).toBeGreaterThan(CENTER_HEIGHT);
  });
});

describe("cycleSeed", () => {
  it("is deterministic and changes per cycle and per seed", () => {
    expect(cycleSeed(7, 3)).toBe(cycleSeed(7, 3));
    expect(cycleSeed(7, 3)).not.toBe(cycleSeed(7, 4));
    expect(cycleSeed(7, 3)).not.toBe(cycleSeed(8, 3));
  });
});

describe("layoutColonies", () => {
  it("scales with density, sorts far to near and keeps the middle to mounds", () => {
    const few = layoutColonies(createRng(3), ASPECT, 0.5);
    const many = layoutColonies(createRng(3), ASPECT, 2);
    expect(many.length).toBeGreaterThan(few.length);
    for (const list of [few, many]) {
      for (let i = 1; i < list.length; i++)
        expect(list[i].fog).toBeLessThanOrEqual(list[i - 1].fog);
      for (const c of list) {
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.x).toBeLessThanOrEqual(ASPECT);
        expect(c.slot).toBeGreaterThanOrEqual(0);
        expect(c.slot).toBeLessThan(SLOTS);
        expect(c.start).toBeLessThan(c.end);
        expect(c.end).toBeLessThanOrEqual(LAST_ARRIVAL);
      }
      const central = list.filter((c) => Math.abs(c.x - ASPECT / 2) < ASPECT * 0.15);
      expect(central.filter((c) => c.kind !== "mound")).toEqual([]);
    }
  });

  it("weights the bases towards the corners", () => {
    const list = layoutColonies(createRng(9), ASPECT, 2);
    const outer = list.filter((c) => Math.abs(c.x - ASPECT / 2) > ASPECT / 4).length;
    expect(outer).toBeGreaterThan(list.length / 2);
  });
});

describe("buildReef", () => {
  it("is deterministic per seed and differs between seeds", () => {
    const again = buildReef(SEEDS[0], ASPECT, 1, HEIGHT);
    expect(again.count).toBe(reefs[0].count);
    expect(Array.from(again.data.subarray(0, again.count * INSTANCE_FLOATS))).toEqual(
      Array.from(reefs[0].data.subarray(0, again.count * INSTANCE_FLOATS)),
    );
    expect(reefs[1].count).not.toBe(reefs[0].count);
  });

  it("builds all three colony types within the budget", () => {
    const kinds = new Set(reefs.flatMap((r) => r.colonies.map((c) => c.kind)));
    expect(kinds).toEqual(new Set(["branching", "fan", "mound"]));
    const dense = buildReef(5, 3, 2, 0.6);
    expect(dense.count).toBeLessThanOrEqual(MAX_INSTANCES);
    for (const reef of reefs) expect(reef.count).toBeGreaterThan(100);
  });

  it("stays within the frame and under the height envelope", () => {
    // Plain comparisons over every instance: an expect per sample dominates the runtime.
    const outside: string[] = [];
    reefs.forEach((reef, n) => {
      for (let i = 0; i < reef.count; i++) {
        for (const [x, y, r] of [
          [field(reef, i, 0), field(reef, i, 1), field(reef, i, 4)],
          [field(reef, i, 2), field(reef, i, 3), field(reef, i, 5)],
        ]) {
          const ok =
            x - r >= -1e-6 &&
            x + r <= ASPECT + 1e-6 &&
            y >= 0 &&
            y + r <= heightAt(x, ASPECT, HEIGHT) + 1e-6;
          if (!ok && outside.length < 10)
            outside.push(`reef ${n}, instance ${i}: ${x}, ${y}, r ${r}`);
        }
      }
    });
    expect(outside).toEqual([]);
  });

  it("keeps the region above the bottom centre clear", () => {
    let top = 0;
    for (const reef of reefs) {
      for (let i = 0; i < reef.count; i++) {
        const r = Math.max(field(reef, i, 4), field(reef, i, 5));
        for (const k of [0, 2]) {
          const x = field(reef, i, k);
          const y = field(reef, i, k + 1);
          if (Math.abs(x - ASPECT / 2) < ASPECT / 6) top = Math.max(top, y + r);
        }
      }
    }
    expect(top).toBeLessThan(0.1);
  });

  it("keeps arrivals ordered and in range", () => {
    const wrong: string[] = [];
    reefs.forEach((reef, n) => {
      for (let i = 0; i < reef.count; i++) {
        const t0 = field(reef, i, 6);
        const t1 = field(reef, i, 7);
        const kind = field(reef, i, 9);
        const ok =
          t0 >= 0 &&
          t1 >= t0 &&
          t1 <= LAST_ARRIVAL + 1e-6 &&
          (kind === KIND_CAPSULE || kind === KIND_DISC) &&
          // A disc grows over a span; a zero-span disc would pop in.
          (kind === KIND_CAPSULE || t1 > t0);
        if (!ok && wrong.length < 10)
          wrong.push(`reef ${n}, instance ${i}: ${t0}..${t1}, kind ${kind}`);
      }
    });
    expect(wrong).toEqual([]);
  });

  it("never shows a child before its parent's end, and tapers along each branch", () => {
    let children = 0;
    const wrong: string[] = [];
    reefs.forEach((reef, n) => {
      for (let i = 0; i < reef.count; i++) {
        const tapers = field(reef, i, 5) <= field(reef, i, 4) + 1e-9;
        if (!tapers && wrong.length < 10) wrong.push(`reef ${n}, instance ${i} widens`);
        const p = reef.parent[i];
        if (p < 0) continue;
        children++;
        const ok =
          p < i &&
          Object.is(reef.colony[p], reef.colony[i]) &&
          field(reef, i, 6) >= field(reef, p, 7) &&
          field(reef, i, 4) <= field(reef, p, 5) + 1e-9 &&
          // A child starts at its parent's end point (toBeCloseTo(_, 6): within half of 1e-6).
          Math.abs(field(reef, i, 0) - field(reef, p, 2)) < 5e-7 &&
          Math.abs(field(reef, i, 1) - field(reef, p, 3)) < 5e-7;
        if (!ok && wrong.length < 10) wrong.push(`reef ${n}, instance ${i}, parent ${p}`);
      }
    });
    expect(wrong).toEqual([]);
    expect(children).toBeGreaterThan(100);
  });

  it("reuses a reef's buffers and falls back on bad inputs", () => {
    const reef = createReef(500);
    buildReef(3, ASPECT, 2, 0.6, reef);
    expect(reef.count).toBeLessThanOrEqual(500);
    const odd = buildReef(3, Number.NaN, Number.NaN, Number.NaN);
    expect(odd.count).toBeGreaterThan(0);
  });
});

describe("palettes", () => {
  it("has one palette per option, and falls back to the reef", () => {
    for (const o of PALETTE_OPTIONS) expect(PALETTES[o.value].coral).toHaveLength(SLOTS);
    expect(paletteFor("nope")).toBe(PALETTES.reef);
    expect(paletteFor("toString")).toBe(PALETTES.reef);
  });
});

describe("advanceCaustics", () => {
  it("advances each phase at its rate and wraps to 0..2pi", () => {
    const phases = new Float32Array(CAUSTIC_RATES.length);
    advanceCaustics(phases, 2);
    for (let i = 0; i < phases.length; i++) {
      const want = (((2 * CAUSTIC_RATES[i]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      expect(phases[i]).toBeCloseTo(want, 5);
    }
    advanceCaustics(phases, 1e4);
    for (const p of phases) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(2 * Math.PI + 1e-6);
    }
    const before = Array.from(phases);
    advanceCaustics(phases, Number.NaN);
    expect(Array.from(phases)).toEqual(before);
  });
});
