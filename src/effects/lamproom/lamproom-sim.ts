/**
 * Pure logic for the Lighthouse Lamp Room (lamproom.ts): the room's layout and
 * the camera that sees it, the lens's turn and the brightness of its beams as
 * they pass the camera, the 1D pattern of refracted light the lens throws on
 * the walls, the weather presets and the clouds' cover over the moon. Nothing
 * here touches GL, so it is all unit tested.
 *
 * World units: the ring of windows has radius 1 (about 2.5 m); y is up from
 * the floor; x is right and z away from the camera, which looks level along +z.
 * The lens's axis is the y axis.
 */
import { lookup } from "../lookup";
import { approach, clamp, smoothstep, wrap } from "../math";
import { MAX_PERIOD, MIN_PERIOD, type LensSide, type Weather } from "./lamproom.meta";

const TAU = Math.PI * 2;

/* ----- Room ----- */

/** Metres per world unit, for the sea outside. */
export const UNIT_M = 2.5;
/** Height of the lamp room above the sea, metres. */
export const SEA_HEIGHT_M = 40;
/** Panes round the ring, so mullions every 30°. */
export const PANES = 12;
/** Mullion width, and the diagonal astragals' width and spacing along the ring (world units). */
export const MULLION_W = 0.04;
export const ASTRAGAL_W = 0.014;
export const ASTRAGAL_PITCH = 0.26;
/** Astragal slope: height per unit along the ring. */
export const ASTRAGAL_SLOPE = 1.6;
/** Top of the parapet wall (the glazing's sill), the glazing's top, and the top of the cornice above. */
export const SILL_Y = 0.4;
export const LINTEL_Y = 1.42;
export const CORNICE_Y = 1.54;
/** Brass handrail just above the sill, standing a little in from the glass. */
export const RAIL_Y = 0.5;
export const RAIL_R = 0.95;
export const RAIL_HALF = 0.013;
/** Grated walkway round the parapet: inner radius and height. */
export const WALK_R = 0.9;
export const WALK_Y = 0.06;

/* ----- Lens ----- */

/** Lens glass from LENS_Y0 to LENS_Y1, widest (LENS_R) at the lamp's height. */
export const LENS_Y0 = 0.42;
export const LENS_Y1 = 0.98;
export const LAMP_Y = 0.68;
export const LENS_R = 0.18;
/** Half-height of the central belt that holds the bull's-eye panels. */
export const DRUM_HALF = 0.1;
/** Cast-iron pedestal radius, and the heights of the brass base ring below the glass and the crown above it. */
export const PEDESTAL_R = 0.12;
export const BASE_H = 0.04;
export const CROWN_H = 0.08;
/** Glass panels round the lens; bull's-eyes on two opposite ones, so two beams. */
export const LENS_PANELS = 6;
export const BEAMS = 2;

/**
 * Radius of the lens's glass at height y: a beehive, widest at the lamp and
 * drawing in toward the crown and less toward the base. 0 outside the glass.
 */
export function lensRadius(y: number): number {
  if (y < LENS_Y0 || y > LENS_Y1) {
    return 0;
  }
  if (y >= LAMP_Y) {
    const u = (y - LAMP_Y) / (LENS_Y1 - LAMP_Y);
    return LENS_R * (1 - 0.5 * u * u);
  }
  const u = (LAMP_Y - y) / (LAMP_Y - LENS_Y0);
  return LENS_R * (1 - 0.3 * u * u);
}

/** Base ring's radius, and the crown's at its foot, as shares of LENS_R. */
export const BASE_RING = 0.88;
export const CROWN_FOOT = 0.52;

/**
 * The lens's whole outline at height y: the brass base ring, the glass
 * (lensRadius) and the domed brass crown. Mirrored in the lens shader.
 */
