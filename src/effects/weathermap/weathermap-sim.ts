/**
 * The Weather Forecast Map's made-up weather: each region's projection and
 * cities, a handful of drifting high and low pressure centres with fronts
 * trailing from the lows, the pressure and rain they make at any point, and the
 * day-by-day forecast for the cities (icons and temperatures) read from them.
 *
 * Everything is in design units: the map as framed at 16:9, x from 0 to
 * `DESIGN_ASPECT` rightwards and y from 0 to 1 downwards, so one unit is the
 * frame's height at 16:9. Time is forecast time in days, which runs one day per
 * `pace` seconds, so the weather moves the same distance each day at any pace.
 */
import { clamp, smoothstep } from "../math";
import { hash32 } from "../noise";
import type { RegionId, SeasonId } from "./weathermap.meta";

/** The aspect ratio the map is framed at. */
export const DESIGN_ASPECT = 16 / 9;
const DEG = Math.PI / 180;

interface City {
  name: string;
  lat: number;
  lon: number;
  /** Puts the temperature box on the icon's left rather than its right. */
  left?: boolean;
}

interface Region {
  /** Map centre, in degrees. */
  lon: number;
  lat: number;
  /** Degrees of latitude the frame's height spans at 16:9. */
  span: number;
  /** Southern hemisphere: fronts trail north of their lows, and it's colder to the south. */
  south: boolean;
  /** Typical daytime high at the map centre in each season, in °C. */
  climate: Readonly<Record<SeasonId, number>>;
  cities: readonly City[];
}

/**
 * The regions. City positions are where their icons sit: a few coastal cities
 * are nudged a little inland, so the icon is over land on the coarse land mask.
 */
export const REGIONS: Readonly<Record<RegionId, Region>> = {
  british: {
    lon: -3.4,
    lat: 54.4,
    span: 10.5,
    south: false,
    climate: { spring: 12, summer: 20, autumn: 13, winter: 6 },
    cities: [
      { name: "London", lat: 51.51, lon: -0.13 },
      { name: "Plymouth", lat: 50.45, lon: -4.0, left: true },
      { name: "Manchester", lat: 53.48, lon: -2.24 },
      { name: "Newcastle", lat: 54.98, lon: -1.75 },
      { name: "Belfast", lat: 54.55, lon: -6.1, left: true },
      { name: "Cork", lat: 51.95, lon: -8.6, left: true },
      { name: "Glasgow", lat: 55.87, lon: -4.3, left: true },
      { name: "Aberdeen", lat: 57.25, lon: -2.4 },
    ],
  },
  europe: {
    lon: 4,
    lat: 46.6,
    span: 20,
    south: false,
    climate: { spring: 16, summer: 26, autumn: 16, winter: 7 },
    cities: [
      { name: "London", lat: 51.51, lon: -0.13, left: true },
      { name: "Paris", lat: 48.86, lon: 2.35 },
      { name: "Amsterdam", lat: 52.3, lon: 5.1 },
      { name: "Berlin", lat: 52.52, lon: 13.4 },
      { name: "Munich", lat: 48.14, lon: 11.58 },
      { name: "Madrid", lat: 40.42, lon: -3.7 },
      { name: "Lisbon", lat: 38.9, lon: -8.9, left: true },
      { name: "Rome", lat: 42.0, lon: 12.6 },
    ],
  },
  america: {
    lon: -97,
    lat: 38.5,
    span: 30,
    south: false,
    climate: { spring: 18, summer: 30, autumn: 18, winter: 6 },
    cities: [
      { name: "Seattle", lat: 47.6, lon: -122.0 },
      { name: "Los Angeles", lat: 34.2, lon: -118.0 },
      { name: "Denver", lat: 39.74, lon: -104.99 },
      { name: "Dallas", lat: 32.78, lon: -96.8 },
      { name: "Chicago", lat: 41.88, lon: -87.63 },
      { name: "Atlanta", lat: 33.75, lon: -84.39 },
      { name: "New York", lat: 41.0, lon: -74.3 },
      { name: "Miami", lat: 26.6, lon: -80.9 },
    ],
  },
  australia: {
    lon: 134,
    lat: -27.5,
    span: 36,
    south: true,
    climate: { spring: 25, summer: 31, autumn: 25, winter: 18 },
    cities: [
      { name: "Perth", lat: -31.95, lon: 116.1 },
      { name: "Broome", lat: -18.1, lon: 122.5 },
      { name: "Darwin", lat: -12.7, lon: 131.1 },
      { name: "Alice Springs", lat: -23.7, lon: 133.88 },
      { name: "Melbourne", lat: -37.6, lon: 145.0, left: true },
      { name: "Sydney", lat: -33.8, lon: 150.9 },
      { name: "Brisbane", lat: -27.47, lon: 152.8 },
      { name: "Cairns", lat: -17.2, lon: 145.5 },
    ],
  },
  japan: {
    lon: 136.5,
    lat: 37.4,
    span: 15,
    south: false,
    climate: { spring: 18, summer: 30, autumn: 20, winter: 9 },
    cities: [
      { name: "Sapporo", lat: 43.06, lon: 141.35 },
      { name: "Sendai", lat: 38.27, lon: 140.7 },
      { name: "Kanazawa", lat: 36.56, lon: 136.75, left: true },
      { name: "Tokyo", lat: 35.75, lon: 139.6 },
      { name: "Osaka", lat: 34.7, lon: 135.6, left: true },
      { name: "Fukuoka", lat: 33.55, lon: 130.55, left: true },
      { name: "Kagoshima", lat: 31.68, lon: 130.7, left: true },
    ],
  },
};

