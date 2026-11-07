/**
 * Pure logic for the "Zen garden" effect: stone placement, the rake-line wave
 * layouts, the rerake sweep, and a JS twin of the shader's rake phase field.
 * Allocates nothing per call. Units are reference px (1080 tall, y down).
 *
 * The rake pattern. The grooves are the level lines of a phase field `θ`, with
 * groove height `cos(2π θ / S)` for line spacing `S` (crests where `θ` is a
 * multiple of `S`). Far from the stones `θ` is the wavy straight field
 * `φ(x, y) = y + A0 sin(k0 x + p0) + A1 sin(k1 x + p1)`.
 *
 * Around each stone the pattern follows a distance field `L` instead, so the line
 * spacing stays constant by construction rather than by rescaling afterwards. In
 * the stone's frame, with `n` the signed distance across the lines from the groove
 * nearest the stone (`n = (φ - φline) / g`, `g = |∇φ|` at the stone) and `t` the
 * distance along it:
 *
 *   L = min(ring, D, max(|n|, Rz))
 *   ring = r + RING_STEEP * max(r - Rz, 0)     (concentric rings out to Rz)
 *   D = sqrt(max(GAP Rz - |t|, 0)^2 + n^2)     (lines turning back in hairpins)
 *
 * `D` is the distance to two rays along the groove from `GAP Rz` out, so outside
 * the gap `D = |n|` and `L = |n|`: the field equals the straight lines there,
 * exactly. Above and below the rings, `max(|n|, Rz)` is `|n|` too. Inside, rings,
 * hairpins and lines only meet along the level `L = Rz`, and the small pockets
 * between them stay flat at that level, like unraked gravel. `Rz` is a whole number
 * of spacings, so every join lies on a groove crest, where the groove's slope is
 * zero: the shading is smooth (C1) across every join without a smooth minimum, and
 * no blend band widens or bunches the lines. The steep ring term stops the rings
 * from reaching past `Rz` where the lines curve towards the stone.
 *
 * The stone's term is `θ = φ + s g (L - |n|)` with `s = sign(n)`, so near the
 * stone `θ = φline + s g L` and the groove height is `cos(2π g L / S)`, even in
 * `s` because `φline` is a crest. `θ` itself flips sign across `n = 0` inside the
 * gap, but the groove height and slope are continuous there. The term is zero
 * outside the box `|t| < GAP Rz, |n| < Rz`, and stones are placed so the boxes
 * never overlap; no fade window is needed.
 */
import { createRng, hash32 } from "../noise";
import { clamp } from "../math";
import { MAX_STONES, SPACING_MAX } from "./zen.meta";

const TAU = Math.PI * 2;

/** Floats per stone in the stone and layout arrays (shader `vec4`s). */
export const STONE_FLOATS = 4;

/** Stone radius ranges (reference px): the first stone is the big one. */
export const BIG_STONE: readonly [number, number] = [56, 74];
export const SMALL_STONE: readonly [number, number] = [30, 52];
/** Rings start outside the moss (this times the radius) and run at least this many spacings. */
export const STONE_PAD = 1.15;
export const RING_COUNT = 2;
/** Hairpin rays start this many ring radii along the groove from the stone. */
export const GAP = 2;
/** How fast the ring field rises past the ring radius. */
export const RING_STEEP = 3;
/** A stone's term is zero where |n| exceeds this many ring radii. */
export const BOX_N = 1.25;
/** Largest slope of the straight lines at waviness 1 (|∇φ| <= sqrt(1 + slope²)). */
export const WAVE_SLOPE = 0.45;
/** Floats in a wave layout: amplitude, wavenumber, phase, twice. */
export const WAVE_FLOATS = 6;

/** Stone margins (reference px): from the frame edges, and between two stones' boxes. */
const EDGE_MARGIN = 24;
const STONE_MARGIN = 24;
/** Placement attempts per stone before it is dropped. */
const TRIES = 400;

