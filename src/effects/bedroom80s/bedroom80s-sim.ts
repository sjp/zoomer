/**
 * Pure logic for the 1980s Bedroom (bedroom80s.ts): the room's layout, the
 * demo's sine scroller, the "loading stripes" pattern, the prompt's cursor,
 * the headlights that sweep across the ceiling, the screen modes' crossfade and
 * the glow the screen casts, and the cassette deck's reels. Nothing here touches
 * GL, so it is all unit tested.
 *
 * Layout units are "design units": the origin at the frame's centre, y up, and
 * one unit the frame's height at 16:9, with the computer on the left. The
 * effect mirrors x for a computer on the right, and scales the whole room down
 * to fit narrower frames (see `fitScale`).
 *
 * Nothing in the room may flicker. Every light that repeats or moves (the
 * stripes, the cursor, the headlights, the screen's glow, the bedside lamp)
 * changes no faster than the comfort limits below, which the tests check.
 */
import type { Rgb } from "../color";
import { approach, clamp, fract, smoothstep } from "../math";
import { GLYPH_W, glyphIndex } from "../dot-matrix";
import { hash32 } from "../noise";
import { SCROLLER_MAX_LENGTH } from "./bedroom80s.meta";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Comfort limits
// ---------------------------------------------------------------------------

/**
 * The fastest any repeating light (the stripes, the cursor, the screen's glow)
 * may change in luminance, per second, as a share of full scale.
 */
export const COMFORT_RATE = 0.35;
/** The shortest time any change of a light's colour, or any bright event, may take (s). */
export const MIN_RAMP = 1;
/** The fastest any light may repeat (Hz): far below the 3 Hz where flashing starts to hurt. */
export const MAX_REPEAT_HZ = 0.5;

