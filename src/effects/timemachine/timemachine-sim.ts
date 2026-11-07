/**
 * The Victorian Time Machine's model, free of GL so it can be tested: the
 * journey's clock (light cycles to time of day, calendar date and season), the
 * day-and-night light with its strobe cap, the seasons as a lookup by the time
 * of year, and the date counter's rolling drums.
 */
import type { Rgb } from "../color";
import {
  createSkyState,
  SKY_KEYS,
  type SkyKey,
  sampleSky,
  type SkyState,
} from "../horizon/horizon-sim";
import { approach, clamp, fract, smoothstep } from "../math";
import { GLYPHS } from "../splitflap/splitflap-sim";
import { MAX_DAY_SECONDS, MIN_DAY_SECONDS } from "./timemachine.meta";

// ---------------------------------------------------------------------------
// The journey's clock
// ---------------------------------------------------------------------------

/**
 * Sun crossings per calendar year. Outside, a season lasts a few minutes while
 * a day lasts several seconds, so each sweep of the sun stands for about a
 * month of the calendar: the counter and the seasons keep the calendar's pace,
 * and the sun and moon its rhythm.
 */
export const CYCLES_PER_YEAR = 12;
/** The mean Gregorian year, days. */
export const YEAR_DAYS = 365.2425;
/** Calendar days per light cycle. */
export const DAYS_PER_CYCLE = YEAR_DAYS / CYCLES_PER_YEAR;
/** The journey sets off on 1 March of the starting year, just before dawn. */
export const START_MONTH = 3;
export const START_DAY = 1;
export const START_PHASE = 4.5 / 24;

/** Seconds per day, limited to the param's range (and the default when not finite). */
export function daySeconds(speed: number): number {
  return Number.isFinite(speed) ? clamp(speed, MIN_DAY_SECONDS, MAX_DAY_SECONDS) : 30;
}

/** +1 forwards, -1 backwards. */
export const directionSign = (d: string) => (d === "backward" ? -1 : 1);

/**
 * The journey's progress after `dt` more seconds at `speed` seconds per day:
 * light cycles since setting off, signed (negative into the past). Kept
 * unwrapped in float64 so a change of speed or direction carries on smoothly.
 */
export function advanceCycles(
  cycles: number,
  dt: number,
  speed: number,
  direction: string,
): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  return cycles + (directionSign(direction) * step) / daySeconds(speed);
}

/** Days since 1970-01-01 of a proleptic Gregorian date (month 1..12). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Where the journey is in time. */
export interface JourneyTime {
  /** The time of day of the light outside, 0..1 from midnight. */
  dayPhase: number;
  /** The calendar date on the counter. */
  year: number;
  month: number;
  day: number;
  /** Days since 1970-01-01 of that date. */
  dayNumber: number;
  /** How far through that calendar day, 0..1. */
  dayFraction: number;
  /** How far through the year, 0 on 1 January to 1. */
  yearFraction: number;
}

export const createJourneyTime = (): JourneyTime => ({
  dayPhase: 0,
  year: 0,
  month: 1,
  day: 1,
  dayNumber: 0,
  dayFraction: 0,
  yearFraction: 0,
});

/** Writes the date of `dayNumber` (days since 1970-01-01) into `out`. */
export function civilFromDays(dayNumber: number, out: JourneyTime): JourneyTime {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  out.year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  out.month = month;
  out.day = day;
  out.dayNumber = dayNumber;
  return out;
}

/**
 * The time `cycles` light cycles after setting off from `startYear`: the time
 * of day outside, and the calendar date, day fraction and time of year.
 */
export function journeyAt(cycles: number, startYear: number, out: JourneyTime): JourneyTime {
  const start = daysFromCivil(Math.round(startYear), START_MONTH, START_DAY);
  const days = cycles * DAYS_PER_CYCLE;
  const whole = Math.floor(days);
  civilFromDays(start + whole, out);
  out.dayFraction = days - whole;
  out.dayPhase = fract(START_PHASE + cycles);
  const jan1 = daysFromCivil(out.year, 1, 1);
  const length = isLeapYear(out.year) ? 366 : 365;
  out.yearFraction = (out.dayNumber - jan1 + out.dayFraction) / length;
  return out;
}

