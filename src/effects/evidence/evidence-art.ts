/**
 * Detective Evidence Board's pinned items, painted with a 2D canvas into its
 * atlas: photos and polaroids of simple silhouettes, index cards and sticky
 * notes with a handwritten word, newspaper clippings of headline bars and grey
 * column lines, a map fragment with a circled spot, and the title card. Each
 * is drawn round a centre with its soft shadow under it; the pins are drawn
 * separately, over the strings.
 */
import { HAND_FONT_STACK } from "../canvas-texture";
import { linearGradient } from "../meme-art";
import { createRng } from "../noise";
import {
  type Item,
  KIND_CLIPPING,
  KIND_INDEX,
  KIND_MAP,
  KIND_PHOTO,
  KIND_POLAROID,
  KIND_STICKY,
  KIND_TITLE,
  SUBJECT_BUILDING,
  SUBJECT_CAR,
  SUBJECT_PERSON,
  WORDS,
} from "./evidence-layout";

type Ctx = OffscreenCanvasRenderingContext2D;

/** Room round an item in its atlas slot for its shadow (board units). */
export const SHADOW_PAD = 0.026;
/** The items' shadow: offset right and down, and blur (board units). */
const SHADOW_X = 0.004;
const SHADOW_Y = 0.007;
const SHADOW_BLUR = 0.012;

const STICKY_COLORS = ["#f4dc5c", "#f3a3bd", "#a9dd94", "#9ccbea"] as const;
/** Photo backgrounds, as top and bottom of a gradient. */
const PHOTO_TONES = [
  ["#9aa5ad", "#5b646b"],
  ["#b3a185", "#6e5f48"],
  ["#a9b0a0", "#5f6658"],
] as const;
const INK = "#1d2333";
const PAPER = "#f3f0e6";

/** A font string at `px` px. */
const handFont = (px: number, weight = 700) =>
  `${String(weight)} ${String(px)}px ${HAND_FONT_STACK}`;

/**
 * Writes `text` centred at (x, y) in the hand font, as large as `maxPx` allows
 * while fitting `maxWidth`.
 */
