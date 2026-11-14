/**
 * Canvas art for the Vaporwave scene: palm silhouettes, 90s dialog boxes and
 * the caption (full-width katakana over the spaced-out line). All drawn here,
 * with system fonts and plain paths; no images.
 */
import { paintCanvas, SANS_FONT_STACK } from "../canvas-texture";
import { linearGradient } from "../meme-art";
import { createRng, hash32 } from "../noise";
import {
  CAPTION_PX,
  CAPTION_Y,
  KANA_PX,
  KANA_Y,
  PALM_ASPECT,
  PALM_VARIANTS,
  WINDOW_H,
  WINDOW_W,
} from "./vaporwave-sim";

/** The katakana line: "vaporwave", full width. */
const KANA = "ヴェイパーウェイヴ";
/** System Japanese faces, falling back to whatever the browser picks. */
const KANA_STACK = `"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", Meiryo, "Noto Sans CJK JP", "Noto Sans JP", sans-serif`;
/** A generic 90s dialog face. */
const DIALOG_STACK = `"MS Sans Serif", "Microsoft Sans Serif", Tahoma, Geneva, Verdana, sans-serif`;

const WHITE = "#ffffff";
const SHADOW_PINK = "#ff5fae";
const PALM_INK = "#3b2150";
const FACE = "#c0c0c0";
const LIGHT = "#ffffff";
const MID = "#808080";
const DARK = "#303030";

/** Made-up program names for the title bars, and two-line messages. */
const TITLES = [
  "aesthetic.exe",
  "vapor.exe",
  "dreams.exe",
  "plaza.exe",
  "nostalgia.exe",
  "mall.exe",
  "sunset.exe",
  "memory.exe",
] as const;
const MESSAGES: readonly (readonly [string, string])[] = [
  ["Welcome to the", "virtual plaza."],
  ["Your dreams have", "finished loading."],
  ["Nothing is real.", "Please stay calm."],
  ["Error: too", "aesthetic."],
  ["Now playing:", "elevator music"],
  ["The mall is", "closed forever."],
  ["The sunset will", "last forever."],
  ["Save your", "memories?"],
];

/** The title and message a dialog box shows, from its variation and serial. */
export function dialogText(
  seed: number,
  serial: number,
): { title: string; lines: readonly [string, string]; warn: boolean } {
  const h = hash32(seed * 2654435761 + serial * 40503 + 11);
  return {
    title: TITLES[h % TITLES.length],
    lines: MESSAGES[(h >>> 8) % MESSAGES.length],
    warn: ((h >>> 16) & 3) === 0,
  };
}

/** A sunken or raised bevel round a rect, 90s style. */
function bevel(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  px: number,
  raised: boolean,
): void {
  const [hi, lo] = raised ? [LIGHT, DARK] : [DARK, LIGHT];
  ctx.fillStyle = hi;
  ctx.fillRect(x, y, w, px);
  ctx.fillRect(x, y, px, h);
  ctx.fillStyle = lo;
  ctx.fillRect(x, y + h - px, w, px);
  ctx.fillRect(x + w - px, y, px, h);
  ctx.fillStyle = MID;
  if (raised) {
    ctx.fillRect(x + px, y + h - 2 * px, w - 2 * px, px);
    ctx.fillRect(x + w - 2 * px, y + px, px, h - 2 * px);
  }
}

/**
 * A dialog box at `s` device px per ref px: grey bevelled frame, a blue title
 * bar with a close box, an icon, two lines of message and an OK button.
 */
