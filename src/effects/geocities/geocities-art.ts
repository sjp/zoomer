/**
 * Under Construction's canvas artwork, drawn once per text, tile, style and
 * canvas size: the static page (the tiled background, the title, the bevelled
 * buttons, the sign's board and hazard stripes, the counter's frame, the
 * rainbow rule, the marquee's band and the footer), a small atlas of the moving
 * parts (the sign's blinking words, the worker's three frames, the NEW! badge,
 * four globe frames and the odometer's digit wheel), and the marquee strip.
 * Classic snaps every canvas to the 216 web-safe colours with hard alpha.
 */
import { MONO_FONT_STACK, paintCanvas, SANS_FONT_STACK } from "../canvas-texture";
import { createRng } from "../noise";
import {
  CLASHING_COLORS,
  clashingColors,
  createEmMeasure,
  drawOutlinedText,
  linearGradient,
  memeFont,
  rainbowStops,
} from "../meme-art";
import type { TileId } from "./geocities.meta";
import {
  BADGE_BUTTON,
  BADGE_POINTS,
  BUTTON_LABELS,
  type Face,
  GLOBE_FRAMES,
  MARQUEE_GAP_EM,
  marqueePeriod,
  type MeasureText,
  type PageLayout,
  type Rect,
  textEm,
  WORKER_FRAMES,
} from "./geocities-sim";

type Ctx = OffscreenCanvasRenderingContext2D;

/** Largest side of any canvas, px. */
export const MAX_TEXTURE = 4096;
/** The background tile's side, page px. */
const TILE_SIZE = 64;

const BUTTON_STACK = `"MS Sans Serif", Tahoma, Verdana, Arial, sans-serif`;
const SERIF_STACK = `"Times New Roman", Times, serif`;
const SIGN_STACK = `"Arial Black", Impact, ${SANS_FONT_STACK}`;

/** A canvas font for `face` at `px` px. */
function faceFont(face: Face, px: number): string {
  if (face === "button") {
    return `700 ${String(px)}px ${BUTTON_STACK}`;
  }
  return face === "small" ? `400 ${String(px)}px ${SERIF_STACK}` : memeFont(700, px);
}

/** Measures page text in ems of each face (undefined where nothing can measure). */
export function createGeoMeasure(): MeasureText {
  const faces = {
    title: createEmMeasure((px) => faceFont("title", px)),
    marquee: createEmMeasure((px) => faceFont("marquee", px)),
    button: createEmMeasure((px) => faceFont("button", px)),
    small: createEmMeasure((px) => faceFont("small", px)),
  };
  return (text, face) => faces[face](text);
}

/** Per tile: the page's text colours and the title's look. */
const TILE_LOOK: Record<
  TileId,
  { text: string; label: string; outline: string; shadow: string; rainbow: boolean }
> = {
  stars: {
    text: "#ffffff",
    label: "#ffff00",
    outline: "#000000",
    shadow: "#660066",
    rainbow: true,
  },
  stone: {
    text: "#000000",
    label: "#000066",
    outline: "#000000",
    shadow: "#000000",
    rainbow: false,
  },
  paper: {
    text: "#000080",
    label: "#990000",
    outline: "#000080",
    shadow: "#999999",
    rainbow: true,
  },
};

/**
 * Snaps RGBA pixels to the 216 web-safe colours (each channel a multiple of
 * 51) with hard alpha: anything at least half opaque becomes solid, the rest
 * clear. In place.
 */
export function snapWebSafe(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    } else {
      data[i] = Math.round(data[i] / 51) * 51;
      data[i + 1] = Math.round(data[i + 1] / 51) * 51;
      data[i + 2] = Math.round(data[i + 2] / 51) * 51;
      data[i + 3] = 255;
    }
  }
}

/** Classic's 256-colour look for a whole canvas; nothing where pixels can't be read (tests). */
function snapCanvas(canvas: OffscreenCanvas | null): void {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) {
    return;
  }
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height) as ImageData | undefined;
  if (image?.data === undefined) {
    return;
  }
  snapWebSafe(image.data);
  ctx.putImageData(image, 0, 0);
}

