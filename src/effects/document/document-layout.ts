/**
 * Where everything in the Document Page goes: the window chrome, the pages, and
 * every typed line on them.
 *
 * Document coordinates are device pixels at the current zoom, with y = 0 at the
 * top of the first page and pages stacked downwards with a grey gap between
 * them. Line breaking uses real font metrics through a `Measure` callback (the
 * renderer's 2D canvas; tests pass a fixed-width stand-in), so layout is pure
 * and runs only when the document, size or zoom changes. Every line top and
 * height is a whole pixel, so a view scrolled to a line rests texel for texel.
 */
import { minTweenSeconds } from "../charts";
import { BLOCK_BULLETS, BLOCK_HEADING, BLOCK_TABLE, BLOCK_TITLE, type Doc } from "./document-sim";

/** Text styles, each with its own font size and line height. */
export const STYLE_TITLE = 0;
const STYLE_HEADING = 1;
export const STYLE_BODY = 2;
const STYLE_TABLE = 3;
const STYLE_TABLE_HEAD = 4;
export const STYLE_COMMENT = 5;
export const STYLE_AUTHOR = 6;
export const STYLE_COUNT = 7;

/** Font sizes at 1080p and zoom 1, px, per style. */
const FONT_PX = [26, 16, 12.5, 11.5, 11.5, 11, 10.5] as const;
/** Line height as a multiple of the font size, per style. */
const LINE_SPACING = [1.35, 1.4, 1.6, 1.4, 1.4, 1.4, 1.4] as const;

/** Zoom of each layout: the page at a glance, or close enough that the speaker covers the body. */
export const ZOOM_PAGE = 1;
export const ZOOM_MARGINS = 1.75;

/** Window chrome heights at 1080p (zoom doesn't change them). */
const TOOLBAR_H = 46;
const RULER_H = 26;
const STATUS_H = 30;
/** Grey above the first page when scrolled to the top, at 1080p. */
const VIEW_PAD = 24;
/** Gap between the window's edge and the comment pane, at 1080p. */
const EDGE_PAD = 12;

/** Scroll when the caret's line comes within this fraction of the view's height of its bottom. */
const SCROLL_TRIGGER = 0.2;
/** Scrolled views rest with this many body lines above the line at their top. */
const LAND_LINES = 1;
/** Shortest scroll step, in body lines. */
const MIN_STEP_LINES = 4;
/** Longest scroll step, as a fraction of the view's height. */
const MAX_STEP_FRACTION = 0.5;
/** Seconds a scroll step takes at least (longer if the codec limits need it). */
const SCROLL_SECONDS = 1.5;

/** Measures `text` in `style`, px. */
export type Measure = (text: string, style: number) => number;

/** Sizes on the page at one scale and zoom, all whole device pixels but the fonts. */
export interface PageGeom {
  /** `scale * zoom`. */
  readonly k: number;
  readonly pageW: number;
  readonly pageH: number;
  readonly margin: number;
  readonly contentW: number;
  /** Grey gap between pages. */
  readonly gap: number;
  /** One inch on the ruler. */
  readonly inch: number;
  readonly fontPx: Float64Array;
  readonly lineH: Int32Array;
  /** Bullet indent and the bullet's centre from the content's left. */
  readonly indent: number;
  readonly bulletX: number;
  /** A table row's height. */
  readonly rowH: number;
  /** Comment pane: gap from the page, width, inner padding, author bar width, gap between comments. */
  readonly commentGap: number;
  readonly commentW: number;
  readonly commentPad: number;
  readonly commentBar: number;
  readonly commentSpace: number;
}

export function pageGeometry(scale: number, zoom: number): PageGeom {
  const k = scale * zoom;
  const R = (n: number) => Math.max(1, Math.round(n * k));
  const fontPx = new Float64Array(STYLE_COUNT);
  const lineH = new Int32Array(STYLE_COUNT);
  for (let i = 0; i < STYLE_COUNT; i++) {
    fontPx[i] = FONT_PX[i] * k;
    lineH[i] = Math.max(2, Math.round(FONT_PX[i] * LINE_SPACING[i] * k));
  }
  const pageW = R(680);
  const margin = R(80);
  return {
    k,
    pageW,
    pageH: R(880),
    margin,
    contentW: pageW - 2 * margin,
    gap: R(20),
    inch: 80 * k,
    fontPx,
    lineH,
    indent: R(26),
    bulletX: R(12),
    rowH: lineH[STYLE_TABLE] + R(8),
    commentGap: R(22),
    commentW: R(210),
    commentPad: R(8),
    commentBar: R(3),
    commentSpace: R(10),
  };
}

