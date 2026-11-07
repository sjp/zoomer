import { describe, expect, it } from "vitest";
import {
  boundAt,
  gradientAt,
  heightAt,
  initialState,
  LATTICE_PERIOD,
  layoutPool,
  lipschitz,
  magnet,
  maxHeight,
  poolBounds,
  project,
  SHADOW_RADIUS,
  spacingFor,
  stepState,
  wrapAngle,
  type Field,
  type Layout,
  type PoolPosition,
  type Rect,
  type Rhythm,
} from "./ferro-sim";
import { createRng } from "../noise";

const RHYTHMS: Rhythm[] = ["breathe", "pulse", "hold"];
const field = (amp: number, density = 4.5, angle = 0.3): Field => ({
  amp,
  spacing: spacingFor(density, amp),
  angle,
});
const FIELDS = [field(0), field(0.3), field(0.7), field(1), field(1, 3, 1), field(1, 8, 0.9)];

describe("magnet", () => {
  it("is bounded, periodic and continuous for every rhythm", () => {
    let bad = 0;
    let maxJump = 0;
    for (const r of RHYTHMS) {
      const n = 2000;
      let prev = magnet(0, r);
      for (let i = 1; i <= n; i++) {
        const u = i / n;
        const m = magnet(u, r);
        if (!(m >= 0 && m <= 1)) {
          bad++;
        }
        if (Math.abs(magnet(u + 3, r) - m) > 1e-9 || Math.abs(magnet(u - 1, r) - m) > 1e-9) {
          bad++;
        }
        maxJump = Math.max(maxJump, Math.abs(m - prev));
        prev = m;
      }
    }
    expect(bad).toBe(0);
    // Steepest is the pulse's smoothstep: 1.5 per quarter cycle -> 6 per cycle.
    expect(maxJump).toBeLessThan(6.01 / 2000);
  });

  it("rests and peaks within each cycle, except hold", () => {
    expect(magnet(0, "pulse")).toBe(0);
    expect(magnet(0.375, "pulse")).toBe(1);
    expect(magnet(0.875, "pulse")).toBe(0);
    expect(magnet(0, "breathe")).toBeCloseTo(0, 12);
    expect(magnet(0.5, "breathe")).toBeCloseTo(1, 12);
    expect(magnet(0.123, "hold")).toBe(1);
  });
});

