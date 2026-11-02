import { describe, expect, it } from "vitest";
import {
  CLOCK_READ_INTERVAL,
  createMapClock,
  DEMO_RATE,
  latLonToPixel,
  latLonToVector,
  type LatLon,
  MAX_PINS,
  MAX_VISIBLE_LAT,
  millerLat,
  millerY,
  PIN_PRESETS,
  pixelToLatLon,
  radiansPerPixel,
  subsolarPoint,
  sublunarPoint,
  twilightLight,
  twilightRamps,
} from "./daymap-sim";

const utc = (iso: string) => Date.parse(iso);
/** Longitude difference in degrees, wrapped to [-180, 180]. */
const lonDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
/** Angle between two points on the globe, in degrees. */
const separation = (a: LatLon, b: LatLon) => {
  const va = latLonToVector(a, [0, 0, 0]);
  const vb = latLonToVector(b, [0, 0, 0]);
  const d = va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2];
  return (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI;
};

describe("subsolarPoint", () => {
  // Declinations from the published equinox and solstice instants; longitudes from
  // the equation of time: lon = (12 h - UT - EoT) * 15 degrees per hour.
  it.each([
    // March equinox 2024-03-20 03:06 UTC, EoT -7.5 min.
    ["2024-03-20T03:06:00Z", 0, (12 - 3.1 + 7.5 / 60) * 15],
    // June solstice 2024-06-20 20:51 UTC, EoT -1.6 min.
    ["2024-06-20T20:51:00Z", 23.44, (12 - 20.85 + 1.6 / 60) * 15],
    // September equinox 2024-09-22 12:44 UTC, EoT +7.3 min.
    ["2024-09-22T12:44:00Z", 0, (12 - (12 + 44 / 60) - 7.3 / 60) * 15],
    // December solstice 2024-12-21 09:20 UTC, EoT +1.9 min.
    ["2024-12-21T09:20:00Z", -23.44, (12 - (9 + 20 / 60) - 1.9 / 60) * 15],
    // The equation of time's extremes: +16.4 min on 3 November, -14.2 min on 11 February.
    ["2026-11-03T12:00:00Z", -15.1, (-16.4 / 60) * 15],
    ["2026-02-11T12:00:00Z", -14.0, (14.2 / 60) * 15],
  ])("matches the reference at %s", (iso, lat, lon) => {
    const p = subsolarPoint(utc(iso));
    expect(Math.abs(p.lat - lat)).toBeLessThan(0.35);
    expect(Math.abs(lonDiff(p.lon, lon))).toBeLessThan(0.3);
  });

  it("moves west by 15 degrees an hour", () => {
    const t = utc("2026-05-01T00:00:00Z");
    const a = subsolarPoint(t);
    const b = subsolarPoint(t + 3600000);
    expect(lonDiff(a.lon, b.lon)).toBeCloseTo(15, 1);
  });

  it("writes into the given object and keeps longitude in [-180, 180)", () => {
    const out = { lat: 0, lon: 0 };
    for (let h = 0; h < 48; h++) {
      expect(subsolarPoint(utc("2026-01-01T00:00:00Z") + h * 1800000, out)).toBe(out);
      expect(out.lon).toBeGreaterThanOrEqual(-180);
      expect(out.lon).toBeLessThan(180);
    }
  });
});

describe("sublunarPoint", () => {
  it("is opposite the sun at a lunar eclipse and beside it at a solar eclipse", () => {
    // Partial lunar eclipse, maximum 2024-09-18 02:44 UTC.
    const full = utc("2024-09-18T02:44:00Z");
    expect(separation(sublunarPoint(full), subsolarPoint(full))).toBeGreaterThan(178);
    // Total solar eclipse, maximum 2024-04-08 18:17 UTC.
    const fresh = utc("2024-04-08T18:17:00Z");
    expect(separation(sublunarPoint(fresh), subsolarPoint(fresh))).toBeLessThan(2);
  });

  it("stays within the moon's declination range", () => {
    for (let d = 0; d < 400; d += 3.7) {
      const p = sublunarPoint(utc("2026-01-01T00:00:00Z") + d * 86400000);
      expect(Math.abs(p.lat)).toBeLessThan(29);
    }
  });
});

