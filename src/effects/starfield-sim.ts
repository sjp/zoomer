/**
 * Pure JS side of the shared star field (`starfield.ts`): the hashed
 * ring-and-sector star layout, the slow sky rotation and the Milky Way band
 * geometry. Star Trails draws its trails from this layout; other night
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
import { clamp, smoothstep } from "./math";
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

// ---------------------------------------------------------------------------
// Point stars (sprites)
// ---------------------------------------------------------------------------

/** Floats per star in `fillStars`' output: sky x, sky y, brightness, 2 x temperature, twinkle rate, twinkle phase. */
export const STAR_FLOATS = 6;
/** Twinkle rates are whole cycles per `TWINKLE_PERIOD` seconds, so time can wrap at it. */
export const TWINKLE_PERIOD = 60;
/** Fewest and most cycles per period: 0.05 to 0.12 Hz, a very slow swell. */
export const TWINKLE_CYCLES = [3, 7] as const;
/** Twinkle depth at full strength, and the brightness range over which stars start to twinkle. */
export const TWINKLE_AMP = 0.22;
export const TWINKLE_FROM = 0.3;
export const TWINKLE_FULL = 0.7;

/** Which stars `fillStars` lists. */
export interface StarfieldLayout {
  salt: number;
  /** Share of occupied cells, 0..1 (about 1 star per 128 reference px² at 1). */
  density: number;
  /** Pole (centre of rotation), reference px, y up. */
  pole: readonly [number, number];
  /** Frame size, reference px. */
  refWidth: number;
  refHeight: number;
  /**
   * True if the sky turns: every star that can ever cross the frame is listed
   * (whole rings). False for a still sky: only the stars inside the frame at
   * rotation 0 are listed.
   */
  rotates: boolean;
  /** Extra frame margin, reference px (covers the sprite radius). */
  margin: number;
}

/**
 * Radii (reference px) between which stars can reach the frame (grown by
 * `margin`) as the sky turns about `pole`: the distance to the nearest point of
 * the frame (0 inside it) and to its farthest corner.
 */
export function visibleRadii(l: StarfieldLayout, out: [number, number]): [number, number] {
  const [px, py] = l.pole;
  const x0 = -l.margin;
  const y0 = -l.margin;
  const x1 = l.refWidth + l.margin;
  const y1 = l.refHeight + l.margin;
  const dx = Math.max(x0 - px, 0, px - x1);
  const dy = Math.max(y0 - py, 0, py - y1);
  out[0] = Math.hypot(dx, dy);
  out[1] = Math.hypot(Math.max(px - x0, x1 - px), Math.max(py - y0, y1 - py));
  return out;
}

const starScratch = createStar();
const radiiScratch: [number, number] = [0, 0];

/**
 * Lists the point stars of the shared layout (the same cells as Star Trails,
 * uncapped) into `out`, `STAR_FLOATS` floats each, ring by ring outward from the
 * pole, and returns how many it wrote: at most `max` (outer rings are dropped
 * past that). Deterministic for the same layout.
 */
export function fillStars(out: Float32Array, max: number, l: StarfieldLayout): number {
  const limit = Math.min(max, Math.floor(out.length / STAR_FLOATS));
  const [rMin, rMax] = visibleRadii(l, radiiScratch);
  const density = clamp(l.density, 0, 1);
  const ring0 = Math.max(0, Math.floor(rMin / RING_WIDTH));
  const ring1 = Math.ceil(rMax / RING_WIDTH);
  const [px, py] = l.pole;
  const x0 = -l.margin;
  const y0 = -l.margin;
  const x1 = l.refWidth + l.margin;
  const y1 = l.refHeight + l.margin;
  const span = TWINKLE_CYCLES[1] - TWINKLE_CYCLES[0] + 1;
  let count = 0;
  for (let ring = ring0; ring <= ring1; ring++) {
    const n = sectorCount(ring, Infinity);
    for (let k = 0; k < n; k++) {
      const star = cellStar(ring, k, n, density, l.salt, starScratch);
      if (!star.occupied || star.radius < rMin || star.radius > rMax) continue;
      const qx = star.radius * Math.cos(star.angle);
      const qy = star.radius * Math.sin(star.angle);
      if (!l.rotates) {
        const x = px + qx;
        const y = py + qy;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      }
      if (count >= limit) return count;
      const o = count * STAR_FLOATS;
      out[o] = qx;
      out[o + 1] = qy;
      out[o + 2] = star.bright;
      out[o + 3] = star.temp * 2;
      // The cell hash's spare bits pick the twinkle; star.u is already uniform.
      const h = hash32((ring * 0x9e3779b1 + k + l.salt) >>> 0);
      out[o + 4] = TWINKLE_CYCLES[0] + (h % span);
      out[o + 5] = (h >>> 8) / 16777216;
      count++;
    }
  }
  return count;
}

/** `t` (s, float64) wrapped to the twinkle period, for upload. */
export const twinkleTime = (t: number) => t - TWINKLE_PERIOD * Math.floor(t / TWINKLE_PERIOD);

/**
 * Brightness factor of a star twinkling `cycles` times per `TWINKLE_PERIOD` at
 * `phase`, time `t` s, `amount` 0..1. Only bright stars twinkle. The shader's twin.
 */
export function twinkleFactor(
  bright: number,
  cycles: number,
  phase: number,
  t: number,
  amount: number,
): number {
  const w = smoothstep(TWINKLE_FROM, TWINKLE_FULL, bright);
  return (
    1 +
    TWINKLE_AMP * clamp(amount, 0, 1) * w * Math.sin(TAU * ((cycles * t) / TWINKLE_PERIOD + phase))
  );
}

/** Point-star radius (reference px) at brightness `b`, before the device-pixel floor. */
export const STAR_RADIUS = [1, 1.4] as const;
/** Smallest sprite radius in device px, so stars moving across the pixel grid don't shimmer. */
export const STAR_MIN_RADIUS_PX = 1.6;
/** Light per star at brightness 1 (peak x sprite area factor), at 1080. */
export const STAR_ENERGY = 6;

/** Sprite radius in device px for brightness `b` at `scale`. */
export const starRadiusPx = (b: number, scale: number) =>
  Math.max((STAR_RADIUS[0] + STAR_RADIUS[1] * b) * scale, STAR_MIN_RADIUS_PX);

/**
 * Peak sprite brightness for a star of brightness `b` at `scale`: the light
 * (`b * STAR_ENERGY * scale²`) spread over the sprite's (1 - d²)² profile,
 * whose integral is π r² / 3, so a star gives the same light at every size.
 */
export function starPeak(b: number, scale: number): number {
  const r = starRadiusPx(b, scale);
  return (b * STAR_ENERGY * scale * scale * 3) / (Math.PI * r * r);
}
