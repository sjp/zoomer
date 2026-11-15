import { SANS_FONT_STACK } from "../canvas-texture";
import { createChartRenderer, pushPolyline, pushRect, pushRoundRect } from "../charts";
import { createColorEase, hexToUnitRgb } from "../color";
import { beginFrame, withScope } from "../gl";
import { approach, clamp, smoothstep } from "../math";
import { sanitizeText } from "../params";
import { createTextLayer, TEXT_PALETTE_FLOATS, TEXT_ROLES } from "../text-layer";
import { defineEffect } from "../types";
import {
  caretLine,
  type DocLayout,
  layoutDocument,
  pageAt,
  type PageGeom,
  pageGeometry,
  pageTop,
  type ScreenLayout,
  screenLayout,
  scrollSeconds,
  scrollTarget,
  settledScroll,
  STYLE_AUTHOR,
  STYLE_BODY,
  STYLE_COMMENT,
  STYLE_COUNT,
  ZOOM_MARGINS,
  ZOOM_PAGE,
} from "./document-layout";
import {
  AUTHORS as AUTHOR_NAMES,
  BLOCK_BULLETS,
  BLOCK_HEADING,
  BLOCK_TABLE,
  BLOCK_TITLE,
  blockTyped,
  carryTypist,
  createDoc,
  createTypist,
  type Doc,
  MAX_SQUIGGLES,
  squiggleAlpha,
  startSegment,
  stepTypist,
  type Typist,
  typedChars,
  typistDone,
  UNTITLED,
} from "./document-sim";
import { documentMeta, MAX_SPEED, MIN_SPEED } from "./document.meta";

/** Seconds for theme changes, comments showing or hiding, and each half of a document swap. */
const COLOR_EASE = 1.2;
const COMMENT_FADE = 1;
const SWAP_HALF = 0.5;
/** Seconds a finished document rests before the next draft fades in. */
const DONE_HOLD = 5;
/** The caret stays solid this long after a key, then blinks softly at this rate (Hz). */
const CARET_HOLD = 0.5;
const CARET_HZ = 1;
/** Chart vertices, text regions a frame, comments and toolbar blocks drawn at most. */
const MESH_CAPACITY = 20000;
const MAX_COMMENTS = 48;
/** The page and each comment may wrap round the ring (two quads each), plus the chrome labels. */
const MAX_QUADS = 2 * MAX_COMMENTS + 4;
const MAX_ICONS = 24;
/** Points in one squiggle's zigzag at most. */
const SQUIGGLE_POINTS = 96;
/** Reference sizes (1080p): the style box's width, the status text's width. */
const STYLE_W = 150;
const STATUS_W = 420;

/** A serif stack for the page's body text, which reads as a printed report. */
const SERIF_FONT_STACK = `Georgia, Cambria, "Times New Roman", "Liberation Serif", "DejaVu Serif", serif`;

/** Palette slots: one RGB triple each. */
const DESK = 0;
const PAGE = 1;
const TEXT = 2;
const HEADING = 3;
const MUTED = 4;
const CHROME = 5;
const BORDER = 6;
const ICON = 7;
const RULER_MARGIN = 8;
const SQUIGGLE = 9;
const CARET = 10;
const TABLE_HEAD = 11;
const TABLE_LINE = 12;
const COMMENT_BG = 13;
const SHADOW = 14;
const AUTHOR = 15;
const AUTHORS = 3;
const COLORS = AUTHOR + AUTHORS;

const THEMES: Record<string, Float32Array> = {};
for (const [name, hexes] of Object.entries({
  light: [
    "#c9ccd2",
    "#ffffff",
    "#3a3f47",
    "#2c5597",
    "#7a808a",
    "#f3f4f6",
    "#d2d5da",
    "#c4c8cf",
    "#e2e5e9",
    "#d93025",
    "#1f2328",
    "#eef1f5",
    "#c3c8d0",
    "#fbf7e6",
    "#000000",
    "#c2410c",
    "#2563eb",
    "#0f8a5f",
  ],
  dark: [
    "#26282d",
    "#1c1e22",
    "#cfd3d9",
    "#8fb3f0",
    "#8b919b",
    "#16181b",
    "#30343a",
    "#3a3f46",
    "#2a2d33",
    "#f06a5f",
    "#e6e8eb",
    "#262a31",
    "#3b4048",
    "#2b2a24",
    "#000000",
    "#f08a4b",
    "#6b9cf5",
    "#3fbf8a",
  ],
})) {
  const out = new Float32Array(COLORS * 3);
  hexes.forEach((hex, i) => {
    out.set(hexToUnitRgb(hex), i * 3);
  });
  THEMES[name] = out;
}

/** Style-box labels by block kind. */
const STYLE_NAMES = ["Title", "Heading 1", "Normal", "List Bullet", "Table Text"] as const;

/** Page fonts per style, at one geometry. */
function makeFonts(g: PageGeom): string[] {
  const weights = ["600", "600", "400", "400", "600", "400", "600"];
  const stacks = [
    SANS_FONT_STACK,
    SANS_FONT_STACK,
    SERIF_FONT_STACK,
    SANS_FONT_STACK,
    SANS_FONT_STACK,
    SANS_FONT_STACK,
    SANS_FONT_STACK,
  ];
  const out: string[] = [];
  for (let i = 0; i < STYLE_COUNT; i++) {
    out.push(weights[i] + " " + String(Math.max(4, Math.round(g.fontPx[i]))) + "px " + stacks[i]);
  }
  return out;
}

