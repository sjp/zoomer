import { describe, expect, it } from "vitest";
import {
  clockText,
  dateText,
  formatStardate,
  LOCATION_HOLD,
  LOCATIONS,
  locationAt,
  shipStatus,
  stardate,
} from "./bridge-live";

describe("bridge live readouts", () => {
  it("counts 1000 stardate units a year from 2323", () => {
    expect(stardate(Date.UTC(2323, 0, 1))).toBe(0);
    expect(stardate(Date.UTC(2324, 0, 1))).toBe(1000);
    expect(stardate(Date.UTC(2364, 6, 2))).toBeCloseTo(41500, -1);
    // Today's date comes out negative, as the convention has it.
    expect(stardate(Date.UTC(2026, 10, 6, 12))).toBeCloseTo(-296152.05, 2);
  });

  it("only ever counts up, smoothly across a new year", () => {
    let prev = stardate(Date.UTC(2026, 11, 31, 23, 59));
    for (let m = 1; m < 5; m++) {
      const sd = stardate(Date.UTC(2026, 11, 31, 23, 59 + m));
      expect(sd).toBeGreaterThan(prev);
      expect(sd - prev).toBeLessThan(0.01);
      prev = sd;
    }
  });

  it("formats to one decimal place, rounding down", () => {
    expect(formatStardate(41153.79)).toBe("41153.7");
    expect(formatStardate(-296151.65)).toBe("-296151.7");
    expect(formatStardate(0)).toBe("0.0");
  });

  it("shows the local date as day, month and year", () => {
    expect(dateText(new Date(2026, 10, 6, 23, 59))).toBe("06 NOV 2026");
    expect(dateText(new Date(2027, 0, 1, 0, 0))).toBe("01 JAN 2027");
  });

  it("shows the local time as 24-hour HH:MM", () => {
    expect(clockText(new Date(2026, 10, 6, 9, 5))).toBe("09:05");
    expect(clockText(new Date(2026, 10, 6, 23, 59, 59))).toBe("23:59");
  });

  it("moves between the show's locations, holding each a while", () => {
    const t0 = Date.UTC(2026, 10, 6);
    const hold = LOCATION_HOLD * 1000;
    const seen = new Set<string>();
    let prev = "";
    for (let k = 0; k < LOCATIONS.length; k++) {
      const at = locationAt(t0 + k * hold, 12);
      expect(LOCATIONS).toContain(at);
      expect(at).not.toBe(prev);
      expect(locationAt(t0 + k * hold + hold - 1000, 12)).toBe(at);
      seen.add(at);
      prev = at;
    }
    expect(seen.size).toBe(LOCATIONS.length);
    expect(locationAt(t0, 12)).toBe(locationAt(t0, 12));
  });
  it("reports the alert, or what the outside view shows the ship doing", () => {
    expect(shipStatus("red", "planet")).toBe("RED ALERT");
    expect(shipStatus("yellow", "warp")).toBe("YELLOW ALERT");
    expect(shipStatus("normal", "planet")).toBe("STANDARD ORBIT");
    expect(shipStatus("normal", "warp")).toBe("WARP 6");
    expect(shipStatus("normal", "stars")).toBe("IMPULSE");
    expect(shipStatus("normal", "off")).toBe("STATION KEEPING");
  });
});