function fitText(ctx: Ctx, text: string, x: number, y: number, maxWidth: number, maxPx: number) {
  let px = maxPx;
  ctx.font = handFont(px);
  // Undefined from the tests' stand-in context.
  const metrics = ctx.measureText(text) as TextMetrics | undefined;
  const w = metrics?.width ?? 0;
  if (w > maxWidth && w > 0) {
    px = Math.max(1, Math.floor((px * maxWidth) / w));
    ctx.font = handFont(px);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

/** A rect centred on the origin, `w` x `h`, with its shadow under it. */
function shadowedRect(ctx: Ctx, w: number, h: number, fill: string | CanvasGradient, unit: number) {
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = SHADOW_BLUR * unit;
  ctx.shadowOffsetX = SHADOW_X * unit;
  ctx.shadowOffsetY = SHADOW_Y * unit;
  ctx.fillStyle = fill;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.restore();
}

/** A dark silhouette of `subject` filling the box centred at (0, cy), `w` x `h`. */
function silhouette(
  ctx: Ctx,
  subject: number,
  cy: number,
  w: number,
  h: number,
  rng: () => number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(-w / 2, cy - h / 2, w, h);
  ctx.clip();
  const tones = PHOTO_TONES[Math.floor(rng() * PHOTO_TONES.length)];
  ctx.fillStyle = linearGradient(ctx, 0, cy - h / 2, 0, cy + h / 2, [
    [0, tones[0]],
    [1, tones[1]],
  ]);
  ctx.fillRect(-w / 2, cy - h / 2, w, h);
  ctx.fillStyle = "rgba(24, 26, 30, 0.88)";
  const s = Math.min(w, h);
  const bottom = cy + h / 2;
  const dx = (rng() - 0.5) * w * 0.2;
  if (subject === SUBJECT_CAR) {
    const y = bottom - h * 0.24;
    ctx.beginPath();
    ctx.roundRect(dx - s * 0.62, y - s * 0.2, s * 1.24, s * 0.2, s * 0.06);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(dx - s * 0.36, y - s * 0.19);
    ctx.lineTo(dx - s * 0.2, y - s * 0.38);
    ctx.lineTo(dx + s * 0.22, y - s * 0.38);
    ctx.lineTo(dx + s * 0.4, y - s * 0.19);
    ctx.fill();
    for (const wx of [-0.38, 0.38]) {
      ctx.beginPath();
      ctx.arc(dx + wx * s, y, s * 0.1, 0, 2 * Math.PI);
      ctx.fill();
    }
    // The road.
    ctx.fillStyle = "rgba(20, 22, 26, 0.35)";
    ctx.fillRect(-w / 2, y + s * 0.09, w, h);
  } else if (subject === SUBJECT_BUILDING) {
    const bw = w * (0.38 + 0.2 * rng());
    const bh = h * (0.62 + 0.25 * rng());
    ctx.fillRect(dx - bw / 2, bottom - bh, bw, bh);
    ctx.fillRect(dx - bw / 2 - w * 0.2, bottom - bh * 0.55, w * 0.22, bh * 0.55);
    ctx.fillStyle = "rgba(230, 214, 160, 0.55)";
    const cols = 3;
    const rows = 5;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (rng() < 0.55) {
          ctx.fillRect(
            dx - bw / 2 + bw * (0.14 + (0.76 * c) / cols),
            bottom - bh + bh * (0.08 + (0.8 * r) / rows),
            bw * 0.13,
            bh * 0.08,
          );
        }
      }
    }
  } else {
    // Someone's head and shoulders, or the same with a question mark for a face.
    const hx = dx;
    const hy = cy - h * 0.06;
    ctx.beginPath();
    ctx.ellipse(hx, hy, s * 0.17, s * 0.21, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hx - s * 0.48, bottom + 1);
    ctx.quadraticCurveTo(hx - s * 0.46, hy + s * 0.22, hx, hy + s * 0.24);
    ctx.quadraticCurveTo(hx + s * 0.46, hy + s * 0.22, hx + s * 0.48, bottom + 1);
    ctx.fill();
    if (subject !== SUBJECT_PERSON) {
      ctx.fillStyle = "rgba(240, 236, 220, 0.9)";
      ctx.font = `700 ${String(Math.round(s * 0.36))}px ${HAND_FONT_STACK}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("?", hx, hy + s * 0.01);
    }
  }
  // A faint sheen across the print.
  ctx.fillStyle = linearGradient(ctx, -w / 2, cy - h / 2, w / 2, cy + h / 2, [
    [0, "rgba(255, 255, 255, 0.14)"],
    [0.5, "rgba(255, 255, 255, 0)"],
  ]);
  ctx.fillRect(-w / 2, cy - h / 2, w, h);
  ctx.restore();
}

function photo(ctx: Ctx, item: Item, w: number, h: number, unit: number, rng: () => number) {
  shadowedRect(ctx, w, h, PAPER, unit);
  const b = 0.006 * unit;
  silhouette(ctx, item.variant, 0, w - 2 * b, h - 2 * b, rng);
}

function polaroid(ctx: Ctx, item: Item, w: number, h: number, unit: number, rng: () => number) {
  shadowedRect(ctx, w, h, "#f6f4ee", unit);
  const b = 0.008 * unit;
  const side = w - 2 * b;
  const top = -h / 2 + b;
  silhouette(ctx, item.variant, top + side / 2, side, side, rng);
  // A word scrawled in the wide bottom margin, on some.
  if (rng() < 0.6) {
    ctx.fillStyle = INK;
    const y = (top + side + h / 2) / 2;
    fitText(ctx, WORDS[item.word], 0, y, side * 0.9, Math.round(0.018 * unit));
  }
}

function indexCard(ctx: Ctx, item: Item, w: number, h: number, unit: number) {
  shadowedRect(ctx, w, h, "#f7f5ec", unit);
  const lw = Math.max(1, 0.0012 * unit);
  ctx.fillStyle = "rgba(208, 72, 72, 0.7)";
  ctx.fillRect(-w / 2, -h / 2 + h * 0.2, w, lw);
  ctx.fillStyle = "rgba(90, 130, 190, 0.35)";
  for (let y = -h / 2 + h * 0.38; y < h / 2 - h * 0.05; y += h * 0.16) {
    ctx.fillRect(-w / 2, y, w, lw);
  }
  ctx.fillStyle = INK;
  fitText(ctx, WORDS[item.word], 0, h * 0.08, w * 0.84, Math.round(0.032 * unit));
}

function sticky(ctx: Ctx, item: Item, w: number, h: number, unit: number) {
  const color = STICKY_COLORS[item.variant % STICKY_COLORS.length];
  shadowedRect(ctx, w, h, color, unit);
  // Darker towards the bottom, where it curls away from the board.
  ctx.fillStyle = linearGradient(ctx, 0, -h / 2, 0, h / 2, [
    [0, "rgba(255, 255, 255, 0.12)"],
    [0.7, "rgba(0, 0, 0, 0)"],
    [1, "rgba(0, 0, 0, 0.1)"],
  ]);
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.fillStyle = INK;
  fitText(ctx, WORDS[item.word], 0, h * 0.06, w * 0.86, Math.round(0.026 * unit));
}

/** A ragged-edged rectangle path (newsprint torn or cut by hand). */
function raggedRect(ctx: Ctx, w: number, h: number, jag: number, rng: () => number) {
  const steps = 9;
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h / 2);
  for (let i = 1; i <= steps; i++) {
    ctx.lineTo(-w / 2 + (w * i) / steps, -h / 2 + (rng() - 0.5) * jag);
  }
  for (let i = 1; i <= steps; i++) {
    ctx.lineTo(w / 2 + (rng() - 0.5) * jag, -h / 2 + (h * i) / steps);
  }
  for (let i = 1; i <= steps; i++) {
    ctx.lineTo(w / 2 - (w * i) / steps, h / 2 + (rng() - 0.5) * jag);
  }
  for (let i = 1; i < steps; i++) {
    ctx.lineTo(-w / 2 + (rng() - 0.5) * jag, h / 2 - (h * i) / steps);
  }
  ctx.closePath();
}

function clipping(ctx: Ctx, item: Item, w: number, h: number, unit: number, rng: () => number) {
  const jag = 0.004 * unit;
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = SHADOW_BLUR * unit;
  ctx.shadowOffsetX = SHADOW_X * unit;
  ctx.shadowOffsetY = SHADOW_Y * unit;
  ctx.fillStyle = "#e6e0cd";
  raggedRect(ctx, w - jag, h - jag, jag, rng);
  ctx.fill();
  ctx.restore();
  const m = 0.009 * unit;
  const x0 = -w / 2 + m;
  const cw = w - 2 * m;
  let y = -h / 2 + m;
  // The headline: one or two bold bars.
  ctx.fillStyle = "#232323";
  const hl = 0.011 * unit;
  const lines = rng() < 0.5 ? 1 : 2;
  for (let i = 0; i < lines; i++) {
    const lw = cw * (i === lines - 1 ? 0.55 + 0.4 * rng() : 1);
    ctx.fillRect(x0, y, lw, hl);
    y += hl * 1.5;
  }
  y += hl * 0.4;
  // A small photo on some.
  if (item.variant === 1) {
    const ph = cw * 0.45;
    ctx.fillStyle = "#7d7a72";
    ctx.fillRect(x0, y, cw, ph);
    ctx.fillStyle = "#57544e";
    ctx.fillRect(x0 + cw * 0.3, y + ph * 0.25, cw * 0.25, ph * 0.75);
    y += ph + hl * 0.6;
  }
  // Two columns of grey lines, not readable text.
  const gap = cw * 0.06;
  const colW = (cw - gap) / 2;
  const lh = Math.max(1, 0.0028 * unit);
  ctx.fillStyle = "rgba(60, 60, 60, 0.55)";
  for (let c = 0; c < 2; c++) {
    const cx = x0 + c * (colW + gap);
    for (let ly = y; ly < h / 2 - m; ly += lh * 2.1) {
      const end = rng() < 0.12 ? 0.4 + 0.5 * rng() : 1;
      ctx.fillRect(cx, ly, colW * end, lh);
    }
  }
}

function map(ctx: Ctx, w: number, h: number, unit: number, rng: () => number) {
  shadowedRect(ctx, w, h, "#e9e3cc", unit);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-w / 2, -h / 2, w, h);
  ctx.clip();
  // A park and a river.
  ctx.fillStyle = "#c4d7a4";
  ctx.beginPath();
  ctx.ellipse(-w * 0.22, h * 0.18, w * 0.16, h * 0.16, 0.3, 0, 2 * Math.PI);
  ctx.fill();
  ctx.strokeStyle = "#9fc0d8";
  ctx.lineWidth = 0.009 * unit;
  ctx.beginPath();
  ctx.moveTo(-w / 2, -h * 0.35);
  ctx.bezierCurveTo(-w * 0.1, -h * 0.1, w * 0.05, -h * 0.55, w / 2, -h * 0.2);
  ctx.stroke();
  // Streets: a skewed grid and one long diagonal.
  ctx.strokeStyle = "#fbf9f1";
  ctx.lineWidth = 0.004 * unit;
  const skew = (rng() - 0.5) * 0.3;
  for (let i = -4; i <= 4; i++) {
    const x = (i / 4) * w * 0.55 + (rng() - 0.5) * w * 0.04;
    ctx.beginPath();
    ctx.moveTo(x - h * skew, -h / 2);
    ctx.lineTo(x + h * skew, h / 2);
    ctx.stroke();
  }
  for (let i = -3; i <= 3; i++) {
    const y = (i / 3) * h * 0.45 + (rng() - 0.5) * h * 0.05;
    ctx.beginPath();
    ctx.moveTo(-w / 2, y);
    ctx.lineTo(w / 2, y + (rng() - 0.5) * h * 0.1);
    ctx.stroke();
  }
  ctx.lineWidth = 0.007 * unit;
  ctx.strokeStyle = "#f2e6b4";
  ctx.beginPath();
  ctx.moveTo(-w / 2, h * 0.45);
  ctx.lineTo(w / 2, -h * 0.4);
  ctx.stroke();
  ctx.restore();
  // The spot, circled twice in red marker.
  const sx = w * (0.12 + 0.12 * rng());
  const sy = h * (0.05 + 0.1 * rng());
  ctx.strokeStyle = "rgba(196, 30, 36, 0.9)";
  ctx.lineWidth = 0.0035 * unit;
  for (let k = 0; k < 2; k++) {
    ctx.beginPath();
    ctx.ellipse(
      sx,
      sy,
      w * (0.1 + 0.01 * k),
      h * (0.12 - 0.012 * k),
      -0.2 + 0.15 * k,
      0.2 * k,
      2 * Math.PI + 0.4,
    );
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(196, 30, 36, 0.9)";
  ctx.font = handFont(Math.round(0.026 * unit));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("X", sx, sy);
}

function titleCard(ctx: Ctx, title: string, w: number, h: number, unit: number) {
  shadowedRect(ctx, w, h, "#efe7cf", unit);
  ctx.fillStyle = "rgba(150, 120, 70, 0.18)";
  ctx.fillRect(-w / 2, -h / 2, w, h * 0.12);
  ctx.fillStyle = "#1b1b1f";
  fitText(ctx, title, 0, h * 0.06, w * 0.88, Math.round(0.06 * unit));
  // Underlined twice, in red.
  ctx.fillStyle = "rgba(190, 30, 36, 0.85)";
  const lw = Math.max(1, 0.003 * unit);
  ctx.fillRect(-w * 0.36, h * 0.33, w * 0.72, lw);
  ctx.fillRect(-w * 0.3, h * 0.33 + lw * 2, w * 0.6, lw);
}

/**
 * Paints `item` centred at (cx, cy) on `ctx`, `unit` px per board unit, its
 * shadow included. The title card shows `title`.
 */
export function paintItem(ctx: Ctx, item: Item, cx: number, cy: number, unit: number, title = "") {
  const w = 2 * item.hw * unit;
  const h = 2 * item.hh * unit;
  const rng = createRng(item.seed + 1);
  ctx.save();
  ctx.translate(cx, cy);
  switch (item.kind) {
    case KIND_PHOTO:
      photo(ctx, item, w, h, unit, rng);
      break;
    case KIND_POLAROID:
      polaroid(ctx, item, w, h, unit, rng);
      break;
    case KIND_INDEX:
      indexCard(ctx, item, w, h, unit);
      break;
    case KIND_STICKY:
      sticky(ctx, item, w, h, unit);
      break;
    case KIND_CLIPPING:
      clipping(ctx, item, w, h, unit, rng);
      break;
    case KIND_MAP:
      map(ctx, w, h, unit, rng);
      break;
    case KIND_TITLE:
      titleCard(ctx, title, w, h, unit);
      break;
  }
  ctx.restore();
}
