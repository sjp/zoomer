import { describe, expect, it } from "vitest";
import {
  advanceLife,
  buildPaletteLut,
  buildTaps,
  centreOfMass,
  createLife,
  CREATURE_MASS,
  DEAD_MAX,
  FADE_SECONDS,
  fillPatch,
  FULL_MEAN,
  GRID_W,
  gridSize,
  growth,
  KERNEL_B,
  KERNEL_R,
  kernelShell,
  leniaStep,
  LUT_SIZE,
  judgeStats,
  mass,
  MAX_SPAWNS,
  packState,
  PALETTES,
  PATCH_RADIUS,
  PATCH_SEEDS,
  PATCH_SIZE,
  PATCH_SPACING,
  pickSpawnSpot,
  potential,
  readStats,
  RULES,
  type RuleId,
  seedField,
  SETTLE_STEPS,
  SPECIES,
  speciesFor,
  spawnPatch,
  STATS_SIZE,
  statsTile,
  TAPS,
} from "./lenia-sim";
import { PALETTE_OPTIONS, SPECIES_OPTIONS } from "./lenia.meta";
import { createRng } from "../noise";

describe("kernel", () => {
  it("sums to 1 with positive weights inside the radius", () => {
    let sum = 0;
    let bad = 0;
    for (let i = 0; i < TAPS.count; i++) {
      const [x, y, w] = TAPS.data.subarray(i * 3, i * 3 + 3);
      sum += 2 * w;
      if (!(w > 0) || Math.hypot(Math.abs(x) + 0.5, y) > KERNEL_R + 1 || y < 0) {
        bad++;
      }
    }
    expect(bad).toBe(0);
    expect(sum).toBeCloseTo(1, 5);
    // Pairing halves the half disc: well under the ~528 cells of the full disc.
    expect(TAPS.count).toBeLessThan(150);
  });

  it("matches the full kernel cell by cell (pairs and symmetry are exact)", () => {
    const w = 40;
    const h = 36;
    const rng = createRng(3);
    const A = new Float32Array(w * h).map(() => rng());
    // Brute force: every cell of the disc with its normalised shell weight.
    const R = KERNEL_R;
    let total = 0;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        total += kernelShell(Math.hypot(dx, dy) / R, KERNEL_B);
      }
    }
    let worst = 0;
    for (const [x, y] of [
      [0, 0],
      [5, 17],
      [39, 35],
      [20, 3],
    ]) {
      let u = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const k = kernelShell(Math.hypot(dx, dy) / R, KERNEL_B) / total;
          u += k * A[((y + dy + h) % h) * w + ((x + dx + w) % w)];
        }
      }
      worst = Math.max(worst, Math.abs(potential(A, w, h, x, y, TAPS) - u));
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it("gives a constant field back unchanged", () => {
    const A = new Float32Array(32 * 32).fill(0.4);
    expect(potential(A, 32, 32, 7, 9, TAPS, 8)).toBeCloseTo(0.4, 5);
  });

  it("builds multi-peak kernels too", () => {
    const t = buildTaps(10, [0.5, 1]);
    let sum = 0;
    for (let i = 0; i < t.count; i++) {
      sum += 2 * t.data[i * 3 + 2];
    }
    expect(sum).toBeCloseTo(1, 5);
  });
});

describe("growth", () => {
  it("is bounded in [-1, 1] and peaks at mu", () => {
    for (const rule of Object.values(RULES)) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let u = 0; u <= 1; u += 0.001) {
        const g = growth(u, rule.mu, rule.sigma);
        lo = Math.min(lo, g);
        hi = Math.max(hi, g);
      }
      expect(lo).toBeGreaterThanOrEqual(-1);
      expect(hi).toBeLessThanOrEqual(1);
      expect(growth(rule.mu, rule.mu, rule.sigma)).toBe(1);
    }
  });
});

describe("rules and species", () => {
  it("share the tap table's kernel", () => {
    for (const rule of Object.values(RULES)) {
      expect(rule.R).toBe(KERNEL_R);
      expect(rule.b).toEqual(KERNEL_B);
    }
  });

  it("cover every species option and fall back for unknown ids", () => {
    for (const o of SPECIES_OPTIONS) {
      expect(SPECIES[o.value].rules.length).toBeGreaterThan(0);
    }
    expect(speciesFor("nope")).toBe(SPECIES.mixed);
    for (const id of Object.keys(RULES) as RuleId[]) {
      expect(PATCH_SEEDS[id]).toBeDefined();
      expect(CREATURE_MASS[id]).toBeGreaterThan(0);
    }
  });
});

