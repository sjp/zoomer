/**
 * Pure JS parts of the Flying Toasters effect (toasters.ts): the flock layout,
 * its flight down and to the left with wrap-around, the wing-flap clock, count
 * and doneness fades, and the per-sprite instances for the sprite batch. Nothing
 * here touches GL, so it is all unit tested.
 *
 * Units: reference px, where the frame is 1080 tall and `refWidth` wide, y down
 * from the top. Sprites sit in square atlas cells; `CELL` is a near sprite's cell
 * side, and the farther depth layers scale it down.
 *
 * Sprite slots: toasters are slots `0 .. MAX_TOASTERS - 1`, slices of toast the
 * slots after them. Each slot draws its layout from its own RNG stream, so a count
 * change adds or removes sprites at the end and leaves the rest where they were.
 */
import { createCountFade } from "../fade";
import { approach, fract } from "../math";
import { createRng, hash32 } from "../noise";
import { MAX_SPEED, MAX_TOAST, MAX_TOASTERS } from "./toasters.meta";

export const SLOTS = MAX_TOASTERS + MAX_TOAST;
export const REF_HEIGHT = 1080;
/** Side of a near sprite's square atlas cell, reference px. */
export const CELL = 160;

/** Per depth layer, near to far: size, speed and brightness relative to the near layer. */
export const LAYER_SIZE = [1, 0.78, 0.6] as const;
const LAYER_SPEED = [1, 0.8, 0.62] as const;
const LAYER_BRIGHTNESS = [1, 0.86, 0.72] as const;

/** Near-layer cruising speed at speed 1, reference px per second. */
const BASE_SPEED = 60;
/** Each sprite flies up to this fraction faster or slower than its layer, so some overtake. */
const SPEED_JITTER = 0.1;
/** Unit flight direction: left and down (y down), a shallow diagonal. */
const DIR_LEN = Math.hypot(1, 0.6);
export const DIR_X = -1 / DIR_LEN;
export const DIR_Y = 0.6 / DIR_LEN;

/** Wing beats per second, each toaster picking its own rate in this range. */
export const FLAP_MIN = 2;
export const FLAP_MAX = 3;
/** Atlas cells of the four-frame flap cycle: wings up, mid, down, mid. */
export const FLAP_CYCLE = [0, 1, 2, 1] as const;
/** First of the three toast cells (light, golden, dark). */
export const TOAST_CELL = 3;
/** Vertical bob with the flaps, as a fraction of the cell side (half the full travel). */
export const BOB = 0.03;
/**
 * How far past each edge the wrap happens, reference px: half a near cell plus
 * its bob, plus room for a frame of flight, so a sprite is wholly out of view
 * when it jumps to the far side.
 */
const MARGIN = CELL * (0.5 + BOB) + 12;

/** Doneness levels per second the toast eases by when the doneness changes. */
const DONENESS_RATE = 1;
/** Seconds an added sprite takes to fade in. */
const FADE_IN = 0.8;
/** Seconds to fade the whole flock out (and back in) around a new layout. */
const RESEED_FADE = 0.4;

/**
 * Instance floats per sprite: centre x, y (device px, y down), half-size (px),
 * opacity; then atlas cells A and B, the mix from A to B, and brightness.
 */
export const SPRITE_FLOATS = 8;

/** The params a step needs. */
export interface FlockParams {
  toasters: number;
  toast: number;
  doneness: string;
  speed: number;
  seed: number;
}

interface Flock {
  /** Position as a fraction of the wrap span (frame plus `MARGIN` each side), in [0, 1). */
  readonly u: Float64Array;
  readonly v: Float64Array;
  /** Depth layer, 0 near to 2 far. */
  readonly layer: Uint8Array;
  /** Speed multiplier within the layer. */
  readonly pace: Float32Array;
  /** Flap rate (Hz) and phase (cycles, in [0, 1)); toasters only. */
  readonly flapRate: Float32Array;
  readonly flapPhase: Float64Array;
  /** The level a slice shows with doneness "Mixed", from its own hash. */
  readonly mixedLevel: Uint8Array;
  /** Each slice's eased doneness, 0 light to 2 dark. */
  readonly doneness: Float32Array;
  /** Every slot, farthest first: the draw order, fixed by the layout. */
  readonly order: Uint8Array;
  readonly toasterFade: ReturnType<typeof createCountFade>;
  readonly toastFade: ReturnType<typeof createCountFade>;
  /** The seed the layout was built from. */
  seed: number;
  /** Whole-flock opacity: dips to 0 and back when the seed changes. */
  presence: number;
  /** Whether the flock has been stepped yet (the first step snaps the fades). */
  started: boolean;
}

