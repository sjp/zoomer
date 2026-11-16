/**
 * The Starting Soon card's words and layout, kept free of GL and canvas so they
 * can be tested: the title each card shows by default, how typed text breaks
 * into lines, and where the title, subtitle and countdown go inside the free
 * centre rect the stream overlays leave (see `freeCentre`).
 */
import type { Rect } from "../stream-overlay/overlay-layout";
import { type CardId, TITLE_LINES } from "./startingsoon.meta";

/** Each card's title when the `title` param is empty. */
export const CARD_TITLES: Readonly<Record<CardId, string>> = {
  starting: "Starting soon",
  brb: "Be right back",
  ending: "Thanks for watching",
};

/** The `card` param's value as a `CardId` (an unknown value shows Starting soon). */
export function toCardId(value: string): CardId {
  return value === "brb" || value === "ending" ? value : "starting";
}

/**
 * The title's lines: the typed text (at most `TITLE_LINES` non-blank lines,
 * trimmed) or, when it has none, the card's default title.
 */
export function titleLines(card: CardId, text: string): string[] {
  const lines = (typeof text === "string" ? text : "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, TITLE_LINES);
  return lines.length > 0 ? lines : [CARD_TITLES[card]];
}

/** Font sizes, line heights and gaps of the card at 1080p, reference px. */
const TITLE_PX = 104;
const TITLE_LINE = 118;
const SUBTITLE_PX = 38;
const SUBTITLE_LINE = 52;
const COUNT_PX = 150;
const COUNT_LINE = 164;
const TITLE_GAP = 16;
const COUNT_GAP = 30;
/** The card's widest at 1080p, reference px. */
const CARD_WIDTH = 1300;
/** The card's height at 1080p: two title lines, the subtitle and the countdown. */
const CARD_HEIGHT = TITLE_LINES * TITLE_LINE + TITLE_GAP + SUBTITLE_LINE + COUNT_GAP + COUNT_LINE;
/** Where the card's centre sits down the free rect: a little above the middle. */
const CENTRE_DOWN = 0.44;

/** Where everything on the card goes, device px, whole pixels (y down). */
interface CardLayout {
  /** Device px per reference px of the card: the frame's scale, less if it had to shrink to fit. */
  k: number;
  /** The whole card. */
  readonly card: Rect;
  /** The title's box, room for `TITLE_LINES` lines; fewer sit at its bottom. */
  readonly title: Rect;
  readonly subtitle: Rect;
  readonly countdown: Rect;
  titlePx: number;
  titleLine: number;
  subtitlePx: number;
  countPx: number;
}

const rect = (): Rect => ({ x: 0, y: 0, w: 0, h: 0 });

export const createCardLayout = (): CardLayout => ({
  k: 1,
  card: rect(),
  title: rect(),
  subtitle: rect(),
  countdown: rect(),
  titlePx: 1,
  titleLine: 1,
  subtitlePx: 1,
  countPx: 1,
});

const set = (r: Rect, x: number, y: number, w: number, h: number) => {
  r.x = x;
  r.y = y;
  r.w = w;
  r.h = h;
};

/**
 * Lays the card out in `free` (device px) for a frame of `scale` (device px per
 * 1080p px): at most `CARD_WIDTH` wide, shrunk to fit a smaller free rect, and
 * centred across it a little above its middle, never past its edges. Writes to
 * `out` and returns it; allocates nothing.
 */
export function layoutCard(free: Readonly<Rect>, scale: number, out: CardLayout): CardLayout {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const fw = Math.max(0, Math.floor(free.w));
  const fh = Math.max(0, Math.floor(free.h));
  const k = Math.max(0, Math.min(s, fw / CARD_WIDTH, fh / CARD_HEIGHT));
  const w = Math.min(fw, Math.floor(CARD_WIDTH * s));
  const titleLine = Math.floor(TITLE_LINE * k);
  const titleH = TITLE_LINES * titleLine;
  const titleGap = Math.floor(TITLE_GAP * k);
  const subH = Math.floor(SUBTITLE_LINE * k);
  const countGap = Math.floor(COUNT_GAP * k);
  const countH = Math.floor(COUNT_LINE * k);
  const h = titleH + titleGap + subH + countGap + countH;
  const x = Math.ceil(free.x) + Math.floor((fw - w) / 2);
  const top = Math.ceil(free.y);
  const y = top + Math.max(0, Math.min(fh - h, Math.round(CENTRE_DOWN * fh - h / 2)));
  out.k = k;
  set(out.card, x, y, w, h);
  set(out.title, x, y, w, titleH);
  set(out.subtitle, x, y + titleH + titleGap, w, subH);
  set(out.countdown, x, y + titleH + titleGap + subH + countGap, w, countH);
  out.titlePx = Math.max(1, Math.round(TITLE_PX * k));
  out.titleLine = Math.max(1, titleLine);
  out.subtitlePx = Math.max(1, Math.round(SUBTITLE_PX * k));
  out.countPx = Math.max(1, Math.round(COUNT_PX * k));
  return out;
}