describe("CPU step", () => {
  // A 64 x 64 wrapping grid; the GPU's 16-bit state and 8-bit filter weights.
  const W = 64;
  const H = 64;
  const opts = { quantise: true, fracBits: 8 };

  it("grows a generated Orbium seed into a glider: bounded mass, moving centre", () => {
    let A = new Float32Array(W * H);
    let B = new Float32Array(W * H);
    const patch = fillPatch(PATCH_SEEDS.orbium[0], 0, new Float32Array(PATCH_SIZE * PATCH_SIZE));
    const c = (PATCH_SIZE - 1) / 2;
    for (let y = 0; y < PATCH_SIZE; y++) {
      for (let x = 0; x < PATCH_SIZE; x++) {
        A[((y - c + H / 2 + H) % H) * W + ((x - c + W / 2 + W) % W)] = patch[y * PATCH_SIZE + x];
      }
    }
    const masses: number[] = [];
    const com = new Float64Array(2);
    const path: number[] = [];
    let outOfRange = 0;
    for (let i = 1; i <= 150; i++) {
      leniaStep(A, B, W, H, RULES.orbium, TAPS, opts);
      [A, B] = [B, A];
      for (const a of A) {
        if (!(a >= 0 && a <= 1)) {
          outOfRange++;
        }
      }
      if (i % 50 === 0) {
        masses.push(mass(A));
        centreOfMass(A, W, H, com);
        path.push(com[0], com[1]);
      }
    }
    expect(outOfRange).toBe(0);
    // Settled to one creature's mass, steady over the last 100 steps.
    expect(Math.abs(masses[2] - CREATURE_MASS.orbium)).toBeLessThan(5);
    expect(Math.abs(masses[2] - masses[1]) / masses[2]).toBeLessThan(0.03);
    // And it moves: wrapped displacement over the last 50 steps.
    const dx = Math.abs(path[4] - path[2]);
    const dy = Math.abs(path[5] - path[3]);
    const moved = Math.hypot(Math.min(dx, W - dx), Math.min(dy, H - dy));
    expect(moved).toBeGreaterThan(5);
  });

  it("steps every cell as A + dt * G(K * A)", () => {
    const w = 30;
    const h = 28;
    const rng = createRng(9);
    const A = new Float32Array(w * h).map(() => rng() * 0.3);
    const B = new Float32Array(w * h);
    const rule = RULES.orbium;
    leniaStep(A, B, w, h, rule, TAPS, { fracBits: 8 });
    let worst = 0;
    for (const [x, y] of [
      [0, 0],
      [29, 27],
      [13, 4],
    ]) {
      const u = potential(A, w, h, x, y, TAPS, 8);
      const v = Math.min(1, Math.max(0, A[y * w + x] + growth(u, rule.mu, rule.sigma) / rule.T));
      worst = Math.max(worst, Math.abs(B[y * w + x] - v));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("lets an empty field stay empty and a full one die back", () => {
    const A = new Float32Array(48 * 48);
    const B = new Float32Array(48 * 48);
    leniaStep(A, B, 48, 48, RULES.orbium);
    expect(mass(B)).toBe(0);
    A.fill(1);
    leniaStep(A, B, 48, 48, RULES.orbium);
    expect(Math.abs(mass(B) - 0.9 * 48 * 48)).toBeLessThan(1);
  });
});

describe("seeding", () => {
  it("draws patches as discs, the same values in every orientation", () => {
    const base = fillPatch(30, 0, new Float32Array(PATCH_SIZE * PATCH_SIZE));
    const sorted = (a: Float32Array) => [...a].filter((v) => v > 0).toSorted((p, q) => p - q);
    const ref = sorted(base);
    expect(ref.length).toBeGreaterThan(Math.PI * (PATCH_RADIUS - 1) ** 2);
    let mismatches = 0;
    for (let o = 1; o < 8; o++) {
      const p = sorted(fillPatch(30, o, new Float32Array(PATCH_SIZE * PATCH_SIZE)));
      if (p.length !== ref.length || p.some((v, i) => v !== ref[i])) {
        mismatches++;
      }
    }
    expect(mismatches).toBe(0);
    // A quarter turn moves cell (x, y) from the centre to (-y, x).
    const q = fillPatch(30, 1, new Float32Array(PATCH_SIZE * PATCH_SIZE));
    const c = (PATCH_SIZE - 1) / 2;
    expect(q[(c + 5) * PATCH_SIZE + c - 3]).toBe(base[(c + 3) * PATCH_SIZE + c + 5]);
  });

  it("uses listed seeds for creatures and fresh ones for soup", () => {
    const a = new Float32Array(PATCH_SIZE * PATCH_SIZE);
    const b = new Float32Array(PATCH_SIZE * PATCH_SIZE);
    spawnPatch(0, "orbium", false, a);
    fillPatch(PATCH_SEEDS.orbium[0], 0, b);
    expect(a).toEqual(b);
    spawnPatch(0, "orbium", true, a);
    expect(a).not.toEqual(b);
    // A rule with no listed seeds always gets soup, without throwing.
    expect(mass(spawnPatch(0.5, "gyrans", false, a))).toBeGreaterThan(100);
  });

  it("is deterministic per seed, in range and spread apart", () => {
    const [w, h] = gridSize(1920, 1080);
    const a = seedField(5, "orbium", false, 6, w, h, new Float32Array(w * h));
    const b = seedField(5, "orbium", false, 6, w, h, new Float32Array(w * h));
    const c = seedField(6, "orbium", false, 6, w, h, new Float32Array(w * h));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    let bad = 0;
    for (const v of a) {
      if (!(v >= 0 && v <= 1)) {
        bad++;
      }
    }
    expect(bad).toBe(0);
    // Mass of one to six patches (each about half its disc), none overlapping.
    const per = Math.PI * PATCH_RADIUS * PATCH_RADIUS * 0.5;
    expect(mass(a)).toBeGreaterThan(0.7 * per);
    expect(mass(a)).toBeLessThan(6.3 * per);
    expect(PATCH_SPACING).toBeGreaterThan(2 * PATCH_RADIUS);
  });
});

describe("packState", () => {
  it("stores A in 16 bits that decode back", () => {
    const A = new Float32Array([0, 1, 0.5, 0.123456, 0.99999]);
    const bytes = packState(A, new Uint8Array(A.length * 4));
    let worst = 0;
    for (let i = 0; i < A.length; i++) {
      const v = (bytes[i * 4] * 256 + bytes[i * 4 + 1]) / 65535;
      worst = Math.max(worst, Math.abs(v - A[i]));
      expect(bytes[i * 4 + 2]).toBe(0);
      expect(bytes[i * 4 + 3]).toBe(255);
    }
    expect(worst).toBeLessThanOrEqual(0.5 / 65535 + 1e-9);
  });
});

describe("grid and stats", () => {
  it("is GRID_W across with square cells", () => {
    expect(gridSize(1920, 1080)).toEqual([GRID_W, 144]);
    expect(gridSize(3840, 2160)).toEqual([GRID_W, 144]);
    expect(gridSize(100, 10)[1]).toBeGreaterThanOrEqual(64);
    expect(gridSize(10, 1000)[1]).toBeLessThanOrEqual(256);
    expect(gridSize(0, 0)).toEqual([GRID_W, 144]);
  });

  it("covers the grid with STATS_SIZE tiles", () => {
    const [tx, ty] = statsTile(256, 144);
    expect(tx * STATS_SIZE).toBeGreaterThanOrEqual(256);
    expect(ty * STATS_SIZE).toBeGreaterThanOrEqual(144);
  });

  it("reads mean and max, skipping tiles without cells", () => {
    const bytes = new Uint8Array(STATS_SIZE * STATS_SIZE * 4);
    bytes.set([51, 200, 255, 255], 0);
    bytes.set([0, 0, 255, 255], 4);
    bytes.set([255, 255, 0, 0], 8);
    const s = readStats(bytes, { mean: 0, max: 0 });
    expect(s.mean).toBeCloseTo(0.1, 5);
    expect(s.max).toBeCloseTo(200 / 255, 5);
  });

  it("only spawns into empty surroundings, inside the grid", () => {
    const [w, h] = gridSize(1920, 1080);
    const [tx, ty] = statsTile(w, h);
    const bytes = new Uint8Array(STATS_SIZE * STATS_SIZE * 4);
    const nx = Math.ceil(w / tx);
    const ny = Math.ceil(h / ty);
    // Fill every tile except columns 2-11.
    const fill = (emptyFrom: number, emptyTo: number) => {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const empty = i >= emptyFrom && i < emptyTo;
          bytes.set([20, empty ? 0 : 200, 255, 255], (j * STATS_SIZE + i) * 4);
        }
      }
    };
    fill(2, 12);
    const rng = createRng(1);
    const out = new Int32Array(2);
    let found = 0;
    let bad = 0;
    for (let k = 0; k < 50; k++) {
      if (!pickSpawnSpot(bytes, w, h, rng, out)) {
        continue;
      }
      found++;
      if (out[0] < 0 || out[1] < 0 || out[0] + PATCH_SIZE > w || out[1] + PATCH_SIZE > h) {
        bad++;
      }
      if (out[0] - KERNEL_R < 2 * tx || out[0] + PATCH_SIZE + KERNEL_R > 12 * tx) {
        bad++;
      }
    }
    expect(bad).toBe(0);
    expect(found).toBeGreaterThan(0);
    fill(0, 0);
    let full = 0;
    for (let k = 0; k < 20; k++) {
      if (pickSpawnSpot(bytes, w, h, rng, out)) {
        full++;
      }
    }
    expect(full).toBe(0);
  });
});

describe("life cycle", () => {
  it("fades in, holds, and fades out before asking for a reseed", () => {
    const life = createLife();
    let reseeds = 0;
    for (let t = 0; t < FADE_SECONDS + 0.5; t += 0.1) {
      if (advanceLife(life, 0.1, 0)) {
        reseeds++;
      }
    }
    expect(life.phase).toBe("live");
    expect(life.fade).toBe(1);
    life.phase = "out";
    let frames = 0;
    while (!advanceLife(life, 0.1, 0) && frames < 1000) {
      frames++;
    }
    expect(reseeds).toBe(0);
    expect(life.fade).toBe(0);
    expect(frames).toBeGreaterThan(FADE_SECONDS / 0.1 - 3);
    expect(advanceLife(createLife(), Number.NaN, 0)).toBe(false);
  });

  it("starts a fade-out after the mixed cycle time", () => {
    const life = createLife();
    advanceLife(life, 5, 10);
    expect(life.phase).toBe("live");
    advanceLife(life, 6, 10);
    expect(life.phase).toBe("out");
  });

  it("judges only settled fields, fading out dead or full ones", () => {
    const cells = 256 * 144;
    const life = createLife();
    life.phase = "live";
    const dead = { mean: 0, max: DEAD_MAX / 2 };
    expect(judgeStats(life, dead, 4, "orbium", cells)).toBe(0);
    expect(life.phase).toBe("live");
    life.quiet = SETTLE_STEPS;
    judgeStats(life, dead, 4, "orbium", cells);
    expect(life.phase).toBe("out");
    life.phase = "live";
    judgeStats(life, { mean: FULL_MEAN * 1.1, max: 1 }, 4, "orbium", cells);
    expect(life.phase).toBe("out");
  });

  it("tops up missing creatures, a few at a time", () => {
    const cells = 256 * 144;
    const life = createLife();
    life.phase = "live";
    life.quiet = SETTLE_STEPS;
    const m = CREATURE_MASS.orbium / cells;
    expect(judgeStats(life, { mean: 4 * m, max: 1 }, 4, "orbium", cells)).toBe(0);
    expect(judgeStats(life, { mean: 3 * m, max: 1 }, 4, "orbium", cells)).toBe(1);
    expect(judgeStats(life, { mean: 0.5 * m, max: 1 }, 8, "orbium", cells)).toBe(MAX_SPAWNS);
    expect(judgeStats(life, { mean: 6 * m, max: 1 }, 4, "orbium", cells)).toBe(0);
    expect(life.phase).toBe("live");
  });
});

describe("palettes", () => {
  it("cover every option and run from the background to the core", () => {
    const out = new Uint8Array(LUT_SIZE * 4);
    for (const o of PALETTE_OPTIONS) {
      const stops = PALETTES[o.value];
      expect(stops[0][0]).toBe(0);
      expect(stops[stops.length - 1][0]).toBe(1);
      buildPaletteLut(o.value, out);
      expect(out[3]).toBe(255);
      expect(out[LUT_SIZE * 4 - 1]).toBe(255);
    }
    const fallback = buildPaletteLut("nope", new Uint8Array(LUT_SIZE * 4));
    expect(fallback).toEqual(buildPaletteLut("bioluminescent", out));
  });
});
