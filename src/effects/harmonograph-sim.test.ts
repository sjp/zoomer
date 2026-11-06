import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseFigure,
  createFigure,
  createHarmonograph,
  fadeAlpha,
  FIGURE_SEGMENTS,
  MAX_SEG,
  measureFigure,
  MIN_SEG,
  PALETTE_STOPS,
  SEG_FLOATS,
  TIME_PERIOD,
  type Figure,
} from "./harmonograph-sim";
import { createRng } from "./noise";

const settings = { drawTime: 30, complexity: 0.5 };

function snapshot(f: Figure) {
  return {
    amp: [...f.amp],
    freq: [...f.freq],
    phase: [...f.phase],
    decay: [...f.decay],
    duration: f.duration,
    seg: f.seg,
    segments: f.segments,
    hue: f.hue,
  };
}

describe("chooseFigure", () => {
  it("is deterministic per seed", () => {
    const a = createFigure();
    const b = createFigure();
    chooseFigure(a, createRng(7), 0.5);
    chooseFigure(b, createRng(7), 0.5);
    expect(snapshot(a)).toEqual(snapshot(b));
    chooseFigure(b, createRng(8), 0.5);
    expect(snapshot(a)).not.toEqual(snapshot(b));
  });

  it("only returns usable figures across seeds and complexities", () => {
    const f = createFigure();
    for (let seed = 0; seed < 40; seed++) {
      const c = (seed % 5) / 4;
      chooseFigure(f, createRng(seed), c);
      expect(measureFigure(f)).toBeNull();
      expect(f.seg).toBeGreaterThanOrEqual(MIN_SEG);
      expect(f.seg).toBeLessThanOrEqual(MAX_SEG);
      expect(f.segments).toBeLessThanOrEqual(FIGURE_SEGMENTS + 1);
      expect(f.hue).toBeGreaterThanOrEqual(0);
      expect(f.hue).toBeLessThan(PALETTE_STOPS);
    }
  });

  it("rejects degenerate figures", () => {
    const f = createFigure();
    const set = (freq: number[], phase: number[], amp = [1, 0, 1, 0]) => {
      f.amp.set(amp);
      f.freq.set(freq);
      f.phase.set(phase);
      f.decay.fill(0.03);
      f.duration = 100;
    };
    // Same frequency and phase on both axes: a straight (decaying) line.
    set([1, 1, 1, 1], [0, 0, 0, 0]);
    expect(measureFigure(f)).toBe("line");
    // The y terms cancel, so y never moves.
    set([1, 2, 2, 2], [0, 0, 0, Math.PI], [1, 0, 1, 1]);
    expect(measureFigure(f)).toBe("collapsed");
    // A 1:1 figure a quarter-cycle out of phase is a circle spiral: fine.
    set([1, 1, 1, 1], [0, 0, Math.PI / 2, 0]);
    expect(measureFigure(f)).toBeNull();
    // Too few cycles to say anything.
    f.duration = 5;
    expect(measureFigure(f)).toBe("sparse");
    // Far too many cycles for the segment budget.
    set([1, 1, 1, 1], [0, 0, Math.PI / 2, 0]);
    f.decay.fill(0.0001);
    f.duration = 20000;
    expect(measureFigure(f)).toBe("dense");
  });
});

