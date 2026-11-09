import { describe, expect, it } from "vitest";
import { hexToUnitRgb } from "../color";
import {
  advanceDrift,
  advanceSpin,
  advanceZoom,
  capIndex,
  fadeWeight,
  inMainBulbs,
  iterCap,
  loopDoublings,
  type MandelTarget,
  MINIBROT_NUCLEUS,
  MINIBROT_SCALE,
  PALETTE_NAMES,
  PALETTE_SIZE,
  paletteAt,
  paletteFor,
  paletteMean,
  PALETTES,
  paletteTexels,
  smoothIter,
  TARGET_NAMES,
  targetFor,
  TARGETS,
  TAU,
  writePaletteMap,
  writeView,
} from "./mandel-sim";
import {
  DEFAULT_DETAIL,
  MAX_DETAIL,
  MIN_DETAIL,
  PALETTE_OPTIONS,
  TARGET_OPTIONS,
  mandelMeta,
} from "./mandel.meta";

/**
 * Multiplier of the cycle a Misiurewicz target's critical orbit lands on, after
 * `preperiod` steps (period 1), as [|ρ|, arg ρ]. For checking the table.
 */
function landingMultiplier(t: MandelTarget): [number, number] {
  const [cr, ci] = t.centre;
  let zr = 0;
  let zi = 0;
  for (let k = 0; k < t.preperiod; k++) {
    const x = zr * zr - zi * zi + cr;
    zi = 2 * zr * zi + ci;
    zr = x;
  }
  return [Math.hypot(2 * zr, 2 * zi), Math.atan2(2 * zi, 2 * zr)];
}

const MISIUREWICZ = TARGET_NAMES.filter((n) => TARGETS[n].preperiod > 0);

/** Signed angle in (-π, π]. */
function angleDiff(a: number, b: number): number {
  const d = (((a - b) % TAU) + TAU) % TAU;
  return d > Math.PI ? d - TAU : d;
}

/** Palette index of the point at frame position (px, py) of the view at `depth`, CPU float64. */
function indexAt(t: MandelTarget, depth: number, px: number, py: number, detail: number): number {
  const v = new Float64Array(4);
  const m = new Float64Array(2);
  writeView(t, depth, 0, v);
  writePaletteMap(t, depth, m);
  const cr = t.centre[0] + v[0] * px - v[1] * py + v[2];
  const ci = t.centre[1] + v[1] * px + v[0] * py + v[3];
  const nu = smoothIter(cr, ci, Math.ceil(iterCap(t, depth, detail)));
  return Number.isFinite(nu) ? nu * m[0] + m[1] : capIndex(t, detail);
}

describe("options", () => {
  it("match the sim's tables", () => {
    expect(TARGET_OPTIONS.map((o) => o.value)).toEqual(TARGET_NAMES);
    expect(PALETTE_OPTIONS.map((o) => o.value)).toEqual(PALETTE_NAMES);
    expect(mandelMeta.params.detail.default).toBe(DEFAULT_DETAIL);
  });

  it("fall back for unknown names", () => {
    expect(targetFor("nope")).toBe(TARGETS.seahorse);
    expect(paletteFor("nope")).toBe(PALETTES.ocean);
    expect(targetFor("elephant")).toBe(TARGETS.elephant);
  });
});

