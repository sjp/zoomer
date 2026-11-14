import { describe, expect, it } from "vitest";
import { capPatternSpeed } from "../motion-limits";
import { createNoise } from "../noise";
import {
  buildProfile,
  CLEAR_X,
  CLEAR_Y,
  clearArea,
  createFire,
  EDGE_BOTTOM,
  EDGE_COUNT,
  EDGE_LEFT,
  EDGE_RIGHT,
  EDGE_TOP,
  type Fire,
  fireCoverage,
  FLAME_OCTAVES,
  layoutFire,
  MAX_PER_EDGE,
  MAX_SMOKE,
  PARAM_RATE,
  PROFILE_CHANNELS,
  PROFILE_COLUMNS,
  type Rect,
  REF_HEIGHT,
  roomLayout,
  SIZE_RATE,
  SMOKE_NOISE,
  smokeDepth,
  STEAM_PERIOD,
  steamPuff,
  stepFire,
  tongue,
  WARP,
  WARP_ALONG,
} from "./thisisfine-sim";

const ASPECTS = [9 / 16, 3 / 4, 1, 4 / 3, 16 / 9, 21 / 9, 32 / 9] as const;
const INTENSITIES = [0, 0.25, 0.5, 0.75, 1] as const;
const noise = createNoise(0xf1e5);

function fireAt(aspect: number, intensity: number, seed = 1, smoke = 0.5): Fire {
  const fire = createFire();
  layoutFire(fire, REF_HEIGHT * aspect, REF_HEIGHT, seed);
  stepFire(fire, 0, intensity, smoke);
  return fire;
}

const profile = () => new Float32Array(PROFILE_COLUMNS * EDGE_COUNT * PROFILE_CHANNELS);

describe("flame anchors", () => {
  it.each(ASPECTS.flatMap((a) => INTENSITIES.map((i) => [a, i] as const)))(
    "stay on the edges and out of the clear area (aspect %f, intensity %f)",
    (aspect, intensity) => {
      for (const seed of [1, 2, 3]) {
        const fire = fireAt(aspect, intensity, seed);
        const w = fire.width;
        const h = fire.height;
        for (let e = 0; e < EDGE_COUNT; e++) {
          const len = e === EDGE_BOTTOM || e === EDGE_TOP ? w : h;
          for (let i = 0; i < fire.count[e]; i++) {
            const t = fire.t[e * MAX_PER_EDGE + i];
            expect(t).toBeGreaterThan(0);
            expect(t).toBeLessThan(len);
          }
        }
        // The drawn flames, at several flicker phases and with the shader's
        // furthest warp, never reach into the clear area.
        const out = profile();
        const over: string[] = [];
        for (const time of [0, 3.3, 17.9, 61.2]) {
          buildProfile(fire, out, noise, time, 1);
          for (let e = 0; e < EDGE_COUNT; e++) {
            const len = e === EDGE_BOTTOM || e === EDGE_TOP ? w : h;
            for (let c = 0; c < PROFILE_COLUMNS; c++) {
              const reach = out[(e * PROFILE_COLUMNS + c) * PROFILE_CHANNELS] * (1 + WARP);
              const t = ((c + 0.5) / PROFILE_COLUMNS) * len;
              const side = e === EDGE_LEFT || e === EDGE_RIGHT;
              const middle = t > w * CLEAR_X - WARP_ALONG && t < w * (1 - CLEAR_X) + WARP_ALONG;
              const limit = side ? w * CLEAR_X : middle ? h * CLEAR_Y : Infinity;
              if (reach >= limit) {
                over.push(`seed ${String(seed)} edge ${String(e)} column ${String(c)}`);
              }
            }
          }
        }
        expect(over).toEqual([]);
      }
    },
  );

  it.each(ASPECTS)("cover more of the room as the fire spreads (aspect %f)", (aspect) => {
    let last = -1;
    for (let i = 0; i <= 20; i++) {
      const cover = fireCoverage(fireAt(aspect, i / 20));
      expect(cover).toBeGreaterThanOrEqual(last);
      last = cover;
    }
    expect(fireCoverage(fireAt(aspect, 1))).toBeGreaterThan(3 * fireCoverage(fireAt(aspect, 0)));
  });

  it("start from one corner and reach every anchor at full spread", () => {
    const small = fireAt(16 / 9, 0);
    const burning = Array.from(
      { length: EDGE_COUNT * MAX_PER_EDGE },
      (_, s) => small.target[s] > 0,
    );
    expect(burning.filter(Boolean).length).toBeGreaterThan(0);
    // Only anchors near a bottom corner burn.
    const far = burning.filter((b, s) => b && small.dist[s] >= small.height);
    expect(far).toEqual([]);
    const full = fireAt(16 / 9, 1);
    for (let e = 0; e < EDGE_COUNT; e++) {
      for (let i = 0; i < full.count[e]; i++) {
        const s = e * MAX_PER_EDGE + i;
        expect(full.target[s]).toBeCloseTo(full.limit[s], 9);
      }
    }
  });

  it("ease spread and smoke changes over several seconds, with no jump in any anchor", () => {
    const fire = fireAt(16 / 9, 0, 1, 0);
    const dt = 1 / 60;
    const before = new Float64Array(fire.size);
    let eased = [0, 0];
    for (let f = 1; f <= 600; f++) {
      stepFire(fire, dt, 1, 1);
      for (let s = 0; s < before.length; s++) {
        expect(Math.abs(fire.size[s] - before[s])).toBeLessThanOrEqual(
          SIZE_RATE * fire.limit[s] * dt + 1e-9,
        );
      }
      before.set(fire.size);
      if (f === 60) {
        eased = [fire.intensity, fire.smoke];
      }
    }
    expect(eased[0]).toBeCloseTo(PARAM_RATE, 6);
    expect(eased[1]).toBeCloseTo(PARAM_RATE, 6);
    expect(fire.intensity).toBe(1);
    expect(smokeDepth(fire)).toBeCloseTo(MAX_SMOKE * fire.height, 6);
    // Settled at full size by the end.
    for (let s = 0; s < before.length; s++) {
      expect(fire.size[s]).toBeCloseTo(fire.target[s], 6);
    }
  });

  it("carry eased sizes over a resize", () => {
    const fire = fireAt(16 / 9, 0.6);
    const before = fire.size[EDGE_BOTTOM * MAX_PER_EDGE + 3];
    layoutFire(fire, REF_HEIGHT * 1.7, REF_HEIGHT, 1);
    expect(fire.size[EDGE_BOTTOM * MAX_PER_EDGE + 3]).toBe(before);
  });

  it("flicker only with motion: a still profile is identical over time", () => {
    const fire = fireAt(16 / 9, 0.7);
    const a = profile();
    const b = profile();
    buildProfile(fire, a, noise, 1, 0);
    buildProfile(fire, b, noise, 40, 0);
    expect(b).toEqual(a);
    buildProfile(fire, b, noise, 40, 1);
    expect(b).not.toEqual(a);
  });
});

