import { describe, expect, it } from "vitest";
import {
  BASE_SEAT_Y,
  createLayout,
  createSnow,
  FLAKE_DISC,
  FLAKE_R,
  FLAKE_STRIDE,
  GLOBE_R,
  globeLayout,
  globeNudge,
  globeRadius,
  MIN_INTERVAL,
  moundEdge,
  moundY,
  NUDGE,
  NUDGE_TIME,
  sceneKind,
  SCENES,
  shakeSnow,
  SHELF_BACK_Y,
  SHELF_FRONT_Y,
  SIZE_RANGE,
  stepSnow,
  swirlAt,
  writeFlakes,
} from "./globe-sim";
import { globeMeta, MAX_FLAKES, POSITION_OPTIONS, SCENE_OPTIONS } from "./globe.meta";

const ASPECTS = [4 / 3, 16 / 9, 21 / 9];
const POSITIONS = POSITION_OPTIONS.map((o) => o.value);
const SIZES = [SIZE_RANGE[0], 1, SIZE_RANGE[1]];
const DT = 1 / 60;

describe("globeLayout", () => {
  it("keeps the globe in its bottom corner, inside the outer third, at 4:3, 16:9 and 21:9", () => {
    const bad: string[] = [];
    for (const aspect of ASPECTS) {
      for (const pos of POSITIONS) {
        for (const size of SIZES) {
          const l = globeLayout(aspect, pos, size, createLayout());
          const [x0, y0, x1, y1] = l.box;
          const inner = pos === "left" ? x1 : aspect - x0;
          const ok =
            x0 >= 0 &&
            x1 <= aspect &&
            y0 >= 0 &&
            y1 < 0.5 &&
            inner <= aspect / 3 &&
            l.side === (pos === "left" ? -1 : 1) &&
            // The box holds the sphere wherever the nudge moves it.
            l.cx - l.r - NUDGE >= x0 &&
            l.cx + l.r + NUDGE <= x1 &&
            l.cy + l.r + NUDGE <= y1;
          if (!ok) bad.push(`${aspect} ${pos} ${size}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("sits the base on the shelf and scales with size", () => {
    const small = globeLayout(16 / 9, "right", SIZE_RANGE[0], createLayout());
    const big = globeLayout(16 / 9, "right", SIZE_RANGE[1], createLayout());
    expect(big.r).toBeGreaterThan(small.r);
    expect(BASE_SEAT_Y).toBeGreaterThan(SHELF_FRONT_Y);
    expect(BASE_SEAT_Y).toBeLessThan(SHELF_BACK_Y);
    expect(globeRadius(1)).toBe(GLOBE_R);
    expect(globeRadius(99)).toBe(GLOBE_R * SIZE_RANGE[1]);
    expect(globeRadius(Number.NaN)).toBe(GLOBE_R);
  });

  it("mirrors left and right", () => {
    const aspect = 16 / 9;
    const l = globeLayout(aspect, "left", 1, createLayout());
    const r = globeLayout(aspect, "right", 1, createLayout());
    expect(l.cx).toBeCloseTo(aspect - r.cx, 12);
    expect(l.box[0]).toBeCloseTo(aspect - r.box[2], 12);
    expect(l.box[2]).toBeCloseTo(aspect - r.box[0], 12);
  });
});

describe("snow", () => {
  it("starts settled on the mound, deterministic per seed", () => {
    const a = createSnow(3, 200);
    const b = createSnow(3, 200);
    const c = createSnow(4, 200);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.x)).not.toEqual(Array.from(c.x));
    let bad = 0;
    for (let i = 0; i < a.count; i++) {
      if (!a.settled[i] || Math.abs(a.y[i] - moundY(a.x[i])) > 1e-12) bad++;
      if (Math.hypot(a.x[i], a.y[i]) > FLAKE_DISC + 1e-9) bad++;
      if (a.radius[i] < FLAKE_R[0] || a.radius[i] > FLAKE_R[1]) bad++;
    }
    expect(bad).toBe(0);
    const e = moundEdge();
    expect(e * e + moundY(e) ** 2).toBeCloseTo(FLAKE_DISC * FLAKE_DISC, 9);
  });

  it("never lets a flake leave the globe or sink into the mound", () => {
    const s = createSnow(1, 300);
    shakeSnow(s);
    let worst = 0;
    let below = 0;
    // 90 s with a shake every 10 s and an uneven frame rate.
    for (let k = 0; k < 90 * 60; k++) {
      stepSnow(s, k % 7 === 0 ? 0.1 : DT, 10);
      for (let i = 0; i < s.count; i++) {
        worst = Math.max(worst, Math.hypot(s.x[i], s.y[i]));
        if (s.y[i] < moundY(s.x[i]) - 1e-9) below++;
      }
    }
    expect(worst).toBeLessThanOrEqual(FLAKE_DISC + 1e-9);
    expect(below).toBe(0);
  });

  it("settles every flake within a bounded time after a shake, but not at once", () => {
    const times: number[] = [];
    const early: number[] = [];
    for (const seed of [1, 2, 3, 4]) {
      const s = createSnow(seed, MAX_FLAKES);
      shakeSnow(s);
      let t = 0;
      let all = false;
      while (!all && t < 60) {
        stepSnow(s, DT, 0);
        t += DT;
        if (Math.abs(t - 5) < DT / 2) early.push(s.settled.reduce((a, v) => a + v, 0) / s.count);
        all = s.settled.every((v) => v === 1);
      }
      times.push(all ? t : Infinity);
    }
    // Most still in the water after 5 s; all down within 40 s.
    expect(Math.max(...early)).toBeLessThan(0.5);
    expect(Math.max(...times)).toBeLessThan(40);
    expect(Math.min(...times)).toBeGreaterThan(8);
  });

  it("leaves settled flakes alone until the next shake", () => {
    const s = createSnow(5, 100);
    const x0 = Array.from(s.x);
    for (let k = 0; k < 600; k++) stepSnow(s, DT, 0);
    expect(Array.from(s.x)).toEqual(x0);
    shakeSnow(s);
    stepSnow(s, DT, 0);
    expect(s.settled.every((v) => v === 0)).toBe(true);
  });

  it("shakes every interval, never at 0, and no more often than MIN_INTERVAL", () => {
    const count = (interval: number, seconds: number) => {
      const s = createSnow(1, 10);
      shakeSnow(s, false);
      let n = 0;
      for (let k = 0; k < seconds * 60; k++) if (stepSnow(s, DT, interval)) n++;
      return n;
    };
    expect(count(0, 120)).toBe(0);
    expect(count(Number.NaN, 30)).toBe(0);
    expect(count(30, 125)).toBe(4);
    expect(count(1, 61)).toBe(Math.floor(61 / MIN_INTERVAL));
  });

  it("decays the swirl", () => {
    expect(swirlAt(0, 1)).toBeGreaterThan(0);
    expect(swirlAt(0, -1)).toBeLessThan(0);
    expect(Math.abs(swirlAt(20, 1))).toBeLessThan(0.01);
    expect(swirlAt(Infinity, 1)).toBe(0);
  });
});

describe("globeNudge", () => {
  it("jiggles a few pixels after a shake, then rests at exactly 0", () => {
    const s = createSnow(1, 1);
    const out = [1, 1];
    globeNudge(s, out);
    expect(out).toEqual([0, 0]);
    shakeSnow(s);
    let peak = 0;
    for (let k = 0; k < 120; k++) {
      stepSnow(s, DT, 0);
      globeNudge(s, out);
      peak = Math.max(peak, Math.abs(out[0]), Math.abs(out[1]));
    }
    expect(peak).toBeGreaterThan(NUDGE * 0.3);
    expect(peak).toBeLessThanOrEqual(NUDGE);
    expect(s.nudgeAge).toBeGreaterThan(NUDGE_TIME);
    expect(out).toEqual([0, 0]);
    // A shake without a nudge leaves the globe still.
    shakeSnow(s, false);
    stepSnow(s, DT, 0);
    globeNudge(s, out);
    expect(out).toEqual([0, 0]);
  });
});

describe("writeFlakes", () => {
  it("writes sprites in height units, inside the globe, limited by count and buffer", () => {
    const s = createSnow(2, 50);
    const l = globeLayout(16 / 9, "left", 1, createLayout());
    const out = new Float32Array(40 * FLAKE_STRIDE);
    expect(writeFlakes(s, l, [0, 0], 1000, out)).toBe(40);
    expect(writeFlakes(s, l, [0, 0], 10, out)).toBe(10);
    expect(writeFlakes(s, l, [0, 0], Number.NaN, out)).toBe(0);
    const n = writeFlakes(s, l, [0.01, 0], 40, out);
    let bad = 0;
    for (let i = 0; i < n; i++) {
      const o = i * FLAKE_STRIDE;
      const d = Math.hypot(out[o] - l.cx - 0.01, out[o + 1] - l.cy);
      if (d + out[o + 2] > l.r) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe("scenes", () => {
  it("has a shader branch for every option and falls back to the cabin", () => {
    expect(SCENE_OPTIONS.map((o) => sceneKind(o.value))).toEqual([0, 1, 2]);
    expect(Object.keys(SCENES)).toEqual(SCENE_OPTIONS.map((o) => o.value));
    expect(sceneKind("nope")).toBe(0);
    expect(sceneKind("toString")).toBe(0);
  });

  it("keeps the params in range", () => {
    const p = globeMeta.params;
    expect(p.flakes.max).toBe(MAX_FLAKES);
    expect(p.size.min).toBe(SIZE_RANGE[0]);
    expect(p.size.max).toBe(SIZE_RANGE[1]);
  });
});
