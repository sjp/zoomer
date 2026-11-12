import type { Rgb } from "./color";
import { clamp } from "./math";
import { MAX_PATTERN_HZ } from "./motion-limits";

/**
 * The look shared by the line screensavers (Mystify, Béziers): thin lines whose
 * colour drifts round the hue wheel, each trailed by discrete echoes of itself
 * sampled every few simulation steps, in a Classic or a Modern style.
 *
 * Classic draws every echo at full brightness in the figure's current colour,
 * as the originals did; Modern keeps each echo in the colour it was drawn in,
 * fades it with age, and adds a soft glow under every line. `styleMix` runs from
 * 0 (Classic) to 1 (Modern), so a style change can cross over smoothly.
 */

/** Simulation steps per second. */
export const ECHO_SIM_RATE = 60;

/**
 * Echoes are sampled about this far apart (frame heights) along a point's path,
 * as in the originals, where a fan of evenly spaced copies traces each figure.
 */
const ECHO_SPACING = 0.03;
/**
 * Steps between echoes, at least: each echo passes a screen point after the one
 * before, so their interval sets the trail's flicker rate, held under the codec's
 * pattern limit.
 */
export const MIN_ECHO_STEPS = Math.ceil(ECHO_SIM_RATE / MAX_PATTERN_HZ) + 3;
/** At most: at the slowest speeds, echoes bunch closer rather than lag for seconds. */
const MAX_ECHO_STEPS = 90;

/** Line half widths in reference px: Classic's crisp 1 px-like line, and Modern's. */
const CLASSIC_HALF_WIDTH = 0.75;
const MODERN_HALF_WIDTH = 1;
/** Modern's glow: a wider, dimmer line under each line. */
const GLOW_HALF_WIDTH = 4;
const GLOW_BRIGHTNESS = 0.22;
/** Colour saturation in each style: the pure spectrum, and a slightly softer one. */
const CLASSIC_SATURATION = 1;
const MODERN_SATURATION = 0.8;

/** Steps between echoes when points move at `speed` frame heights per second. */
export function echoSteps(speed: number): number {
  const perStep = Math.max(speed, 1e-6) / ECHO_SIM_RATE;
  return clamp(Math.round(ECHO_SPACING / perStep), MIN_ECHO_STEPS, MAX_ECHO_STEPS);
}

/** One channel of an HSV colour: `n` is 5 for red, 3 for green, 1 for blue. */
function hsvChannel(n: number, h: number, s: number): number {
  const k = (n + (h - Math.floor(h)) * 6) % 6;
  return 1 - s * Math.max(0, Math.min(k, 4 - k, 1));
}

/** The full-value colour at hue `h` (turns) and saturation `s`, into `out`. */
export function hueRgb(h: number, s: number, out: Rgb): Rgb {
  out[0] = hsvChannel(5, h, s);
  out[1] = hsvChannel(3, h, s);
  out[2] = hsvChannel(1, h, s);
  return out;
}

/** Line sizes and colour for a style, from `echoLineLook`. Sizes are in px. */
export interface EchoLineLook {
  halfWidth: number;
  glowWidth: number;
  /** Glow brightness relative to its line; 0 for no glow. */
  glow: number;
  saturation: number;
}

/** The look at `styleMix` (0 Classic, 1 Modern) for `scale` px per reference px, into `out`. */
export function echoLineLook(styleMix: number, scale: number, out: EchoLineLook): EchoLineLook {
  out.halfWidth =
    (CLASSIC_HALF_WIDTH + (MODERN_HALF_WIDTH - CLASSIC_HALF_WIDTH) * styleMix) * scale;
  out.glowWidth = GLOW_HALF_WIDTH * scale;
  out.glow = GLOW_BRIGHTNESS * styleMix;
  out.saturation = CLASSIC_SATURATION + (MODERN_SATURATION - CLASSIC_SATURATION) * styleMix;
  return out;
}

/**
 * Brightness of the `k`-th echo (1 is the newest after the figure itself) when
 * `trailMix` echoes show (fractional while the count eases, fading the last one)
 * and the next sample is `phase` (0–1) of the way due: full in Classic, fading
 * with age in Modern.
 */
export function echoBrightness(k: number, trailMix: number, phase: number, styleMix: number) {
  const weight = clamp(trailMix - k + 1, 0, 1);
  const age = Math.max(0, 1 - (k - 1 + phase) / Math.max(trailMix, 1));
  return weight * (1 + (age - 1) * styleMix);
}

/** An echo's colour: the figure's colour `now` in Classic, the echo's own `then` in Modern. */
export function echoColor(now: Rgb, then: Rgb, styleMix: number, out: Rgb): Rgb {
  out[0] = now[0] + (then[0] - now[0]) * styleMix;
  out[1] = now[1] + (then[1] - now[1]) * styleMix;
  out[2] = now[2] + (then[2] - now[2]) * styleMix;
  return out;
}