/** Projects `lat`, `lon` (degrees) onto the region's design frame: equirectangular, stretched by cos(centre latitude). */
export function project(region: Region, lat: number, lon: number, out: number[]): number[] {
  out[0] = DESIGN_ASPECT / 2 + ((lon - region.lon) * Math.cos(region.lat * DEG)) / region.span;
  out[1] = 0.5 - (lat - region.lat) / region.span;
  return out;
}

/**
 * The part of the design frame a `width` x `height` canvas shows, as its left
 * and top edges and design units per pixel: the full height at 16:9 and wider
 * (wider frames show more at the sides), the full width when narrower (more
 * above and below).
 */
export function viewWindow(width: number, height: number, out: number[]): number[] {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const u = Math.max(1 / h, DESIGN_ASPECT / w);
  out[0] = DESIGN_ASPECT / 2 - (w * u) / 2;
  out[1] = 0.5 - (h * u) / 2;
  out[2] = u;
  return out;
}

// ---------------------------------------------------------------------------
// Pressure systems and fronts
// ---------------------------------------------------------------------------

/** Pressure centres in the domain at once. */
export const SYSTEM_COUNT = 5;
/** The systems drift east through this span of x and wrap round; wider than any frame up to 21:9 shows. */
const DOMAIN_MIN = -0.7;
const DOMAIN_SPAN = DESIGN_ASPECT + 1.4;
/** Width at each end of the domain over which a system fades out and in as it wraps. */
const DOMAIN_EDGE = 0.45;
/** Eastward drift, in design units per day. */
export const DRIFT_PER_DAY = 0.1;
/** Pressure with no systems, in hPa. */
export const BASE_PRESSURE = 1013;
/** Isobar spacing, in hPa. */
export const ISOBAR_STEP = 4;
/** The pressure range the field encodes, in hPa. */
export const PRESSURE_MIN = 940;
export const PRESSURE_RANGE = 120;

type FrontKind = 0 | 1 | 2;
/** Front kinds: cold (triangles), warm (semicircles) and occluded (both, alternating). */
export const COLD: FrontKind = 0;
export const WARM: FrontKind = 1;
export const OCCLUDED: FrontKind = 2;

