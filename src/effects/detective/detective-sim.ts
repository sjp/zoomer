/**
 * 1940s Detective Office's timing and text, apart from GL: the sign across the
 * street blinking on and off, the ceiling fan turning, the film's weave and
 * grain clock, the tones, and how the door's lettering is sized to its panel.
 */
import { approach, smoothstep } from "../math";
import { capPatternSpeed } from "../motion-limits";
import { hash32 } from "../noise";

/** Seconds the sign stays on, and off, drawn afresh for each blink. */
export const SIGN_ON = [4, 8] as const;
export const SIGN_OFF = [1, 3] as const;
/** Seconds each change of the sign's level takes (a smoothstep, so its steepest is 1.5 times the mean). */
export const SIGN_RAMP = 0.6;
/** The sign's level while it's off: one of its tubes stays lit, so the room never drops to dark. */
export const SIGN_LOW = 0.3;
/** Seconds the sign takes to fade away, or back, when it's switched off or on. */
export const SIGN_SWITCH = 1.2;

/**
 * The light through the blinds: the street lamps' steady share and the sign's
 * share at full. While the sign blinks, the light swings between
 * `STREET_LIGHT + SIGN_LIGHT * SIGN_LOW` and `STREET_LIGHT + SIGN_LIGHT`.
 */
export const STREET_LIGHT = 0.45;
export const SIGN_LIGHT = 0.8;
/** The most the blinking may change the light through the blinds, as a share of its brightest. */
export const MAX_SIGN_SWING = 0.5;

interface SignState {
  readonly seed: number;
  /** Whether the sign is (heading) on in its schedule. */
  on: boolean;
  /** Seconds until the schedule's next change. */
  left: number;
  /** Changes so far, which picks each new duration. */
  count: number;
  /** Progress of the ramp between low (0) and full (1), linear in time. */
  ramp: number;
  /** How far the sign is switched on by its param, 0..1; NaN before the first step. */
  enabled: number;
}

/** Seconds the sign holds after its `n`th change, in the state that change put it in. */
export function signDuration(seed: number, n: number, on: boolean): number {
  const h = hash32((Math.imul(Math.trunc(seed), 0x2c1b3c6d) ^ n) >>> 0) / 4294967296;
  const [lo, hi] = on ? SIGN_ON : SIGN_OFF;
  return lo + h * (hi - lo);
}

export function createSign(seed: number): SignState {
  return {
    seed,
    on: true,
    left: signDuration(seed, 0, true),
    count: 0,
    ramp: 1,
    enabled: Number.NaN,
  };
}

/** The sign's brightness, 0..1: 0 when switched off, else between SIGN_LOW and 1. */
function signLevel(s: SignState): number {
  const enabled = Number.isFinite(s.enabled) ? s.enabled : 0;
  return enabled * (SIGN_LOW + (1 - SIGN_LOW) * smoothstep(0, 1, s.ramp));
}

/**
 * Advances the sign by `dt` seconds and returns its level. Its schedule keeps
 * running while it's switched off, so it comes back mid-cycle; the first step
 * takes the switch's state without fading.
 */
export function stepSign(s: SignState, dt: number, enabled: boolean): number {
  const t = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const want = enabled ? 1 : 0;
  s.enabled = Number.isFinite(s.enabled) ? approach(s.enabled, want, t / SIGN_SWITCH) : want;
  s.left -= t;
  while (s.left <= 0) {
    s.count++;
    s.on = !s.on;
    s.left += signDuration(s.seed, s.count, s.on);
  }
  s.ramp = approach(s.ramp, s.on ? 1 : 0, t / SIGN_RAMP);
  return signLevel(s);
}

/** The ceiling fan's blades, and its speed when on (turns a second). */
export const FAN_BLADES = 4;
export const FAN_TURNS = 0.2;
/** Seconds the fan takes to spin up from still to full speed, or to run down. */
const FAN_SPIN = 5;

interface FanState {
  /** Turns a second. */
  speed: number;
  /** The blades' angle, in turns, wrapped to one blade's share of a turn (the pattern repeats there). */
  angle: number;
}

