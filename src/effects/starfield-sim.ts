/**
 * Pure JS side of the shared star field (`starfield.ts`): the hashed
 * ring-and-sector star layout, the slow sky rotation and the Milky Way band
 * geometry. Star Trails (036) draws its trails from this layout; other night
 * skies draw the same stars as points. Nothing here touches GL.
 *
 * Coordinates: reference pixels of a 1080-tall frame, y up. Around the pole a
 * pixel has radius `r` and a sky angle `phi` (its screen angle minus the sky's
 * rotation, in [0, 2π)). The plane is split into rings `RING_WIDTH` wide; ring
 * `ring` is split into `n` equal sectors (`sectorCount`), and each (ring,
 * sector) cell holds at most one star, placed by hashing the cell. Stars sit
 * inside their ring with a margin (`RING_MARGIN`) wider than a trail's
 * half-width plus anti-aliasing.
 */
import { clamp } from "./math";
import { hash32 } from "./noise";

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Star layout (constants shared with the shaders)
// ---------------------------------------------------------------------------

/** Ring width, reference px. */
export const RING_WIDTH = 8;
/** Star (trail) half-width range, reference px: full widths 1.2 to 2.4 px at 1080. */
export const HALF_WIDTH_MIN = 0.6;
export const HALF_WIDTH_RANGE = 0.6;
/** Half the radial anti-aliasing ramp, reference px. */
export const EDGE_AA = 0.6;
/** Gap between a ring's edge and its stars, so trails never reach a neighbouring ring. */
export const RING_MARGIN = HALF_WIDTH_MIN + HALF_WIDTH_RANGE + EDGE_AA;
/** Target arc length of a sector near the pole (reference px), where cells are about square. */
export const CELL_LENGTH = 16;
/** Sectors per ring before any cap, per unit of ring index + 0.5. */
export const SECTORS_PER_RING = (TAU * RING_WIDTH) / CELL_LENGTH;
/** Brightness = BRIGHT_MIN + (1 - BRIGHT_MIN) * x^BRIGHT_POWER: many faint stars, a few bright. */
export const BRIGHT_MIN = 0.1;
export const BRIGHT_POWER = 5;

/**
 * Sectors in ring `ring` (at least 1), at most `cap` (pass `Infinity` for no
 * cap). Matches the shader.
 */
export function sectorCount(ring: number, cap: number): number {
  return clamp(Math.floor((ring + 0.5) * SECTORS_PER_RING), 1, Math.max(1, cap));
}

/** Per-seed salt mixed into every ring's hash, uploaded as a uint. */
export const seedSalt = (seed: number) =>
  hash32((Math.floor(seed) * 0x9e3779b1 + 0x5bd1e995) >>> 0);

/** Hash of a ring, shared by all its cells (once per pixel in the shader). */
export const ringHash = (ring: number, salt: number) => hash32((ring ^ salt) >>> 0);

export interface Star {
  occupied: boolean;
  /** Sky angle, radians, in [k s, (k + 1) s) of its sector (unwrapped past 2π for k >= n). */
  angle: number;
  /** Fraction across its sector, 0..1. */
  u: number;
  /** Radius, reference px. */
  radius: number;
  /** 0..1. */
  bright: number;
  /** Half-width, reference px. */
  halfWidth: number;
  /** Colour temperature, 0 blue-white to 1 orange. */
  temp: number;
}

export const createStar = (): Star => ({
  occupied: false,
  angle: 0,
  u: 0,
  radius: 0,
  bright: 0,
  halfWidth: 0,
  temp: 0,
});

/**
 * The star in cell (`ring`, `k mod n`) of a ring with `n` sectors, written into
 * `out`. `density` (0..1) is the share of occupied cells. Deterministic for the
 * same salt; the same bit layout as the shader. `angle` uses `k` unwrapped.
 */
export function cellStar(
  ring: number,
  k: number,
  n: number,
  density: number,
  salt: number,
  out: Star,
): Star {
  const h1 = hash32((ringHash(ring, salt) + (k % n)) >>> 0);
  out.occupied = (h1 & 0xffff) < density * 65536;
  out.u = ((h1 >>> 16) + 0.5) / 65536;
  out.angle = (k + out.u) * (TAU / n);
  const h2 = hash32(h1);
  const v = ((h2 & 0xffff) + 0.5) / 65536;
  const bx = (((h2 >>> 16) & 0xff) + 0.5) / 256;
  out.temp = ((h2 >>> 24) + 0.5) / 256;
  out.radius = ring * RING_WIDTH + RING_MARGIN + v * (RING_WIDTH - 2 * RING_MARGIN);
  out.bright = BRIGHT_MIN + (1 - BRIGHT_MIN) * bx ** BRIGHT_POWER;
  out.halfWidth = HALF_WIDTH_MIN + HALF_WIDTH_RANGE * out.bright;
  return out;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/** Advances the unwrapped sky rotation (radians, float64) by `dt` s at `degPerMin`. */
export const advanceRotation = (rot: number, dt: number, degPerMin: number) =>
  rot + Math.max(0, dt) * degPerMin * (DEG / 60);

/** `a` wrapped to [0, 2π), for upload: the rotation is periodic, so this never jumps. */
export function wrapAngle(a: number): number {
  const w = a - TAU * Math.floor(a / TAU);
  return w < TAU ? w : 0;
}

/**
 * Sky coordinates of a screen offset `(dx, dy)` from the pole (reference px)
 * under rotation `rot`: the offset turned back by `rot`, as the shaders do.
 */
export function toSky(dx: number, dy: number, rot: number, out: [number, number]) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  out[0] = c * dx + s * dy;
  out[1] = c * dy - s * dx;
  return out;
}

// ---------------------------------------------------------------------------
// Milky Way
// ---------------------------------------------------------------------------

/**
 * The Milky Way band: a straight band in sky coordinates (so it turns with the
 * stars), Gaussian across.
 */
export interface MilkyWayBand {
  /** Angle of the band's unit normal, radians (sky coordinates). */
  angle: number;
  /** Signed distance of the band's centre line from the pole along the normal, reference px. */
  offset: number;
  /** Gaussian width (the distance at which the band falls to half), reference px. */
  width: number;
}

/** Star Trails' band. */
export const DEFAULT_BAND: MilkyWayBand = { angle: 0.7, offset: 560, width: 230 };

/** Haze noise tiles every this many reference px of sky. */
export const HAZE_TILE = 760;

/** Signed distance of sky point `(qx, qy)` from the band's centre line, reference px. */
export const bandAcross = (band: MilkyWayBand, qx: number, qy: number) =>
  qx * Math.cos(band.angle) + qy * Math.sin(band.angle) - band.offset;

/** Band envelope at sky point `(qx, qy)`: 1 on the centre line, 1/2 at `width` away. */
export function bandMask(band: MilkyWayBand, qx: number, qy: number): number {
  const a = bandAcross(band, qx, qy);
  return 2 ** (-(a * a) / (band.width * band.width));
}

/**
 * A band through screen point `(x, y)` (reference px) at rotation 0, running at
 * `direction` radians from the x axis, for a sky turning about `pole`.
 */
export function bandThrough(
  pole: readonly [number, number],
  x: number,
  y: number,
  direction: number,
  width: number,
): MilkyWayBand {
  const angle = direction + Math.PI / 2;
  const offset = (x - pole[0]) * Math.cos(angle) + (y - pole[1]) * Math.sin(angle);
  return { angle, offset, width };
}