// ---------------------------------------------------------------------------
// Light, and its strobe cap
// ---------------------------------------------------------------------------

/**
 * The fastest any light channel (sky colours, sunlight, glow) may change, per
 * second, as a fraction of full scale: a swing from black to white takes at
 * least 1 / MAX_LIGHT_RATE seconds.
 */
export const MAX_LIGHT_RATE = 0.6;

/**
 * Where each of the Day-Night Horizon's sky keys falls in the time machine's
 * day (key hour to hour of day). Dawn and dusk are stretched to six hours each
 * and the steady day and night squeezed, so the light changes as evenly as it
 * can through the day.
 */
const KEY_WARP: readonly (readonly [number, number])[] = [
  [4.6, 3],
  [6.1, 6],
  [7.2, 9],
  [16.4, 15],
  [18.15, 18],
  [19.8, 21],
  [28.6, 27],
];

/** A sky key's hour of day in the time machine's day. */
function warpHour(h: number): number {
  const x = h < KEY_WARP[0][0] ? h + 24 : h;
  for (let i = 0; i < KEY_WARP.length - 1; i++) {
    const [k0, t0] = KEY_WARP[i];
    const [k1, t1] = KEY_WARP[i + 1];
    if (x >= k0 && x <= k1) {
      const t = t0 + ((x - k0) / (k1 - k0)) * (t1 - t0);
      return t >= 24 ? t - 24 : t;
    }
  }
  return h;
}

/** The sky keys on the time machine's day, in increasing hour order. */
export const TIME_KEYS: readonly SkyKey[] = SKY_KEYS.map((k) => ({
  ...k,
  hour: warpHour(k.hour),
})).toSorted((a, b) => a.hour - b.hour);

/** Light channels the scene uses, in a fixed order. */
export const LIGHT_CHANNELS = 13;

/** Writes the light's channels: zenith, horizon, sunlight, the glow at its strength, and the strength. */
export function lightChannels(s: SkyState, out: Float32Array | number[]): void {
  for (let k = 0; k < 3; k++) {
    out[k] = s.zenith[k];
    out[3 + k] = s.horizon[k];
    out[6 + k] = s.light[k];
    out[9 + k] = s.glow[k] * s.glowStrength;
  }
  out[12] = s.glowStrength;
}

const SLOPE_SAMPLES = 4096;

/**
 * The steepest any light channel changes over the day, per day (finite
 * differences over the day's keys, with a margin for what falls between).
 */
export const MAX_LIGHT_SLOPE = (() => {
  const a = createSkyState();
  const b = createSkyState();
  const ca = new Float32Array(LIGHT_CHANNELS);
  const cb = new Float32Array(LIGHT_CHANNELS);
  let max = 0;
  for (let i = 0; i < SLOPE_SAMPLES; i++) {
    sampleSky(i / SLOPE_SAMPLES, a, TIME_KEYS);
    sampleSky((i + 1) / SLOPE_SAMPLES, b, TIME_KEYS);
    lightChannels(a, ca);
    lightChannels(b, cb);
    for (let k = 0; k < LIGHT_CHANNELS; k++) {
      max = Math.max(max, Math.abs(cb[k] - ca[k]) * SLOPE_SAMPLES);
    }
  }
  return max * 1.1;
})();

/** The day's light averaged over the whole day. */
export const AVERAGE_SKY: SkyState = (() => {
  const avg = createSkyState();
  const s = createSkyState();
  const n = 1024;
  for (let i = 0; i < n; i++) {
    sampleSky(i / n, s, TIME_KEYS);
    for (let k = 0; k < 3; k++) {
      avg.zenith[k] += s.zenith[k] / n;
      avg.horizon[k] += s.horizon[k] / n;
      avg.light[k] += s.light[k] / n;
      // The glow at its strength, averaged, so its product averages right.
      avg.glow[k] += (s.glow[k] * s.glowStrength) / n;
    }
    avg.glowStrength += s.glowStrength / n;
  }
  for (let k = 0; k < 3; k++) {
    avg.glow[k] = avg.glowStrength > 0 ? avg.glow[k] / avg.glowStrength : 0;
  }
  return avg;
})();

