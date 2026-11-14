/**
 * Where the Kanban Board's title bar, columns and cards sit, in device pixels.
 * Sizes are defined at 1080p and multiplied by the viewport scale; cards shrink
 * further (by `k`) when the columns are narrower than their full width.
 *
 * The columns spread across the whole width, so with four of them the middle gap
 * falls behind the speaker. The inner columns hold cards only in their upper
 * part (`capBottom`), leaving the lower middle of the frame plain; the outer
 * columns, where most of the coming and going happens, use their full height.
 */

/** Columns shown at most; narrow frames show three. */
export const MAX_COLUMNS = 4;

/** Reference sizes at 1080p. */
const MARGIN = 32;
const MIN_GAP = 20;
/** A column's full width, and the narrowest that still fits four across. */
export const COLUMN_W = 330;
const MIN_FOUR_W = 230;
const TITLE_H = 64;
const HEADER_GAP = 16;
const HEADER_H = 44;
const CARDS_GAP = 6;
const BOTTOM_MARGIN = 20;
const COLUMN_PAD = 10;
const CARD_GAP = 10;
/** Share of the column below its header that an inner column fills with cards. */
const INNER_SHARE = 0.55;

/** A card's parts at full card scale (1080p): padding, chip row, title line, footer. */
export const CARD_PAD = 12;
export const CARD_CHIP_H = 18;
export const CARD_LINE_H = 20;
export const CARD_FOOTER_H = 24;
/** Space between the chip row and the title, and between the title and the footer. */
export const CARD_SPACING = 8;

export interface BoardLayout {
  readonly width: number;
  readonly height: number;
  /** Viewport scale (height / 1080). */
  readonly s: number;
  /** Columns shown: 3 or 4. */
  readonly columns: number;
  /** Left edge of each column. */
  readonly colX: readonly number[];
  readonly colW: number;
  readonly titleH: number;
  readonly headerTop: number;
  readonly headerH: number;
  /** Top of the first card in every column. */
  readonly cardsTop: number;
  /** Bottom of the column panels. */
  readonly panelBottom: number;
  /** The lowest a card's bottom edge may sit, per column. */
  readonly capBottom: readonly number[];
  /** Card scale on top of `s`: 1 at full column width, less in narrow columns. */
  readonly k: number;
  /** A card's left edge within its column, and its width. */
  readonly cardInset: number;
  readonly cardW: number;
  /** Space between cards. */
  readonly cardGap: number;
}

/** Whether column `c` of `columns` is an inner one, kept short behind the speaker. */
export const isInner = (columns: number, c: number): boolean => c > 0 && c < columns - 1;

/** Columns shown for a set of `setColumns` names in a `width` x `height` frame at scale `s`. */
export function columnsShown(width: number, s: number, setColumns: number): number {
  if (setColumns < MAX_COLUMNS) {
    return 3;
  }
  const four = (width - 2 * MARGIN * s - (MAX_COLUMNS - 1) * MIN_GAP * s) / MAX_COLUMNS;
  return four >= MIN_FOUR_W * s ? MAX_COLUMNS : 3;
}

/** The board layout for a `width` x `height` frame at scale `s`, for a set of `setColumns` names. */
export function boardLayout(
  width: number,
  height: number,
  s: number,
  setColumns: number,
): BoardLayout {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const sc = s > 0 ? s : h / 1080;
  const n = columnsShown(w, sc, setColumns);
  const margin = Math.round(MARGIN * sc);
  const room = Math.max(n, w - 2 * margin);
  const colW = Math.max(
    1,
    Math.floor(Math.min(COLUMN_W * sc, (room - (n - 1) * MIN_GAP * sc) / n)),
  );
  const gap = n > 1 ? (room - n * colW) / (n - 1) : 0;
  const colX: number[] = [];
  for (let c = 0; c < n; c++) {
    colX.push(Math.round(margin + c * (colW + gap)));
  }
  const k = Math.max(0.05, Math.min(1, colW / (COLUMN_W * sc)));
  const titleH = Math.round(TITLE_H * sc);
  const headerTop = titleH + Math.round(HEADER_GAP * sc);
  const headerH = Math.round(HEADER_H * sc);
  const cardsTop = headerTop + headerH + Math.round(CARDS_GAP * sc);
  const panelBottom = Math.max(cardsTop, h - Math.round(BOTTOM_MARGIN * sc));
  const cardInset = Math.round(COLUMN_PAD * sc * k);
  const full = panelBottom - Math.round(COLUMN_PAD * sc * k);
  const capBottom: number[] = [];
  for (let c = 0; c < n; c++) {
    capBottom.push(
      isInner(n, c) ? Math.round(cardsTop + (full - cardsTop) * INNER_SHARE) : Math.round(full),
    );
  }
  return {
    width: w,
    height: h,
    s: sc,
    columns: n,
    colX,
    colW,
    titleH,
    headerTop,
    headerH,
    cardsTop,
    panelBottom,
    capBottom,
    k,
    cardInset,
    cardW: Math.max(1, colW - 2 * cardInset),
    cardGap: Math.round(CARD_GAP * sc * k),
  };
}

/** A card's height with `lines` title lines (1 or 2). */
export function cardHeight(L: BoardLayout, lines: number): number {
  const ref =
    2 * CARD_PAD +
    CARD_CHIP_H +
    2 * CARD_SPACING +
    CARD_FOOTER_H +
    CARD_LINE_H * Math.max(1, Math.min(2, lines));
  return Math.max(1, Math.round(ref * L.s * L.k));
}
