import { describe, expect, it } from "vitest";
import {
  ambientAt,
  createVoronoiSample,
  DRIFT_MAX,
  DRIFT_PERIOD,
  driftUniform,
  GRID_ORIGIN,
  HIGHLIGHT,
  HIGHLIGHT_FADE,
  JITTER,
  leadStyle,
  palette,
  PALETTE_SIZE,
  PALETTES,
  paneColorIndex,
  SEARCH_BOUND,
  seedHash,
  seedOffset,
  SUN_PERIOD,
  sunAt,
  voronoi,
} from "./glass-sim";
import { createRng } from "../noise";
import { PALETTE_OPTIONS } from "./glass.meta";

describe("search bound", () => {
  it("is the analytic bound, and jitter plus drift stays inside it", () => {
    expect(SEARCH_BOUND).toBeCloseTo(0.3964, 4);
    expect(JITTER + DRIFT_MAX).toBeLessThan(SEARCH_BOUND);
  });

  it("holds numerically: outside seeds are farther than the 2nd-nearest centre plus 2R", () => {
    // Slack between the nearest possible outside-3x3 seed and the second-nearest
    // 3x3 centre, over points in the cell; the search is exact while slack >= 2R.
    let minSlack = Infinity;
    for (let y = 0; y <= 1; y += 1 / 64) {
      for (let x = 0; x <= 1; x += 1 / 64) {
        const out = Math.min(2.5 - x, x + 1.5, 2.5 - y, y + 1.5);
        const d: number[] = [];
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            d.push(Math.hypot(x - i - 0.5, y - j - 0.5));
          }
        }
        d.sort((a, b) => a - b);
        minSlack = Math.min(minSlack, out - d[1]);
      }
    }
    expect(minSlack).toBeCloseTo(2 * SEARCH_BOUND, 6);
  });

  it("seeds stay within jitter + drift of their cell centre at all times", () => {
    const d = [0, 0];
    const o = [0, 0];
    let worst = 0;
    for (let iy = GRID_ORIGIN - 12; iy < GRID_ORIGIN + 12; iy++) {
      for (let ix = GRID_ORIGIN - 20; ix < GRID_ORIGIN + 20; ix++) {
        for (let t = 0; t < DRIFT_PERIOD; t += DRIFT_PERIOD / 48) {
          driftUniform(t, 1, d);
          seedOffset(ix, iy, d, o);
          worst = Math.max(worst, Math.hypot(o[0], o[1]));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(JITTER + DRIFT_MAX + 1e-12);
    // And the jitter actually uses most of its range.
    expect(worst).toBeGreaterThan(JITTER);
  });

  it("3x3 search matches a 7x7 brute force", () => {
    const rng = createRng(40);
    const d = [0, 0];
    const a = createVoronoiSample();
    const b = createVoronoiSample();
    let nearLead = 0;
    let worstEdge = 0;
    // The first sample where the searches disagree or the edge leaves its bounds.
    let bad: { n: number; what: string; a: number; b: number } | undefined;
    const fail = (n: number, what: string, x: number, y: number) => {
      bad ??= { n, what, a: x, b: y };
    };
    for (let n = 0; n < 4000; n++) {
      const gx = GRID_ORIGIN - 10 + rng() * 20;
      const gy = GRID_ORIGIN - 6 + rng() * 12;
      driftUniform(rng() * DRIFT_PERIOD, 1, d);
      voronoi(gx, gy, d, a, 1);
      voronoi(gx, gy, d, b, 3);
      if (!Object.is(a.hash, b.hash)) {
        fail(n, "hash", a.hash, b.hash);
      }
      // toBeCloseTo(_, 12): within half of 1e-12.
      if (!(Math.abs(a.f1 - b.f1) < 0.5e-12)) {
        fail(n, "f1", a.f1, b.f1);
      }
      if (!(Math.abs(a.f2 - b.f2) < 0.5e-12)) {
        fail(n, "f2", a.f2, b.f2);
      }
      // Exact wherever a lead could be drawn (half of 14 px lead in 100 px cells, plus AA).
      if (b.edge < 0.15) {
        nearLead++;
        worstEdge = Math.max(worstEdge, Math.abs(a.edge - b.edge));
      }
      if (!(a.edge >= 0)) {
        fail(n, "edge >= 0", a.edge, 0);
      }
      // At most the distance to the bisector with the second-nearest seed,
      // (f2² - f1²) / (2|a - b|), which is at most (f1 + f2) / 2 as |a - b| >= f2 - f1.
      if (!(a.edge <= (a.f1 + a.f2) / 2 + 1e-12)) {
        fail(n, "edge <= (f1 + f2) / 2", a.edge, (a.f1 + a.f2) / 2 + 1e-12);
      }
    }
    expect(bad).toBeUndefined();
    expect(nearLead).toBeGreaterThan(500);
    expect(worstEdge).toBeLessThan(1e-12);
  });
});

describe("determinism", () => {
  it("seeds and colours depend only on the grid cell", () => {
    expect(seedHash(500, 510)).toBe(seedHash(500, 510));
    expect(seedHash(500, 510)).not.toBe(seedHash(510, 500));
    const d = driftUniform(12.3, 0.7, [0, 0]);
    expect(seedOffset(503, 507, d, [0, 0])).toEqual(seedOffset(503, 507, d, [0, 0]));
    const s = voronoi(GRID_ORIGIN + 0.3, GRID_ORIGIN + 0.4, d, createVoronoiSample());
    const t = voronoi(GRID_ORIGIN + 0.3, GRID_ORIGIN + 0.4, d, createVoronoiSample());
    expect(s).toEqual(t);
  });

  it("a pane keeps its colour as its seed drifts", () => {
    // Sample near a seed's jittered home: the drift is too small to hand it to another pane.
    const d = [0, 0];
    const o = [0, 0];
    for (let ix = GRID_ORIGIN; ix < GRID_ORIGIN + 10; ix++) {
      seedOffset(ix, GRID_ORIGIN, [0, 0], o);
      const gx = ix + 0.5 + o[0];
      const gy = GRID_ORIGIN + 0.5 + o[1];
      const h = seedHash(ix, GRID_ORIGIN);
      for (let t = 0; t < DRIFT_PERIOD; t += 3) {
        driftUniform(t, 1, d);
        expect(voronoi(gx, gy, d, createVoronoiSample()).hash).toBe(h);
      }
    }
  });

  it("drift is periodic and zero at drift 0", () => {
    const a = driftUniform(3, 1, [0, 0]);
    const b = driftUniform(3 + 7 * DRIFT_PERIOD, 1, [0, 0]);
    expect(b[0]).toBeCloseTo(a[0], 9);
    expect(b[1]).toBeCloseTo(a[1], 9);
    expect(driftUniform(3, 0, [1, 1])).toEqual([0, 0]);
    expect(Math.hypot(...driftUniform(9, 5, [0, 0]))).toBeCloseTo(DRIFT_MAX / Math.SQRT2, 12);
  });
});

describe("palettes", () => {
  it("have PALETTE_SIZE colours each and an option per palette", () => {
    for (const p of Object.values(PALETTES)) {
      expect(p).toHaveLength(PALETTE_SIZE);
    }
    expect(PALETTE_OPTIONS.map((o) => o.value).toSorted()).toEqual(
      Object.keys(PALETTES).toSorted(),
    );
  });

  it("falls back to cathedral", () => {
    expect(palette("tiffany")).toBe(PALETTES.tiffany);
    expect(palette("nope")).toBe(PALETTES.cathedral);
    expect(palette("constructor")).toBe(PALETTES.cathedral);
  });

  it("uses every colour across a window", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 64; i++) {
      seen.add(paneColorIndex(seedHash(GRID_ORIGIN + i, GRID_ORIGIN)));
    }
    expect(seen.size).toBe(PALETTE_SIZE);
  });
});