/** Paints a canvas, snapped to web-safe colours in Classic. */
function paint(
  width: number,
  height: number,
  classic: boolean,
  draw: (ctx: Ctx) => void,
): OffscreenCanvas | null {
  const canvas = paintCanvas(Math.max(1, width), Math.max(1, height), (ctx) => {
    ctx.imageSmoothingEnabled = !classic;
    draw(ctx);
  });
  if (classic) {
    snapCanvas(canvas);
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// Background tiles

/** A four-pointed star of radius `r` at (x, y). */
function star(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const d = k % 2 === 0 ? r : r * 0.28;
    ctx.lineTo(x + d * Math.cos(a), y + d * Math.sin(a));
  }
  ctx.closePath();
  ctx.fill();
}

/** One tile in a unit square: its visible repeats are part of the joke. */
function drawTile(ctx: Ctx, tile: TileId): void {
  const rng = createRng(tile === "stars" ? 7 : tile === "stone" ? 11 : 13);
  if (tile === "stars") {
    ctx.fillStyle = "#000033";
    ctx.fillRect(0, 0, 1, 1);
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = rng() < 0.3 ? "#ffff66" : "#ffffff";
      const s = 0.015 + 0.015 * rng();
      ctx.fillRect(rng(), rng(), s, s);
    }
    ctx.fillStyle = "#ffffff";
    star(ctx, 0.27, 0.31, 0.07);
    ctx.fillStyle = "#ffff33";
    star(ctx, 0.74, 0.7, 0.09);
    star(ctx, 0.82, 0.18, 0.045);
  } else if (tile === "stone") {
    ctx.fillStyle = "#999999";
    ctx.fillRect(0, 0, 1, 1);
    for (let i = 0; i < 40; i++) {
      const g = 110 + Math.floor(rng() * 90);
      ctx.fillStyle = `rgb(${String(g)}, ${String(g)}, ${String(g - 8)})`;
      ctx.beginPath();
      ctx.ellipse(rng(), rng(), 0.03 + 0.07 * rng(), 0.02 + 0.05 * rng(), rng() * 3, 0, 7);
      ctx.fill();
    }
    ctx.strokeStyle = "#555555";
    ctx.lineWidth = 0.02;
    ctx.beginPath();
    ctx.moveTo(0.1, 0.55);
    ctx.lineTo(0.3, 0.6);
    ctx.lineTo(0.38, 0.75);
    ctx.moveTo(0.6, 0.12);
    ctx.lineTo(0.72, 0.26);
    ctx.stroke();
  } else {
    ctx.fillStyle = "#ffffcc";
    ctx.fillRect(0, 0, 1, 1);
    ctx.strokeStyle = "#e8e0b0";
    ctx.lineWidth = 0.012;
    for (let i = 0; i < 9; i++) {
      const x = rng();
      const y = rng();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 0.15 * rng(), y + 0.04 * (rng() - 0.5));
      ctx.stroke();
    }
    ctx.fillStyle = "#d8cc99";
    for (let i = 0; i < 12; i++) {
      ctx.fillRect(rng(), rng(), 0.015, 0.015);
    }
  }
}

// ---------------------------------------------------------------------------
// The static page