/**
 * Ring radius (reference px) for a stone of `radius` with line spacing `spacing`
 * and local line density `g`: the smallest whole number of ring spacings
 * (`spacing / g`) at least `STONE_PAD radius + RING_COUNT` ring spacings.
 */
export function ringRadius(radius: number, spacing: number, g = 1): number {
  const step = spacing / g;
  return Math.ceil((radius * STONE_PAD) / step + RING_COUNT) * step;
}

/** Largest ring radius a stone of `radius` can get, at the widest spacing. */
export function maxRingRadius(radius: number): number {
  return radius * STONE_PAD + (RING_COUNT + 1) * SPACING_MAX;
}

/**
 * Whether stones of radii `ra`, `rb` at offset (dx, dy) keep their boxes apart for
 * any spacing and waviness: side by side (along the lines) or one above the other,
 * allowing for the lines' slope.
 */
export function stonesApart(ra: number, rb: number, dx: number, dy: number): boolean {
  const a = maxRingRadius(ra);
  const b = maxRingRadius(rb);
  const ax = Math.abs(dx);
  if (ax >= GAP * (a + b) + STONE_MARGIN) {
    return true;
  }
  return Math.abs(dy) >= BOX_N * (a + b) + WAVE_SLOPE * ax + STONE_MARGIN;
}

/** Whether a stone of `radius` at x would sit in the middle third, behind the speaker. */
export function inCentre(x: number, radius: number, refWidth: number): boolean {
  return Math.abs(x - refWidth / 2) < refWidth / 6 + 0.6 * radius;
}

/**
 * Places up to MAX_STONES stones for `seed` in a frame `refWidth` wide: the first
 * big, the rest smaller, each toward the sides (out of the middle third), inside
 * the frame and with their boxes apart (`stonesApart`). A stone that finds no room
 * is dropped, so the others keep their places as the count changes. Writes
 * `cx, cy, radius, 0` per stone into `pos` and the look (two wobble phases, a tone
 * and a moss amount) into `look`; returns how many were placed.
 */
export function placeStones(
  pos: Float32Array,
  look: Float32Array,
  seed: number,
  refWidth: number,
): number {
  const rng = createRng(hash32(Math.floor(seed) * 7919 + 50));
  let n = 0;
  for (let i = 0; i < MAX_STONES; i++) {
    const [lo, hi] = i === 0 ? BIG_STONE : SMALL_STONE;
    const radius = lo + (hi - lo) * rng();
    const ph0 = rng() * TAU;
    const ph1 = rng() * TAU;
    const tone = 0.8 + 0.4 * rng();
    const moss = 0.55 + 0.45 * rng();
    const edge = radius * STONE_PAD + EDGE_MARGIN;
    for (let t = 0; t < TRIES; t++) {
      const x = edge + (refWidth - 2 * edge) * rng();
      const y = edge + (1080 - 2 * edge) * rng();
      if (inCentre(x, radius, refWidth)) {
        continue;
      }
      let ok = true;
      for (let j = 0; j < n && ok; j++) {
        const o = j * STONE_FLOATS;
        ok = stonesApart(radius, pos[o + 2], x - pos[o], y - pos[o + 1]);
      }
      if (!ok) {
        continue;
      }
      const o = n * STONE_FLOATS;
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = radius;
      pos[o + 3] = 0;
      look[o] = ph0;
      look[o + 1] = ph1;
      look[o + 2] = tone;
      look[o + 3] = moss;
      n++;
      break;
    }
  }
  pos.fill(0, n * STONE_FLOATS);
  look.fill(0, n * STONE_FLOATS);
  return n;
}

/**
 * Writes the wave layout for `seed` and rerake `generation` into `out`
 * (`A0, k0, p0, A1, k1, p1`): two sines of long wavelength, scaled so the lines'
 * slope never exceeds `WAVE_SLOPE * waviness`.
 */
