import { describe, expect, it } from "vitest";
import {
  AIRSTONE_MODE,
  AIRSTONE_X,
  airstoneY,
  BACK_PLANTS,
  buildHardscape,
  buildPlants,
  createFishSim,
  DART_MAX,
  type FishEnv,
  fishInstances,
  FISH_FLOATS,
  FORCE_MAX,
  FRONT_PLANTS,
  GRAVEL_GLSL,
  gravelTop,
  LIGHTS,
  MAX_PLANTS,
  MAX_ROCKS,
  PLANT_FLOATS,
  PLANT_STRIP,
  PLANT_SEGMENTS,
  plantWeight,
  schoolCount,
  SPECIES_NEON,
  SPECIES_SILVER,
  speciesOf,
  SPEED_MIN,
  stepFishSim,
  TANK_BOTTOM,
  TANK_TOP,
  TANK_X,
  TURN_TIME,
  turnScale,
} from "./aquarium-sim";
import { BUBBLE_FLOATS, createBubbles } from "../bubbles/bubbles-sim";
import { MAX_FISH } from "./aquarium.meta";

const env = (over: Partial<FishEnv> = {}): FishEnv => ({
  aspect: 16 / 9,
  count: 30,
  species: "mixed",
  speed: 1,
  ...over,
});

describe("gravelTop", () => {
  it("rises towards the sides and stays in the lower fifth or so", () => {
    let bad = 0;
    for (let k = 0; k <= 100; k++) {
      const g = gravelTop(k / 100);
      if (!(g > 0.74 && g < 0.82)) {
        bad++;
      }
    }
    expect(bad).toBe(0);
    expect(gravelTop(0)).toBeLessThan(gravelTop(0.5));
    expect(gravelTop(1)).toBeLessThan(gravelTop(0.5));
    expect(GRAVEL_GLSL).toContain("float gravelTop(float u)");
  });
});