describe("flame shape", () => {
  it("is a pointed tongue over a low bed", () => {
    expect(tongue(0)).toBeCloseTo(1, 9);
    expect(tongue(0.5)).toBeLessThan(tongue(0.25));
    expect(tongue(1.2)).toBeGreaterThan(0);
    expect(tongue(2)).toBe(0);
  });
});

describe("motion limits", () => {
  it.each(FLAME_OCTAVES)("scroll the flame noise slowly (cell $cell)", ({ cell, rise }) => {
    expect(capPatternSpeed(rise, cell)).toBe(rise);
    expect(rise / cell).toBeLessThan(1);
  });

  it("drift the smoke slowly", () => {
    expect(capPatternSpeed(SMOKE_NOISE.drift, SMOKE_NOISE.cell)).toBe(SMOKE_NOISE.drift);
  });
});

describe("steam", () => {
  it("curls up and fades every few seconds, starting and ending unseen", () => {
    const puff = { alpha: 0, rise: 0 };
    expect(steamPuff(0, puff).alpha).toBe(0);
    expect(steamPuff(STEAM_PERIOD * 0.4, puff).alpha).toBeGreaterThan(0.5);
    expect(steamPuff(STEAM_PERIOD * 0.95, puff).alpha).toBe(0);
    let last = steamPuff(0, puff).alpha;
    for (let t = 0.01; t < 3 * STEAM_PERIOD; t += 0.01) {
      const a = steamPuff(t, puff).alpha;
      expect(Math.abs(a - last)).toBeLessThan(0.02);
      last = a;
    }
  });
});

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("room layout", () => {
  it.each(ASPECTS)("keeps the props out of the clear area (aspect %f)", (aspect) => {
    const w = REF_HEIGHT * aspect;
    const l = roomLayout(w, REF_HEIGHT, 1);
    const clear = clearArea(w, REF_HEIGHT);
    for (const prop of [l.door, l.picture, l.stand, l.table, l.mug, l.plant, l.bubble]) {
      expect(overlaps(prop, clear)).toBe(false);
      expect(prop.x).toBeGreaterThanOrEqual(0);
      expect(prop.x + prop.w).toBeLessThanOrEqual(w);
      expect(prop.w).toBeGreaterThan(0);
    }
    expect(l.tailX).toBeLessThan(clear.x);
    // The mug stands on the table.
    expect(l.mug.y + l.mug.h).toBeCloseTo(l.table.y, 9);
  });

  it("tilts the picture a little, either way by variation", () => {
    const tilts = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => roomLayout(1920, 1080, s).tilt);
    expect(tilts.some((t) => t > 0)).toBe(true);
    expect(tilts.some((t) => t < 0)).toBe(true);
    for (const t of tilts) {
      expect(Math.abs(t)).toBeLessThan(0.1);
    }
  });
});
