/**
 * Pure logic for the Evening News Desk (newsdesk.ts): the studio's layout, the
 * on-screen graphics' layout and text fitting, the ticker's scroll, the video
 * wall's dusk cycle and sky colours, and the graphics' reveal. Nothing here
 * touches GL, so it is all unit tested.
 *
 * Layout units are "frame units": the origin at the frame's centre, y up, and
 * one unit the frame's height, so y runs -0.5..0.5 and x -aspect/2..aspect/2.
 */
import type { Rgb } from "../color";
import { clamp, smoothstep, wrap } from "../math";

// ---------------------------------------------------------------------------
// Studio layout
// ---------------------------------------------------------------------------

/** The aspect the studio is designed for. */
export const DESIGN_ASPECT = 16 / 9;

/** A box: centre x, y and half width, half height. */
export type Box = [number, number, number, number];
/** A disc: centre x, y and radius. */
export type Disc = [number, number, number];

export interface DeskLayout {
  aspect: number;
  /**
   * The curved video wall: its half width, and its top and bottom edges at the
   * middle. The wall bows round the anchor, so its ends are nearer the camera
   * and taller: the top edge rises and the bottom edge drops by `bulge` (times
   * the square of x / hw) towards them.
   */
  wallHw: number;
  wallTop: number;
  wallBottom: number;
  bulge: number;
  /** The upright light strips on the side pieces. */
  strips: Box[];
  /** The small screens with abstract graphics, one on each side. */
  screens: [Box, Box];
  /** The glowing globe motif, high on the right. */
  globe: Disc;
  /** The desk's back edge at the middle, how much it rises towards the frame's edges, and its front lip. */
  deskTop: number;
  deskCurve: number;
  deskLip: number;
}

/** The video wall's bezel round its glass. */
export const WALL_BEZEL = 0.009;
/** How far the light strips stand in from the side pieces' ends. */
export const STRIP_INSET = 0.016;

/** The wall's top and bottom edges at `x`. */
export function wallEdges(l: DeskLayout, x: number): [number, number] {
  const s = Math.min(1, (x / l.wallHw) ** 2);
  return [l.wallTop + l.bulge * s, l.wallBottom - 0.8 * l.bulge * s];
}

/**
 * The studio for a frame of `aspect`. The video wall fills the middle behind
 * the anchor's head and shoulders, so only calm sky and skyline shows either
 * side of them; the set pieces with their strips, screens and globe stand at
 * the sides, and the desk's curved edge runs along the bottom.
 */
export function deskLayout(aspect: number): DeskLayout {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DESIGN_ASPECT;
  const half = a / 2;
  const wallHw = clamp(half - 0.27, 0.36, 0.62);
  // The side pieces run from the wall's bezel to the frame's edge, with a
  // strip near each end; the screen and globe sit between the strips.
  const inner = wallHw + WALL_BEZEL;
  const stripIn = inner + STRIP_INSET;
  const stripOut = half - STRIP_INSET;
  const room = Math.max(0.01, (stripOut - stripIn) / 2 - 0.016);
  const sideX = (stripIn + stripOut) / 2;
  const screenHw = Math.min(0.085, room);
  const screenHh = screenHw * 0.7;
  const stripHw = 0.0045;
  const strip = (x: number): Box => [x, 0.125, stripHw, 0.265];
  return {
    aspect: a,
    wallHw,
    wallTop: 0.355,
    wallBottom: -0.13,
    bulge: 0.035,
    strips: [strip(-stripIn), strip(stripIn), strip(-stripOut), strip(stripOut)],
    screens: [
      [-sideX, 0.235, screenHw, screenHh],
      [sideX, -0.015, screenHw, screenHh],
    ],
    globe: [sideX, 0.245, Math.min(0.068, 0.85 * room)],
    deskTop: -0.33,
    deskCurve: 0.07,
    deskLip: -0.4,
  };
}

// ---------------------------------------------------------------------------
// On-screen graphics
// ---------------------------------------------------------------------------

export interface GraphicsLayout {
  /** The lower third's left edge, and the widest its bars may grow. */
  left: number;
  maxWidth: number;
  /** The narrowest the bars get, however short the name. */
  minWidth: number;
  /** The name and title bars' heights. */
  nameH: number;
  titleH: number;
  /** Space between the bars' text and their ends. */
  pad: number;
  /** The ticker strip's height along the bottom of the frame. */
  tickerH: number;
  /** The lower third's bottom edge with the ticker shown, and without it. */
  bottom: number;
  bottomNoTicker: number;
  /** The LIVE tag and clock: their top-left corner and height. */
  liveX: number;
  liveY: number;
  liveH: number;
}