export function lensProfile(y: number): number {
  if (y < LENS_Y0 - BASE_H || y > LENS_Y1 + CROWN_H) {
    return 0;
  }
  if (y < LENS_Y0) {
    return LENS_R * BASE_RING;
  }
  if (y > LENS_Y1) {
    const u = (y - LENS_Y1) / CROWN_H;
    return LENS_R * CROWN_FOOT * Math.sqrt(Math.max(1 - u * u, 0)) + 0.012 * (1 - u);
  }
  return lensRadius(y);
}

/* ----- Camera ----- */

/** Where the lens's axis falls, as a fraction of the frame width in from its side. */
export const LENS_AT = 0.18;
/** The camera's furthest reach across from the lens, its eye height, and how far back from the lens it stands. */
export const CAM_X_MAX = 0.55;
export const CAM_Y = 0.68;
export const CAM_Z = -0.7;
/** Focal length in frame heights (a wide lens: about 67° vertically). */
export const FOCAL = 0.75;
/** Where eye level (the horizon) falls, as a fraction of the frame height up from the bottom. */
export const HORIZON_Y = 0.55;

/**
 * The camera's x for a lens side and a frame `aspect` (width / height) wide:
 * it stands across from the lens far enough that the lens's axis shows
 * LENS_AT of the width in from that side. To see the lens on the left, the
 * camera stands to its right.
 */
export function cameraX(side: LensSide, aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const x = Math.min(((0.5 - LENS_AT) * a * -CAM_Z) / FOCAL, CAM_X_MAX);
  return side === "right" ? -x : x;
}

/**
 * Projects world point (x, y, z) for a camera on `side` into frame heights
 * (x from the left edge of a frame `aspect` wide, y up from the bottom), into
 * `out`. Returns false (leaving `out` alone) for points behind the camera.
 */
export function project(
  x: number,
  y: number,
  z: number,
  side: LensSide,
  aspect: number,
  out: { x: number; y: number },
): boolean {
  const depth = z - CAM_Z;
  if (depth <= 1e-6) {
    return false;
  }
  out.x = aspect / 2 + (FOCAL * (x - cameraX(side, aspect))) / depth;
  out.y = HORIZON_Y + (FOCAL * (y - CAM_Y)) / depth;
  return true;
}

/**
 * Unit vector (x, z) from the lens's axis toward the camera: the lens's angle
 * is measured from it, so a beam at angle 0 points straight at the camera.
 */
export function towardCamera(side: LensSide, aspect: number, out: { x: number; z: number }) {
  const cx = cameraX(side, aspect);
  const len = Math.hypot(cx, CAM_Z);
  out.x = cx / len;
  out.z = CAM_Z / len;
  return out;
}

/** Screen box round the lens and its crown, in frame heights: left, right, bottom, top. */
export interface LensBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** The lamp's centre on screen. */
  lampX: number;
  lampY: number;
}

/** The lens's screen box for `side`, with a small margin for its anti-aliased edge. */
export function lensBox(side: LensSide, aspect: number): LensBox {
  const p = { x: 0, y: 0 };
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  // Trace the outline's rings from the base to the top of the crown.
  const bottom = LENS_Y0 - BASE_H;
  const top = LENS_Y1 + CROWN_H;
  for (let i = 0; i <= 48; i++) {
    const y = bottom + ((top - bottom) * i) / 48;
    const r = Math.max(lensProfile(y), lensProfile(y - 1e-6), lensProfile(y + 1e-6));
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * TAU;
      if (project(r * Math.cos(a), y, r * Math.sin(a), side, aspect, p)) {
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y);
        y1 = Math.max(y1, p.y);
      }
    }
  }
  project(0, LAMP_Y, 0, side, aspect, p);
  const m = 0.01;
  return { x0: x0 - m, x1: x1 + m, y0: y0 - m, y1: y1 + m, lampX: p.x, lampY: p.y };
}

/* ----- Beam ----- */

/** Half-width (radians of lens turn) of a beam's pass over the camera: it brightens over this, then fades. */
export const FACE_HALF = 0.6;
/** The brightest the beam's pass may add, at `beam` = 1 (linear, before the room's own light). */
export const BEAM_PEAK = 0.32;

