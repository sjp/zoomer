/**
 * Graphic Design Is My Passion's canvas artwork: the static backdrop (a banded
 * sky over flat green grass), the small atlas of clouds, sparkle and lens-flare
 * pieces, and the caption's words, each rasterised once and redrawn only when
 * the canvas size, the text, the style or the variation changes.
 */
import { paintCanvas } from "../canvas-texture";
import { hexToRgb, mixRgb } from "../color";
import {
  type CaptionLayout,
  type CaptionStyle,
  CLOUD_VARIANTS,
  groundEdge,
  type MeasureWord,
  packShelves,
  REF_HEIGHT,
  WORD_BOX_HEIGHT,
  WORD_COLORS,
  WORD_PAD,
} from "./passion-sim";

type Ctx = OffscreenCanvasRenderingContext2D;

/** The cheesy font stack; whatever the browser falls back to looks the part. */
const CAPTION_FONT_STACK = `Papyrus, "Comic Sans MS", "Chalkboard SE", "Comic Neue", cursive`;
/** Font weight per style: WordArt's letters are bold. */
const CAPTION_WEIGHT: Record<CaptionStyle, number> = { meme: 400, wordart: 700 };
/** The baseline's depth in a word's box, ems from the top. */
const WORD_BASELINE = 1.08;
/** Outline widths per style, ems: thin in Meme, thick in WordArt. */
const OUTLINE_EM: Record<CaptionStyle, number> = { meme: 0.07, wordart: 0.13 };
const OUTLINE_COLOR: Record<CaptionStyle, string> = { meme: "#1c1c1c", wordart: "#1b1464" };
/** WordArt's rainbow, left to right across each line. */
const RAINBOW = ["#ff2a2a", "#ff9a1f", "#ffe81f", "#3fdc3f", "#2a8cff", "#9a3dff"];

/** Largest texture side any of the art is drawn at, px. */
const MAX_TEXTURE = 4096;
/** Transparent gap round each word in the caption atlas, px. */
const GUTTER = 2;

const font = (style: CaptionStyle, px: number) =>
  `${String(CAPTION_WEIGHT[style])} ${String(px)}px ${CAPTION_FONT_STACK}`;

const rgb = (c: readonly number[]) =>
  `rgb(${String(Math.round(c[0]))}, ${String(Math.round(c[1]))}, ${String(Math.round(c[2]))})`;

/**
 * A linear gradient through `stops` (offset, colour), or the first colour where
 * the canvas is a stand-in that makes no gradients (tests).
 */
function linear(
  ctx: Ctx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  stops: readonly (readonly [number, string])[],
): CanvasGradient | string {
  const g = ctx.createLinearGradient(x0, y0, x1, y1) as CanvasGradient | undefined;
  if (!g) {
    return stops[0][1];
  }
  for (const [at, colour] of stops) {
    g.addColorStop(at, colour);
  }
  return g;
}