/**
 * Where the graphics go for a frame of `aspect`. The lower third sits on the
 * left, its bars reaching at most to where the anchor's shoulder usually is;
 * narrower frames get narrower bars, and their text shrinks to fit.
 */
export function graphicsLayout(aspect: number): GraphicsLayout {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DESIGN_ASPECT;
  const half = a / 2;
  const margin = Math.min(0.05, 0.06 * half);
  const tickerH = 0.082;
  return {
    left: -half + margin,
    maxWidth: clamp(half - margin - 0.26, 0.3, 0.7),
    minWidth: 0.22,
    nameH: 0.116,
    titleH: 0.072,
    pad: 0.02,
    tickerH,
    bottom: -0.5 + tickerH + 0.018,
    bottomNoTicker: -0.5 + 0.04,
    liveX: -half + margin,
    liveY: 0.5 - margin,
    liveH: 0.08,
  };
}

/**
 * The font size that fits a line `emWidth` font-sizes wide into `maxWidth`,
 * no bigger than `maxSize`: long names and titles shrink, short ones don't grow.
 */
export function fitTextSize(emWidth: number, maxSize: number, maxWidth: number): number {
  if (!(emWidth > 0) || !(maxWidth > 0)) {
    return Math.max(0, maxSize);
  }
  return Math.max(0, Math.min(maxSize, maxWidth / emWidth));
}

/** The bars' width: the wider text line plus padding, within [minWidth, maxWidth]. */
export function barWidth(textWidth: number, g: GraphicsLayout): number {
  return clamp(textWidth + 2 * g.pad, g.minWidth, Math.max(g.minWidth, g.maxWidth));
}

/** The ticker's stories: runs of three or more spaces split them, and a bullet joins them. */
export function tickerLine(text: string): string {
  return text
    .split(/\s{3,}/)
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join("   •   ");
}

// ---------------------------------------------------------------------------
// Ticker scroll
// ---------------------------------------------------------------------------

/** Texels per row of the ticker's strip texture; longer strips wrap onto more rows. */
export const TICKER_ROW = 2048;
/** The ticker's speed at 1080p, in pixels per second. */
export const TICKER_SPEED = 60;

/**
 * The ticker's speed in device pixels a second: about `TICKER_SPEED` times
 * `speed` at 1080p, rounded so a 60 Hz frame moves it a whole number of pixels
 * (at least one). A `speed` of 0 or less stops it.
 */
export function tickerSpeed(scale: number, speed = 1): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const k = Number.isFinite(speed) ? speed : 1;
  if (k <= 0) {
    return 0;
  }
  return Math.max(1, Math.round((TICKER_SPEED * s * k) / 60)) * 60;
}

/**
 * Advances the ticker's position (device pixels into a strip `period` texels
 * long) by `dt` seconds at `speed`, wrapped into [0, period). The strip repeats
 * every period, so wrapping never moves the text.
 */
export function stepTicker(pos: number, dt: number, speed: number, period: number): number {
  if (!(period > 0)) {
    return 0;
  }
  const step = Number.isFinite(dt) && dt > 0 ? dt * speed : 0;
  return wrap(pos + step, 0, period);
}

/** The whole-pixel offset the ticker shows at `pos`, in [0, period). */
export function tickerOffset(pos: number, period: number): number {
  if (!(period > 0)) {
    return 0;
  }
  const o = Math.round(pos);
  return o >= period ? o - period : o;
}

/** The strip texel that screen column `x` shows at `offset`: column and row in the texture. */
export function tickerTexel(x: number, offset: number, period: number): [number, number] {
  const i = (((x + offset) % period) + period) % period;
  return [i % TICKER_ROW, Math.floor(i / TICKER_ROW)];
}

// ---------------------------------------------------------------------------
// The video wall's sky
// ---------------------------------------------------------------------------

/** Seconds per dusk cycle: sunset into night and back. */
export const DUSK_PERIOD = 600;
/** The dusk levels: 0 midday, about 0.5 sunset, 1 full night. */
export const DUSK_SUNSET = 0.38;
/** Seconds a change of skyline setting takes to blend in. */
export const DUSK_BLEND = 6;

/**
 * The dusk level `t` seconds into the cycle: five minutes from sunset into
 * night, a minute and a half of night, three minutes back to sunset, then a
 * moment of sunset again, all on smooth ramps.
 */
