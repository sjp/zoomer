import { describe, expect, it } from "vitest";
import {
  altitudeHigh,
  altitudeLow,
  APEX_Y,
  BALLOON_FLOATS,
  BALLOON_STRIP,
  balloonCount,
  balloonHaze,
  balloonRadius,
  balloonSpeed,
  BASKET_BOTTOM,
  BASKET_HALF,
  BASKET_TOP,
  BURN_GAP_MAX,
  BURN_MAX,
  burnGlow,
  centreBoost,
  CONE_COS,
  CONE_SIN,
  createBalloons,
  EXTENT,
  hillColor,
  LIGHTS,
  lightFor,
  MOUTH_HALF,
  MOUTH_Y,
  OUTLINE,
  PALETTE_SIZE,
  PALETTES,
  paletteFor,
  stepBalloons,
  TANGENT_Y,
  writeBalloons,
} from "./balloons-sim";
import { LIGHT_OPTIONS, MAX_BALLOONS, MIN_BALLOONS, PALETTE_OPTIONS } from "./balloons.meta";
import type { Rgb } from "./color";

const ASPECT = 16 / 9;
const DT = 1 / 30;

/** Whether (x, y) is inside the convex, clockwise `OUTLINE`, by at least `margin`. */
function insideOutline(x: number, y: number, margin = 0): boolean {
  const n = OUTLINE.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = OUTLINE[i];
    const [bx, by] = OUTLINE[(i + 1) % n];
    const ex = bx - ax;
    const ey = by - ay;
    // Right of each edge (y up), by `margin`.
    if ((ey * (x - ax) - ex * (y - ay)) / Math.hypot(ex, ey) < margin) return false;
  }
  return true;
}

describe("balloon shape", () => {
  it("has a cone tangent to the unit circle", () => {
    expect(CONE_SIN ** 2 + CONE_COS ** 2).toBeCloseTo(1);
    const tx = Math.sqrt(1 - TANGENT_Y ** 2);
    // The tangent point lies on the cone's side line.
    expect((TANGENT_Y - APEX_Y) * CONE_SIN - tx * CONE_COS).toBeCloseTo(0);
    expect(MOUTH_HALF).toBeGreaterThan(BASKET_HALF);
    expect(MOUTH_Y).toBeGreaterThan(BASKET_TOP);
  });

  it("outline encloses the envelope, mouth and basket", () => {
    // The round top, down to where the cone takes over.
    const t0 = Math.asin(TANGENT_Y);
    for (let a = 0; a <= 64; a++) {
      const t = t0 + (a / 64) * (Math.PI - 2 * t0);
      expect(insideOutline(Math.cos(t), Math.sin(t), 0.04)).toBe(true);
    }
    expect(insideOutline(MOUTH_HALF, MOUTH_Y, 0.04)).toBe(true);
    expect(insideOutline(-MOUTH_HALF, MOUTH_Y, 0.04)).toBe(true);
    expect(insideOutline(BASKET_HALF, BASKET_BOTTOM, 0.04)).toBe(true);
    expect(insideOutline(-BASKET_HALF, BASKET_BOTTOM, 0.04)).toBe(true);
    // The burner glow around the mouth.
    expect(insideOutline(0.3, MOUTH_Y, 0)).toBe(true);
  });

  it("strip has every outline vertex once and fits within EXTENT", () => {
    expect(BALLOON_STRIP.length).toBe(OUTLINE.length * 2);
    for (const [x, y] of OUTLINE) {
      let found = 0;
      for (let i = 0; i < BALLOON_STRIP.length; i += 2) {
        if (BALLOON_STRIP[i] === x && BALLOON_STRIP[i + 1] === y) found++;
      }
      expect(found).toBe(1);
      expect(Math.abs(x)).toBeLessThan(EXTENT);
    }
  });
});

describe("depth curves", () => {
  it("size and speed fall and haze rises with depth", () => {
    for (let d = 0; d < 1; d += 0.05) {
      expect(balloonRadius(d + 0.05)).toBeLessThan(balloonRadius(d));
      expect(balloonSpeed(d + 0.05)).toBeLessThan(balloonSpeed(d));
      expect(balloonHaze(d + 0.05)).toBeGreaterThan(balloonHaze(d));
      expect(altitudeLow(d)).toBeLessThan(altitudeHigh(d));
    }
  });

  it("keeps every balloon inside the frame vertically", () => {
    for (let d = 0; d <= 1; d += 0.1) {
      expect(altitudeHigh(d) + balloonRadius(d)).toBeLessThan(0.9);
      expect(altitudeLow(d) + BASKET_BOTTOM * balloonRadius(d)).toBeGreaterThan(0.15);
    }
  });

  it("speeds up in the centre third and not at the edges", () => {
    expect(centreBoost(ASPECT / 2, ASPECT)).toBeGreaterThan(1.5);
    expect(centreBoost(ASPECT / 3, ASPECT)).toBeGreaterThan(1.5);
    expect(centreBoost(0, ASPECT)).toBeCloseTo(1);
    expect(centreBoost(ASPECT, ASPECT)).toBeCloseTo(1);
    expect(centreBoost(-1, ASPECT)).toBeCloseTo(1);
  });

  it("counts clamp to whole balloons", () => {
    expect(balloonCount(0)).toBe(MIN_BALLOONS);
    expect(balloonCount(99)).toBe(MAX_BALLOONS);
    expect(balloonCount(5.4)).toBe(5);
    expect(balloonCount(Number.NaN)).toBe(MIN_BALLOONS);
  });
});