/** The `period` param, made safe: seconds between two beams passing the camera. */
export function clampPeriod(period: number): number {
  return clamp(Number.isFinite(period) ? period : 20, MIN_PERIOD, MAX_PERIOD);
}

/** Advances the lens's angle (radians, wrapped to [0, 2π)) by `dt` seconds: a beam passes every `period` s. */
export function advanceLens(angle: number, dt: number, period: number): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  return wrap(angle + (step * TAU) / (BEAMS * clampPeriod(period)), 0, TAU);
}

/** Angle wrapped to (-π, π]. */
export function wrapAngle(a: number): number {
  return a - TAU * Math.round(a / TAU);
}

/**
 * How squarely a beam at angle `a` (radians from the camera) faces the
 * camera: 1 head-on, falling smoothly to 0 at FACE_HALF either side.
 */
export function facing(a: number): number {
  const x = 1 - Math.abs(wrapAngle(a)) / FACE_HALF;
  return x <= 0 ? 0 : smoothstep(0, 1, x);
}

/**
 * Brightness the beams add as they pass the camera at lens angle `angle`, for
 * a `beam` setting of 0..1: never more than BEAM_PEAK. The two beams are
 * opposite, so at most one faces the camera at a time.
 */
export function beamLevel(angle: number, beam: number): number {
  let f = 0;
  for (let k = 0; k < BEAMS; k++) {
    f = Math.max(f, facing(angle + (k * TAU) / BEAMS));
  }
  return BEAM_PEAK * clamp(Number.isFinite(beam) ? beam : 0, 0, 1) * f;
}

/** Seconds the beam's brightness takes to climb from nothing to its peak at `period`. */
export function riseSeconds(period: number): number {
  return (FACE_HALF * BEAMS * clampPeriod(period)) / TAU;
}

/* ----- Light on the walls ----- */

/** Texels in the band table, over half a turn of lens angle (the pattern repeats per beam). */
export const BAND_SIZE = 512;
/** Width (radians) of a beam's own patch of light on the walls, and of the thin bands from the prisms. */
export const BAND_BEAM_SIGMA = 0.2;
export const BAND_STRIPE_SIGMA = 0.025;

/**
 * The light the turning lens throws round the room, as a function of angle
 * from a beam (0..π, wrapping): a soft patch where the beam itself falls,
 * then thin bands of refracted light from the prism rings, a few per panel.
 * 0..255 as R8 texels, peak 255.
 */
export function buildBandTable(size = BAND_SIZE): Uint8Array {
  const out = new Uint8Array(size);
  const span = Math.PI;
  const values = new Float64Array(size);
  const panel = TAU / LENS_PANELS;
  // Three bands per panel, offset within it; fixed so the pattern never jumps.
  const stripes: [number, number][] = [];
  for (let j = 0; j < LENS_PANELS / BEAMS; j++) {
    stripes.push([j * panel + 0.22 * panel, 0.45]);
    stripes.push([j * panel + 0.5 * panel, 0.3]);
    stripes.push([j * panel + 0.71 * panel, 0.38]);
  }
  let peak = 0;
  for (let i = 0; i < size; i++) {
    const a = (i / size) * span;
    // Nearest distance to the beam, wrapping round the half turn.
    const db = Math.min(a, span - a);
    let v = Math.exp(-0.5 * (db / BAND_BEAM_SIGMA) ** 2);
    for (const [at, gain] of stripes) {
      const d = Math.abs(wrapAngle(((a - at) / span) * TAU)) * (span / TAU);
      v += gain * Math.exp(-0.5 * (d / BAND_STRIPE_SIGMA) ** 2);
    }
    values[i] = v;
    peak = Math.max(peak, v);
  }
  for (let i = 0; i < size; i++) {
    out[i] = Math.round((values[i] / peak) * 255);
  }
  return out;
}

/* ----- Weather ----- */

