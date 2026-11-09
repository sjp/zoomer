import { describe, expect, it } from "vitest";
import type { Rgb } from "../color";
import {
  BASE_BOT,
  BRANCH_SEGMENTS,
  branchPath,
  CORE_R,
  createLayout,
  createPlasma,
  FADE_RATE,
  filamentBrightness,
  filamentCount,
  filamentPath,
  FLOOR_Y,
  GLASS_IN,
  globeRadius,
  hsvToRgb,
  MAX_BRANCHES,
  PALETTES,
  PATH_SEGMENTS,
  type Plasma,
  plasmaLayout,
  rainbowPalette,
  roomGlow,
  SEAT_Y,
  settlePlasma,
  stepPlasma,
} from "./plasma-sim";
import { COLOUR_OPTIONS, CORNER_OPTIONS, MAX_FILAMENTS, plasmaMeta } from "./plasma.meta";

/** Sum of the shown filaments' brightness: what the tests bound the change of. */
function totalBrightness(p: Plasma): number {
  let sum = 0;
  for (let i = 0; i < MAX_FILAMENTS; i++) {
    sum += filamentBrightness(p, i);
  }
  return sum;
}

const DT = 1 / 60;
const SEED = 109;
const path = () => new Float64Array(3 * (PATH_SEGMENTS + 1));
const branch = () => new Float64Array(3 * (BRANCH_SEGMENTS + 1));

/** Smallest chord between the first `n` end points. */
function minSpacing(ends: Float64Array, n: number): number {
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(
        ends[3 * i] - ends[3 * j],
        ends[3 * i + 1] - ends[3 * j + 1],
        ends[3 * i + 2] - ends[3 * j + 2],
      );
      min = Math.min(min, d);
    }
  }
  return min;
}

