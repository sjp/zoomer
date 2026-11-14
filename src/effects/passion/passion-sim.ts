/**
 * Pure JS parts of Graphic Design Is My Passion (passion.ts): the caption's
 * wrap, fit and placement, the words' clashing colours, the cloud layout and its
 * drift, where the critter sits and how it crossfades and changes side, the
 * blink and idle schedule, the sparkles, and the clocks that `motion` scales.
 * Nothing here touches GL or a canvas, so it is all unit tested.
 *
 * Units: reference px, where the frame is 1080 tall and `refWidth` wide, y down
 * from the top.
 */
import { driftPoint } from "../fade";
import { clamp } from "../math";
import { createRng, hash32 } from "../noise";
import { CAPTION_LINES, CRITTER_OPTIONS } from "./passion.meta";

export const REF_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// Caption

export type CaptionStyle = "meme" | "wordart";
export const captionStyle = (v: string): CaptionStyle => (v === "wordart" ? "wordart" : "meme");

/**
 * A word's sprite box, in ems of the caption font: padding round the measured
 * advance (room for the outline), and the box height.
 */
export const WORD_PAD = 0.15;
export const WORD_BOX_HEIGHT = 1.5;
/** Gap between neighbouring word boxes, ems; with the pads it reads as a space. */
const WORD_GAP = 0.02;
/** Distance between the two lines' centres, ems. */
const LINE_PITCH = 1.12;
/** Advance per code point where the font can't be measured, ems. */
const FALLBACK_ADVANCE = 0.55;

/** Largest caption font size, reference px. */
const BASE_FONT = 96;
/** The caption's box is at most this fraction of the frame width. */
export const CAPTION_MAX_WIDTH = 0.7;
/** The caption's box stays between these heights: the upper third, below a margin. */
const CAPTION_TOP = 36;
export const CAPTION_BOTTOM = REF_HEIGHT / 3;
/** Least gap between the caption's box and the frame's sides, reference px. */
const EDGE_MARGIN = 12;

/** Each word's bob at motion 1, reference px (half the travel), and its rate, Hz. */
export const BOB_AMPLITUDE = 5;
export const BOB_HZ = 0.25;
/** Phase lag from one word to the next, radians: a slow wave along the caption. */
const BOB_LAG = 0.8;

/** The hand-dragged tilt of the whole caption, radians either way. */
const TILT_MIN = 0.025;
const TILT_MAX = 0.06;
/** How far the caption sits off-centre, as a fraction of the frame width either way. */
const OFFSET_MAX = 0.05;
/** WordArt's arched baseline: the rise of a line's middle, per unit of line width. */
const ARCH = 0.07;

/** WordArt's deep drop shadow, ems right and down. */
export const WORDART_SHADOW = 0.08;
/** Meme's thin drop shadow (with extras), reference px right and down. */
export const MEME_SHADOW = 1;

/** The clashing word colours: yellow, lime, magenta, orange, cyan. */
export const WORD_COLORS = ["#ffe800", "#8dff1a", "#ff2bd6", "#ff8a00", "#14e4ff"] as const;

/**
 * Word `index`'s colour (an index into `WORD_COLORS`) for `seed`, given the word
 * before it had `previous` (-1 for none): a hash of the seed and index, moved on
 * when it would match its neighbour. Depends only on the words before it, so
 * adding words leaves the earlier ones' colours alone.
 */
function wordColor(seed: number, index: number, previous: number): number {
  const n = WORD_COLORS.length;
  const h = hash32(Math.floor(seed) * 977 + index * 7919 + 101);
  const c = h % n;
  return c === previous ? (c + 1 + (hash32(h) % (n - 1))) % n : c;
}

/** The colours of `count` words in reading order, for `seed`. */
export function wordColors(seed: number, count: number): number[] {
  const out: number[] = [];
  let previous = -1;
  for (let i = 0; i < count; i++) {
    previous = wordColor(seed, i, previous);
    out.push(previous);
  }
  return out;
}

/** The text's words, line by line: at most `CAPTION_LINES` non-empty lines. */
export function captionLines(text: string): string[][] {
  return text
    .split("\n")
    .map((line) => line.split(/\s+/).filter((w) => w.length > 0))
    .filter((line) => line.length > 0)
    .slice(0, CAPTION_LINES);
}

