/**
 * Monitor Glow's light: what a game or film on a monitor just out of shot
 * throws on the wall behind the speaker, as a schedule of "shots".
 *
 * Each shot holds one look from its genre's palette (a colour and brightness,
 * the pool's size and where it centres) for 4 to 20 seconds, after easing
 * over from the last shot's look in 0.5 to 2 seconds. Some shots have bright
 * events in them, such as an explosion's warm burst. The pacing follows the
 * codec and comfort rules for bright changes:
 *
 * - An event ramps up over at least `MIN_RISE` seconds and falls away over at
 *   least `MIN_FALL`, and the light's brightness never passes `PEAK`.
 * - A shot change eases over long enough that its brightness changes no
 *   faster than an event's fall.
 * - Two brightness changes (a shot change or an event) start at least
 *   `MIN_REPEAT` seconds apart, and each starts at least `REST` seconds after
 *   the one before has settled, so nothing pulses faster than once every
 *   three seconds.
 *
 * The schedule is seeded and latches its params per shot: a new genre or seed
 * applies from the next shot. A genre change also eases the shot under way over
 * to its counterpart in the new palette, over at least `GENRE_EASE` seconds.
 * Brightness is measured as luminance (Rec. 709 weights) of the light colour.
 */
import { hexToUnitRgb } from "../color";
import { approach, clamp, smoothstep } from "../math";
import { hash32 } from "../noise";

export type Genre = "adventure" | "shooter" | "racing" | "horror" | "cosy" | "film";

/** Shortest and longest shot, seconds. */
export const MIN_SHOT = 4;
export const MAX_SHOT = 20;
/** Shortest and longest ease from one shot's look to the next, seconds. */
export const MIN_EASE = 0.5;
export const MAX_EASE = 2;
/** Shortest rise and fall of a bright event, seconds. */
export const MIN_RISE = 0.3;
export const MIN_FALL = 1;
/** Least time between the starts of two brightness changes, seconds. */
export const MIN_REPEAT = 3;
/** Least time from one change settling to the next starting, seconds. */
export const REST = 2;
/** Brightest a look may be, and the brightest the light may get with an event on top. */
export const MAX_LOOK = 0.6;
export const PEAK = 0.8;
/** Most an event adds to the brightness. */
export const MAX_BOOST = 0.3;
/** Least time a genre change takes to ease the shot under way, seconds. */
export const GENRE_EASE = 1.5;
/** Most bright events in one shot. */
const MAX_EVENTS = 4;
/** Longest step taken at once, seconds. */
const MAX_STEP = 0.25;
/** How fast the light follows the intensity param, per second. */
const INTENSITY_RATE = 0.5;
/**
 * Average brightness change per second of a shot change. With the smoothstep
 * ease peaking at 1.5 times the average, a change of `MAX_LOOK` over `MAX_EASE`
 * stays under an event's steepest fall.
 */
const EASE_RATE = MAX_BOOST / MIN_FALL;

/** Rec. 709 luminance. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

interface LookDef {
  readonly hex: string;
  /** Scales the colour: the look's brightness. */
  readonly gain: number;
  /** Pool radius, frame heights. */
  readonly radius: number;
  /** How often it's picked, relative to the genre's other looks. */
  readonly weight: number;
}

interface GenreDef {
  readonly looks: readonly LookDef[];
  /** Shot length range, seconds. */
  readonly shot: readonly [number, number];
  /** Chance each free stretch of a shot gets an event. */
  readonly events: number;
  /** An event's typical brightness boost (up to 1.4 times this). */
  readonly boost: number;
  /** Event colours. */
  readonly bursts: readonly string[];
}

const look = (hex: string, gain: number, radius: number, weight = 1): LookDef => ({
  hex,
  gain,
  radius,
  weight,
});

const MENU = look("#5cff8a", 0.42, 0.62, 0.8);
const LOADING = look("#e8eeff", 0.6, 0.85, 0.6);