describe("palettes and light", () => {
  it("has a palette and light for every option, and falls back", () => {
    for (const o of PALETTE_OPTIONS) expect(paletteFor(o.value)).toBe(PALETTES[o.value]);
    for (const o of LIGHT_OPTIONS) expect(lightFor(o.value)).toBe(LIGHTS[o.value]);
    expect(paletteFor("nope")).toBe(PALETTES.classic);
    expect(lightFor("toString")).toBe(LIGHTS.morning);
    for (const p of Object.values(PALETTES)) expect(p.length).toBe(PALETTE_SIZE);
    for (const l of Object.values(LIGHTS)) expect(Math.hypot(...l.dir)).toBeCloseTo(1);
  });

  it("hazes farther hill layers towards the horizon", () => {
    const light = LIGHTS.morning;
    const dist = (c: Rgb) => Math.hypot(...c.map((v, i) => v - light.horizon[i]));
    const back = hillColor([0, 0, 0], light, 0, 3);
    const mid = hillColor([0, 0, 0], light, 1, 3);
    const front = hillColor([0, 0, 0], light, 2, 3);
    expect(dist(back)).toBeLessThan(dist(mid));
    expect(dist(mid)).toBeLessThan(dist(front));
  });
});

describe("balloons", () => {
  it("are deterministic per seed", () => {
    const run = (seed: number) => {
      const b = createBalloons(seed, ASPECT);
      for (let s = 0; s < 3000; s++) stepBalloons(b, DT, ASPECT, 1, 6);
      return [...b.x, ...b.y, ...b.burnTimer, ...b.burnAge];
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });

  it("are drawn farthest first, with distinct gore colours that close round", () => {
    const b = createBalloons(3, ASPECT);
    for (let k = 1; k < MAX_BALLOONS; k++) {
      expect(b.depth[b.order[k]]).toBeLessThanOrEqual(b.depth[b.order[k - 1]]);
    }
    for (let i = 0; i < MAX_BALLOONS; i++) {
      const [a, c2, c3] = [b.colors[i * 3], b.colors[i * 3 + 1], b.colors[i * 3 + 2]];
      expect(a).not.toBe(c2);
      expect(new Set([a, c2, c3]).size).toBe(b.colorCount[i]);
      expect(b.gores[i] % b.colorCount[i]).toBe(0);
    }
  });

  it("spread any first few over near and far", () => {
    for (let seed = 0; seed < 20; seed++) {
      const b = createBalloons(seed, ASPECT);
      const first = [...b.depth.slice(0, MIN_BALLOONS)];
      expect(Math.max(...first) - Math.min(...first)).toBeGreaterThan(0.3);
    }
  });

  it("never start in the centre third", () => {
    for (let seed = 0; seed < 50; seed++) {
      const b = createBalloons(seed, ASPECT);
      for (const x of b.x) expect(x < ASPECT / 3 || x > (2 * ASPECT) / 3).toBe(true);
    }
  });

  it("only wrap while fully off-screen (no pop-in)", () => {
    for (const seed of [1, 2, 3]) {
      const b = createBalloons(seed, ASPECT);
      const prev = new Float64Array(MAX_BALLOONS);
      let wraps = 0;
      for (let s = 0; s < 20000; s++) {
        prev.set(b.x);
        stepBalloons(b, 0.1, ASPECT, 3, MAX_BALLOONS);
        for (let i = 0; i < MAX_BALLOONS; i++) {
          if (Math.abs(b.x[i] - prev[i]) < 0.5) continue;
          wraps++;
          // Off-screen by the balloon's whole extent, less at most one step of drift.
          const ext = EXTENT * balloonRadius(b.depth[i]) - 0.01;
          for (const x of [prev[i], b.x[i]]) expect(x < -ext || x > ASPECT + ext).toBe(true);
        }
      }
      expect(wraps).toBeGreaterThan(10);
    }
  });

  it("keep their positions on screen across a resize", () => {
    const b = createBalloons(4, ASPECT);
    stepBalloons(b, DT, ASPECT, 1, MAX_BALLOONS);
    const frac = [...b.x].map((x) => x / ASPECT);
    stepBalloons(b, 0, 4 / 3, 1, MAX_BALLOONS);
    const onScreen = frac.map((f, i) => [f, i]).filter(([f]) => f > 0.1 && f < 0.9);
    expect(onScreen.length).toBeGreaterThan(0);
    for (const [f, i] of onScreen) expect(Math.abs(b.x[i] / (4 / 3) - f)).toBeLessThan(0.1);
  });

  it("stay within their altitude band", () => {
    const b = createBalloons(5, ASPECT);
    // Plain comparisons in the hot loop: an expect per sample costs ~10× the simulation.
    const outside: string[] = [];
    for (let s = 0; s < 30000; s++) {
      stepBalloons(b, DT, ASPECT, 1, 6);
      for (let i = 0; i < MAX_BALLOONS; i++) {
        const lo = altitudeLow(b.depth[i]) - 1e-12;
        const hi = altitudeHigh(b.depth[i]) + 1e-12;
        if (!(b.y[i] >= lo && b.y[i] <= hi) && outside.length < 10) {
          outside.push(`step ${s}, balloon ${i}: y ${b.y[i]} outside [${lo}, ${hi}]`);
        }
      }
    }
    expect(outside).toEqual([]);
  });

  it("actually rise and sink over time", () => {
    const b = createBalloons(6, ASPECT);
    const lo = [...b.y];
    const hi = [...b.y];
    for (let s = 0; s < 18000; s++) {
      stepBalloons(b, DT, ASPECT, 1, 6);
      for (let i = 0; i < MAX_BALLOONS; i++) {
        lo[i] = Math.min(lo[i], b.y[i]);
        hi[i] = Math.max(hi[i], b.y[i]);
      }
    }
    for (let i = 0; i < MAX_BALLOONS; i++) {
      expect(hi[i] - lo[i]).toBeGreaterThan(0.2 * balloonRadius(b.depth[i]));
    }
  });

  it("burner timers stay bounded and every balloon fires", () => {
    const b = createBalloons(9, ASPECT);
    const fired = new Uint8Array(MAX_BALLOONS);
    const unbounded: string[] = [];
    for (let s = 0; s < 6000; s++) {
      stepBalloons(b, DT, ASPECT, 1, 6);
      for (let i = 0; i < MAX_BALLOONS; i++) {
        const timer = b.burnTimer[i];
        const age = b.burnAge[i];
        if (!(timer <= BURN_GAP_MAX && age < BURN_MAX && age >= -1) && unbounded.length < 10) {
          unbounded.push(`step ${s}, balloon ${i}: burnTimer ${timer}, burnAge ${age}`);
        }
        if (age >= 0) fired[i] = 1;
      }
    }
    expect(unbounded).toEqual([]);
    expect([...fired].every((f) => f === 1)).toBe(true);
  });

  it("burner glow rises, holds and falls within the burn", () => {
    expect(burnGlow(-1, 2)).toBe(0);
    expect(burnGlow(0, 2)).toBe(0);
    expect(burnGlow(1, 2)).toBe(1);
    expect(burnGlow(2, 2)).toBe(0);
    for (let t = 0; t <= 2; t += 0.05) {
      expect(burnGlow(t, 2)).toBeGreaterThanOrEqual(0);
      expect(burnGlow(t, 2)).toBeLessThanOrEqual(1);
    }
  });

  it("fade in and out with the count, and stand still at zero drift", () => {
    const b = createBalloons(2, ASPECT);
    stepBalloons(b, 0.1, ASPECT, 0, 4);
    const x = [...b.x];
    for (let s = 0; s < 40; s++) stepBalloons(b, 0.1, ASPECT, 0, 4);
    expect([...b.x]).toEqual(x);
    for (let i = 0; i < MAX_BALLOONS; i++) expect(b.presence[i]).toBe(i < 4 ? 1 : 0);
    const out = new Float32Array(MAX_BALLOONS * BALLOON_FLOATS);
    expect(writeBalloons(b, out, PALETTES.classic, 1080, true)).toBe(4);
    stepBalloons(b, 0.1, ASPECT, 0, 5);
    expect(writeBalloons(b, out, PALETTES.classic, 1080, true)).toBe(5);
  });

  it("writes instances farthest first in px, with no glow when burners are off", () => {
    const b = createBalloons(1, ASPECT);
    for (let s = 0; s < 3000; s++) stepBalloons(b, DT, ASPECT, 1, MAX_BALLOONS);
    const out = new Float32Array(MAX_BALLOONS * BALLOON_FLOATS);
    const n = writeBalloons(b, out, PALETTES.pastel, 2160, false);
    expect(n).toBe(MAX_BALLOONS);
    for (let k = 0; k < n; k++) {
      const o = k * BALLOON_FLOATS;
      expect(out[o + 2]).toBeGreaterThanOrEqual(k > 0 ? out[o + 2 - BALLOON_FLOATS] : 0);
      expect(out[o + 11]).toBe(0);
      expect(out[o + 3]).toBe(1);
      expect([2, 3]).toContain(out[o + 17]);
    }
  });
});
