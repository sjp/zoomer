import { describe, expect, it } from "vitest";
import {
  advanceRotation,
  bandAcross,
  bandMask,
  bandThrough,
  cellStar,
  createStar,
  DEG,
  EDGE_AA,
  RING_MARGIN,
  RING_WIDTH,
  sectorCount,
  seedSalt,
  TAU,
  toSky,
  wrapAngle,
} from "./starfield-sim";

describe("star cells", () => {
  it("are deterministic for a salt and differ between salts", () => {
    const a = cellStar(12, 5, 20, 0.7, seedSalt(7), createStar());
    const b = cellStar(12, 5, 20, 0.7, seedSalt(7), createStar());
    const c = cellStar(12, 5, 20, 0.7, seedSalt(8), createStar());
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it("keep stars inside their sector and inside the ring margin", () => {
    const star = createStar();
    const bad: [number, number][] = [];
    for (let ring = 0; ring < 300; ring += 7) {
      const n = sectorCount(ring, Infinity);
      const s = TAU / n;
      for (let k = 0; k < n; k++) {
        cellStar(ring, k, n, 1, seedSalt(3), star);
        const ok =
          star.angle >= k * s &&
          star.angle < (k + 1) * s &&
          star.radius >= ring * RING_WIDTH + RING_MARGIN &&
          star.radius <= (ring + 1) * RING_WIDTH - RING_MARGIN &&
          // The whole trail width, anti-aliasing included, stays in the ring.
          star.radius - star.halfWidth - EDGE_AA >= ring * RING_WIDTH &&
          star.radius + star.halfWidth + EDGE_AA <= (ring + 1) * RING_WIDTH &&
          star.bright > 0 &&
          star.bright <= 1 &&
          star.temp > 0 &&
          star.temp < 1;
        if (!ok) bad.push([ring, k]);
      }
    }
    expect(bad).toEqual([]);
  });

  it("occupy about `density` of the cells", () => {
    const star = createStar();
    let occupied = 0;
    const total = 20000;
    for (let i = 0; i < total; i++) {
      if (cellStar(i >> 6, i & 63, 64, 0.3, seedSalt(1), star).occupied) occupied++;
    }
    expect(occupied / total).toBeGreaterThan(0.27);
    expect(occupied / total).toBeLessThan(0.33);
  });

  it("have many faint stars and a few bright ones", () => {
    const star = createStar();
    let bright = 0;
    for (let k = 0; k < 4000; k++) {
      if (cellStar(50, k, 4000, 1, seedSalt(1), star).bright > 0.5) bright++;
    }
    expect(bright / 4000).toBeGreaterThan(0.02);
    expect(bright / 4000).toBeLessThan(0.15);
  });
});

describe("rotation", () => {
  it("advances at the given rate and wraps to [0, 2π) without jumps", () => {
    expect(advanceRotation(0, 60, 6)).toBeCloseTo(6 * DEG, 12);
    expect(advanceRotation(1, -1, 6)).toBe(1);
    let rot = TAU - 0.001;
    let prev = wrapAngle(rot);
    let ok = true;
    for (let i = 0; i < 1000; i++) {
      rot = advanceRotation(rot, 0.1, 60);
      const w = wrapAngle(rot);
      // The step on the circle is the same whether or not it wrapped.
      let step = w - prev;
      if (step < 0) step += TAU;
      ok &&=
        w >= 0 &&
        w < TAU &&
        Math.abs(step - 0.1 * DEG) < 1e-9 &&
        // A star's screen angle is the same from the wrapped and unwrapped rotation.
        Math.abs(Math.cos(1.3 + w) - Math.cos(1.3 + rot)) < 1e-9;
      prev = w;
    }
    expect(ok).toBe(true);
    expect(wrapAngle(-1e-18)).toBe(0);
    expect(wrapAngle(TAU)).toBe(0);
  });
});

describe("sky coordinates", () => {
  it("turn a screen offset back by the rotation", () => {
    const out: [number, number] = [0, 0];
    // A star at sky angle a shows at screen angle a + rot.
    const a = 0.4;
    const rot = 1.1;
    toSky(100 * Math.cos(a + rot), 100 * Math.sin(a + rot), rot, out);
    expect(out[0]).toBeCloseTo(100 * Math.cos(a), 9);
    expect(out[1]).toBeCloseTo(100 * Math.sin(a), 9);
  });
});

describe("Milky Way band", () => {
  it("passes through the requested point at rotation 0, along the requested direction", () => {
    const pole = [300, 1400] as const;
    const band = bandThrough(pole, 1100, 700, -0.5, 250);
    expect(bandAcross(band, 1100 - pole[0], 700 - pole[1])).toBeCloseTo(0, 9);
    const along = [Math.cos(-0.5) * 400, Math.sin(-0.5) * 400];
    expect(bandAcross(band, 1100 + along[0] - pole[0], 700 + along[1] - pole[1])).toBeCloseTo(0, 9);
    expect(bandMask(band, 1100 - pole[0], 700 - pole[1])).toBeCloseTo(1, 9);
    // Half at one width across.
    const n = [Math.cos(band.angle) * 250, Math.sin(band.angle) * 250];
    expect(bandMask(band, 1100 + n[0] - pole[0], 700 + n[1] - pole[1])).toBeCloseTo(0.5, 9);
  });
});