const GENRE_DEFS: Readonly<Record<Genre, GenreDef>> = {
  adventure: {
    looks: [
      look("#5b8cff", 0.55, 0.78, 4),
      look("#6fd08a", 0.5, 0.7, 2),
      look("#ffb066", 0.5, 0.8, 1.5),
      look("#3fa7a0", 0.38, 0.62, 1.5),
      MENU,
      LOADING,
    ],
    shot: [8, 20],
    events: 0.2,
    boost: 0.18,
    bursts: ["#ff8a3a", "#ffc070"],
  },
  shooter: {
    looks: [
      look("#8796b0", 0.5, 0.75, 3),
      look("#d8b27a", 0.5, 0.78, 2),
      look("#4c8f9a", 0.42, 0.66, 2),
      MENU,
      LOADING,
    ],
    shot: [6, 14],
    events: 0.85,
    boost: 0.2,
    bursts: ["#ff8a3a", "#ffe0a0"],
  },
  racing: {
    looks: [
      look("#9fd2ff", 0.6, 0.85, 3),
      look("#ff5ad8", 0.42, 0.7, 1.5),
      look("#4ae0ff", 0.45, 0.72, 1.5),
      look("#ff9a5a", 0.5, 0.8, 1.5),
      LOADING,
    ],
    shot: [5, 14],
    events: 0.2,
    boost: 0.15,
    bursts: ["#fff2d0", "#8ae8ff"],
  },
  horror: {
    looks: [
      look("#2a3a60", 0.2, 0.55, 3),
      look("#c0303a", 0.32, 0.6, 1.5),
      look("#7aa060", 0.22, 0.58, 1.5),
      look("#ffa860", 0.28, 0.62, 1),
      look("#e8eeff", 0.3, 0.7, 0.5),
    ],
    shot: [8, 20],
    events: 0.12,
    boost: 0.16,
    bursts: ["#ff4a3a", "#ffd0a0"],
  },
  cosy: {
    looks: [
      look("#ffc39a", 0.5, 0.8, 2),
      look("#a8e0a0", 0.5, 0.78, 2),
      look("#ffb0d0", 0.45, 0.75, 1.5),
      look("#a8d0ff", 0.5, 0.8, 1.5),
      look("#fff0d8", 0.5, 0.82, 1),
    ],
    shot: [10, 20],
    events: 0.05,
    boost: 0.1,
    bursts: ["#ffe0a0"],
  },
  film: {
    looks: [
      look("#4a6ad0", 0.4, 0.72, 2),
      look("#ffb070", 0.45, 0.78, 2),
      look("#c8cfd8", 0.5, 0.8, 1.5),
      look("#4aa0a8", 0.38, 0.68, 1.5),
      look("#6070a0", 0.18, 0.6, 1),
      look("#e8eeff", 0.55, 0.85, 0.5),
    ],
    shot: [4, 16],
    events: 0.15,
    boost: 0.18,
    bursts: ["#ff8a3a", "#ffd890"],
  },
};

/** Floats per look: red, green, blue, pool radius, pool centre x. */
const LOOK_SIZE = 5;
/** Floats per event: start, rise, hold, fall, boost, burst red, green, blue (per unit luminance). */
export const EVENT_SIZE = 8;

/** A genre's looks and bursts as numbers, built once. */
interface GenreTable {
  readonly def: GenreDef;
  /** `LOOK_SIZE` floats per look; the centre x is 0. */
  readonly looks: Float64Array;
  readonly lums: Float64Array;
  readonly weights: Float64Array;
  readonly totalWeight: number;
  /** Burst colours scaled to unit luminance, 3 floats each. */
  readonly bursts: Float64Array;
}

function buildTable(def: GenreDef): GenreTable {
  const n = def.looks.length;
  const looks = new Float64Array(n * LOOK_SIZE);
  const lums = new Float64Array(n);
  const weights = new Float64Array(n);
  def.looks.forEach((l, i) => {
    const [r, g, b] = hexToUnitRgb(l.hex);
    looks.set([r * l.gain, g * l.gain, b * l.gain, l.radius, 0], i * LOOK_SIZE);
    lums[i] = luminance(r, g, b) * l.gain;
    weights[i] = l.weight;
  });
  const bursts = new Float64Array(def.bursts.length * 3);
  def.bursts.forEach((hex, i) => {
    const [r, g, b] = hexToUnitRgb(hex);
    const lum = luminance(r, g, b);
    bursts.set([r / lum, g / lum, b / lum], i * 3);
  });
  return {
    def,
    looks,
    lums,
    weights,
    totalWeight: weights.reduce((a, w) => a + w, 0),
    bursts,
  };
}

