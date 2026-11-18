/**
 * Where Loading Screen's tip, progress bar and emblem sit, and how a tip wraps,
 * kept free of GL and canvas so they can be tested. On a wide frame the tip
 * keeps to the bottom-left third and the bar and emblem to the bottom-right
 * third, leaving the middle third (the speaker) clear; on a frame too narrow
 * for that, they stack across the bottom.
 */

/** The bar's longest, px at 1080p (so its end's speed is bounded on any frame). */
export const BAR_MAX_WIDTH = 640;
/** Font sizes and rows at 1080p, px. */
const TIP_PX = 25;
const TIP_LINE = 34;
export const TIP_LINES = 2;
const LABEL_PX = 21;
const LABEL_ROW = 30;
const BAR_HEIGHT = 6;
const BAR_GAP = 10;
const EMBLEM_SIZE = 58;
const EMBLEM_GAP = 22;
const MARGIN = 64;
/** Gap kept from the middle third's edge, and between the stacked rows. */
const GAP = 48;
/** The narrowest outer third that still holds the tip and the bar, px at 1080p. */
const MIN_THIRD = 420;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where everything goes, device px, y down. */
interface HudLayout {
  /** Whether the tip and bar stack across the bottom (a narrow frame). */
  stacked: boolean;
  /** Device px per 1080p px. */
  k: number;
  /** The tip's box: `TIP_LINES` lines of `tipLine`, fewer sitting at its bottom. */
  readonly tip: Box;
  tipLine: number;
  tipPx: number;
  /** The row above the bar: the label on the left, the percentage on the right. */
  readonly label: Box;
  labelPx: number;
  /** The bar's track. */
  readonly bar: Box;
  /** The emblem's centre and radius. */
  emblemX: number;
  emblemY: number;
  emblemR: number;
}

const box = (): Box => ({ x: 0, y: 0, w: 0, h: 0 });

export const createHudLayout = (): HudLayout => ({
  stacked: false,
  k: 1,
  tip: box(),
  tipLine: 1,
  tipPx: 1,
  label: box(),
  labelPx: 1,
  bar: box(),
  emblemX: 0,
  emblemY: 0,
  emblemR: 1,
});

const set = (b: Box, x: number, y: number, w: number, h: number) => {
  b.x = Math.round(x);
  b.y = Math.round(y);
  b.w = Math.max(1, Math.round(w));
  b.h = Math.max(1, Math.round(h));
};

/** Lays the HUD out for a `width` x `height` frame at `scale`. Writes to `out`; allocates nothing. */
export function layoutHud(width: number, height: number, scale: number, out: HudLayout): HudLayout {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const third = w / 3;
  const m = MARGIN * k;
  const gap = GAP * k;
  const bottom = h - m;
  const tipH = TIP_LINES * TIP_LINE * k;
  const e = EMBLEM_SIZE * k;
  const block = (LABEL_ROW + BAR_GAP + BAR_HEIGHT) * k;
  const stacked = third < MIN_THIRD * k;
  out.stacked = stacked;
  out.k = k;
  out.tipLine = Math.max(1, Math.round(TIP_LINE * k));
  out.tipPx = Math.max(1, Math.round(TIP_PX * k));
  out.labelPx = Math.max(1, Math.round(LABEL_PX * k));
  out.emblemR = e / 2;
  out.emblemX = w - m - e / 2;
  let barLeft: number;
  if (stacked) {
    set(out.tip, m, bottom - tipH, w - 2 * m, tipH);
    out.emblemY = bottom - tipH - gap - e / 2;
    barLeft = m;
  } else {
    set(out.tip, m, bottom - tipH, third - m - gap, tipH);
    out.emblemY = bottom - e / 2;
    barLeft = 2 * third + gap;
  }
  const barRight = out.emblemX - e / 2 - EMBLEM_GAP * k;
  barLeft = Math.max(barLeft, barRight - BAR_MAX_WIDTH * k);
  const top = out.emblemY - block / 2;
  set(out.label, barLeft, top, barRight - barLeft, LABEL_ROW * k);
  set(out.bar, barLeft, top + (LABEL_ROW + BAR_GAP) * k, barRight - barLeft, BAR_HEIGHT * k);
  return out;
}

/**
 * Breaks `text` into at most `maxLines` lines at spaces: the first line
 * `firstWidth` wide (it follows the "TIP" prefix), the rest `width`, measured
 * with `measure`. Whatever doesn't fit goes on the last line, to be squeezed.
 */
export function wrapWords(
  text: string,
  measure: (s: string) => number,
  firstWidth: number,
  width: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter((s) => s.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line.length > 0 ? `${line} ${word}` : word;
    const room = lines.length === 0 ? firstWidth : width;
    if (line.length > 0 && measure(next) > room && lines.length < maxLines - 1) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line.length > 0 || lines.length === 0) {
    lines.push(line);
  }
  return lines;
}