describe("createHarmonograph", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps segment lengths within tolerance of the figure's target", () => {
    for (let seed = 1; seed <= 3; seed++) {
      const h = createHarmonograph(16384, createRng(seed), seed / 3);
      const target = h.figure.seg;
      const segments = h.figure.segments;
      // Draw the whole first figure in one go, at 10 s per figure.
      for (let k = 0; k < 100 && h.live < segments - 1; k++) {
        h.step(0.1, { ...settings, drawTime: 10 });
      }
      const n = h.live;
      expect(n).toBeGreaterThan(segments * 0.9);
      let worst = 0;
      let gaps = 0;
      // The last segment may be cut short by the end of the figure.
      for (let i = 0; i < n - 1; i++) {
        const o = i * SEG_FLOATS;
        const len = Math.hypot(h.data[o + 2] - h.data[o], h.data[o + 3] - h.data[o + 1]);
        worst = Math.max(worst, Math.abs(len / target - 1));
        // Consecutive segments join up.
        if (i > 0 && (h.data[o] !== h.data[o - 4] || h.data[o + 1] !== h.data[o - 3])) {
          gaps++;
        }
      }
      expect(worst).toBeLessThan(0.1);
      expect(gaps).toBe(0);
    }
  });

  it("stays inside the normalised box, give or take sampling", () => {
    const h = createHarmonograph(16384, createRng(3));
    for (let k = 0; k < 150; k++) {
      h.step(0.1, { ...settings, drawTime: 5 });
    }
    let reach = 0;
    let phaseLo = Infinity;
    let phaseHi = -Infinity;
    for (let i = 0; i < h.capacity * SEG_FLOATS; i += SEG_FLOATS) {
      for (let j = 0; j < 4; j++) {
        reach = Math.max(reach, Math.abs(h.data[i + j]));
      }
      phaseLo = Math.min(phaseLo, h.data[i + 5]);
      phaseHi = Math.max(phaseHi, h.data[i + 5]);
    }
    expect(reach).toBeGreaterThan(0.9);
    expect(reach).toBeLessThanOrEqual(1.03);
    expect(phaseLo).toBeGreaterThanOrEqual(0);
    expect(phaseHi).toBeLessThan(PALETTE_STOPS);
  });

  it("allocates no typed arrays while stepping, across figure changes", () => {
    const h = createHarmonograph(4096, createRng(5));
    const data = h.data;
    const figure = h.figure;
    let created = 0;
    const names = ["Float32Array", "Float64Array", "Int32Array", "Uint32Array"] as const;
    const counting: ProxyHandler<(typeof globalThis)[(typeof names)[number]]> = {
      construct(target, args) {
        created++;
        return Reflect.construct(target, args) as object;
      },
    };
    for (const name of names) {
      const Original = globalThis[name];
      vi.stubGlobal(name, new Proxy(Original, counting));
    }
    // Several figures, drawn fast.
    for (let k = 0; k < 400; k++) {
      h.step(0.1, { drawTime: 5, complexity: (k % 7) / 6 });
    }
    expect(created).toBe(0);
    expect(h.data).toBe(data);
    expect(h.figure).toBe(figure);
  });

  it("wraps the ring, tracking the live range and dirty slots", () => {
    const cap = 64;
    const h = createHarmonograph(cap, createRng(9));
    let written = 0;
    let wrapped = false;
    for (let k = 0; k < 400; k++) {
      const before = h.head;
      h.step(1 / 60, settings);
      const n = h.dirtyCount;
      expect(n).toBeLessThanOrEqual(cap);
      expect(n === 0 || h.dirtyStart === before).toBe(true);
      expect(h.head).toBe((before + n) % cap);
      if (h.head < before) {
        wrapped = true;
      }
      written += n;
      expect(h.live).toBeLessThanOrEqual(cap);
      h.clearDirty();
    }
    expect(wrapped).toBe(true);
    expect(written).toBeGreaterThan(cap * 2);
    expect(h.live).toBe(cap);
    // Live slots, oldest first, have non-decreasing birth times.
    for (let i = 1; i < h.live; i++) {
      const a = (h.head - h.live + i - 1 + cap) % cap;
      const b = (a + 1) % cap;
      expect(h.births[b]).toBeGreaterThanOrEqual(h.births[a]);
      expect(h.data[b * SEG_FLOATS]).toBe(h.data[a * SEG_FLOATS + 2]);
    }
  });

  it("expires segments past the fade age and stores wrapped birth times", () => {
    const h = createHarmonograph(16384, createRng(11));
    for (let k = 0; k < 300; k++) {
      h.step(0.1, { ...settings, drawTime: 10 });
    }
    expect(h.live).toBeGreaterThan(0);
    for (let i = 0; i < h.live; i++) {
      const slot = (h.head - 1 - i + h.capacity) % h.capacity;
      const age = h.time - h.births[slot];
      expect(age).toBeLessThan(h.fadeAge);
      expect(h.data[slot * SEG_FLOATS + 4]).toBeCloseTo(h.births[slot] % TIME_PERIOD, 2);
    }
    // At most about two figures are visible.
    expect(h.live).toBeLessThan(2.5 * FIGURE_SEGMENTS);
  });
});

describe("fadeAlpha", () => {
  it("falls monotonically from 1 to 0 over the fade age", () => {
    const fadeAge = 100;
    let prev = fadeAlpha(0, fadeAge);
    expect(prev).toBe(1);
    for (let age = 0; age <= 120; age += 0.25) {
      const a = fadeAlpha(age, fadeAge);
      expect(a).toBeLessThanOrEqual(prev);
      expect(a).toBeGreaterThanOrEqual(0);
      prev = a;
    }
    expect(fadeAlpha(fadeAge, fadeAge)).toBe(0);
  });
});
