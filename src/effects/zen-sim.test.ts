import { describe, expect, it } from "vitest";
import {
  BOX_N,
  createRerake,
  fillStoneLayout,
  GAP,
  inCentre,
  MAX_STONES,
  placeStones,
  rakePhase,
  RERAKE_DURATION,
  RERAKE_INTERVAL,
  RING_STEEP,
  ringRadius,
  SPACING_MAX,
  SPACING_MIN,
  STONE_FLOATS,
  STONE_PAD,
  stepRerake,
  stoneDistance,
  stonesApart,
  straightField,
  straightSlope,
  SWEEP_OFF,
  sweepWeight,
  sweepX,
  WAVE_SLOPE,
  waveLayout,
} from "./zen-sim";

const size = MAX_STONES * STONE_FLOATS;

function scene(seed: number, spacing: number, waviness: number, refWidth = 1920, generation = 0) {
  const pos = new Float32Array(size);
  const look = new Float32Array(size);
  const count = placeStones(pos, look, seed, refWidth);
  const wave = waveLayout(new Float64Array(6), seed, generation, waviness);
  const layout = fillStoneLayout(new Float32Array(size), wave, pos, count, spacing);
  return { pos, look, count, wave, layout };
}

const height = (theta: number, spacing: number) => Math.cos((2 * Math.PI * theta) / spacing);

describe("placeStones", () => {
  it("is deterministic and places several stones at 16:9", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const a = scene(seed, 16, 0.5);
      const b = scene(seed, 16, 0.5);
      expect(a.pos).toEqual(b.pos);
      expect(a.look).toEqual(b.look);
      expect(a.count).toBeGreaterThanOrEqual(3);
    }
  });

  it.each([1920, 1440, 2560])(
    "keeps stones apart, inside and out of the centre at width %i",
    (w) => {
      for (let seed = 1; seed <= 60; seed++) {
        const { pos, count } = scene(seed, 16, 0.5, w);
        for (let i = 0; i < count; i++) {
          const [x, y, r] = pos.subarray(i * STONE_FLOATS, i * STONE_FLOATS + 3);
          expect(inCentre(x, r, w)).toBe(false);
          expect(Math.abs(x - w / 2)).toBeGreaterThan(w / 6);
          expect(x - r * STONE_PAD).toBeGreaterThan(0);
          expect(x + r * STONE_PAD).toBeLessThan(w);
          expect(y - r * STONE_PAD).toBeGreaterThan(0);
          expect(y + r * STONE_PAD).toBeLessThan(1080);
          for (let j = 0; j < i; j++) {
            const o = j * STONE_FLOATS;
            expect(stonesApart(r, pos[o + 2], x - pos[o], y - pos[o + 1])).toBe(true);
            expect(Math.hypot(x - pos[o], y - pos[o + 1])).toBeGreaterThan(3 * (r + pos[o + 2]));
          }
        }
      }
    },
  );

  it("never lets two stones' boxes overlap, at any spacing and waviness", () => {
    let overlaps = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const spacing of [SPACING_MIN, SPACING_MAX]) {
        for (const wav of [0, 1]) {
          const { pos, count, wave, layout } = scene(seed, spacing, wav);
          for (let y = 0; y < 1080; y += 8) {
            for (let x = 0; x < 1920; x += 8) {
              const phi = straightField(wave, x, y);
              let inside = 0;
              for (let i = 0; i < count; i++) {
                const o = i * STONE_FLOATS;
                const inv = layout[o + 2];
                const rz = layout[o + 3];
                const n = (phi - layout[o]) * inv;
                const t = (x - pos[o] - layout[o + 1] * (y - pos[o + 1])) * inv;
                if (Math.abs(t) < GAP * rz && Math.abs(n) < BOX_N * rz) inside++;
              }
              if (inside > overlaps) overlaps = inside;
            }
          }
        }
      }
    }
    expect(overlaps).toBeLessThanOrEqual(1);
  });
});

describe("waveLayout", () => {
  it("keeps the line slope within WAVE_SLOPE * waviness", () => {
    for (let seed = 1; seed <= 30; seed++) {
      for (const wav of [0.25, 1]) {
        const w = waveLayout(new Float64Array(6), seed, 3, wav);
        let max = 0;
        for (let x = 0; x < 4000; x += 3) max = Math.max(max, Math.abs(straightSlope(w, x)));
        expect(max).toBeLessThanOrEqual(WAVE_SLOPE * wav + 1e-9);
        expect(max).toBeGreaterThan(0.3 * WAVE_SLOPE * wav);
      }
    }
  });

  it("is straight at waviness 0, and differs between generations", () => {
    const w = waveLayout(new Float64Array(6), 4, 0, 0);
    expect(straightField(w, 123, 456)).toBe(456);
    const a = waveLayout(new Float64Array(6), 4, 0, 1);
    const b = waveLayout(new Float64Array(6), 4, 1, 1);
    expect(a).not.toEqual(b);
    expect(waveLayout(new Float64Array(6), 4, 1, 1)).toEqual(b);
  });
});

