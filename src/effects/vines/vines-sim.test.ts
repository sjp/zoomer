import { describe, expect, it } from "vitest";
import {
  allowed,
  angleDiff,
  bandHeight,
  bandWidth,
  createVines,
  intrusion,
  KAPPA_MAX,
  KIND_TENDRIL,
  leafGrow,
  MAX_FALLING,
  MAX_SPRITES,
  MAX_STEP,
  OFF_FRAME,
  offFrame,
  PLANT_FLOWERS,
  PLANT_LEAVES,
  PLANT_SEGS,
  PLANTS,
  RACEME,
  SEG_FLOATS,
  SEG_LEN,
  SPRITE_FLOATS,
  type VineFrame,
  VINE_SHAPES,
  vineOutline,
  type Vines,
  witherCurve,
} from "./vines-sim";
import { MAX_PLANTS } from "./vines.meta";

const frame = (over: Partial<VineFrame> = {}): VineFrame => ({
  refWidth: 1920,
  type: PLANTS.ivy,
  growth: 1,
  density: 5,
  border: 0.6,
  flowers: 0.5,
  ...over,
});

const STRIDE = SPRITE_FLOATS + 2;
const sprites = new Float32Array(MAX_SPRITES * STRIDE);

/** Every drawn segment of every plant in use, as [plant, slot]. */
function* segments(v: Vines) {
  for (let p = 0; p < MAX_PLANTS; p++) {
    if (!v.active[p]) {
      continue;
    }
    for (let k = 0; k < v.segUsed[p]; k++) {
      yield [p, p * PLANT_SEGS + k] as const;
    }
  }
}

/** Runs `seconds` of real time at 10 fps, calling `check` every `every` steps. */
function run(v: Vines, f: VineFrame, seconds: number, every: number, check: () => void) {
  v.resize(f.refWidth);
  const steps = Math.round(seconds * 10);
  for (let s = 0; s < steps; s++) {
    v.step(0.1, f);
    if (s % every === 0) {
      check();
    }
  }
}

describe("region", () => {
  it("keeps the centre third clear below the top band, for every border", () => {
    const open: string[] = [];
    for (const border of [0, 0.3, 0.6, 1]) {
      expect(bandWidth(1920, border)).toBeLessThanOrEqual(1920 / 3);
      for (let x = 640; x <= 1280; x += 40) {
        for (let y = bandHeight(border) + 1; y <= 1080; y += 40) {
          if (allowed(x, y, 1920, border) && open.length < 10) {
            open.push(`border ${String(border)}: ${String(x)},${String(y)}`);
          }
        }
      }
    }
    expect(open).toEqual([]);
  });

  it("allows the edges, the corners and the top band", () => {
    expect(allowed(5, 540, 1920, 0.5)).toBe(true);
    expect(allowed(1915, 540, 1920, 0.5)).toBe(true);
    expect(allowed(960, 5, 1920, 0.5)).toBe(true);
    expect(allowed(-30, 1100, 1920, 0.5)).toBe(true);
    expect(allowed(-60, 540, 1920, 0.5)).toBe(false);
    expect(intrusion(960, 540, 1920, 1)).toBeGreaterThan(0);
    expect(offFrame(960, 540, 1920)).toBeLessThan(0);
  });
});