/** Points along each front: a quadratic Bézier sampled as a polyline. */
export const FRONT_POINTS = 9;
const MAX_FRONTS = SYSTEM_COUNT * 3;
/** How much a front deepens the pressure along it (hPa per design unit), and over what distance. */
export const TROUGH_SLOPE = 24;
export const TROUGH_REACH = 0.1;
/** Softens the trough's V right on the front, in design units. */
export const TROUGH_SOFT = 0.012;
/** Rain band half-widths (design units) and peak strengths by front kind. */
export const RAIN_WIDTH: readonly number[] = [0.05, 0.085, 0.07];
export const RAIN_PEAK: readonly number[] = [0.95, 0.72, 0.82];
/** Rain round a low's centre: radius as a fraction of the low's, and peak. */
export const LOW_RAIN_RADIUS = 0.45;
export const LOW_RAIN_PEAK = 0.7;
/** Floats per system in `WeatherState.systems`: x, y, signed amplitude (hPa), quadratic form a, b, c, radius. */
export const SYSTEM_STRIDE = 7;

/** The weather at one forecast time. Filled by `evaluate`, allocation-free. */
interface WeatherState {
  /** `SYSTEM_STRIDE` floats per system. */
  systems: Float64Array;
  /** Fronts, `FRONT_POINTS` (x, y) points each. */
  points: Float64Array;
  kinds: Uint8Array;
  /** Each front's opacity, 0..1: fronts fade with their low. */
  alpha: Float64Array;
  /** Each front's warm-sector point: the warm air the cold front pushes into and the warm front leaves behind. */
  warmSector: Float64Array;
  /** Each front's direction of travel, which its symbols face. */
  motion: Float64Array;
  frontCount: number;
}

export function createWeatherState(): WeatherState {
  return {
    systems: new Float64Array(SYSTEM_COUNT * SYSTEM_STRIDE),
    points: new Float64Array(MAX_FRONTS * FRONT_POINTS * 2),
    kinds: new Uint8Array(MAX_FRONTS),
    alpha: new Float64Array(MAX_FRONTS),
    warmSector: new Float64Array(MAX_FRONTS * 2),
    motion: new Float64Array(MAX_FRONTS * 2),
    frontCount: 0,
  };
}

export interface Forecast {
  readonly region: Region;
  readonly south: boolean;
  readonly seed: number;
  /** Scratch state for `forecastDay`. */
  readonly scratch: WeatherState;
}

export function createForecast(region: RegionId, seed: number): Forecast {
  const r = REGIONS[region];
  return { region: r, south: r.south, seed: seed >>> 0, scratch: createWeatherState() };
}

/** A uniform 0..1 value from the seed and up to three integers. */
function rand(seed: number, a: number, b: number, c: number): number {
  return (
    hash32((seed ^ hash32((a * 7919 + hash32((b * 104729 + c) >>> 0)) >>> 0)) >>> 0) / 4294967296
  );
}

/**
 * Front layouts trailing from a low, in its frame (x east, y towards the
 * equator, in units of the front scale): start, control and end points.
 */
const OCCLUSION = [0.05, 0.05, 0.3, 0.12, 0.42, 0.38] as const;
const WARM_FROM_TRIPLE = [0.45, -0.02, 0.9, 0.3] as const;
const COLD_FROM_TRIPLE = [0.05, 0.55, -0.45, 1.05] as const;
/** The triple point (where warm and cold fronts meet) without an occlusion. */
const TRIPLE_POINT = [0.12, 0.12] as const;
const WARM_SECTOR = [0.35, 0.45] as const;
/** Directions of travel, as above: cold fronts sweep east and equatorwards, warm fronts and occlusions east and polewards. */
const MOTION: readonly (readonly [number, number])[] = [
  [1, 0.5],
  [1, -0.8],
  [1, -0.5],
];

/** Fronts per low by its front type: none, cold only, warm and cold, or an occlusion with both. */
const FRONT_TYPE_ODDS = [0.15, 0.35, 0.65] as const;

/**
 * Scratch for `evaluate`: the front frame of the low being laid out (its
 * centre, scale, turn cos and sin, and 1 or -1 for the hemisphere), and its
 * warm-sector point.
 */
const FRAME = new Float64Array(6);
const WARM_POINT = new Float64Array(2);