/** `n` with thousands separators. */
function withCommas(n: number): string {
  const s = String(Math.max(0, Math.round(n)));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) {
      out += ",";
    }
    out += s[i];
  }
  return out;
}

/**
 * A word-processor window drafting a report: a toolbar with a style box, a ruler,
 * one or more white pages on a grey desk, and a status strip with a page and word
 * count. Text types itself a character at a time (`document-sim.ts`) onto a
 * device-pixel canvas (`text-layer.ts`) that redraws only the line being typed.
 * The canvas holds the doc rows in view as a ring: when the caret nears the
 * bottom the view eases down a paragraph at a time, each frame painting just
 * the rows it reveals over the ones it hides, the view drawn as two quads where
 * the ring wraps.
 * Pages, tables, bullets, comment balloons, the caret and spelling squiggles are
 * triangles in one chart mesh rebuilt each frame.
 */
export const documentPage = defineEffect(documentMeta, {
  create(gl) {
    return withScope((scope) => {
      const chart = createChartRenderer(gl, scope, MESH_CAPACITY);
      const mesh = chart.mesh;
      const text = createTextLayer(gl, scope, MAX_QUADS);
      const ease = createColorEase(COLORS * 3);
      const col: Float32Array[] = [];
      for (let i = 0; i < COLORS; i++) {
        col.push(ease.value.subarray(i * 3, i * 3 + 3));
      }
      const C = (i: number) => col[i];
      const textPalette = new Float32Array(TEXT_PALETTE_FLOATS);
      const maxTexture = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
      /** Up to three canvas row ranges (and doc-to-canvas y shifts) a doc row range lands on: see `ringPieces`. */
      const pieceA = new Int32Array(3);
      const pieceB = new Int32Array(3);
      const pieceShift = new Int32Array(3);
      const commentLevel = new Float32Array(MAX_COMMENTS);
      const iconX = new Float32Array(MAX_ICONS);
      const sqKnown = new Int32Array(MAX_SQUIGGLES);
      const sqX0 = new Float64Array(MAX_SQUIGGLES);
      const sqX1 = new Float64Array(MAX_SQUIGGLES);
      const sqY = new Float64Array(MAX_SQUIGGLES);
      const zx = new Float32Array(SQUIGGLE_POINTS);
      const zy = new Float32Array(SQUIGGLE_POINTS);
      const measured: Map<string, number>[] = [];
      for (let i = 0; i < STYLE_COUNT; i++) {
        measured.push(new Map());
      }

      let width = 1;
      let height = 1;
      let scale = 1;
      let zoom = ZOOM_PAGE;
      let geom = pageGeometry(1, zoom);
      let S: ScreenLayout = screenLayout(1, 1, 1, geom);
      let fonts = makeFonts(geom);
      let chromeFonts = ["", "", ""];
      let L: DocLayout | null = null;
      let doc: Doc | null = null;
      let typist: Typist | null = null;
      let rawTitle = "";
      let title = "";
      let iconCount = 0;
      let styleX = 0;

      /**
       * The canvas: a ring of `docH` doc rows (doc y lands on canvas row
       * `mod(y, docH) + 1`, holding the rows from `ringTop`), with a guard row on
       * each side copying the row across the wrap so filtering reads the right
       * neighbour, then a band of chrome labels. Columns: the page's on-screen
       * columns from page x `pageLeft` (`pageCols` wide), then the comment
       * pane's on-screen columns (`commentCols` wide).
       */
      let painted = false;
      let docH = 1;
      let ringTop = 0;
      let pageLeft = 0;
      let pageCols = 1;
      let commentCols = 0;
      let bandY = 0;
      /** What the canvas shows of the typist: segment and characters, the status and style labels. */
      let pSeg = -1;
      let pChars = 0;
      let pWords = -1;
      let pPage = -1;
      let pStyle = -1;

      /** The view's scroll (doc y at its top) and the step under way. */
      let scroll = 0;
      let scrollFrom = 0;
      let scrollTo = 0;
      let scrollT = 1;
      let scrollDur = 1;
      /** The caret's line and place (doc coordinates), for the segment and characters it was measured at. */
      let caretIdx = 0;
      let caretX = 0;
      let cSeg = -1;
      let cChars = -1;

      /** Document swap: 1 fading out, 2 fading in; whether the pages fade too (a zoom change). */
      let swapPhase = 0;
      let swapT = 0;
      let swapPages = false;
      let doneT = 0;

      // ---- Measuring and painting (on a change, never every frame).

      const measure = (s: string, style: number): number => {
        const cache = measured[style];
        const known = cache.get(s);
        if (known !== undefined) {
          return known;
        }
        let w = s.length * geom.fontPx[style] * 0.5;
        const ctx = text.ctx;
        if (ctx) {
          ctx.font = fonts[style];
          const m = (ctx.measureText(s) as TextMetrics | undefined)?.width;
          if (m !== undefined && m >= 0) {
            w = m;
          }
        }
        cache.set(s, w);
        return w;
      };

      const fill = (
        t: string,
        x: number,
        y: number,
        role: string,
        font: string,
        maxWidth: number,
      ) => {
        const ctx = text.ctx;
        if (!ctx || !(maxWidth > 0) || t.length === 0) {
          return;
        }
        ctx.font = font;
        ctx.fillStyle = role;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(t, Math.round(x), Math.round(y), maxWidth);
      };
      const R = (n: number) => Math.round(n * scale);

      /**
       * Fills `pieceA/B/Shift` with where doc rows `y0 .. y1` (clipped to the
       * ring's rows) land on the canvas: the ring row range, cut where it wraps,
       * plus the guard rows; returns how many pieces.
       */
      const ringPieces = (y0: number, y1: number): number => {
        const a = Math.max(y0, ringTop);
        const b = Math.min(y1, ringTop + docH);
        if (b <= a) {
          return 0;
        }
        const shift = (((a % docH) + docH) % docH) + 1 - a;
        let n = 0;
        for (let k = -1; k <= 1; k++) {
          const sh = shift + k * docH;
          const pa = Math.max(0, a + sh);
          const pb = Math.min(docH + 2, b + sh);
          if (pb > pa) {
            pieceA[n] = pa;
            pieceB[n] = pb;
            pieceShift[n] = sh;
            n++;
          }
        }
        return n;
      };

      /** Clips drawing to canvas rect `x .. x + w` by rows `a .. b`, and clears it; undo with `ctx.restore()`. */
      const clipClear = (
        ctx: OffscreenCanvasRenderingContext2D,
        x: number,
        w: number,
        a: number,
        b: number,
      ) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, a, w, b - a);
        ctx.clip();
        text.clear(x, a, w, b - a);
      };

      /** Draws whatever of line `i` is typed, doc y shifted by `shift` onto the canvas. */
      const drawLine = (d: Doc, t: Typist, Ld: DocLayout, i: number, shift: number) => {
        const s = Ld.lineSeg[i];
        const end = Math.min(Ld.lineEnd[i], typedChars(d, t, s));
        if (end <= Ld.lineStart[i]) {
          return;
        }
        const style = Ld.lineStyle[i];
        const kind = d.blocks[d.segments[s].block].kind;
        fill(
          d.segments[s].text.slice(Ld.lineStart[i], end),
          Ld.lineX[i] - pageLeft,
          Ld.lineY[i] + shift + Ld.lineH[i] / 2,
          kind === BLOCK_TITLE || kind === BLOCK_HEADING ? TEXT_ROLES.up : TEXT_ROLES.primary,
          fonts[style],
          Ld.lineW[i] + (kind === BLOCK_TABLE ? 0 : 2 * geom.k),
        );
      };

      /** Draws comment `c`'s author and text, doc y shifted by `shift` onto the canvas. */
      const drawComment = (Ld: DocLayout, ci: number, shift: number) => {
        const g = geom;
        const c = Ld.comments[ci];
        const tx = pageCols + g.commentBar + g.commentPad;
        const tw = g.commentW - g.commentBar - 2 * g.commentPad;
        let ty = c.y + shift + g.commentPad;
        fill(
          AUTHOR_NAMES[c.author],
          tx,
          ty + g.lineH[STYLE_AUTHOR] / 2,
          TEXT_ROLES.muted,
          fonts[STYLE_AUTHOR],
          tw,
        );
        ty += g.lineH[STYLE_AUTHOR];
        for (let i = 0; i < c.starts.length; i++) {
          fill(
            c.text.slice(c.starts[i], c.ends[i]),
            tx,
            ty + g.lineH[STYLE_COMMENT] / 2,
            TEXT_ROLES.primary,
            fonts[STYLE_COMMENT],
            tw + 2,
          );
          ty += g.lineH[STYLE_COMMENT];
        }
      };

      /** Repaints line `i` with whatever of it is typed. */
      const paintLine = (d: Doc, t: Typist, Ld: DocLayout, i: number) => {
        const ctx = text.ctx;
        if (!ctx) {
          return;
        }
        const x0 = Math.max(0, Ld.lineX[i] - pageLeft - 2);
        const x1 = Math.min(pageCols, Ld.lineX[i] - pageLeft + Ld.lineW[i] + 2);
        if (x1 <= x0) {
          return;
        }
        const n = ringPieces(Ld.lineY[i], Ld.lineY[i] + Ld.lineH[i]);
        for (let k = 0; k < n; k++) {
          clipClear(ctx, x0, x1 - x0, pieceA[k], pieceB[k]);
          drawLine(d, t, Ld, i, pieceShift[k]);
          ctx.restore();
        }
      };

      /** Repaints the lines of segment `s` whose text spans characters `a` .. `b`. */
      const paintSegment = (d: Doc, t: Typist, Ld: DocLayout, s: number, a: number, b: number) => {
        if (s < 0 || s >= d.segments.length) {
          return;
        }
        for (let i = Ld.segLine[s]; i < Ld.segLine[s] + Ld.segLines[s]; i++) {
          if (Ld.lineStart[i] <= b && Ld.lineEnd[i] + 1 >= a) {
            paintLine(d, t, Ld, i);
          }
        }
      };

      /** Clears and paints doc rows `y0 .. y1` (within the ring's rows): the lines and comments on them. */
      const paintRows = (d: Doc, t: Typist, Ld: DocLayout, y0: number, y1: number) => {
        const ctx = text.ctx;
        if (!ctx) {
          return;
        }
        const n = ringPieces(y0, y1);
        for (let k = 0; k < n; k++) {
          const a = pieceA[k] - pieceShift[k];
          const b = pieceB[k] - pieceShift[k];
          clipClear(ctx, 0, pageCols, pieceA[k], pieceB[k]);
          for (let i = 0; i < Ld.lineCount; i++) {
            if (Ld.lineY[i] + Ld.lineH[i] > a && Ld.lineY[i] < b) {
              drawLine(d, t, Ld, i, pieceShift[k]);
            }
          }
          ctx.restore();
          if (commentCols > 0) {
            clipClear(ctx, pageCols, commentCols, pieceA[k], pieceB[k]);
            for (let i = 0; i < Ld.comments.length; i++) {
              const c = Ld.comments[i];
              if (c.y + c.h > a && c.y < b) {
                drawComment(Ld, i, pieceShift[k]);
              }
            }
            ctx.restore();
          }
        }
      };

      const paintStyle = (kind: number) => {
        pStyle = kind;
        text.clear(0, bandY, R(STYLE_W), S.toolbarH);
        fill(
          STYLE_NAMES[kind] ?? STYLE_NAMES[2],
          R(10),
          bandY + S.toolbarH / 2,
          TEXT_ROLES.primary,
          chromeFonts[0],
          R(STYLE_W - 36),
        );
      };

      /** The caret's page, 1-based. */
      const caretPage = (Ld: DocLayout) => pageAt(geom, Ld.lineY[caretIdx]) + 1;

      /** Paints "Page n of m · w words". */
      const paintStatus = (t: Typist, Ld: DocLayout) => {
        pPage = caretPage(Ld);
        pWords = t.words;
        const s =
          "Page " +
          String(pPage) +
          " of " +
          String(Ld.pages) +
          "  \u00b7  " +
          withCommas(t.words) +
          " words";
        const y = bandY + S.toolbarH;
        text.clear(0, y, R(STATUS_W), S.statusH);
        fill(s, R(14), y + S.statusH / 2, TEXT_ROLES.muted, chromeFonts[1], R(STATUS_W - 20));
      };

      const paintRuler = () => {
        const g = geom;
        const y = bandY + S.toolbarH + S.statusH;
        text.clear(0, y, pageCols, S.rulerH);
        const n = Math.floor(g.contentW / g.inch + 1e-6);
        for (let i = 1; i <= n; i++) {
          const x = g.margin + i * g.inch;
          if (x < g.pageW - g.margin - 2) {
            fill(
              String(i),
              x - R(3) - pageLeft,
              y + S.rulerH / 2,
              TEXT_ROLES.muted,
              chromeFonts[2],
              R(14),
            );
          }
        }
      };

      /**
       * Moves the ring to hold the doc rows from `top` and paints the rows that
       * come into it (over the ones that leave); the rows it kept stay as they are.
       */
      const moveRing = (top: number) => {
        const d = doc;
        const t = typist;
        const Ld = L;
        const from = ringTop;
        ringTop = Math.floor(top);
        if (!painted || !d || !t || !Ld) {
          return;
        }
        if (ringTop > from && ringTop < from + docH) {
          paintRows(d, t, Ld, from + docH, ringTop + docH);
        } else if (ringTop < from && ringTop + docH > from) {
          paintRows(d, t, Ld, ringTop, from);
        } else if (ringTop !== from) {
          paintRows(d, t, Ld, ringTop, ringTop + docH);
        }
      };

      /** Positions the ring from doc y `top` and paints everything on the canvas. */
      const paintAll = (top: number) => {
        const d = doc;
        const t = typist;
        const Ld = L;
        if (!d || !t || !Ld || !text.ctx) {
          painted = false;
          return;
        }
        ringTop = Math.floor(top);
        text.clear(0, 0, text.width, text.height);
        paintRows(d, t, Ld, ringTop, ringTop + docH);
        paintStyle(d.blocks[d.segments[Math.min(t.seg, d.segments.length - 1)].block].kind);
        paintStatus(t, Ld);
        paintRuler();
        pSeg = t.seg;
        pChars = t.chars;
        painted = true;
      };

      /** Measures where the caret sits, after the typed text. */
      const placeCaret = (d: Doc, t: Typist, Ld: DocLayout) => {
        cSeg = t.seg;
        cChars = t.chars;
        const s = Math.min(t.seg, d.segments.length - 1);
        const chars = typedChars(d, t, s);
        caretIdx = caretLine(Ld, s, chars);
        const a = Ld.lineStart[caretIdx];
        const b = Math.min(chars, Ld.lineEnd[caretIdx]);
        caretX =
          Ld.lineX[caretIdx] +
          (b > a ? measure(d.segments[s].text.slice(a, b), Ld.lineStyle[caretIdx]) : 0);
        if (chars > Ld.lineEnd[caretIdx]) {
          caretX += measure(" ", Ld.lineStyle[caretIdx]);
        }
      };

      /** Places squiggle `i` under its word. */
      const placeSquiggle = (d: Doc, t: Typist, Ld: DocLayout, i: number) => {
        sqKnown[i] = t.sqId[i];
        const s = t.sqSeg[i];
        if (s < 0 || s >= d.segments.length) {
          sqX1[i] = sqX0[i];
          return;
        }
        const line = caretLine(Ld, s, t.sqFrom[i]);
        const a = Ld.lineStart[line];
        const txt = d.segments[s].text;
        const style = Ld.lineStyle[line];
        sqX0[i] =
          Ld.lineX[line] + (t.sqFrom[i] > a ? measure(txt.slice(a, t.sqFrom[i]), style) : 0);
        sqX1[i] = Ld.lineX[line] + measure(txt.slice(a, t.sqTo[i]), style);
        sqY[i] = Ld.lineY[line] + Math.round(Ld.lineH[line] * 0.82);
      };

      /** Lays everything out for the current size, zoom and document, and shows the caret at rest. */
      const relayout = () => {
        geom = pageGeometry(scale, zoom);
        S = screenLayout(width, height, scale, geom);
        fonts = makeFonts(geom);
        const px = (n: number) =>
          String(Math.max(4, Math.round(n * scale))) + "px " + SANS_FONT_STACK;
        chromeFonts = ["400 " + px(13), "400 " + px(12), "400 " + px(10)];
        for (const m of measured) {
          m.clear();
        }
        // Only the columns on screen, and the view's rows (one more for a
        // fractional scroll, a guard row each side): a window's size and a few rows.
        pageLeft = clamp(-S.pageX, 0, geom.pageW - 1);
        pageCols = clamp(width - S.pageX, pageLeft + 1, geom.pageW) - pageLeft;
        commentCols = clamp(width - S.paneX, 0, geom.commentW);
        const band = S.toolbarH + S.statusH + S.rulerH;
        docH = S.viewH + 1;
        bandY = docH + 2;
        text.resize(
          Math.min(maxTexture, Math.max(pageCols + commentCols, R(STATUS_W), R(STYLE_W))),
          Math.min(maxTexture, bandY + band),
        );
        sqKnown.fill(0);
        // Toolbar blocks: a group, the style box, then more groups, all on the left.
        const size = R(20);
        const gap = R(8);
        let x = R(14);
        iconCount = 0;
        styleX = 0;
        for (const g of [3, 0, 4, 3, 2, 4]) {
          if (g === 0) {
            styleX = x;
            x += R(STYLE_W) + R(18);
            continue;
          }
          for (let i = 0; i < g && iconCount < MAX_ICONS; i++) {
            if (x + size > width * 0.62) {
              break;
            }
            iconX[iconCount++] = x;
            x += size + gap;
          }
          x += R(18);
        }
        const d = doc;
        const t = typist;
        if (!d || !t) {
          L = null;
          return;
        }
        L = layoutDocument(d, geom, measure);
        placeCaret(d, t, L);
        scroll = settledScroll(L, S, caretIdx);
        scrollFrom = scroll;
        scrollTo = scroll;
        scrollT = 1;
        paintAll(scroll);
      };

      /** Shows document `d` with typist `t`, laid out from scratch. */
      const adopt = (d: Doc, t: Typist) => {
        doc = d;
        typist = t;
        commentLevel.fill(0);
        doneT = 0;
        relayout();
      };

      // ---- Geometry (per frame). Doc coordinates map to the screen through the scroll.

      const sy = (y: number) => S.viewTop + y - scroll;

      const drawPages = (a: number) => {
        const g = geom;
        const first = pageAt(g, Math.max(0, scroll));
        const last = Math.min(pageAt(g, Math.max(0, scroll + S.viewH)), (L?.pages ?? 1) - 1);
        const x0 = S.pageX;
        const x1 = S.pageX + g.pageW;
        const r = Math.max(1, R(2));
        for (let p = first; p <= last; p++) {
          const top = sy(pageTop(g, p));
          const bottom = top + g.pageH;
          pushRoundRect(
            mesh,
            x0 - R(3),
            top - R(1),
            x1 + R(3),
            bottom + R(6),
            R(6),
            C(SHADOW),
            0.06 * a,
          );
          pushRoundRect(
            mesh,
            x0 - R(1),
            top,
            x1 + R(1),
            bottom + R(2),
            r + R(1),
            C(SHADOW),
            0.1 * a,
          );
          pushRect(mesh, x0, top, x1, bottom, C(PAGE), a);
        }
      };

      const drawContent = (d: Doc, t: Typist, Ld: DocLayout, a: number) => {
        const g = geom;
        const one = Math.max(1, Math.round(g.k));
        const viewBottom = scroll + S.viewH;
        // Tables appear a row at a time, as their first cells are typed.
        for (const tb of Ld.tables) {
          const block = d.blocks[tb.block];
          const x0 = S.pageX + tb.x;
          const x1 = x0 + tb.w;
          for (let r = 0; r < tb.rows; r++) {
            const y = tb.rowY[r];
            if (t.seg < block.firstSeg + r * block.cols || y > viewBottom || y + g.rowH < scroll) {
              continue;
            }
            const top = sy(y);
            if (r === 0) {
              pushRect(mesh, x0, top, x1, top + g.rowH, C(TABLE_HEAD), a);
            }
            pushRect(mesh, x0, top, x1, top + one, C(TABLE_LINE), a);
            pushRect(mesh, x0, top + g.rowH - one, x1, top + g.rowH, C(TABLE_LINE), a);
            for (let c = 0; c <= tb.cols; c++) {
              const x = Math.min(x1 - one, x0 + c * tb.colW);
              pushRect(mesh, x, top, x + one, top + g.rowH, C(TABLE_LINE), a);
            }
          }
        }
        // Bullets, once their item starts.
        for (const block of d.blocks) {
          if (block.kind !== BLOCK_BULLETS) {
            continue;
          }
          for (let s = block.firstSeg; s < block.firstSeg + block.segCount && s <= t.seg; s++) {
            const line = Ld.segLine[s];
            const y = Ld.lineY[line];
            if (y > viewBottom || y + Ld.lineH[line] < scroll || (s === t.seg && t.chars === 0)) {
              continue;
            }
            const cx = S.pageX + Ld.lineX[line] - g.indent + g.bulletX;
            const cy = sy(y) + Ld.lineH[line] / 2;
            const rad = Math.max(1.5, 2.4 * g.k);
            pushRoundRect(mesh, cx - rad, cy - rad, cx + rad, cy + rad, rad, C(TEXT), a);
          }
        }
      };

      const drawComments = (Ld: DocLayout, a: number) => {
        const g = geom;
        const one = Math.max(1, R(1));
        for (let i = 0; i < Ld.comments.length && i < MAX_COMMENTS; i++) {
          const k = smoothstep(0, 1, commentLevel[i]) * a;
          const c = Ld.comments[i];
          if (!(k > 0) || c.y > scroll + S.viewH || c.y + c.h < scroll) {
            continue;
          }
          const x0 = S.paneX;
          const x1 = x0 + g.commentW;
          const top = sy(c.y);
          const ac = C(AUTHOR + (c.author % AUTHORS));
          // A thin lead from the page's right margin to the balloon.
          const ly = sy(c.anchor) + Math.round(g.lineH[STYLE_BODY] / 2);
          const lx = S.pageX + g.pageW - Math.round(g.margin / 2);
          pushRect(mesh, lx, ly, x0, ly + one, ac, 0.45 * k);
          if (top !== ly) {
            pushRect(
              mesh,
              x0 - one,
              Math.min(ly, top + R(10)),
              x0,
              Math.max(ly + one, top + R(10)),
              ac,
              0.45 * k,
            );
          }
          pushRoundRect(
            mesh,
            x0 - R(1),
            top,
            x1 + R(1),
            top + c.h + R(3),
            R(5),
            C(SHADOW),
            0.08 * k,
          );
          pushRoundRect(mesh, x0, top, x1, top + c.h, R(4), C(COMMENT_BG), k);
          pushRoundRect(
            mesh,
            x0,
            top,
            x0 + g.commentBar,
            top + c.h,
            Math.min(R(4), g.commentBar / 2),
            ac,
            k,
          );
        }
      };

      const drawCaret = (t: Typist, Ld: DocLayout, a: number) => {
        const idle = t.idle - CARET_HOLD;
        const blink = idle <= 0 ? 1 : 0.575 + 0.425 * Math.cos(2 * Math.PI * CARET_HZ * idle);
        const h = Ld.lineH[caretIdx];
        const top = sy(Ld.lineY[caretIdx]) + Math.round(h * 0.08);
        const x = Math.round(S.pageX + caretX);
        const w = Math.max(1, Math.round(1.3 * geom.k));
        pushRect(mesh, x, top, x + w, top + Math.round(h * 0.84), C(CARET), blink * a);
      };

      const drawSquiggles = (d: Doc, t: Typist, Ld: DocLayout, a: number) => {
        const amp = Math.max(1, 1.3 * geom.k);
        const half = Math.max(2, 2.2 * geom.k);
        for (let i = 0; i < MAX_SQUIGGLES; i++) {
          const k = squiggleAlpha(t, i) * a;
          if (!(k > 0)) {
            continue;
          }
          if (sqKnown[i] !== t.sqId[i]) {
            placeSquiggle(d, t, Ld, i);
          }
          const x0 = S.pageX + sqX0[i];
          const span = sqX1[i] - sqX0[i];
          const y = sy(sqY[i]);
          const n = Math.min(SQUIGGLE_POINTS, Math.max(2, Math.floor(span / half) + 1));
          for (let j = 0; j < n; j++) {
            zx[j] = x0 + (span * j) / (n - 1);
            zy[j] = y + (j % 2 === 0 ? -amp : amp) / 2;
          }
          pushPolyline(mesh, zx, zy, 0, n, Math.max(1, geom.k), C(SQUIGGLE), k);
        }
      };

      const drawChrome = () => {
        const g = geom;
        const one = Math.max(1, R(1));
        // Toolbar: icon blocks, the style box, a search pill on the right.
        const tb = S.toolbarH;
        pushRect(mesh, 0, 0, width, tb, C(CHROME), 1);
        const size = R(20);
        const iy = (tb - size) / 2;
        for (let i = 0; i < iconCount; i++) {
          pushRoundRect(mesh, iconX[i], iy, iconX[i] + size, iy + size, R(4), C(ICON), 1);
        }
        const bh = R(26);
        const by = Math.round((tb - bh) / 2);
        const sw = R(STYLE_W);
        pushRoundRect(mesh, styleX, by, styleX + sw, by + bh, R(4), C(BORDER), 1);
        pushRoundRect(
          mesh,
          styleX + one,
          by + one,
          styleX + sw - one,
          by + bh - one,
          R(3),
          C(PAGE),
          1,
        );
        pushRoundRect(
          mesh,
          styleX + sw - R(20),
          by + R(10),
          styleX + sw - R(10),
          by + R(16),
          R(2),
          C(ICON),
          1,
        );
        if (width > R(900)) {
          pushRoundRect(mesh, width - R(240), iy, width - R(14), iy + size, R(10), C(ICON), 0.6);
        }
        pushRect(mesh, 0, tb - one, width, tb, C(BORDER), 1);
        // Ruler: the page's width, its margins shaded, quarter-inch ticks and indent markers.
        const ry = tb;
        const rh = S.rulerH;
        pushRect(mesh, 0, ry, width, ry + rh, C(CHROME), 1);
        const sTop = ry + R(5);
        const sBottom = ry + rh - R(5);
        const px0 = S.pageX;
        const left = px0 + g.margin;
        const right = px0 + g.pageW - g.margin;
        pushRect(mesh, px0, sTop, px0 + g.pageW, sBottom, C(RULER_MARGIN), 1);
        pushRect(mesh, left, sTop, right, sBottom, C(PAGE), 1);
        const quarter = g.inch / 4;
        for (let q = -Math.floor(g.margin / quarter); left + q * quarter < px0 + g.pageW; q++) {
          if (q % 4 === 0) {
            continue;
          }
          const x = Math.round(left + q * quarter);
          const th = q % 2 === 0 ? R(6) : R(3);
          const mid = (sTop + sBottom) / 2;
          pushRect(mesh, x, mid - th / 2, x + one, mid + th / 2, C(MUTED), 0.8);
        }
        const mk = R(5);
        pushRect(mesh, left - mk, sTop - R(3), left + mk, sTop + R(2), C(MUTED), 1);
        pushRect(mesh, left - mk, sBottom - R(2), left + mk, sBottom + R(3), C(MUTED), 1);
        pushRect(mesh, right - mk, sBottom - R(2), right + mk, sBottom + R(3), C(MUTED), 1);
        pushRect(mesh, 0, ry + rh - one, width, ry + rh, C(BORDER), 1);
        // Status strip: the label on the left, view blocks and a zoom slider on the right.
        const st = height - S.statusH;
        pushRect(mesh, 0, st, width, height, C(CHROME), 1);
        pushRect(mesh, 0, st, width, st + one, C(BORDER), 1);
        const bs = R(12);
        const cy = st + S.statusH / 2;
        let x = width - R(230);
        for (let i = 0; i < 3; i++) {
          pushRoundRect(mesh, x, cy - bs / 2, x + bs, cy + bs / 2, R(2), C(ICON), 1);
          x += bs + R(8);
        }
        x += R(14);
        pushRect(mesh, x, cy - one / 2, width - R(20), cy + one / 2 + 1, C(ICON), 1);
        const knob = x + (width - R(20) - x) * (zoom === ZOOM_PAGE ? 0.4 : 0.62);
        pushRoundRect(mesh, knob - R(3), cy - R(6), knob + R(3), cy + R(6), R(2), C(MUTED), 1);
      };

      // ---- Text regions (per frame).

      /**
       * Queues the ring's doc rows `y0 .. y1` at canvas x `cx` (width `w`), on
       * screen at `x`, clipped to the view: two quads if they wrap.
       */
      const docQuad = (cx: number, y0: number, y1: number, w: number, x: number, alpha: number) => {
        const a = Math.max(y0, scroll, ringTop);
        const b = Math.min(y1, scroll + S.viewH, ringTop + docH);
        if (!(b > a) || !(w > 0)) {
          return;
        }
        const c = (((a % docH) + docH) % docH) + 1;
        const first = Math.min(b - a, docH + 1 - c);
        text.quad(cx, c, w, first, x, sy(a), w, first, alpha);
        if (b - a > first) {
          text.quad(cx, 1, w, b - a - first, x, sy(a) + first, w, b - a - first, alpha);
        }
      };

      const queueDocText = (Ld: DocLayout, ca: number) => {
        docQuad(0, scroll, scroll + S.viewH, pageCols, S.pageX + pageLeft, ca);
        for (let i = 0; i < Ld.comments.length && i < MAX_COMMENTS; i++) {
          const k = smoothstep(0, 1, commentLevel[i]) * ca;
          const c = Ld.comments[i];
          if (k > 0) {
            docQuad(pageCols, c.y, c.y + c.h, commentCols, S.paneX, k);
          }
        }
      };

      const queueChromeText = () => {
        const sw = R(STYLE_W);
        const sb = S.toolbarH;
        text.quad(0, bandY, sw, sb, styleX, 0, sw, sb, 1);
        const stw = R(STATUS_W);
        text.quad(0, bandY + sb, stw, S.statusH, 0, height - S.statusH, stw, S.statusH, 1);
        const ry = bandY + sb + S.statusH;
        text.quad(0, ry, pageCols, S.rulerH, S.pageX + pageLeft, S.toolbarH, pageCols, S.rulerH, 1);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          if (doc) {
            relayout();
          }
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const speed = clamp(p.speed, MIN_SPEED, MAX_SPEED);
          const wantZoom = p.layout === "margins" ? ZOOM_MARGINS : ZOOM_PAGE;
          if (p.title !== rawTitle) {
            // Allocates: the sanitised title, once per edit.
            rawTitle = p.title;
            title = sanitizeText(documentMeta.params.title, p.title).trim();
          }

          let d = doc;
          let t = typist;
          if (!d || !t) {
            // Allocates: the first document, laid out at the param zoom.
            zoom = wantZoom;
            d = createDoc(p.seed, 0, title);
            t = createTypist(d, p.seed, startSegment(d, p.seed));
            adopt(d, t);
            ease.snap();
          }

          // A new variation, title or layout, or a finished draft, fades the document out and back in.
          if (typistDone(t)) {
            doneT += step;
          }
          const retitled = d.title !== (title === "" ? UNTITLED : title);
          if (
            swapPhase === 0 &&
            (d.seed !== p.seed || retitled || wantZoom !== zoom || doneT > DONE_HOLD)
          ) {
            swapPhase = 1;
            swapT = 0;
            swapPages = wantZoom !== zoom;
          }
          if (swapPhase === 1) {
            swapT = Math.min(1, swapT + step / SWAP_HALF);
            if (swapT >= 1) {
              // Allocates: a new document or layout, once per change.
              zoom = wantZoom;
              if (d.seed !== p.seed) {
                d = createDoc(p.seed, 0, title);
                t = createTypist(d, p.seed, startSegment(d, p.seed));
              } else if (typistDone(t) && doneT > DONE_HOLD) {
                d = createDoc(d.seed, d.generation + 1, title);
                t = createTypist(d, d.seed, 0);
              } else if (retitled) {
                d = createDoc(d.seed, d.generation, title);
                t = carryTypist(d, t, d.seed);
              }
              adopt(d, t);
              swapPhase = 2;
              swapT = 0;
            }
          } else if (swapPhase === 2) {
            swapT = Math.min(1, swapT + step / SWAP_HALF);
            if (swapT >= 1) {
              swapPhase = 0;
            }
          }
          const ca =
            swapPhase === 1
              ? 1 - smoothstep(0, 1, swapT)
              : swapPhase === 2
                ? smoothstep(0, 1, swapT)
                : 1;
          const pa = swapPages ? ca : 1;

          if (swapPhase !== 1) {
            stepTypist(d, t, step, speed);
          }
          const Ld = L;

          // Colours.
          ease.step(THEMES[p.theme] ?? THEMES.light, step, COLOR_EASE);
          for (let k = 0; k < 3; k++) {
            textPalette[k] = col[TEXT][k];
            textPalette[3 + k] = col[MUTED][k];
            textPalette[6 + k] = col[HEADING][k];
            textPalette[9 + k] = col[SQUIGGLE][k];
            textPalette[12 + k] = col[PAGE][k];
          }

          if (Ld) {
            for (let i = 0; i < Ld.comments.length && i < MAX_COMMENTS; i++) {
              const show = p.comments && blockTyped(d, t, Ld.comments[i].block);
              commentLevel[i] = approach(commentLevel[i], show ? 1 : 0, step / COMMENT_FADE);
            }

            // Text: the lines the typist touched since the last frame.
            if (t.seg !== pSeg || t.chars !== pChars) {
              if (painted) {
                if (t.seg !== pSeg) {
                  for (let s = Math.max(0, pSeg); s <= t.seg; s++) {
                    paintSegment(d, t, Ld, s, 0, Infinity);
                  }
                } else {
                  paintSegment(
                    d,
                    t,
                    Ld,
                    t.seg,
                    Math.min(pChars, t.chars),
                    Math.max(pChars, t.chars),
                  );
                }
              }
              pSeg = t.seg;
              pChars = t.chars;
            }
            if (t.seg !== cSeg || t.chars !== cChars) {
              placeCaret(d, t, Ld);
            }
            if (painted) {
              const kind = d.blocks[d.segments[Math.min(t.seg, d.segments.length - 1)].block].kind;
              if (kind !== pStyle) {
                paintStyle(kind);
              }
              if (t.words !== pWords || caretPage(Ld) !== pPage) {
                paintStatus(t, Ld);
              }
            }

            // Scrolling: a paragraph at a time, painting just the rows each frame reveals.
            if (scrollT >= 1) {
              const target = scrollTarget(Ld, S, scrollTo, caretIdx);
              if (target !== scrollTo) {
                scrollFrom = scroll;
                scrollTo = target;
                scrollT = 0;
                scrollDur = scrollSeconds(target - scrollFrom, scale);
              }
            }
            if (scrollT < 1) {
              scrollT = Math.min(1, scrollT + step / scrollDur);
              scroll = scrollFrom + (scrollTo - scrollFrom) * smoothstep(0, 1, scrollT);
              moveRing(scroll);
            }
          }
          text.flush();

          // Geometry: pages and their marks, then the text, then the chrome and its labels.
          mesh.count = 0;
          drawPages(pa);
          if (Ld) {
            drawContent(d, t, Ld, ca);
            drawComments(Ld, ca);
            drawSquiggles(d, t, Ld, ca);
            drawCaret(t, Ld, ca);
          }
          const chromeFirst = mesh.count;
          drawChrome();
          chart.upload();

          gl.clearColor(col[DESK][0], col[DESK][1], col[DESK][2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          chart.draw(width, height, 0, chromeFirst);
          if (painted && Ld) {
            queueDocText(Ld, ca);
            text.draw(width, height, textPalette);
          }
          chart.draw(width, height, chromeFirst, mesh.count - chromeFirst);
          if (painted) {
            queueChromeText();
            text.draw(width, height, textPalette);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
