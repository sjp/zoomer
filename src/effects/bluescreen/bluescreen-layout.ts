/**
 * Blue Screen's layouts, in reference px (a frame 1080 px tall): where each
 * style's text goes, wrapped and shrunk until it fits its block. Text sits in
 * the upper third across the frame, or in a column down the left; below the
 * upper third, the middle of the frame stays clear for the speaker.
 */
import { clamp } from "../math";
import {
  type BlueStyle,
  classicText,
  MAX_TRACE_CHARS,
  percentText,
  TOP_PERCENT,
  TRACE_ROWS,
} from "./bluescreen-sim";

/** Reference frame height; layout sizes are in px at this height. */
export const REF_HEIGHT = 1080;
/** Text below this fraction of the height keeps out of the clear middle. */
export const BAND = 1 / 3;
/** The left column's right edge (the clear middle's left edge), as a fraction of the width. */
export const CLEAR_LEFT = 0.3;

export type FontKind = "face" | "sans" | "mono";
/** Measures `text` in ems of a font kind; undefined where text can't be measured. */
export type Measure = (text: string, kind: FontKind) => number | undefined;

/** A rectangle, reference px, y down. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One line of text: top-left corner, font size and measured width, reference px. */
interface TextRun {
  text: string;
  kind: FontKind;
  x: number;
  y: number;
  size: number;
  width: number;
}

/** Line height, in font sizes. */
const LINE = 1.3;
/** The sad face's box height, in font sizes. */
const FACE_LINE = 1.1;

/** Ems per character where text can't be measured. */
const FALLBACK_EM: Record<FontKind, number> = { face: 0.5, sans: 0.55, mono: 0.6 };

function ems(measure: Measure, text: string, kind: FontKind): number {
  return measure(text, kind) ?? Array.from(text).length * FALLBACK_EM[kind];
}

/**
 * Breaks one line into lines no wider than `maxWidth`, between words where it
 * can and inside a word too long for a line of its own.
 */
export function wrapLine(
  line: string,
  maxWidth: number,
  widthOf: (text: string) => number,
): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    const joined = current === "" ? word : `${current} ${word}`;
    if (widthOf(joined) <= maxWidth) {
      current = joined;
      continue;
    }
    if (current !== "") {
      out.push(current);
      current = "";
    }
    // Too long on its own: cut it into pieces that fit.
    let piece = "";
    for (const ch of word) {
      if (piece !== "" && widthOf(piece + ch) > maxWidth) {
        out.push(piece);
        piece = "";
      }
      piece += ch;
    }
    current = piece;
  }
  out.push(current);
  return out;
}

/** The left margin and top margin shared by Modern and Classic. */
const marginX = (refWidth: number) => clamp(0.08 * refWidth, 24, 170);

/** Shrink factors tried in turn until a layout fits. */
const SHRINK = 0.92;
const MIN_FIT = 0.15;

// ---------------------------------------------------------------------------
// Modern
// ---------------------------------------------------------------------------

/** Font sizes and gaps, reference px, before shrinking. */
const FACE_SIZE = 140;
const MESSAGE_SIZE = 30;
const FACE_GAP = 22;
const BLOCK_MAX = 1000;
const PERCENT_SIZE = 28;
const QR_SIZE = 104;
const HINT_SIZE = 15;
const CODE_SIZE = 17;
const COLUMN_GAP = 20;
const MODERN_TOP = 0.06;

const FACE_TEXT = ":(";
const HINT_TEXT = "If anyone asks, tell them this:";

export interface ModernLayout {
  style: "modern";
  /** The face, the message lines, the hint and the stop code lines. */
  runs: TextRun[];
  /** Where the "NN% complete" line goes, sized for the widest count. */
  percent: Box;
  percentSize: number;
  /** The square of pixel noise. */
  qr: Box;
}

/**
 * The face and message across the upper third; the count, the noise square,
 * a hint and the stop code down the left column.
 */