/**
 * How much of the day-and-night swing shows at `speed` seconds per day, 0..1.
 * A faster day would change the light faster than MAX_LIGHT_RATE, so its swing
 * shrinks towards the day's average light: the faster it goes, the more the
 * light settles to a soft, steady mean.
 */
export function lightSwing(speed: number): number {
  return Math.min(1, (Math.max(speed, 0) * MAX_LIGHT_RATE) / MAX_LIGHT_SLOPE);
}

const mixInto = (out: Rgb, a: Rgb, b: Rgb, t: number) => {
  out[0] = b[0] + (a[0] - b[0]) * t;
  out[1] = b[1] + (a[1] - b[1]) * t;
  out[2] = b[2] + (a[2] - b[2]) * t;
};

/**
 * The light outside at `dayPhase` for `speed` seconds per day: the sky keys'
 * colours, with the swing shrunk towards the day's average as `lightSwing` says.
 * The glow is mixed at its strength, so the glow the sky shows is the mix too.
 */
export function lightAt(dayPhase: number, speed: number, out: SkyState): SkyState {
  sampleSky(dayPhase, out, TIME_KEYS);
  const t = lightSwing(speed);
  const strength = AVERAGE_SKY.glowStrength + (out.glowStrength - AVERAGE_SKY.glowStrength) * t;
  for (let k = 0; k < 3; k++) {
    const g = AVERAGE_SKY.glow[k] * AVERAGE_SKY.glowStrength;
    const lit = g + (out.glow[k] * out.glowStrength - g) * t;
    out.glow[k] = strength > 1e-6 ? lit / strength : AVERAGE_SKY.glow[k];
  }
  out.glowStrength = strength;
  mixInto(out.zenith, out.zenith, AVERAGE_SKY.zenith, t);
  mixInto(out.horizon, out.horizon, AVERAGE_SKY.horizon, t);
  mixInto(out.light, out.light, AVERAGE_SKY.light, t);
  return out;
}

/**
 * Moves the shown light `current` towards `target` with no channel (see
 * `lightChannels`) changing by more than MAX_LIGHT_RATE per second, so even a
 * sudden jump (a change of speed, direction or starting year) ramps smoothly.
 * The glow is limited at its strength.
 */
export function slewLight(current: SkyState, target: SkyState, dt: number): void {
  const step = (Number.isFinite(dt) && dt > 0 ? dt : 0) * MAX_LIGHT_RATE;
  const strength = approach(current.glowStrength, target.glowStrength, step);
  for (let k = 0; k < 3; k++) {
    current.zenith[k] = approach(current.zenith[k], target.zenith[k], step);
    current.horizon[k] = approach(current.horizon[k], target.horizon[k], step);
    current.light[k] = approach(current.light[k], target.light[k], step);
    const lit = approach(
      current.glow[k] * current.glowStrength,
      target.glow[k] * target.glowStrength,
      step,
    );
    current.glow[k] = strength > 1e-6 ? Math.min(1, lit / strength) : target.glow[k];
  }
  current.glowStrength = strength;
}

/** Copies `from` into `to`. */
export function copySky(from: SkyState, to: SkyState): void {
  for (let k = 0; k < 3; k++) {
    to.zenith[k] = from.zenith[k];
    to.horizon[k] = from.horizon[k];
    to.glow[k] = from.glow[k];
    to.light[k] = from.light[k];
  }
  to.glowStrength = from.glowStrength;
}

/** Relative luminance (Rec. 709 weights) of a linear-ish colour. */
export const luma = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const NIGHT_LUMA = luma(SKY_KEYS[0].light);
const DAY_LUMA = 0.5;
/** How dark it is outside, 0 by day to 1 at night, from the shown sunlight. */
export const nightFrom = (s: SkyState) =>
  1 - smoothstep(NIGHT_LUMA + 0.02, DAY_LUMA, luma(s.light));