/** Writes front-frame point (u, v) in design units to `out[o]`, `out[o + 1]`. */
function framePoint(u: number, v: number, out: Float64Array, o: number) {
  const scale = FRAME[2];
  const tc = FRAME[3];
  const ts = FRAME[4];
  const my = FRAME[5];
  out[o] = FRAME[0] + scale * (tc * u - ts * v * my);
  out[o + 1] = FRAME[1] + scale * (ts * u + tc * v * my);
}

/** Writes front `f`, a quadratic Bézier in the front frame, into `state`. */
function addFront(
  state: WeatherState,
  f: number,
  kind: FrontKind,
  alpha: number,
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
) {
  state.kinds[f] = kind;
  state.alpha[f] = alpha;
  state.warmSector[2 * f] = WARM_POINT[0];
  state.warmSector[2 * f + 1] = WARM_POINT[1];
  const m = MOTION[kind];
  const tc = FRAME[3];
  const ts = FRAME[4];
  const my = FRAME[5];
  const mx = tc * m[0] - ts * m[1] * my;
  const mz = ts * m[0] + tc * m[1] * my;
  const ml = Math.hypot(mx, mz);
  state.motion[2 * f] = mx / ml;
  state.motion[2 * f + 1] = mz / ml;
  const p = f * FRONT_POINTS * 2;
  for (let j = 0; j < FRONT_POINTS; j++) {
    const t = j / (FRONT_POINTS - 1);
    const a = (1 - t) * (1 - t);
    const b = 2 * t * (1 - t);
    const c = t * t;
    framePoint(a * x0 + b * cx + c * x1, a * y0 + b * cy + c * y1, state.points, p + 2 * j);
  }
}

/**
 * Fills `state` with the weather `tau` days into the forecast. Each system
 * drifts east and wraps round the domain, fading out and in at its ends and
 * taking new random properties each time round.
 */