export function duskCycle(t: number): number {
  const s = wrap(Number.isFinite(t) ? t : 0, 0, DUSK_PERIOD);
  const down = 300;
  const hold = 90;
  const up = 180;
  let k: number;
  if (s < down) {
    k = smoothstep(0, down, s);
  } else if (s < down + hold) {
    k = 1;
  } else if (s < down + hold + up) {
    k = 1 - smoothstep(down + hold, down + hold + up, s);
  } else {
    k = 0;
  }
  return DUSK_SUNSET + (1 - DUSK_SUNSET) * k;
}

/** The dusk level the skyline setting ("cycle", "day" or "night") asks for at `t`. */
export function duskTarget(mode: string, t: number): number {
  if (mode === "day") {
    return 0;
  }
  if (mode === "night") {
    return 1;
  }
  return duskCycle(t);
}

/** Sky keyframes: dusk level, then the zenith and horizon colours. */
const SKY_KEYS: readonly (readonly [number, Rgb, Rgb])[] = [
  [0, [0.16, 0.38, 0.74], [0.62, 0.77, 0.92]],
  [0.25, [0.2, 0.33, 0.62], [0.96, 0.74, 0.46]],
  [0.45, [0.15, 0.17, 0.4], [0.98, 0.46, 0.2]],
  [0.65, [0.05, 0.07, 0.22], [0.42, 0.24, 0.36]],
  [0.82, [0.02, 0.035, 0.12], [0.12, 0.11, 0.24]],
  [1, [0.01, 0.018, 0.06], [0.05, 0.07, 0.16]],
];

/** The sky's zenith and horizon colours at dusk level `e`, written into `zenith` and `horizon`. */
export function skyColours(e: number, zenith: Rgb, horizon: Rgb): void {
  const d = clamp(Number.isFinite(e) ? e : 0, 0, 1);
  let i = 0;
  while (i < SKY_KEYS.length - 2 && d > SKY_KEYS[i + 1][0]) {
    i++;
  }
  const [d0, z0, h0] = SKY_KEYS[i];
  const [d1, z1, h1] = SKY_KEYS[i + 1];
  const t = smoothstep(d0, d1, d);
  for (let c = 0; c < 3; c++) {
    zenith[c] = z0[c] + (z1[c] - z0[c]) * t;
    horizon[c] = h0[c] + (h1[c] - h0[c]) * t;
  }
}

/** The sun's height above the horizon at dusk level `e` (wall heights; negative once set). */
export function sunHeight(e: number): number {
  return 0.42 - 0.95 * clamp(e, 0, 1);
}

/** How dark it is for the city's lights, 0 by day to 1 at night. */
export function nightLevel(e: number): number {
  return smoothstep(0.3, 0.85, e);
}

/** The share of windows lit at dusk level `e`: a few by day, most of the offices by night. */
export function litFraction(e: number): number {
  return 0.06 + 0.4 * nightLevel(e);
}

// ---------------------------------------------------------------------------
// Graphics reveal and the clock
// ---------------------------------------------------------------------------

/** Seconds the lower third, ticker and LIVE tag take to slide and fade in or out. */
export const REVEAL_SECONDS = 0.9;
/** Seconds after start before the graphics come in. */
export const REVEAL_DELAY = 0.7;

/** A reveal's starting level: below zero, so it waits `delay` seconds before it shows. */
export function revealStart(delay: number): number {
  return -Math.max(0, delay) / REVEAL_SECONDS;
}

/** Moves a reveal level towards 1 (shown) or 0 (hidden) at the reveal's pace. */
export function stepReveal(level: number, shown: boolean, dt: number): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt / REVEAL_SECONDS : 0;
  if (shown) {
    return Math.min(1, level + step);
  }
  return level > 0 ? Math.max(0, level - step) : level;
}

/** How visible a reveal level is, eased: 0 hidden (or still waiting), 1 fully in. */
export function revealShown(level: number): number {
  return smoothstep(0, 1, level);
}

/** The minute of the day (0..1439) at a day phase (0 midnight, 0.5 noon). */
export function dayMinute(phase: number): number {
  return Math.floor(wrap(Number.isFinite(phase) ? phase : 0, 0, 1) * 1440) % 1440;
}

/** The clock's "HH:MM" for a day phase. */
export function clockText(phase: number): string {
  const minutes = dayMinute(phase + 1e-9);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