export interface WeatherLook {
  /** Cloud cover, 0..1. */
  cover: number;
  /** Swell height and ripple strength (1 = the Calm Sea's calm). */
  swell: number;
  wind: number;
  /** Rain on the glass, 0..1. */
  rain: number;
  /** Storm murk: darker sky, greyer air. */
  storm: number;
}

export const WEATHER: Readonly<Record<Weather, Readonly<WeatherLook>>> = {
  calm: { cover: 0.12, swell: 0.7, wind: 0.6, rain: 0, storm: 0 },
  clouds: { cover: 0.5, swell: 1.1, wind: 1, rain: 0, storm: 0 },
  storm: { cover: 0.88, swell: 2.4, wind: 2, rain: 0.75, storm: 1 },
};

export function createWeatherLook(): WeatherLook {
  return { ...WEATHER.clouds };
}

/** Seconds the weather takes to change fully from one setting to another. */
export const WEATHER_EASE = 6;

/**
 * Eases `look` toward the `weather` setting over `dt` seconds, so a change of
 * weather rolls in rather than cutting. `snap` jumps straight there.
 */
export function easeWeather(
  look: WeatherLook,
  weather: string,
  dt: number,
  snap = false,
): WeatherLook {
  const t = lookup(WEATHER, weather, "clouds");
  const step = snap ? Infinity : Math.max(0, dt) / WEATHER_EASE;
  look.cover = approach(look.cover, t.cover, step);
  // Swell and wind span more than 1, so scale their step to keep the same duration.
  look.swell = approach(look.swell, t.swell, step * 2);
  look.wind = approach(look.wind, t.wind, step * 2);
  look.rain = approach(look.rain, t.rain, step);
  look.storm = approach(look.storm, t.storm, step);
  return look;
}

/* ----- Clouds ----- */

/** Cloud noise texture side, and the clouds' height above the camera (world units, for perspective). */
export const CLOUD_NOISE = 128;
export const CLOUD_HEIGHT = 1;
/** Noise tiles per unit of the clouds' plane coordinate, and their drift (tiles per second). */
export const CLOUD_SCALE = 0.11;
export const CLOUD_DRIFT = 0.0035;

/**
 * Cloud density from the two noise octaves (0..1 each, 0.5 mid) at a cloud
 * cover of 0..1. Mirrored in the sky shader.
 */
export function cloudDensity(n0: number, n1: number, cover: number): number {
  const n = 0.65 * n0 + 0.35 * n1;
  const threshold = 0.66 - 0.4 * clamp(cover, 0, 1);
  return smoothstep(threshold - 0.08, threshold + 0.14, n);
}

/**
 * Bilinear sample of channel `c` of a square, tiling 8-bit texture (`size`
 * texels a side, `stride` bytes per texel) at (u, v) in tiles, as the GPU's
 * LINEAR + REPEAT sampling does, 0..1.
 */
export function sampleTiled(
  data: Uint8Array,
  size: number,
  stride: number,
  c: number,
  u: number,
  v: number,
): number {
  const x = wrap(u, 0, 1) * size - 0.5;
  const y = wrap(v, 0, 1) * size - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (i: number, j: number) =>
    data[((((j % size) + size) % size) * size + (((i % size) + size) % size)) * stride + c] / 255;
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Where a sky direction (frame heights from the horizon centre, over the
 * focal length; `qy` > 0) meets the clouds' plane, in noise tiles before the
 * drift offset. The sky shader does the same.
 */
export function cloudUv(qx: number, qy: number, out: { u: number; v: number }) {
  const k = (CLOUD_HEIGHT * CLOUD_SCALE) / Math.max(qy, 1e-3);
  out.u = qx * k;
  out.v = k;
  return out;
}

/* ----- Moon ----- */

/** The moon: across the frame from the lens (fraction of the width), and its height above the horizon (frame heights). */
export const MOON_X = 0.8;
export const MOON_Y = 0.26;

/** The moon's x as a fraction of the frame width, opposite the lens. */
export function moonX(side: LensSide): number {
  return side === "right" ? 1 - MOON_X : MOON_X;
}