export function evaluate(forecast: Forecast, tau: number, state: WeatherState): WeatherState {
  const { seed, south } = forecast;
  const my = south ? -1 : 1;
  let fronts = 0;
  for (let i = 0; i < SYSTEM_COUNT; i++) {
    const start = ((i + 0.3 * rand(seed, i, 0, 99)) * DOMAIN_SPAN) / SYSTEM_COUNT;
    const raw = start + DRIFT_PER_DAY * (1 + 0.08 * (rand(seed, i, 0, 98) - 0.5)) * tau;
    const gen = Math.floor(raw / DOMAIN_SPAN);
    const xr = raw - gen * DOMAIN_SPAN;
    const env = smoothstep(0, DOMAIN_EDGE, xr) * smoothstep(0, DOMAIN_EDGE, DOMAIN_SPAN - xr);
    // Alternate highs and lows round the domain, with a few swapped for variety.
    const low = (i + gen) % 2 === 0 ? rand(seed, i, gen, 1) < 0.8 : rand(seed, i, gen, 1) < 0.25;
    const strength = low ? 16 + 12 * rand(seed, i, gen, 2) : 9 + 8 * rand(seed, i, gen, 2);
    // Each system deepens and fills over a few days; at its weakest (life 0.1,
    // too weak for fronts) its fronts take new random properties.
    const phase = tau / (4 + 2 * rand(seed, i, gen, 3)) + rand(seed, i, gen, 4);
    const life = 0.55 + 0.45 * Math.sin(2 * Math.PI * phase);
    const lifeKey = gen * 4096 + Math.floor(phase + 0.25);
    const radius = low ? 0.24 + 0.12 * rand(seed, i, gen, 5) : 0.42 + 0.2 * rand(seed, i, gen, 5);
    const stretch = 1 + 0.6 * rand(seed, i, gen, 6);
    const angle = (rand(seed, i, gen, 7) - 0.5) * 1.2;
    // Lows keep to the poleward half, highs anywhere.
    const yBase = low ? 0.05 + 0.5 * rand(seed, i, gen, 8) : 0.15 + 0.75 * rand(seed, i, gen, 8);
    const wobble =
      0.05 *
      Math.sin(
        (2 * Math.PI * tau) / (6 + 3 * rand(seed, i, gen, 9)) + 6.283 * rand(seed, i, gen, 10),
      );
    const x = DOMAIN_MIN + xr;
    const y = south ? 1 - yBase - wobble : yBase + wobble;
    const amp = (low ? -1 : 1) * strength * life * env;
    const rx = radius * stretch;
    const ry = radius / stretch;
    const cs = Math.cos(angle);
    const sn = Math.sin(angle);
    const o = i * SYSTEM_STRIDE;
    const s = state.systems;
    s[o] = x;
    s[o + 1] = y;
    s[o + 2] = amp;
    s[o + 3] = (cs * cs) / (rx * rx) + (sn * sn) / (ry * ry);
    s[o + 4] = cs * sn * (1 / (rx * rx) - 1 / (ry * ry));
    s[o + 5] = (sn * sn) / (rx * rx) + (cs * cs) / (ry * ry);
    s[o + 6] = radius;

    if (!low) {
      continue;
    }
    const type = rand(seed, i, lifeKey, 11);
    if (type < FRONT_TYPE_ODDS[0]) {
      continue;
    }
    const alpha = env * smoothstep(8, 13, strength * life);
    const turn = (rand(seed, i, lifeKey, 13) - 0.5) * 0.5;
    FRAME[0] = x;
    FRAME[1] = y;
    FRAME[2] = radius * (1.5 + 0.4 * rand(seed, i, lifeKey, 12));
    FRAME[3] = Math.cos(turn);
    FRAME[4] = Math.sin(turn);
    FRAME[5] = my;
    const occluded = type >= FRONT_TYPE_ODDS[2];
    const tx = occluded ? OCCLUSION[4] : TRIPLE_POINT[0];
    const ty = occluded ? OCCLUSION[5] : TRIPLE_POINT[1];
    framePoint(tx + WARM_SECTOR[0], ty + WARM_SECTOR[1], WARM_POINT, 0);
    if (occluded) {
      const q = OCCLUSION;
      addFront(state, fronts++, OCCLUDED, alpha, q[0], q[1], q[2], q[3], q[4], q[5]);
    }
    if (type >= FRONT_TYPE_ODDS[1]) {
      const q = WARM_FROM_TRIPLE;
      addFront(state, fronts++, WARM, alpha, tx, ty, tx + q[0], ty + q[1], tx + q[2], ty + q[3]);
    }
    const q = COLD_FROM_TRIPLE;
    addFront(state, fronts++, COLD, alpha, tx, ty, tx + q[0], ty + q[1], tx + q[2], ty + q[3]);
  }
  state.frontCount = fronts;
  return state;
}

/** Distance from (x, y) to front `f`'s polyline, in design units. */
export function frontDistance(state: WeatherState, f: number, x: number, y: number): number {
  const p = state.points;
  const o = f * FRONT_POINTS * 2;
  let best = Infinity;
  for (let j = 0; j < FRONT_POINTS - 1; j++) {
    const ax = p[o + 2 * j];
    const ay = p[o + 2 * j + 1];
    const bx = p[o + 2 * j + 2] - ax;
    const by = p[o + 2 * j + 3] - ay;
    const px = x - ax;
    const py = y - ay;
    const t = clamp((px * bx + py * by) / Math.max(1e-12, bx * bx + by * by), 0, 1);
    const d = Math.hypot(px - t * bx, py - t * by);
    if (d < best) {
      best = d;
    }
  }
  return best;
}

/** Sea-level pressure at (x, y), in hPa: the systems plus a soft trough along each front. */
export function pressureAt(state: WeatherState, x: number, y: number): number {
  let p = BASE_PRESSURE;
  const s = state.systems;
  for (let i = 0; i < SYSTEM_COUNT; i++) {
    const o = i * SYSTEM_STRIDE;
    const dx = x - s[o];
    const dy = y - s[o + 1];
    p += s[o + 2] * Math.exp(-(s[o + 3] * dx * dx + 2 * s[o + 4] * dx * dy + s[o + 5] * dy * dy));
  }
  for (let f = 0; f < state.frontCount; f++) {
    const d = frontDistance(state, f, x, y);
    const r = Math.hypot(d, TROUGH_SOFT);
    p += state.alpha[f] * TROUGH_SLOPE * TROUGH_REACH * (Math.tanh(r / TROUGH_REACH) - 1);
  }
  return p;
}

