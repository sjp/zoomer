import { describe, expect, it } from "vitest";
import {
  advancePulse,
  breathAt,
  camera,
  CAMERAS,
  CORE_GAIN,
  DRIFT_MAX,
  DRIFT_PERIOD,
  driftUniform,
  footprint,
  GRID_ORIGIN,
  groundFromScreen,
  HALO_GAIN,
  JITTER,
  minDrop,
  screenFromGround,
  SEARCH_OK,
  seamGlow,
  seedOffset,
  sky,
  SKIES,
  Z_MAX,
} from "./lava-sim";
import { CAMERA_OPTIONS, SKY_OPTIONS } from "./lava.meta";
import { createRng } from "./noise";
import { createVoronoiSample, voronoiHash, voronoiSample, type VoronoiOffset } from "./voronoi";

describe("projection", () => {
  it("screen to ground is invertible below the horizon", () => {
    const g = [0, 0];
    const s = [0, 0];
    let worst = 0;
    for (const cam of Object.values(CAMERAS)) {
      for (let y = cam.horizon + 0.002; y <= 1; y += 0.01) {
        for (let x = -0.9; x <= 0.9; x += 0.05) {
          if (!groundFromScreen(x, y, cam, g)) worst = Infinity;
          screenFromGround(g[0], g[1], cam, s);
          worst = Math.max(worst, Math.abs(s[0] - x), Math.abs(s[1] - y));
        }
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it("sees no ground on or above the horizon, and recedes toward it", () => {
    const g = [7, 7];
    const cam = camera("low");
    expect(groundFromScreen(0, cam.horizon, cam, g)).toBe(false);
    expect(groundFromScreen(0, 0.1, cam, g)).toBe(false);
    expect(g).toEqual([7, 7]);
    let lastZ = 0;
    let monotone = true;
    for (let y = 1; y > cam.horizon + 0.001; y -= 0.01) {
      groundFromScreen(0.3, y, cam, g);
      if (!(g[1] > lastZ)) monotone = false;
      lastZ = g[1];
    }
    expect(monotone).toBe(true);
  });

  it("the footprint matches finite differences of the projection", () => {
    const cam = camera("high");
    const H = 2160;
    const a = [0, 0];
    const b = [0, 0];
    const c = [0, 0];
    const fp = [0, 0];
    let worst = 0;
    for (let y = cam.horizon + 0.05; y < 1; y += 0.05) {
      groundFromScreen(0.2, y, cam, a);
      groundFromScreen(0.2 + 1 / H, y, cam, b);
      groundFromScreen(0.2, y + 1 / H, cam, c);
      footprint(a[1], cam, H, fp);
      worst = Math.max(worst, Math.abs((b[0] - a[0]) / fp[0] - 1));
      worst = Math.max(worst, Math.abs((a[1] - c[1]) / fp[1] - 1));
    }
    expect(worst).toBeLessThan(0.02);
  });

  it("keeps every grid cell the shader touches non-negative and within the 12-bit hash", () => {
    for (const cam of Object.values(CAMERAS)) {
      const g = [0, 0];
      // The nearest-horizon row the shader evaluates, at the frame's widest edge (21:9).
      groundFromScreen(-1.2, cam.horizon + minDrop(cam), cam, g);
      expect(g[1]).toBeCloseTo(Z_MAX, 9);
      const lo = GRID_ORIGIN + g[0] - 2;
      const hi = GRID_ORIGIN + Z_MAX + 2;
      expect(lo).toBeGreaterThan(0);
      expect(hi).toBeLessThan(4096);
    }
  });
});

describe("plates", () => {
  it("seed offsets stay inside the exact Voronoi search", () => {
    expect(SEARCH_OK).toBe(true);
    const d = [0, 0];
    const o = [0, 0];
    let worst = 0;
    for (let iy = 0; iy < 24; iy++) {
      for (let ix = 0; ix < 24; ix++) {
        const h = voronoiHash(GRID_ORIGIN + ix, GRID_ORIGIN + iy);
        for (let t = 0; t < DRIFT_PERIOD; t += DRIFT_PERIOD / 24) {
          seedOffset(h, driftUniform(t, d), o);
          worst = Math.max(worst, Math.hypot(o[0], o[1]));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(JITTER + DRIFT_MAX + 1e-12);
    expect(worst).toBeGreaterThan(JITTER * 0.9);
  });

  it("3x3 search matches a brute force with the lava seeds", () => {
    const d = driftUniform(31, [0, 0]);
    const offset: VoronoiOffset = (h, _x, _y, out) => seedOffset(h, d, out);
    const rng = createRng(94);
    const a = createVoronoiSample();
    const b = createVoronoiSample();
    let bad = 0;
    for (let n = 0; n < 1500; n++) {
      const gx = GRID_ORIGIN + rng() * 40;
      const gy = GRID_ORIGIN + rng() * 40;
      voronoiSample(gx, gy, offset, a, 1);
      voronoiSample(gx, gy, offset, b, 3);
      if (a.hash !== b.hash || (b.edge < 0.3 && Math.abs(a.edge - b.edge) > 1e-12)) bad++;
    }
    expect(bad).toBe(0);
  });

  it("creep is slow and closed", () => {
    const a = driftUniform(10, [0, 0]);
    const b = driftUniform(10 + DRIFT_PERIOD, [0, 0]);
    expect(b[0]).toBeCloseTo(a[0], 9);
    expect(b[1]).toBeCloseTo(a[1], 9);
    expect(Math.hypot(a[0], a[1])).toBeCloseTo(DRIFT_MAX / Math.SQRT2, 12);
  });
});

describe("glow", () => {
  it("is bounded for any input in range", () => {
    const rng = createRng(1);
    let lo = Infinity;
    let hi = -Infinity;
    for (let n = 0; n < 20000; n++) {
      const g = seamGlow(rng() * 0.8, rng() ** 3 * 3, rng(), rng(), rng(), rng());
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(CORE_GAIN + HALO_GAIN);
    expect(hi).toBeGreaterThan(1);
  });

  it("is zero when cold, and brightest on the seam", () => {
    expect(seamGlow(0, 0.001, 0, 0, 1, 1)).toBe(0);
    expect(seamGlow(0, 0.001, 0, 1, 1, 1)).toBeGreaterThan(seamGlow(0.2, 0.001, 0, 1, 1, 1));
  });

  it("keeps a thin seam's energy as the pixel footprint grows", () => {
    // Integrated over distance, the box-filtered core is the same at any footprint.
    const integrate = (fp: number) => {
      let sum = 0;
      for (let e = 0; e < 2; e += 0.0005) sum += seamGlow(e, fp, 0, 1, 1, 1) * 0.0005;
      return sum;
    };
    expect(integrate(0.05) / integrate(0.002)).toBeCloseTo(1, 1);
  });

  it("is continuous in time, including across speed changes and the phase wrap", () => {
    let phase = 0.97;
    let worst = 0;
    let prev = seamGlow(0.01, 0.002, 0, 0.8, 0.7, breathAt(phase, 0.4));
    for (let i = 0; i < 4000; i++) {
      const pulse = i < 2000 ? 1 : 2; // a speed change half-way
      phase = advancePulse(phase, 1 / 60, pulse);
      const g = seamGlow(0.01, 0.002, 0, 0.8, 0.7, breathAt(phase, 0.4));
      worst = Math.max(worst, Math.abs(g - prev));
      prev = g;
    }
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(1);
    // A frame's step is a small fraction of the glow (about 1.5).
    expect(worst).toBeLessThan(0.01);
  });

  it("the breathing phase stands still at zero speed and ignores bad input", () => {
    expect(advancePulse(0.25, 1, 0)).toBe(0.25);
    expect(advancePulse(0.25, 1, Number.NaN)).toBe(0.25);
    expect(advancePulse(0.25, 1, -1)).toBe(0.25);
  });
});

describe("presets", () => {
  it("every option has a preset, and unknown values fall back", () => {
    for (const o of SKY_OPTIONS) expect(sky(o.value)).toBe(SKIES[o.value]);
    for (const o of CAMERA_OPTIONS) expect(camera(o.value)).toBe(CAMERAS[o.value]);
    expect(sky("nope")).toBe(SKIES.night);
    expect(camera("toString")).toBe(CAMERAS.low);
  });
});
