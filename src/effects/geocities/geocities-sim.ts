/**
 * Under Construction's pure logic: the page layout for any aspect ratio (with
 * the middle of the frame left clear), the marquee's period and scroll, the
 * hit counter's ticks and odometer roll, and the animation clock behind the
 * blinking sign, the spinning badge, the globes and the digging worker. Nothing
 * here touches GL or a canvas, so it is all unit tested.
 *
 * Units: page px. The page's short side is `PAGE_SHORT` px (800 x 600 at 4:3),
 * x right and y down from the top-left.
 */
import { clamp, smoothstep } from "../math";
import { hash32 } from "../noise";
import type { TileId } from "./geocities.meta";

/** The page's short side, page px: the height of an 800 x 600 page. */
export const PAGE_SHORT = 600;

export type GeoStyle = "classic" | "crisp";
export const geoStyle = (v: string): GeoStyle => (v === "crisp" ? "crisp" : "classic");
export const geoTile = (v: string): TileId => (v === "stone" || v === "paper" ? v : "stars");

// ---------------------------------------------------------------------------
// Layout

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line of text: its centre, font size and measured width, page px. */
interface TextLine {
  text: string;
  x: number;
  y: number;
  size: number;
  width: number;
}

/** The faces the page sets text in. */
export type Face = "title" | "button" | "small" | "marquee";

/**
 * Measures `text`'s advance in ems of `face`, or gives undefined where it
 * can't; the layout then falls back to a fixed advance per code point.
 */
export type MeasureText = (text: string, face: Face) => number | undefined;

/** Advance per code point where a face can't be measured, ems: generous, so text still fits. */
const FALLBACK_ADVANCE: Record<Face, number> = {
  title: 0.62,
  button: 0.6,
  small: 0.5,
  marquee: 0.6,
};

/** `text`'s width in ems of `face`. */
export function textEm(text: string, face: Face, measure: MeasureText): number {
  const w = measure(text, face);
  return typeof w === "number" && Number.isFinite(w) && w >= 0
    ? w
    : FALLBACK_ADVANCE[face] * Array.from(text).length;
}

export const BUTTON_LABELS = ["About me", "My pets", "Links", "Guestbook"] as const;
/** The button that wears the NEW! badge. */
export const BADGE_BUTTON = 3;
const COUNTER_LABEL = "You are visitor number";
export const FOOTER_LINES = [
  "Best viewed at 800×600 in any browser",
  "Last updated: March 14, 1998",
] as const;
/** Digits on the odometer. */
export const COUNTER_DIGITS = 7;

/** Gap kept from the page's edges, page px. */
const MARGIN = 10;
/** The page is laid out wide (side columns) at this aspect and above, tall (bands) below it. */
const WIDE_ASPECT = 1.25;
/** The clear middle, as fractions of the page: half the width and 60% of the height. */
export const CLEAR_WIDTH = 0.5;
export const CLEAR_HEIGHT = 0.6;
/** Largest title size, page px, in each layout. */
const TITLE_MAX = 44;
const TITLE_MAX_TALL = 40;
/** A globe's side and its gap from the title, in title ems. */
const GLOBE_EM = 1.1;
const GLOBE_GAP_EM = 0.3;
/** The sign's height per unit of width. */
const SIGN_ASPECT = 0.62;
/** Gap between marquee repeats, ems. */
export const MARQUEE_GAP_EM = 3;
/** Smallest a label shrinks to fit, page px. */
const MIN_TEXT = 6;

export interface PageLayout {
  width: number;
  height: number;
  /** Whether the page has side columns (wide) or top and bottom bands only (tall). */
  wide: boolean;
  /** The middle left clear for the speaker. */
  clear: Rect;
  title: TextLine;
  /** The two globes flanking the title. */
  globes: [Rect, Rect];
  /** The construction sign's board, and within it the blinking text, the worker and the hazard bar. */
  sign: Rect;
  signText: Rect;
  worker: Rect;
  hazard: Rect;
  buttons: Rect[];
  buttonSize: number;
  /** The badge's centre and radius. */
  badge: { x: number; y: number; r: number };
  counterLabel: TextLine;
  /** The odometer's digit windows: the first window, and each digit's size. */
  odometer: Rect;
  digitW: number;
  digitH: number;
  rule: Rect;
  marquee: Rect;
  marqueeSize: number;
  footer: TextLine[];
}