/** Rain intensity at (x, y), 0..1: bands along the fronts and a patch round each low's centre. */
export function rainAt(state: WeatherState, x: number, y: number): number {
  let rain = 0;
  for (let f = 0; f < state.frontCount; f++) {
    const d = frontDistance(state, f, x, y) / RAIN_WIDTH[state.kinds[f]];
    rain = Math.max(rain, state.alpha[f] * RAIN_PEAK[state.kinds[f]] * Math.exp(-d * d));
  }
  const s = state.systems;
  for (let i = 0; i < SYSTEM_COUNT; i++) {
    const o = i * SYSTEM_STRIDE;
    const amp = s[o + 2];
    if (amp >= 0) {
      continue;
    }
    const r = LOW_RAIN_RADIUS * s[o + 6];
    const dx = (x - s[o]) / r;
    const dy = (y - s[o + 1]) / r;
    const depth = smoothstep(8, 18, -amp);
    rain = Math.max(rain, LOW_RAIN_PEAK * depth * Math.exp(-(dx * dx + dy * dy)));
  }
  return rain;
}

/** Floats per symbol from `frontSymbols`: x, y, facing normal x, y, shape, front kind, opacity. */
export const SYMBOL_STRIDE = 7;
/** Symbol shapes. */
export const TRIANGLE = 0;
export const SEMICIRCLE = 1;
/** Spacing of symbols along a front, in design units. */
const SYMBOL_SPACING = 0.075;

/**
 * Lays out the symbols along every front into `out` (`SYMBOL_STRIDE` floats
 * each, up to `max`) and returns how many. Each faces the front's direction of
 * travel: cold fronts' triangles point into the warm air, warm fronts'
 * semicircles into the cold air ahead, and an occlusion alternates the two.
 */
