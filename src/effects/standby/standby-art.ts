/**
 * Please Stand By's canvas artwork, drawn once per style, text and canvas size:
 * the card (colour bars, reverse strip and pluge band, plus Digital's "NO
 * SIGNAL" pill), the sign (a plate, or Cartoon's board on its ropes) and a small
 * parts atlas (the clock's dial, a hand, and Cartoon's TV with eyes open and
 * shut).
 */
import { paintCanvas, SANS_FONT_STACK } from "../canvas-texture";
import { hexToRgb, mixRgb } from "../color";
import {
  blockEdges,
  MAIN_BARS,
  MAIN_BARS_HEIGHT,
  type MeasureText,
  PILL_HEIGHT,
  PILL_INSET,
  PLUGE_BLOCKS,
  REF_HEIGHT,
  REVERSE_BARS,
  REVERSE_STRIP_HEIGHT,
  type SignLayout,
  type StandbyStyle,
} from "./standby-sim";

type Ctx = OffscreenCanvasRenderingContext2D;

/** A hand-lettered look for the Cartoon card; no font is bundled. */
const CARTOON_FONT_STACK = `"Comic Sans MS", "Chalkboard SE", "Comic Neue", "Marker Felt", cursive`;

/** Largest side the card is painted at, px: 4K paints one to one, so Digital's pill and edges stay crisp. */
const MAX_CARD = 4096;
/** Largest side of the sign and parts textures, px. */
const MAX_TEXTURE = 4096;
/** Transparent margin round the sign for its shadow, reference px. */
const SIGN_MARGIN = 24;
/** The Cartoon board's nail, reference px below the frame's top. */
export const NAIL_Y = 14;
/** Analogue's colour bleed trailing right of each bar edge, reference px. */
const BLEED = 7;
/** Paper behind the Cartoon card and ink round its shapes. */
const PAPER = "#f1e7d0";
const INK = "#2e2219";

const rgb = (c: readonly number[], a = 1) =>
  `rgba(${String(Math.round(c[0]))}, ${String(Math.round(c[1]))}, ${String(Math.round(c[2]))}, ${String(a)})`;

const fontFor = (style: StandbyStyle, part: "title" | "subtext", px: number) => {
  const weight = part === "title" ? 700 : style === "cartoon" ? 700 : 400;
  const stack = style === "cartoon" ? CARTOON_FONT_STACK : SANS_FONT_STACK;
  return `${String(weight)} ${String(Math.max(1, px))}px ${stack}`;
};

/** Measures sign text in ems of `style`'s fonts (undefined where nothing can measure). */
export function createMeasure(style: StandbyStyle): MeasureText {
  let ctx: Ctx | null | undefined;
  return (text, part) => {
    if (ctx === undefined) {
      const canvas = paintCanvas(1, 1, () => undefined);
      ctx = canvas ? canvas.getContext("2d") : null;
    }
    if (!ctx) {
      return undefined;
    }
    ctx.font = fontFor(style, part, 100);
    // Undefined from the tests' stand-in context, whose methods return nothing.
    const metrics = ctx.measureText(text) as TextMetrics | undefined;
    return metrics === undefined ? undefined : metrics.width / 100;
  };
}

/** A smooth, deterministic wobble in about [-1, 1] along a hand-drawn edge. */
const wobble = (t: number, seed: number) =>
  0.6 * Math.sin(t * 0.021 + seed * 1.7) + 0.4 * Math.sin(t * 0.053 + seed * 4.1);

/**
 * Traces a rectangle with hand-drawn edges, each point pushed up to `amp` off
 * the straight line, as the current path.
 */