describe("growth", () => {
  for (const [name, type, border, refWidth] of [
    ["ivy", PLANTS.ivy, 0.6, 1920],
    ["morning glory, narrow border", PLANTS.morningGlory, 0.1, 1920],
    ["wisteria, wide border, ultrawide", PLANTS.wisteria, 1, 2560],
  ] as const) {
    it(`stays in the border region with bounded curvature (${name})`, () => {
      const v = createVines(7);
      const f = frame({ type, border, refWidth, growth: 2, density: 8 });
      let worst = -Infinity;
      let worstOff = -Infinity;
      let worstTurn = 0;
      let worstTendril = 0;
      let segs = 0;
      run(v, f, 900, 50, () => {
        for (const [p, slot] of segments(v)) {
          const o = slot * SEG_FLOATS;
          const d = v.segData;
          const xOff = v.plantData[p * 4];
          for (const [x, y] of [
            [d[o] + xOff, d[o + 1]],
            [d[o + 2] + xOff, d[o + 3]],
          ]) {
            worst = Math.max(worst, intrusion(x, y, refWidth, border));
            worstOff = Math.max(worstOff, offFrame(x, y, refWidth));
          }
          // The heading turns at most KAPPA_MAX per ref px along a segment.
          const kind = v.segKind[slot];
          const turn = Math.abs(angleDiff(d[o + 5], d[o + 4]));
          worstTurn = Math.max(worstTurn, turn / (KAPPA_MAX[kind] * (SEG_LEN[kind] + MAX_STEP)));
          if (kind === KIND_TENDRIL) {
            worstTendril = Math.max(worstTendril, d[o + 6]);
          }
          segs++;
        }
      });
      expect(segs).toBeGreaterThan(1000);
      expect(worst).toBeLessThanOrEqual(1e-3);
      expect(worstOff).toBeLessThanOrEqual(OFF_FRAME + 1e-3);
      expect(worstTurn).toBeLessThanOrEqual(1 + 1e-4);
      expect(worstTendril).toBeLessThanOrEqual(1.3 + 1e-6);
    }, 60_000);
  }

  it("grows leaves and flowers, then drops the leaves and starts new vines", () => {
    const v = createVines(3);
    const f = frame({ growth: 3, flowers: 1 });
    let maxLeaves = 0;
    let maxFlowers = 0;
    let maxFalling = 0;
    run(v, f, 500, 10, () => {
      v.writeSprites(sprites, STRIDE, SPRITE_FLOATS, 1, f.type);
      maxLeaves = Math.max(maxLeaves, v.leafSprites);
      maxFlowers = Math.max(maxFlowers, v.flowerSprites);
      maxFalling = Math.max(maxFalling, v.falling);
    });
    expect(maxLeaves).toBeGreaterThan(50);
    expect(maxFlowers).toBeGreaterThan(0);
    expect(maxFalling).toBeGreaterThan(0);
    // Plants retire and are replaced: many more spawned than there are slots.
    expect(v.spawned).toBeGreaterThan(MAX_PLANTS);
    expect(v.plants).toBeLessThanOrEqual(5);
  }, 60_000);

  it("writes finite sprites within the batch", () => {
    for (const type of Object.values(PLANTS)) {
      const v = createVines(11);
      const f = frame({ type, growth: 3, flowers: 1, density: MAX_PLANTS });
      let bad = 0;
      let most = 0;
      run(v, f, 300, 20, () => {
        const n = v.writeSprites(sprites, STRIDE, SPRITE_FLOATS, 2, type);
        most = Math.max(most, n);
        if (n !== v.leafSprites + v.flowerSprites) {
          bad++;
        }
        for (let i = 0; i < n * STRIDE; i++) {
          if (!Number.isFinite(sprites[i])) {
            bad++;
          }
        }
      });
      expect(bad).toBe(0);
      expect(most).toBeGreaterThan(0);
      expect(most).toBeLessThanOrEqual(MAX_SPRITES);
    }
  }, 60_000);

  it("is deterministic for a seed", () => {
    const a = createVines(5);
    const b = createVines(5);
    const f = frame();
    run(a, f, 60, 1000, () => {});
    run(b, f, 60, 1000, () => {});
    expect(Array.from(a.segData)).toEqual(Array.from(b.segData));
  });
});