export function createFan(): FanState {
  return { speed: Number.NaN, angle: 0.03 };
}

/**
 * Advances the fan by `dt` seconds: it spins up or runs down over FAN_SPIN
 * seconds, and its blades' shadows never pass a point faster than the codec
 * limit. The first step takes the switch's speed at once.
 */
export function stepFan(f: FanState, dt: number, on: boolean): void {
  const t = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const want = on ? FAN_TURNS : 0;
  const speed = Number.isFinite(f.speed)
    ? approach(f.speed, want, (t * FAN_TURNS) / FAN_SPIN)
    : want;
  f.speed = capPatternSpeed(speed, 1 / FAN_BLADES);
  const a = f.angle + f.speed * t;
  f.angle = a - Math.floor(a * FAN_BLADES) / FAN_BLADES;
}

/** The film's grain holds each pattern this long: it changes at 12 frames a second. */
export const GRAIN_HZ = 12;

/** The gate weave's reach, in px at 1080p: a slow, slight drift of the picture. */
export const WEAVE_PX = 0.6;

/** The picture's weave at `time` seconds, in px at 1080p, into `out` (x, y). */
export function gateWeave(time: number, out: Float64Array): Float64Array {
  const t = Number.isFinite(time) ? time : 0;
  const tau = 2 * Math.PI;
  out[0] = WEAVE_PX * (0.6 * Math.sin((tau * t) / 1.7) + 0.4 * Math.sin((tau * t) / 0.93 + 1.3));
  out[1] = WEAVE_PX * (0.7 * Math.sin((tau * t) / 2.3 + 0.4) + 0.3 * Math.sin((tau * t) / 1.1 + 2));
  return out;
}

/**
 * Each tone's values, eased as one block: how much colour is kept (0 is
 * black and white), the print's tint (RGB), and the sign's colour (RGB). The
 * sign is red in colour; in the others only its brightness shows.
 */
export const TONE_FLOATS = 7;
export const TONES: Readonly<Record<string, readonly number[]>> = {
  mono: [0, 1, 1, 1, 1, 1, 1],
  sepia: [0, 1.1, 0.95, 0.74, 1, 1, 1],
  colour: [0.6, 1, 1, 1, 1.7, 0.4, 0.32],
};

/** The lettering's room on the door panel, in canvas px. */
export const DOOR_CANVAS_W = 600;
export const DOOR_CANVAS_H = 520;
/** Margin around the lettering, in canvas px. */
export const DOOR_MARGIN = 40;
/** Largest letter size (px), and each line's height per px of letter size. */
const DOOR_MAX_SIZE = 120;
export const DOOR_LINE_HEIGHT = 1.25;

/** The door's lines to paint: the text's lines, without trailing blank ones; none for empty text. */
export function doorLines(text: string): string[] {
  const lines = text.split("\n").map((l) => l.trim());
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Letter size (px) for each of `lines`, into `out`: as big as fits, each line
 * sized to its own width (so a short name stands larger than a long title,
 * as a sign painter would letter it) and all of them together in the panel's
 * height. `measure(text, size)` is the text's width at a letter size.
 */
export function fitDoorText(
  lines: readonly string[],
  measure: (text: string, size: number) => number,
  out: number[],
): number[] {
  out.length = 0;
  if (lines.length === 0) {
    return out;
  }
  const width = DOOR_CANVAS_W - 2 * DOOR_MARGIN;
  const height = DOOR_CANVAS_H - 2 * DOOR_MARGIN;
  const rowMax = Math.min(DOOR_MAX_SIZE, height / (lines.length * DOOR_LINE_HEIGHT));
  for (const line of lines) {
    let size = rowMax;
    const w = line === "" ? 0 : measure(line, size);
    if (w > width) {
      size *= width / w;
      // Measured widths needn't scale exactly with the size (hinting): shrink until it fits.
      while (size > 1 && measure(line, size) > width) {
        size *= 0.97;
      }
    }
    out.push(Math.max(1, Math.floor(size)));
  }
  return out;
}