/** Relative luminance (Rec. 709 weights). */
export const luma = (c: Readonly<Rgb>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** The aspect the room is drawn for. */
export const DESIGN_ASPECT = 16 / 9;

/** A box: centre x, y and half width, half height. */
export type Box = readonly [number, number, number, number];

/** Where the back wall meets the ceiling. */
export const CEILING_Y = 0.39;
/** The desk: its back edge, the top of its front edge, and how far it reaches towards the middle. */
export const DESK_BACK = -0.15;
export const DESK_FRONT = -0.33;
export const DESK_END = -0.22;
/** The CRT's picture (the tube's face), and the monitor's beige case round it. */
export const SCREEN: Box = [-0.6, 0.08, 0.118, 0.09];
export const MONITOR: Box = [-0.6, 0.068, 0.158, 0.136];
/** The computer: a beige wedge with its keyboard, lying on the desk in front of the monitor. */
export const KEYBOARD: Box = [-0.6, -0.245, 0.17, 0.042];
/** The cassette recorder on the desk beside the monitor, the window over its tape, and its two reels' radius. */
export const DECK: Box = [-0.823, -0.106, 0.058, 0.044];
export const DECK_WINDOW: Box = [-0.823, -0.093, 0.04, 0.016];
export const REEL_R = 0.0115;
/** The two reels' centres. */
export const REELS: readonly (readonly [number, number])[] = [
  [-0.845, -0.093],
  [-0.801, -0.093],
];
/** A stack of cassettes in their cases, on the desk's other side of the monitor. */
export const CASSETTES: Box = [-0.375, -0.118, 0.048, 0.032];
/** The joystick's base on the desk. */
export const JOYSTICK: Box = [-0.835, -0.262, 0.036, 0.018];
/** The three posters: a neon sunset, a space scene and a sports car's silhouette. */
export const POSTER_SUNSET: Box = [-0.73, 0.3, 0.09, 0.07];
export const POSTER_SPACE: Box = [-0.43, 0.29, 0.07, 0.085];
export const POSTER_CAR: Box = [0.37, 0.27, 0.105, 0.07];
/** The wall shelf (the plank's top surface's middle and half size). */
export const SHELF: Box = [0.37, -0.048, 0.14, 0.008];
/** The radio on the shelf. */
export const RADIO: Box = [0.37, -0.008, 0.048, 0.032];
/** The lava lamp's glass, standing on its base on the shelf: centre and half size. */
export const LAMP_GLASS: Box = [0.468, 0.075, 0.026, 0.078];
/** The lava lamp's light: where it seems to come from. */
export const LAMP_LIGHT: readonly [number, number] = [0.468, 0.07];
/** The window with its blinds (the glass, inside its frame) and the frame's width. */
export const WINDOW: Box = [0.69, 0.165, 0.15, 0.175];
export const WINDOW_FRAME = 0.016;
/** The bedside table's top (centre, half size) and the bedside lamp's bulb. */
export const TABLE: Box = [0.77, -0.205, 0.15, 0.01];
export const BULB: readonly [number, number] = [0.79, -0.095];
/** The duvet's top edge, along the bottom on the window's side. */
export const BED_TOP = -0.3;

// ---------------------------------------------------------------------------
// The demo screen
// ---------------------------------------------------------------------------

/** The computer's picture, in its own pixels. */
export const DEMO_W = 320;
export const DEMO_H = 200;
/** The "paper" inside the border, for the prompt and the loading screen: left, top, width, height (y down). */
export const PAPER: readonly [number, number, number, number] = [32, 20, 256, 160];

/** The scroller's letters are the dot-matrix font scaled up this much. */
export const GLYPH_SCALE = 2;
/** The scroller's letter pitch, in demo pixels: a glyph and one blank column. */
export const CELL = (GLYPH_W + 1) * GLYPH_SCALE;
/** Spaces after the message before it comes round again. */
export const SCROLL_GAP = 8;
/** The scroller's speed (demo pixels a second): two or three letters a second, easy to read. */
export const SCROLL_SPEED = 30;
/** The longest the scroller's glyph row can be. */
export const MAX_CODES = SCROLLER_MAX_LENGTH + SCROLL_GAP;

/**
 * Writes the scroller's glyph indices into `out`: the message (capitals; any
 * character the font lacks shows as a space), then `SCROLL_GAP` spaces.
 * Returns how many it wrote.
 */
export function scrollerCodes(text: string, out: Uint8Array): number {
  let n = 0;
  for (const ch of text) {
    if (n >= SCROLLER_MAX_LENGTH || n >= out.length) {
      break;
    }
    out[n++] = ch === "\n" ? 0 : glyphIndex(ch);
  }
  // A message of nothing but spaces scrolls nothing.
  let blank = true;
  for (let i = 0; i < n; i++) {
    blank &&= out[i] === 0;
  }
  if (blank) {
    n = 0;
  }
  for (let i = 0; i < SCROLL_GAP && n < out.length; i++) {
    out[n++] = 0;
  }
  return n;
}

/** Demo pixels the scroller travels before it repeats. */
export const scrollerPeriod = (len: number) => Math.max(1, len) * CELL;

/** The scroller's offset after travelling `distance` demo pixels, wrapped to its period. */
export function scrollOffset(distance: number, len: number): number {
  const p = scrollerPeriod(len);
  const d = Number.isFinite(distance) ? distance : 0;
  return fract(d / p) * p;
}

/**
 * The glyph index the scroller shows at demo column `x` with offset `offset`
 * (the shader's twin): the text runs leftwards, repeating every
 * `scrollerPeriod(len)` pixels.
 */
export function scrollerGlyph(codes: Uint8Array, len: number, x: number, offset: number): number {
  const n = Math.max(1, len);
  const ci = Math.floor((x + offset) / CELL);
  return codes[((ci % n) + n) % n] ?? 0;
}

/** The sine scroller's baseline (demo pixels from the top) and how far it swings. */
export const SCROLL_Y = 150;
export const SCROLL_SWING = 9;

/** The prompt's lines, on a made-up home computer's start-up screen. */
export const PROMPT_LINES: readonly string[] = [
  "MICRO BASIC 2.1",
  "32768 BYTES FREE",
  "",
  "READY.",
  "LOAD",
  "",
  "SEARCHING",
  "READY.",
];
/** The loading screen's one line. */
export const LOADING_LINE = "LOADING";

/** The cursor's pulse: its period (s), middle and swing (shares of the text's brightness). */
export const CURSOR_PERIOD = 3;
export const CURSOR_MID = 0.72;
export const CURSOR_SWING = 0.16;

/**
 * The prompt cursor's brightness at `t` seconds, as a share of the text's: a
 * slow, shallow pulse rather than a hard blink.
 */
export function cursorLevel(t: number): number {
  const s = Number.isFinite(t) ? t : 0;
  return CURSOR_MID + CURSOR_SWING * Math.cos((TAU * s) / CURSOR_PERIOD);
}

// ---------------------------------------------------------------------------
// Loading stripes
// ---------------------------------------------------------------------------

/**
 * The stripes' colours, in order: muted, and all of nearly the same luminance,
 * so the border changes hue as they pass but hardly changes brightness.
 */
export const STRIPE_PALETTE: readonly Rgb[] = [
  [0.46, 0.25, 0.24],
  [0.2, 0.33, 0.36],
  [0.38, 0.31, 0.18],
  [0.3, 0.26, 0.48],
];
/** Stripes down the screen's height. */
export const STRIPE_BANDS = 6;
/** Stripes passing any point per second: a new colour every four seconds. */
export const STRIPE_SPEED = 0.25;
/** The share of a stripe spent blending into the next: two seconds at any point. */
export const STRIPE_EDGE = 0.5;

/** The stripes' phase (stripes travelled) at `t` seconds, wrapped to the palette's length. */
export function stripePhase(t: number): number {
  const n = STRIPE_PALETTE.length;
  const s = Number.isFinite(t) ? t : 0;
  return fract((s * STRIPE_SPEED) / n) * n;
}

/**
 * The border's colour at `v` (0 at the screen's top, 1 at its bottom) and
 * stripe phase `phase`, into `out`: wide flat stripes drifting slowly up the
 * screen, each blending softly into the next. The shader's twin.
 */
export function stripeColor(v: number, phase: number, out: Rgb): Rgb {
  const n = STRIPE_PALETTE.length;
  const s = v * STRIPE_BANDS + phase;
  const i = Math.floor(s);
  const w = smoothstep(1 - STRIPE_EDGE, 1, s - i);
  const a = STRIPE_PALETTE[((i % n) + n) % n];
  const b = STRIPE_PALETTE[(((i + 1) % n) + n) % n];
  for (let k = 0; k < 3; k++) {
    out[k] = a[k] + (b[k] - a[k]) * w;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Screen modes and the screen's glow
// ---------------------------------------------------------------------------

/** The screen modes, in the order of their crossfade weights. */
export const MODES = ["demo", "stripes", "prompt"] as const;
/** Seconds for one mode to fade into another. */
export const MODE_FADE = 1.2;

/** The mode's index in `MODES` (the demo for unknown modes). */
export function modeIndex(mode: string): number {
  const i = (MODES as readonly string[]).indexOf(mode);
  return i < 0 ? 0 : i;
}

/**
 * Moves the modes' weights towards `mode` for `dt` seconds, a full crossfade
 * taking `MODE_FADE`. NaN weights (the first frame) snap to the mode.
 */
export function stepModes(weights: Float64Array, mode: string, dt: number): Float64Array {
  const target = modeIndex(mode);
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0) / MODE_FADE;
  for (let i = 0; i < MODES.length; i++) {
    const goal = i === target ? 1 : 0;
    weights[i] = Number.isFinite(weights[i]) ? approach(clamp(weights[i], 0, 1), goal, step) : goal;
  }
  return weights;
}

/** The average colour of the demo, and of the prompt's screen, as they light the room. */
export const DEMO_GLOW: Rgb = [0.3, 0.24, 0.5];
export const PROMPT_GLOW: Rgb = [0.24, 0.26, 0.62];
/** The loading screen's dark paper. */
export const LOADING_PAPER: Rgb = [0.05, 0.05, 0.07];
const PAPER_SHARE = (PAPER[2] * PAPER[3]) / (DEMO_W * DEMO_H);
const GLOW_SAMPLES = 12;
const stripeScratch: Rgb = [0, 0, 0];

/**
 * The colour the screen casts on the room for the modes' `weights` and the
 * stripes' `phase`, into `out`: each mode's average colour, the loading screen's
 * averaged over its border.
 */
export function screenGlow(weights: Float64Array, phase: number, out: Rgb): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let j = 0; j < GLOW_SAMPLES; j++) {
    stripeColor((j + 0.5) / GLOW_SAMPLES, phase, stripeScratch);
    r += stripeScratch[0];
    g += stripeScratch[1];
    b += stripeScratch[2];
  }
  const border = (1 - PAPER_SHARE) / GLOW_SAMPLES;
  const stripes: Rgb = stripeScratch;
  stripes[0] = r * border + LOADING_PAPER[0] * PAPER_SHARE;
  stripes[1] = g * border + LOADING_PAPER[1] * PAPER_SHARE;
  stripes[2] = b * border + LOADING_PAPER[2] * PAPER_SHARE;
  for (let k = 0; k < 3; k++) {
    out[k] = weights[0] * DEMO_GLOW[k] + weights[1] * stripes[k] + weights[2] * PROMPT_GLOW[k];
  }
  return out;
}