/** Like `linear`, radial from (x, y) out to radius `r`. */
function radial(
  ctx: Ctx,
  x: number,
  y: number,
  r: number,
  stops: readonly (readonly [number, string])[],
): CanvasGradient | string {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r) as CanvasGradient | undefined;
  if (!g) {
    return stops[0][1];
  }
  for (const [at, colour] of stops) {
    g.addColorStop(at, colour);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Backdrop

const SKY_TOP = "#1652ff";
const SKY_HORIZON = "#c4f6ff";
/** The sky's visible bands, and the share of each band its soft edge takes. */
const SKY_BANDS = 9;
const BAND_SOFTNESS = 0.3;
const GRASS = "#3bd62a";
const GRASS_EDGE = "#1f8e18";

/** Largest side the backdrop is painted at, px; it is upscaled past that. */
const MAX_BACKDROP = 2048;

/**
 * The backdrop for a `width` x `height` px canvas whose frame is `refWidth`
 * reference px wide: a sky in wide, softly stepped bands from saturated blue to
 * pale cyan at the horizon, the cheap gradient's banding left in on purpose, and
 * the grass with its one wobbly edge.
 */
export function paintBackdrop(
  width: number,
  height: number,
  refWidth: number,
): OffscreenCanvas | null {
  const k = Math.min(1, MAX_BACKDROP / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  return paintCanvas(w, h, (ctx) => {
    ctx.scale(w / refWidth, h / REF_HEIGHT);
    const top = hexToRgb(SKY_TOP);
    const bottom = hexToRgb(SKY_HORIZON);
    const stops: [number, string][] = [];
    for (let b = 0; b < SKY_BANDS; b++) {
      const colour = rgb(mixRgb(top, bottom, b / (SKY_BANDS - 1)));
      const soft = BAND_SOFTNESS / 2 / SKY_BANDS;
      stops.push([b === 0 ? 0 : b / SKY_BANDS + soft, colour]);
      stops.push([b === SKY_BANDS - 1 ? 1 : (b + 1) / SKY_BANDS - soft, colour]);
    }
    const horizon = groundEdge(0) - 20;
    ctx.fillStyle = linear(ctx, 0, 0, 0, horizon, stops);
    ctx.fillRect(0, 0, refWidth, REF_HEIGHT);

    ctx.beginPath();
    ctx.moveTo(0, REF_HEIGHT);
    for (let x = 0; x <= refWidth + 8; x += 8) {
      ctx.lineTo(x, groundEdge(x));
    }
    ctx.lineTo(refWidth + 8, REF_HEIGHT);
    ctx.closePath();
    ctx.fillStyle = GRASS;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, groundEdge(0));
    for (let x = 0; x <= refWidth + 8; x += 8) {
      ctx.lineTo(x, groundEdge(x));
    }
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.strokeStyle = GRASS_EDGE;
    ctx.stroke();
  });
}

// ---------------------------------------------------------------------------
// Clouds, sparkle and flare pieces

/** The misc atlas's grid, in cells: three 2 x 1 clouds on the top row, the rest below. */
export const MISC_COLS = 6;
export const MISC_ROWS = 2;
/** Cell rectangles, [column, row, columns, rows]. */
export const CLOUD_CELLS: readonly (readonly number[])[] = Array.from(
  { length: CLOUD_VARIANTS },
  (_, v) => [2 * v, 0, 2, 1],
);
export const SPARKLE_CELL = [0, 1, 1, 1] as const;
export const BURST_CELL = [1, 1, 1, 1] as const;
export const RING_CELL = [2, 1, 1, 1] as const;
export const DISC_CELL = [3, 1, 1, 1] as const;

/** Each cloud's puffs, [x, y, radius] in its 2 x 1 cell, over a rounded flat base. */
const CLOUD_PUFFS: readonly (readonly (readonly [number, number, number])[])[] = [
  [
    [0.5, 0.6, 0.22],
    [0.92, 0.45, 0.33],
    [1.38, 0.53, 0.27],
    [1.66, 0.67, 0.15],
  ],
  [
    [0.48, 0.64, 0.19],
    [0.84, 0.5, 0.28],
    [1.2, 0.4, 0.3],
    [1.56, 0.6, 0.22],
  ],
  [
    [0.42, 0.65, 0.17],
    [0.78, 0.46, 0.29],
    [1.14, 0.55, 0.25],
    [1.44, 0.5, 0.24],
    [1.7, 0.68, 0.14],
  ],
];
const CLOUD_FILL = "#ffffff";
const CLOUD_LINE = "#8fb6d9";

/** A clip-art cloud: overlapping circles on a flat base, outlined round the outside only. */
function drawCloud(ctx: Ctx, variant: number): void {
  const puffs = CLOUD_PUFFS[variant % CLOUD_PUFFS.length];
  const trace = (i: number) => {
    ctx.beginPath();
    if (i < puffs.length) {
      ctx.arc(puffs[i][0], puffs[i][1], puffs[i][2], 0, Math.PI * 2);
    } else {
      ctx.roundRect(0.2, 0.6, 1.6, 0.24, 0.12);
    }
  };
  // Every piece stroked wide first, then every piece filled over the inner lines.
  ctx.lineWidth = 0.05;
  ctx.strokeStyle = CLOUD_LINE;
  for (let i = 0; i <= puffs.length; i++) {
    trace(i);
    ctx.stroke();
  }
  ctx.fillStyle = CLOUD_FILL;
  for (let i = 0; i <= puffs.length; i++) {
    trace(i);
    ctx.fill();
  }
}

/** A four-pointed twinkle star, hard-edged, in the unit cell. */
function drawSparkle(ctx: Ctx): void {
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4 - Math.PI / 2;
    const r = k % 2 === 0 ? 0.46 : 0.09;
    ctx.lineTo(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a));
  }
  ctx.closePath();
  ctx.fillStyle = "#fffbe0";
  ctx.fill();
  ctx.lineWidth = 0.025;
  ctx.strokeStyle = "#ffd84a";
  ctx.stroke();
}