describe("targets", () => {
  it.each(MISIUREWICZ)("%s lands on a repelling fixed point with the listed multiplier", (n) => {
    const t = TARGETS[n];
    // The orbit sits on the fixed point after `preperiod` steps, not before.
    let zr = 0;
    let zi = 0;
    const orbit: [number, number][] = [];
    for (let k = 0; k <= t.preperiod + 1; k++) {
      orbit.push([zr, zi]);
      const x = zr * zr - zi * zi + t.centre[0];
      zi = 2 * zr * zi + t.centre[1];
      zr = x;
    }
    const [a, b] = [orbit[t.preperiod], orbit[t.preperiod + 1]];
    const [c, d] = [orbit[t.preperiod - 1], orbit[t.preperiod]];
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-12);
    expect(Math.hypot(c[0] - d[0], c[1] - d[1])).toBeGreaterThan(1e-3);

    const [mag, arg] = landingMultiplier(t);
    expect(mag).toBeGreaterThan(1);
    expect(Math.log2(mag)).toBeCloseTo(t.periodDoublings, 9);
    // A whole loop turns by a multiple of arg ρ, so its end matches its start.
    expect(Math.abs(angleDiff(t.periods * (arg + t.periodTwist), 0))).toBeLessThan(1e-9);
    // And the turn per period is arg ρ modulo the arms' symmetry.
    const rest = Math.abs(angleDiff(arg + t.periodTwist, 0));
    const arms = rest < 1e-9 ? 1 : Math.round(TAU / rest);
    expect(Math.abs(arms * rest - (arms === 1 ? 0 : TAU))).toBeLessThan(1e-9);
    expect(t.periods % arms).toBe(0);
  });

  it("mini-brot zooms about the fixed point of the whole-set-to-copy map", () => {
    const t = TARGETS.minibrot;
    const c = t.centre[0];
    expect(MINIBROT_NUCLEUS + MINIBROT_SCALE * c).toBeCloseTo(c, 12);
    expect(2 ** -loopDoublings(t)).toBeCloseTo(MINIBROT_SCALE, 12);
    // The whole set is centred at depth 0.
    const v = new Float64Array(4);
    writeView(t, 0, 0, v);
    expect(c + v[2]).toBeCloseTo(-0.75, 12);
    expect(v[3]).toBeCloseTo(0, 12);
  });

  it.each(TARGET_NAMES)("%s looks the same a whole loop deeper (CPU float64)", (n) => {
    const t = TARGETS[n];
    const loop = loopDoublings(t);
    const diffs: number[] = [];
    for (let j = 0; j < 9; j++) {
      for (let i = 0; i < 16; i++) {
        const px = ((i + 0.5) / 16 - 0.5) * (32 / 9);
        const py = ((j + 0.5) / 9 - 0.5) * 2;
        const a = indexAt(t, 0, px, py, DEFAULT_DETAIL);
        const b = indexAt(t, loop, px, py, DEFAULT_DETAIL);
        diffs.push(Math.abs(a - b));
      }
    }
    diffs.sort((x, y) => x - y);
    // Median index difference well under a tenth of a palette cycle.
    expect(diffs[diffs.length >> 1]).toBeLessThan(0.1 * t.cycle);
  });
});