const TABLES: Readonly<Record<Genre, GenreTable>> = {
  adventure: buildTable(GENRE_DEFS.adventure),
  shooter: buildTable(GENRE_DEFS.shooter),
  racing: buildTable(GENRE_DEFS.racing),
  horror: buildTable(GENRE_DEFS.horror),
  cosy: buildTable(GENRE_DEFS.cosy),
  film: buildTable(GENRE_DEFS.film),
};

/** The brightness of each look in `genre` (for tests). */
export function lookLuminances(genre: Genre): Float64Array {
  return TABLES[genre].lums;
}

/** Shot length range of `genre`, seconds. */
export function shotRange(genre: Genre): readonly [number, number] {
  return GENRE_DEFS[genre].shot;
}

/** Furthest the pool's centre wanders from its home, frame heights. */
const CENTRE_JITTER = 0.06;
/** How much bigger the pool gets at an event's peak, at `MAX_BOOST`. */
const EVENT_SPREAD = 0.25;

/** The schedule's state and its output, updated in place by `stepGlow`. */
interface GlowSchedule {
  /** Seconds since it began (float64, unwrapped). */
  time: number;
  /** Index of the shot under way. */
  shot: number;
  /** The seed and genre the shot under way was drawn with. */
  seed: number;
  genre: Genre;
  /** The look the shot shows, by index in its genre. */
  look: number;
  /** When the shot began and when the next begins. */
  start: number;
  end: number;
  /** When the ease to `to` began, and how long it takes. */
  easeStart: number;
  ease: number;
  /** The look eased from and to (`LOOK_SIZE` floats each). */
  readonly from: Float64Array;
  readonly to: Float64Array;
  /** The shot's events, `EVENT_SIZE` floats each, in time order. */
  readonly events: Float64Array;
  eventCount: number;
  /** The eased intensity. */
  intensity: number;
  /** Per-shot random stream: its base and position. */
  rngBase: number;
  rngIndex: number;
  /** Output: the light's colour at the current intensity, its brightness, the pool's radius and centre x. */
  readonly light: Float64Array;
  level: number;
  radius: number;
  centre: number;
  /** Scratch: the base look now. */
  readonly base: Float64Array;
}

function random(s: GlowSchedule): number {
  s.rngIndex++;
  return hash32(s.rngBase + Math.imul(s.rngIndex, 0x9e3779b9)) / 4294967296;
}

function between(s: GlowSchedule, lo: number, hi: number): number {
  return lo + (hi - lo) * random(s);
}

/** A look picked by weight from `table`, other than `avoid` (unless it is the only one). */
function pickLook(s: GlowSchedule, table: GenreTable, avoid: number): number {
  const n = table.lums.length;
  const total =
    avoid >= 0 && avoid < n && n > 1 ? table.totalWeight - table.weights[avoid] : table.totalWeight;
  let r = random(s) * total;
  for (let i = 0; i < n; i++) {
    if (i === avoid && n > 1) {
      continue;
    }
    r -= table.weights[i];
    if (r < 0) {
      return i;
    }
  }
  return avoid === n - 1 && n > 1 ? n - 2 : n - 1;
}

/** Writes look `index` of `table` into `out`, with the pool centre at `centre`. */
function writeLook(table: GenreTable, index: number, centre: number, out: Float64Array): void {
  for (let k = 0; k < LOOK_SIZE; k++) {
    out[k] = table.looks[index * LOOK_SIZE + k];
  }
  out[4] = centre;
}

/** How long an ease of `delta` brightness takes, at least `least` seconds. */
function easeFor(delta: number, least: number): number {
  return Math.max(least, Math.abs(delta) / EASE_RATE);
}

/** Seconds from `start` that an event (rise, hold, fall) has the light raised. */
function eventLength(e: Float64Array, i: number): number {
  return e[i + 1] + e[i + 2] + e[i + 3];
}

