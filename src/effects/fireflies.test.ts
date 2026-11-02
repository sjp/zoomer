import { describe, expect, it } from "vitest";
import {
  type Beam,
  beamAcross,
  beamAlong,
  beamMembership,
  blink,
  layoutBeams,
  MAX_BEAMS,
} from "./fireflies";

const beam = (over: Partial<Beam> = {}): Beam => ({
  x0: 500,
  slope: 0,
  halfWidth: 100,
  y0: 0,
  y1: 1000,
  intensity: 1,
  ...over,
});

describe("blink", () => {
  it("is dark outside the pulse", () => {
    expect(blink(0, 0.2)).toBe(0);
    expect(blink(0.2, 0.2)).toBe(0);
    expect(blink(0.5, 0.2)).toBe(0);
    expect(blink(0.99, 0.2)).toBe(0);
    expect(blink(-0.1, 0.2)).toBe(0);
    expect(blink(0.1, 0)).toBe(0);
  });

  it("peaks at 1 mid-pulse and is symmetric", () => {
    expect(blink(0.1, 0.2)).toBeCloseTo(1, 10);
    expect(blink(0.05, 0.2)).toBeCloseTo(blink(0.15, 0.2), 10);
    expect(blink(0.05, 0.2)).toBeCloseTo(0.5, 10);
  });

  it("fades in and out smoothly (near-zero slope at the ends)", () => {
    const eps = 1e-4;
    expect(blink(eps, 0.2)).toBeLessThan(1e-5);
    expect(blink(0.2 - eps, 0.2)).toBeLessThan(1e-5);
  });

  it("stays in [0, 1]", () => {
    for (let ph = 0; ph < 1; ph += 0.01) {
      const v = blink(ph, 0.3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("beam profiles", () => {
  it("across: full in the core, zero at the edge", () => {
    expect(beamAcross(0)).toBe(1);
    expect(beamAcross(0.2)).toBe(1);
    expect(beamAcross(-0.2)).toBe(1);
    expect(beamAcross(1)).toBe(0);
    expect(beamAcross(-1.5)).toBe(0);
    expect(beamAcross(0.6)).toBeGreaterThan(beamAcross(0.8));
  });

  it("along: fades gently down the beam and ends softly", () => {
    expect(beamAlong(0)).toBe(1);
    expect(beamAlong(0.5)).toBeLessThan(1);
    expect(beamAlong(0.5)).toBeGreaterThan(0.6);
    expect(beamAlong(1)).toBe(0);
    expect(beamAlong(-0.1)).toBe(0);
    expect(beamAlong(1.1)).toBe(0);
    for (let v = 0; v < 1; v += 0.05) expect(beamAlong(v + 0.05)).toBeLessThanOrEqual(beamAlong(v));
  });
});

describe("beamMembership", () => {
  it("is brightest on the centre line near the top", () => {
    expect(beamMembership(500, 0, beam())).toBe(1);
    expect(beamMembership(500, 0, beam({ intensity: 0.5 }))).toBe(0.5);
  });

  it("is zero outside the beam", () => {
    expect(beamMembership(700, 300, beam())).toBe(0);
    expect(beamMembership(300, 300, beam())).toBe(0);
    expect(beamMembership(500, -10, beam())).toBe(0);
    expect(beamMembership(500, 1010, beam())).toBe(0);
  });

  it("falls off towards the edges", () => {
    const b = beam();
    const centre = beamMembership(500, 300, b);
    const mid = beamMembership(570, 300, b);
    const edge = beamMembership(595, 300, b);
    expect(centre).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(0);
    expect(beamMembership(430, 300, b)).toBeCloseTo(mid, 10);
  });

  it("follows the slant", () => {
    const b = beam({ slope: 0.5 });
    // Centre line at y = 400 is x = 700.
    expect(beamMembership(700, 400, b)).toBeCloseTo(beamAlong(0.4), 10);
    expect(beamMembership(500, 400, b)).toBe(0);
  });
});

describe("layoutBeams", () => {
  const out = (): Beam[] => Array.from({ length: MAX_BEAMS }, () => beam());

  it("clamps the beam count", () => {
    expect(layoutBeams(0, 20, 1920, out())).toBe(1);
    expect(layoutBeams(2, 20, 1920, out())).toBe(2);
    expect(layoutBeams(9, 20, 1920, out())).toBe(MAX_BEAMS);
  });

  it("slants by the angle and keeps beams on screen at mid-height", () => {
    for (const angle of [-45, -10, 0, 24, 45]) {
      const beams = out();
      const n = layoutBeams(3, angle, 1920, beams);
      for (let i = 0; i < n; i++) {
        const b = beams[i];
        expect(b.slope).toBeCloseTo(Math.tan((angle * Math.PI) / 180), 10);
        const mid = b.x0 + b.slope * 540;
        expect(mid).toBeGreaterThan(0);
        expect(mid).toBeLessThan(1920);
        expect(b.y0).toBeLessThanOrEqual(0);
        expect(b.y1).toBeGreaterThanOrEqual(1000);
      }
    }
  });
});
