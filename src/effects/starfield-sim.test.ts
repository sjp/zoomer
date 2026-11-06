import { describe, expect, it } from "vitest";
import {
  advanceRotation,
  bandAcross,
  bandMask,
  bandThrough,
  CELL_LENGTH,
  cellStar,
  createStar,
  DEG,
  EDGE_AA,
  RING_MARGIN,
  RING_WIDTH,
  sectorCount,
  fillStars,
  seedSalt,
  STAR_ENERGY,
  STAR_FLOATS,
  STAR_MIN_RADIUS_PX,
  type StarfieldLayout,
  starPeak,
  starRadiusPx,
  TAU,
  toSky,
  TWINKLE_AMP,
  TWINKLE_CYCLES,
  TWINKLE_PERIOD,
  twinkleFactor,
  twinkleTime,
  visibleRadii,
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
        if (!ok) {
          bad.push([ring, k]);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("occupy about `density` of the cells", () => {
    const star = createStar();
    let occupied = 0;
    const total = 20000;
    for (let i = 0; i < total; i++) {
      if (cellStar(i >> 6, i & 63, 64, 0.3, seedSalt(1), star).occupied) {
        occupied++;
      }
    }
    expect(occupied / total).toBeGreaterThan(0.27);
    expect(occupied / total).toBeLessThan(0.33);
  });

  it("have many faint stars and a few bright ones", () => {
    const star = createStar();
    let bright = 0;
    for (let k = 0; k < 4000; k++) {
      if (cellStar(50, k, 4000, 1, seedSalt(1), star).bright > 0.5) {
        bright++;
      }
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
      if (step < 0) {
        step += TAU;
      }
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

const layout = (over: Partial<StarfieldLayout> = {}): StarfieldLayout => ({
  salt: seedSalt(4),
  density: 0.4,
  pole: [400, 1500],
  refWidth: 1920,
  refHeight: 1080,
  rotates: true,
  margin: 4,
  ...over,
});

describe("point stars", () => {
  it("are deterministic and come from the shared cells", () => {
    const a = new Float32Array(60000 * STAR_FLOATS);
    const b = new Float32Array(60000 * STAR_FLOATS);
    const n = fillStars(a, 60000, layout());
    expect(fillStars(b, 60000, layout())).toBe(n);
    let same = true;
    for (let i = 0; i < n * STAR_FLOATS; i++) {
      same &&= a[i] === b[i];
    }
    expect(same).toBe(true);
    expect(n).toBeGreaterThan(1000);
    // The first listed star is a real cell of its ring.
    const r = Math.hypot(a[0], a[1]);
    const ring = Math.floor(r / RING_WIDTH);
    const cells = sectorCount(ring, Infinity);
    const star = createStar();
    let found = false;
    for (let k = 0; k < cells && !found; k++) {
      cellStar(ring, k, cells, 0.4, seedSalt(4), star);
      found =
        star.occupied && Math.abs(star.radius - r) < 1e-3 && Math.abs(star.bright - a[2]) < 1e-6;
    }
    expect(found).toBe(true);
  });

  it("cover every star that can reach the frame as the sky turns", () => {
    const l = layout();
    const out = new Float32Array(80000 * STAR_FLOATS);
    const n = fillStars(out, 80000, l);
    const [rMin, rMax] = visibleRadii(l, [0, 0]);
    let inside = 0;
    let bad = 0;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(out[i * STAR_FLOATS], out[i * STAR_FLOATS + 1]);
      if (r < rMin || r > rMax) {
        bad++;
      }
    }
    // At any rotation, the stars in the frame match the density (about 1 per 128 px² at 1).
    for (const rot of [0, 1, 2.5, 4]) {
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      inside = 0;
      for (let i = 0; i < n; i++) {
        const qx = out[i * STAR_FLOATS];
        const qy = out[i * STAR_FLOATS + 1];
        const x = l.pole[0] + c * qx - s * qy;
        const y = l.pole[1] + s * qx + c * qy;
        if (x >= 0 && x <= 1920 && y >= 0 && y <= 1080) {
          inside++;
        }
      }
      const expected = (0.4 * 1920 * 1080) / (RING_WIDTH * CELL_LENGTH);
      if (Math.abs(inside / expected - 1) > 0.1) {
        bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("keep only the frame for a still sky, and stop at the cap", () => {
    const l = layout({ rotates: false, pole: [960, 2000] });
    const out = new Float32Array(80000 * STAR_FLOATS);
    const n = fillStars(out, 80000, l);
    let outside = 0;
    for (let i = 0; i < n; i++) {
      const x = l.pole[0] + out[i * STAR_FLOATS];
      const y = l.pole[1] + out[i * STAR_FLOATS + 1];
      if (x < -4 || x > 1924 || y < -4 || y > 1084) {
        outside++;
      }
    }
    expect(outside).toBe(0);
    expect(n).toBeGreaterThan(6000);
    expect(n).toBeLessThan(7100);
    expect(fillStars(out, 100, l)).toBe(100);
    expect(fillStars(out, 100, { ...l, density: 0 })).toBe(0);
  });

  it("twinkle slowly within bounds, and only the bright ones", () => {
    const out = new Float32Array(2000 * STAR_FLOATS);
    const n = fillStars(out, 2000, layout());
    let ok = true;
    for (let i = 0; i < n; i++) {
      const o = i * STAR_FLOATS;
      const cycles = out[o + 4];
      ok &&= Number.isInteger(cycles) && cycles >= TWINKLE_CYCLES[0] && cycles <= TWINKLE_CYCLES[1];
      ok &&= out[o + 5] >= 0 && out[o + 5] < 1;
    }
    expect(ok).toBe(true);
    let lo = Infinity;
    let hi = -Infinity;
    let seam = 0;
    for (let t = 0; t < 120; t += 0.25) {
      const f = twinkleFactor(1, 7, 0.3, t, 1);
      lo = Math.min(lo, f);
      hi = Math.max(hi, f);
      // Wrapping time to the period changes nothing.
      seam = Math.max(
        seam,
        Math.abs(f - twinkleFactor(1, 7, 0.3, twinkleTime(t + 1e4 * TWINKLE_PERIOD), 1)),
      );
    }
    expect(lo).toBeGreaterThanOrEqual(1 - TWINKLE_AMP - 1e-9);
    expect(hi).toBeLessThanOrEqual(1 + TWINKLE_AMP + 1e-9);
    expect(hi - lo).toBeGreaterThan(TWINKLE_AMP);
    expect(seam).toBeLessThan(1e-6);
    expect(twinkleFactor(0.1, 7, 0.3, 13, 1)).toBe(1);
    expect(twinkleFactor(1, 7, 0.3, 13, 0)).toBe(1);
    // Fastest twinkle stays well under 1 Hz.
    expect(TWINKLE_CYCLES[1] / TWINKLE_PERIOD).toBeLessThan(0.2);
  });

  it("give the same light at every sprite size", () => {
    let worst = 0;
    for (const scale of [0.5, 1, 2, 3]) {
      for (const b of [0.1, 0.4, 1]) {
        const r = starRadiusPx(b, scale);
        const light = (starPeak(b, scale) * Math.PI * r * r) / 3;
        worst = Math.max(worst, Math.abs(light / (b * STAR_ENERGY * scale * scale) - 1));
        if (r < STAR_MIN_RADIUS_PX) {
          worst = Infinity;
        }
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });
});