export function layoutModern(
  message: string,
  code: string,
  refWidth: number,
  measure: Measure,
): ModernLayout {
  const left = marginX(refWidth);
  const top = MODERN_TOP * REF_HEIGHT;
  const bandBottom = BAND * REF_HEIGHT;
  const blockWidth = Math.min(refWidth - 2 * left, BLOCK_MAX);
  const paragraphs = message.split("\n");

  // The upper block, shrunk until it fits the band.
  let k = 1;
  let lines: string[] = [];
  for (; ; k *= SHRINK) {
    const size = MESSAGE_SIZE * k;
    lines = paragraphs.flatMap((p) =>
      wrapLine(p, blockWidth, (s) => ems(measure, s, "sans") * size),
    );
    const height = FACE_SIZE * k * FACE_LINE + FACE_GAP * k + lines.length * size * LINE;
    if (height <= bandBottom - top || k < MIN_FIT) {
      break;
    }
  }
  const runs: TextRun[] = [];
  const faceSize = FACE_SIZE * k;
  runs.push({
    text: FACE_TEXT,
    kind: "face",
    x: left,
    y: top,
    size: faceSize,
    width: ems(measure, FACE_TEXT, "face") * faceSize,
  });
  const size = MESSAGE_SIZE * k;
  let y = top + faceSize * FACE_LINE + FACE_GAP * k;
  for (const text of lines) {
    runs.push({ text, kind: "sans", x: left, y, size, width: ems(measure, text, "sans") * size });
    y += size * LINE;
  }

  // The left column, shrunk until it fits.
  const columnRight = (CLEAR_LEFT - 0.02) * refWidth;
  const columnWidth = Math.max(1, columnRight - left);
  const columnTop = bandBottom + 0.02 * REF_HEIGHT;
  const columnBottom = REF_HEIGHT * (1 - MODERN_TOP);
  const codeLine = `Stop code: ${code}`;
  const widestEms = ems(measure, percentText(TOP_PERCENT), "sans");
  let c = 1;
  let hint: string[] = [];
  let codeLines: string[] = [];
  let qrSize = 0;
  let percentSize = 0;
  for (; ; c *= SHRINK) {
    percentSize = Math.min(PERCENT_SIZE * c, size);
    qrSize = Math.min(QR_SIZE * c, columnWidth * 0.6);
    const hs = HINT_SIZE * c;
    const cs = CODE_SIZE * c;
    hint = wrapLine(HINT_TEXT, columnWidth, (s) => ems(measure, s, "sans") * hs);
    codeLines = wrapLine(codeLine, columnWidth, (s) => ems(measure, s, "sans") * cs);
    const height =
      percentSize * LINE +
      2 * COLUMN_GAP * c +
      qrSize +
      hint.length * hs * LINE +
      codeLines.length * cs * LINE;
    const fits = height <= columnBottom - columnTop && widestEms * percentSize <= columnWidth;
    if (fits || c < MIN_FIT) {
      break;
    }
  }
  const percent = {
    x: left,
    y: columnTop,
    w: widestEms * percentSize,
    h: percentSize * LINE,
  };
  y = columnTop + percent.h + COLUMN_GAP * c;
  const qr = { x: left, y, w: qrSize, h: qrSize };
  y += qrSize + COLUMN_GAP * c;
  for (const [texts, s] of [
    [hint, HINT_SIZE * c],
    [codeLines, CODE_SIZE * c],
  ] as const) {
    for (const text of texts) {
      runs.push({ text, kind: "sans", x: left, y, size: s, width: ems(measure, text, "sans") * s });
      y += s * LINE;
    }
  }
  return { style: "modern", runs, percent, percentSize, qr };
}

// ---------------------------------------------------------------------------
// Classic
// ---------------------------------------------------------------------------

/** A text-mode cell, in font dots: a 5 x 7 glyph with a column and two rows of space. */
export const CELL_W = 6;
export const CELL_H = 9;
/** The widest the Classic page gets, in characters. */
export const CLASSIC_COLS = 72;
const CLASSIC_TOP = 0.06;
const MAX_DOT = 4;
const MIN_DOT = 0.5;
const DOT_STEP = 0.25;

export const CLASSIC_TITLE = " ERROR ";
export const CLASSIC_PROMPT = "PRESS ANY KEY TO CONTINUE ";

/** The Classic page's paragraphs, before wrapping; "" is a blank line. */
function classicParagraphs(message: string, code: string): string[] {
  const c = classicText(code).trim();
  return [
    `A FATAL EXCEPTION 0E HAS OCCURRED AT 0028:C0011E36 IN VXD BACKGRND(01) + 00010E36${c === "" ? "" : ` (${c})`}. THE CURRENT MEETING WILL BE TERMINATED.`,
    "",
    ...classicText(message).split("\n"),
    "",
    "*  PRESS ANY KEY TO TERMINATE THE CURRENT MEETING.",
    "*  PRESS CTRL+ALT+DEL AGAIN TO RESTART YOUR CAMERA. YOU WILL LOSE ANY UNSAVED SMALL TALK IN ALL OPEN MEETINGS.",
    "",
    CLASSIC_PROMPT,
  ];
}

/** Wraps the paragraphs to `cols` characters; bullets ("*  ") hang their indent. */
function wrapClassic(paragraphs: readonly string[], cols: number): string[] {
  const out: string[] = [];
  const widthOf = (s: string) => Array.from(s).length;
  for (const p of paragraphs) {
    if (p.startsWith("*  ")) {
      const body = wrapLine(p.slice(3), cols - 3, widthOf);
      for (let i = 0; i < body.length; i++) {
        out.push((i === 0 ? "*  " : "   ") + body[i]);
      }
    } else if (p === CLASSIC_PROMPT) {
      // Kept whole with its trailing space, where the cursor sits.
      out.push(p.length < cols ? p : p.trim());
    } else {
      out.push(...wrapLine(p, cols, widthOf));
    }
  }
  return out;
}

export interface ClassicLayout {
  style: "classic";
  /** The page's top-left corner, reference px. */
  x: number;
  y: number;
  /** One font dot, reference px. */
  dot: number;
  cols: number;
  /** Row 0 is the title; text starts at row 2. */
  lines: string[];
  /** The underline cursor after the prompt. */
  cursor: Box;
}

