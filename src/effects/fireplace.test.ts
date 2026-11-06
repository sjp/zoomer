import { describe, expect, it } from "vitest";
import {
  buildHearthProfile,
  buildRamp,
  createEmberState,
  fireNoiseChannels,
  type EmberEnv,
  emberAlpha,
  fireLayout,
  FLOOR_H,
  getPalette,
  HEARTH_PROFILE_COLUMNS,
  hearthMaxHeight,
  NOISE_SIZE,
  PALETTES,
  RAMP_SIZE,
  stepEmbers,
} from "./fireplace-model";
import { buildPeriodicNoiseTexture, createRng } from "./noise";

describe("buildRamp", () => {
  it("is transparent at zero heat and opaque near-white at full heat", () => {
    const ramp = buildRamp(PALETTES.wood.ramp);
    expect(ramp.length).toBe(RAMP_SIZE * 4);
    expect([...ramp.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    const last = ramp.subarray((RAMP_SIZE - 1) * 4);
    expect(last[3]).toBe(255);
    expect(last[0]).toBe(255);
    expect(last[1]).toBeGreaterThan(240);
  });

  it("premultiplies colour by alpha", () => {
    const ramp = buildRamp(
      [
        { at: 0, rgb: [1, 1, 1], a: 0 },
        { at: 1, rgb: [1, 1, 1], a: 1 },
      ],
      5,
    );
    expect([...ramp.subarray(8, 12)]).toEqual([128, 128, 128, 128]);
    for (let i = 0; i < 5; i++) expect(ramp[i * 4]).toBe(ramp[i * 4 + 3]);
  });

  it("interpolates linearly between stops and hits each stop", () => {
    const ramp = buildRamp(
      [
        { at: 0, rgb: [0, 0, 0], a: 1 },
        { at: 0.5, rgb: [1, 0, 0], a: 1 },
        { at: 1, rgb: [1, 1, 0], a: 1 },
      ],
      5,
    );
    expect([...ramp.subarray(0, 12)]).toEqual([0, 0, 0, 255, 128, 0, 0, 255, 255, 0, 0, 255]);
    expect([...ramp.subarray(12, 20)]).toEqual([255, 128, 0, 255, 255, 255, 0, 255]);
  });

  it("alpha never decreases with heat for every palette", () => {
    for (const id of ["wood", "gas", "magic"]) {
      const ramp = buildRamp(getPalette(id).ramp);
      for (let i = 1; i < RAMP_SIZE; i++)
        expect(ramp[i * 4 + 3]).toBeGreaterThanOrEqual(ramp[i * 4 - 1]);
    }
  });

  it("falls back to wood for unknown palettes", () => {
    expect(getPalette("nope")).toBe(PALETTES.wood);
    expect(getPalette("gas")).toBe(PALETTES.gas);
  });
});

describe("fire noise texture", () => {
  it("tiles seamlessly in x and y, in both channels", () => {
    const size = NOISE_SIZE;
    const tex = buildPeriodicNoiseTexture(size, fireNoiseChannels());
    expect(tex.length).toBe(size * size * 2);
    const at = (x: number, y: number, c: number) => tex[(y * size + x) * 2 + c];
    /** Mean |difference| between the texel pairs `pick` names, over one edge. */
    const meanStep = (c: number, pick: (i: number) => [number, number, number, number]) => {
      let sum = 0;
      for (let i = 0; i < size; i++) {
        const [x0, y0, x1, y1] = pick(i);
        sum += Math.abs(at(x0, y0, c) - at(x1, y1, c));
      }
      return sum / size;
    };
    for (let c = 0; c < 2; c++) {
      // Steps across the seam are no larger than steps just inside it.
      const seamX = meanStep(c, (y) => [size - 1, y, 0, y]);
      const innerX = meanStep(c, (y) => [size - 2, y, size - 1, y]);
      const seamY = meanStep(c, (x) => [x, size - 1, x, 0]);
      const innerY = meanStep(c, (x) => [x, size - 2, x, size - 1]);
      expect(seamX).toBeLessThan(innerX * 1.6 + 2);
      expect(seamY).toBeLessThan(innerY * 1.6 + 2);
    }
  });

  it("uses the value range", () => {
    const tex = buildPeriodicNoiseTexture(NOISE_SIZE, fireNoiseChannels());
    let lo = 255;
    let hi = 0;
    for (const v of tex) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(hi - lo).toBeGreaterThan(120);
  });
});

describe("fireLayout", () => {
  it("centres the fire and scales its base with the width, within limits", () => {
    const l = fireLayout(1600, 0.4);
    expect(l.cx).toBe(800);
    expect(l.halfW).toBeCloseTo(1600 * 0.36, 9);
    expect(l.flameH).toBeCloseTo(432, 9);
    expect(l.floorH).toBe(FLOOR_H);
    expect(l.baseY).toBeCloseTo(FLOOR_H + l.halfW * 0.07, 9);
  });

  it("clamps the base half-width to 60..680 and the flame to at least 40px", () => {
    expect(fireLayout(100, 0.4).halfW).toBe(60);
    expect(fireLayout(0, 0.4).halfW).toBe(60);
    expect(fireLayout(10_000, 0.4).halfW).toBe(680);
    expect(fireLayout(1920, 0).flameH).toBe(40);
    expect(fireLayout(1920, -1).flameH).toBe(40);
    expect(fireLayout(1920, 0.02).flameH).toBe(40);
  });
});

describe("hearth profile", () => {
  const layout = fireLayout(1920, 0.4);

  it("is the floor away from the fire and rises to the logs under it", () => {
    const out = buildHearthProfile(new Float32Array(512), 1920, layout);
    expect(out[0]).toBe(FLOOR_H);
    expect(out[511]).toBe(FLOOR_H);
    const mid = out[256];
    expect(mid).toBeGreaterThan(FLOOR_H + 20);
    const max = Math.max(...out);
    expect(max).toBeLessThanOrEqual(hearthMaxHeight(layout) + 1e-3);
    expect(max).toBeGreaterThan(hearthMaxHeight(layout) - 10);
  });

  it("stays below the flame base so flames show above the logs", () => {
    expect(hearthMaxHeight(layout)).toBeLessThan(layout.baseY + layout.flameH * 0.4);
  });

  it("has enough columns that the interpolated silhouette stays close at 4K", () => {
    // 4K at 16:9 is 1920 reference px across 3840 device px.
    expect(3840 / HEARTH_PROFILE_COLUMNS).toBeLessThanOrEqual(4);
    // Sample the profile the way the shader does (linear, texel centres) and compare
    // with a dense build. Error is unavoidable only next to the log ends' vertical
    // steps, so the total width where it exceeds half a reference px stays small.
    const n = HEARTH_PROFILE_COLUMNS;
    const p = buildHearthProfile(new Float32Array(n), 1920, layout);
    const dense = buildHearthProfile(new Float32Array(16384), 1920, layout);
    let off = 0;
    for (let i = 0; i < dense.length; i++) {
      const c = Math.min(n - 1, Math.max(0, ((i + 0.5) / dense.length) * n - 0.5));
      const i0 = Math.floor(c);
      const i1 = Math.min(n - 1, i0 + 1);
      const v = p[i0] + (p[i1] - p[i0]) * (c - i0);
      if (Math.abs(v - dense[i]) > 0.5) off++;
    }
    expect((off / dense.length) * 1920).toBeLessThan(12);
  });
});

describe("stepEmbers", () => {
  const layout = fireLayout(1920, 0.4);
  const env = (rate: number): EmberEnv => ({ rate, layout, rise: 150, time: 0, top: 1100 });
  const noCurl = () => 0;

  it("spawns nothing at rate 0", () => {
    const s = createEmberState(50);
    for (let i = 0; i < 100; i++) stepEmbers(s, 1 / 60, env(0), createRng(1), noCurl);
    expect(s.count).toBe(0);
  });

  it("spawns at the requested rate and never exceeds the maximum", () => {
    const s = createEmberState(500);
    const rng = createRng(2);
    for (let i = 0; i < 60; i++) stepEmbers(s, 1 / 60, env(20), rng, noCurl);
    expect(s.count).toBeGreaterThanOrEqual(19);
    expect(s.count).toBeLessThanOrEqual(20);
    const small = createEmberState(5);
    for (let i = 0; i < 60; i++) stepEmbers(small, 1 / 60, env(100), rng, noCurl);
    expect(small.count).toBe(5);
  });

  it("embers rise, drift with the curl field and die", () => {
    const s = createEmberState(10);
    const rng = createRng(3);
    stepEmbers(s, 0.05, env(20), rng, () => 1);
    expect(s.count).toBe(1);
    const y0 = s.y[0];
    const x0 = s.x[0];
    const e = env(0);
    for (let i = 0; i < 30; i++) stepEmbers(s, 1 / 60, e, rng, () => 1);
    expect(s.y[0]).toBeGreaterThan(y0 + 20);
    expect(s.x[0]).toBeGreaterThan(x0);
    for (let i = 0; i < 400; i++) stepEmbers(s, 1 / 60, e, rng, () => 1);
    expect(s.count).toBe(0);
  });

  it("does nothing for a zero or negative step", () => {
    const s = createEmberState(20);
    const rng = createRng(5);
    for (let i = 0; i < 30; i++) stepEmbers(s, 1 / 60, env(30), rng, noCurl);
    const snapshot = JSON.stringify(s);
    for (const dt of [0, -1, -1e-9]) stepEmbers(s, dt, env(1000), rng, () => 1);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it("removes embers that rise past the top of the frame", () => {
    const s = createEmberState(10);
    const rng = createRng(6);
    stepEmbers(s, 0.1, env(10), rng, noCurl);
    expect(s.count).toBe(1);
    // Long-lived and below the top...
    s.life[0] = 100;
    s.y[0] = 1099;
    stepEmbers(s, 1e-3, env(0), rng, noCurl);
    expect(s.count).toBe(1);
    // ...until it rises past it.
    s.y[0] = 1100.5;
    stepEmbers(s, 1e-3, env(0), rng, noCurl);
    expect(s.count).toBe(0);
  });

  it("caps the spawn debt, so a long hitch can't queue a burst", () => {
    const s = createEmberState(8);
    const rng = createRng(7);
    // A 100s step at 50/s owes 5000 embers; at most `max` are ever owed.
    stepEmbers(s, 100, env(50), rng, noCurl);
    expect(s.spawnDebt).toBeLessThan(1);
    expect(s.count).toBeLessThanOrEqual(8);
    // Once they have died, a normal step spawns at the normal rate.
    for (let i = 0; i < 400; i++) stepEmbers(s, 1 / 60, env(0), rng, noCurl);
    expect(s.count).toBe(0);
    stepEmbers(s, 1 / 60, env(50), rng, noCurl);
    expect(s.count).toBeLessThanOrEqual(1);
    expect(s.spawnDebt).toBeLessThan(1);
  });

  it("keeps live embers packed after removals", () => {
    const s = createEmberState(100);
    const rng = createRng(4);
    // Plain comparisons in the hot loop: an expect per ember costs far more than the check.
    const stale: string[] = [];
    for (let i = 0; i < 600; i++) {
      stepEmbers(s, 1 / 60, env(30), rng, noCurl);
      for (let k = 0; k < s.count; k++) {
        if (!(s.age[k] < s.life[k]) && stale.length < 10) {
          stale.push(
            `step ${String(i)}, ember ${String(k)}: age ${String(s.age[k])}, life ${String(s.life[k])}`,
          );
        }
      }
    }
    expect(stale).toEqual([]);
    expect(s.count).toBeGreaterThan(0);
  });
});

describe("emberAlpha", () => {
  it("fades in and out", () => {
    expect(emberAlpha(0, 2, 0, 0)).toBe(0);
    expect(emberAlpha(2, 2, 0, 0)).toBe(0);
    expect(emberAlpha(0.3, 2, 0, 0)).toBeGreaterThan(0.4);
    expect(emberAlpha(1.8, 2, 0, 0)).toBeLessThan(0.02);
  });

  it("stays within [0, 1] for any age, seed and time", () => {
    const rng = createRng(8);
    let hi = 0;
    const negative: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const life = 0.1 + rng() * 5;
      const a = emberAlpha(rng() * 1.2 * life, life, rng() * 7, rng() * 1000);
      if (!(a >= 0) && negative.length < 10) negative.push(`sample ${String(i)}: ${String(a)}`);
      hi = Math.max(hi, a);
    }
    expect(negative).toEqual([]);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi).toBeGreaterThan(0.5);
    expect(emberAlpha(1, 0, 0, 0)).toBe(0);
    expect(emberAlpha(1, -1, 0, 0)).toBe(0);
  });
});