describe("height field", () => {
  it("is non-negative inside the pool and zero outside", () => {
    const rng = createRng(5);
    let bad = 0;
    for (const f of FIELDS) {
      const top = maxHeight(f);
      for (let i = 0; i < 2000; i++) {
        const x = (rng() * 2 - 1) * 1.6;
        const z = (rng() * 2 - 1) * 1.6;
        const h = heightAt(x, z, f);
        const r2 = x * x + z * z;
        if (r2 >= 1 && h !== 0) {
          bad++;
        }
        if (r2 < 1 && !(h > 0)) {
          bad++;
        }
        if (h > top + 1e-12 || h > boundAt(r2, f) + 1e-12) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("peaks at the centre spike", () => {
    for (const f of FIELDS) {
      expect(heightAt(0, 0, f)).toBeCloseTo(maxHeight(f), 12);
    }
  });

  it("is continuous within its Lipschitz bound", () => {
    const rng = createRng(11);
    let worst = 0;
    for (const f of FIELDS) {
      const L = lipschitz(f);
      for (let i = 0; i < 3000; i++) {
        const x = (rng() * 2 - 1) * 1.1;
        const z = (rng() * 2 - 1) * 1.1;
        const a = rng() * Math.PI * 2;
        const step = 1e-3;
        const dh = Math.abs(
          heightAt(x + step * Math.cos(a), z + step * Math.sin(a), f) - heightAt(x, z, f),
        );
        worst = Math.max(worst, dh / (step * L));
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
  });

  it("has a gradient matching finite differences", () => {
    const rng = createRng(3);
    const g = [0, 0];
    let worst = 0;
    for (const f of FIELDS) {
      for (let i = 0; i < 1000; i++) {
        const x = (rng() * 2 - 1) * 0.95;
        const z = (rng() * 2 - 1) * 0.95;
        const e = 1e-6;
        const fx = (heightAt(x + e, z, f) - heightAt(x - e, z, f)) / (2 * e);
        const fz = (heightAt(x, z + e, f) - heightAt(x, z - e, f)) / (2 * e);
        gradientAt(x, z, f, g);
        // Kinks (spike tips, cell borders) make a rare sample disagree; skip those.
        const err = Math.hypot(fx - g[0], fz - g[1]);
        const fx2 = (heightAt(x + 2 * e, z, f) - heightAt(x, z, f)) / (2 * e);
        const fz2 = (heightAt(x, z + 2 * e, f) - heightAt(x, z, f)) / (2 * e);
        if (Math.abs(fx2 - fx) > 1e-3 || Math.abs(fz2 - fz) > 1e-3) {
          continue;
        }
        worst = Math.max(worst, err);
      }
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it("looks the same after a lattice turn of 60 degrees, so the angle wraps without a jump", () => {
    const rng = createRng(9);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const x = (rng() * 2 - 1) * 0.9;
      const z = (rng() * 2 - 1) * 0.9;
      const a = rng() * LATTICE_PERIOD;
      const f1 = { amp: 1, spacing: 0.21, angle: a };
      const f2 = { amp: 1, spacing: 0.21, angle: a + LATTICE_PERIOD };
      const f3 = { amp: 1, spacing: 0.21, angle: wrapAngle(a - 1e-9 + 5 * LATTICE_PERIOD) };
      const f4 = { amp: 1, spacing: 0.21, angle: a - 1e-9 };
      worst = Math.max(
        worst,
        Math.abs(heightAt(x, z, f1) - heightAt(x, z, f2)),
        Math.abs(heightAt(x, z, f3) - heightAt(x, z, f4)),
      );
    }
    expect(worst).toBeLessThan(1e-9);
    expect(wrapAngle(LATTICE_PERIOD)).toBe(0);
    expect(wrapAngle(-0.1)).toBeCloseTo(LATTICE_PERIOD - 0.1, 12);
  });
});

describe("clock", () => {
  it("wraps phase and angle, and eases the magnet across a rhythm switch", () => {
    const s = initialState("pulse");
    let bad = 0;
    let maxStep = 0;
    for (let i = 0; i < 3000; i++) {
      const rhythm = i < 1500 ? "pulse" : "breathe";
      const before = s.amp;
      stepState(s, 1 / 60, 6, rhythm);
      if (!(s.phase >= 0 && s.phase < 1 && s.angle >= 0 && s.angle < LATTICE_PERIOD)) {
        bad++;
      }
      maxStep = Math.max(maxStep, Math.abs(s.amp - before));
    }
    stepState(s, Number.NaN, 6, "hold");
    expect(Number.isFinite(s.amp + s.phase + s.angle)).toBe(true);
    expect(bad).toBe(0);
    expect(maxStep).toBeLessThanOrEqual(1.5 / 60 + 1e-12);
  });
});

describe("layout", () => {
  const SIZES = [
    [1920, 1080],
    [3840, 2160],
    [1080, 1920],
    [640, 480],
  ] as const;
  const POSITIONS: PoolPosition[] = ["left", "centre", "right"];

  it("keeps the rim inside the frame and the bounds around everything drawn", () => {
    const rng = createRng(17);
    const layout: Layout = { focal: 1, anchorX: 0, anchorY: 0 };
    const rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
    const q = [0, 0];
    let bad = 0;
    for (const [w, h] of SIZES) {
      for (const pos of POSITIONS) {
        for (const size of [0.6, 1, 1.4]) {
          layoutPool(w, h, size, pos, layout);
          const top = maxHeight(field(1, 3));
          poolBounds(layout, top, w, h, rect);
          if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > w || rect.y + rect.h > h) {
            bad++;
          }
          for (let i = 0; i < 64; i++) {
            const a = (i / 64) * Math.PI * 2;
            // Rim: on screen, clear of the frame's edges.
            project(Math.cos(a), 0, Math.sin(a), layout.focal, q);
            const sx = layout.anchorX + q[0];
            const sy = layout.anchorY + q[1];
            if (sx < -1e-6 || sx > w + 1e-6 || sy < -1e-6) {
              bad++;
            }
            // Random points of the drawn volume, inside the bounds where on screen.
            const r = Math.sqrt(rng());
            const onFloor = rng() < 0.5;
            const rr = onFloor ? r * SHADOW_RADIUS : r;
            project(rr * Math.cos(a), onFloor ? 0 : rng() * top, rr * Math.sin(a), layout.focal, q);
            const px = layout.anchorX + q[0];
            const py = layout.anchorY + q[1];
            if (px < 0 || px > w || py < 0 || py > h) {
              continue;
            }
            if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) {
              bad++;
            }
          }
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("covers a modest share of a 16:9 frame at the default size", () => {
    const layout: Layout = { focal: 1, anchorX: 0, anchorY: 0 };
    const rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
    layoutPool(3840, 2160, 1, "right", layout);
    poolBounds(layout, maxHeight(field(1, 4)), 3840, 2160, rect);
    const share = (rect.w * rect.h) / (3840 * 2160);
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.25);
  });
});
