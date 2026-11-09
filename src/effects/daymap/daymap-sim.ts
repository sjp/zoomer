/**
 * Pure JS logic for the daylight world map (daymap.ts): the wall clock and demo
 * clock, the subsolar and sublunar points, the map projection, the twilight
 * shading ramp and the pin presets. Nothing here touches GL, so it is all unit
 * tested.
 */
import { clamp, wrap } from "../math";

const DEG = Math.PI / 180;
const MS_PER_DAY = 86400000;
/** Julian day of the Unix epoch. */
const JD_UNIX_EPOCH = 2440587.5;
/** Julian day of J2000.0 (2000-01-01 12:00 TT, taken as UT here). */
const JD_J2000 = 2451545;

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** Seconds between reads of the wall clock in real-time mode. */
export const CLOCK_READ_INTERVAL = 1;
/** Simulated seconds per real second in demo mode: one day a minute. */
export const DEMO_RATE = 1440;

/** Seconds leaving demo mode takes to ease back to the wall clock. */
export const DEMO_EASE = 4;

interface MapClock {
  /** The current simulated time, in Unix milliseconds (unwrapped, float64). */
  readonly ms: number;
  /**
   * Advances by `dt` real seconds and returns the new time. In real time the wall
   * clock is read about once a second and the time advances with `dt` in between;
   * demo mode runs `DEMO_RATE` times faster from wherever it is. Leaving demo mode
   * eases back to the wall clock over `DEMO_EASE` seconds (see `easeOffset`).
   */
  step: (dt: number, demo: boolean) => number;
}

/**
 * How far from the wall clock (ms) the map shows, a fraction `f` (0..1) of the
 * way back from `offset`. The time of day (the offset's part within ±12 hours)
 * unwinds smoothly, at most half a turn of the terminator; whole days unwind in
 * whole days, so the date walks back through the seasons without spinning the
 * Earth round once per day of offset.
 */
export function easeOffset(offset: number, f: number): number {
  const days = Math.round(offset / MS_PER_DAY);
  const rest = offset - days * MS_PER_DAY;
  const left = days * (1 - f);
  return Math.sign(left) * Math.round(Math.abs(left)) * MS_PER_DAY + rest * (1 - f);
}