/** Steps of the R2 sequence (from the plastic number) and the jitter around it, in spans. */
const R2_X = 0.7548776662466927;
const R2_Y = 0.5698402909980532;
const LAYOUT_JITTER = 0.12;

/** The slot's own stream: independent of every other slot, and of the counts. */
const slotRng = (seed: number, slot: number) => createRng(hash32(seed * 977 + slot * 7919 + 13));

/** Fills every slot's layout from `seed`. */
function layout(f: Flock, seed: number): void {
  const key = new Float32Array(SLOTS);
  // Toasters and toast each start on their own R2 low-discrepancy sequence, so
  // any first few are spread evenly over the sky (still prefix-stable), offset
  // per seed and jittered a little so the flock doesn't look like a lattice.
  const start = createRng(hash32(seed * 7 + 3));
  const origins = [start(), start(), start(), start()];
  for (let s = 0; s < SLOTS; s++) {
    const rand = slotRng(seed, s);
    const toast = s >= MAX_TOASTERS;
    const i = toast ? s - MAX_TOASTERS : s;
    const o = toast ? 2 : 0;
    f.u[s] = fract(origins[o] + i * R2_X + (rand() - 0.5) * LAYOUT_JITTER);
    f.v[s] = fract(origins[o + 1] + i * R2_Y + (rand() - 0.5) * LAYOUT_JITTER);
    // More far sprites than near ones, as in a deep sky.
    const r = rand();
    const layer = r < 0.3 ? 0 : r < 0.65 ? 1 : 2;
    f.layer[s] = layer;
    // A continuous depth within the layer orders the draw, so overtaking sprites
    // pass consistently in front or behind.
    key[s] = layer + rand() * 0.9;
    f.pace[s] = 1 + (rand() * 2 - 1) * SPEED_JITTER;
    f.flapRate[s] = FLAP_MIN + rand() * (FLAP_MAX - FLAP_MIN);
    f.flapPhase[s] = rand();
    f.mixedLevel[s] = hash32(seed * 31 + s * 101 + 7) % 3;
  }
  const slots = Array.from({ length: SLOTS }, (_, s) => s);
  slots.sort((a, b) => key[b] - key[a]);
  f.order.set(slots);
  f.seed = seed;
}

export function createFlock(seed: number): Flock {
  const f: Flock = {
    u: new Float64Array(SLOTS),
    v: new Float64Array(SLOTS),
    layer: new Uint8Array(SLOTS),
    pace: new Float32Array(SLOTS),
    flapRate: new Float32Array(SLOTS),
    flapPhase: new Float64Array(SLOTS),
    mixedLevel: new Uint8Array(SLOTS),
    doneness: new Float32Array(SLOTS),
    order: new Uint8Array(SLOTS),
    toasterFade: createCountFade(MAX_TOASTERS),
    toastFade: createCountFade(MAX_TOAST),
    seed: 0,
    presence: 1,
    started: false,
  };
  layout(f, Math.floor(seed));
  return f;
}

/** The speed slider value made safe: finite, within [0, MAX_SPEED]. */
const safeSpeed = (speed: number) => (speed > 0 ? Math.min(speed, MAX_SPEED) : 0);

/** A slot's flight speed, reference px per second. */
export const slotSpeed = (f: Flock, s: number, speed: number) =>
  BASE_SPEED * safeSpeed(speed) * LAYER_SPEED[f.layer[s]] * f.pace[s];

/**
 * The fastest any sprite edge moves at slider value `speed`, reference px per
 * second: the fastest flight plus the fastest bob, added as if they were parallel.
 */
export function maxEdgeSpeed(speed: number): number {
  const fly = BASE_SPEED * safeSpeed(speed) * (1 + SPEED_JITTER);
  const bob = 2 * Math.PI * FLAP_MAX * BOB * CELL;
  return fly + bob;
}

/** The doneness a slice eases towards. */
function targetDoneness(f: Flock, s: number, doneness: string): number {
  switch (doneness) {
    case "light":
      return 0;
    case "golden":
      return 1;
    case "dark":
      return 2;
    default:
      return f.mixedLevel[s];
  }
}

/** Atlas cell of a toaster at flap phase `phase` (cycles). */
export const flapCell = (phase: number) => FLAP_CYCLE[Math.floor(fract(phase) * 4) & 3];