/** Page size for a canvas aspect (width / height): the short side is `PAGE_SHORT`. */
export function pageSize(aspect: number): [number, number] {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return a >= 1 ? [PAGE_SHORT * a, PAGE_SHORT] : [PAGE_SHORT, PAGE_SHORT / a];
}

/** A line of `text` in `face`, centred at (x, y), shrunk from `size` to fit `maxWidth`. */
function fitLine(
  text: string,
  face: Face,
  measure: MeasureText,
  x: number,
  y: number,
  size: number,
  maxWidth: number,
): TextLine {
  const em = textEm(text, face, measure);
  const s = em > 0 ? clamp(Math.min(size, maxWidth / em), MIN_TEXT, size) : size;
  return { text, x, y, size: s, width: em * s };
}

/** The title and its globes, centred near `cx` but kept within [left, right]. */
function placeTitle(
  title: string,
  measure: MeasureText,
  cx: number,
  cy: number,
  left: number,
  right: number,
  maxSize: number,
): { title: TextLine; globes: [Rect, Rect] } {
  const em = textEm(title, "title", measure);
  const blockEm = em + 2 * (GLOBE_EM + GLOBE_GAP_EM);
  const size = Math.max(MIN_TEXT, Math.min(maxSize, Math.max(0, right - left) / blockEm));
  const block = blockEm * size;
  const x = Math.max(left + block / 2, Math.min(cx, right - block / 2));
  const g = GLOBE_EM * size;
  const half = (em * size) / 2 + GLOBE_GAP_EM * size;
  return {
    title: { text: title, x, y: cy, size, width: em * size },
    globes: [
      { x: x - half - g, y: cy - g / 2, w: g, h: g },
      { x: x + half, y: cy - g / 2, w: g, h: g },
    ],
  };
}

/** The sign's parts inside its board. */
function signParts(sign: Rect): Pick<PageLayout, "signText" | "worker" | "hazard"> {
  const pad = sign.w * 0.06;
  const hazardH = sign.h * 0.2;
  const side = sign.h * 0.4;
  return {
    signText: { x: sign.x + pad, y: sign.y + sign.h * 0.07, w: sign.w - 2 * pad, h: sign.h * 0.3 },
    hazard: { x: sign.x, y: sign.y + sign.h - hazardH, w: sign.w, h: hazardH },
    worker: { x: sign.x + pad, y: sign.y + sign.h - hazardH - side, w: side, h: side },
  };
}

/** The odometer at (x, y): its first digit window. */
const odometerAt = (x: number, y: number, dw: number, dh: number): Rect => ({
  x,
  y,
  w: dw * COUNTER_DIGITS,
  h: dh,
});

