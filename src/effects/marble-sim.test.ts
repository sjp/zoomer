import { describe, expect, it } from "vitest";
import {
  BAKE_AT,
  BAKE_FORCE_AT,
  BAKE_MIN_INTERVAL,
  createMarble,
  ease,
  forward,
  inverse,
  isDone,
  KIND_DROP,
  KIND_SWIRL,
  MAX_COLOURS,
  MAX_OPS,
  marblePalette,
  OP_FLOATS,
  packOps,
  PALETTES,
  STROKE_MODES,
  tineDistance,
  type MarbleOp,
} from "./marble-sim";
import { createRng } from "./noise";
import { PALETTE_OPTIONS, STROKE_OPTIONS } from "./marble.meta";

function makeOp(partial: Partial<MarbleOp> & { kind: number }): MarbleOp {
  return {
    x: 0,
    y: 0,
    amount: 0,
    dx: 1,
    dy: 0,
    falloff: 1,
    spacing: 1,
    colour: 0,
    start: 0,
    duration: 1,
    ...partial,
  };
}

const a = Math.cos(0.4);
const b = Math.sin(0.4);
const SAMPLE_OPS: MarbleOp[] = [
  makeOp({ kind: KIND_DROP, x: 30, y: -20, amount: 80 }),
  makeOp({ kind: KIND_SWIRL, x: -40, y: 10, amount: 2.7, falloff: 120 }),
  makeOp({ kind: KIND_SWIRL, x: 0, y: 0, amount: -3.1, falloff: 60 }),
  makeOp({ kind: 1, x: 5, y: 7, amount: 180, dx: a, dy: b, falloff: 30 }),
  makeOp({ kind: 9, x: 12, y: -3, amount: -120, dx: 0, dy: 1, falloff: 11, spacing: 70 }),
  makeOp({ kind: 4, x: 0, y: 0, amount: 90, dx: -b, dy: a, falloff: 8, spacing: 55 }),
];