export function waveLayout<T extends Float32Array | Float64Array>(
  out: T,
  seed: number,
  generation: number,
  waviness: number,
): T {
  const rng = createRng(hash32(Math.floor(seed) * 1013 + Math.floor(generation) * 92821 + 3));
  const k0 = TAU / (1000 + 500 * rng());
  const k1 = TAU / (450 + 250 * rng());
  const ratio = 0.3 + 0.35 * rng();
  const a0 = (WAVE_SLOPE * clamp(waviness, 0, 1)) / (k0 + ratio * k1);
  out[0] = a0;
  out[1] = k0;
  out[2] = rng() * TAU;
  out[3] = a0 * ratio;
  out[4] = k1;
  out[5] = rng() * TAU;
  return out;
}

/** The straight field `φ` at (x, y). */
export function straightField(w: ArrayLike<number>, x: number, y: number): number {
  return y + w[0] * Math.sin(w[1] * x + w[2]) + w[3] * Math.sin(w[4] * x + w[5]);
}

/** `∂φ/∂x` at x (`∂φ/∂y` is 1). */
export function straightSlope(w: ArrayLike<number>, x: number): number {
  return w[0] * w[1] * Math.cos(w[1] * x + w[2]) + w[3] * w[4] * Math.cos(w[4] * x + w[5]);
}

/**
 * Fills one wave layout's per-stone constants into `out` (`MAX_STONES * 4`): the
 * crest value `φline` nearest the stone centre, the lines' slope there, `1 / g`
 * and the ring radius. Unused stones are zero.
 */
export function fillStoneLayout(
  out: Float32Array,
  wave: ArrayLike<number>,
  pos: ArrayLike<number>,
  count: number,
  spacing: number,
): Float32Array {
  out.fill(0);
  for (let i = 0; i < count; i++) {
    const o = i * STONE_FLOATS;
    const cx = pos[o];
    const slope = straightSlope(wave, cx);
    const g = Math.sqrt(1 + slope * slope);
    out[o] = Math.round(straightField(wave, cx, pos[o + 1]) / spacing) * spacing;
    out[o + 1] = slope;
    out[o + 2] = 1 / g;
    out[o + 3] = ringRadius(pos[o + 2], spacing, g);
  }
  return out;
}

/**
 * The stone's distance field `L` (see the file comment) at stone-frame
 * coordinates `t` (along the groove), `n` (across it) and `r` (from the centre),
 * for ring radius `rz`.
 */
export function stoneDistance(t: number, n: number, r: number, rz: number): number {
  const ring = r + RING_STEEP * Math.max(r - rz, 0);
  const u = Math.max(GAP * rz - Math.abs(t), 0);
  const d = Math.hypot(u, n);
  return Math.min(ring, d, Math.max(Math.abs(n), rz));
}

/**
 * JS twin of the shader's `rakePhase`: writes `θ` and its analytic gradient into
 * `out` (`[θ, ∂x, ∂y]`) at (x, y) for one wave layout. `pos` comes from
 * `placeStones`, `layout` from `fillStoneLayout`. Returns `out`.
 */