function layoutWide(width: number, height: number, title: string, m: MeasureText): PageLayout {
  const col = Math.max(1, width * ((1 - CLEAR_WIDTH) / 2) - 2 * MARGIN);
  const clear: Rect = {
    x: width * ((1 - CLEAR_WIDTH) / 2),
    y: height * ((1 - CLEAR_HEIGHT) / 2),
    w: width * CLEAR_WIDTH,
    h: height * CLEAR_HEIGHT,
  };
  const band = clear.y;

  const signW = Math.min(col, 210);
  const sign: Rect = { x: width - MARGIN - signW, y: MARGIN, w: signW, h: signW * SIGN_ASPECT };
  const head = placeTitle(title, m, width / 2, band / 2, MARGIN, sign.x - MARGIN, TITLE_MAX);

  const bw = Math.max(1, Math.min(col - 12, 180));
  const bh = 34;
  const buttons = BUTTON_LABELS.map((_, i) => ({
    x: MARGIN + 4,
    y: clear.y + 20 + i * (bh + 12),
    w: bw,
    h: bh,
  }));
  const r = Math.min(22, col * 0.12);
  const host = buttons[BADGE_BUTTON];
  const badge = { x: host.x + host.w - 10, y: host.y + host.h / 2, r };
  const buttonSize = Math.min(
    15,
    ...BUTTON_LABELS.map((l) => (bw - 16) / Math.max(1e-6, textEm(l, "button", m))),
  );

  const colX = width - MARGIN - col;
  const labelY = sign.y + sign.h + 24;
  const counterLabel = fitLine(COUNTER_LABEL, "small", m, colX + col / 2, labelY, 13, col);
  const dw = Math.min(18, (col - 8) / COUNTER_DIGITS);
  const dh = dw * (26 / 18);
  const odometer = odometerAt(
    colX + (col - dw * COUNTER_DIGITS) / 2,
    labelY + counterLabel.size,
    dw,
    dh,
  );

  const bottom = clear.y + clear.h;
  const rule: Rect = { x: MARGIN, y: bottom + 12, w: width - 2 * MARGIN, h: 6 };
  const marquee: Rect = { x: MARGIN, y: bottom + 26, w: width - 2 * MARGIN, h: 42 };
  const footer = FOOTER_LINES.map((line, i) =>
    fitLine(line, "small", m, width / 2, bottom + 82 + i * 18, 12, width - 2 * MARGIN),
  );
  return {
    width,
    height,
    wide: true,
    clear,
    ...head,
    sign,
    ...signParts(sign),
    buttons,
    buttonSize: Math.max(MIN_TEXT, buttonSize),
    badge,
    counterLabel,
    odometer,
    digitW: dw,
    digitH: dh,
    rule,
    marquee,
    marqueeSize: 30,
    footer,
  };
}

function layoutTall(width: number, height: number, title: string, m: MeasureText): PageLayout {
  const clear: Rect = {
    x: width * ((1 - CLEAR_WIDTH) / 2),
    y: height * ((1 - CLEAR_HEIGHT) / 2),
    w: width * CLEAR_WIDTH,
    h: height * CLEAR_HEIGHT,
  };
  const band = clear.y;
  // Everything shrinks together when the bands are short (near-square pages).
  const u = clamp(Math.min(width / 600, (band - 2 * MARGIN) / 190, (band - MARGIN) / 166), 0.05, 1);

  const head = placeTitle(
    title,
    m,
    width / 2,
    MARGIN + 26 * u,
    MARGIN,
    width - MARGIN,
    TITLE_MAX_TALL * u,
  );
  const signW = 200 * u;
  const sign: Rect = {
    x: width - MARGIN - signW,
    y: MARGIN + 58 * u,
    w: signW,
    h: signW * SIGN_ASPECT,
  };
  const left = Math.max(1, sign.x - 2 * MARGIN);
  const labelY = sign.y + 30 * u;
  const counterLabel = fitLine(COUNTER_LABEL, "small", m, MARGIN + left / 2, labelY, 13 * u, left);
  const dw = Math.min(18 * u, (left - 8) / COUNTER_DIGITS);
  const dh = dw * (26 / 18);
  const odometer = odometerAt(
    MARGIN + (left - dw * COUNTER_DIGITS) / 2,
    labelY + counterLabel.size,
    dw,
    dh,
  );

  const bottom = clear.y + clear.h;
  const rule: Rect = { x: MARGIN, y: bottom + 8 * u, w: width - 2 * MARGIN, h: 6 * u };
  const gap = 10 * u;
  const bw = Math.max(1, (width - 2 * MARGIN - 3 * gap) / BUTTON_LABELS.length);
  const bh = 32 * u;
  const by = bottom + 38 * u;
  const buttons = BUTTON_LABELS.map((_, i) => ({
    x: MARGIN + i * (bw + gap),
    y: by,
    w: bw,
    h: bh,
  }));
  const r = 20 * u;
  const host = buttons[BADGE_BUTTON];
  const badge = { x: host.x + host.w - 1.1 * r, y: host.y + 0.1 * r, r };
  const buttonSize = Math.min(
    14 * u,
    ...BUTTON_LABELS.map((l) => (bw - 10 * u) / Math.max(1e-6, textEm(l, "button", m))),
  );
  const marquee: Rect = { x: MARGIN, y: by + bh + 10 * u, w: width - 2 * MARGIN, h: 36 * u };
  const footer = FOOTER_LINES.map((line, i) =>
    fitLine(
      line,
      "small",
      m,
      width / 2,
      marquee.y + marquee.h + (14 + i * 14) * u,
      11 * u,
      width - 2 * MARGIN,
    ),
  );
  return {
    width,
    height,
    wide: false,
    clear,
    ...head,
    sign,
    ...signParts(sign),
    buttons,
    buttonSize: Math.max(MIN_TEXT * u, buttonSize),
    badge,
    counterLabel,
    odometer,
    digitW: dw,
    digitH: dh,
    rule,
    marquee,
    marqueeSize: 26 * u,
    footer,
  };
}

