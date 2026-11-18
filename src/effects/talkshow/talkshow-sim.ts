/**
 * Late-Night Talk Desk's layout and timing, apart from GL: where the frame,
 * desk, microphone, band and title sit for an aspect ratio, the applause
 * sign's schedule, the band's breathing lights, the backdrops' and desks'
 * settings, and how the title is sized to the desk front.
 *
 * Positions are in design units: frame heights at 16:9, origin at the frame's
 * centre, y up.
 */
import { approach, clamp, smoothstep } from "../math";
import { hash32 } from "../noise";
import { fitScale } from "../scene-layout";

/** The smallest the room is drawn at narrow aspects, so it stays legible behind a portrait speaker. */
const MIN_FIT = 0.6;
/** The backdrop window's inner half width and its top edge. */
export const FRAME_HW = 0.66;
export const FRAME_TOP = 0.39;
/** The backdrop's painted horizon: the waterline under the skyline. */
export const HORIZON = -0.13;
/** The desk front's top edge on the left and middle, and how much it rises towards the right-hand end. */
export const DESK_Y = -0.31;
export const DESK_RISE = 0.045;
export const DESK_RISE_FROM = 0.3;
export const DESK_RISE_TO = 0.78;
/** How deep the desk's top surface looks above its front edge. */
export const DESK_TOP_DEPTH = 0.028;
/** The skyline's zoom in the backdrop: the tallest towers reach about 0.58 of this above the horizon. */
export const CITY_ZOOM = 0.66;
export const CITY_DENSITY = 0.5;
export const CITY_SEED = 0x7461_6c6b;
/** The bridge's lamps along its deck: first and last x, the deck's height and the spacing. */
export const BRIDGE_X0 = 0.07;
export const BRIDGE_X1 = 0.75;
export const BRIDGE_DECK = HORIZON + 0.05;
export const BRIDGE_SPACING = 0.026;
/**
 * The bridge lamps' twinkle: its depth (share of their glow), and its loop:
 * each lamp runs a whole number of cycles (in TWINKLE_CYCLES) every
 * TWINKLE_LOOP seconds, so the shader's time can wrap without a jump.
 */
export const TWINKLE_DEPTH = 0.18;
export const TWINKLE_LOOP = 30;
export const TWINKLE_CYCLES = [3, 9] as const;
/** The applause sign's centre and half size. */
export const SIGN_CENTRE = [0, 0.408] as const;
export const SIGN_HALF = [0.105, 0.026] as const;

/** Where things go at one aspect ratio. */
export interface TalkLayout {
  /** Frame heights per design unit's worth of the frame (1 at 16:9 and wider). */
  fit: number;
  /** The visible half width and half height, in design units. */
  halfW: number;
  halfH: number;
  /** The microphone's and mug's x on the desk's right-hand end. */
  micX: number;
  mugX: number;
  /** The band's out-of-focus corner on the left: its rect (centre x, centre y, half width, half height). */
  band: readonly [number, number, number, number];
  /** The title's room on the desk front: centre x, centre y, half width, half height. */
  title: readonly [number, number, number, number];
}

export function talkLayout(aspect: number): TalkLayout {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const fit = Math.max(MIN_FIT, fitScale(a));
  const halfW = a / (2 * fit);
  const halfH = 0.5 / fit;
  const micX = Math.min(0.66, halfW - 0.1);
  const bandX = -Math.min(0.72, halfW - 0.12);
  // On the desk front's left, clear of a speaker's shoulders, at least 0.3 wide.
  const edge = -halfW + 0.05;
  const right = Math.max(-0.44, edge + 0.3);
  const left = Math.max(edge, right - 0.46);
  return {
    fit,
    halfW,
    halfH,
    micX,
    mugX: micX - 0.13,
    band: [bandX, (DESK_Y - 0.03 + 0.22) / 2, 0.27, (0.22 - DESK_Y + 0.03) / 2],
    title: [(left + right) / 2, DESK_Y - 0.075, Math.max(0.05, (right - left) / 2), 0.042],
  };
}

/** The desk front's top edge at design x: level on the left, rising smoothly towards the right-hand end. */
export function deskTopAt(x: number): number {
  return DESK_Y + DESK_RISE * smoothstep(DESK_RISE_FROM, DESK_RISE_TO, x);
}

