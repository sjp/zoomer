import { describe, expect, it } from "vitest";
import {
  createDrips,
  createIcicles,
  DROP_G,
  DROP_HANG,
  dropFall,
  dropSpeed,
  dropSwell,
  ICICLE_BAND,
  ICICLE_LEN,
  JITTER,
  mouth,
  MOUTHS,
  palette,
  PALETTES,
  screenFromWall,
  SEARCH_OK,
  seedOffset,
  stepDrips,
  thickness,
  transmission,
  tunnelRadius,
  wallFromScreen,
  Z_MAX,
} from "./icecave-sim";
import { COLOUR_OPTIONS, MOUTH_OPTIONS } from "./icecave.meta";
import { createRng } from "./noise";
import { createVoronoiSample, voronoiHash, voronoiSample, type VoronoiOffset } from "./voronoi";

describe("tunnel mapping", () => {
  it("round-trips screen to wall to screen", () => {
    const w = [0, 0];
    const s = [0, 0];
    let worst = 0;
    for (const m of Object.values(MOUTHS)) {
      for (let y = 0; y <= 1; y += 0.02) {
        for (let x = -0.9; x <= 0.9; x += 0.03) {
          if (tunnelRadius(x, y, m) < 1 / Z_MAX) continue;
          wallFromScreen(x, y, m, w);
          screenFromWall(w[0], w[1], m, s);
          worst = Math.max(worst, Math.abs(s[0] - x), Math.abs(s[1] - y));
        }
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it("recedes monotonically toward the vanishing point", () => {
    const w = [0, 0];
    let ok = true;
    for (const m of Object.values(MOUTHS)) {
      for (let k = 0; k < 16; k++) {
        const dir = (k / 16) * 2 * Math.PI;
        let last = 0;
        for (let t = 1; t > 0.001; t -= 0.005) {
          wallFromScreen(m.x + Math.cos(dir) * t, m.y + Math.sin(dir) * t, m, w);
          if (!(w[1] >= last)) ok = false;
          last = w[1];
        }
        if (last !== Z_MAX) ok = false;
      }
    }
    expect(ok).toBe(true);
  });

  it("is continuous away from the floor seam", () => {
    // Neighbouring pixels (1/1080 frame heights apart) map to nearby wall points.
    const a = [0, 0];
    const b = [0, 0];
    const d = 1 / 1080;
    let worstA = 0;
    let worstZ = 0;
    for (const m of Object.values(MOUTHS)) {
      for (let y = 0; y <= 1; y += 0.01) {
        for (let x = -0.89; x <= 0.89; x += 0.01) {
          if (tunnelRadius(x, y, m) < 0.12) continue;
          wallFromScreen(x, y, m, a);
          // The seam is the floor centre line, straight below the vanishing point.
          if (Math.abs(Math.abs(a[0]) - 0.5) < 0.02) continue;
          for (const [dx, dy] of [
            [d, 0],
            [0, d],
          ]) {
            wallFromScreen(x + dx, y + dy, m, b);
            worstA = Math.max(worstA, Math.abs(b[0] - a[0]));
            worstZ = Math.max(worstZ, Math.abs(b[1] - a[1]) / a[1]);
          }
        }
      }
    }
    // Small steps everywhere the wall is drawn (the mouth covers radii below 1/8).
    expect(worstA).toBeLessThan(0.01);
    expect(worstZ).toBeLessThan(0.01);
  });

  it("puts the ceiling at a = 0 and the floor at a = +-0.5", () => {
    const w = [0, 0];
    const m = mouth("far");
    wallFromScreen(m.x, m.y - 0.3, m, w);
    expect(w[0]).toBeCloseTo(0, 12);
    wallFromScreen(m.x + 1e-9, m.y + 0.3, m, w);
    expect(Math.abs(w[0])).toBeCloseTo(0.5, 6);
  });

  it("falls back to the right mouth", () => {
    expect(mouth("nope")).toBe(MOUTHS.right);
    expect(mouth("toString")).toBe(MOUTHS.right);
    for (const o of MOUTH_OPTIONS) expect(mouth(o.value)).toBe(MOUTHS[o.value]);
  });
});

describe("scallops", () => {
  it("keeps every seed inside the exact search", () => {
    expect(SEARCH_OK).toBe(true);
    const o = [0, 0];
    let worst = 0;
    for (let i = 0; i < 4096; i++) {
      seedOffset(voronoiHash(i, i * 7), o);
      worst = Math.max(worst, Math.hypot(o[0], o[1]));
    }
    expect(worst).toBeLessThanOrEqual(JITTER + 1e-12);
  });

  it("matches a wide brute-force search", () => {
    const offset: VoronoiOffset = (h, _ix, _iy, out) => seedOffset(h, out);
    const a = createVoronoiSample();
    const b = createVoronoiSample();
    const rng = createRng(97);
    let bad = 0;
    for (let k = 0; k < 2000; k++) {
      const gx = 1024 + rng() * 40;
      const gy = rng() * 200;
      voronoiSample(gx, gy, offset, a, 1);
      voronoiSample(gx, gy, offset, b, 3);
      if (a.hash !== b.hash || Math.abs(a.edge - b.edge) > 1e-9) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe("translucency", () => {
  it("is bounded in (0, 1] and falls with thickness", () => {
    let ok = true;
    let last = 2;
    for (let t = -1; t <= 10; t += 0.05) {
      const v = transmission(t);
      if (!(v > 0 && v <= 1)) ok = false;
      if (t >= 0 && !(v < last)) ok = false;
      if (t >= 0) last = v;
    }
    for (let n = 0; n <= 1; n += 0.1) {
      for (let band = 0; band <= 1; band += 0.25) {
        for (let dish = 0; dish <= 1; dish += 0.25) {
          const th = thickness(n, band, dish);
          const v = transmission(th);
          if (!(th >= 0 && v > 0 && v <= 1)) ok = false;
        }
      }
    }
    expect(ok).toBe(true);
    // Thin ice glows; thick, banded ice is dark.
    expect(transmission(thickness(0, 0, 1))).toBeGreaterThan(0.9);
    expect(transmission(thickness(1, 1, 0))).toBeLessThan(0.05);
  });

  it("has a palette for every colour option, falling back to glacier", () => {
    for (const o of COLOUR_OPTIONS) expect(palette(o.value)).toBe(PALETTES[o.value]);
    expect(palette("nope")).toBe(PALETTES.glacier);
  });
});

describe("icicles and drips", () => {
  it("hangs icicles at the sides, away from the speaker", () => {
    const ics = createIcicles(createRng(3));
    let ok = true;
    for (const ic of ics) {
      if (!(ic.x <= ICICLE_BAND || ic.x >= 1 - ICICLE_BAND)) ok = false;
      if (!(ic.x >= 0 && ic.x <= 1)) ok = false;
      if (!(ic.tip >= ICICLE_LEN[0] && ic.tip <= ICICLE_LEN[1])) ok = false;
    }
    expect(ok).toBe(true);
    expect(ics.filter((ic) => ic.x < 0.5).length).toBe(ics.length / 2);
  });

  it("is deterministic per seed", () => {
    const run = (seed: number) => {
      const rng = createRng(seed);
      const ics = createIcicles(rng);
      const s = createDrips(ics.length, rng);
      const ages: number[] = [];
      for (let i = 0; i < 600; i++) {
        stepDrips(s, 1 / 30, 1, 1100, rng);
        ages.push(...s.age);
      }
      return { ics, ages };
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
  });

  it("drops start at the tip, swell, then fall faster and faster", () => {
    expect(dropFall(0)).toBe(0);
    expect(dropFall(DROP_HANG)).toBe(0);
    expect(dropSwell(0)).toBe(0);
    expect(dropSwell(DROP_HANG)).toBe(1);
    let ok = true;
    let lastFall = 0;
    let lastSpeed = 0;
    for (let t = DROP_HANG + 0.01; t < DROP_HANG + 1; t += 0.01) {
      const fall = dropFall(t);
      const speed = dropSpeed(t);
      if (!(fall > lastFall && speed > lastSpeed)) ok = false;
      lastFall = fall;
      lastSpeed = speed;
    }
    expect(ok).toBe(true);
    expect(dropFall(DROP_HANG + 0.5)).toBeCloseTo(0.5 * DROP_G * 0.25, 9);
  });

  it("drips at the requested rate and ends drops once they have fallen", () => {
    const count = (rate: number) => {
      const rng = createRng(11);
      const s = createDrips(12, rng);
      let starts = 0;
      let longest = 0;
      for (let i = 0; i < 30 * 600; i++) {
        const before = Array.from(s.age);
        stepDrips(s, 1 / 30, rate, 1100, rng);
        for (let k = 0; k < 12; k++) {
          if (before[k] < 0 && s.age[k] >= 0) starts++;
          longest = Math.max(longest, s.age[k]);
        }
      }
      return { starts, longest };
    };
    const off = count(0);
    const one = count(1);
    const two = count(2);
    expect(off.starts).toBe(0);
    // 12 icicles for 600 s at a 9 s mean interval: about 800 drops, a few skipped while busy.
    expect(one.starts).toBeGreaterThan(600);
    expect(one.starts).toBeLessThan(900);
    expect(two.starts).toBeGreaterThan(one.starts * 1.5);
    expect(one.longest).toBeLessThan(DROP_HANG + Math.sqrt((2 * 1100) / DROP_G) + 0.05);
  });
});