describe("pools", () => {
  it("never grow, and stay within their limits", () => {
    const v = createVines(9);
    const f = frame({ growth: 3, density: MAX_PLANTS, flowers: 1 });
    const segData = v.segData;
    const length = segData.length;
    let bad = 0;
    run(v, f, 600, 10, () => {
      if (v.segData.length !== length) {
        bad++;
      }
      let active = 0;
      for (let p = 0; p < MAX_PLANTS; p++) {
        active += v.active[p];
        if (v.segUsed[p] > PLANT_SEGS || v.leafCount[p] > PLANT_LEAVES) {
          bad++;
        }
      }
      if (active !== v.plants || v.plants > MAX_PLANTS) {
        bad++;
      }
      if (v.falling > MAX_FALLING) {
        bad++;
      }
      if (v.writeSprites(sprites, STRIDE, SPRITE_FLOATS, 1, f.type) > MAX_SPRITES) {
        bad++;
      }
    });
    expect(bad).toBe(0);
    expect(v.spawned).toBeGreaterThan(MAX_PLANTS);
    expect(MAX_SPRITES).toBeGreaterThanOrEqual(
      MAX_PLANTS * (PLANT_LEAVES + PLANT_FLOWERS * RACEME),
    );
  }, 60_000);

  it("recycles the oldest plant when every slot is in use", () => {
    const v = createVines(1);
    const f = frame({ density: 0 });
    v.resize(1920);
    v.step(0.1, f);
    const slots: number[] = [];
    for (let i = 0; i < MAX_PLANTS; i++) {
      slots.push(v.spawn(f));
    }
    expect(new Set(slots).size).toBe(MAX_PLANTS);
    for (let i = 0; i < 20; i++) {
      v.step(0.1, f);
    }
    // The next spawn reuses the first plant's slot, and its old segments are cleared.
    const reused = v.spawn(f);
    expect(reused).toBe(slots[0]);
    expect(v.plants).toBe(MAX_PLANTS);
    expect(v.segUsed[reused]).toBe(1);
    expect(v.dirtyLo[reused]).toBe(0);
    expect(v.spawn(f)).toBe(slots[1]);
  });

  it("zeroes a retired plant's segments and marks them for upload", () => {
    const v = createVines(2);
    const f = frame({ growth: 3, density: 1 });
    v.resize(1920);
    for (let i = 0; i < 20; i++) {
      v.step(0.1, f);
    }
    const p = v.active.indexOf(1);
    const used = v.segUsed[p];
    expect(used).toBeGreaterThan(0);
    v.clearDirty();
    // Run the plant through to retirement without spawning a replacement.
    const g = frame({ growth: 3, density: 0 });
    while (v.active[p]) {
      v.step(0.1, g);
    }
    const slice = v.segData.subarray(
      p * PLANT_SEGS * SEG_FLOATS,
      (p + 1) * PLANT_SEGS * SEG_FLOATS,
    );
    expect(slice.every((x) => x === 0)).toBe(true);
    expect(v.dirtyLo[p]).toBe(0);
    expect(v.dirtyHi[p]).toBeGreaterThanOrEqual(used - 1);
  });
});

describe("curves", () => {
  it("leaf growth and wither are monotonic and bounded", () => {
    for (const curve of [leafGrow, witherCurve]) {
      let prev = -Infinity;
      for (let t = -1; t <= 2; t += 0.01) {
        const y = curve(t);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
        expect(y).toBeGreaterThanOrEqual(prev);
        prev = y;
      }
      expect(curve(0)).toBe(0);
      expect(curve(1)).toBe(1);
      expect(curve(-Infinity)).toBe(0);
    }
  });
});

describe("shapes", () => {
  it("are unit-sized fan strips with the centre only at the origin", () => {
    for (let s = 0; s < VINE_SHAPES.length; s++) {
      const outline = vineOutline(s);
      let max = 0;
      for (let i = 0; i < outline.length; i += 2) {
        const r = Math.hypot(outline[i], outline[i + 1]);
        expect(r).toBeGreaterThan(0.05);
        max = Math.max(max, r);
      }
      expect(max).toBeCloseTo(1, 5);
      expect(VINE_SHAPES[s].length).toBe(outline.length * 2 + 2);
    }
  });
});