describe("operation maps", () => {
  it("round-trip forward then inverse to within 1e-6 at any progress", () => {
    const rng = createRng(1);
    const fwd = new Float64Array(2);
    const back = new Float64Array(2);
    let worst = 0;
    let failedInverse = 0;
    for (const op of SAMPLE_OPS) {
      for (const e of [0, 0.3, 1]) {
        for (let n = 0; n < 400; n++) {
          const x = (rng() - 0.5) * 1200;
          const y = (rng() - 0.5) * 800;
          forward(op, e, x, y, fwd);
          if (!inverse(op, e, fwd[0], fwd[1], back)) {
            failedInverse++;
          }
          worst = Math.max(worst, Math.hypot(back[0] - x, back[1] - y));
        }
      }
    }
    expect(failedInverse).toBe(0);
    expect(worst).toBeLessThan(1e-6);
  });

  it("round-trip inverse then forward outside drops", () => {
    const rng = createRng(2);
    const back = new Float64Array(2);
    const fwd = new Float64Array(2);
    let worst = 0;
    for (const op of SAMPLE_OPS) {
      for (let n = 0; n < 400; n++) {
        const x = (rng() - 0.5) * 1200;
        const y = (rng() - 0.5) * 800;
        if (!inverse(op, 1, x, y, back)) {
          continue;
        }
        forward(op, 1, back[0], back[1], fwd);
        worst = Math.max(worst, Math.hypot(fwd[0] - x, fwd[1] - y));
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("are the identity at zero progress", () => {
    const out = new Float64Array(2);
    let worst = 0;
    for (const op of SAMPLE_OPS) {
      for (const [x, y] of [
        [3, 4],
        [-200, 50],
        [31, -21],
      ]) {
        forward(op, 0, x, y, out);
        worst = Math.max(worst, Math.hypot(out[0] - x, out[1] - y));
      }
    }
    expect(worst).toBe(0);
  });

  it("drop pushes points out so the disc is new paint, and the inverse flags it", () => {
    const op = SAMPLE_OPS[0];
    const out = new Float64Array(2);
    expect(inverse(op, 1, op.x + 10, op.y + 5, out)).toBe(false);
    expect(out[0]).toBe(op.x);
    expect(out[1]).toBe(op.y);
    // A point at distance d lands at sqrt(d^2 + r^2).
    forward(op, 1, op.x + 60, op.y, out);
    expect(out[0] - op.x).toBeCloseTo(Math.hypot(60, 80), 9);
    // Half progress gives half the area.
    forward(op, 0.5, op.x + 60, op.y, out);
    expect((out[0] - op.x) ** 2 - 60 ** 2).toBeCloseTo((80 * 80) / 2, 6);
  });

  it("preserve area outside drops (unit Jacobian determinant)", () => {
    const rng = createRng(3);
    const h = 1e-4;
    const p0 = new Float64Array(2);
    const px = new Float64Array(2);
    const py = new Float64Array(2);
    let worst = 0;
    for (const op of SAMPLE_OPS) {
      for (let n = 0; n < 300; n++) {
        const x = (rng() - 0.5) * 1000;
        const y = (rng() - 0.5) * 700;
        // Skip points next to a comb's tine, where the map has a crease.
        if (op.kind >= 1 && tineDistance(op, x, y) < 0.01) {
          continue;
        }
        forward(op, 1, x, y, p0);
        forward(op, 1, x + h, y, px);
        forward(op, 1, x, y + h, py);
        const det =
          ((px[0] - p0[0]) * (py[1] - p0[1]) - (px[1] - p0[1]) * (py[0] - p0[0])) / (h * h);
        worst = Math.max(worst, Math.abs(det - 1));
      }
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it("drop keeps the area of an annulus outside it", () => {
    const op = SAMPLE_OPS[0];
    const out = new Float64Array(2);
    const r1 = 20;
    const r2 = 150;
    forward(op, 1, op.x + r1, op.y, out);
    const R1 = out[0] - op.x;
    forward(op, 1, op.x + r2, op.y, out);
    const R2 = out[0] - op.x;
    expect(R2 * R2 - R1 * R1).toBeCloseTo(r2 * r2 - r1 * r1, 6);
  });

  it("finds the nearest tine of a comb", () => {
    const comb = makeOp({ kind: 3, x: 0, y: 0, dx: 1, dy: 0, spacing: 50 });
    expect(tineDistance(comb, 0, 0)).toBe(0);
    expect(tineDistance(comb, 99, 50)).toBe(0);
    expect(tineDistance(comb, 0, 20)).toBe(20);
    expect(tineDistance(comb, 0, 30)).toBe(20);
    // Past the last tine, the distance keeps growing.
    expect(tineDistance(comb, 0, -120)).toBe(70);
    const even = makeOp({ kind: 2, x: 0, y: 0, dx: 1, dy: 0, spacing: 50 });
    expect(tineDistance(even, 0, 25)).toBe(0);
    expect(tineDistance(even, 0, 0)).toBe(25);
  });
});

describe("packing", () => {
  it("packs each kind with its strength at the current progress", () => {
    const ops = [
      makeOp({ kind: KIND_DROP, x: 1, y: 2, amount: 10, colour: 3, start: 0, duration: 2 }),
      makeOp({ kind: KIND_SWIRL, x: 3, y: 4, amount: 2, falloff: 50, start: 0, duration: 2 }),
      makeOp({ kind: 5, amount: 100, dx: 0, dy: 1, falloff: 10, spacing: 60, duration: 2 }),
    ];
    const pa = new Float32Array(MAX_OPS * OP_FLOATS);
    const pb = new Float32Array(MAX_OPS * OP_FLOATS);
    packOps(ops, 0, 3, 1, pa, pb);
    expect(Array.from(pa.subarray(0, 4))).toEqual([0, 1, 2, 50]);
    expect(Array.from(pb.subarray(0, 4))).toEqual([3, 0, 0, 0]);
    expect(pa[4]).toBe(-1);
    expect(pa[7]).toBeCloseTo(1, 6);
    expect(pb[4]).toBeCloseTo(0.02, 6);
    expect(pa[8]).toBe(5);
    expect(pa[11]).toBeCloseTo(50, 5);
    expect(Array.from(pb.subarray(8, 12))).toEqual([0, 1, Math.fround(0.1), 60]);
    packOps(ops, 1, 1, 5, pa, pb);
    expect(pa[0]).toBe(-1);
    expect(pa[3]).toBe(2);
  });
});

describe("scheduler", () => {
  const EXTENT = { hx: 960, hy: 540 };

  it("bakes before the queue exceeds its uniform capacity", () => {
    let violations = 0;
    let bakes = 0;
    let earlyBakes = 0;
    let incompleteBakes = 0;
    let longest = 0;
    for (const strokes of STROKE_MODES) {
      for (const [speed, drops] of [
        [3, 6],
        [1, 1.5],
        [0.25, 0],
      ]) {
        const sim = createMarble({ seed: 5, colours: 5, extent: EXTENT });
        let sinceBake = 0;
        for (let i = 0; i < 20 * 60 * 10; i++) {
          sim.step(0.1, { speed, drops, strokes }, EXTENT);
          sinceBake += 0.1;
          longest = Math.max(longest, sim.ops.length);
          if (sim.ops.length > MAX_OPS) {
            violations++;
          }
          const k = sim.bakeCount();
          if (k > 0) {
            if (sim.ops.length < BAKE_FORCE_AT && sinceBake < BAKE_MIN_INTERVAL - 1e-9) {
              earlyBakes++;
            }
            for (let j = 0; j < k; j++) {
              if (!isDone(sim.ops[j], sim.time)) {
                incompleteBakes++;
              }
            }
            sim.commitBake(k);
            sinceBake = 0;
            bakes++;
          }
        }
      }
    }
    expect(violations).toBe(0);
    expect(earlyBakes).toBe(0);
    expect(incompleteBakes).toBe(0);
    expect(longest).toBeGreaterThanOrEqual(BAKE_AT);
    expect(bakes).toBeGreaterThan(20);
  });

  it("starts with finished rings and keeps adding strokes and drops", () => {
    const sim = createMarble({ seed: 1, colours: 6, extent: EXTENT });
    const initial = sim.ops.length;
    expect(initial).toBeGreaterThanOrEqual(9);
    expect(initial).toBeLessThan(BAKE_AT);
    expect(sim.ops.every((op) => op.kind === KIND_DROP && isDone(op, 0))).toBe(true);
    const kinds = new Set<string>();
    for (let i = 0; i < 6000; i++) {
      sim.step(0.05, { speed: 1, drops: 3, strokes: "mixed" }, EXTENT);
      const last = sim.ops[sim.ops.length - 1];
      kinds.add(last.kind === KIND_DROP ? "drop" : last.kind === KIND_SWIRL ? "swirl" : "comb");
      const k = sim.bakeCount();
      if (k) {
        sim.commitBake(k);
      }
    }
    expect([...kinds].toSorted()).toEqual(["comb", "drop", "swirl"]);
    expect(sim.bakes).toBeGreaterThan(0);
  });

  it("only uses the chosen stroke kinds, and colours within the palette", () => {
    for (const strokes of ["combs", "swirls"]) {
      const sim = createMarble({ seed: 2, colours: 4, extent: EXTENT });
      let wrong = 0;
      let badColour = 0;
      for (let i = 0; i < 4000; i++) {
        sim.step(0.1, { speed: 2, drops: 2, strokes }, EXTENT);
        for (const op of sim.ops) {
          if (strokes === "combs" && op.kind === KIND_SWIRL) {
            wrong++;
          }
          if (strokes === "swirls" && op.kind > 1) {
            wrong++;
          }
          if (op.kind === KIND_DROP && (op.colour < 0 || op.colour >= 4)) {
            badColour++;
          }
        }
        const k = sim.bakeCount();
        if (k) {
          sim.commitBake(k);
        }
      }
      expect(wrong).toBe(0);
      expect(badColour).toBe(0);
    }
  });

  it("is deterministic per seed", () => {
    const run = (seed: number) => {
      const sim = createMarble({ seed, colours: 5, extent: EXTENT });
      for (let i = 0; i < 1000; i++) {
        sim.step(0.1, { speed: 1, drops: 2, strokes: "mixed" }, EXTENT);
      }
      return JSON.stringify(sim.ops);
    };
    expect(run(7)).toBe(run(7));
    expect(run(7)).not.toBe(run(8));
  });

  it("survives bad input", () => {
    const sim = createMarble({ seed: Number.NaN, colours: 99, extent: EXTENT });
    expect(sim.seed).toBe(0);
    expect(sim.colours).toBe(MAX_COLOURS);
    sim.step(Number.NaN, { speed: Number.NaN, drops: Number.NaN, strokes: "?" }, EXTENT);
    sim.step(-1, { speed: -2, drops: -1, strokes: "?" }, EXTENT);
    expect(Number.isFinite(sim.time)).toBe(true);
    sim.commitBake(0);
    expect(sim.bakes).toBe(0);
  });
});

describe("palettes and options", () => {
  it("has 3 to 6 colours per palette and an option per palette", () => {
    for (const p of Object.values(PALETTES)) {
      expect(p.colours.length).toBeGreaterThanOrEqual(3);
      expect(p.colours.length).toBeLessThanOrEqual(MAX_COLOURS);
    }
    expect(PALETTE_OPTIONS.map((o) => o.value).toSorted()).toEqual(
      Object.keys(PALETTES).toSorted(),
    );
    expect(STROKE_OPTIONS.map((o) => o.value)).toEqual([...STROKE_MODES]);
    expect(marblePalette("nope")).toBe(PALETTES.classic);
  });

  it("eases from 0 to 1, clamped", () => {
    expect(ease(-1)).toBe(0);
    expect(ease(0.5)).toBe(0.5);
    expect(ease(2)).toBe(1);
  });
});