/** Moves each channel of `current` towards `target` by at most `rate` a second. */
export function slewColor(current: Rgb, target: Readonly<Rgb>, rate: number, dt: number): Rgb {
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0) * rate;
  for (let k = 0; k < 3; k++) {
    current[k] = Number.isFinite(current[k]) ? approach(current[k], target[k], step) : target[k];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Headlights across the ceiling
// ---------------------------------------------------------------------------

/** One car in every slot of this many seconds… */
export const SWEEP_SLOT = 90;
/** …passing somewhere in this middle share of its slot, so they come every minute or two. */
export const SWEEP_SPREAD = 0.6;
/** The first car passes this soon. */
export const FIRST_SWEEP = 20;
/** Seconds a sweep takes to cross the ceiling. */
export const SWEEP_TIME = 9;
/** Where the light starts (above the window) and ends (past the room's far side), in design x. */
export const SWEEP_FROM = 0.75;
export const SWEEP_TO = -1.15;
/** The patch of light's half width (design units) and its brightest. */
export const HEADLIGHT_WIDTH = 0.35;
export const HEADLIGHT_PEAK = 0.22;

/** When the car in `slot` starts its sweep (s). */
export function sweepStart(slot: number): number {
  if (slot < 1) {
    return FIRST_SWEEP;
  }
  const u = hash32(hash32(slot + 0x80c) ^ 0x2c1b3c6d) / 4294967296;
  return slot * SWEEP_SLOT + SWEEP_SLOT * ((1 - SWEEP_SPREAD) / 2 + SWEEP_SPREAD * u);
}

/** Seconds into the sweep under way at `t`, or -1 when no car is passing. */
export function sweepAt(t: number): number {
  if (!(t >= 0) || !Number.isFinite(t)) {
    return -1;
  }
  const slot = Math.floor(t / SWEEP_SLOT);
  for (let s = slot; s >= Math.max(0, slot - 1); s--) {
    const into = t - sweepStart(s);
    if (into >= 0 && into <= SWEEP_TIME) {
      return into;
    }
  }
  return -1;
}

/** Where the patch of light is `s` seconds into a sweep (design x, window on +x). */
export function sweepPos(s: number): number {
  return SWEEP_FROM + (SWEEP_TO - SWEEP_FROM) * clamp(s / SWEEP_TIME, 0, 1);
}

/** How bright the whole sweep is `s` seconds in: easing in and out over its whole length. */
export function sweepEnvelope(s: number): number {
  if (!(s >= 0 && s <= SWEEP_TIME)) {
    return 0;
  }
  const e = Math.sin((Math.PI * s) / SWEEP_TIME);
  return e * e;
}

/**
 * The headlights' light on the ceiling at design x (window on +x), `s`
 * seconds into a sweep (0 outside one): a soft patch drifting across from the
 * window, fading in and out. The blinds' slats run along the sweep, so the
 * stripes they cast stay put while the patch moves; nothing flickers.
 */
export function headlightAt(x: number, s: number): number {
  const env = sweepEnvelope(s);
  if (env === 0) {
    return 0;
  }
  const d = (x - sweepPos(s)) / HEADLIGHT_WIDTH;
  return HEADLIGHT_PEAK * env * Math.exp(-d * d);
}

// ---------------------------------------------------------------------------
// Fades, and the cassette's reels
// ---------------------------------------------------------------------------

/** Seconds for the bedside lamp to come up or go down. */
export const BEDSIDE_FADE = 1.5;

/** A light's level (0..1) after `dt` seconds fading towards on or off over `seconds`. */
export function stepFade(level: number, on: boolean, dt: number, seconds: number): number {
  const from = Number.isFinite(level) ? clamp(level, 0, 1) : on ? 1 : 0;
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0) / Math.max(1e-6, seconds);
  return approach(from, on ? 1 : 0, step);
}

/** The reels' turning speed while playing (radians a second), and seconds to get up to speed or stop. */
export const REEL_SPEED = 2.4;
export const REEL_SPIN_UP = 0.6;

export interface Reels {
  /** The reels' angle (radians, counter-clockwise), wrapped to 0..2π. */
  angle: number;
  /** Share of full speed, 0..1. */
  speed: number;
}

export const createReels = (): Reels => ({ angle: 0, speed: Number.NaN });

/** Turns the reels for `dt` seconds, easing up to speed while `playing` and to a stop when not. */
export function stepReels(r: Reels, playing: boolean, dt: number): Reels {
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  r.speed = Number.isFinite(r.speed)
    ? approach(r.speed, playing ? 1 : 0, step / REEL_SPIN_UP)
    : playing
      ? 1
      : 0;
  // Clockwise, as a tape plays.
  r.angle = fract((r.angle - r.speed * REEL_SPEED * step) / TAU) * TAU;
  return r;
}
