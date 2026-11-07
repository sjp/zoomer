/**
 * Pure logic for the Captain's Cabin (captainscabin.ts): the cabin's layout
 * (the bowed row of stern windows and their leaded panes, the bookshelves,
 * the chart table, the cannon and the lantern's beam), the ship's roll and
 * pitch on the swell, the lantern's swing, the weather presets and their
 * easing, the storm's soft lightning and the schedule of distant ships.
 * Nothing here touches GL, so it is all unit tested.
 *
 * Layout units are reference px: x from the frame's left edge, y up from the
 * bottom of a 1080-high frame.
 */
import { hexToUnitRgb, type Rgb } from "../color";
import { lookup } from "../lookup";
import { approach, clamp, smoothstep } from "../math";
import { createRng } from "../noise";
import { SEA_PRESETS, type SeaPreset } from "../sea/sea-sim";
import { createSwell, swayAt, swellAt } from "../sway";
import type { CabinWeather } from "./captainscabin.meta";

/* ----- Layout ----- */

export const REF_HEIGHT = 1080;
/** The windows' sill and head at their ends; the row bows outwards, so both draw in toward the middle by these. */
export const SILL_Y = 440;
export const HEAD_Y = 892;
export const SILL_BOW = 20;
export const HEAD_BOW = 16;
/** Width of the carved, painted frame round the whole row of windows. */
export const FRAME_W = 22;
/** Half width of the carved pilaster between two window lights. */
export const PILASTER_HALF = 15;
/** Leaded panes across and up each window light. */
export const PANE_COLS = 3;
export const PANE_ROWS = 6;
/** Width of a lead came between panes. */
export const CAME_W = 3.2;
/** The great beam across the stern above the windows, and the deckhead above it. */
export const BEAM_Y0 = 938;
export const BEAM_Y1 = 996;
/** Top of the stern lockers' cushion, the lockers' foot on the deck, and the chart table's near edge. */
export const SEAT_Y = 412;
export const DECK_Y = 250;
export const TABLE_Y = 116;
/** Shelves on the bookcase at the left, from the deck up to the beam. */
export const SHELVES = 4;
export const SHELF_Y0 = 270;
export const SHELF_Y1 = 930;
/** The lantern: rod length from the beam's underside to the lantern's top, and the lantern's height and half width. */
export const LANTERN_ROD = 150;
export const LANTERN_H = 124;
export const LANTERN_HALF = 34;
/** The flame's height above the lantern's foot. */
export const FLAME_UP = 54;

export interface CabinLayout {
  /** Frame width and centre, reference px. */
  readonly width: number;
  readonly cx: number;
  /** The bookcase's width at the left, and the hull side's at the right. */
  readonly shelfW: number;
  readonly sideW: number;
  /** The row of window glass, left and right (inside the frame), and how many lights it holds. */
  readonly winX0: number;
  readonly winX1: number;
  readonly lights: number;
  /** Where the lantern hangs from the beam (x; it hangs from BEAM_Y0). */
  readonly lanternX: number;
  /** The sextant and the dividers on the chart table. */
  readonly sextantX: number;
  readonly dividersX: number;
  /** Where the cannon's breech begins, coming in from the right edge. */
  readonly cannonX: number;
}

/** Target width of one window light, pilaster to pilaster. */
const LIGHT_W = 230;

/**
 * The cabin for a frame `refWidth` reference px wide. The windows span the
 * middle, an even number of lights so a pilaster stands behind the speaker's
 * head; the bookcase is at the left, the hull side and the cannon at the
 * right; the lantern hangs to the right of the speaker, and the sextant and
 * dividers lie on the table outside their shoulders.
 */
export function cabinLayout(refWidth: number): CabinLayout {
  const width = Math.max(1, Number.isFinite(refWidth) ? refWidth : 1920);
  const cx = width / 2;
  const shelfW = clamp(0.1 * width, 110, 240);
  const sideW = shelfW;
  const winX0 = Math.min(Math.max(shelfW + 50, cx - 0.36 * width), cx - 2 * (PILASTER_HALF + 60));
  const winX1 = width - winX0;
  const lights = 2 * Math.max(1, Math.round((cx - winX0) / LIGHT_W));
  const lanternX = Math.min(cx + Math.max(0.27 * width, 330), winX1 - LANTERN_HALF - 30);
  return {
    width,
    cx,
    shelfW,
    sideW,
    winX0,
    winX1,
    lights,
    lanternX,
    sextantX: cx - Math.max(0.3 * width, 480),
    dividersX: cx + Math.max(0.29 * width, 480),
    cannonX: width - Math.max(0.12 * width, 150),
  };
}

