import { describe, expect, it } from "vitest";
import { LOCATIONS } from "./bridge-live";
import { planetStyle } from "./bridge-planets";

describe("bridge planets", () => {
  it("are deterministic, and vary a little between visits", () => {
    expect(planetStyle(1, 5, 12)).toEqual(planetStyle(1, 5, 12));
    const a = planetStyle(1, 5, 12);
    const b = planetStyle(1, 6, 12);
    expect(a).not.toEqual(b);
    // The same world stays recognisably itself.
    for (let i = 0; i < 3; i++) {
      expect(Math.abs((a.ocean[i] ?? 0) - (b.ocean[i] ?? 0))).toBeLessThan(0.12);
    }
  });

  it("match their world", () => {
    const at = (name: string) =>
      planetStyle(LOCATIONS.indexOf(name as (typeof LOCATIONS)[number]), 0, 12);
    const earth = at("EARTH");
    expect(earth.ocean[2]).toBeGreaterThan(earth.ocean[0]);
    const vulcan = at("VULCAN");
    expect(vulcan.landLow[0]).toBeGreaterThan(vulcan.landLow[2] * 2);
    const andoria = at("ANDORIA");
    expect(Math.min(...andoria.landHigh)).toBeGreaterThan(0.75);
  });

  it("keep every look in range", () => {
    let lo = Infinity;
    let hi = -Infinity;
    let radiusLo = Infinity;
    let radiusHi = -Infinity;
    let topHi = -Infinity;
    for (let loc = 0; loc < LOCATIONS.length; loc++) {
      for (let visit = 0; visit < 20; visit++) {
        const s = planetStyle(loc, visit, 7);
        for (const c of [s.ocean, s.landLow, s.landHigh, s.cloud, s.atmosphere]) {
          for (const x of c) {
            lo = Math.min(lo, x);
            hi = Math.max(hi, x);
          }
        }
        radiusLo = Math.min(radiusLo, s.radius);
        radiusHi = Math.max(radiusHi, s.radius);
        topHi = Math.max(topHi, s.top);
      }
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(radiusLo).toBeGreaterThan(0.85);
    expect(radiusHi).toBeLessThan(1.25);
    expect(topHi).toBeLessThan(-0.1);
  });
});