/** Starts shot `index` at `at`, drawn with `seed` and `genre`, easing from the look shown at `at`. */
function beginShot(s: GlowSchedule, at: number, index: number, seed: number, genre: Genre): void {
  s.from.set(s.to);
  s.shot = index;
  s.seed = seed;
  s.rngBase = hash32(hash32(seed) ^ Math.imul(index + 1, 0x85ebca6b));
  s.rngIndex = 0;
  const sameGenre = s.genre === genre;
  s.genre = genre;
  const table = TABLES[genre];
  s.look = pickLook(s, table, sameGenre ? s.look : -1);
  writeLook(table, s.look, between(s, -CENTRE_JITTER, CENTRE_JITTER), s.to);
  s.to[3] *= between(s, 0.92, 1.08);
  const delta = luminance(s.to[0], s.to[1], s.to[2]) - luminance(s.from[0], s.from[1], s.from[2]);
  s.ease = clamp(easeFor(delta, between(s, MIN_EASE, 1)), MIN_EASE, MAX_EASE);
  s.easeStart = at;
  s.start = at;
  const [lo, hi] = table.def.shot;
  s.end = at + between(s, lo, hi);
  scheduleEvents(s, table, s.start + Math.max(MIN_REPEAT, s.ease + REST));
}

/** Fills the shot's events from `from` on, keeping each clear of the next shot change. */
function scheduleEvents(s: GlowSchedule, table: GenreTable, from: number): void {
  const e = s.events;
  const def = table.def;
  const baseLum = luminance(s.to[0], s.to[1], s.to[2]);
  let t = from + between(s, 0, 2);
  s.eventCount = 0;
  while (s.eventCount < MAX_EVENTS) {
    const rise = between(s, 0.4, 0.8);
    const hold = between(s, 0, 0.3);
    const fall = between(s, 1.2, 2.5);
    const length = rise + hold + fall;
    // The next shot change must start late enough after this event.
    if (s.end < Math.max(t + MIN_REPEAT, t + length + REST)) {
      break;
    }
    if (random(s) < def.events) {
      const i = s.eventCount * EVENT_SIZE;
      const boost = Math.min(def.boost * between(s, 0.7, 1.4), MAX_BOOST, PEAK - baseLum);
      const burst = Math.floor(random(s) * def.bursts.length) * 3;
      e[i] = t;
      e[i + 1] = rise;
      e[i + 2] = hold;
      e[i + 3] = fall;
      e[i + 4] = Math.max(0, boost);
      e[i + 5] = table.bursts[burst];
      e[i + 6] = table.bursts[burst + 1];
      e[i + 7] = table.bursts[burst + 2];
      s.eventCount++;
      t = Math.max(t + MIN_REPEAT, t + length + REST) + between(s, 0, 4);
    } else {
      t += between(s, 1, 3);
    }
  }
}

/** Starts a schedule at time 0 showing a look of `genre`, with no ease in. */
export function createGlowSchedule(seed: number, genre: Genre, intensity: number): GlowSchedule {
  const s: GlowSchedule = {
    time: 0,
    shot: 0,
    seed,
    genre,
    look: -1,
    start: 0,
    end: 0,
    easeStart: 0,
    ease: 0,
    from: new Float64Array(LOOK_SIZE),
    to: new Float64Array(LOOK_SIZE),
    events: new Float64Array(MAX_EVENTS * EVENT_SIZE),
    eventCount: 0,
    intensity: clamp(intensity, 0, 1),
    rngBase: 0,
    rngIndex: 0,
    light: new Float64Array(3),
    level: 0,
    radius: 0,
    centre: 0,
    base: new Float64Array(LOOK_SIZE),
  };
  beginShot(s, 0, 0, seed, genre);
  // The first shot starts on its look.
  s.from.set(s.to);
  s.ease = 0;
  scheduleEvents(s, TABLES[genre], MIN_REPEAT);
  evaluate(s);
  return s;
}

/**
 * Moves the schedule on by `dt` seconds and writes its output. `genre` and
 * `seed` apply from the next shot (a genre change also eases the shot under
 * way into the new palette); `intensity` (0..1) is eased.
 */