/** The flare's bright burst: a soft glow with a few thin rays, for additive drawing. */
function drawBurst(ctx: Ctx): void {
  ctx.fillStyle = radial(ctx, 0.5, 0.5, 0.5, [
    [0, "rgba(255, 255, 240, 1)"],
    [0.15, "rgba(255, 250, 210, 0.8)"],
    [0.5, "rgba(255, 230, 160, 0.18)"],
    [1, "rgba(255, 220, 140, 0)"],
  ]);
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = "rgba(255, 255, 230, 0.35)";
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 6 + 0.2;
    ctx.beginPath();
    ctx.moveTo(0.5 + 0.48 * Math.cos(a), 0.5 + 0.48 * Math.sin(a));
    ctx.lineTo(0.5 + 0.015 * Math.cos(a + 1.57), 0.5 + 0.015 * Math.sin(a + 1.57));
    ctx.lineTo(0.5 - 0.48 * Math.cos(a), 0.5 - 0.48 * Math.sin(a));
    ctx.lineTo(0.5 - 0.015 * Math.cos(a + 1.57), 0.5 - 0.015 * Math.sin(a + 1.57));
    ctx.closePath();
    ctx.fill();
  }
}

/** A flare ghost: a soft pale ring. */
function drawRing(ctx: Ctx): void {
  ctx.fillStyle = radial(ctx, 0.5, 0.5, 0.48, [
    [0, "rgba(160, 255, 210, 0)"],
    [0.72, "rgba(160, 255, 210, 0.05)"],
    [0.86, "rgba(170, 255, 220, 0.7)"],
    [1, "rgba(160, 255, 210, 0)"],
  ]);
  ctx.fillRect(0, 0, 1, 1);
}

/** A flare ghost: a soft, faintly magenta disc. */
function drawDisc(ctx: Ctx): void {
  ctx.fillStyle = radial(ctx, 0.5, 0.5, 0.48, [
    [0, "rgba(255, 170, 240, 0.6)"],
    [0.8, "rgba(255, 150, 230, 0.4)"],
    [1, "rgba(255, 150, 230, 0)"],
  ]);
  ctx.fillRect(0, 0, 1, 1);
}

/** The clouds, sparkle and flare pieces, `cell` px per grid cell. */
export function paintMiscAtlas(cell: number): OffscreenCanvas | null {
  return paintCanvas(cell * MISC_COLS, cell * MISC_ROWS, (ctx) => {
    const place = (rect: readonly number[], draw: () => void) => {
      ctx.save();
      ctx.translate(rect[0] * cell, rect[1] * cell);
      ctx.scale(cell, cell);
      draw();
      ctx.restore();
    };
    for (let v = 0; v < CLOUD_VARIANTS; v++) {
      place(CLOUD_CELLS[v], () => {
        drawCloud(ctx, v);
      });
    }
    place(SPARKLE_CELL, () => {
      drawSparkle(ctx);
    });
    place(BURST_CELL, () => {
      drawBurst(ctx);
    });
    place(RING_CELL, () => {
      drawRing(ctx);
    });
    place(DISC_CELL, () => {
      drawDisc(ctx);
    });
  });
}