function wobblyRect(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  amp: number,
  seed: number,
): void {
  const stepLen = 12;
  ctx.beginPath();
  const side = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    nx: number,
    ny: number,
    s: number,
  ) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(2, Math.ceil(len / stepLen));
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const d = amp * wobble(t * len, seed + s) * Math.min(1, 6 * t, 6 * (1 - t) + 0.5);
      ctx.lineTo(x0 + (x1 - x0) * t + nx * d, y0 + (y1 - y0) * t + ny * d);
    }
  };
  ctx.moveTo(x, y);
  side(x, y, x + w, y, 0, 1, 0);
  side(x + w, y, x + w, y + h, 1, 0, 1);
  side(x + w, y + h, x, y + h, 0, 1, 2);
  side(x, y + h, x, y, 1, 0, 3);
  ctx.closePath();
}

/** Traces a rounded rectangle as the current path. */
function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// The card

/**
 * The card for a `width` x `height` px canvas (painted at up to `MAX_CARD` px
 * and upscaled): the bars,
 * the reverse strip and the pluge band, crisp in Digital (with its "NO SIGNAL"
 * pill), bleeding a little rightwards in Analogue, hand-drawn on paper in Cartoon.
 */
export function paintCard(
  style: StandbyStyle,
  width: number,
  height: number,
): OffscreenCanvas | null {
  const k = Math.min(1, MAX_CARD / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  return paintCanvas(w, h, (ctx) => {
    const s = h / REF_HEIGHT;
    const top = Math.round(MAIN_BARS_HEIGHT * h);
    const mid = Math.round((MAIN_BARS_HEIGHT + REVERSE_STRIP_HEIGHT) * h);
    const sevenths = blockEdges([1, 1, 1, 1, 1, 1, 1], w);
    const pluge = blockEdges(
      PLUGE_BLOCKS.map((b) => b[0]),
      w,
    );
    const bands: [number[], readonly string[], number, number][] = [
      [sevenths, MAIN_BARS, 0, top],
      [sevenths, REVERSE_BARS, top, mid],
      [pluge, PLUGE_BLOCKS.map((b) => b[1]), mid, h],
    ];

    if (style === "cartoon") {
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, w, h);
      const paper = hexToRgb(PAPER);
      const gap = 5 * s;
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(1, 3.2 * s);
      ctx.strokeStyle = INK;
      let seed = 0;
      for (const [edges, colours, y0, y1] of bands) {
        for (let i = 0; i < colours.length; i++) {
          wobblyRect(
            ctx,
            edges[i] + gap,
            y0 + gap,
            edges[i + 1] - edges[i] - 2 * gap,
            y1 - y0 - 2 * gap,
            3.5 * s,
            seed++,
          );
          ctx.fillStyle = rgb(mixRgb(hexToRgb(colours[i]), paper, 0.18));
          ctx.fill();
          ctx.stroke();
        }
      }
      return;
    }

    for (const [edges, colours, y0, y1] of bands) {
      for (let i = 0; i < colours.length; i++) {
        ctx.fillStyle = colours[i];
        ctx.fillRect(edges[i], y0, edges[i + 1] - edges[i], y1 - y0);
      }
    }

    if (style === "analogue") {
      // A CRT smears each edge a little to the right.
      const bleed = Math.max(1, BLEED * s);
      for (const [edges, colours, y0, y1] of bands) {
        for (let i = 1; i < colours.length; i++) {
          const c = hexToRgb(colours[i - 1]);
          const g = ctx.createLinearGradient(edges[i], 0, edges[i] + bleed, 0) as
            | CanvasGradient
            | undefined;
          if (!g) {
            continue;
          }
          g.addColorStop(0, rgb(c, 0.55));
          g.addColorStop(1, rgb(c, 0));
          ctx.fillStyle = g;
          ctx.fillRect(edges[i], y0, bleed, y1 - y0);
        }
      }
      return;
    }

    // Digital: the "NO SIGNAL" pill in the bottom-left corner.
    const ph = PILL_HEIGHT * s;
    const fontPx = Math.round(ph * 0.46);
    ctx.font = `700 ${String(Math.max(1, fontPx))}px ${SANS_FONT_STACK}`;
    const label = "NO SIGNAL";
    const measured = ctx.measureText(label) as TextMetrics | undefined;
    const textW = measured ? measured.width : label.length * fontPx * 0.66;
    const dot = ph * 0.16;
    const pw = textW + ph * 1.35 + 2 * dot;
    const px = PILL_INSET * s;
    const py = h - PILL_INSET * s - ph;
    roundRect(ctx, px, py, pw, ph, ph / 2);
    ctx.fillStyle = "rgba(10, 10, 12, 0.78)";
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px + ph * 0.5, py + ph / 2, dot, 0, 2 * Math.PI);
    ctx.fillStyle = "#d8443a";
    ctx.fill();
    ctx.fillStyle = "#f2f2f2";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, px + ph * 0.5 + dot * 2 + ph * 0.25, py + ph / 2 + fontPx * 0.04);
  });
}