/** A bevelled box: light top-left, dark bottom-right (`sunken` swaps them). */
function bevel(ctx: Ctx, r: Rect, face: string | null, sunken: boolean, edge: number): void {
  if (face !== null) {
    ctx.fillStyle = face;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  const light = sunken ? "#808080" : "#ffffff";
  const dark = sunken ? "#ffffff" : "#808080";
  ctx.fillStyle = light;
  ctx.fillRect(r.x, r.y, r.w, edge);
  ctx.fillRect(r.x, r.y, edge, r.h);
  ctx.fillStyle = dark;
  ctx.fillRect(r.x, r.y + r.h - edge, r.w, edge);
  ctx.fillRect(r.x + r.w - edge, r.y, edge, r.h);
}

/** Diagonal yellow-and-black hazard stripes filling `r`. */
function hazard(ctx: Ctx, r: Rect): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.fillStyle = "#ffcc00";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = "#000000";
  const s = r.h;
  for (let x = r.x - r.h; x < r.x + r.w + r.h; x += 2 * s) {
    ctx.beginPath();
    ctx.moveTo(x, r.y + r.h);
    ctx.lineTo(x + s, r.y + r.h);
    ctx.lineTo(x + s + r.h, r.y);
    ctx.lineTo(x + r.h, r.y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Centred text in `face` at `size`. */
function centred(ctx: Ctx, text: string, face: Face, size: number, x: number, y: number): void {
  ctx.font = faceFont(face, size);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

/**
 * The static page for a `width` x `height` px canvas: everything that doesn't
 * move, round the edges of the page, with the middle left as plain tile.
 */
export function paintPage(
  layout: PageLayout,
  tile: TileId,
  width: number,
  height: number,
  classic: boolean,
): OffscreenCanvas | null {
  const look = TILE_LOOK[tile];
  return paint(width, height, classic, (ctx) => {
    // The tile, repeated in whole device px so every seam lands on the same column.
    const k = height / layout.height;
    const side = Math.max(1, Math.round(TILE_SIZE * k));
    const tileCanvas = paint(side, side, classic, (t) => {
      t.scale(side, side);
      drawTile(t, tile);
    });
    if (tileCanvas) {
      for (let y = 0; y < height; y += side) {
        for (let x = 0; x < width; x += side) {
          ctx.drawImage(tileCanvas, x, y);
        }
      }
    } else {
      ctx.fillStyle = "#000033";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.scale(width / layout.width, height / layout.height);

    // The title: rainbow or flat yellow, outlined, over a hard drop shadow.
    const t = layout.title;
    if (t.text.length > 0) {
      ctx.font = faceFont("title", t.size);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const drop = Math.max(1, 0.08 * t.size);
      ctx.fillStyle = look.shadow;
      ctx.fillText(t.text, t.x + drop, t.y + drop);
      const fill = look.rainbow
        ? linearGradient(ctx, t.x - t.width / 2, 0, t.x + t.width / 2, 0, rainbowStops())
        : "#ffff00";
      drawOutlinedText(ctx, t.text, t.x, t.y, fill, look.outline, Math.max(1, 0.07 * t.size));
    }

    // The buttons.
    const edge = Math.max(1, layout.buttons[0].h / 16);
    layout.buttons.forEach((b, i) => {
      ctx.fillStyle = "#000000";
      ctx.fillRect(b.x - edge / 2, b.y - edge / 2, b.w + edge, b.h + edge);
      bevel(ctx, b, "#c0c0c0", false, edge);
      ctx.fillStyle = i === BADGE_BUTTON ? "#000080" : "#000000";
      centred(ctx, BUTTON_LABELS[i], "button", layout.buttonSize, b.x + b.w / 2, b.y + b.h / 2);
    });

    // The sign's board, hazard bar, dirt pile and cone; its words and worker are sprites.
    const s = layout.sign;
    const line = Math.max(1, s.w / 80);
    ctx.fillStyle = "#000000";
    ctx.fillRect(s.x - line, s.y - line, s.w + 2 * line, s.h + 2 * line);
    ctx.fillStyle = "#ffcc00";
    ctx.fillRect(s.x, s.y, s.w, s.h);
    hazard(ctx, layout.hazard);
    const w = layout.worker;
    const ground = layout.hazard.y;
    ctx.fillStyle = "#996633";
    ctx.beginPath();
    ctx.ellipse(w.x + w.w * 1.25, ground, w.w * 0.42, w.h * 0.28, 0, Math.PI, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = "#663300";
    ctx.fillRect(w.x + w.w * 1.1, ground - w.h * 0.12, w.w * 0.08, w.w * 0.08);
    const coneX = s.x + s.w * 0.86;
    const coneH = w.h * 0.62;
    ctx.fillStyle = "#ff6600";
    ctx.beginPath();
    ctx.moveTo(coneX - coneH * 0.32, ground);
    ctx.lineTo(coneX, ground - coneH);
    ctx.lineTo(coneX + coneH * 0.32, ground);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(coneX - coneH * 0.16, ground - coneH * 0.5, coneH * 0.32, coneH * 0.12);

    // The counter's label and frame; its digits are sprites.
    ctx.fillStyle = look.label;
    const c = layout.counterLabel;
    centred(ctx, c.text, "small", c.size, c.x, c.y);
    const o = layout.odometer;
    const pad = Math.max(1, layout.digitW * 0.18);
    ctx.fillStyle = "#333333";
    ctx.fillRect(o.x - pad, o.y - pad, o.w + 2 * pad, o.h + 2 * pad);
    bevel(ctx, { x: o.x - pad, y: o.y - pad, w: o.w + 2 * pad, h: o.h + 2 * pad }, null, true, 1);

    // The rainbow rule, the marquee's sunken band and the footer.
    const r = layout.rule;
    ctx.fillStyle = linearGradient(ctx, r.x, 0, r.x + r.w, 0, rainbowStops());
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#000000";
    ctx.fillRect(r.x, r.y + r.h, r.w, Math.max(1, r.h / 4));
    const m = layout.marquee;
    ctx.fillStyle = "#000000";
    ctx.fillRect(m.x, m.y, m.w, m.h);
    bevel(ctx, m, null, true, Math.max(1, m.h / 20));
    ctx.fillStyle = look.text;
    for (const f of layout.footer) {
      centred(ctx, f.text, "small", f.size, f.x, f.y);
    }
  });
}

// ---------------------------------------------------------------------------
// The moving parts' atlas

/** A cell's atlas rectangle, u0 v0 u1 v1 (v down). */
type Uv = readonly [number, number, number, number];

export interface PartsArt {
  canvas: OffscreenCanvas | null;
  signText: Uv;
  workers: Uv[];
  badge: Uv;
  globes: Uv[];
  /** The digit wheel: 0 to 9 then 0 again, top to bottom; `cell` is one digit's height in v. */
  wheel: Uv;
  cell: number;
}

/** Gap round each atlas cell, page px. */
const CELL_GAP = 3;

/** The sign's words, two lines fitted to the cell, black on clear. */
function drawSignText(ctx: Ctx, w: number, h: number): void {
  const lines = ["UNDER", "CONSTRUCTION"];
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 100px ${SIGN_STACK}`;
  const widest = Math.max(
    ...lines.map((l) => {
      const m = ctx.measureText(l) as TextMetrics | undefined;
      return m === undefined ? Array.from(l).length * 70 : m.width;
    }),
  );
  const size = Math.max(1, Math.min(h * 0.46, (100 * w * 0.96) / Math.max(1, widest)));
  ctx.font = `900 ${String(size)}px ${SIGN_STACK}`;
  ctx.fillStyle = "#000000";
  ctx.fillText(lines[0], w / 2, h * 0.27);
  ctx.fillText(lines[1], w / 2, h * 0.75);
}

/**
 * The stick worker in a unit cell, in hard hat and with a shovel: frame 0 at
 * rest, 1 with the shovel raised, 2 with it driven into the pile on the right.
 */
function drawWorker(ctx: Ctx, frame: number): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 0.07;
  const lean = frame === 2 ? 0.08 : 0;
  // Legs and body.
  ctx.beginPath();
  ctx.moveTo(0.3, 0.98);
  ctx.lineTo(0.42 + lean, 0.66);
  ctx.lineTo(0.54, 0.98);
  ctx.moveTo(0.42 + lean, 0.66);
  ctx.lineTo(0.4 + lean * 1.5, 0.36);
  ctx.stroke();
  // Head and hard hat.
  const hx = 0.39 + lean * 1.8;
  ctx.fillStyle = "#ffcc99";
  ctx.beginPath();
  ctx.arc(hx, 0.26, 0.09, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#ff9900";
  ctx.beginPath();
  ctx.arc(hx, 0.22, 0.1, Math.PI, 2 * Math.PI);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(hx - 0.14, 0.2, 0.28, 0.035);
  // Arms and shovel, by frame.
  const shoulder = [0.4 + lean * 1.5, 0.42] as const;
  const hand =
    frame === 1
      ? ([0.66, 0.22] as const)
      : frame === 2
        ? ([0.7, 0.6] as const)
        : ([0.6, 0.55] as const);
  const blade =
    frame === 1
      ? ([0.88, 0.08] as const)
      : frame === 2
        ? ([0.86, 0.95] as const)
        : ([0.7, 0.96] as const);
  ctx.beginPath();
  ctx.moveTo(shoulder[0], shoulder[1]);
  ctx.lineTo(hand[0], hand[1]);
  ctx.stroke();
  ctx.strokeStyle = "#663300";
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.moveTo(hand[0] - (blade[0] - hand[0]) * 0.5, hand[1] - (blade[1] - hand[1]) * 0.5);
  ctx.lineTo(blade[0], blade[1]);
  ctx.stroke();
  ctx.fillStyle = "#999999";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 0.025;
  ctx.beginPath();
  ctx.arc(blade[0], blade[1], 0.06, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
}

/** The NEW! badge in a unit cell: a red starburst with yellow lettering. */
function drawBadge(ctx: Ctx): void {
  ctx.beginPath();
  for (let k = 0; k < 2 * BADGE_POINTS; k++) {
    const a = (k * Math.PI) / BADGE_POINTS - Math.PI / 2;
    const r = k % 2 === 0 ? 0.49 : 0.36;
    ctx.lineTo(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a));
  }
  ctx.closePath();
  ctx.fillStyle = "#ff0000";
  ctx.fill();
  ctx.lineWidth = 0.03;
  ctx.strokeStyle = "#ffff00";
  ctx.stroke();
  // Lettered in a 100-unit square: fonts a fraction of a px tall don't render reliably.
  ctx.save();
  ctx.scale(0.01, 0.01);
  ctx.font = memeFont(700, 30);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawOutlinedText(ctx, "NEW!", 50, 52, "#ffff00", "#990000", 5);
  ctx.restore();
}

/** Each continent as [x, y, rx, ry] on a unit-wide strip that wraps round the globe. */
const CONTINENTS = [
  [0.1, 0.35, 0.12, 0.18],
  [0.2, 0.68, 0.07, 0.16],
  [0.48, 0.3, 0.14, 0.1],
  [0.55, 0.6, 0.1, 0.17],
  [0.82, 0.42, 0.1, 0.12],
] as const;

/** A globe in a unit cell, its continents turned on by `frame` of `GLOBE_FRAMES`. */
function drawGlobe(ctx: Ctx, frame: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(0.5, 0.5, 0.46, 0, 2 * Math.PI);
  ctx.fillStyle = "#0066ff";
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = "#33cc33";
  const shift = frame / GLOBE_FRAMES;
  for (const [x, y, rx, ry] of CONTINENTS) {
    for (const wrap of [-1, 0]) {
      ctx.beginPath();
      ctx.ellipse(((x + shift) % 1) + wrap + 0.5, y, rx, ry, 0, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(0.34, 0.28, 0.1, 0.06, -0.6, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 0.05;
  ctx.strokeStyle = "#000000";
  ctx.beginPath();
  ctx.arc(0.5, 0.5, 0.46, 0, 2 * Math.PI);
  ctx.stroke();
}

/** The odometer's wheel: digits 0-9 then 0, each in a `w` x `h` cell, white on black. */
function drawWheel(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h * 11);
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${String(h * 0.78)}px ${MONO_FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let d = 0; d <= 10; d++) {
    ctx.fillText(String(d % 10), w / 2, (d + 0.54) * h);
  }
  ctx.fillStyle = "#333333";
  ctx.fillRect(0, 0, Math.max(0.5, w * 0.06), h * 11);
  ctx.fillRect(w - Math.max(0.5, w * 0.06), 0, Math.max(0.5, w * 0.06), h * 11);
}

/**
 * The moving parts for `layout`, `kx` x `ky` px per page px (shrunk if they
 * would not fit a texture): the sign's words, three worker frames, the badge,
 * the globe frames and the digit wheel.
 */
export function paintParts(layout: PageLayout, kx: number, ky: number, classic: boolean): PartsArt {
  const g = CELL_GAP;
  const st = layout.signText;
  const wk = layout.worker;
  const bd = 2 * layout.badge.r;
  const gl = layout.globes[0].w;
  const dw = layout.digitW;
  const dh = layout.digitH;
  // Cells in page px: the words on the top row, the small parts in a row
  // below, the wheel in a column on the right.
  const row2 = Math.max(wk.h, bd, gl);
  const leftW = Math.max(st.w, WORKER_FRAMES * (wk.w + g) + bd + g + GLOBE_FRAMES * (gl + g));
  const width = g + leftW + g + dw + g;
  const height = Math.max(g + st.h + g + row2 + g, g + 11 * dh + g);
  const k = Math.min(1, MAX_TEXTURE / Math.max(width * kx, height * ky));
  const sx = kx * k;
  const sy = ky * k;
  const cw = Math.max(1, Math.ceil(width * sx));
  const ch = Math.max(1, Math.ceil(height * sy));
  const uv = (x: number, y: number, w: number, h: number): Uv => [
    (x * sx) / cw,
    (y * sy) / ch,
    ((x + w) * sx) / cw,
    ((y + h) * sy) / ch,
  ];
  const y2 = g + st.h + g;
  const workerX = (i: number) => g + i * (wk.w + g);
  const badgeX = workerX(WORKER_FRAMES);
  const globeX = (i: number) => badgeX + bd + g + i * (gl + g);
  const wheelX = g + leftW + g;
  const canvas = paint(cw, ch, classic, (ctx) => {
    ctx.scale(sx, sy);
    const place = (x: number, y: number, w: number, h: number, draw: () => void) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(w, h);
      draw();
      ctx.restore();
    };
    ctx.save();
    ctx.translate(g, g);
    drawSignText(ctx, st.w, st.h);
    ctx.restore();
    for (let i = 0; i < WORKER_FRAMES; i++) {
      place(workerX(i), y2, wk.w, wk.h, () => {
        drawWorker(ctx, i);
      });
    }
    place(badgeX, y2, bd, bd, () => {
      drawBadge(ctx);
    });
    for (let i = 0; i < GLOBE_FRAMES; i++) {
      place(globeX(i), y2, gl, gl, () => {
        drawGlobe(ctx, i);
      });
    }
    ctx.save();
    ctx.translate(wheelX, g);
    drawWheel(ctx, dw, dh);
    ctx.restore();
  });
  return {
    canvas,
    signText: uv(g, g, st.w, st.h),
    workers: Array.from({ length: WORKER_FRAMES }, (_, i) => uv(workerX(i), y2, wk.w, wk.h)),
    badge: uv(badgeX, y2, bd, bd),
    globes: Array.from({ length: GLOBE_FRAMES }, (_, i) => uv(globeX(i), y2, gl, gl)),
    wheel: uv(wheelX, g, dw, 11 * dh),
    cell: (dh * sy) / ch,
  };
}

// ---------------------------------------------------------------------------
// The marquee strip

interface MarqueeArt {
  canvas: OffscreenCanvas | null;
  /** The strip's period, page px: it repeats seamlessly every period. */
  period: number;
}

/**
 * The marquee's text once, each word in a clashing colour with a dark
 * outline, starting half a gap into a strip one period long, at `kx` x `ky` px
 * per page px (shrunk along the strip if it would not fit a texture). Drawn on
 * a repeating texture it scrolls with no seam for any text length.
 */
export function paintMarquee(
  text: string,
  layout: PageLayout,
  measure: MeasureText,
  kx: number,
  ky: number,
  classic: boolean,
): MarqueeArt {
  const size = layout.marqueeSize;
  const em = textEm(text, "marquee", measure);
  const period = marqueePeriod(em, size);
  const h = layout.marquee.h;
  const cw = Math.max(1, Math.round(Math.min(period * kx, MAX_TEXTURE)));
  const ch = Math.max(1, Math.round(Math.min(h * ky, MAX_TEXTURE)));
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const colors = clashingColors(3, words.length);
  const space = textEm(" ", "marquee", measure) * size;
  const canvas = paint(cw, ch, classic, (ctx) => {
    ctx.scale(cw / period, ch / h);
    ctx.font = faceFont("marquee", size);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    // Each word is placed by its share of the measured line, so the drawn text
    // spans exactly the width the period was built from.
    const widths = words.map((w) => textEm(w, "marquee", measure) * size);
    const total = widths.reduce((a, b) => a + b, 0) + space * Math.max(0, words.length - 1);
    const fit = total > 0 ? (em * size) / total : 1;
    let x = (MARQUEE_GAP_EM * size) / 2;
    words.forEach((word, i) => {
      drawOutlinedText(
        ctx,
        word,
        x,
        h / 2,
        CLASHING_COLORS[colors[i]],
        "#000000",
        Math.max(1, size * 0.08),
      );
      x += (widths[i] + space) * fit;
    });
  });
  return { canvas, period };
}