// ---------------------------------------------------------------------------
// Caption

/**
 * A measurer for `style`'s font, in ems, or one that always gives undefined
 * where there is no canvas to measure with.
 */
export function createMeasure(style: CaptionStyle): MeasureWord {
  let ctx: Ctx | null | undefined;
  return (word) => {
    if (ctx === undefined) {
      const canvas = paintCanvas(1, 1, () => undefined);
      ctx = canvas ? canvas.getContext("2d") : null;
    }
    if (!ctx) {
      return undefined;
    }
    ctx.font = font(style, 100);
    // Undefined from the tests' stand-in context, whose methods return nothing.
    const metrics = ctx.measureText(word) as TextMetrics | undefined;
    return metrics === undefined ? undefined : metrics.width / 100;
  };
}

interface CaptionArt {
  canvas: OffscreenCanvas | null;
  /** Each word's atlas rectangle, u0 v0 u1 v1 (v down), in word order. */
  uv: Float32Array;
}

/**
 * Rasterises `layout`'s words at `fontPx` px per em (shrunk if they would not
 * fit a texture), packed in rows: Meme words in their clashing colours with a
 * thin dark outline, WordArt words in a rainbow running across each line with a
 * thick navy outline. Drop shadows are drawn from the same art by the effect.
 */
export function paintCaption(
  layout: CaptionLayout,
  style: CaptionStyle,
  fontPx: number,
): CaptionArt {
  const words = layout.words;
  const uv = new Float32Array(words.length * 4);
  if (words.length === 0) {
    return { canvas: null, uv };
  }
  const widest = Math.max(...words.map((w) => w.em));
  let px = Math.max(4, Math.min(fontPx, (MAX_TEXTURE - 2 * GUTTER) / widest));
  let pack = packShelves([], [], MAX_TEXTURE, GUTTER);
  const sizes = () => ({
    w: words.map((w) => Math.ceil(w.em * px)),
    h: words.map(() => Math.ceil(WORD_BOX_HEIGHT * px)),
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const { w, h } = sizes();
    pack = packShelves(w, h, MAX_TEXTURE, GUTTER);
    if (pack.height <= MAX_TEXTURE) {
      break;
    }
    px = Math.max(4, px * Math.sqrt(MAX_TEXTURE / pack.height) * 0.95);
  }
  const { w: boxW, h: boxH } = sizes();
  const width = Math.min(MAX_TEXTURE, pack.width);
  const height = Math.min(MAX_TEXTURE, pack.height);
  words.forEach((_, i) => {
    uv[i * 4] = pack.x[i] / width;
    uv[i * 4 + 1] = pack.y[i] / height;
    uv[i * 4 + 2] = (pack.x[i] + boxW[i]) / width;
    uv[i * 4 + 3] = (pack.y[i] + boxH[i]) / height;
  });
  const canvas = paintCanvas(width, height, (ctx) => {
    ctx.font = font(style, px);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.lineJoin = "round";
    ctx.lineWidth = OUTLINE_EM[style] * px;
    ctx.strokeStyle = OUTLINE_COLOR[style];
    words.forEach((word, i) => {
      const x = pack.x[i] + WORD_PAD * px;
      const y = pack.y[i] + WORD_BASELINE * px;
      if (style === "wordart") {
        // The rainbow spans the whole line, of which this box is a slice.
        const line = (word.em * px) / Math.max(1e-6, word.span1 - word.span0);
        const start = pack.x[i] - word.span0 * line;
        ctx.fillStyle = linear(
          ctx,
          start,
          0,
          start + line,
          0,
          RAINBOW.map((c, k) => [k / (RAINBOW.length - 1), c] as const),
        );
      } else {
        ctx.fillStyle = WORD_COLORS[word.color];
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(pack.x[i], pack.y[i], boxW[i], boxH[i]);
      ctx.clip();
      ctx.strokeText(word.text, x, y);
      ctx.fillText(word.text, x, y);
      ctx.restore();
    });
  });
  return { canvas, uv };
}
