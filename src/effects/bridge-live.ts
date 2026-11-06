/**
 * Starship Bridge live readouts: the band above the stations shows the real
 * stardate and local time, and where the ship is, beside its made-up numbers.
 * Pure, so they can be tested with fixed dates.
 */
import { hash32 } from "./noise";

/** The readouts the band shows, in the order they're laid out. */
export type LiveKey = "stardate" | "time" | "status" | "location";

/** Year the stardate convention counts from: 1000 units a year, 0 at its start. */
export const STARDATE_EPOCH_YEAR = 2323;

/**
 * The stardate for a moment, in the later-era convention: 1000 units per year,
 * counted from the start of 2323 (UTC), so earlier years are negative. Each unit
 * is about 8 h 46 min.
 */
export function stardate(ms: number): number {
  const year = new Date(ms).getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return 1000 * (year - STARDATE_EPOCH_YEAR) + (1000 * (ms - start)) / (end - start);
}

/** A stardate to one decimal place, rounded down so it only ever counts up. */
export function formatStardate(sd: number): string {
  return (Math.floor(sd * 10) / 10).toFixed(1);
}

/** Local time as 24-hour "HH:MM". */
export function clockText(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Places the ship can be, from the show's worlds. */
export const LOCATIONS = [
  "EARTH",
  "RISA",
  "QO'NOS",
  "VULCAN",
  "BAJOR",
  "BETAZED",
  "ROMULUS",
  "CARDASSIA PRIME",
  "FERENGINAR",
  "ANDORIA",
  "TRILL",
  "DEEP SPACE",
] as const;

/** Seconds the ship stays at one location before moving on. */
export const LOCATION_HOLD = 15 * 60;

/** Places to step through the list each hold: coprime with its length, so every place comes up. */
const LOCATION_STEP = 5;

/**
 * Where the ship is at a moment: it holds each location for `LOCATION_HOLD`
 * seconds, then jumps `LOCATION_STEP` places on through `LOCATIONS` from a
 * seeded start, so it visits all of them before any repeats and never stays put.
 * A pure function of the time, so it's the same on every load.
 */
export function locationAt(ms: number, seed: number): string {
  const slot = Math.floor(ms / 1000 / LOCATION_HOLD);
  const n = LOCATIONS.length;
  const start = hash32(Math.floor(seed)) % n;
  return LOCATIONS[(((start + slot * LOCATION_STEP) % n) + n) % n];
}

/**
 * The ship's status, from the `alert` and `exterior` params: the alert condition
 * when there is one, otherwise what the outside view shows the ship doing.
 */
export function shipStatus(alert: string, exterior: string): string {
  if (alert === "red") {
    return "RED ALERT";
  }
  if (alert === "yellow") {
    return "YELLOW ALERT";
  }
  if (exterior === "planet") {
    return "STANDARD ORBIT";
  }
  if (exterior === "warp") {
    return "WARP 6";
  }
  if (exterior === "stars") {
    return "IMPULSE";
  }
  return "STATION KEEPING";
}