// ---------------------------------------------------------------------------
// The sign

export interface SignArt {
  canvas: OffscreenCanvas | null;
  /** Where the canvas goes on the frame: left, top, width and height, reference px. */
  left: number;
  top: number;
  width: number;
  height: number;
}

const SIGN_STYLE: Record<
  StandbyStyle,
  { plate: string; outline: string; text: string; subtext: string }
> = {
  analogue: { plate: "#0c0c0e", outline: "#f2f2f2", text: "#f4f4f4", subtext: "#d6d6d6" },
  digital: { plate: "#f4f4f4", outline: "#f4f4f4", text: "#101012", subtext: "#3a3a3e" },
  cartoon: { plate: "#b9824c", outline: INK, text: "#3a2412", subtext: "#4a3020" },
};

/**
 * The sign for `layout` at `scale` device px per reference px: a rounded plate
 * (black with a white outline in Analogue, white in Digital) with a soft
 * shadow, or Cartoon's wooden board hanging by two ropes from a nail at
 * (`layout.x`, `NAIL_Y`). Null canvas for an empty layout.
 */
export function paintSign(layout: SignLayout, style: StandbyStyle, scale: number): SignArt {
  const cartoon = style === "cartoon";
  const left = layout.x - layout.width / 2 - SIGN_MARGIN;
  const top = cartoon ? 0 : layout.top - SIGN_MARGIN;
  const width = layout.width + 2 * SIGN_MARGIN;
  const height = layout.top + layout.height + SIGN_MARGIN - top;
  const art: SignArt = { canvas: null, left, top, width, height };
  if (layout.width <= 0 || layout.height <= 0) {
    return art;
  }
  const k = Math.min(scale, MAX_TEXTURE / Math.max(width, height));
  const cw = Math.max(1, Math.ceil(width * k));
  const ch = Math.max(1, Math.ceil(height * k));
  const look = SIGN_STYLE[style];
  art.canvas = paintCanvas(cw, ch, (ctx) => {
    ctx.scale(cw / width, ch / height);
    ctx.translate(-left, -top);
    const x0 = layout.x - layout.width / 2;
    const y0 = layout.top;
    const radius = Math.min(26, layout.height / 4);
    const em = Math.max(layout.titleSize, layout.subtextSize);

    if (cartoon) {
      // Two ropes from the board's upper corners up to the nail.
      ctx.lineCap = "round";
      ctx.strokeStyle = "#7a5a32";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(x0 + layout.width * 0.16, y0 + 6);
      ctx.lineTo(layout.x, NAIL_Y);
      ctx.lineTo(x0 + layout.width * 0.84, y0 + 6);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(layout.x, NAIL_Y, 6, 0, 2 * Math.PI);
      ctx.fillStyle = "#8c8c8c";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.stroke();

      wobblyRect(ctx, x0, y0, layout.width, layout.height, 4, 11);
      ctx.fillStyle = look.plate;
      ctx.fill();
      // Plank seams and a little grain.
      ctx.save();
      ctx.clip();
      const planks = Math.max(2, Math.round(layout.height / 70));
      ctx.strokeStyle = "rgba(90, 55, 25, 0.55)";
      ctx.lineWidth = 2.5;
      for (let p = 1; p < planks; p++) {
        const y = y0 + (layout.height * p) / planks;
        ctx.beginPath();
        ctx.moveTo(x0, y + 2 * wobble(p * 40, 3));
        ctx.lineTo(x0 + layout.width, y + 2 * wobble(p * 40 + 300, 3));
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(110, 70, 35, 0.22)";
      ctx.lineWidth = 1.5;
      for (let g = 0; g < planks * 3; g++) {
        const y = y0 + ((g + 0.5) / (planks * 3)) * layout.height;
        const gx = x0 + layout.width * (0.1 + 0.5 * ((g * 0.618) % 1));
        ctx.beginPath();
        ctx.moveTo(gx, y);
        ctx.quadraticCurveTo(gx + 40, y - 3, gx + 90, y + 1);
        ctx.stroke();
      }
      ctx.restore();
      wobblyRect(ctx, x0, y0, layout.width, layout.height, 4, 11);
      ctx.lineJoin = "round";
      ctx.lineWidth = 4;
      ctx.strokeStyle = INK;
      ctx.stroke();
    } else {
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
      ctx.shadowBlur = 16 * k;
      ctx.shadowOffsetY = 4 * k;
      roundRect(ctx, x0, y0, layout.width, layout.height, radius);
      ctx.fillStyle = look.plate;
      ctx.fill();
      ctx.restore();
      if (style === "analogue") {
        const inset = Math.max(3, em * 0.08);
        roundRect(
          ctx,
          x0 + inset,
          y0 + inset,
          layout.width - 2 * inset,
          layout.height - 2 * inset,
          Math.max(0, radius - inset),
        );
        ctx.lineWidth = Math.max(2, em * 0.05);
        ctx.strokeStyle = look.outline;
        ctx.stroke();
      }
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = look.text;
    ctx.font = fontFor(style, "title", layout.titleSize);
    for (let i = 0; i < layout.lines.length; i++) {
      ctx.fillText(layout.lines[i], layout.x, y0 + layout.lineY[i]);
    }
    if (layout.subtext.length > 0) {
      ctx.fillStyle = look.subtext;
      ctx.font = fontFor(style, "subtext", layout.subtextSize);
      ctx.fillText(layout.subtext, layout.x, y0 + layout.subtextY);
    }
  });
  return art;
}

// ---------------------------------------------------------------------------
// Parts atlas

/** The parts atlas's cells, left to right in one row. */
export const DIAL_CELL = 0;
export const HAND_CELL = 1;
export const TV_CELL = 2;
export const TV_SHUT_CELL = 3;
export const PART_CELLS = 4;
/** The hand cell's bar: its share of the cell's width, and of its height (in a band twice as tall). */
export const HAND_BAR_LENGTH = 0.92;
export const HAND_BAR_THICKNESS = 0.08;
export const HAND_BAND = 2 * HAND_BAR_THICKNESS;

/** The parts atlas, `cell` px per cell: dial, hand bar, and Cartoon's TV with eyes open and shut. */
export function paintParts(style: StandbyStyle, cell: number): OffscreenCanvas | null {
  const c = Math.max(8, Math.min(Math.round(cell), Math.floor(MAX_TEXTURE / PART_CELLS)));
  return paintCanvas(c * PART_CELLS, c, (ctx) => {
    const cartoon = style === "cartoon";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // The dial: a plain station clock face.
    ctx.save();
    ctx.translate(DIAL_CELL * c + c / 2, c / 2);
    const r = c * 0.46;
    ctx.beginPath();
    if (cartoon) {
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * 2 * Math.PI;
        const rr = r * (1 + 0.025 * wobble(i * 30, 5));
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
    } else {
      ctx.arc(0, 0, r, 0, 2 * Math.PI);
    }
    ctx.fillStyle = cartoon ? "#fbf4e2" : "#f2f2f0";
    ctx.fill();
    ctx.lineWidth = r * (cartoon ? 0.07 : 0.06);
    ctx.strokeStyle = cartoon ? INK : "#1d1d1f";
    ctx.stroke();
    ctx.fillStyle = cartoon ? INK : "#1d1d1f";
    for (let m = 0; m < 60; m++) {
      const hour = m % 5 === 0;
      if (cartoon && m % 15 !== 0) {
        continue;
      }
      ctx.save();
      ctx.rotate((m / 60) * 2 * Math.PI);
      const len = hour ? r * 0.16 : r * 0.06;
      const wd = hour ? r * 0.05 : r * 0.018;
      ctx.fillRect(-wd / 2, -r * 0.88, wd, len);
      ctx.restore();
    }
    ctx.restore();

    // The hand: a white rounded bar, tinted per hand when drawn.
    const bw = c * HAND_BAR_LENGTH;
    const bh = c * HAND_BAR_THICKNESS;
    roundRect(ctx, HAND_CELL * c + (c - bw) / 2, (c - bh) / 2, bw, bh, bh / 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    for (const cellIndex of [TV_CELL, TV_SHUT_CELL]) {
      paintTv(ctx, cellIndex * c, c, cellIndex === TV_SHUT_CELL);
    }
  });
}

/** Cartoon's little TV set with a sad face, in the `c` px cell at `x`. */
function paintTv(ctx: Ctx, x: number, c: number, shut: boolean): void {
  ctx.save();
  ctx.translate(x, 0);
  ctx.scale(c / 100, c / 100);
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = INK;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // Antennae and legs.
  ctx.beginPath();
  ctx.moveTo(48, 26);
  ctx.lineTo(34, 8);
  ctx.moveTo(52, 26);
  ctx.lineTo(70, 6);
  ctx.moveTo(28, 84);
  ctx.lineTo(22, 95);
  ctx.moveTo(72, 84);
  ctx.lineTo(78, 95);
  ctx.stroke();
  for (const [ax, ay] of [
    [34, 8],
    [70, 6],
  ]) {
    ctx.beginPath();
    ctx.arc(ax, ay, 2.6, 0, 2 * Math.PI);
    ctx.fillStyle = "#d8443a";
    ctx.fill();
    ctx.stroke();
  }
  // The cabinet and its screen.
  wobblyRect(ctx, 10, 26, 80, 58, 0.8, 21);
  ctx.fillStyle = "#c98f55";
  ctx.fill();
  ctx.stroke();
  wobblyRect(ctx, 17, 32, 52, 46, 0.6, 23);
  ctx.fillStyle = "#cfe0e6";
  ctx.fill();
  ctx.stroke();
  // Knobs.
  for (const ky of [42, 58]) {
    ctx.beginPath();
    ctx.arc(80, ky, 3.6, 0, 2 * Math.PI);
    ctx.fillStyle = "#6e4b2a";
    ctx.fill();
    ctx.stroke();
  }
  // The sad face: eyes (or shut lids), a frown and a tear.
  ctx.fillStyle = INK;
  for (const ex of [34, 52]) {
    ctx.beginPath();
    if (shut) {
      ctx.moveTo(ex - 4, 48);
      ctx.quadraticCurveTo(ex, 51, ex + 4, 48);
      ctx.stroke();
    } else {
      ctx.arc(ex, 48, 2.8, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.beginPath();
  ctx.moveTo(30, 44);
  ctx.lineTo(37, 41.5);
  ctx.moveTo(56, 44);
  ctx.lineTo(49, 41.5);
  ctx.moveTo(33, 67);
  ctx.quadraticCurveTo(43, 59, 53, 67);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(56, 55, 1.6, 2.6, 0, 0, 2 * Math.PI);
  ctx.fillStyle = "#4a9fd8";
  ctx.fill();
  ctx.restore();
}