export function createMapClock(now: () => number = () => Date.now()): MapClock {
  let ms = now();
  let sinceRead = 0;
  let lastDemo = false;
  /** The offset from the wall clock when demo mode was left, and the ease's progress (1: done). */
  let offset = 0;
  let eased = 1;
  return {
    get ms() {
      return ms;
    },
    step(dt, demo) {
      if (demo) {
        ms += dt * 1000 * DEMO_RATE;
        eased = 1;
      } else if (lastDemo || eased < 1) {
        // Easing back from demo time: read the wall clock every frame.
        const wall = now();
        if (lastDemo) {
          offset = ms - wall;
          eased = 0;
        }
        eased = Math.min(1, eased + Math.max(0, dt) / DEMO_EASE);
        const f = eased * eased * (3 - 2 * eased);
        ms = wall + easeOffset(offset, f);
        sinceRead = 0;
      } else {
        sinceRead += dt;
        if (sinceRead >= CLOCK_READ_INTERVAL) {
          sinceRead = 0;
          ms = now();
        } else {
          ms += dt * 1000;
        }
      }
      lastDemo = demo;
      return ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Sun and moon
// ---------------------------------------------------------------------------

/** A point on the globe, in degrees: latitude -90..90, longitude -180..180 (east positive). */
export interface LatLon {
  lat: number;
  lon: number;
}

export const createLatLon = (): LatLon => ({ lat: 0, lon: 0 });

/** Days since J2000.0 for a Unix time in milliseconds. */
const daysSinceJ2000 = (ms: number) => ms / MS_PER_DAY + JD_UNIX_EPOCH - JD_J2000;

/** Greenwich mean sidereal time in degrees, for `n` days since J2000.0. */
const gmstDeg = (n: number) => 280.46061837 + 360.98564736629 * n;

/**
 * The point on the globe directly below a body at ecliptic longitude `lambda` and
 * latitude `beta` (degrees), `n` days since J2000.0, written into `out`.
 */
function subPoint(n: number, lambda: number, beta: number, out: LatLon): LatLon {
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const l = lambda * DEG;
  const b = beta * DEG;
  const sl = Math.sin(l);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const ce = Math.cos(eps);
  const se = Math.sin(eps);
  // atan2(sin(l) cos(eps) - tan(b) sin(eps), cos(l)), both terms scaled by cos(b) > 0.
  const ra = Math.atan2(sl * ce * cb - sb * se, Math.cos(l) * cb);
  const dec = Math.asin(clamp(sb * ce + cb * se * sl, -1, 1));
  out.lat = dec / DEG;
  out.lon = wrap(ra / DEG - gmstDeg(n), -180, 360);
  return out;
}

/**
 * The subsolar point at Unix time `ms`, from the Astronomical Almanac's
 * low-precision solar coordinates (good to about 0.01 degrees from 1950 to 2050).
 * Right ascension minus sidereal time includes the equation of time.
 */
export function subsolarPoint(ms: number, out: LatLon = createLatLon()): LatLon {
  const n = daysSinceJ2000(ms);
  const L = 280.46 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
  return subPoint(n, lambda, 0, out);
}

/**
 * The sublunar point at Unix time `ms`, from the Astronomical Almanac's
 * low-precision lunar coordinates (geocentric, so ignoring the up to one degree of
 * parallax an observer sees; good to a few tenths of a degree otherwise).
 */
export function sublunarPoint(ms: number, out: LatLon = createLatLon()): LatLon {
  const n = daysSinceJ2000(ms);
  const T = n / 36525;
  const s = (a: number, b: number) => Math.sin((a + b * T) * DEG);
  const lambda =
    218.32 +
    481267.881 * T +
    6.29 * s(134.9, 477198.85) -
    1.27 * s(259.2, -413335.38) +
    0.66 * s(235.7, 890534.23) +
    0.21 * s(269.9, 954397.7) -
    0.19 * s(357.5, 35999.05) -
    0.11 * s(186.6, 966404.05);
  const beta =
    5.13 * s(93.3, 483202.03) +
    0.28 * s(228.2, 960400.87) -
    0.28 * s(318.3, 6003.18) -
    0.17 * s(217.6, -407332.2);
  return subPoint(n, lambda, beta, out);
}

/**
 * The unit vector of a point on the globe, in the Earth-fixed frame the shader
 * uses: x towards (0, 0), y towards (0, 90E), z towards the north pole.
 */
export function latLonToVector(p: LatLon, out: [number, number, number]): [number, number, number] {
  const cl = Math.cos(p.lat * DEG);
  out[0] = cl * Math.cos(p.lon * DEG);
  out[1] = cl * Math.sin(p.lon * DEG);
  out[2] = Math.sin(p.lat * DEG);
  return out;
}

// ---------------------------------------------------------------------------
// Projection (Miller cylindrical)
// ---------------------------------------------------------------------------

/** Miller y (radians of map width) of a latitude in radians. */
export const millerY = (lat: number) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * lat));
/** Latitude in radians of a Miller y. The shader's twin is in daymap.ts. */
export const millerLat = (y: number) => 2.5 * Math.atan(Math.exp(0.8 * y)) - 0.625 * Math.PI;

/** Highest latitude the map is ever cropped to vertically, in degrees. */
export const MAX_VISIBLE_LAT = 85;
const MAX_Y = millerY(MAX_VISIBLE_LAT * DEG);

/**
 * Radians of longitude per device pixel. The map spans exactly 360 degrees across
 * the width unless that would show latitudes past `MAX_VISIBLE_LAT` (a tall
 * canvas), in which case it fills the height and crops longitude instead. At 16:9
 * the full width shows latitudes to about 78 degrees.
 */
export const radiansPerPixel = (width: number, height: number) =>
  Math.min((2 * Math.PI) / Math.max(1, width), (2 * MAX_Y) / Math.max(1, height));

/**
 * Pixel (origin top-left, y down) to latitude and longitude in degrees for a map
 * centred on longitude `centre`. Longitude wraps to [-180, 180).
 */
export function pixelToLatLon(
  x: number,
  y: number,
  width: number,
  height: number,
  centre: number,
  out: LatLon = createLatLon(),
): LatLon {
  const k = radiansPerPixel(width, height);
  out.lon = wrap(centre + ((x - 0.5 * width) * k) / DEG, -180, 360);
  out.lat = millerLat((0.5 * height - y) * k) / DEG;
  return out;
}

/**
 * Latitude and longitude in degrees to a pixel (origin top-left, y down), choosing
 * the copy of the longitude nearest the centre, written into `out` as [x, y].
 */
export function latLonToPixel(
  p: LatLon,
  width: number,
  height: number,
  centre: number,
  out: [number, number],
): [number, number] {
  const k = radiansPerPixel(width, height);
  out[0] = 0.5 * width + (wrap(p.lon - centre, -180, 360) * DEG) / k;
  out[1] = 0.5 * height - millerY(p.lat * DEG) / k;
  return out;
}

// ---------------------------------------------------------------------------
// Twilight
// ---------------------------------------------------------------------------

/**
 * Solar elevations (degrees) bounding the shading segments: astronomical,
 * nautical and civil twilight, then the low sun. Each segment adds its weight in
 * `TWILIGHT_WEIGHTS` to the light level.
 */
const TWILIGHT_KNOTS = [-18, -12, -6, 0, 8] as const;
export const TWILIGHT_WEIGHTS = [0.06, 0.12, 0.32, 0.5] as const;
/** Half-width of a band edge in "Bands" mode, in units of sin(elevation) (about 0.15 degrees). */
const BAND_EDGE = 0.0026;

type TwilightMode = "smooth" | "bands";

/**
 * The segment ramps for the shader, in sin(elevation): segment i ramps from
 * `lo[i]` to `hi[i]`. "Smooth" ramps linearly across each segment; "Bands" steps
 * at each segment's lower knot, so each twilight band has a flat level.
 */
export function twilightRamps(
  mode: TwilightMode,
  lo: Float32Array | number[],
  hi: Float32Array | number[],
): void {
  for (let i = 0; i < 4; i++) {
    const a = Math.sin(TWILIGHT_KNOTS[i] * DEG);
    if (mode === "bands") {
      lo[i] = a - BAND_EDGE;
      hi[i] = a + BAND_EDGE;
    } else {
      lo[i] = a;
      hi[i] = Math.sin(TWILIGHT_KNOTS[i + 1] * DEG);
    }
  }
}

/**
 * Light level in [0, 1] for a sun at sin(elevation) `s`: the shader's
 * `dot(clamp((s - lo) / (hi - lo), 0, 1), weights)`.
 */
export function twilightLight(s: number, lo: ArrayLike<number>, hi: ArrayLike<number>): number {
  let l = 0;
  for (let i = 0; i < 4; i++) {
    l += TWILIGHT_WEIGHTS[i] * clamp((s - lo[i]) / (hi[i] - lo[i]), 0, 1);
  }
  return l;
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

interface City extends LatLon {
  name: string;
  /** IANA time zone, for the local-time label. */
  zone: string;
}

const city = (name: string, lat: number, lon: number, zone: string): City => ({
  name,
  lat,
  lon,
  zone,
});

const SAN_FRANCISCO = city("San Francisco", 37.77, -122.42, "America/Los_Angeles");
const CHICAGO = city("Chicago", 41.88, -87.63, "America/Chicago");
const NEW_YORK = city("New York", 40.71, -74.01, "America/New_York");
const SAO_PAULO = city("São Paulo", -23.55, -46.63, "America/Sao_Paulo");
const LONDON = city("London", 51.51, -0.13, "Europe/London");
const BERLIN = city("Berlin", 52.52, 13.4, "Europe/Berlin");
const DUBAI = city("Dubai", 25.2, 55.27, "Asia/Dubai");
const MUMBAI = city("Mumbai", 19.08, 72.88, "Asia/Kolkata");
const SINGAPORE = city("Singapore", 1.35, 103.82, "Asia/Singapore");
const TOKYO = city("Tokyo", 35.68, 139.69, "Asia/Tokyo");
const SYDNEY = city("Sydney", -33.87, 151.21, "Australia/Sydney");

/** Most pins any preset shows. */
export const MAX_PINS = 4;

export const PIN_PRESETS: Record<string, readonly City[]> = {
  none: [],
  world: [SAN_FRANCISCO, NEW_YORK, LONDON, TOKYO],
  americas: [SAN_FRANCISCO, CHICAGO, NEW_YORK, SAO_PAULO],
  atlantic: [NEW_YORK, SAO_PAULO, LONDON, BERLIN],
  asia: [DUBAI, MUMBAI, SINGAPORE, SYDNEY],
};