/** Each backdrop's settings: how bright its lit windows are, the share of them lit, and whether it's a skyline. */
interface BackdropStyle {
  windows: number;
  lit: number;
  skyline: boolean;
}

const BACKDROPS: Readonly<Record<string, BackdropStyle>> = {
  night: { windows: 1, lit: 0.3, skyline: true },
  dusk: { windows: 0.55, lit: 0.18, skyline: true },
  curtain: { windows: 0, lit: 0.3, skyline: false },
};

export const backdropStyle = (name: string): BackdropStyle => BACKDROPS[name] ?? BACKDROPS.night;

/** Shader codes for the backdrops and desks. */
export const BACKDROP_CODE: Readonly<Record<string, number>> = { night: 0, dusk: 1, curtain: 2 };
export const DESK_CODE: Readonly<Record<string, number>> = { wood: 0, retro: 1, glass: 2 };

/** How much the title glows on each desk: brass letters on wood, neon on the others. */
export const TITLE_GLOW: Readonly<Record<string, number>> = { wood: 0.3, retro: 0.85, glass: 0.85 };

/** Seconds a backdrop, desk or microphone change cross-fades over. */
export const CROSSFADE_SECONDS = 1.2;
/** Window toggles a second on the backdrop: a few change slowly. */
export const WINDOW_RATE = 0.5;

/**
 * The key light's tint on the desk at `warmth` (0 cool daylight, 1 warm
 * tungsten), into `out`. Its brightness stays about the same.
 */
export function keyTint(warmth: number, out: Float32Array): Float32Array {
  const w = clamp(Number.isFinite(warmth) ? warmth : 0.6, 0, 1);
  out[0] = 0.9 + 0.22 * w;
  out[1] = 0.98 - 0.02 * w;
  out[2] = 1.12 - 0.36 * w;
  return out;
}

/** Seconds between the starts of applause cues, drawn afresh for each. */
export const APPLAUSE_GAP = [40, 90] as const;
/** Seconds from a cue's start until the sign starts to dim. */
const APPLAUSE_HOLD = 3;
/** Seconds the sign takes to light up, and to go out. */
export const APPLAUSE_UP = 0.6;
export const APPLAUSE_DOWN = 1;
/** The lit sign's peak brightness: bright letters, never a flash. */
export const APPLAUSE_PEAK = 1.1;

interface ApplauseState {
  readonly seed: number;
  /** Cues so far, which picks each gap. */
  count: number;
  /** Seconds until the next cue starts. */
  wait: number;
  /** Seconds left of the current cue's hold; 0 between cues. */
  hold: number;
  /** Whether the current cue lights the sign: the param as it was when the cue started. */
  lit: boolean;
  /** The ramp between dark (0) and lit (1), linear in time. */
  ramp: number;
}

/** Seconds from cue `n`'s start to the next one's. */
export function applauseGap(seed: number, n: number): number {
  const h = hash32((Math.imul(Math.trunc(seed), 0x5bd1e995) ^ Math.imul(n, 0x27d4eb2f)) >>> 0);
  const [lo, hi] = APPLAUSE_GAP;
  return lo + (h / 4294967296) * (hi - lo);
}

export function createApplause(seed: number): ApplauseState {
  // The first cue comes a while in, part-way through a gap.
  return { seed, count: 0, wait: 0.5 * applauseGap(seed, 0), hold: 0, lit: false, ramp: 0 };
}

/**
 * Advances the applause schedule by `dt` seconds and returns the sign's
 * brightness, 0..1 (smoothstepped). The schedule runs whether or not the sign
 * is enabled; a cue lights it only if it was enabled when the cue started,
 * and switching it off mid-cue dims it at once.
 */
