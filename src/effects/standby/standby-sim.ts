/**
 * Please Stand By's pure logic: the colour-bar layout, the sign's layout and
 * text fitting, and the animation clock (the rolling band, the grain re-seed,
 * the sign's pulse, the cartoon board's swing and the TV's blink).
 */
import { fract } from "../math";
import { hash32 } from "../noise";

/** Reference frame height; layout sizes are in px at this height. */
export const REF_HEIGHT = 1080;

export type StandbyStyle = "analogue" | "digital" | "cartoon";

/** The style for a `style` param value, Analogue for anything unknown. */
export function standbyStyle(value: string): StandbyStyle {
  return value === "digital" || value === "cartoon" ? value : "analogue";
}

// ---------------------------------------------------------------------------
// Colour bars
// ---------------------------------------------------------------------------

/** Fractions of the frame height: the main bars, then the reverse-bar strip; the pluge band fills the rest. */
export const MAIN_BARS_HEIGHT = 0.67;
export const REVERSE_STRIP_HEIGHT = 0.08;

/**
 * The seven main bars, left to right, as 75% bars pulled a little towards grey
 * so a codec isn't asked for fully saturated primaries.
 */
export const MAIN_BARS: readonly string[] = [
  "#bdbdbd",
  "#bdbb3a",
  "#3ab6b8",
  "#3eb540",
  "#b53cb2",
  "#b53e3e",
  "#3c3eb4",
];

/** The reverse-bar strip under the main bars, one block per main bar. */
export const REVERSE_BARS: readonly string[] = [
  "#3c3eb4",
  "#151515",
  "#b53cb2",
  "#151515",
  "#3ab6b8",
  "#151515",
  "#bdbdbd",
];

/**
 * The dark band along the bottom: blocks as (width in main-bar widths, colour),
 * left to right, ending in the three near-black pluge steps.
 */
export const PLUGE_BLOCKS: readonly (readonly [number, string])[] = [
  [1.25, "#1c2f4f"],
  [1.25, "#e6e6e6"],
  [1.25, "#3a1f63"],
  [1.25, "#151515"],
  [1 / 3, "#0b0b0b"],
  [1 / 3, "#151515"],
  [1 / 3, "#202020"],
  [1, "#151515"],
];

/**
 * The x edges of `widths` (summing to `total` units) laid across `width` px,
 * rounded to whole px so neighbouring blocks share an edge exactly.
 */
export function blockEdges(widths: readonly number[], width: number): number[] {
  const total = widths.reduce((a, b) => a + b, 0);
  const edges = [0];
  let acc = 0;
  for (const w of widths) {
    acc += w;
    edges.push(Math.round((acc / total) * width));
  }
  return edges;
}

// ---------------------------------------------------------------------------
// The sign
// ---------------------------------------------------------------------------

/** The sign keeps inside the upper third: its top and bottom margins in it, reference px. */
export const SIGN_TOP = 44;
export const SIGN_BOTTOM = REF_HEIGHT / 3 - 20;
/** The largest title and subtext sizes, px per em. */
const TITLE_MAX = 104;
const SUBTEXT_MAX = 34;
/** The subtext's size as a fraction of the title's, at most. */
const SUBTEXT_RATIO = 0.42;
/** Line heights, ems. */
export const TITLE_LINE = 1.12;
export const SUBTEXT_LINE = 1.3;
/** Plate padding, in title ems across and down, and the title-to-subtext gap. */
const PAD_X = 0.5;
const PAD_Y = 0.34;
const GAP = 0.22;
/** Em width per code point when there is nothing to measure with. */
const FALLBACK_EM = 0.62;

/** A line's width in ems of its font, or undefined where text can't be measured. */
export type MeasureText = (text: string, part: "title" | "subtext") => number | undefined;

export interface SignLayout {
  /** The title's lines (trimmed, empty ones dropped) and the subtext, or "" for none. */
  lines: string[];
  subtext: string;
  /** Font sizes, reference px per em. */
  titleSize: number;
  subtextSize: number;
  /** The plate: centre x, top, width and height, reference px; zero size when there is no text. */
  x: number;
  top: number;
  width: number;
  height: number;
  /** Each title line's centre and the subtext's centre, reference px from the plate's top. */
  lineY: number[];
  subtextY: number;
}