describe("fillStoneLayout", () => {
  it("snaps each stone to a crest and sizes whole rings", () => {
    for (const spacing of [12, 16, 23]) {
      const { pos, count, wave, layout } = scene(7, spacing, 0.8);
      for (let i = 0; i < count; i++) {
        const o = i * STONE_FLOATS;
        const phiC = straightField(wave, pos[o], pos[o + 1]);
        expect(layout[o] / spacing).toBeCloseTo(Math.round(layout[o] / spacing), 6);
        expect(Math.abs(layout[o] - phiC)).toBeLessThanOrEqual(spacing / 2 + 1e-3);
        const g = 1 / layout[o + 2];
        expect(g).toBeCloseTo(Math.hypot(1, straightSlope(wave, pos[o])), 5);
        const rings = (layout[o + 3] * g) / spacing;
        expect(rings).toBeCloseTo(Math.round(rings), 4);
        expect(layout[o + 3]).toBeGreaterThan(pos[o + 2] * STONE_PAD);
        expect(layout[o + 3]).toBeCloseTo(ringRadius(pos[o + 2], spacing, g), 3);
      }
      for (let i = count * STONE_FLOATS; i < size; i++) expect(layout[i]).toBe(0);
    }
  });
});

describe("stoneDistance", () => {
  it("is continuous, never steeper than the ring term, and equals |n| outside the gap", () => {
    const rz = 120;
    const step = 0.25;
    let prev = 0;
    let jump = 0;
    let wrong = 0;
    for (let n = -200; n <= 200; n += 7.3) {
      for (let t = -400; t <= 400; t += step) {
        const r = Math.hypot(t, n);
        const l = stoneDistance(t, n, r, rz);
        if (t > -400) jump = Math.max(jump, Math.abs(l - prev));
        prev = l;
        if ((Math.abs(t) >= GAP * rz || Math.abs(n) >= rz) && Math.abs(l - Math.abs(n)) > 1e-9) {
          wrong++;
        }
        if (r < rz && Math.abs(l - r) > 1e-9) wrong++;
      }
    }
    expect(jump).toBeLessThanOrEqual(step * (1 + RING_STEEP) + 1e-9);
    expect(wrong).toBe(0);
  });
});