/** How far toward the middle of the row x is: 1 at the centre, 0 at either end. Mirrored in the shaders. */
function bowAt(l: CabinLayout, x: number): number {
  const u = clamp((x - l.cx) / Math.max(1, (l.winX1 - l.winX0) / 2), -1, 1);
  return 1 - u * u;
}

/** The windows' sill at x: the row bows outwards, so it stands a little higher at the middle. */
export function sillAt(l: CabinLayout, x: number): number {
  return SILL_Y + SILL_BOW * bowAt(l, x);
}

/** The windows' head at x, a little lower at the middle. */
export function headAt(l: CabinLayout, x: number): number {
  return HEAD_Y - HEAD_BOW * bowAt(l, x);
}

/* ----- The view ----- */

/** Eye level outside at rest, as a fraction of the frame height up from the bottom. */
export const HORIZON_Y = 0.6;
/** Focal length in frame heights, and the windows' height above the sea (m). */
export const FOCAL = 1;
export const EYE_HEIGHT = 6;

/* ----- The swell ----- */

/** Roll (radians) and pitch (the horizon's rise, frame heights) at `swell` = 1 in fair weather. */
export const MAX_ROLL = (3 * Math.PI) / 180;
export const MAX_PITCH = 0.04;
/** How much deeper the swell runs in a storm. */
export const STORM_SWELL = 1.5;
/**
 * The roll: a dominant 8 s period, a 9.6 s partner and a faint 6.9 s ripple,
 * repeating every 48 s. The pitch runs on its own 9.6 s and 8 s pair.
 */
export const ROLL_SWELL = createSwell(48, [
  { cycles: 6, amplitude: 1, offset: 0 },
  { cycles: 5, amplitude: 0.45, offset: 0.31 },
  { cycles: 7, amplitude: 0.2, offset: 0.62 },
]);
export const PITCH_SWELL = createSwell(48, [
  { cycles: 5, amplitude: 1, offset: 0.12 },
  { cycles: 6, amplitude: 0.4, offset: 0.71 },
]);
/** How far the lantern swings against the cabin, as a share of the roll, and how far it trails it (s). */
export const LANTERN_GAIN = 1.25;
export const LANTERN_LAG = 0.4;
/** The swell's amount follows its setting at most this fast (per second), so a change never jolts. */
export const GAIN_RATE = 0.2;

/** The swell's amount for a `swell` setting of 0..1 and a storm weight of 0..1. */
export function swellGain(swell: number, storm: number): number {
  const s = clamp(Number.isFinite(swell) ? swell : 0, 0, 1);
  return s * (1 + (STORM_SWELL - 1) * clamp(storm, 0, 1));
}

/** Eases the swell's amount toward `target` over `dt` seconds. */
export function easeGain(current: number, target: number, dt: number): number {
  return approach(current, target, Math.max(0, Number.isFinite(dt) ? dt : 0) * GAIN_RATE);
}

export interface CabinMotion {
  /** The cabin's roll (radians, positive to port); the horizon tilts on screen by its negative. */
  roll: number;
  /** The horizon's rise on screen, frame heights. */
  pitch: number;
  /** The lantern's swing against the cabin (radians, positive counter-clockwise on screen). */
  lantern: number;
}

export const createMotion = (): CabinMotion => ({ roll: 0, pitch: 0, lantern: 0 });

/**
 * The cabin's motion at swell `phase` (0..1 over ROLL_SWELL's period) and
 * swell amount `gain`. The lantern hangs plumb, so against the rolling cabin
 * it swings the other way, a little further and a moment behind.
 */
export function motionAt(phase: number, gain: number, out: CabinMotion): CabinMotion {
  const g = Math.max(0, gain);
  out.roll = g * MAX_ROLL * swellAt(ROLL_SWELL, phase);
  out.pitch = g * MAX_PITCH * swellAt(PITCH_SWELL, phase);
  out.lantern = -g * LANTERN_GAIN * MAX_ROLL * swayAt(ROLL_SWELL, phase, LANTERN_LAG);
  return out;
}