/**
 * The widest the plate may be on a frame `refWidth` reference px across: most
 * of a wide frame, a little less than all of a narrow one.
 */
export function signMaxWidth(refWidth: number): number {
  return Math.min(1180, refWidth * 0.72, refWidth - 60);
}

const ems = (text: string, part: "title" | "subtext", measure: MeasureText) => {
  if (text.length === 0) {
    return 0;
  }
  const m = measure(text, part);
  return m !== undefined && Number.isFinite(m) && m > 0 ? m : Array.from(text).length * FALLBACK_EM;
};

/**
 * Fits the title (up to its own lines) and subtext on a plate centred across a
 * frame `refWidth` reference px wide, as large as fits within `signMaxWidth`
 * and between `SIGN_TOP` and `SIGN_BOTTOM`. The subtext is sized from the
 * title, smaller, and shrinks on its own if it is the wider.
 */
export function layoutSign(
  text: string,
  subtext: string,
  refWidth: number,
  measure: MeasureText,
): SignLayout {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const sub = subtext.replace(/\s+/g, " ").trim();
  const maxWidth = signMaxWidth(refWidth);
  const maxHeight = SIGN_BOTTOM - SIGN_TOP;
  const titleEms = lines.reduce((w, l) => Math.max(w, ems(l, "title", measure)), 0);
  const subEms = ems(sub, "subtext", measure);
  const n = lines.length;

  // Sizes for a title size `t` (the paddings follow the title, or the subtext
  // alone when there is no title).
  const size = (t: number) => {
    const sMax = n > 0 ? Math.min(SUBTEXT_MAX, t * SUBTEXT_RATIO) : t;
    const pad = n > 0 ? t : sMax / SUBTEXT_RATIO;
    const sFit = subEms > 0 ? (maxWidth - 2 * PAD_X * pad) / subEms : sMax;
    const s = sub.length > 0 ? Math.max(0, Math.min(sMax, sFit)) : 0;
    const contentW = Math.max(n > 0 ? titleEms * t : 0, subEms * s);
    const contentH = (n > 0 ? n * TITLE_LINE * t : 0) + (s > 0 ? s * SUBTEXT_LINE : 0);
    const gap = n > 0 && s > 0 ? GAP * t : 0;
    return {
      s,
      pad,
      width: contentW + 2 * PAD_X * pad,
      height: contentH + gap + 2 * PAD_Y * pad,
      gap,
    };
  };

  if (n === 0 && sub.length === 0) {
    return {
      lines,
      subtext: sub,
      titleSize: 0,
      subtextSize: 0,
      x: refWidth / 2,
      top: SIGN_TOP,
      width: 0,
      height: 0,
      lineY: [],
      subtextY: 0,
    };
  }

  // The title (or, with none, the subtext) as big as its width allows, then
  // shrunk until the whole plate fits both ways.
  let t =
    n > 0
      ? Math.min(TITLE_MAX, maxWidth / (titleEms + 2 * PAD_X))
      : Math.min(SUBTEXT_MAX * 1.4, maxWidth / (subEms + (2 * PAD_X) / SUBTEXT_RATIO));
  let fit = size(t);
  for (let i = 0; i < 200 && (fit.height > maxHeight || fit.width > maxWidth); i++) {
    t *= 0.97;
    fit = size(t);
  }
  const titleSize = n > 0 ? t : 0;
  const top = SIGN_TOP + (maxHeight - fit.height) / 2;
  const lineY: number[] = [];
  let y = PAD_Y * fit.pad;
  for (let i = 0; i < n; i++) {
    lineY.push(y + (TITLE_LINE * titleSize) / 2);
    y += TITLE_LINE * titleSize;
  }
  y += fit.gap;
  const subtextY = y + (SUBTEXT_LINE * fit.s) / 2;
  return {
    lines,
    subtext: sub,
    titleSize,
    subtextSize: fit.s,
    x: refWidth / 2,
    top,
    width: fit.width,
    height: fit.height,
    lineY,
    subtextY,
  };
}

// ---------------------------------------------------------------------------
// Corners
// ---------------------------------------------------------------------------