describe("sun patch", () => {
  it("is periodic and stays over the frame", () => {
    const a = sunAt(17, [0, 0]);
    const b = sunAt(17 + 3 * SUN_PERIOD, [0, 0]);
    expect(b[0]).toBeCloseTo(a[0], 9);
    expect(b[1]).toBeCloseTo(a[1], 9);
    for (let t = 0; t < SUN_PERIOD; t += 0.5) {
      sunAt(t, a);
      expect(a[0]).toBeGreaterThanOrEqual(0.1);
      expect(a[0]).toBeLessThanOrEqual(0.9);
      expect(a[1]).toBeGreaterThanOrEqual(0.2);
      expect(a[1]).toBeLessThanOrEqual(0.7);
    }
  });

  it("is continuous and slow, including across the period", () => {
    const a = [0, 0];
    const b = [0, 0];
    const dt = 1 / 60;
    for (let t = 0; t < 2 * SUN_PERIOD; t += 0.37) {
      sunAt(t, a);
      sunAt(t + dt, b);
      // Under 2.5% of the frame per second.
      expect(Math.hypot(b[0] - a[0], b[1] - a[1]) / dt).toBeLessThan(0.025);
    }
    sunAt(SUN_PERIOD - 1e-6, a);
    sunAt(SUN_PERIOD, b);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThan(1e-6);
  });

  it("crosses most of the frame each period", () => {
    let lo = Infinity;
    let hi = -Infinity;
    const a = [0, 0];
    for (let t = 0; t < SUN_PERIOD; t += 0.5) {
      sunAt(t, a);
      lo = Math.min(lo, a[0]);
      hi = Math.max(hi, a[0]);
    }
    expect(hi - lo).toBeGreaterThan(0.7);
  });

  it("ambient varies only a little", () => {
    for (let t = 0; t < 600; t += 0.7) {
      expect(ambientAt(t)).toBeGreaterThan(0.6);
      expect(ambientAt(t)).toBeLessThan(0.75);
    }
  });
});