describe("zoom schedule", () => {
  it("advances log-scale linearly and wraps to the loop", () => {
    const loop = 3;
    let u = 0;
    for (let k = 0; k < 600; k++) {
      u = advanceZoom(u, 0.1, 10, loop);
    }
    // 60 s at 10 s per doubling: 6 doublings, two whole loops.
    expect(Math.min(u, loop - u)).toBeCloseTo(0, 9);
    expect(advanceZoom(1, 5, 10, loop)).toBeCloseTo(1.5, 12);
    expect(advanceZoom(2.9, 2, 10, loop)).toBeCloseTo(0.1, 12);
    expect(advanceZoom(1, Number.NaN, 10, loop)).toBe(1);
    expect(advanceZoom(1, -1, 10, loop)).toBe(1);
    expect(advanceZoom(Number.NaN, 0, 10, loop)).toBe(0);
    // Out-of-range speeds clamp, non-finite ones use the default.
    expect(advanceZoom(0, 1, 0, loop)).toBeCloseTo(1 / 4, 12);
    expect(advanceZoom(0, 15, Number.NaN, 100)).toBeCloseTo(1, 12);
  });

  it.each(TARGET_NAMES)("%s is continuous apart from the cross-fade, and loops", (n) => {
    const t = TARGETS[n];
    const loop = loopDoublings(t);
    const dt = 1 / 30;
    const speed = 5;
    const step = dt / speed;
    const prev = { u: 0, view: new Float64Array(4), map: new Float64Array(2), cap: 0, w: 0 };
    const viewB = new Float64Array(4);
    const mapB = new Float64Array(2);
    const view = new Float64Array(4);
    const map = new Float64Array(2);
    let wraps = 0;
    let fades = 0;
    let worst = 0;
    let bad = 0;
    let u = 0;
    writeView(t, 0, 0, prev.view);
    writePaletteMap(t, 0, prev.map);
    prev.cap = iterCap(t, 0, DEFAULT_DETAIL);
    // Relative change in view factor, offset and palette map between frames.
    const delta = (a: Float64Array, b: Float64Array, ma: Float64Array, mb: Float64Array) =>
      Math.max(
        Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.hypot(b[0], b[1]),
        Math.hypot(a[2] - b[2], a[3] - b[3]) / Math.hypot(b[0], b[1]),
        Math.abs(ma[0] - mb[0]) / mb[0],
        Math.abs(ma[1] - mb[1]),
      );
    const frames = Math.ceil((2.5 * loop) / step);
    for (let f = 0; f < frames; f++) {
      const before = u;
      // The incoming view's state just before this step.
      writeView(t, before - loop, 0, viewB);
      writePaletteMap(t, before - loop, mapB);
      const capB = iterCap(t, before - loop, DEFAULT_DETAIL);
      u = advanceZoom(u, dt, speed, loop);
      writeView(t, u, 0, view);
      writePaletteMap(t, u, map);
      const cap = iterCap(t, u, DEFAULT_DETAIL);
      const w = fadeWeight(t, u);
      if (!(w >= 0 && w <= 1)) {
        bad++;
      }
      if (w > 0) {
        fades++;
      }
      if (u < before) {
        wraps++;
        // At the loop point the fade had finished, and the new view carries on
        // from where the incoming one was.
        if (prev.w < 0.999) {
          bad++;
        }
        if (w !== 0) {
          bad++;
        }
        worst = Math.max(worst, delta(view, viewB, map, mapB) / step);
        if (Math.abs(cap - capB) > 1) {
          bad++;
        }
      } else {
        worst = Math.max(worst, delta(view, prev.view, map, prev.map) / step);
        if (Math.abs(cap - prev.cap) > 1) {
          bad++;
        }
        // The fade weight eases in without jumps.
        if (Math.abs(w - prev.w) > (2 * step) / t.fade) {
          bad++;
        }
      }
      prev.view.set(view);
      prev.map.set(map);
      prev.cap = cap;
      prev.w = w;
    }
    expect(bad).toBe(0);
    expect(wraps).toBe(2);
    expect(fades).toBeGreaterThan(0);
    // Change per doubling stays at the steady rates of zoom (ln 2), turn and
    // palette shift; a jump of one step would be hundreds of times larger.
    const rate =
      Math.LN2 +
      Math.abs(t.periodTwist / t.periodDoublings) +
      (t.periodGain * t.periodIters) / t.periodDoublings;
    expect(worst).toBeLessThan(1.5 * rate);
  });

  it("fade weight is zero outside the last `fade` doublings and one at the loop point", () => {
    for (const n of TARGET_NAMES) {
      const t = TARGETS[n];
      const loop = loopDoublings(t);
      expect(fadeWeight(t, 0)).toBe(0);
      expect(fadeWeight(t, loop - t.fade - 1e-9)).toBe(0);
      expect(fadeWeight(t, loop)).toBe(1);
      expect(fadeWeight(t, loop - t.fade / 2)).toBeCloseTo(0.5, 12);
    }
  });
});