export function stepGlow(
  s: GlowSchedule,
  dt: number,
  genre: Genre,
  intensity: number,
  seed: number,
): void {
  // A long hitch (a hidden tab) pauses the show rather than racing through shots.
  const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_STEP) : 0;
  s.time += step;
  s.intensity = approach(s.intensity, clamp(intensity, 0, 1), INTENSITY_RATE * step);
  if (genre !== s.genre && s.time < s.end) {
    switchGenre(s, genre);
  }
  while (s.time >= s.end) {
    beginShot(s, s.end, s.shot + 1, seed, genre);
  }
  evaluate(s);
}

/** Eases the shot under way to its look's counterpart in `genre`, and drops its events still to come. */
function switchGenre(s: GlowSchedule, genre: Genre): void {
  evaluateBase(s, s.time);
  s.from.set(s.base);
  const table = TABLES[genre];
  const counterpart = s.look % table.lums.length;
  const centre = s.to[4];
  const radius = s.to[3] / TABLES[s.genre].looks[s.look * LOOK_SIZE + 3];
  writeLook(table, counterpart, centre, s.to);
  s.to[3] *= radius;
  s.genre = genre;
  s.look = counterpart;
  const delta = luminance(s.to[0], s.to[1], s.to[2]) - luminance(s.from[0], s.from[1], s.from[2]);
  s.ease = easeFor(delta, GENRE_EASE);
  s.easeStart = s.time;
  // Events not yet begun were fitted to the old look; one under way plays out.
  let kept = 0;
  for (let i = 0; i < s.eventCount; i++) {
    if (s.events[i * EVENT_SIZE] <= s.time) {
      kept = i + 1;
    }
  }
  s.eventCount = kept;
  // Keep the next shot change clear of this ease.
  s.end = Math.max(s.end, s.time + Math.max(MIN_REPEAT, s.ease + REST));
}

/** Writes the base look (before events) at time `t` into `s.base`. */
function evaluateBase(s: GlowSchedule, t: number): void {
  const k = s.ease > 0 ? smoothstep(0, 1, (t - s.easeStart) / s.ease) : 1;
  for (let i = 0; i < LOOK_SIZE; i++) {
    s.base[i] = s.from[i] + (s.to[i] - s.from[i]) * k;
  }
}

/** An event's envelope at `t`: 0, rising, 1 while held, falling. */
function envelope(e: Float64Array, i: number, t: number): number {
  const u = t - e[i];
  if (u <= 0 || u >= eventLength(e, i)) {
    return 0;
  }
  const rise = e[i + 1];
  const hold = e[i + 2];
  if (u < rise) {
    return smoothstep(0, rise, u);
  }
  if (u < rise + hold) {
    return 1;
  }
  return 1 - smoothstep(rise + hold, rise + hold + e[i + 3], u);
}

function evaluate(s: GlowSchedule): void {
  const t = s.time;
  evaluateBase(s, t);
  const b = s.base;
  const baseLum = luminance(b[0], b[1], b[2]);
  let r = b[0];
  let g = b[1];
  let bl = b[2];
  let spread = 0;
  for (let n = 0; n < s.eventCount; n++) {
    const i = n * EVENT_SIZE;
    const env = envelope(s.events, i, t);
    if (env > 0) {
      const boost = Math.min(s.events[i + 4], Math.max(0, PEAK - baseLum)) * env;
      r += s.events[i + 5] * boost;
      g += s.events[i + 6] * boost;
      bl += s.events[i + 7] * boost;
      spread += boost / MAX_BOOST;
    }
  }
  const k = s.intensity;
  s.light[0] = r * k;
  s.light[1] = g * k;
  s.light[2] = bl * k;
  s.level = luminance(s.light[0], s.light[1], s.light[2]);
  s.radius = b[3] * (1 + EVENT_SPREAD * spread);
  s.centre = b[4];
}

/** Most the ambient flicker moves the brightness, as a fraction. */
export const FLICKER = 0.026;

/**
 * The screen's slow ambient flicker at `time` seconds: a factor within
 * `FLICKER` of 1, so the light reads as a screen rather than a lamp.
 */
export function screenFlicker(time: number): number {
  const tau = 2 * Math.PI;
  return (
    1 +
    0.012 * Math.sin(tau * 0.13 * time) +
    0.008 * Math.sin(tau * 0.31 * time + 1.3) +
    0.006 * Math.sin(tau * 0.71 * time + 2.1)
  );
}