/** The page for a canvas of `aspect` (width / height), titled `title`. */
export function layoutPage(aspect: number, title: string, measure: MeasureText): PageLayout {
  const [width, height] = pageSize(aspect);
  return width / height >= WIDE_ASPECT
    ? layoutWide(width, height, title, measure)
    : layoutTall(width, height, title, measure);
}

/** A text line's box, page px (height one em, centred on its y). */
const lineBox = (t: TextLine): Rect => ({
  x: t.x - t.width / 2,
  y: t.y - t.size / 2,
  w: t.width,
  h: t.size,
});

/** Every element's box on the page (none for an empty line), for overlap checks. */
export function pageBoxes(layout: PageLayout): Rect[] {
  const b = layout.badge;
  return [
    ...(layout.title.text.length > 0 ? [lineBox(layout.title)] : []),
    ...layout.globes,
    layout.sign,
    ...layout.buttons,
    { x: b.x - b.r, y: b.y - b.r, w: 2 * b.r, h: 2 * b.r },
    lineBox(layout.counterLabel),
    layout.odometer,
    layout.rule,
    layout.marquee,
    ...layout.footer.map(lineBox),
  ];
}

// ---------------------------------------------------------------------------
// Marquee

/** The marquee's scroll speed at motion 1, page px per second. */
export const MARQUEE_SPEED = 40;

/**
 * The marquee strip's period, page px: the text's width at `size` plus the gap
 * before it repeats. The strip draws the text once, starting half a gap in, and
 * wraps (a repeating texture), so it is continuous at the wrap for any length.
 */
export const marqueePeriod = (em: number, size: number) =>
  Math.max(1, (Math.max(0, em) + MARQUEE_GAP_EM) * size);

/** Where the marquee's window starts in its strip, page px in [0, period). */
export function marqueeOffset(distance: number, period: number): number {
  const p = period > 0 ? period : 1;
  const o = distance % p;
  return o < 0 ? o + p : o;
}

/** Reference px (a 1080-tall frame) per page px for a page `height` page px tall. */
export const refPerPage = (pageHeight: number) => 1080 / pageHeight;

// ---------------------------------------------------------------------------
// Animation clock

/** The sign's blink, Hz, and how far it fades at motion 1 (to 1 - depth). */
export const BLINK_HZ = 0.5;
export const BLINK_DEPTH = 0.85;
/** The badge's spin, turns per second, and its starburst's points. */
export const BADGE_TURNS = 0.08;
export const BADGE_POINTS = 12;
/** The globes' frames and frame rate, Hz. */
export const GLOBE_FRAMES = 4;
export const GLOBE_FPS = 2.5;
/** The worker's dig: every `DIG_PERIOD` s, frames 1, 2, 1 for `DIG_STEP` s each. */
export const WORKER_FRAMES = 3;
export const DIG_PERIOD = 2.4;
const DIG_STEP = 0.3;

interface GeoClock {
  /** Animation time, s: real time scaled by motion. */
  t: number;
  /** How far the marquee has scrolled, page px. */
  distance: number;
}

export const createGeoClock = (): GeoClock => ({ t: 0, distance: 0 });

/** Advances the clock by `dt` s at `motion` (0 stops everything). */
export function stepGeoClock(c: GeoClock, dt: number, motion: number): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const m = clamp(Number.isFinite(motion) ? motion : 0, 0, 1);
  c.t += step * m;
  c.distance += step * m * MARQUEE_SPEED;
}

/**
 * The sign text's opacity: a soft on / off at `BLINK_HZ`, holding on and off
 * with eased changes between, faded only as deep as `motion` allows.
 */