/** The station clock's radius and its centre's inset from the bottom-right corner, reference px. */
export const CLOCK_RADIUS = 78;
export const CLOCK_INSET = 128;
/** The cartoon TV's side and its centre's inset from the bottom-left corner, reference px. */
export const TV_SIZE = 220;
export const TV_INSET = 150;
/** The Digital "NO SIGNAL" pill: its height and its left and bottom insets, reference px. */
export const PILL_HEIGHT = 44;
export const PILL_INSET = 56;

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

/** Seconds between the rolling band's passes down the screen. */
export const ROLL_PERIOD = 20;
/** The rolling band's half height, as a fraction of the frame height. */
export const BAND_HALF = 0.12;
/** The band's centre's travel per pass, frame heights: from above the top to below the bottom. */
const BAND_TRAVEL = 1 + 4 * BAND_HALF;
/** Grain re-seeds a second: each pixel eases from one random value to the next. */
export const GRAIN_HZ = 4;
/** The sign's brightness pulse: Hz, and its depth at full motion. */
export const PULSE_HZ = 0.2;
export const PULSE_DEPTH = 0.04;
/** The cartoon board's swing: period, seconds, and amplitude at full motion, radians. */
export const SWING_PERIOD = 6.5;
export const SWING_ANGLE = (1.6 * Math.PI) / 180;
/** The TV's blinks: mean gap and its spread, seconds, and how long the eyes stay shut. */
const BLINK_GAP = 4;
const BLINK_SPREAD = 2;
export const BLINK_SHUT = 0.16;

/** The rolling band's speed, frame heights per second. */
export const BAND_SPEED = BAND_TRAVEL / ROLL_PERIOD;

interface StandbyClock {
  /** Seconds of animation, unwrapped (only advanced while motion is on). */
  time: number;
  /** Seconds into the current blink gap, and how long that gap is. */
  blinkTime: number;
  blinkGap: number;
  blinkCount: number;
}

const gapFor = (k: number) => BLINK_GAP + BLINK_SPREAD * (hash32(k + 0x51ed) / 4294967296 - 0.5);

export function createStandbyClock(): StandbyClock {
  return { time: 0, blinkTime: 0, blinkGap: gapFor(0), blinkCount: 0 };
}

/**
 * Advances the animation by `dt` seconds at `motion` (0..1). At motion 0 the
 * clock stands still, so the grain freezes and nothing else moves either.
 */
export function stepStandbyClock(c: StandbyClock, dt: number, motion: number): void {
  if (!(dt > 0) || !(motion > 0) || !Number.isFinite(dt)) {
    return;
  }
  c.time += dt;
  c.blinkTime += dt;
  while (c.blinkTime >= c.blinkGap + BLINK_SHUT) {
    c.blinkTime -= c.blinkGap + BLINK_SHUT;
    c.blinkCount++;
    c.blinkGap = gapFor(c.blinkCount);
  }
}

/** The rolling band's centre, frame heights from the top (it starts above the frame). */
export function bandCentre(c: StandbyClock): number {
  return fract(c.time / ROLL_PERIOD) * BAND_TRAVEL - 2 * BAND_HALF;
}

/** The grain's seed index and how far it has eased to the next, 0..1. */
export function grainPhase(c: StandbyClock, out: Float64Array): Float64Array {
  const g = c.time * GRAIN_HZ;
  out[0] = Math.floor(g);
  out[1] = g - Math.floor(g);
  return out;
}

/** The sign's brightness, 1 - depth .. 1. */
export function signPulse(c: StandbyClock, motion: number): number {
  return 1 - PULSE_DEPTH * motion * (0.5 - 0.5 * Math.cos(2 * Math.PI * PULSE_HZ * c.time));
}

/** The cartoon board's swing angle, radians (clockwise on screen). */
export function boardSwing(c: StandbyClock, motion: number): number {
  return SWING_ANGLE * motion * Math.sin((2 * Math.PI * c.time) / SWING_PERIOD);
}

/** Whether the cartoon TV's eyes are shut. */
export function tvBlinking(c: StandbyClock, motion: number): boolean {
  return motion > 0 && c.blinkTime >= c.blinkGap;
}