export function rakePhase(
  out: Float64Array,
  x: number,
  y: number,
  wave: ArrayLike<number>,
  pos: ArrayLike<number>,
  layout: ArrayLike<number>,
  count: number,
): Float64Array {
  const a0 = wave[1] * x + wave[2];
  const a1 = wave[4] * x + wave[5];
  const phi = y + wave[0] * Math.sin(a0) + wave[3] * Math.sin(a1);
  const gsx = wave[0] * wave[1] * Math.cos(a0) + wave[3] * wave[4] * Math.cos(a1);
  let th = phi;
  let gx = gsx;
  let gy = 1;
  for (let i = 0; i < count; i++) {
    const o = i * STONE_FLOATS;
    const rz = layout[o + 3];
    const inv = layout[o + 2];
    const slope = layout[o + 1];
    const qx = x - pos[o];
    const qy = y - pos[o + 1];
    const n = (phi - layout[o]) * inv;
    const t = (qx - slope * qy) * inv;
    const gap = GAP * rz;
    if (Math.abs(t) >= gap || Math.abs(n) >= BOX_N * rz) {
      continue;
    }
    const r = Math.max(Math.hypot(qx, qy), 1e-3);
    const ring = r + RING_STEEP * Math.max(r - rz, 0);
    const u = gap - Math.abs(t);
    const d = Math.max(Math.hypot(u, n), 1e-3);
    const flat = Math.max(Math.abs(n), rz);
    const s = n >= 0 ? 1 : -1;
    // ∇n = ∇φ / g, ∇t = (1, -slope) / g.
    const gnx = gsx * inv;
    const gny = inv;
    let l: number;
    let glx: number;
    let gly: number;
    if (ring <= d && ring <= flat) {
      l = ring;
      const k = r > rz ? 1 + RING_STEEP : 1;
      glx = (k * qx) / r;
      gly = (k * qy) / r;
    } else if (d <= flat) {
      l = d;
      const st = Math.sign(t);
      glx = (-u * st * inv + n * gnx) / d;
      gly = (u * st * slope * inv + n * gny) / d;
    } else {
      l = flat;
      const k = Math.abs(n) > rz ? s : 0;
      glx = k * gnx;
      gly = k * gny;
    }
    // θ += s g (L - |n|), and g ∇n = ∇φ.
    const g = 1 / inv;
    th += s * g * l - g * n;
    gx += s * g * glx - gsx;
    gy += s * g * gly - 1;
  }
  out[0] = th;
  out[1] = gx;
  out[2] = gy;
  return out;
}

/** Seconds between rerakes (idle), and how long a sweep takes to cross the frame. */
export const RERAKE_INTERVAL = 150;
export const RERAKE_DURATION = 60;
/** Width of the soft band between the old and new patterns, reference px. */
export const RERAKE_BAND = 180;

export interface Rerake {
  /** Seconds since the last sweep ended (or since the start). */
  idle: number;
  /** Sweep progress 0..1, or -1 while idle. */
  progress: number;
  /** Wave generation of the current (old) pattern; the sweep draws `generation + 1`. */
  generation: number;
}

export function createRerake(): Rerake {
  return { idle: 0, progress: -1, generation: 0 };
}

/**
 * Advances the rerake by `dt` seconds. While `enabled`, a sweep starts after
 * `RERAKE_INTERVAL` idle seconds; a sweep already under way always finishes (so
 * turning it off never jumps). Returns true on the frame a sweep finishes, when
 * the new pattern becomes the old one.
 */
export function stepRerake(s: Rerake, dt: number, enabled: boolean): boolean {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (s.progress >= 0) {
    s.progress += step / RERAKE_DURATION;
    if (s.progress >= 1) {
      s.progress = -1;
      s.idle = 0;
      s.generation++;
      return true;
    }
    return false;
  }
  if (!enabled) {
    return false;
  }
  s.idle += step;
  if (s.idle >= RERAKE_INTERVAL) {
    s.progress = 0;
  }
  return false;
}

/** Sentinel sweep position far left of the frame: everything shows the old pattern. */
export const SWEEP_OFF = -1e5;

/**
 * Sweep line x (reference px) for a frame `refWidth` wide: from a band left of the
 * frame to a band right of it at constant speed, or `SWEEP_OFF` while idle. Pixels
 * left of it show the new pattern.
 */
export function sweepX(s: Rerake, refWidth: number): number {
  if (s.progress < 0) {
    return SWEEP_OFF;
  }
  return -RERAKE_BAND + s.progress * (refWidth + 2 * RERAKE_BAND);
}

/** Weight of the new pattern at x for sweep line `sx` (1 behind the line, 0 ahead). */
export function sweepWeight(x: number, sx: number): number {
  return clamp((sx - x) / RERAKE_BAND + 0.5, 0, 1);
}
