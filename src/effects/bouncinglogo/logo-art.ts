/**
 * The Bouncing Logo's artwork: heavy, wide italic letters above a flattened
 * disc with "VIDEO" cut out of it, drawn with a 2D canvas. The letters D and V
 * have hand-built outlines (a wide D with a slim counter, a pointed V tucked in
 * between), so the default "DVD" looks the part; any other text is set in a
 * heavy italic system font.
 *
 * Lengths are in letter heights: the letters' cap height is 1.
 */
import { SANS_FONT_STACK } from "../canvas-texture";

/** Horizontal lean of the letters: the top shifts right by this per letter height. */
const SLANT = 0.24;
/** Gap between the letters and the disc. */
const DISC_GAP = 0.1;
/** Disc height (twice its vertical radius). */
const DISC_HEIGHT = 0.6;
/** Disc width relative to the letters, and its least width (so short text keeps a disc). */
const DISC_SCALE = 0.96;
const MIN_DISC_WIDTH = 2.4;
/** Cap height of the system font per font size, roughly. */
const FONT_CAP = 0.72;
/** Advance per character when the font can't be measured, in letter heights. */
const FALLBACK_ADVANCE = 0.95;
/** "VIDEO": font size, and letter spacing as a fraction of the disc width. */
const VIDEO_SIZE = 0.34;
const VIDEO_SPACING = 0.13;
const VIDEO_WEIGHT = 500;

interface Glyph {
  /** Pen advance, in glyph units (100 per letter height). */
  advance: number;
  /** Traces the outline in glyph units, y down from the top; filled even-odd. */
  trace: (ctx: OffscreenCanvasRenderingContext2D) => void;
}

const GLYPHS: Record<string, Glyph> = {
  D: {
    advance: 104,
    trace(ctx) {
      ctx.moveTo(0, 0);
      ctx.lineTo(62, 0);
      ctx.bezierCurveTo(108, 0, 128, 22, 128, 50);
      ctx.bezierCurveTo(128, 80, 104, 100, 58, 100);
      ctx.lineTo(0, 100);
      ctx.closePath();
      // The counter: a slim lens inside the bowl.
      ctx.moveTo(34, 22);
      ctx.lineTo(58, 22);
      ctx.bezierCurveTo(83, 22, 93, 34, 93, 50);
      ctx.bezierCurveTo(93, 67, 82, 78, 57, 78);
      ctx.lineTo(34, 78);
      ctx.closePath();
    },
  },
  V: {
    advance: 100,
    trace(ctx) {
      ctx.moveTo(0, 0);
      ctx.lineTo(34, 0);
      ctx.lineTo(56, 58);
      ctx.lineTo(80, 0);
      ctx.lineTo(114, 0);
      ctx.lineTo(70, 100);
      ctx.lineTo(42, 100);
      ctx.closePath();
    },
  },
};
/** Ink width of each built-in glyph beyond its advance, for the last letter. */
const GLYPH_INK: Record<string, number> = { D: 128, V: 114 };

interface LogoLayout {
  /** The letters to draw, upper-cased; empty for a disc alone. */
  text: string;
  /** Whether the letters use the built-in outlines rather than the system font. */
  builtIn: boolean;
  /** Width of the letters, slant included. */
  lettersWidth: number;
  /** The whole logo's box. */
  width: number;
  height: number;
  /** The disc's centre and radii. */
  discX: number;
  discY: number;
  discRx: number;
  discRy: number;
}

/** The heavy italic font for `px` px letters (cap height), for text without built-in outlines. */
export function letterFont(px: number): string {
  return `italic 900 ${String(px / FONT_CAP)}px ${SANS_FONT_STACK}`;
}

/**
 * Lays out the logo for `text`. `measure` gives the width of a string set in
 * `letterFont(1)`, or undefined where it can't be measured.
 */
export function logoLayout(text: string, measure: (s: string) => number | undefined): LogoLayout {
  const upper = text.trim().toLocaleUpperCase();
  const builtIn = upper.length > 0 && /^[DV]+$/.test(upper);
  let lettersWidth = 0;
  if (builtIn) {
    let pen = 0;
    for (let i = 0; i < upper.length - 1; i++) {
      pen += GLYPHS[upper[i]].advance;
    }
    lettersWidth = (pen + GLYPH_INK[upper[upper.length - 1]]) / 100 + SLANT;
  } else if (upper.length > 0) {
    const w = measure(upper);
    const chars = Array.from(upper).length;
    lettersWidth =
      (typeof w === "number" && Number.isFinite(w) && w > 0 ? w : FALLBACK_ADVANCE * chars) + SLANT;
  }
  const discWidth = Math.max(lettersWidth * DISC_SCALE, MIN_DISC_WIDTH);
  const width = Math.max(lettersWidth, discWidth);
  const top = upper.length > 0 ? 1 + DISC_GAP : 0;
  return {
    text: upper,
    builtIn,
    lettersWidth,
    width,
    height: top + DISC_HEIGHT,
    discX: width / 2,
    discY: top + DISC_HEIGHT / 2,
    discRx: discWidth / 2,
    discRy: DISC_HEIGHT / 2,
  };
}

/**
 * Draws the logo in `ctx`'s current fill style with its box's top-left at
 * (`left`, `top`), `unit` px per letter height, on a transparent canvas: "VIDEO"
 * is cut out of the disc, leaving it transparent.
 */
export function drawLogo(
  ctx: OffscreenCanvasRenderingContext2D,
  layout: LogoLayout,
  left: number,
  top: number,
  unit: number,
): void {
  const lettersLeft = left + (layout.width - layout.lettersWidth) / 2;
  if (layout.builtIn) {
    const k = unit / 100;
    let pen = 0;
    for (const ch of layout.text) {
      const glyph = GLYPHS[ch];
      // Skew so the top leans right, the bottom staying on the baseline.
      ctx.setTransform(k, 0, -k * SLANT, k, lettersLeft + k * pen + unit * SLANT, top);
      ctx.beginPath();
      glyph.trace(ctx);
      ctx.fill("evenodd");
      pen += glyph.advance;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else if (layout.text.length > 0) {
    ctx.font = letterFont(unit);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(layout.text, lettersLeft + (layout.lettersWidth * unit) / 2, top + unit);
  }

  const cx = left + layout.discX * unit;
  const cy = top + layout.discY * unit;
  ctx.beginPath();
  ctx.ellipse(cx, cy, layout.discRx * unit, layout.discRy * unit, 0, 0, 2 * Math.PI);
  ctx.fill();

  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000";
  ctx.font = `${String(VIDEO_WEIGHT)} ${String(VIDEO_SIZE * unit)}px ${SANS_FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const spacing = VIDEO_SPACING * 2 * layout.discRx * unit;
  const word = "VIDEO";
  for (let i = 0; i < word.length; i++) {
    ctx.fillText(word[i], cx + (i - 2) * spacing, cy);
  }
  ctx.restore();
}