/**
 * Advances the flock by `dt` seconds in a frame `refWidth` reference px wide.
 * Allocates nothing, except when a new seed lays the flock out again.
 */
export function stepFlock(f: Flock, dt: number, refWidth: number, p: FlockParams): void {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const seed = Number.isFinite(p.seed) ? Math.floor(p.seed) : 0;
  if (!f.started) {
    f.started = true;
    if (seed !== f.seed) {
      layout(f, seed);
    }
    f.toasterFade.snap(p.toasters);
    f.toastFade.snap(p.toast);
    for (let s = MAX_TOASTERS; s < SLOTS; s++) {
      f.doneness[s] = targetDoneness(f, s, p.doneness);
    }
  }
  // A new seed: fade the whole flock out, lay it out again, and fade it back in.
  if (seed !== f.seed) {
    f.presence = Math.max(0, f.presence - d / RESEED_FADE);
    if (f.presence === 0) {
      layout(f, seed);
      for (let s = MAX_TOASTERS; s < SLOTS; s++) {
        f.doneness[s] = targetDoneness(f, s, p.doneness);
      }
    }
  } else {
    f.presence = Math.min(1, f.presence + d / RESEED_FADE);
  }
  f.toasterFade.step(p.toasters, d, FADE_IN);
  f.toastFade.step(p.toast, d, FADE_IN);

  const spanX = refWidth + 2 * MARGIN;
  const spanY = REF_HEIGHT + 2 * MARGIN;
  for (let s = 0; s < SLOTS; s++) {
    const travel = slotSpeed(f, s, p.speed) * d;
    f.u[s] = fract(f.u[s] + (DIR_X * travel) / spanX);
    f.v[s] = fract(f.v[s] + (DIR_Y * travel) / spanY);
    if (s < MAX_TOASTERS) {
      f.flapPhase[s] = fract(f.flapPhase[s] + f.flapRate[s] * d);
    } else {
      f.doneness[s] = approach(f.doneness[s], targetDoneness(f, s, p.doneness), d * DONENESS_RATE);
    }
  }
}

/** A slot's fade, 0 to 1 (count fade times the whole-flock presence). */
export function slotLife(f: Flock, s: number): number {
  const life =
    s < MAX_TOASTERS
      ? s < f.toasterFade.live
        ? f.toasterFade.life[s]
        : 0
      : s - MAX_TOASTERS < f.toastFade.live
        ? f.toastFade.life[s - MAX_TOASTERS]
        : 0;
  return life * f.presence;
}

/** A slot's centre in reference px (y down), bob included, written to `out`. */
export function slotCentre(f: Flock, s: number, refWidth: number, out: [number, number]): void {
  const size = CELL * LAYER_SIZE[f.layer[s]];
  out[0] = -MARGIN + f.u[s] * (refWidth + 2 * MARGIN);
  out[1] = -MARGIN + f.v[s] * (REF_HEIGHT + 2 * MARGIN);
  if (s < MAX_TOASTERS) {
    // The body rises on the downstroke (phase 0 to 0.5) and sinks on the upstroke.
    out[1] += BOB * size * Math.cos(2 * Math.PI * f.flapPhase[s]);
  }
}

const centre: [number, number] = [0, 0];

/**
 * Writes the visible sprites, farthest first, as `SPRITE_FLOATS` floats each at
 * device-pixel `scale`, and returns how many it wrote.
 */
export function writeSprites(f: Flock, out: Float32Array, refWidth: number, scale: number): number {
  let n = 0;
  for (let k = 0; k < SLOTS; k++) {
    const s = f.order[k];
    const life = slotLife(f, s);
    if (life <= 0) {
      continue;
    }
    const layer = f.layer[s];
    slotCentre(f, s, refWidth, centre);
    const o = n * SPRITE_FLOATS;
    out[o] = centre[0] * scale;
    out[o + 1] = centre[1] * scale;
    out[o + 2] = 0.5 * CELL * LAYER_SIZE[layer] * scale;
    out[o + 3] = life;
    if (s < MAX_TOASTERS) {
      const cell = flapCell(f.flapPhase[s]);
      out[o + 4] = cell;
      out[o + 5] = cell;
      out[o + 6] = 0;
    } else {
      const d = f.doneness[s];
      const a = Math.min(Math.floor(d), 1);
      out[o + 4] = TOAST_CELL + a;
      out[o + 5] = TOAST_CELL + a + 1;
      out[o + 6] = d - a;
    }
    out[o + 7] = LAYER_BRIGHTNESS[layer];
    n++;
  }
  return n;
}