export function blinkAlpha(c: GeoClock, motion: number): number {
  const s = Math.cos(2 * Math.PI * BLINK_HZ * c.t);
  const on = smoothstep(-0.5, 0.5, s);
  return 1 - clamp(motion, 0, 1) * BLINK_DEPTH * (1 - on);
}

/** The badge's angle, radians, kept within one turn. */
export const badgeAngle = (c: GeoClock) => 2 * Math.PI * ((BADGE_TURNS * c.t) % 1);

/** The globes' frame. */
export const globeFrame = (c: GeoClock) => Math.floor(c.t * GLOBE_FPS) % GLOBE_FRAMES;

/** The worker's frame: 0 at rest, then 1 (shovel up), 2 (shovel in), 1 every dig. */
export function workerFrame(c: GeoClock): number {
  const phase = c.t % DIG_PERIOD;
  if (phase < DIG_STEP || (phase >= 2 * DIG_STEP && phase < 3 * DIG_STEP)) {
    return 1;
  }
  return phase < 2 * DIG_STEP ? 2 : 0;
}

// ---------------------------------------------------------------------------
// Hit counter

/** Gaps between visits, s of animation time. */
export const TICK_MIN = 20;
export const TICK_MAX = 60;
/** The odometer's wheels: slowest and fastest roll, digits per second. */
const ROLL_MIN_RATE = 1.6;
export const ROLL_MAX_RATE = 4;
/** How fast a wheel's roll speeds up per digit still to go, per second. */
const ROLL_EASE = 5;
const WRAP = 10 ** COUNTER_DIGITS;

export interface HitCounter {
  /** The starting count from the param, and visits since. */
  start: number;
  visits: number;
  /** Animation time of the next visit, s. */
  next: number;
  /** Each wheel's position, 0 to 10 (most significant first); whole numbers show one digit. */
  wheels: Float64Array;
}

/** The gap before visit `n`, s: 20-60 s, hashed. */
const tickGap = (n: number) =>
  TICK_MIN + ((TICK_MAX - TICK_MIN) * hash32(n * 7919 + 17)) / 4294967296;

/** A counter showing `start` at once. */
export function createHitCounter(start: number): HitCounter {
  const c: HitCounter = {
    start: counterValue(start),
    visits: 0,
    next: tickGap(0),
    wheels: new Float64Array(COUNTER_DIGITS),
  };
  for (let i = 0; i < COUNTER_DIGITS; i++) {
    c.wheels[i] = digitOf(c.start, i);
  }
  return c;
}

/** A param value as a count the odometer can show. */
const counterValue = (v: number) => (Number.isFinite(v) ? Math.floor(Math.max(0, v)) % WRAP : 0);

/** Digit `i` (most significant first) of `value`. */
export const digitOf = (value: number, i: number) =>
  Math.floor(value / 10 ** (COUNTER_DIGITS - 1 - i)) % 10;

/** The count the counter is heading for. */
export const counterTarget = (c: HitCounter) => (c.start + c.visits) % WRAP;

/**
 * Advances the counter: a visit every 20-60 s of animation time (`animTime`
 * is the clock's `t`), and each wheel rolls forward towards its digit by real
 * time `dt`, so a changed starting count rolls in even with motion off. Wheels
 * only ever roll forward, at most `ROLL_MAX_RATE` digits a second.
 */
export function stepHitCounter(c: HitCounter, dt: number, animTime: number, start: number): void {
  const s = counterValue(start);
  if (s !== c.start) {
    c.start = s;
  }
  while (animTime >= c.next) {
    c.visits++;
    c.next += tickGap(c.visits);
  }
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const target = counterTarget(c);
  for (let i = 0; i < COUNTER_DIGITS; i++) {
    const want = digitOf(target, i);
    const at = c.wheels[i];
    const left = (want - at + 10) % 10;
    if (left < 1e-9) {
      c.wheels[i] = want;
      continue;
    }
    const rate = clamp(ROLL_EASE * left, ROLL_MIN_RATE, ROLL_MAX_RATE);
    const move = Math.min(left, rate * step);
    const next = at + move;
    c.wheels[i] = move >= left ? want : next >= 10 ? next - 10 : next;
  }
}