// ---------------------------------------------------------------------------
// The sun and moon
// ---------------------------------------------------------------------------

/** The horizon's height, frame heights from the centre (up). */
export const HORIZON_Y = 0.02;
/** The sun's and moon's arc: its height above the horizon at noon, and half its width (frame heights). */
export const ARC_HEIGHT = 0.36;
export const ARC_HALF = 0.62;

/**
 * Where the sun (or, with `moon`, the moon) is at `dayPhase`, frame heights
 * from the frame's centre: it rises at the left at 06:00, peaks overhead at
 * noon and sets at the right at 18:00; the moon runs the other half.
 */
export function bodyAt(dayPhase: number, moon: boolean, out: [number, number]): [number, number] {
  const theta = Math.PI * 2 * (fract(dayPhase) - 0.25) + (moon ? Math.PI : 0);
  out[0] = -ARC_HALF * Math.cos(theta);
  out[1] = HORIZON_Y + ARC_HEIGHT * Math.sin(theta);
  return out;
}

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

/** How the outside looks at one time of year. */
export interface SeasonLook {
  /** How much of the tree's canopy is in leaf, 0 bare to 1 full. */
  foliage: number;
  /** The leaves' colour. */
  leaf: Rgb;
  /** The grass's colour. */
  grass: Rgb;
  /** Blossom among the leaves, 0..1. */
  blossom: number;
  /** Lying snow, 0..1. */
  snow: number;
  /** Falling snow and falling leaves, 0..1 of their most. */
  snowfall: number;
  leaffall: number;
}

export const createSeasonLook = (): SeasonLook => ({
  foliage: 0,
  leaf: [0, 0, 0],
  grass: [0, 0, 0],
  blossom: 0,
  snow: 0,
  snowfall: 0,
  leaffall: 0,
});

interface SeasonKey extends Omit<SeasonLook, "leaf" | "grass"> {
  /** Fraction of the year, 0 on 1 January. */
  at: number;
  leaf: Rgb;
  grass: Rgb;
}