/** Where the flame sits for a lantern hanging from (px, py) swung by `angle`, into `out`. */
export function flameAt(
  px: number,
  py: number,
  angle: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  const r = LANTERN_ROD + LANTERN_H - FLAME_UP;
  out.x = px + r * Math.sin(angle);
  out.y = py - r * Math.cos(angle);
  return out;
}

/* ----- Weather ----- */

export interface WeatherLook {
  /** Weights of the three presets, easing from one to the next. */
  fair: number;
  night: number;
  storm: number;
}

export const createWeatherLook = (): WeatherLook => ({ fair: 1, night: 0, storm: 0 });

/** Seconds the weather takes to change fully from one setting to another. */
export const WEATHER_EASE = 6;

const WEATHER_TARGETS: Readonly<Record<CabinWeather, Readonly<WeatherLook>>> = {
  fair: { fair: 1, night: 0, storm: 0 },
  night: { fair: 0, night: 1, storm: 0 },
  storm: { fair: 0, night: 0, storm: 1 },
};

/**
 * Eases `look` toward `weather` over `dt` seconds and keeps the weights
 * summing to 1, so a change of weather rolls in rather than cutting. `snap`
 * jumps straight there.
 */
export function easeWeather(
  look: WeatherLook,
  weather: string,
  dt: number,
  snap = false,
): WeatherLook {
  const t = lookup(WEATHER_TARGETS, weather, "fair");
  const step = snap ? Infinity : Math.max(0, Number.isFinite(dt) ? dt : 0) / WEATHER_EASE;
  look.fair = approach(look.fair, t.fair, step);
  look.night = approach(look.night, t.night, step);
  look.storm = approach(look.storm, t.storm, step);
  const sum = look.fair + look.night + look.storm;
  if (sum > 0) {
    look.fair /= sum;
    look.night /= sum;
    look.storm /= sum;
  } else {
    look.fair = 1;
  }
  return look;
}

/** A golden late afternoon: the sun low over the sea, off to the left. */
export const FAIR_SKY: SeaPreset = {
  sky: 17.3,
  lightY: 0.15,
  disc: 0.03,
  discColor: hexToUnitRgb("#fff1c8"),
  lightColor: hexToUnitRgb("#ffc777"),
  intensity: 0.9,
  roughness: 0.014,
  deep: hexToUnitRgb("#173045"),
};

/** The three skies: fair, the Calm Sea's moonlight (lower, to stay under the windows' head), and its overcast. */
export const WEATHER_SKIES: Readonly<Record<CabinWeather, SeaPreset>> = {
  fair: FAIR_SKY,
  night: { ...SEA_PRESETS.moonlight, lightY: 0.13 },
  storm: { ...SEA_PRESETS.overcast, deep: hexToUnitRgb("#1a2328"), intensity: 0.06 },
};

/** Where the sun or moon stands across the view, frame heights from the middle. */
export const LIGHT_X: Readonly<Record<CabinWeather, number>> = {
  fair: -0.42,
  night: 0.38,
  storm: 0.1,
};

/** Per weather: cloud cover, ripple strength, the cabin's ambient light and the daylight through the windows. */
export interface WeatherTone {
  cover: number;
  wind: number;
  ambient: Rgb;
  daylight: Rgb;
}

export const WEATHER_TONES: Readonly<Record<CabinWeather, Readonly<WeatherTone>>> = {
  fair: { cover: 0.32, wind: 1, ambient: [0.4, 0.32, 0.24], daylight: [1.0, 0.78, 0.5] },
  night: { cover: 0.3, wind: 0.8, ambient: [0.03, 0.035, 0.05], daylight: [0.16, 0.2, 0.3] },
  storm: { cover: 0.92, wind: 2, ambient: [0.1, 0.105, 0.11], daylight: [0.3, 0.33, 0.36] },
};

/* ----- Lightning ----- */

/** A storm's lightning: a soft brightening of the sky that rises over LIGHTNING_RISE s and fades over LIGHTNING_FALL s. */
export const LIGHTNING_RISE = 1.2;
export const LIGHTNING_HOLD = 0.3;
export const LIGHTNING_FALL = 3;
export const LIGHTNING_LENGTH = LIGHTNING_RISE + LIGHTNING_HOLD + LIGHTNING_FALL;
/** Seconds between the starts of two glows: at least the minimum, plus up to the spread. */
export const LIGHTNING_MIN_GAP = 18;
export const LIGHTNING_GAP_SPREAD = 40;