describe("plasmaLayout", () => {
  it("puts the globe in its bottom corner, inside the frame, base on the table", () => {
    const bad: string[] = [];
    for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
      for (const { value: corner } of CORNER_OPTIONS) {
        for (const size of [plasmaMeta.params.size.min, 0.42, plasmaMeta.params.size.max]) {
          const l = plasmaLayout(aspect, corner, size, createLayout());
          const [x0, y0, x1, y1] = l.box;
          const ok =
            x0 >= 0 &&
            x1 <= aspect &&
            y0 >= 0 &&
            y1 <= 1 &&
            l.side === (corner === "left" ? -1 : 1) &&
            (corner === "left" ? l.cx < aspect / 2 : l.cx > aspect / 2) &&
            Math.abs(l.cy + BASE_BOT * l.r - SEAT_Y) < 1e-12 &&
            l.cx - l.r >= x0 &&
            l.cx + l.r <= x1 &&
            l.cy + l.r <= y1;
          if (!ok) {
            bad.push(`${String(aspect)} ${corner} ${String(size)}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps the default globe out of the middle third at 16:9", () => {
    const aspect = 16 / 9;
    for (const { value: corner } of CORNER_OPTIONS) {
      const l = plasmaLayout(aspect, corner, plasmaMeta.params.size.default, createLayout());
      expect(corner === "left" ? l.box[2] : aspect - l.box[0]).toBeLessThan(aspect / 3);
    }
  });

  it("clamps the size and survives bad input", () => {
    expect(globeRadius(10)).toBe(plasmaMeta.params.size.max / 2);
    expect(globeRadius(Number.NaN)).toBeGreaterThan(0);
    const l = plasmaLayout(Number.NaN, "right", Number.NaN, createLayout());
    expect([l.cx, l.cy, l.r, ...l.box].every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("end points", () => {
  it("stay on the sphere, above the floor, and never cluster", () => {
    for (const n of [4, 9, MAX_FILAMENTS]) {
      const p = createPlasma(SEED);
      settlePlasma(p, n);
      let off = 0;
      let low = 1;
      let spacing = Infinity;
      for (let f = 0; f < 60 * 120; f++) {
        stepPlasma(p, DT, n, 2);
        if (f % 10 !== 0) {
          continue;
        }
        for (let i = 0; i < n; i++) {
          const e = p.ends.subarray(3 * i, 3 * i + 3);
          off = Math.max(off, Math.abs(Math.hypot(e[0], e[1], e[2]) - 1));
          low = Math.min(low, e[1]);
        }
        spacing = Math.min(spacing, minSpacing(p.ends, n));
      }
      expect(off).toBeLessThan(1e-9);
      expect(low).toBeGreaterThan(FLOOR_Y - 0.25);
      // 16 even points on the sphere are about 0.95 apart; never a small fraction of that.
      expect(spacing).toBeGreaterThan(0.25);
    }
  });

  it("are deterministic per seed and move over several seconds at the default drift", () => {
    const a = createPlasma(SEED);
    const b = createPlasma(SEED);
    settlePlasma(a, 9);
    settlePlasma(b, 9);
    const start = a.ends.slice();
    for (let f = 0; f < 600; f++) {
      stepPlasma(a, DT, 9, 0.6);
      stepPlasma(b, DT, 9, 0.6);
    }
    expect(Array.from(a.ends)).toEqual(Array.from(b.ends));
    let moved = 0;
    for (let i = 0; i < 9; i++) {
      moved = Math.max(
        moved,
        Math.hypot(
          a.ends[3 * i] - start[3 * i],
          a.ends[3 * i + 1] - start[3 * i + 1],
          a.ends[3 * i + 2] - start[3 * i + 2],
        ),
      );
    }
    expect(moved).toBeGreaterThan(0.1);
  });

  it("fade in and out when the count changes, and ignore bad steps", () => {
    const p = createPlasma(SEED);
    settlePlasma(p, 4);
    expect(Array.from(p.fade.subarray(0, 5))).toEqual([1, 1, 1, 1, 0]);
    stepPlasma(p, 0.2, 6, 1);
    expect(p.fade[4]).toBeCloseTo(0.2 * FADE_RATE, 12);
    // Long frames are clamped, so it takes a few of them.
    for (let f = 0; f < 12; f++) {
      stepPlasma(p, 10, 6, 1);
    }
    expect(p.fade[5]).toBe(1);
    const before = p.ends.slice();
    stepPlasma(p, Number.NaN, 6, 1);
    stepPlasma(p, -1, 6, 1);
    expect(Array.from(p.ends)).toEqual(Array.from(before));
    expect(filamentCount(Number.NaN)).toBeGreaterThan(0);
    expect(filamentCount(99)).toBe(MAX_FILAMENTS);
  });
});

describe("paths", () => {
  it("run from the electrode to the end point, inside the glass", () => {
    const p = createPlasma(SEED);
    settlePlasma(p, MAX_FILAMENTS);
    stepPlasma(p, 3, MAX_FILAMENTS, 1);
    const out = path();
    const bout = branch();
    const end = new Float64Array(3);
    let bad = 0;
    for (let i = 0; i < MAX_FILAMENTS; i++) {
      filamentPath(p, i, out);
      const e = p.ends.subarray(3 * i, 3 * i + 3);
      const last = 3 * PATH_SEGMENTS;
      if (Math.abs(Math.hypot(out[0], out[1], out[2]) - CORE_R) > 1e-9) {
        bad++;
      }
      for (let c = 0; c < 3; c++) {
        if (Math.abs(out[last + c] - e[c] * GLASS_IN) > 1e-9) {
          bad++;
        }
      }
      for (let k = 0; k <= PATH_SEGMENTS; k++) {
        if (Math.hypot(out[3 * k], out[3 * k + 1], out[3 * k + 2]) > GLASS_IN + 1e-9) {
          bad++;
        }
      }
      for (let b = 0; b < p.branches[i]; b++) {
        branchPath(p, i, b, out, end, bout);
        const r = Math.hypot(
          bout[3 * BRANCH_SEGMENTS],
          bout[3 * BRANCH_SEGMENTS + 1],
          bout[3 * BRANCH_SEGMENTS + 2],
        );
        if (Math.abs(r - GLASS_IN) > 1e-9) {
          bad++;
        }
        // The branch leaves from the outer part of the main path.
        if (Math.hypot(bout[0], bout[1], bout[2]) < 0.4) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
    expect(p.branches.every((b) => b >= 1 && b <= MAX_BRANCHES)).toBe(true);
  });

  it.each([
    [0.6, 0.01],
    [2, 0.04],
  ])("are continuous in time at drift %s", (drift, bound) => {
    const p = createPlasma(SEED);
    settlePlasma(p, MAX_FILAMENTS);
    const a = path();
    const b = path();
    const ba = branch();
    const bb = branch();
    const end = new Float64Array(3);
    let worst = 0;
    for (let f = 0; f < 240; f++) {
      const i = f % MAX_FILAMENTS;
      filamentPath(p, i, a);
      branchPath(p, i, 0, a, end, ba);
      stepPlasma(p, DT, MAX_FILAMENTS, drift);
      filamentPath(p, i, b);
      branchPath(p, i, 0, b, end, bb);
      for (let k = 0; k < a.length; k++) {
        worst = Math.max(worst, Math.abs(a[k] - b[k]));
      }
      for (let k = 0; k < ba.length; k++) {
        worst = Math.max(worst, Math.abs(ba[k] - bb[k]));
      }
    }
    // No point jumps: at most a small fraction of the sphere's radius per frame.
    expect(worst).toBeLessThan(bound);
  });
});

describe("brightness", () => {
  it("changes slowly and slightly: the total by under 5% per second, never per frame", () => {
    const p = createPlasma(SEED);
    settlePlasma(p, 9);
    let prev = totalBrightness(p);
    const first = prev;
    let worst = 0;
    let lo = Infinity;
    let hi = 0;
    for (let f = 0; f < 60 * 60; f++) {
      stepPlasma(p, DT, 9, 2);
      const t = totalBrightness(p);
      worst = Math.max(worst, Math.abs(t - prev) / DT / first);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
      prev = t;
    }
    expect(worst).toBeLessThan(0.05);
    expect((hi - lo) / first).toBeLessThan(0.2);
    let off = 0;
    for (let i = 0; i < MAX_FILAMENTS; i++) {
      const b = filamentBrightness(p, i);
      if (i < 9 ? b <= 0.6 || b > 1 : b !== 0) {
        off++;
      }
    }
    expect(off).toBe(0);
  });
});

describe("palettes", () => {
  it("has a palette or a room glow for every colour option", () => {
    const bad = COLOUR_OPTIONS.map((o) => o.value).filter(
      (value) =>
        !roomGlow(value).every((c) => c >= 0 && c <= 1) ||
        (value !== "rainbow" && !(value in PALETTES)),
    );
    expect(bad).toEqual([]);
  });

  it("converts HSV and keeps rainbow colours in range and slowly changing", () => {
    const out: Rgb = [0, 0, 0];
    expect(hsvToRgb(0, 1, 1, out)).toEqual([1, 0, 0]);
    expect(hsvToRgb(1 / 3, 1, 1, out)).toEqual([0, 1, 0]);
    const p = createPlasma(SEED);
    const pal = { root: [0, 0, 0] as Rgb, tip: [0, 0, 0] as Rgb, glow: [0, 0, 0] as Rgb };
    rainbowPalette(p, 3, pal);
    const before = [...pal.root];
    stepPlasma(p, DT, 9, 1);
    rainbowPalette(p, 3, pal);
    const all = [...pal.root, ...pal.tip, ...pal.glow];
    expect(all.every((c) => c >= 0 && c <= 1)).toBe(true);
    expect(Math.max(...pal.root.map((c, k) => Math.abs(c - before[k])))).toBeLessThan(0.01);
  });
});