export function paintDialog(s: number, seed: number, serial: number): OffscreenCanvas | null {
  const w = Math.max(1, Math.round(WINDOW_W * s));
  const h = Math.max(1, Math.round(WINDOW_H * s));
  const { title, lines, warn } = dialogText(seed, serial);
  return paintCanvas(w, h, (ctx) => {
    const px = Math.max(1, Math.round(1.5 * s));
    ctx.fillStyle = FACE;
    ctx.fillRect(0, 0, w, h);
    bevel(ctx, 0, 0, w, h, px, true);
    // Title bar.
    const bx = 4 * s;
    const by = 4 * s;
    const bw = w - 8 * s;
    const bh = 22 * s;
    ctx.fillStyle = linearGradient(ctx, bx, 0, bx + bw, 0, [
      [0, "#000080"],
      [1, "#1084d0"],
    ]);
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = WHITE;
    ctx.font = `700 ${String(13 * s)}px ${DIALOG_STACK}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(title, bx + 6 * s, by + bh / 2);
    // Close box.
    const cs = 16 * s;
    const cx = bx + bw - cs - 3 * s;
    const cy = by + (bh - cs) / 2;
    ctx.fillStyle = FACE;
    ctx.fillRect(cx, cy, cs, cs);
    bevel(ctx, cx, cy, cs, cs, px, true);
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.moveTo(cx + 4.5 * s, cy + 4.5 * s);
    ctx.lineTo(cx + cs - 4.5 * s, cy + cs - 4.5 * s);
    ctx.moveTo(cx + cs - 4.5 * s, cy + 4.5 * s);
    ctx.lineTo(cx + 4.5 * s, cy + cs - 4.5 * s);
    ctx.stroke();
    // Icon: an info disc or a warning sign.
    const ix = 32 * s;
    const iy = 62 * s;
    if (warn) {
      ctx.fillStyle = "#ffd800";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(ix, iy - 16 * s);
      ctx.lineTo(ix + 17 * s, iy + 14 * s);
      ctx.lineTo(ix - 17 * s, iy + 14 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#000000";
      ctx.font = `700 ${String(20 * s)}px ${DIALOG_STACK}`;
      ctx.textAlign = "center";
      ctx.fillText("!", ix, iy + 4 * s);
    } else {
      ctx.fillStyle = "#2050c8";
      ctx.beginPath();
      ctx.arc(ix, iy, 16 * s, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = WHITE;
      ctx.font = `700 italic ${String(22 * s)}px Georgia, "Times New Roman", serif`;
      ctx.textAlign = "center";
      ctx.fillText("i", ix, iy + s);
    }
    // Message.
    ctx.fillStyle = "#000000";
    ctx.font = `${String(14 * s)}px ${DIALOG_STACK}`;
    ctx.textAlign = "left";
    ctx.fillText(lines[0], 62 * s, 54 * s);
    ctx.fillText(lines[1], 62 * s, 74 * s);
    // The OK button, with its focus rect.
    const kw = 84 * s;
    const kh = 26 * s;
    const kx = (w - kw) / 2;
    const ky = h - kh - 14 * s;
    ctx.fillStyle = "#000000";
    ctx.fillRect(kx - px, ky - px, kw + 2 * px, kh + 2 * px);
    ctx.fillStyle = FACE;
    ctx.fillRect(kx, ky, kw, kh);
    bevel(ctx, kx, ky, kw, kh, px, true);
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = Math.max(1, s);
    ctx.setLineDash([s, s]);
    ctx.strokeRect(kx + 4 * s, ky + 4 * s, kw - 8 * s, kh - 8 * s);
    ctx.setLineDash([]);
    ctx.fillStyle = "#000000";
    ctx.font = `${String(14 * s)}px ${DIALOG_STACK}`;
    ctx.textAlign = "center";
    ctx.fillText("OK", w / 2, ky + kh / 2 + s);
  });
}

/** One palm silhouette in a cell `cw` x `ch`, its trunk's foot at the bottom centre. */
function paintPalm(
  ctx: OffscreenCanvasRenderingContext2D,
  ox: number,
  cw: number,
  ch: number,
  variant: number,
): void {
  const rand = createRng(variant * 7 + 3);
  const lean = [0.08, -0.07, 0.15][variant % 3] * cw;
  const footX = ox + cw / 2;
  const crownX = footX + lean;
  const crownY = ch * 0.3;
  const midX = footX + lean * 0.15;
  const midY = ch * 0.68;
  ctx.fillStyle = PALM_INK;
  ctx.strokeStyle = PALM_INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Trunk: a tapered quadratic curve, with ring notches along its edges.
  const steps = 24;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    const x = a * footX + b * midX + c * crownX;
    const y = a * ch + b * midY + c * crownY;
    const dx = 2 * (1 - t) * (midX - footX) + 2 * t * (crownX - midX);
    const dy = 2 * (1 - t) * (midY - ch) + 2 * t * (crownY - midY);
    const len = Math.hypot(dx, dy) || 1;
    const notch = i % 2 === 0 ? 1 : 0.86;
    const half = cw * (0.042 - 0.016 * t) * notch;
    left.push([x - (dy / len) * half, y + (dx / len) * half]);
    right.push([x + (dy / len) * half, y - (dx / len) * half]);
  }
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (const [x, y] of left) {
    ctx.lineTo(x, y);
  }
  for (let i = right.length - 1; i >= 0; i--) {
    ctx.lineTo(right[i][0], right[i][1]);
  }
  ctx.closePath();
  ctx.fill();
  // Fronds: drooping spines with leaflets combed outwards along them.
  const fronds = 8;
  for (let f = 0; f < fronds; f++) {
    const angle = -2.5 + (5 * (f + 0.5)) / fronds + (rand() - 0.5) * 0.3;
    const length = cw * 0.4 * (0.8 + 0.2 * rand());
    const droop = 0.3 + 0.3 * Math.abs(Math.sin(angle));
    const dirX = Math.sin(angle);
    const dirY = -Math.cos(angle);
    const ex = crownX + dirX * length;
    const ey = crownY + dirY * length + droop * length;
    const qx = crownX + dirX * length * 0.55;
    const qy = crownY + dirY * length * 0.55 - 0.05 * length;
    ctx.lineWidth = cw * 0.012;
    ctx.beginPath();
    ctx.moveTo(crownX, crownY);
    ctx.quadraticCurveTo(qx, qy, ex, ey);
    ctx.stroke();
    ctx.lineWidth = cw * 0.007;
    ctx.beginPath();
    for (let k = 1; k <= 18; k++) {
      const t = k / 19;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const c = t * t;
      const x = a * crownX + b * qx + c * ex;
      const y = a * crownY + b * qy + c * ey;
      const tx = 2 * (1 - t) * (qx - crownX) + 2 * t * (ex - qx);
      const ty = 2 * (1 - t) * (qy - crownY) + 2 * t * (ey - qy);
      const tl = Math.hypot(tx, ty) || 1;
      const leaf = length * 0.26 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      for (const side of [-1, 1]) {
        // Leaflets point forward along the spine and out to each side, then hang.
        const lx = (tx / tl) * 0.55 - (side * ty) / tl;
        const ly = (ty / tl) * 0.55 + (side * tx) / tl;
        const ll = Math.hypot(lx, ly);
        ctx.moveTo(x, y);
        ctx.lineTo(x + (lx / ll) * leaf, y + (ly / ll) * leaf + leaf * 0.45);
      }
    }
    ctx.stroke();
  }
  // Coconuts.
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    ctx.arc(crownX + (k - 1) * cw * 0.03, crownY + cw * 0.03, cw * 0.02, 0, 2 * Math.PI);
    ctx.fill();
  }
}

/** Every palm variant side by side, each in a cell `height` px tall. */
export function paintPalmAtlas(height: number): OffscreenCanvas | null {
  const ch = Math.max(1, Math.round(height));
  const cw = Math.max(1, Math.round(ch * PALM_ASPECT));
  return paintCanvas(cw * PALM_VARIANTS, ch, (ctx) => {
    for (let v = 0; v < PALM_VARIANTS; v++) {
      paintPalm(ctx, v * cw, cw, ch, v);
    }
  });
}

/** Whether the system has a face for the katakana: false if they draw like a missing glyph. */
export function canDrawKana(): boolean {
  try {
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (fonts !== undefined && !fonts.check(`20px ${KANA_STACK}`, KANA)) {
      return false;
    }
    const probe = (text: string) =>
      paintCanvas(40, 40, (ctx) => {
        ctx.font = `28px ${KANA_STACK}`;
        ctx.fillStyle = WHITE;
        ctx.textBaseline = "middle";
        ctx.fillText(text, 4, 20);
      })
        ?.getContext("2d")
        ?.getImageData(0, 0, 40, 40).data;
    const kana = probe(KANA.charAt(0));
    const missing = probe("￿");
    if (!kana || !missing) {
      return true;
    }
    return kana.some((v, i) => v !== missing[i]);
  } catch {
    return true;
  }
}

/** Fits `text` in `max` px at `px` (with `ctx.font` set by `font`), shrinking the font if needed. */
function fitFont(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  font: (px: number) => string,
  px: number,
  max: number,
): number {
  ctx.font = font(px);
  const measured = (ctx.measureText(text) as TextMetrics | undefined)?.width;
  if (measured === undefined || !(measured > max)) {
    return px;
  }
  const fitted = Math.max(1, (px * max) / measured);
  ctx.font = font(fitted);
  return fitted;
}

/**
 * The caption band, `width` x `height` device px at `s` device px per ref px:
 * the katakana (when there is a face for it) over the caption, white with a
 * pink drop shadow, each shrunk to fit across.
 */
export function paintCaption(
  width: number,
  height: number,
  s: number,
  top: number,
  text: string,
  kana: boolean,
): OffscreenCanvas | null {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return paintCanvas(w, h, (ctx) => {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const drawLine = (line: string, y: number, font: (px: number) => string, px: number) => {
      const size = fitFont(ctx, line, font, px * s, w * 0.94);
      const off = Math.max(1, size * 0.06);
      ctx.fillStyle = SHADOW_PINK;
      ctx.fillText(line, w / 2 + off, y + off);
      ctx.fillStyle = WHITE;
      ctx.fillText(line, w / 2, y);
    };
    if (kana) {
      drawLine(KANA, (KANA_Y - top) * s, (px) => `500 ${String(px)}px ${KANA_STACK}`, KANA_PX);
    }
    if (text.length > 0) {
      drawLine(
        text,
        (CAPTION_Y - top) * s,
        (px) => `700 ${String(px)}px ${SANS_FONT_STACK}`,
        CAPTION_PX,
      );
    }
  });
}