interface CaptionWord {
  text: string;
  /** The line it is on, 0 or 1. */
  line: number;
  /** Centre, reference px, bob excluded. */
  x: number;
  y: number;
  /** Sprite box, reference px. */
  width: number;
  height: number;
  /** Box width in ems, for rasterising. */
  em: number;
  /** Rotation, radians, clockwise on screen. */
  angle: number;
  /** Index into `WORD_COLORS`. */
  color: number;
  /** The box's span across its line, 0 to 1: where it sits in WordArt's rainbow. */
  span0: number;
  span1: number;
}

export interface CaptionLayout {
  words: CaptionWord[];
  /** Font size, reference px. */
  fontSize: number;
  /** Box round every word and its drop shadow, reference px, bob excluded. */
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Measures `word`'s advance in ems of the caption font, or undefined where it can't. */
export type MeasureWord = (word: string) => number | undefined;

/** A word box's width in ems: its measured advance plus the pads. */
function wordEm(word: string, measure: MeasureWord): number {
  const w = measure(word);
  const advance =
    typeof w === "number" && Number.isFinite(w) && w > 0
      ? w
      : FALLBACK_ADVANCE * Array.from(word).length;
  return advance + 2 * WORD_PAD;
}

/** One candidate arrangement at a 1 px font, around the block's anchor. */
interface Arrangement {
  /** Word centres, angles and line spans, in word order. */
  x: number[];
  y: number[];
  angle: number[];
  span0: number[];
  span1: number[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Lays out `lines` (each a run of word indices) at a 1 px font, tilted by `tilt`. */
function arrange(
  lines: readonly (readonly number[])[],
  ems: readonly number[],
  style: CaptionStyle,
  tilt: number,
): Arrangement {
  const a: Arrangement = {
    x: [],
    y: [],
    angle: [],
    span0: [],
    span1: [],
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const shadow = style === "wordart" ? WORDART_SHADOW : 0;
  lines.forEach((line, l) => {
    const width = line.reduce((sum, i) => sum + ems[i], 0) + WORD_GAP * (line.length - 1);
    const lineY = (l - (lines.length - 1) / 2) * LINE_PITCH;
    let pen = -width / 2;
    for (const i of line) {
      const lx = pen + ems[i] / 2;
      let ly = lineY;
      let angle = tilt;
      if (style === "wordart") {
        // A parabola through the line's ends, its middle raised (y is down).
        const u = (2 * lx) / width;
        ly -= ARCH * width * (1 - u * u);
        angle += Math.atan((8 * ARCH * lx) / width);
      }
      const x = lx * cos - ly * sin;
      const y = lx * sin + ly * cos;
      a.x[i] = x;
      a.y[i] = y;
      a.angle[i] = angle;
      a.span0[i] = (pen + width / 2) / width;
      a.span1[i] = (pen + ems[i] + width / 2) / width;
      // The rotated box's corners, and the same box shifted by its drop shadow.
      const hw = ems[i] / 2;
      const hh = WORD_BOX_HEIGHT / 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const ex = Math.abs(hw * c) + Math.abs(hh * s);
      const ey = Math.abs(hw * s) + Math.abs(hh * c);
      a.minX = Math.min(a.minX, x - ex);
      a.maxX = Math.max(a.maxX, x + ex + shadow);
      a.minY = Math.min(a.minY, y - ey);
      a.maxY = Math.max(a.maxY, y + ey + shadow);
      pen += ems[i] + WORD_GAP;
    }
  });
  return a;
}

/** The split of one run of word widths into two lines with the narrower longest line. */
function balancedSplit(ems: readonly number[]): number {
  let best = 1;
  let bestWidth = Infinity;
  const total = ems.reduce((a, b) => a + b, 0);
  let first = 0;
  for (let k = 1; k < ems.length; k++) {
    first += ems[k - 1];
    const w = Math.max(first, total - first);
    if (w < bestWidth) {
      bestWidth = w;
      best = k;
    }
  }
  return best;
}

/** Room for the caption box, reference px. */
const captionRoom = (refWidth: number, style: CaptionStyle) => {
  const extra = style === "meme" ? MEME_SHADOW : 0;
  return {
    width: Math.max(1, Math.min(CAPTION_MAX_WIDTH * refWidth, refWidth - 2 * EDGE_MARGIN) - extra),
    height: CAPTION_BOTTOM - CAPTION_TOP - 2 * BOB_AMPLITUDE - extra,
  };
};

/**
 * Lays out the caption for a frame `refWidth` wide: its words on at most two
 * lines (the text's own lines, or one line split in two where that lets it be
 * bigger), shrunk to fit the room, tilted by a seeded angle (and arched in
 * WordArt), and placed a little off-centre in the upper third.
 */
export function layoutCaption(
  text: string,
  style: CaptionStyle,
  seed: number,
  refWidth: number,
  measure: MeasureWord,
): CaptionLayout {
  const lines = captionLines(text);
  const words = lines.flat();
  const ems = words.map((w) => wordEm(w, measure));
  const rng = createRng(hash32(Math.floor(seed) * 31 + 5));
  const tilt = (rng() < 0.5 ? -1 : 1) * (TILT_MIN + (TILT_MAX - TILT_MIN) * rng());
  const offset = (2 * rng() - 1) * OFFSET_MAX;
  if (words.length === 0) {
    const y = (CAPTION_TOP + CAPTION_BOTTOM) / 2;
    return {
      words: [],
      fontSize: BASE_FONT,
      left: refWidth / 2,
      top: y,
      right: refWidth / 2,
      bottom: y,
    };
  }

  // Candidate line breaks: as written, and a one-line caption split in two.
  const candidates: number[][][] = [];
  let next = 0;
  candidates.push(lines.map((line) => line.map(() => next++)));
  if (lines.length === 1 && words.length > 1) {
    const k = balancedSplit(ems);
    const all = words.map((_, i) => i);
    candidates.push([all.slice(0, k), all.slice(k)]);
  }
  const room = captionRoom(refWidth, style);
  let pick = 0;
  let a = arrange(candidates[0], ems, style, tilt);
  const fit = (r: Arrangement) =>
    Math.min(BASE_FONT, room.width / (r.maxX - r.minX), room.height / (r.maxY - r.minY));
  let size = fit(a);
  for (let c = 1; c < candidates.length; c++) {
    const r = arrange(candidates[c], ems, style, tilt);
    const s = fit(r);
    // A split must buy a clearly bigger caption to be worth the second line.
    if (s > size * 1.15) {
      pick = c;
      a = r;
      size = s;
    }
  }
  const lineOf: number[] = [];
  candidates[pick].forEach((line, l) => {
    for (const i of line) {
      lineOf[i] = l;
    }
  });
  const extra = style === "meme" ? MEME_SHADOW : 0;
  const boxW = (a.maxX - a.minX) * size + extra;
  const boxH = (a.maxY - a.minY) * size + extra;

  // Off-centre, but never past the side margins.
  const lo = Math.min(EDGE_MARGIN, (refWidth - boxW) / 2);
  const left = clamp(refWidth * (0.5 + offset) - boxW / 2, lo, refWidth - lo - boxW);
  const spare = Math.max(0, room.height - boxH + extra);
  const top = CAPTION_TOP + BOB_AMPLITUDE + spare * 0.3;
  const ax = left - a.minX * size;
  const ay = top - a.minY * size;
  const colors = wordColors(seed, words.length);
  return {
    words: words.map((w, i) => ({
      text: w,
      line: lineOf[i],
      x: ax + a.x[i] * size,
      y: ay + a.y[i] * size,
      width: ems[i] * size,
      height: WORD_BOX_HEIGHT * size,
      em: ems[i],
      angle: a.angle[i],
      color: colors[i],
      span0: a.span0[i],
      span1: a.span1[i],
    })),
    fontSize: size,
    left,
    top,
    right: left + boxW,
    bottom: top + boxH,
  };
}

/** Word `index`'s bob, reference px (y down), at clock phase `phase` (cycles) and `motion`. */
export function bobOffset(index: number, phase: number, motion: number): number {
  return BOB_AMPLITUDE * motion * Math.sin(2 * Math.PI * phase - index * BOB_LAG);
}

/** Where each box sits in a shelf-packed atlas, and the atlas's size, px. */
interface Packing {
  x: number[];
  y: number[];
  width: number;
  height: number;
}

/**
 * Packs boxes of the given sizes into rows at most `maxWidth` wide (wider boxes
 * get a row each), `gutter` px apart and from the edges.
 */
export function packShelves(
  widths: readonly number[],
  heights: readonly number[],
  maxWidth: number,
  gutter: number,
): Packing {
  const out: Packing = { x: [], y: [], width: 1, height: 1 };
  let x = gutter;
  let y = gutter;
  let row = 0;
  for (let i = 0; i < widths.length; i++) {
    if (x > gutter && x + widths[i] + gutter > maxWidth) {
      x = gutter;
      y += row + gutter;
      row = 0;
    }
    out.x.push(x);
    out.y.push(y);
    x += widths[i] + gutter;
    row = Math.max(row, heights[i]);
    out.width = Math.max(out.width, x);
    out.height = Math.max(out.height, y + row + gutter);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ground and critter

/** The ground's top edge at x, reference px: a gentle wobble round 86% down. */
export function groundEdge(x: number): number {
  return (
    930 + 7 * Math.sin((x * 2 * Math.PI) / 530 + 0.6) + 4 * Math.sin((x * 2 * Math.PI) / 233 + 1.9)
  );
}

/** The critter's cell side, reference px: about 22% of the frame height. */
export const CRITTER_SIZE = 240;
/** Where the critter's feet sit in its cell, as a fraction of the side from the top. */
export const CRITTER_FEET = 0.95;
/** How far the feet sit below the ground's edge, reference px. */
const FEET_SINK = 26;
/** The critter's centre from the nearer side, as a fraction of the frame width. */
const SIDE_INSET = 0.16;
/** Least gap between the critter and the frame's sides, reference px. */
const CRITTER_MARGIN = 16;

/** Critter atlas frames: eyes open, blinking, and an idle touch. */
const FRAME_OPEN = 0;
export const FRAME_BLINK = 1;
export const FRAME_IDLE = 2;

/** The critter select's value as its row in the atlas (the Frog for anything unknown). */
export function critterIndex(value: string): number {
  return Math.max(
    0,
    CRITTER_OPTIONS.findIndex((o) => o.value === value),
  );
}

type Side = "left" | "right" | "none";
export const critterSide = (v: string): Side => (v === "left" || v === "none" ? v : "right");

export interface CritterBox {
  /** Centre, reference px. */
  x: number;
  y: number;
  /** Cell side, reference px. */
  size: number;
}

/** Writes into `out` where the critter sits on `side` of a frame `refWidth` wide. */
export function critterBox(side: "left" | "right", refWidth: number, out: CritterBox): CritterBox {
  const size = Math.max(1, Math.min(CRITTER_SIZE, (refWidth - 2 * CRITTER_MARGIN) * 0.9));
  const lo = size / 2 + CRITTER_MARGIN;
  const hi = refWidth - lo;
  const want = side === "left" ? refWidth * SIDE_INSET : refWidth * (1 - SIDE_INSET);
  out.x = lo <= hi ? clamp(want, lo, hi) : refWidth / 2;
  out.size = size;
  out.y = groundEdge(out.x) + FEET_SINK - size * (CRITTER_FEET - 0.5);
  return out;
}

/** Seconds a critter change crossfades, and a side change fades out (then in again). */
export const CRITTER_FADE = 1;
export const SIDE_FADE = 0.4;

interface CritterState {
  /** The critter shown, and the one crossfading in (-1 for none). */
  shown: number;
  next: number;
  /** The crossfade from `shown` to `next`, 0 to 1. */
  mix: number;
  /** The side the critter is drawn on, and its opacity there. */
  side: Side;
  presence: number;
  started: boolean;
}

export const createCritterState = (): CritterState => ({
  shown: 0,
  next: -1,
  mix: 0,
  side: "right",
  presence: 0,
  started: false,
});

/**
 * Steps the critter's fades by `dt` towards `critter` on `side`. A new critter
 * crossfades in place; a new side fades the critter out, moves it and fades it
 * back in. Each change latches: one arriving mid-fade waits for it to finish.
 */
export function stepCritter(s: CritterState, dt: number, critter: number, side: Side): void {
  if (!s.started) {
    s.started = true;
    s.shown = critter;
    s.side = side;
    s.presence = side === "none" ? 0 : 1;
    return;
  }
  if (s.next < 0 && critter !== s.shown) {
    s.next = critter;
    s.mix = 0;
  }
  if (s.next >= 0) {
    s.mix += dt / CRITTER_FADE;
    if (s.mix >= 1) {
      s.shown = s.next;
      s.next = -1;
      s.mix = 0;
    }
  }
  if (side !== s.side) {
    s.presence = Math.max(0, s.presence - dt / SIDE_FADE);
    if (s.presence === 0) {
      s.side = side;
    }
  } else if (side !== "none") {
    s.presence = Math.min(1, s.presence + dt / SIDE_FADE);
  }
}

/** Seconds between blinks, a blink's length, and the same for the idle touch. */
export const BLINK_MIN = 4;
export const BLINK_MAX = 8;
export const BLINK_LENGTH = 0.16;
const IDLE_MIN = 5;
const IDLE_MAX = 10;
export const IDLE_LENGTH = 0.7;

interface BlinkClock {
  readonly rng: () => number;
  time: number;
  /** Start of the next (or current) blink and idle touch, seconds. */
  blinkAt: number;
  idleAt: number;
}

export function createBlinkClock(seed: number): BlinkClock {
  const rng = createRng(hash32(Math.floor(seed) * 53 + 9));
  return {
    rng,
    time: 0,
    blinkAt: BLINK_MIN * rng() + 1,
    idleAt: IDLE_MIN + (IDLE_MAX - IDLE_MIN) * rng(),
  };
}

/** Advances the clock by `dt` and returns the critter frame to show. A blink beats an idle touch. */
export function stepBlink(c: BlinkClock, dt: number): number {
  c.time += Math.max(0, dt);
  while (c.time >= c.blinkAt + BLINK_LENGTH) {
    c.blinkAt += BLINK_MIN + (BLINK_MAX - BLINK_MIN) * c.rng();
  }
  while (c.time >= c.idleAt + IDLE_LENGTH) {
    c.idleAt += IDLE_MIN + (IDLE_MAX - IDLE_MIN) * c.rng();
  }
  if (c.time >= c.blinkAt) {
    return FRAME_BLINK;
  }
  return c.time >= c.idleAt ? FRAME_IDLE : FRAME_OPEN;
}

/** The critter's breathing: a body scale this far either way at motion 1, at this rate. */
export const BREATH_SCALE = 0.01;
export const BREATH_HZ = 0.3;

// ---------------------------------------------------------------------------
// Clouds

export const MAX_CLOUDS = 7;
/** Cloud shapes in the atlas. */
export const CLOUD_VARIANTS = 3;
/** A cloud's sprite at size 1, reference px; sizes run from 0.7 to 1.2. */
export const CLOUD_WIDTH = 300;
export const CLOUD_HEIGHT = 150;
const CLOUD_SIZE_MIN = 0.7;
const CLOUD_SIZE_MAX = 1.2;
/** Drift speed range at motion 1, reference px per second. */
const CLOUD_SPEED_MIN = 3;
export const CLOUD_SPEED_MAX = 7;
/** Range of the clouds' centres, reference px from the top. */
const CLOUD_Y_MIN = 70;
const CLOUD_Y_MAX = 560;
/**
 * How far past each side a cloud wraps, reference px: half the widest cloud plus
 * room for a frame's drift, so it is wholly out of view when it jumps across.
 */
export const CLOUD_MARGIN = (CLOUD_WIDTH * CLOUD_SIZE_MAX) / 2 + 4;

/** How many clouds a frame `refWidth` wide shows. */
export const cloudCount = (refWidth: number) => clamp(Math.round(refWidth / 380), 2, MAX_CLOUDS);

/** Every cloud slot's layout for one seed, and where each cloud has drifted to. */
interface CloudLayout {
  seed: number;
  /** Centre x, reference px, in `[-CLOUD_MARGIN, span - CLOUD_MARGIN)`. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly size: Float32Array;
  readonly speed: Float32Array;
  readonly variant: Uint8Array;
  /** 1, or -1 for a mirrored cloud. */
  readonly flip: Float32Array;
  /** The wrap span the positions are in: the frame width plus a margin each side. */
  span: number;
}

const cloudSpan = (refWidth: number) => Math.max(1, refWidth) + 2 * CLOUD_MARGIN;

export function createCloudLayout(seed: number, refWidth: number): CloudLayout {
  const c: CloudLayout = {
    seed: 0,
    x: new Float32Array(MAX_CLOUDS),
    y: new Float32Array(MAX_CLOUDS),
    size: new Float32Array(MAX_CLOUDS),
    speed: new Float32Array(MAX_CLOUDS),
    variant: new Uint8Array(MAX_CLOUDS),
    flip: new Float32Array(MAX_CLOUDS),
    span: 1,
  };
  fillCloudLayout(c, seed, refWidth);
  return c;
}

/**
 * Fills every slot from `seed` for a frame `refWidth` wide, each from its own
 * stream (so a count change leaves the other clouds where they were), spread
 * evenly across the span by golden-ratio steps from a seeded origin.
 */
export function fillCloudLayout(c: CloudLayout, seed: number, refWidth: number): void {
  c.seed = seed;
  c.span = cloudSpan(refWidth);
  const origin = createRng(hash32(Math.floor(seed) * 7 + 3))();
  for (let i = 0; i < MAX_CLOUDS; i++) {
    const rng = createRng(hash32(Math.floor(seed) * 977 + i * 7919 + 13));
    const u = origin + i * 0.618034 + (rng() - 0.5) * 0.1;
    c.x[i] = -CLOUD_MARGIN + (u - Math.floor(u)) * c.span;
    c.y[i] = CLOUD_Y_MIN + (CLOUD_Y_MAX - CLOUD_Y_MIN) * rng();
    c.size[i] = CLOUD_SIZE_MIN + (CLOUD_SIZE_MAX - CLOUD_SIZE_MIN) * rng();
    c.speed[i] = CLOUD_SPEED_MIN + (CLOUD_SPEED_MAX - CLOUD_SPEED_MIN) * rng();
    c.variant[i] = Math.floor(rng() * CLOUD_VARIANTS) % CLOUD_VARIANTS;
    c.flip[i] = rng() < 0.5 ? -1 : 1;
  }
}

/**
 * Drifts every cloud slot right by `dt` seconds at `motion` (0 to 1), wrapping
 * from `CLOUD_MARGIN` past the right side to as far past the left. A new frame
 * width stretches the positions to the new span first, so each cloud keeps its
 * place across the frame. Hidden slots drift too, so they come back in place.
 */
export function stepClouds(c: CloudLayout, dt: number, motion: number, refWidth: number): void {
  const span = cloudSpan(refWidth);
  if (span !== c.span) {
    const k = span / c.span;
    for (let i = 0; i < MAX_CLOUDS; i++) {
      c.x[i] = -CLOUD_MARGIN + (c.x[i] + CLOUD_MARGIN) * k;
    }
    c.span = span;
  }
  const step = (Number.isFinite(dt) && dt > 0 ? dt : 0) * clamp(motion, 0, 1);
  for (let i = 0; i < MAX_CLOUDS; i++) {
    // y never moves, so only x wraps.
    driftPoint(c.x, c.y, i, c.speed[i] * step, 0, -CLOUD_MARGIN, 0, span, REF_HEIGHT);
  }
}

// ---------------------------------------------------------------------------
// Sparkles and the clocks

export const MAX_SPARKLES = 5;
/** Seconds a sparkle is visible: a slow swell and fade. */
const SPARKLE_ON = 2.4;

export interface Sparkle {
  x: number;
  y: number;
  alpha: number;
}

/**
 * Writes sparkle slot `k` at sparkle clock `time` into `out`. Each slot repeats
 * on its own period (4 s and up): it swells in and out once, then rests until a
 * new spot. Pure, so a slot comes back the same for the same time.
 */
export function sparkleAt(
  seed: number,
  k: number,
  time: number,
  refWidth: number,
  out: Sparkle,
): Sparkle {
  const period = 4 + 1.3 * k;
  const offset = (hash32(Math.floor(seed) * 131 + k * 17 + 3) / 4294967296) * period;
  const n = Math.floor((time + offset) / period);
  const local = time + offset - n * period;
  const rng = createRng(hash32(Math.floor(seed) * 977 + k * 7919 + n * 104729 + 29));
  out.x = refWidth * (0.06 + 0.88 * rng());
  out.y = 40 + 560 * rng();
  out.alpha = local < SPARKLE_ON ? Math.sin((Math.PI * local) / SPARKLE_ON) ** 2 : 0;
  return out;
}

/** Everything `motion` drives, stepped together. */
interface MotionClock {
  /** Bob and breath phases, cycles in [0, 1). */
  bob: number;
  breath: number;
  /** Sparkle clock, seconds. */
  sparkle: number;
  /** The critter frame to show. */
  frame: number;
  readonly blink: BlinkClock;
}

export const createMotionClock = (seed: number): MotionClock => ({
  bob: 0,
  breath: 0,
  sparkle: 0,
  frame: FRAME_OPEN,
  blink: createBlinkClock(seed),
});

/**
 * Advances the clocks by `dt` at `motion` (0 to 1). The bob and breath
 * amplitudes are scaled where they are drawn (and cloud drift in `stepClouds`); at motion 0
 * every clock stands still and the critter keeps its eyes open, so the frame is
 * a still image.
 */
export function stepMotion(m: MotionClock, dt: number, motion: number): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const k = clamp(motion, 0, 1);
  if (k <= 0) {
    m.frame = FRAME_OPEN;
    return;
  }
  m.bob = (m.bob + step * BOB_HZ) % 1;
  m.breath = (m.breath + step * BREATH_HZ) % 1;
  m.sparkle += step;
  m.frame = stepBlink(m.blink, step);
}