export function frontSymbols(state: WeatherState, out: Float32Array, max: number): number {
  let n = 0;
  const p = state.points;
  for (let f = 0; f < state.frontCount; f++) {
    const kind = state.kinds[f];
    const alpha = state.alpha[f];
    if (!(alpha > 0)) {
      continue;
    }
    const mx = state.motion[2 * f];
    const my = state.motion[2 * f + 1];
    const o = f * FRONT_POINTS * 2;
    let next = SYMBOL_SPACING * 0.5;
    let walked = 0;
    let index = 0;
    for (let j = 0; j < FRONT_POINTS - 1 && n < max; j++) {
      const ax = p[o + 2 * j];
      const ay = p[o + 2 * j + 1];
      const dx = p[o + 2 * j + 2] - ax;
      const dy = p[o + 2 * j + 3] - ay;
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) {
        continue;
      }
      // Of the segment's two normals, the one facing the way the front travels.
      let nx = dy / len;
      let ny = -dx / len;
      if (nx * mx + ny * my < 0) {
        nx = -nx;
        ny = -ny;
      }
      while (next <= walked + len && n < max) {
        const t = (next - walked) / len;
        const q = n * SYMBOL_STRIDE;
        out[q] = ax + t * dx;
        out[q + 1] = ay + t * dy;
        out[q + 2] = nx;
        out[q + 3] = ny;
        out[q + 4] =
          kind === COLD
            ? TRIANGLE
            : kind === WARM
              ? SEMICIRCLE
              : index % 2 === 0
                ? TRIANGLE
                : SEMICIRCLE;
        out[q + 5] = kind;
        out[q + 6] = alpha;
        n++;
        index++;
        next += SYMBOL_SPACING;
      }
      walked += len;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// City forecasts
// ---------------------------------------------------------------------------

export const ICONS = [
  "sun",
  "suncloud",
  "cloud",
  "rain",
  "heavyrain",
  "thunder",
  "snow",
  "fog",
] as const;
export type IconId = (typeof ICONS)[number];
/** Icons with rain, snow or storms, shown under fronts and rain. */
export const WET_ICONS: ReadonlySet<IconId> = new Set(["rain", "heavyrain", "thunder", "snow"]);

/** Rain at a city (as `rainAt`) above which its icon is wet, and heavy. */
export const WET_RAIN = 0.28;
const HEAVY_RAIN = 0.62;
/** Pressure above which a dry city is sunny, and with some cloud, in hPa. */
const SUNNY_PRESSURE = 1019;
const FAIR_PRESSURE = 1011;
/** Daytime highs fall this much per degree of latitude polewards, in °C. */
const LAPSE_PER_DEGREE = 0.55;
/** Chance of thunder in heavy rain, and of fog in calm high pressure, by season. */
const THUNDER_ODDS: Readonly<Record<SeasonId, number>> = {
  spring: 0.3,
  summer: 0.65,
  autumn: 0.2,
  winter: 0.05,
};
const FOG_ODDS: Readonly<Record<SeasonId, number>> = {
  spring: 0.06,
  summer: 0.02,
  autumn: 0.2,
  winter: 0.18,
};
/** How sunshine changes the high, by season (°C). */
const SUN_WARMTH: Readonly<Record<SeasonId, number>> = {
  spring: 1.5,
  summer: 3,
  autumn: 1,
  winter: -0.5,
};
/** Wet weather at or below this (°C, before the weather's own effect) falls as snow. */
const SNOW_BELOW = 2;

export interface CityForecast {
  icon: IconId;
  /** Whole °C. */
  tempC: number;
}

/** The forecast time a day's icons are read at: its middle, so they fit the map all day. */
export const dayTime = (day: number) => day + 0.5;

/**
 * Fills `out` (one entry per city of the region) with day `day`'s forecast in
 * `season`: each city's icon from the weather at its point mid-day, and its high.
 */
export function forecastDay(
  forecast: Forecast,
  day: number,
  season: SeasonId,
  out: CityForecast[],
): CityForecast[] {
  const state = evaluate(forecast, dayTime(day), forecast.scratch);
  const region = forecast.region;
  const pt = [0, 0];
  const sign = region.south ? -1 : 1;
  region.cities.forEach((city, c) => {
    project(region, city.lat, city.lon, pt);
    const r = (k: number) => rand(forecast.seed, 1000 + c, day, k);
    const rain = rainAt(state, pt[0], pt[1]);
    const pressure = pressureAt(state, pt[0], pt[1]);
    const base =
      region.climate[season] -
      LAPSE_PER_DEGREE * sign * (city.lat - region.lat) +
      3 * (rand(forecast.seed, 1000 + c, 0, 50) - 0.5) +
      5 * (r(1) - 0.5);
    let icon: IconId;
    let warmth = 0;
    if (rain >= WET_RAIN) {
      if (base <= SNOW_BELOW) {
        icon = "snow";
        warmth = Math.min(0, 1 - base);
      } else if (rain >= HEAVY_RAIN) {
        icon = r(2) < THUNDER_ODDS[season] ? "thunder" : "heavyrain";
        warmth = -2.5;
      } else {
        icon = "rain";
        warmth = -1.5;
      }
    } else if (pressure >= SUNNY_PRESSURE) {
      icon = r(3) < FOG_ODDS[season] ? "fog" : "sun";
      warmth = icon === "fog" ? -2 : SUN_WARMTH[season];
    } else if (pressure >= FAIR_PRESSURE) {
      icon = "suncloud";
      warmth = 0.5 * SUN_WARMTH[season];
    } else {
      icon = "cloud";
    }
    const entry = out[c] ?? { icon, tempC: 0 };
    entry.icon = icon;
    entry.tempC = Math.round(base + warmth);
    out[c] = entry;
  });
  out.length = region.cities.length;
  return out;
}

/** A whole-degree Celsius temperature in whole degrees Fahrenheit. */
export const toFahrenheit = (c: number) => Math.round((c * 9) / 5 + 32);

/** The minus sign temperatures are written with. */
export const MINUS = "−";

/** A temperature as shown in its box, without the degree sign. */
export const formatTemp = (t: number) => (t < 0 ? MINUS : "") + String(Math.abs(t));

// ---------------------------------------------------------------------------
// Day schedule and the temperature roll
// ---------------------------------------------------------------------------

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The name of day `day` of a forecast starting on weekday `start` (0 is Sunday). */
export const dayName = (start: number, day: number) => DAY_NAMES[(((start + day) % 7) + 7) % 7];

interface DayClock {
  /** Days since the forecast began. */
  readonly day: number;
  /** Seconds into the day. */
  readonly elapsed: number;
  /** This day's length in seconds, latched when it began. */
  readonly pace: number;
  /** Forecast time in days. */
  readonly tau: number;
  /**
   * Steps by `dt` seconds; `pace` applies from the next day. Returns whether a
   * new day began (once, however many a long step crossed).
   */
  step: (dt: number, pace: number) => boolean;
  /** Back to the start of day 0, with `pace`. */
  reset: (pace: number) => void;
}

export function createDayClock(pace: number, minPace: number, maxPace: number): DayClock {
  const fit = (v: number) => (Number.isFinite(v) ? clamp(v, minPace, maxPace) : minPace);
  let day = 0;
  let elapsed = 0;
  let length = fit(pace);
  return {
    get day() {
      return day;
    },
    get elapsed() {
      return elapsed;
    },
    get pace() {
      return length;
    },
    get tau() {
      return day + Math.min(1, elapsed / length);
    },
    step(dt, nextPace) {
      elapsed += Number.isFinite(dt) && dt > 0 ? dt : 0;
      let turned = false;
      while (elapsed >= length) {
        elapsed -= length;
        day++;
        length = fit(nextPace);
        turned = true;
      }
      return turned;
    },
    reset(nextPace) {
      day = 0;
      elapsed = 0;
      length = fit(nextPace);
    },
  };
}

/** Seconds a temperature takes to roll to its new value, and the delay between digits. */
export const ROLL_SECONDS = 0.6;
const ROLL_STAGGER = 0.1;

/**
 * How far digit slot `slot` (0 is the rightmost) has rolled, 0..1 eased, `t`
 * seconds into a roll: the units first, then each digit to its left a little later.
 */
export function slotRoll(t: number, slot: number): number {
  const length = ROLL_SECONDS - 2 * ROLL_STAGGER;
  return smoothstep(0, 1, (t - slot * ROLL_STAGGER) / length);
}

// ---------------------------------------------------------------------------
// City cards: an icon on the city, its temperature box beside it, its name below
// ---------------------------------------------------------------------------

/** Card sizes in design units. */
export const ICON_SIZE = 0.088;
export const BOX_HEIGHT = 0.052;
/** The temperature box's inner edge from the city, its font size, digit cell, degree sign and padding. */
export const BOX_GAP = 0.036;
export const BOX_FONT = 0.038;
export const DIGIT_CELL = 0.024;
export const DEGREE_CELL = 0.017;
export const BOX_PAD = 0.011;
/** The box's centre below the city. */
export const BOX_DROP = 0.016;
export const NAME_FONT = 0.024;
export const NAME_DROP = 0.066;
/** Longest temperature, in characters: "100" or "−10" and the like. */
export const MAX_DIGITS = 3;

/** Width of a temperature box holding `chars` characters, in design units. */
export const boxWidth = (chars: number) => 2 * BOX_PAD + chars * DIGIT_CELL + DEGREE_CELL;

/**
 * The box round a city's card at (x, y) at its widest (a three-character
 * temperature, and a name `nameWidth` wide), as left, top, right and bottom.
 */
export function cardRect(x: number, y: number, left: boolean, nameWidth: number, out: number[]) {
  const box = boxWidth(MAX_DIGITS);
  const half = ICON_SIZE / 2;
  out[0] = Math.min(left ? x - BOX_GAP - box : x - half, x - nameWidth / 2);
  out[1] = y - half;
  out[2] = Math.max(left ? x + half : x + BOX_GAP + box, x + nameWidth / 2);
  out[3] = y + NAME_DROP + NAME_FONT / 2;
  return out;
}