export function stepApplause(s: ApplauseState, dt: number, enabled: boolean): number {
  const t = Number.isFinite(dt) && dt > 0 ? dt : 0;
  s.wait -= t;
  s.hold = Math.max(0, s.hold - t);
  if (s.wait <= 0) {
    s.wait += applauseGap(s.seed, s.count);
    s.count++;
    s.hold = APPLAUSE_HOLD;
    s.lit = enabled;
    // A very long step can't pile up cues.
    s.wait = Math.max(s.wait, APPLAUSE_HOLD + APPLAUSE_DOWN);
  }
  if (!enabled) {
    s.lit = false;
  }
  const on = s.lit && s.hold > 0;
  s.ramp = approach(s.ramp, on ? 1 : 0, t / (on ? APPLAUSE_UP : APPLAUSE_DOWN));
  return smoothstep(0, 1, s.ramp);
}

/**
 * The band's lights, out of focus: positions in the band's rect (0..1 across
 * and up), radius (design units), colour, brightness, and the breathing's
 * period and phase.
 */
export const BAND_LIGHTS = 18;
export const BAND_LIGHT_FLOATS = 9;
/** The slowest and fastest breathing periods, seconds, and how deep it goes. */
export const BREATH_PERIOD = [7, 13] as const;
const BREATH_DEPTH = 0.3;

const BAND_COLOURS = [
  [1, 0.62, 0.26],
  [1, 0.8, 0.5],
  [0.95, 0.35, 0.55],
  [0.45, 0.55, 1],
] as const;

/** Lays out the band's lights for `seed`: a few big soft stage lights and small glints off the instruments. */
export function createBandLights(seed: number): Float32Array {
  const out = new Float32Array(BAND_LIGHTS * BAND_LIGHT_FLOATS);
  for (let i = 0; i < BAND_LIGHTS; i++) {
    const h = (salt: number) =>
      hash32((Math.imul(Math.trunc(seed) ^ salt, 0x9e3779b1) + Math.imul(i, 0x85ebca6b)) >>> 0) /
      4294967296;
    const o = i * BAND_LIGHT_FLOATS;
    const glint = i % 3 === 2;
    out[o] = 0.08 + 0.84 * h(1);
    // Stage lights hang high; glints sit low, on the instruments.
    out[o + 1] = glint ? 0.12 + 0.4 * h(2) : 0.35 + 0.6 * h(2);
    out[o + 2] = glint ? 0.006 + 0.006 * h(3) : 0.018 + 0.03 * h(3);
    const c =
      BAND_COLOURS[glint ? 1 : Math.floor(h(4) * BAND_COLOURS.length) % BAND_COLOURS.length];
    out[o + 3] = c[0];
    out[o + 4] = c[1];
    out[o + 5] = c[2];
    out[o + 6] = glint ? 0.5 + 0.3 * h(5) : 0.16 + 0.14 * h(5);
    out[o + 7] = BREATH_PERIOD[0] + (BREATH_PERIOD[1] - BREATH_PERIOD[0]) * h(6);
    out[o + 8] = 2 * Math.PI * h(7);
  }
  return out;
}

/** Light `i`'s brightness at `time` seconds: its own, breathing slowly. */
export function bandLightLevel(lights: Float32Array, i: number, time: number): number {
  const o = i * BAND_LIGHT_FLOATS;
  const breath = 0.5 + 0.5 * Math.sin((2 * Math.PI * time) / lights[o + 7] + lights[o + 8]);
  return lights[o + 6] * (1 - BREATH_DEPTH * breath);
}

/** The title's canvas: its letters' share of the canvas height at most, and the margin each side for the glow. */
const TITLE_MAX_SIZE = 0.62;
export const TITLE_MARGIN = 0.18;

/**
 * Letter size (px) for `text` on a `width` x `height` canvas: as large as
 * fits the height, shrunk until it fits the width inside the margins. Empty
 * text gives 0. `measure(text, size)` is the text's width at a letter size.
 */
export function fitTitle(
  text: string,
  width: number,
  height: number,
  measure: (text: string, size: number) => number,
): number {
  if (text === "" || !(width > 0) || !(height > 0)) {
    return 0;
  }
  const room = width - 2 * TITLE_MARGIN * height;
  let size = Math.max(1, Math.floor(height * TITLE_MAX_SIZE));
  const w = measure(text, size);
  if (w > room) {
    size *= room / w;
    // Measured widths needn't scale exactly with the size (hinting): shrink until it fits.
    while (size > 1 && measure(text, size) > room) {
      size *= 0.97;
    }
  }
  return Math.max(1, Math.floor(size));
}
