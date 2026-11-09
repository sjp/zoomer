import { describe, expect, it } from "vitest";
import {
  BOB_MAX,
  BOB_OFFSET,
  buildLeaves,
  buildRoof,
  cloudThin,
  carryBobs,
  createBobs,
  createDrips,
  createRivulets,
  eaveAt,
  EAVE_EDGE,
  eaveY,
  inCentre,
  LAYOUT_ASPECT,
  LEAF_FLOATS,
  LEAF_LAYERS,
  leafPoint,
  MAX_BARS,
  MAX_DRIPS,
  MAX_LEAVES,
  MAX_RIVULETS,
  PALETTES,
  resetRivulets,
  PANE_MARGIN,
  rivuletR,
  roofPoint,
  stepBobs,
  stepDrips,
  stepRivulets,
  TRAIL_SEGS,
  writeBars,
  writeDrips,
  writeLeaves,
  writeRivulets,
  BAR_FLOATS,
} from "./greenhouse-sim";
import { DENSITY_MAX } from "./greenhouse.meta";
import { STREAK_FLOATS } from "../streaks";
import { defined } from "../../test/defined";

const SEEDS = [0, 1, 7, 42, 999];

describe("roof", () => {
  it("has a symmetric eave inside the top half, and none when hidden", () => {
    const bad: string[] = [];
    for (const kind of ["arched", "pitched"] as const) {
      for (let k = 0; k <= 40; k++) {
        const u = k / 40;
        const y = eaveY(kind, u);
        if (Math.abs(y - eaveY(kind, 1 - u)) > 1e-9) {
          bad.push(`sym ${kind} ${String(u)}`);
        }
        if (y < 0.1 || y > EAVE_EDGE + 1e-9) {
          bad.push(`range ${kind} ${String(u)}`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(eaveY("hidden", 0.5)).toBeLessThan(0);
    expect(buildRoof("hidden", 16 / 9)).toBeNull();
  });

  it("writes bars that fit the buffer, at every aspect ratio", () => {
    const out = new Float32Array(MAX_BARS * BAR_FLOATS);
    for (const aspect of [1, 4 / 3, 16 / 9, 21 / 9, 4]) {
      const roof = defined(buildRoof("arched", aspect));
      const n = writeBars(roof, out);
      expect(n).toBe(roof.panes + 1 + roof.panes * 3);
      expect(n).toBeLessThanOrEqual(MAX_BARS);
    }
    expect(writeBars(null, out)).toBe(0);
  });
});

describe("rivulets", () => {
  it("stay inside their roof panes, between the eave and the frame top", () => {
    const bad: string[] = [];
    const p: [number, number] = [0, 0];
    const out = new Float32Array(MAX_RIVULETS * TRAIL_SEGS * STREAK_FLOATS);
    for (const kind of ["arched", "pitched"] as const) {
      const roof = defined(buildRoof(kind, 16 / 9));
      const riv = createRivulets(3);
      let maxAlive = 0;
      for (let s = 0; s < 3000; s++) {
        stepRivulets(riv, roof, 1 / 15, 1);
        let alive = 0;
        for (let i = 0; i < MAX_RIVULETS; i++) {
          if (!riv.alive[i]) {
            continue;
          }
          alive++;
          const f = Math.max(0, riv.f[i]);
          const r = rivuletR(riv, i, f);
          const pane = riv.pane[i];
          if (r < pane + PANE_MARGIN - 1e-9 || r > pane + 1 - PANE_MARGIN + 1e-9) {
            bad.push(`pane ${kind} ${String(s)} ${String(i)}`);
          }
          roofPoint(roof, r, f, p);
          if (p[1] < -1e-9 || p[1] > EAVE_EDGE + 1e-9) {
            bad.push(`y ${kind} ${String(s)} ${String(i)}`);
          }
        }
        maxAlive = Math.max(maxAlive, alive);
        const n = writeRivulets(riv, roof, 1080, 1, [1, 1, 1], out);
        for (let k = 0; k < n * STREAK_FLOATS; k++) {
          if (!Number.isFinite(out[k])) {
            bad.push(`nan ${String(s)}`);
          }
        }
      }
      if (maxAlive < MAX_RIVULETS * 0.8) {
        bad.push(`few ${kind} ${String(maxAlive)}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // Heavy by nature: 6000 rivulet steps, with no per-sample expects to trim.
  }, 20_000);

  it("does nothing without a roof, and none spawn when dry", () => {
    const riv = createRivulets(1);
    stepRivulets(riv, null, 0.1, 1);
    expect(riv.alive.every((a) => a === 0)).toBe(true);
    const roof = defined(buildRoof("pitched", 16 / 9));
    for (let s = 0; s < 300; s++) {
      stepRivulets(riv, roof, 0.1, 0);
    }
    expect(riv.alive.every((a) => a === 0)).toBe(true);
  });
});

describe("drips", () => {
  it("fall from the eave, stay within the pool and stop when switched off", () => {
    const roof = defined(buildRoof("arched", 16 / 9));
    const d = createDrips(2);
    const out = new Float32Array(MAX_DRIPS * STREAK_FLOATS);
    let seen = 0;
    for (let s = 0; s < 600; s++) {
      stepDrips(d, roof, 1 / 30, 1, true);
      seen = Math.max(seen, writeDrips(d, 1080, 1, [1, 1, 1], out));
    }
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThanOrEqual(MAX_DRIPS);
    for (let s = 0; s < 300; s++) {
      stepDrips(d, roof, 1 / 30, 1, false);
    }
    expect(d.alive.every((a) => a === 0)).toBe(true);
  });
});

describe("cloudThin", () => {
  it("is within [0, 1], mostly 0, and periodic", () => {
    let zero = 0;
    let max = 0;
    let bad = 0;
    for (let k = 0; k < 1000; k++) {
      const v = cloudThin(k / 1000);
      if (!(v >= 0 && v <= 1)) {
        bad++;
      }
      if (Math.abs(v - cloudThin(k / 1000 + 3)) > 1e-9) {
        bad++;
      }
      if (v === 0) {
        zero++;
      }
      max = Math.max(max, v);
    }
    expect(bad).toBe(0);
    expect(zero).toBeGreaterThan(500);
    expect(max).toBeGreaterThan(0.5);
  });
});

describe("buildLeaves", () => {
  it("is deterministic per seed and varies between seeds", () => {
    expect(buildLeaves(7, 1, "jungle")).toEqual(buildLeaves(7, 1, "jungle"));
    expect(buildLeaves(8, 1, "jungle")).not.toEqual(buildLeaves(7, 1, "jungle"));
  });

  it("keeps the centre third mostly clear", () => {
    const p: [number, number] = [0, 0];
    let inside = 0;
    let total = 0;
    for (const seed of SEEDS) {
      for (const palette of ["jungle", "fern"] as const) {
        const layout = buildLeaves(seed, DENSITY_MAX, palette);
        for (const leaf of layout.leaves) {
          for (let s = 0; s <= 40; s++) {
            leafPoint(leaf, s / 40, LAYOUT_ASPECT, p);
            total++;
            if (inCentre(p[0], p[1])) {
              inside++;
            }
          }
        }
      }
    }
    expect(inside / total).toBeLessThan(0.01);
  });

  it("fills every layer, scales with density and fits the instance buffer", () => {
    const bad: string[] = [];
    for (const seed of SEEDS) {
      const low = buildLeaves(seed, 0.3, "jungle");
      const mid = buildLeaves(seed, 1, "jungle");
      const high = buildLeaves(seed, DENSITY_MAX, "fern");
      for (const layout of [low, mid, high]) {
        if (layout.counts.length !== LEAF_LAYERS.length) {
          bad.push(`layers ${String(seed)}`);
        }
        if (layout.counts.some((c) => c < 1)) {
          bad.push(`empty ${String(seed)}`);
        }
        if (layout.leaves.length > MAX_LEAVES) {
          bad.push(`max ${String(seed)}`);
        }
        layout.leaves.forEach((leaf, i) => {
          const l = leaf.layer;
          if (i < layout.starts[l] || i >= layout.starts[l] + layout.counts[l]) {
            bad.push(`order ${String(seed)}`);
          }
        });
      }
      if (!(low.leaves.length < mid.leaves.length && mid.leaves.length < high.leaves.length)) {
        bad.push(`density ${String(seed)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("follows the palette's mix of kinds", () => {
    const fronds = { jungle: 0, fern: 0 };
    for (const seed of SEEDS) {
      for (const palette of ["jungle", "fern"] as const) {
        const layout = buildLeaves(seed, 1, palette);
        fronds[palette] += layout.leaves.filter((l) => l.kind === 2).length / layout.leaves.length;
      }
    }
    expect(fronds.fern).toBeGreaterThan(fronds.jungle);
    expect(PALETTES.fern.kinds[3]).toBeGreaterThan(PALETTES.jungle.kinds[3]);
  });

  it("keeps every existing leaf in place when the density rises", () => {
    for (const seed of SEEDS) {
      for (const [lo, hi] of [
        [1, 1.05],
        [0.5, 1],
        [1, DENSITY_MAX],
      ]) {
        const a = buildLeaves(seed, lo, "jungle");
        const b = new Map(buildLeaves(seed, hi, "jungle").leaves.map((l) => [l.key, l]));
        for (const leaf of a.leaves) {
          expect(b.get(leaf.key)).toEqual(leaf);
        }
      }
    }
  });

  it("keeps plants where they grow when the palette changes", () => {
    for (const seed of SEEDS) {
      const a = buildLeaves(seed, 1, "jungle");
      const b = new Map(buildLeaves(seed, 1, "fern").leaves.map((l) => [l.key, l]));
      let same = 0;
      for (const leaf of a.leaves) {
        const other = b.get(leaf.key);
        if (other && other.anchor === leaf.anchor && other.y === leaf.y) {
          same++;
        }
      }
      // Kinds change, and a kind's length can drop a leaf near the centre; the rest stay.
      expect(same / a.leaves.length).toBeGreaterThan(0.9);
    }
  });

  it("writes finite instance data", () => {
    const layout = buildLeaves(5, DENSITY_MAX, "evening");
    const out = new Float32Array(MAX_LEAVES * LEAF_FLOATS);
    const n = writeLeaves(layout, out);
    expect(n).toBe(layout.leaves.length);
    expect(out.subarray(0, n * LEAF_FLOATS).every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("bob springs", () => {
  it("stay bounded under frequent kicks", () => {
    const lengths = [0.1, 0.2, 0.4, 0.6, 0.8];
    const b = createBobs(lengths, 4);
    const out = new Float32Array(lengths.length * LEAF_FLOATS);
    let max = 0;
    for (let s = 0; s < 5000; s++) {
      stepBobs(b, s % 7 === 0 ? 0.1 : 1 / 60, 5, out);
      for (let i = 0; i < lengths.length; i++) {
        max = Math.max(max, Math.abs(b.x[i]));
      }
    }
    expect(max).toBeLessThanOrEqual(BOB_MAX);
    expect(max).toBeGreaterThan(0);
    expect(out[BOB_OFFSET]).toBe(Math.fround(b.x[0]));
  });

  it("settle without kicks", () => {
    const b = createBobs([0.3, 0.8], 1);
    b.x[0] = BOB_MAX;
    b.v[1] = 0.3;
    for (let s = 0; s < 60 * 20; s++) {
      stepBobs(b, 1 / 60, 0);
    }
    expect(Math.abs(b.x[0])).toBeLessThan(1e-3);
    expect(Math.abs(b.x[1])).toBeLessThan(1e-3);
  });

  it("carry each leaf's motion across a rebuild by key", () => {
    const from = createBobs([0.3, 0.5, 0.7], 1);
    from.x.set([0.01, 0.02, 0.03]);
    from.v.set([0.1, 0.2, 0.3]);
    const to = createBobs([0.5, 0.4, 0.3, 0.7], 1);
    carryBobs(from, [10, 20, 30], to, [20, 99, 10, 30]);
    expect(Array.from(to.x)).toEqual([0.02, 0, 0.01, 0.03]);
    expect(Array.from(to.v)).toEqual([0.2, 0, 0.1, 0.3]);
  });

  it("ignores bad time steps", () => {
    const b = createBobs([0.3], 1);
    b.x[0] = 0.01;
    stepBobs(b, Number.NaN, 1);
    stepBobs(b, -1, 1);
    expect(b.x[0]).toBe(0.01);
  });
});

describe("eaveAt", () => {
  it("runs straight between the rafter feet, clamped to the roof", () => {
    for (const kind of ["arched", "pitched"] as const) {
      const roof = defined(buildRoof(kind, 16 / 9));
      for (let i = 0; i <= roof.panes; i++) {
        expect(eaveAt(roof, i)).toBeCloseTo(roof.footY[i], 12);
      }
      for (let i = 0; i < roof.panes; i++) {
        const mid = (roof.footY[i] + roof.footY[i + 1]) / 2;
        expect(eaveAt(roof, i + 0.5)).toBeCloseTo(mid, 12);
      }
      expect(eaveAt(roof, -2)).toBe(eaveAt(roof, 0));
      expect(eaveAt(roof, roof.panes + 3)).toBe(eaveAt(roof, roof.panes));
    }
  });

  it("matches the roof's own eave line at height fraction 0", () => {
    const roof = defined(buildRoof("arched", 21 / 9));
    const p: [number, number] = [0, 0];
    for (let r = 0; r <= roof.panes; r += 0.25) {
      roofPoint(roof, r, 0, p);
      expect(eaveAt(roof, r)).toBeCloseTo(p[1], 12);
    }
  });
});

describe("resetRivulets", () => {
  it("clears every rivulet, and they come back with the rain", () => {
    const roof = defined(buildRoof("pitched", 16 / 9));
    const riv = createRivulets(4);
    for (let s = 0; s < 200; s++) {
      stepRivulets(riv, roof, 0.1, 1);
    }
    expect(riv.alive.some((a) => a === 1)).toBe(true);
    resetRivulets(riv);
    expect(riv.alive.every((a) => a === 0)).toBe(true);
    for (let s = 0; s < 200; s++) {
      stepRivulets(riv, roof, 0.1, 1);
    }
    expect(riv.alive.some((a) => a === 1)).toBe(true);
  });
});
