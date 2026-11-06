import { describe, expect, it } from "vitest";
import {
  type Beam,
  BEAM_FRAGMENT,
  BEAM_VERTEX,
  beamAcross,
  beamAlong,
  beamMembership,
  blink,
  layoutBeams,
  writeBeamInstance,
} from "./fireflies";
import { createRng } from "./noise";
import { MAX_BEAMS } from "./fireflies.meta";

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
    for (let v = 0; v < 1; v += 0.05) {
      expect(beamAlong(v + 0.05)).toBeLessThanOrEqual(beamAlong(v));
    }
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

  it("leans continuously as the angle passes through 0", () => {
    const at = (angle: number) => {
      const beams = out();
      layoutBeams(1, angle, 1920, beams);
      return beams[0].x0 + beams[0].slope * 540;
    };
    expect(at(0)).toBeCloseTo(0.42 * 1920, 6);
    expect(Math.abs(at(1) - at(-1))).toBeLessThan(15);
    expect(Math.abs(at(0.5) - at(0))).toBeLessThan(5);
    // Full lean from 24 degrees on, as before.
    expect(at(24)).toBeCloseTo(0.34 * 1920, 6);
    expect(at(45)).toBeCloseTo(0.34 * 1920, 6);
    expect(at(-30)).toBeCloseTo(0.5 * 1920, 6);
  });
});

/**
 * The beam quad as the GPU draws it: BEAM_VERTEX places the QUAD strip's corners
 * from the instance, the rasteriser interpolates `vBeam` linearly over each of its
 * two triangles, and BEAM_FRAGMENT shades `across * along * intensity`. Returns 0
 * outside the quad, where nothing is drawn.
 */
function gpuBeam(inst: Float32Array, px: number, py: number): number {
  const [x0, slope, hw, y0, y1, intensity] = inst;
  // BEAM_VERTEX for each corner of QUAD: position and vBeam.
  const corners = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ].map(([cx, cy]) => {
    const v = cy * 0.5 + 0.5;
    const y = y0 + (y1 - y0) * v;
    return { x: x0 + slope * y + cx * hw, y, beam: [cx, v] };
  });
  // The strip's triangles: 0-1-2 and 1-2-3.
  for (const [a, b, c] of [
    [0, 1, 2],
    [1, 2, 3],
  ]) {
    const A = corners[a];
    const B = corners[b];
    const C = corners[c];
    const det = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
    const wa = ((B.y - C.y) * (px - C.x) + (C.x - B.x) * (py - C.y)) / det;
    const wb = ((C.y - A.y) * (px - C.x) + (A.x - C.x) * (py - C.y)) / det;
    const wc = 1 - wa - wb;
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) {
      continue;
    }
    const across = wa * A.beam[0] + wb * B.beam[0] + wc * C.beam[0];
    const along = wa * A.beam[1] + wb * B.beam[1] + wc * C.beam[1];
    // BEAM_FRAGMENT's profile, which beamAcross and beamAlong mirror.
    return beamAcross(across) * beamAlong(Math.min(1, Math.max(0, along))) * intensity;
  }
  return 0;
}

describe("beam quad on the GPU", () => {
  it("lights exactly where beamMembership says, for slanted beams at any scale", () => {
    const beams = Array.from({ length: MAX_BEAMS }, () => beam());
    const inst = new Float32Array(6);
    const rng = createRng(12);
    let lit = 0;
    for (const angle of [-45, -24, -5, 0, 10, 24, 45]) {
      for (const scale of [1, 2, 0.5]) {
        const n = layoutBeams(MAX_BEAMS, angle, 1920, beams);
        for (let b = 0; b < n; b++) {
          writeBeamInstance(inst, 0, beams[b], scale, 1);
          for (let k = 0; k < 400; k++) {
            // Device px over the frame and a little beyond it.
            const px = (rng() * 2200 - 140) * scale;
            const py = (rng() * 1200 - 60) * scale;
            const want = beamMembership(px / scale, py / scale, beams[b]);
            const got = gpuBeam(inst, px, py);
            expect(Math.abs(got - want)).toBeLessThan(1e-4);
            if (want > 0) {
              lit++;
            }
          }
        }
      }
    }
    expect(lit).toBeGreaterThan(1000);
  });

  it("mirrors the shaders gpuBeam stands in for", () => {
    // If these lines change, update gpuBeam to match.
    for (const line of [
      "float v = aCorner.y * 0.5 + 0.5;",
      "float y = mix(aSpan.x, aSpan.y, v);",
      "float x = aShape.x + aShape.y * y + aCorner.x * aShape.z;",
      "vBeam = vec2(aCorner.x, v);",
    ]) {
      expect(BEAM_VERTEX).toContain(line);
    }
    expect(BEAM_FRAGMENT).toContain("float v = clamp(vBeam.y, 0.0, 1.0);");
    expect(BEAM_FRAGMENT).toContain("vec3 c = uColor * (across * along * vIntensity);");
  });

  it("writes the instance in device px, with the slope unscaled", () => {
    const out = new Float32Array(6);
    writeBeamInstance(out, 0, beam({ slope: 0.5, intensity: 0.8 }), 2, 0.5);
    expect(Array.from(out)).toEqual([1000, 0.5, 200, 0, 2000, 0.4000000059604645]);
  });
});