export function layoutClassic(message: string, code: string, refWidth: number): ClassicLayout {
  const left = marginX(refWidth);
  const top = CLASSIC_TOP * REF_HEIGHT;
  const width = refWidth - 2 * left;
  const height = BAND * REF_HEIGHT - top;
  const paragraphs = classicParagraphs(message, code);
  let dot = MAX_DOT;
  let cols = 0;
  let lines: string[] = [];
  for (; ; dot -= DOT_STEP) {
    const last = dot - DOT_STEP < MIN_DOT;
    cols = Math.min(CLASSIC_COLS, Math.floor(width / (CELL_W * dot)));
    // Too narrow for 8 columns even at the smallest dot: wrap to what fits.
    if (cols >= 8 || last) {
      cols = Math.max(1, cols);
      lines = ["", "", ...wrapClassic(paragraphs, cols)];
      if (last || lines.length * CELL_H * dot <= height) {
        break;
      }
    }
  }
  const row = lines.length - 1;
  const col = Array.from(lines[row]).length;
  const cursor = {
    x: left + col * CELL_W * dot,
    y: top + (row * CELL_H + 6) * dot,
    w: 5 * dot,
    h: 2 * dot,
  };
  return { style: "classic", x: left, y: top, dot, cols, lines, cursor };
}

// ---------------------------------------------------------------------------
// Kernel
// ---------------------------------------------------------------------------

const KERNEL_SIZE = 17;
const KERNEL_TOP = 0.035;

/** The panic message above the stack trace. */
function kernelHeader(code: string): string[] {
  return [
    `Kernel panic - not syncing: ${code}`,
    "CPU: 0 PID: 42 Comm: background Not tainted 6.1.0-coffee #1",
    "Hardware name: Home Office/Kitchen Table, BIOS 0.9 01/01/2000",
    "Call Trace:",
  ];
}

export interface KernelLayout {
  style: "kernel";
  /** The header lines. */
  runs: TextRun[];
  /** The window the trace lines scroll through, `TRACE_ROWS` lines tall. */
  log: Box;
  size: number;
  lineHeight: number;
  /** The block cursor on the line after the trace. */
  cursor: Box;
}

export function layoutKernel(code: string, refWidth: number, measure: Measure): KernelLayout {
  const left = clamp(0.03 * refWidth, 16, 80);
  const top = KERNEL_TOP * REF_HEIGHT;
  const header = kernelHeader(code);
  const rows = header.length + TRACE_ROWS + 1;
  const traceEms = ems(measure, "0".repeat(MAX_TRACE_CHARS), "mono");
  const widestEms = Math.max(traceEms, ...header.map((h) => ems(measure, h, "mono")));
  const size = Math.min(
    KERNEL_SIZE,
    (BAND * REF_HEIGHT - top) / (rows * LINE),
    Math.max(1, refWidth - 2 * left) / widestEms,
  );
  const lineHeight = size * LINE;
  const runs = header.map((text, i) => ({
    text,
    kind: "mono" as const,
    x: left,
    y: top + i * lineHeight,
    size,
    width: ems(measure, text, "mono") * size,
  }));
  const logTop = top + header.length * lineHeight;
  const log = { x: left, y: logTop, w: traceEms * size, h: TRACE_ROWS * lineHeight };
  const cursor = {
    x: left,
    y: logTop + TRACE_ROWS * lineHeight + (lineHeight - size) / 2,
    w: size * 0.6,
    h: size,
  };
  return { style: "kernel", runs, log, size, lineHeight, cursor };
}

// ---------------------------------------------------------------------------

export type BlueLayout = ModernLayout | ClassicLayout | KernelLayout;

export function layoutFor(
  style: BlueStyle,
  message: string,
  code: string,
  refWidth: number,
  measure: Measure,
): BlueLayout {
  if (style === "classic") {
    return layoutClassic(message, code, refWidth);
  }
  return style === "kernel"
    ? layoutKernel(code, refWidth, measure)
    : layoutModern(message, code, refWidth, measure);
}

/** Every box the layout puts text (or the noise square, or a cursor) in, reference px. */
export function textBoxes(layout: BlueLayout): Box[] {
  if (layout.style === "classic") {
    const cell = CELL_H * layout.dot;
    const boxes = layout.lines.map((line, row) => ({
      x: layout.x,
      y: layout.y + row * cell,
      w: Array.from(line).length * CELL_W * layout.dot,
      h: cell,
    }));
    boxes[0] = { ...boxes[0], w: layout.cols * CELL_W * layout.dot };
    boxes.push(layout.cursor);
    return boxes.filter((b) => b.w > 0);
  }
  const runs: Box[] = layout.runs.map((r) => ({
    x: r.x,
    y: r.y,
    w: r.width,
    h: r.size * (r.kind === "face" ? FACE_LINE : LINE),
  }));
  if (layout.style === "modern") {
    return [...runs, layout.percent, layout.qr];
  }
  return [...runs, layout.log, layout.cursor];
}