describe("view and palette map", () => {
  it("spins about the frame centre and zooms about the focus", () => {
    const t = TARGETS.minibrot;
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    writeView(t, 1, 0, a);
    writeView(t, 1, 1, b);
    expect(Math.hypot(b[0], b[1])).toBeCloseTo(Math.hypot(a[0], a[1]), 12);
    expect(angleDiff(Math.atan2(b[1], b[0]), Math.atan2(a[1], a[0]))).toBeCloseTo(1, 12);
    // The offset is not spun.
    expect(b[2]).toBe(a[2]);
    expect(b[3]).toBe(a[3]);
    // One doubling deeper halves the scale.
    writeView(t, 2, 0, b);
    expect(Math.hypot(b[0], b[1]) / Math.hypot(a[0], a[1])).toBeCloseTo(0.5, 12);
  });

  it("maps a point and its twin one period deeper to the same index", () => {
    const m0 = new Float64Array(2);
    const m1 = new Float64Array(2);
    let worst = 0;
    for (const n of TARGET_NAMES) {
      const t = TARGETS[n];
      for (let k = 0; k < 20; k++) {
        const d = -1 + 0.37 * k;
        const nu = 3 + 7.3 * k;
        writePaletteMap(t, d, m0);
        writePaletteMap(t, d + t.periodDoublings, m1);
        const twin = t.periodGain * nu + t.periodIters;
        worst = Math.max(worst, Math.abs(nu * m0[0] + m0[1] - (twin * m1[0] + m1[1])));
        const cap0 = iterCap(t, d, DEFAULT_DETAIL);
        const cap1 = iterCap(t, d + t.periodDoublings, DEFAULT_DETAIL);
        worst = Math.max(worst, Math.abs(t.periodGain * cap0 + t.periodIters - cap1));
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("caps the deepest view at about 200 iterations by default", () => {
    for (const n of TARGET_NAMES) {
      const t = TARGETS[n];
      const deep = iterCap(t, loopDoublings(t), DEFAULT_DETAIL);
      expect(deep).toBeGreaterThan(160);
      expect(deep).toBeLessThan(240);
      expect(iterCap(t, 0, DEFAULT_DETAIL)).toBeLessThanOrEqual(deep);
    }
    const t = TARGETS.seahorse;
    expect(capIndex(t, 1e6)).toBe(capIndex(t, MAX_DETAIL));
    expect(capIndex(t, -5)).toBe(capIndex(t, MIN_DETAIL));
    expect(capIndex(t, Number.NaN)).toBe(capIndex(t, DEFAULT_DETAIL));
  });
});

describe("smooth escape count", () => {
  it("is continuous across escape bands", () => {
    // A line toward the set from outside: the integer count steps many times.
    let worst = 0;
    let bands = 0;
    let last = smoothIter(-2.2, 1.6, 500);
    // Ends at about 6.4 iterations, short of the boundary, where counts get steep.
    let lastInt = Math.floor(last);
    for (let k = 1; k <= 4000; k++) {
      const s = k / 4000;
      const nu = smoothIter(-2.2 + 1.4 * s, 1.6 - 1.1 * s, 500);
      worst = Math.max(worst, Math.abs(nu - last));
      if (Math.floor(nu) !== lastInt) {
        bands++;
      }
      last = nu;
      lastInt = Math.floor(nu);
    }
    expect(bands).toBeGreaterThanOrEqual(4);
    expect(worst).toBeLessThan(0.02);
  });

  it("skips the main cardioid and period-2 bulb, and agrees with iterating", () => {
    expect(inMainBulbs(0, 0)).toBe(true);
    expect(inMainBulbs(-1, 0)).toBe(true);
    expect(inMainBulbs(0.4, 0.3)).toBe(false);
    expect(inMainBulbs(0.3, 0)).toBe(false);
    expect(smoothIter(0, 0, 100)).toBe(Infinity);
    // Inside the period-3 bulb, which the shortcut misses: the loop runs to the cap.
    expect(inMainBulbs(-0.1226, 0.7449)).toBe(false);
    expect(smoothIter(-0.1226, 0.7449, 2000)).toBe(Infinity);
    expect(smoothIter(1, 1, 100)).toBeLessThan(4);
  });
});

describe("angles and drift", () => {
  it("wrap and ignore bad input", () => {
    expect(advanceSpin(0, 10, 9)).toBeCloseTo(Math.PI / 2, 12);
    expect(advanceSpin(0, 10, -9)).toBeCloseTo(1.5 * Math.PI, 12);
    expect(advanceSpin(1, Number.NaN, 9)).toBe(1);
    expect(advanceSpin(1, 1, Number.NaN)).toBe(1);
    expect(advanceDrift(0.9, 48)).toBeCloseTo(0.1, 12);
    expect(advanceDrift(0.5, -1)).toBe(0.5);
  });
});

describe("palettes", () => {
  it.each(PALETTE_NAMES)("%s builds a seamless, moderate lookup table", (n) => {
    const p = PALETTES[n];
    const tex = paletteTexels(p);
    expect(tex.length).toBe(PALETTE_SIZE * 4);
    // Neighbouring texels, including across the wrap, differ by little.
    let jump = 0;
    for (let k = 0; k < PALETTE_SIZE; k++) {
      const j = (k + 1) % PALETTE_SIZE;
      for (let c = 0; c < 3; c++) {
        jump = Math.max(jump, Math.abs(tex[4 * k + c] - tex[4 * j + c]));
      }
    }
    expect(jump).toBeLessThan(16);
    // Brightness stays moderate, and the interior is the darkest colour.
    const luma = ([r, g, b]: readonly number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let maxL = 0;
    let minL = 1;
    for (let k = 0; k < 64; k++) {
      const l = luma(paletteAt(p, k / 64));
      maxL = Math.max(maxL, l);
      minL = Math.min(minL, l);
    }
    expect(maxL).toBeLessThan(0.8);
    expect(luma(hexToUnitRgb(p.interior))).toBeLessThan(minL);
    const mean = luma(paletteMean(p));
    expect(mean).toBeGreaterThan(minL);
    expect(mean).toBeLessThan(maxL);
  });
});