describe("leadStyle", () => {
  it("draws the lead at its width in device px, half each side of the edge", () => {
    expect(leadStyle(6, 1)).toEqual([3, 1, HIGHLIGHT]);
    const [hw, alpha] = leadStyle(6, 2);
    expect(hw).toBe(6);
    expect(alpha).toBe(1);
  });

  it("keeps a lead thinner than a pixel a pixel wide but faint, so it never breaks up", () => {
    const [hw, alpha, hl] = leadStyle(2, 0.25);
    expect(hw).toBe(0.5);
    expect(alpha).toBeCloseTo(0.5, 12);
    expect(hl).toBe(0);
    expect(leadStyle(0, 1)).toEqual([0.5, 0, 0]);
    expect(leadStyle(-3, 1)).toEqual([0.5, 0, 0]);
  });

  it("fades the highlight in smoothly between the fade widths", () => {
    const [lo, hi] = HIGHLIGHT_FADE;
    expect(leadStyle(lo, 1)[2]).toBe(0);
    expect(leadStyle(hi, 1)[2]).toBe(HIGHLIGHT);
    expect(leadStyle((lo + hi) / 2, 1)[2]).toBeCloseTo(HIGHLIGHT / 2, 12);
    const ramp = Array.from({ length: 13 }, (_, i) => leadStyle(lo + ((hi - lo) * i) / 12, 1)[2]);
    expect(ramp).toEqual(ramp.toSorted((x, y) => x - y));
  });

  it("scales with the frame, so the lead looks the same at every resolution", () => {
    for (const w of [2, 6, 14]) {
      const [hd] = leadStyle(w, 1);
      const [uhd, alpha, hl] = leadStyle(w, 2);
      expect(uhd).toBeCloseTo(2 * hd, 12);
      expect(alpha).toBe(1);
      expect(hl).toBeGreaterThanOrEqual(leadStyle(w, 1)[2]);
    }
  });
});