describe("projection", () => {
  it("inverts Miller's y", () => {
    for (let lat = -88; lat <= 88; lat += 4) {
      const r = (lat * Math.PI) / 180;
      expect(millerLat(millerY(r))).toBeCloseTo(r, 12);
    }
  });

  it("spans 360 degrees across a 16:9 frame and crops a tall one", () => {
    expect(radiansPerPixel(1920, 1080)).toBeCloseTo((2 * Math.PI) / 1920, 12);
    const top = pixelToLatLon(0, 0, 1920, 1080, 0);
    expect(top.lat).toBeGreaterThan(75);
    expect(top.lat).toBeLessThan(MAX_VISIBLE_LAT);
    const tall = pixelToLatLon(0, 0, 1080, 1080, 0);
    expect(tall.lat).toBeCloseTo(MAX_VISIBLE_LAT, 6);
    expect(tall.lon).toBeGreaterThan(-180);
  });

  it.each([0, 37.5, -150, 180])("round-trips pixels and lat/lon with centre %s", (centre) => {
    const ll = { lat: 0, lon: 0 };
    const px: [number, number] = [0, 0];
    for (const [w, h] of [
      [1920, 1080],
      [3840, 2160],
      [900, 1200],
    ]) {
      for (let x = 1; x < w; x += w / 7) {
        for (let y = 1; y < h; y += h / 5) {
          pixelToLatLon(x, y, w, h, centre, ll);
          expect(ll.lon).toBeGreaterThanOrEqual(-180);
          expect(ll.lon).toBeLessThan(180);
          latLonToPixel(ll, w, h, centre, px);
          expect(px[0]).toBeCloseTo(x, 6);
          expect(px[1]).toBeCloseTo(y, 6);
        }
      }
    }
  });

  it("puts the centre longitude and the equator in the middle", () => {
    const px = latLonToPixel({ lat: 0, lon: 120 }, 1920, 1080, 120, [0, 0]);
    expect(px[0]).toBeCloseTo(960, 9);
    expect(px[1]).toBeCloseTo(540, 9);
    // East of the centre is to the right, north is up.
    latLonToPixel({ lat: 10, lon: 130 }, 1920, 1080, 120, px);
    expect(px[0]).toBeGreaterThan(960);
    expect(px[1]).toBeLessThan(540);
  });
});

describe("twilight shading", () => {
  const lo = new Float32Array(4);
  const hi = new Float32Array(4);
  const sinDeg = (d: number) => Math.sin((d * Math.PI) / 180);

  it.each(["smooth", "bands"] as const)("is monotonic in solar elevation (%s)", (mode) => {
    twilightRamps(mode, lo, hi);
    let prev = -1;
    for (let e = -90; e <= 90; e += 0.05) {
      const l = twilightLight(sinDeg(e), lo, hi);
      expect(l).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(1 + 1e-6);
      prev = l;
    }
    expect(twilightLight(sinDeg(-30), lo, hi)).toBe(0);
    expect(twilightLight(sinDeg(30), lo, hi)).toBeCloseTo(1, 6);
  });

  it("holds a flat level inside each band in bands mode", () => {
    twilightRamps("bands", lo, hi);
    for (const [a, b] of [
      [-17.5, -12.5],
      [-11.5, -6.5],
      [-5.5, -0.5],
      [0.5, 20],
    ]) {
      expect(twilightLight(sinDeg(a), lo, hi)).toBeCloseTo(twilightLight(sinDeg(b), lo, hi), 6);
    }
    expect(twilightLight(sinDeg(-1), lo, hi)).toBeLessThan(twilightLight(sinDeg(1), lo, hi));
  });
});

describe("createMapClock", () => {
  it("reads the wall clock about once a second and advances with dt in between", () => {
    let wall = 1000000;
    let reads = 0;
    const clock = createMapClock(() => {
      reads++;
      return wall;
    });
    expect(clock.ms).toBe(1000000);
    wall = 5000000;
    clock.step(0.25, false);
    expect(clock.ms).toBe(1000250);
    for (let t = 0.25; t < CLOCK_READ_INTERVAL; t += 0.25) clock.step(0.25, false);
    expect(clock.ms).toBe(5000000);
    expect(reads).toBe(2);
  });

  it("runs DEMO_RATE times faster in demo mode and snaps back afterwards", () => {
    const clock = createMapClock(() => 0);
    clock.step(2, true);
    expect(clock.ms).toBe(2000 * DEMO_RATE);
    clock.step(0.01, false);
    expect(clock.ms).toBe(0);
  });
});

describe("PIN_PRESETS", () => {
  it("has at most MAX_PINS valid cities per preset", () => {
    for (const cities of Object.values(PIN_PRESETS)) {
      expect(cities.length).toBeLessThanOrEqual(MAX_PINS);
      for (const c of cities) {
        expect(Math.abs(c.lat)).toBeLessThan(MAX_VISIBLE_LAT);
        // Throws on an unknown zone.
        expect(() => new Intl.DateTimeFormat("en-GB", { timeZone: c.zone })).not.toThrow();
      }
    }
  });
});