const rgb = (h: string): Rgb => {
  const n = Number.parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const season = (
  at: number,
  foliage: number,
  leaf: string,
  grass: string,
  blossom: number,
  snow: number,
  snowfall: number,
  leaffall: number,
): SeasonKey => ({
  at,
  foliage,
  leaf: rgb(leaf),
  grass: rgb(grass),
  blossom,
  snow,
  snowfall,
  leaffall,
});

/**
 * The year, in increasing order (interpolation wraps from the last to the
 * first): snow lying through midwinter and melting in late February, buds and
 * blossom in spring, full green summer, gold then rust in autumn as the leaves
 * fall, bare by December, then the first snow.
 */
export const SEASON_KEYS: readonly SeasonKey[] = [
  season(0.02, 0, "#6b5038", "#9aa08a", 0, 1, 0.9, 0),
  season(0.1, 0, "#6b5038", "#9aa08a", 0, 1, 0.7, 0),
  season(0.15, 0, "#6b5038", "#7d8a5c", 0, 0.6, 0.1, 0),
  season(0.2, 0.05, "#a9c46a", "#6f9a48", 0, 0, 0, 0),
  season(0.27, 0.45, "#9fd05e", "#5f9c3e", 0.9, 0, 0, 0),
  season(0.34, 0.85, "#6fb043", "#4f9236", 0.25, 0, 0, 0),
  season(0.42, 1, "#4d8f32", "#4a8a32", 0, 0, 0, 0),
  season(0.62, 1, "#3f7a2c", "#6a8a3a", 0, 0, 0, 0),
  season(0.7, 1, "#c2a33a", "#76883e", 0, 0, 0, 0.25),
  season(0.77, 0.8, "#d27a2a", "#6f8240", 0, 0, 0, 1),
  season(0.84, 0.35, "#a8502a", "#6a7a44", 0, 0, 0, 0.8),
  season(0.89, 0, "#6b5038", "#6f7a50", 0, 0, 0, 0.15),
  season(0.92, 0, "#6b5038", "#78805e", 0, 0.05, 0.5, 0),
  season(0.97, 0, "#6b5038", "#9aa08a", 0, 0.85, 1, 0),
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The look of the outside at `yearFraction` (wrapped to [0, 1)), easing between
 * the neighbouring keys. Allocates nothing.
 */
export function seasonAt(yearFraction: number, out: SeasonLook): SeasonLook {
  const x = fract(yearFraction);
  const n = SEASON_KEYS.length;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    if (SEASON_KEYS[k].at <= x) {
      i = k;
    } else {
      break;
    }
  }
  const a = SEASON_KEYS[i];
  const b = SEASON_KEYS[(i + 1) % n];
  let span = b.at - a.at;
  let into = x - a.at;
  if (span <= 0) {
    span += 1;
  }
  if (into < 0) {
    into += 1;
  }
  const t = smoothstep(0, 1, into / span);
  out.foliage = lerp(a.foliage, b.foliage, t);
  out.blossom = lerp(a.blossom, b.blossom, t);
  out.snow = lerp(a.snow, b.snow, t);
  out.snowfall = lerp(a.snowfall, b.snowfall, t);
  out.leaffall = lerp(a.leaffall, b.leaffall, t);
  for (let k = 0; k < 3; k++) {
    out.leaf[k] = lerp(a.leaf[k], b.leaf[k], t);
    out.grass[k] = lerp(a.grass[k], b.grass[k], t);
  }
  return out;
}

/**
 * The outside's colours are drawn once per bucket of the year and crossfaded
 * between neighbouring buckets, so they're redrawn every week of the calendar
 * rather than every frame.
 */
export const SEASON_BUCKETS = 48;

/** The two buckets either side of `yearFraction`, and how far from the first to the second. */
export function seasonBuckets(
  yearFraction: number,
  out: { first: number; second: number; mix: number },
): void {
  const b = fract(yearFraction) * SEASON_BUCKETS;
  const first = Math.floor(b) % SEASON_BUCKETS;
  out.first = first;
  out.second = (first + 1) % SEASON_BUCKETS;
  out.mix = b - Math.floor(b);
}

// ---------------------------------------------------------------------------
// The date counter
// ---------------------------------------------------------------------------

/** The counter's drums: "DD MON YYYY". */
export const COUNTER_CELLS = 11;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const glyph = (ch: string) => Math.max(0, GLYPHS.indexOf(ch));
const DIGITS = Array.from("0123456789", glyph);
const MONTH_GLYPHS = MONTHS.map((m) => Array.from(m, glyph));
const BLANK = 0;
/** Seconds a drum takes to roll on to the next date, when the days pass slowly enough. */
export const ROLL_SECONDS = 0.4;

const scratch = createJourneyTime();

/**
 * Writes the counter's glyphs (indices into the split-flap `GLYPHS`) for the
 * date of `dayNumber` into `out` from `o`: the day, the month's abbreviation
 * and the year, which shows its last four digits.
 */
export function counterGlyphs(dayNumber: number, out: Uint8Array | Float32Array, o = 0): void {
  const d = civilFromDays(dayNumber, scratch);
  const year = ((d.year % 10000) + 10000) % 10000;
  out[o] = DIGITS[Math.floor(d.day / 10)];
  out[o + 1] = DIGITS[d.day % 10];
  out[o + 2] = BLANK;
  const m = MONTH_GLYPHS[d.month - 1];
  out[o + 3] = m[0];
  out[o + 4] = m[1];
  out[o + 5] = m[2];
  out[o + 6] = BLANK;
  out[o + 7] = DIGITS[Math.floor(year / 1000)];
  out[o + 8] = DIGITS[Math.floor(year / 100) % 10];
  out[o + 9] = DIGITS[Math.floor(year / 10) % 10];
  out[o + 10] = DIGITS[year % 10];
}

const curGlyphs = new Uint8Array(COUNTER_CELLS);
const nextGlyphs = new Uint8Array(COUNTER_CELLS);

/**
 * The counter's drums at time `t` (see `journeyAt`), `speed` seconds per day:
 * for each drum, the glyph showing, the one rolling in, and how far it has
 * rolled (signed: up going forwards, down going backwards), three floats per
 * drum into `out`. Each drum that changes rolls over the last ROLL_SECONDS of
 * the calendar day (all of it, when the days pass faster), so the digits roll
 * on smoothly rather than flicking.
 */
export function counterDrums(
  t: JourneyTime,
  speed: number,
  direction: string,
  out: Float32Array,
): void {
  const sign = directionSign(direction);
  const secondsPerDay = daySeconds(speed) / DAYS_PER_CYCLE;
  const r = Math.min(1, ROLL_SECONDS / secondsPerDay);
  // Forwards the day ends at fraction 1; backwards, at 0.
  const left = sign > 0 ? 1 - t.dayFraction : t.dayFraction;
  const roll = smoothstep(0, 1, (r - left) / r);
  counterGlyphs(t.dayNumber, curGlyphs);
  counterGlyphs(t.dayNumber + sign, nextGlyphs);
  for (let i = 0; i < COUNTER_CELLS; i++) {
    const changes = curGlyphs[i] !== nextGlyphs[i];
    out[i * 3] = curGlyphs[i];
    out[i * 3 + 1] = nextGlyphs[i];
    out[i * 3 + 2] = changes ? roll * sign : 0;
  }
}

// ---------------------------------------------------------------------------
// The disc
// ---------------------------------------------------------------------------

/** The disc's turn, radians per second, at the default day (30 s). */
export const DISC_TURN = 0.12;

/** How fast the disc turns at `speed` seconds per day: a little faster for faster days. */
export const discRate = (speed: number) => DISC_TURN * Math.sqrt(30 / daySeconds(speed));

// ---------------------------------------------------------------------------
// Layout, frame heights from the frame's centre (y up)
// ---------------------------------------------------------------------------

/** The chair back's half width, and the top of its straight sides (its crest arches above). */
export const CHAIR_HALF = 0.3;
export const CHAIR_SHOULDER = 0.28;
export const CHAIR_CREST = 0.13;
/** The disc: its centre's height and its radius. */
export const DISC_Y = 0.14;
export const DISC_R = 0.36;
/** The dial panel: width, bottom and top. */
export const PANEL_W = 0.38;
export const PANEL_BOTTOM = -0.405;
export const PANEL_TOP = -0.255;
/** The counter's window inside the panel: insets from the panel's left and right, bottom and top. */
export const COUNTER_INSET = 0.02;
export const COUNTER_BOTTOM = -0.39;
export const COUNTER_TOP = -0.347;
/** The lever: its pivot's height, its length and its lean either side of upright (radians). */
export const LEVER_Y = -0.37;
export const LEVER_LENGTH = 0.27;
export const LEVER_LEAN = 0.3;

/** Where the parts that sit by the frame's edges go, for a frame `aspect` wide. */
export interface SceneLayout {
  /** The dial panel's left edge. */
  panelX: number;
  /** The lever's pivot. */
  leverX: number;
  /** The disc's centre. */
  discX: number;
  /** The tree's trunk outside, and the street's lamp post. */
  treeX: number;
  lampX: number;
}

export const createSceneLayout = (): SceneLayout => ({
  panelX: 0,
  leverX: 0,
  discX: 0,
  treeX: 0,
  lampX: 0,
});

/**
 * Places the panel, lever, disc and tree for a frame `aspect` (width / height)
 * wide: as at 16:9 on wider frames, and drawn in from the edges on narrower ones.
 */
export function sceneLayout(aspect: number, out: SceneLayout): SceneLayout {
  const half = Math.max(aspect, 1) / 2;
  out.panelX = Math.max(-half + 0.04, -0.85);
  out.leverX = Math.min(half - 0.2, 0.68);
  out.discX = Math.min(half - 0.42, 0.47);
  out.treeX = Math.max(-half + 0.27, -0.62);
  out.lampX = Math.max(-half + 0.45, -0.42);
  return out;
}