describe("hardscape", () => {
  it("is deterministic per seed and keeps clear of the centre third", () => {
    const a = buildHardscape(5);
    expect(Array.from(buildHardscape(5).rocks)).toEqual(Array.from(a.rocks));
    expect(Array.from(buildHardscape(6).rocks)).not.toEqual(Array.from(a.rocks));
    let bad = 0;
    for (let s = 0; s < 50; s++) {
      const h = buildHardscape(s);
      for (let i = 0; i < MAX_ROCKS; i++) {
        const u = h.rocks[i * 4];
        if (u > 0.3 && u < 0.7) {
          bad++;
        }
        if (!(h.rocks[i * 4 + 3] > 0 && h.rocks[i * 4 + 3] <= h.rocks[i * 4 + 2])) {
          bad++;
        }
      }
      for (let i = 0; i < 2; i++) {
        if (h.wood[i * 4 + 3] >= h.wood[i * 4 + 1]) {
          bad++;
        }
        const top = h.wood[i * 4 + 2];
        if (top > 0.33 && top < 0.67) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });
});

describe("plants", () => {
  it("builds a strip of PLANT_SEGMENTS + 1 vertex pairs", () => {
    expect(PLANT_STRIP.length).toBe((PLANT_SEGMENTS + 1) * 4);
  });

  it("weights the sides far above the centre", () => {
    expect(plantWeight(0.5)).toBeLessThan(0.1);
    expect(plantWeight(0.05)).toBe(1);
    expect(plantWeight(0.95)).toBe(1);
  });

  it("scales with density, keeps a prefix and stays mostly at the sides", () => {
    const full = new Float32Array(MAX_PLANTS * PLANT_FLOATS);
    const half = new Float32Array(MAX_PLANTS * PLANT_FLOATS);
    const a = buildPlants(3, 1, full);
    const b = buildPlants(3, 0.5, half);
    expect(a.backCount).toBe(BACK_PLANTS);
    expect(a.frontCount).toBe(FRONT_PLANTS);
    expect(buildPlants(3, 0, half)).toEqual({ backCount: 0, frontCount: 0 });
    buildPlants(3, 0.5, half);
    expect(Array.from(half.subarray(0, b.backCount * PLANT_FLOATS))).toEqual(
      Array.from(full.subarray(0, b.backCount * PLANT_FLOATS)),
    );
    let centre = 0;
    let bad = 0;
    for (let i = 0; i < a.backCount + a.frontCount; i++) {
      const o = i * PLANT_FLOATS;
      const u = full[o];
      if (u > 0.36 && u < 0.64) {
        centre++;
      }
      if (!(u >= 0 && u <= 1 && full[o + 2] > 0 && full[o + 3] > 0 && full[o + 5] > 0)) {
        bad++;
      }
      const kind = Math.floor(full[o + 7]);
      if (kind !== 0 && kind !== 1) {
        bad++;
      }
      if (i >= a.backCount && u > 0.1 && u < 0.9) {
        bad++;
      }
    }
    expect(bad).toBe(0);
    expect(centre).toBeLessThanOrEqual(3);
  });
});

describe("light presets", () => {
  it("are finite colours", () => {
    let bad = 0;
    for (const l of Object.values(LIGHTS)) {
      for (const c of [l.top, l.deep, l.wall, l.gravelA, l.gravelB, l.rock, l.light]) {
        if (c.some((v) => !(v >= 0 && v <= 1))) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });
});

describe("air-stone bubbles", () => {
  it("rise in a column from the stone", () => {
    const sim = createBubbles(64, 1920, 9);
    const data = new Float32Array(64 * BUBBLE_FLOATS);
    const f = {
      refWidth: 1920,
      scale: 1,
      mode: AIRSTONE_MODE,
      count: 46,
      size: 4,
      speed: 1,
      streams: true,
    };
    const x0 = AIRSTONE_X * 1920;
    let bad = 0;
    let drawn = 0;
    for (let i = 0; i < 20 * 30; i++) {
      const n = sim.step(1 / 20, f, data, BUBBLE_FLOATS);
      for (let k = 0; k < n; k++) {
        const o = k * BUBBLE_FLOATS;
        if (Math.abs(data[o] - x0) > 40 || data[o + 1] > airstoneY() * 1080) {
          bad++;
        }
      }
      drawn += n;
    }
    expect(bad).toBe(0);
    expect(drawn / 600).toBeGreaterThan(20);
  });
});

describe("species", () => {
  it("follows the param, splitting mixed schools", () => {
    expect(speciesOf("neon", 3, 1, 2)).toBe(SPECIES_NEON);
    expect(speciesOf("silver", 3, 1, 2)).toBe(SPECIES_SILVER);
    expect(speciesOf("mixed", 3, 0, 2)).toBe(SPECIES_NEON);
    expect(speciesOf("mixed", 3, 1, 2)).toBe(SPECIES_SILVER);
    expect(speciesOf("mixed", 3, 0, 1)).toBe(SPECIES_SILVER);
    expect(schoolCount(5)).toBe(1);
    expect(schoolCount(40)).toBe(3);
  });
});

describe("fish", () => {
  // 5400 steps of the full school with plain checks: the cost is the simulation itself.
  it(
    "keeps forces bounded, speeds capped and every fish inside the tank",
    { timeout: 20_000 },
    () => {
      const issues: string[] = [];
      for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
        const sim = createFishSim(7, MAX_FISH, aspect);
        const e = env({ aspect, count: MAX_FISH, speed: 2 });
        let maxF = 0;
        for (let step = 0; step < 30 * 60; step++) {
          stepFishSim(sim, 1 / 30, e);
          for (let i = 0; i < sim.live; i++) {
            maxF = Math.max(maxF, Math.hypot(sim.fx[i], sim.fy[i]));
            const sp = Math.hypot(sim.vx[i], sim.vy[i]);
            if (sp > DART_MAX + 1e-6 || sp < SPEED_MIN - 1e-6) {
              issues.push(`speed ${String(sp)}`);
            }
            const x = sim.x[i];
            const y = sim.y[i];
            if (x < TANK_X - 1e-6 || x > aspect - TANK_X + 1e-6) {
              issues.push(`x ${String(x)}`);
            }
            if (y < TANK_TOP - 1e-6 || y > TANK_BOTTOM + 1e-6) {
              issues.push(`y ${String(y)}`);
            }
            if (!(sim.z[i] >= 0 && sim.z[i] <= 1)) {
              issues.push(`z ${String(sim.z[i])}`);
            }
          }
          if (issues.length > 5) {
            break;
          }
        }
        expect(maxF).toBeLessThanOrEqual(FORCE_MAX + 1e-6);
      }
      expect(issues).toEqual([]);
    },
  );

  it("clamps fish back inside after the frame narrows", () => {
    const sim = createFishSim(1, 20, 21 / 9);
    stepFishSim(sim, 1 / 30, env({ aspect: 21 / 9, count: 20 }));
    stepFishSim(sim, 1 / 30, env({ aspect: 1, count: 20 }));
    let out = 0;
    for (let i = 0; i < sim.live; i++) {
      if (sim.x[i] > 1 - TANK_X + 1e-6) {
        out++;
      }
    }
    expect(out).toBe(0);
  });

  it("spend little time in the centre band but still cross it", () => {
    const sim = createFishSim(3, MAX_FISH);
    const e = env({ count: 24 });
    let centre = 0;
    let samples = 0;
    let crossings = 0;
    const side = new Int8Array(MAX_FISH);
    for (let step = 0; step < 30 * 180; step++) {
      stepFishSim(sim, 1 / 30, e);
      for (let i = 0; i < sim.live; i++) {
        const u = sim.x[i] / e.aspect;
        if (u > 0.4 && u < 0.6) {
          centre++;
        }
        samples++;
        const sd = u < 0.5 ? -1 : 1;
        if (side[i] !== 0 && side[i] !== sd) {
          crossings++;
        }
        side[i] = sd;
      }
    }
    // The band is a fifth of the width; fish spend clearly less time there than that.
    expect(centre / samples).toBeLessThan(0.15);
    // But they still cross from time to time.
    expect(crossings).toBeGreaterThan(10);
  });

  it("turns continuously: the width factor moves at most pi / TURN_TIME per second", () => {
    const sim = createFishSim(11, MAX_FISH);
    const e = env({ count: MAX_FISH });
    const prev = new Float64Array(MAX_FISH);
    for (let i = 0; i < MAX_FISH; i++) {
      prev[i] = turnScale(sim.turn[i]);
    }
    const dt = 1 / 60;
    // |d cos(theta)| <= |d theta| = pi / TURN_TIME * dt.
    const limit = (Math.PI / TURN_TIME) * dt + 1e-6;
    let worst = 0;
    let flips = 0;
    let partial = 0;
    for (let step = 0; step < 60 * 90; step++) {
      stepFishSim(sim, dt, e);
      for (let i = 0; i < sim.live; i++) {
        const s = turnScale(sim.turn[i]);
        worst = Math.max(worst, Math.abs(s - prev[i]));
        if (Math.sign(s) !== Math.sign(prev[i]) && prev[i] !== 0) {
          flips++;
        }
        if (Math.abs(s) < 0.5) {
          partial++;
        }
        prev[i] = s;
      }
    }
    expect(worst).toBeLessThanOrEqual(limit);
    expect(flips).toBeGreaterThan(5);
    // A turn passes through edge-on but never lingers there.
    expect(partial / (60 * 90 * MAX_FISH)).toBeLessThan(0.05);
  });

  it("takes about TURN_TIME to reverse", () => {
    const sim = createFishSim(2, 5);
    const e = env({ count: 5 });
    stepFishSim(sim, 1 / 60, e);
    sim.turn[0] = 0;
    sim.facing[0] = -1;
    sim.vx[0] = -0.08;
    let t = 0;
    while (sim.turn[0] < Math.PI && t < 2) {
      stepFishSim(sim, 1 / 120, e);
      // Keep it swimming left so it doesn't turn back.
      sim.vx[0] = -0.08;
      t += 1 / 120;
    }
    expect(t).toBeGreaterThan(TURN_TIME * 0.9);
    expect(t).toBeLessThan(TURN_TIME * 1.1 + 1 / 60);
  });

  it("fades fish in and out with the count, and freezes at speed 0", () => {
    const sim = createFishSim(4, MAX_FISH);
    const out = new Float32Array(MAX_FISH * FISH_FLOATS);
    stepFishSim(sim, 1 / 30, env({ count: 10 }));
    expect(sim.live).toBe(10);
    stepFishSim(sim, 1 / 30, env({ count: 20 }));
    expect(sim.life[15]).toBeLessThan(0.1);
    for (let i = 0; i < 90; i++) {
      stepFishSim(sim, 1 / 30, env({ count: 20 }));
    }
    expect(sim.life[15]).toBe(1);
    stepFishSim(sim, 1 / 30, env({ count: 5 }));
    expect(sim.live).toBe(20);
    for (let i = 0; i < 60; i++) {
      stepFishSim(sim, 1 / 30, env({ count: 5 }));
    }
    expect(sim.live).toBe(5);

    const x = Array.from(sim.x.subarray(0, 5));
    for (let i = 0; i < 30; i++) {
      stepFishSim(sim, 1 / 30, env({ count: 5, speed: 0 }));
    }
    expect(Array.from(sim.x.subarray(0, 5))).toEqual(x);
    expect(fishInstances(sim, env({ count: 5 }), out)).toBe(5);
  });

  it("writes finite instances sorted far to near, far ones first", () => {
    const sim = createFishSim(8, MAX_FISH);
    const e = env({ count: 33 });
    const out = new Float32Array(MAX_FISH * FISH_FLOATS);
    let bad = 0;
    for (let step = 0; step < 300; step++) {
      stepFishSim(sim, 1 / 30, e);
      const n = fishInstances(sim, e, out);
      if (n !== 33) {
        bad++;
      }
      let lastZ = -1;
      for (let k = 0; k < n; k++) {
        const o = k * FISH_FLOATS;
        for (let j = 0; j < FISH_FLOATS; j++) {
          if (!Number.isFinite(out[o + j])) {
            bad++;
          }
        }
        // Fog falls as depth rises.
        const fog = out[o + 5];
        if (lastZ >= 0 && fog > lastZ + 1e-6) {
          bad++;
        }
        lastZ = fog;
        if (k < sim.farCount !== fog > 0.6 * 0.25 - 1e-6) {
          bad++;
        }
        if (!(out[o + 2] > 0 && Math.abs(out[o + 3]) <= 1 && out[o + 7] > 0 && out[o + 7] <= 1)) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("is deterministic per seed", () => {
    const a = createFishSim(5, 30);
    const b = createFishSim(5, 30);
    for (let i = 0; i < 200; i++) {
      stepFishSim(a, 1 / 30, env());
      stepFishSim(b, 1 / 30, env());
    }
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
  });
});