/** A margin comment's box, in document coordinates (x from the comment pane's left). */
interface CommentBox {
  readonly block: number;
  readonly author: number;
  readonly text: string;
  /** Top of the paragraph it belongs to, and the box's top and height. */
  readonly anchor: number;
  readonly y: number;
  readonly h: number;
  /** Line ranges of `text`. */
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

/** A table's grid, in document coordinates (x from the page's left). */
interface TableBox {
  readonly block: number;
  readonly x: number;
  readonly w: number;
  readonly colW: number;
  readonly cols: number;
  readonly rows: number;
  /** Each row's top; a row never splits across pages, but rows may. */
  readonly rowY: Int32Array;
}

export interface DocLayout {
  readonly geom: PageGeom;
  readonly lineCount: number;
  /** Per line: its segment, character range [start, end), left (from the page's left), top, height, style, widest extent and block. */
  readonly lineSeg: Int32Array;
  readonly lineStart: Int32Array;
  readonly lineEnd: Int32Array;
  readonly lineX: Int32Array;
  readonly lineY: Int32Array;
  readonly lineH: Int32Array;
  readonly lineStyle: Int32Array;
  readonly lineW: Int32Array;
  readonly lineBlock: Int32Array;
  /** Per segment: its first line and line count. */
  readonly segLine: Int32Array;
  readonly segLines: Int32Array;
  /** Per block: top and bottom. */
  readonly blockTop: Int32Array;
  readonly blockBottom: Int32Array;
  readonly tables: readonly TableBox[];
  readonly comments: readonly CommentBox[];
  readonly pages: number;
  /** Bottom of the last page. */
  readonly bottom: number;
}

/** Top of page `p`. */
export const pageTop = (g: PageGeom, p: number): number => p * (g.pageH + g.gap);

/** The page holding document y `y` (in a gap, the page above). */
export const pageAt = (g: PageGeom, y: number): number =>
  Math.max(0, Math.floor(y / (g.pageH + g.gap)));

/** Splits `text` into lines no wider than `maxW` (a longer word gets a line to itself). */
function breakLines(
  text: string,
  maxW: number,
  style: number,
  measure: Measure,
  starts: number[],
  ends: number[],
): void {
  starts.length = 0;
  ends.length = 0;
  const space = measure(" ", style);
  let lineStart = 0;
  let lineEnd = 0;
  let x = 0;
  let i = 0;
  while (i < text.length) {
    let j = text.indexOf(" ", i);
    if (j < 0) {
      j = text.length;
    }
    const w = measure(text.slice(i, j), style);
    if (lineEnd > lineStart && x + space + w > maxW) {
      starts.push(lineStart);
      ends.push(lineEnd);
      lineStart = i;
      x = w;
    } else {
      x += (lineEnd > lineStart ? space : 0) + w;
    }
    lineEnd = j;
    i = j + 1;
  }
  starts.push(lineStart);
  ends.push(Math.max(lineStart, lineEnd));
}

/** Spacing before and after each block kind, at 1080p and zoom 1. */
const SPACE_BEFORE = [0, 20, 0, 0, 6] as const;
const SPACE_AFTER = [18, 6, 11, 11, 15] as const;
/** Gap between list items. */
const ITEM_GAP = 3;

/** Lays `doc` out on pages of `geom`, breaking lines with `measure`. */
export function layoutDocument(doc: Doc, geom: PageGeom, measure: Measure): DocLayout {
  const g = geom;
  const segs = doc.segments;
  const lineSeg: number[] = [];
  const lineStart: number[] = [];
  const lineEnd: number[] = [];
  const lineX: number[] = [];
  const lineY: number[] = [];
  const lineH: number[] = [];
  const lineStyle: number[] = [];
  const lineW: number[] = [];
  const lineBlock: number[] = [];
  const segLine = new Int32Array(segs.length);
  const segLines = new Int32Array(segs.length);
  const blockTop = new Int32Array(doc.blocks.length);
  const blockBottom = new Int32Array(doc.blocks.length);
  const tables: TableBox[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const R = (n: number) => Math.round(n * g.k);

  let page = 0;
  let y = g.margin;
  /** Whether nothing is on the current page yet (no space before the first block). */
  let fresh = true;
  const contentBottom = () => pageTop(g, page) + g.pageH - g.margin;
  /** Makes room for `h` px, moving to the next page if it doesn't fit. */
  const fit = (h: number) => {
    if (!fresh && y + h > contentBottom()) {
      page++;
      y = pageTop(g, page) + g.margin;
      fresh = true;
    }
  };
  const addLine = (
    s: number,
    a: number,
    b: number,
    x: number,
    top: number,
    style: number,
    w: number,
  ) => {
    lineSeg.push(s);
    lineStart.push(a);
    lineEnd.push(b);
    lineX.push(x);
    lineY.push(top);
    lineH.push(g.lineH[style]);
    lineStyle.push(style);
    lineW.push(w);
    lineBlock.push(segs[s].block);
  };

  for (let bi = 0; bi < doc.blocks.length; bi++) {
    const block = doc.blocks[bi];
    const kind = block.kind;
    if (!fresh) {
      y += R(SPACE_BEFORE[kind]);
    }
    let top = -1;
    if (kind === BLOCK_TABLE) {
      const x = g.margin;
      const w = g.contentW;
      const colW = Math.floor(w / block.cols);
      const rowY = new Int32Array(block.rows);
      for (let r = 0; r < block.rows; r++) {
        fit(g.rowH);
        rowY[r] = y;
        if (top < 0) {
          top = y;
        }
        const style = r === 0 ? STYLE_TABLE_HEAD : STYLE_TABLE;
        const pad = R(6);
        const ty = y + Math.round((g.rowH - g.lineH[style]) / 2);
        for (let c = 0; c < block.cols; c++) {
          const s = block.firstSeg + r * block.cols + c;
          segLine[s] = lineX.length;
          segLines[s] = 1;
          addLine(s, 0, segs[s].text.length, x + c * colW + pad, ty, style, colW - 2 * pad);
        }
        y += g.rowH;
        fresh = false;
      }
      tables.push({
        block: bi,
        x,
        w: colW * block.cols,
        colW,
        cols: block.cols,
        rows: block.rows,
        rowY,
      });
    } else {
      const style =
        kind === BLOCK_TITLE ? STYLE_TITLE : kind === BLOCK_HEADING ? STYLE_HEADING : STYLE_BODY;
      const indent = kind === BLOCK_BULLETS ? g.indent : 0;
      const maxW = g.contentW - indent;
      for (let s = block.firstSeg; s < block.firstSeg + block.segCount; s++) {
        if (s > block.firstSeg) {
          y += R(ITEM_GAP);
        }
        breakLines(segs[s].text, maxW, style, measure, starts, ends);
        segLine[s] = lineX.length;
        segLines[s] = starts.length;
        for (let i = 0; i < starts.length; i++) {
          // A heading keeps with the first lines of what follows.
          fit(g.lineH[style] * (kind === BLOCK_HEADING ? 3 : 1));
          if (top < 0) {
            top = y;
          }
          addLine(s, starts[i], ends[i], g.margin + indent, y, style, maxW);
          y += g.lineH[style];
          fresh = false;
        }
      }
    }
    blockTop[bi] = top;
    blockBottom[bi] = y;
    y += R(SPACE_AFTER[kind]);
  }

  // Comments stack down the pane beside their blocks, never overlapping.
  const comments: CommentBox[] = [];
  const textW = g.commentW - g.commentBar - 2 * g.commentPad;
  let below = -Infinity;
  for (let bi = 0; bi < doc.blocks.length; bi++) {
    const c = doc.blocks[bi].comment;
    if (!c) {
      continue;
    }
    breakLines(c.text, textW, STYLE_COMMENT, measure, starts, ends);
    const h = 2 * g.commentPad + g.lineH[STYLE_AUTHOR] + starts.length * g.lineH[STYLE_COMMENT];
    const boxY = Math.max(blockTop[bi], below + g.commentSpace);
    comments.push({
      block: bi,
      author: c.author,
      text: c.text,
      anchor: blockTop[bi],
      y: boxY,
      h,
      starts: [...starts],
      ends: [...ends],
    });
    below = boxY + h;
  }

  const n = lineX.length;
  return {
    geom: g,
    lineCount: n,
    lineSeg: Int32Array.from(lineSeg),
    lineStart: Int32Array.from(lineStart),
    lineEnd: Int32Array.from(lineEnd),
    lineX: Int32Array.from(lineX),
    lineY: Int32Array.from(lineY),
    lineH: Int32Array.from(lineH),
    lineStyle: Int32Array.from(lineStyle),
    lineW: Int32Array.from(lineW),
    lineBlock: Int32Array.from(lineBlock),
    segLine,
    segLines,
    blockTop,
    blockBottom,
    tables,
    comments,
    pages: page + 1,
    bottom: pageTop(g, page) + g.pageH,
  };
}

/**
 * The line the caret is on with `chars` characters of segment `seg` typed: the
 * last line starting at or before it, so after a wrapped space it sits at the
 * start of the next line.
 */
export function caretLine(L: DocLayout, seg: number, chars: number): number {
  const first = L.segLine[seg];
  let line = first;
  for (let i = first + 1; i < first + L.segLines[seg]; i++) {
    if (L.lineStart[i] <= chars) {
      line = i;
    }
  }
  return line;
}

// ---------------------------------------------------------------------------
// The window

/** The window around the pages, in device pixels. */
export interface ScreenLayout {
  readonly toolbarH: number;
  readonly rulerH: number;
  readonly statusH: number;
  /** The scrolling view between the ruler and the status strip. */
  readonly viewTop: number;
  readonly viewH: number;
  /** The page's left edge and the comment pane's. */
  readonly pageX: number;
  readonly paneX: number;
  /** Lowest and highest scroll for no document (the top gap), and the longest scroll step. */
  readonly minScroll: number;
  readonly maxStep: number;
}

/**
 * Places the page centred in a `width` x `height` window, moved left as far as
 * needed for the comment pane to fit on the right (but never so far that the
 * page's text leaves the window).
 */
export function screenLayout(
  width: number,
  height: number,
  scale: number,
  g: PageGeom,
): ScreenLayout {
  const toolbarH = Math.round(TOOLBAR_H * scale);
  const rulerH = Math.round(RULER_H * scale);
  const statusH = Math.round(STATUS_H * scale);
  const viewTop = toolbarH + rulerH;
  const viewH = Math.max(1, height - viewTop - statusH);
  const centred = Math.round((width - g.pageW) / 2);
  const fits = width - Math.round(EDGE_PAD * scale) - g.commentW - g.commentGap - g.pageW;
  // On a narrow window the pane may run off the right before the page's text runs off the left.
  const pageX = Math.max(Math.min(centred, fits), -Math.round(g.margin * 0.6));
  return {
    toolbarH,
    rulerH,
    statusH,
    viewTop,
    viewH,
    pageX,
    paneX: pageX + g.pageW + g.commentGap,
    minScroll: -Math.round(VIEW_PAD * scale),
    maxStep: Math.max(1, Math.floor(viewH * MAX_STEP_FRACTION)),
  };
}

/** The furthest the view scrolls: the last page's bottom (and a gap) at the view's bottom. */
export const maxScroll = (L: DocLayout, S: ScreenLayout): number =>
  Math.max(S.minScroll, L.bottom - S.minScroll - S.viewH);

/**
 * Where the view should scroll to from `scroll` with the caret on `line`: where
 * it is, unless the caret's line nears the view's bottom; then down by about a
 * paragraph (at least a few lines, at most `S.maxStep`), resting with a line's top
 * one line below the view's top and never past `maxScroll`.
 */
export function scrollTarget(L: DocLayout, S: ScreenLayout, scroll: number, line: number): number {
  const bottom = L.lineY[line] + L.lineH[line];
  const limit = scroll + S.viewH * (1 - SCROLL_TRIGGER);
  if (bottom <= limit) {
    return scroll;
  }
  const body = L.geom.lineH[STYLE_BODY];
  const block = L.lineBlock[line];
  const paragraph = L.blockBottom[block] - L.blockTop[block];
  const top = Math.min(maxScroll(L, S), scroll + S.maxStep);
  const want = Math.min(top, scroll + Math.max(bottom - limit, MIN_STEP_LINES * body, paragraph));
  const pad = LAND_LINES * body;
  let best = scroll;
  for (let i = 0; i < L.lineCount; i++) {
    const at = L.lineY[i] - pad;
    if (at <= scroll) {
      continue;
    }
    if (at > top) {
      break;
    }
    best = at;
    if (at >= want) {
      break;
    }
  }
  return best;
}

/** Scrolls from `S.minScroll` until the caret on `line` rests in view: the view to show at once. */
export function settledScroll(L: DocLayout, S: ScreenLayout, line: number): number {
  let scroll = S.minScroll;
  for (let n = 0; n < 1000; n++) {
    const next = scrollTarget(L, S, scroll, line);
    if (next === scroll) {
      break;
    }
    scroll = next;
  }
  return scroll;
}

/** Seconds for a scroll step of `px` device pixels at `scale`: within the codec motion limits. */
export const scrollSeconds = (px: number, scale: number): number =>
  Math.max(SCROLL_SECONDS, minTweenSeconds(Math.abs(px) / (scale > 0 ? scale : 1)));