describe("rakePhase", () => {
  const out = new Float64Array(3);
  const out2 = new Float64Array(3);

  it("is the straight field away from the stones", () => {
    const { pos, count, wave, layout } = scene(3, 16, 0.7);
    for (let y = 0; y < 1080; y += 37) {
      for (let x = 0; x < 1920; x += 41) {
        let far = true;
        for (let i = 0; i < count; i++) {
          const o = i * STONE_FLOATS;
          if (Math.hypot(x - pos[o], y - pos[o + 1]) < 3 * layout[o + 3]) far = false;
        }
        if (!far) continue;
        rakePhase(out, x, y, wave, pos, layout, count);
        expect(out[0]).toBeCloseTo(straightField(wave, x, y), 9);
        expect(out[1]).toBeCloseTo(straightSlope(wave, x), 9);
        expect(out[2]).toBe(1);
      }
    }
  });

  it("draws concentric rings round each stone", () => {
    for (const wav of [0, 1]) {
      const spacing = 16;
      const { pos, count, wave, layout } = scene(5, spacing, wav);
      for (let i = 0; i < count; i++) {
        const o = i * STONE_FLOATS;
        const g = 1 / layout[o + 2];
        const rz = layout[o + 3];
        for (let a = 0; a < 6.28; a += 0.3) {
          for (let r = pos[o + 2]; r < rz - 2; r += 3.1) {
            rakePhase(
              out,
              pos[o] + r * Math.cos(a),
              pos[o + 1] + r * Math.sin(a),
              wave,
              pos,
              layout,
              count,
            );
            expect(height(out[0], spacing)).toBeCloseTo(height(g * r, spacing), 6);
          }
        }
      }
    }
  });

  /**
   * The issue's test: the groove pattern is continuous across the stone blend, and
   * the line spacing stays the straight lines' spacing (|∇θ| = |∇φ|) except in
   * the flat pockets and the thin rim where the rings stop.
   */
  it.each([
    [12, 0, 1e-6],
    [16, 0, 1e-6],
    [24, 0, 1e-6],
    [16, 0.5, 0.21],
    [24, 1, 0.42],
  ])("is continuous, with constant spacing, at spacing %i and waviness %f", (spacing, wav, tol) => {
    const step = 0.05;
    const maxSlope = ((2 * Math.PI) / spacing) * (1 + RING_STEEP) * Math.hypot(1, WAVE_SLOPE);
    for (const seed of [1, 2]) {
      const { pos, count, wave, layout } = scene(seed, spacing, wav);
      let n = 0;
      let off = 0;
      let jump = 0;
      let low = Infinity;
      for (let i = 0; i < count; i++) {
        const o = i * STONE_FLOATS;
        const rz = layout[o + 3];
        for (let y = pos[o + 1] - 2.5 * rz; y < pos[o + 1] + 2.5 * rz; y += 3.1) {
          for (let x = pos[o] - 2.5 * rz; x < pos[o] + 2.5 * rz; x += 3.1) {
            if (Math.hypot(x - pos[o], y - pos[o + 1]) < pos[o + 2]) continue;
            rakePhase(out, x, y, wave, pos, layout, count);
            const h = height(out[0], spacing);
            rakePhase(out2, x + step, y, wave, pos, layout, count);
            jump = Math.max(jump, Math.abs(height(out2[0], spacing) - h));
            rakePhase(out2, x, y + step, wave, pos, layout, count);
            jump = Math.max(jump, Math.abs(height(out2[0], spacing) - h));

            const ratio = Math.hypot(out[1], out[2]) / Math.hypot(1, straightSlope(wave, x));
            if (ratio === 0) continue; // flat pocket
            n++;
            if (Math.abs(ratio - 1) > tol) {
              // Only the rim where the rings stop may be steeper.
              low = Math.min(low, ratio);
              off++;
            }
          }
        }
      }
      expect(jump).toBeLessThanOrEqual(maxSlope * step);
      expect(low).toBeGreaterThan(1 + RING_STEEP - tol - 0.3);
      expect(off / n).toBeLessThan(0.01);
    }
  });

  it("has an analytic gradient that matches the groove height's slope", () => {
    const spacing = 16;
    const e = 1e-3;
    const { pos, count, wave, layout } = scene(9, spacing, 0.6);
    let n = 0;
    let bad = 0;
    for (let i = 0; i < count; i++) {
      const o = i * STONE_FLOATS;
      const rz = layout[o + 3];
      for (let y = pos[o + 1] - 2.2 * rz; y < pos[o + 1] + 2.2 * rz; y += 3.7) {
        for (let x = pos[o] - 2.2 * rz; x < pos[o] + 2.2 * rz; x += 3.7) {
          rakePhase(out, x, y, wave, pos, layout, count);
          const k = ((-2 * Math.PI) / spacing) * Math.sin((2 * Math.PI * out[0]) / spacing);
          rakePhase(out2, x + e, y, wave, pos, layout, count);
          const hx = height(out2[0], spacing);
          rakePhase(out2, x - e, y, wave, pos, layout, count);
          const dx = (hx - height(out2[0], spacing)) / (2 * e);
          rakePhase(out2, x, y + e, wave, pos, layout, count);
          const hy = height(out2[0], spacing);
          rakePhase(out2, x, y - e, wave, pos, layout, count);
          const dy = (hy - height(out2[0], spacing)) / (2 * e);
          n++;
          // Creases (where the winning branch changes) can fall between the samples.
          if (Math.abs(dx - k * out[1]) > 1e-3 || Math.abs(dy - k * out[2]) > 1e-3) bad++;
        }
      }
    }
    expect(bad / n).toBeLessThan(0.005);
  });
});

describe("rerake", () => {
  it("waits RERAKE_INTERVAL, then sweeps monotonically and finishes in RERAKE_DURATION", () => {
    const s = createRerake();
    const dt = 1 / 60;
    let t = 0;
    while (s.progress < 0) {
      expect(sweepX(s, 1920)).toBe(SWEEP_OFF);
      stepRerake(s, dt, true);
      t += dt;
      expect(t).toBeLessThan(RERAKE_INTERVAL + 2 * dt);
    }
    expect(t).toBeGreaterThanOrEqual(RERAKE_INTERVAL - 1e-6);
    let prev = sweepX(s, 1920);
    expect(sweepWeight(0, prev)).toBe(0);
    let sweepTime = 0;
    let done = false;
    while (!done) {
      done = stepRerake(s, dt, true);
      sweepTime += dt;
      if (done) break;
      const x = sweepX(s, 1920);
      expect(x).toBeGreaterThan(prev);
      prev = x;
    }
    expect(sweepTime).toBeGreaterThanOrEqual(RERAKE_DURATION - 1e-6);
    expect(sweepTime).toBeLessThan(RERAKE_DURATION + 2 * dt);
    expect(sweepWeight(1920, prev)).toBe(1);
    expect(s.generation).toBe(1);
    expect(s.progress).toBe(-1);
    expect(sweepX(s, 1920)).toBe(SWEEP_OFF);
  });

  it("never starts while disabled, but finishes a sweep under way", () => {
    const s = createRerake();
    for (let i = 0; i < 1000; i++) stepRerake(s, 1, false);
    expect(s.progress).toBe(-1);
    stepRerake(s, RERAKE_INTERVAL, true);
    expect(s.progress).toBe(0);
    for (let i = 0; i < RERAKE_DURATION - 1; i++) expect(stepRerake(s, 1, false)).toBe(false);
    expect(stepRerake(s, 1.5, false)).toBe(true);
    expect(s.generation).toBe(1);
  });

  it("ignores bad time steps", () => {
    const s = createRerake();
    stepRerake(s, Number.NaN, true);
    stepRerake(s, -5, true);
    stepRerake(s, Infinity, true);
    expect(s.idle).toBe(0);
  });
});