/** The glow's level `t` seconds after it began, 0..1: smooth up, a short hold, smooth down. */
export function lightningEnvelope(t: number): number {
  if (!(t > 0) || t >= LIGHTNING_LENGTH) {
    return 0;
  }
  if (t < LIGHTNING_RISE) {
    return smoothstep(0, LIGHTNING_RISE, t);
  }
  if (t < LIGHTNING_RISE + LIGHTNING_HOLD) {
    return 1;
  }
  return 1 - smoothstep(0, LIGHTNING_FALL, t - LIGHTNING_RISE - LIGHTNING_HOLD);
}

export interface Lightning {
  rng: () => number;
  /** Seconds until the next glow may start. */
  wait: number;
  /** Seconds since the current glow began, or -1. */
  t: number;
  /** The current glow's strength, 0.6..1. */
  strength: number;
}

export function createLightning(seed: number): Lightning {
  const rng = createRng(Math.floor(seed) * 31 + 7);
  return { rng, wait: 4 + rng() * LIGHTNING_GAP_SPREAD * 0.5, t: -1, strength: 1 };
}

/**
 * Advances the lightning by `dt` seconds with the storm's weight `storm`
 * (0..1) and returns the glow's level, 0..1. Glows only begin while the
 * storm is mostly in; one already under way always finishes smoothly.
 */
export function stepLightning(l: Lightning, dt: number, storm: number): number {
  const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);
  if (l.t >= 0) {
    l.t += step;
    if (l.t >= LIGHTNING_LENGTH) {
      l.t = -1;
    }
  } else {
    l.wait -= step;
    if (l.wait <= 0) {
      l.wait = LIGHTNING_MIN_GAP + l.rng() * LIGHTNING_GAP_SPREAD;
      if (storm > 0.5) {
        l.t = 0;
        l.strength = 0.6 + 0.4 * l.rng();
      }
    }
  }
  return l.t >= 0 ? l.strength * lightningEnvelope(l.t) : 0;
}

/* ----- Distant ships ----- */

/** Seconds between two ships (end of one to the start of the next), and how long one takes to cross the view. */
export const SHIP_MIN_GAP = 40;
export const SHIP_GAP_SPREAD = 80;
export const SHIP_MIN_CROSS = 90;
export const SHIP_CROSS_SPREAD = 60;
/** A ship's height on the horizon, frame heights, at its largest. */
export const SHIP_H = 0.034;
/** Share of a crossing over which a ship fades in out of the haze, and out again. */
export const SHIP_FADE = 0.15;

export interface Ships {
  rng: () => number;
  /** Seconds until the next ship, while none is crossing. */
  wait: number;
  /** Progress across the view, 0..1, or -1 while none is crossing. */
  u: number;
  /** Seconds the current crossing takes, its direction (1 rightward) and its size (0.6..1). */
  cross: number;
  dir: number;
  size: number;
}

export function createShips(seed: number): Ships {
  const rng = createRng(Math.floor(seed) * 17 + 3);
  return { rng, wait: 8 + rng() * 30, u: -1, cross: SHIP_MIN_CROSS, dir: 1, size: 1 };
}

/** Advances the ships by `dt` seconds. */
export function stepShips(s: Ships, dt: number): void {
  const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);
  if (s.u >= 0) {
    s.u += step / s.cross;
    if (s.u >= 1) {
      s.u = -1;
      s.wait = SHIP_MIN_GAP + s.rng() * SHIP_GAP_SPREAD;
    }
    return;
  }
  s.wait -= step;
  if (s.wait <= 0) {
    s.u = 0;
    s.cross = SHIP_MIN_CROSS + s.rng() * SHIP_CROSS_SPREAD;
    s.dir = s.rng() < 0.5 ? -1 : 1;
    s.size = 0.6 + 0.4 * s.rng();
  }
}

/**
 * The crossing ship in the view, into `out`: x (frame heights from the
 * middle, from -span to span), height (frame heights) and opacity, which
 * fades in and out at the ends. Opacity 0 while no ship is crossing.
 */
export function shipView(
  s: Ships,
  span: number,
  out: { x: number; h: number; alpha: number },
): { x: number; h: number; alpha: number } {
  if (s.u < 0) {
    out.alpha = 0;
    return out;
  }
  out.x = s.dir * span * (2 * s.u - 1);
  out.h = SHIP_H * s.size;
  out.alpha = smoothstep(0, SHIP_FADE, s.u) * smoothstep(0, SHIP_FADE, 1 - s.u);
  return out;
}
