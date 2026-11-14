/**
 * This Is Fine's canvas artwork: the two rooms (Office and Kitchen) in flat
 * colour with heavy dark outlines and a little hand-drawn wobble, and the
 * speech bubble. Everything is drawn in reference px (the frame is 1080 tall)
 * on a context scaled to device px.
 */
import { paintCanvas } from "../canvas-texture";
import { blob, OUTLINE } from "../clip-art";
import { createRng } from "../noise";
import type { Rect, RoomLayout } from "./thisisfine-sim";

type Ctx = OffscreenCanvasRenderingContext2D;

/** Heavy outline width, ref px. */
const INK = 5;
/** Hand-drawn wobble: largest sideways wander of a line, and the length it varies over, ref px. */
const WOBBLE = 1.6;
const WOBBLE_STEP = 36;

/** A comic lettering stack that falls back to `cursive`; no font is bundled. */
const COMIC_FONT_STACK = `"Comic Sans MS", "Chalkboard SE", "Comic Neue", cursive`;
export const comicFont = (px: number) => `400 ${String(px)}px ${COMIC_FONT_STACK}`;

interface RoomColors {
  wall: string;
  /** The lower wall: a darker band (Office) or tiles (Kitchen). */
  dado: string;
  skirting: string;
  floor: string;
  floorLine: string;
  ceiling: string;
}

const ROOMS: Record<string, RoomColors> = {
  office: {
    wall: "#f4b650",
    dado: "#e99d3e",
    skirting: "#7a4a2a",
    floor: "#9a6236",
    floorLine: "#7a4826",
    ceiling: "#e8a446",
  },
  kitchen: {
    wall: "#f7c86a",
    dado: "#f3efe2",
    skirting: "#5f6b7a",
    floor: "#e9e2d0",
    floorLine: "#6d6a7a",
    ceiling: "#eeb859",
  },
};

const WOOD = "#a8693c";
const WOOD_DARK = "#7c4a2a";
const DOOR = "#c0814a";
const MUG = "#f7f3ea";
const COFFEE = "#4a2b17";
const POT = "#c8643a";
const LEAF = "#3f9a45";
const LEAF_LIGHT = "#5cbf55";
const FRIDGE = "#eef1f1";
const BUBBLE = "#ffffff";
const TEXT = "#1d1a1a";

/** Unknown rooms draw as the office. */
const roomColors = (room: string) => ROOMS[room] ?? ROOMS.office;

/**
 * Traces a wobbly polyline through `pts` (x, y pairs): each segment split into
 * short steps, each nudged sideways by a slowly varying offset.
 */
function wobblyPath(ctx: Ctx, pts: readonly number[], closed: boolean, rng: () => number) {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  const n = pts.length / 2;
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const x0 = pts[i * 2];
    const y0 = pts[i * 2 + 1];
    const j = (i + 1) % n;
    const x1 = pts[j * 2];
    const y1 = pts[j * 2 + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.round(len / WOBBLE_STEP));
    const nx = len > 0 ? -(y1 - y0) / len : 0;
    const ny = len > 0 ? (x1 - x0) / len : 0;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      // Corners stay put so shapes still meet.
      const off = s < steps ? (rng() * 2 - 1) * WOBBLE : 0;
      ctx.lineTo(x0 + (x1 - x0) * f + nx * off, y0 + (y1 - y0) * f + ny * off);
    }
  }
  if (closed) {
    ctx.closePath();
  }
}

/** A filled, outlined, slightly wobbly rect. */
function box(ctx: Ctx, r: Rect, fill: string, rng: () => number) {
  wobblyPath(ctx, [r.x, r.y, r.x + r.w, r.y, r.x + r.w, r.y + r.h, r.x, r.y + r.h], true, rng);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

/** A wobbly outlined line. */
function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, rng: () => number) {
  wobblyPath(ctx, [x0, y0, x1, y1], false, rng);
  ctx.stroke();
}

function pen(ctx: Ctx, width = INK) {
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = OUTLINE;
}

/** Back wall, lower wall band, cornice, skirting and floor. */
function drawShell(ctx: Ctx, l: RoomLayout, room: string, rng: () => number) {
  const c = roomColors(room);
  const { width: w, height: h, floorTop } = l;
  ctx.fillStyle = c.wall;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = c.ceiling;
  ctx.fillRect(0, 0, w, l.cornice);
  pen(ctx, INK * 0.8);
  line(ctx, -10, l.cornice, w + 10, l.cornice, rng);

  const dadoTop = h * 0.62;
  ctx.fillStyle = c.dado;
  ctx.fillRect(0, dadoTop, w, floorTop - dadoTop);
  if (room === "kitchen") {
    // Big plain tiles: calm behind the speaker.
    pen(ctx, 2);
    ctx.strokeStyle = "#cfc6b0";
    const tile = 64;
    for (let y = dadoTop + tile; y < floorTop - 4; y += tile) {
      line(ctx, 0, y, w, y, rng);
    }
    for (let x = tile; x < w; x += tile) {
      line(ctx, x, dadoTop, x, floorTop, rng);
    }
    pen(ctx);
  } else {
    pen(ctx, INK * 0.6);
    line(ctx, -10, dadoTop + 12, w + 10, dadoTop + 12, rng);
  }
  pen(ctx, INK * 0.8);
  line(ctx, -10, dadoTop, w + 10, dadoTop, rng);

  ctx.fillStyle = c.floor;
  ctx.fillRect(0, floorTop, w, h - floorTop);
  pen(ctx, 3);
  ctx.strokeStyle = c.floorLine;
  if (room === "kitchen") {
    // Checked lino in perspective-free rows.
    const cell = 40;
    ctx.fillStyle = c.floorLine;
    for (let row = 0; floorTop + row * cell < h; row++) {
      for (let col = row % 2; col * cell < w; col += 2) {
        ctx.fillRect(col * cell, floorTop + row * cell, cell, cell);
      }
    }
  } else {
    for (let y = floorTop + 26; y < h; y += 26) {
      line(ctx, 0, y, w, y, rng);
    }
  }
  pen(ctx);
  ctx.fillStyle = c.skirting;
  ctx.fillRect(0, floorTop - 18, w, 18);
  line(ctx, -10, floorTop - 18, w + 10, floorTop - 18, rng);
  line(ctx, -10, floorTop, w + 10, floorTop, rng);
}

function drawDoor(ctx: Ctx, l: RoomLayout, rng: () => number) {
  const d = l.door;
  const trim = Math.max(8, d.w * 0.09);
  box(ctx, d, WOOD_DARK, rng);
  const panel = { x: d.x + trim, y: d.y + trim, w: d.w - 2 * trim, h: d.h - trim };
  box(ctx, panel, DOOR, rng);
  // Two sunk panels and a knob.
  const inset = panel.w * 0.16;
  pen(ctx, INK * 0.6);
  const ph = (panel.h - 3 * inset) / 2;
  box(
    ctx,
    { x: panel.x + inset, y: panel.y + inset, w: panel.w - 2 * inset, h: ph },
    "#b5743f",
    rng,
  );
  box(
    ctx,
    { x: panel.x + inset, y: panel.y + 2 * inset + ph, w: panel.w - 2 * inset, h: ph },
    "#b5743f",
    rng,
  );
  pen(ctx);
  blob(
    ctx,
    panel.x + panel.w * 0.84,
    panel.y + panel.h * 0.52,
    panel.w * 0.05,
    panel.w * 0.05,
    "#f2c94c",
  );
}

function drawPicture(ctx: Ctx, l: RoomLayout, rng: () => number) {
  const p = l.picture;
  ctx.save();
  ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
  ctx.rotate(l.tilt);
  ctx.translate(-p.w / 2, -p.h / 2);
  // Hanging string.
  pen(ctx, 3);
  line(ctx, p.w * 0.2, 0, p.w / 2, -p.h * 0.25, rng);
  line(ctx, p.w / 2, -p.h * 0.25, p.w * 0.8, 0, rng);
  pen(ctx);
  box(ctx, { x: 0, y: 0, w: p.w, h: p.h }, "#6b3f22", rng);
  const m = p.w * 0.09;
  const inner = { x: m, y: m, w: p.w - 2 * m, h: p.h - 2 * m };
  // A sunny landscape: sky, sun, a green hill.
  ctx.fillStyle = "#8fd3f0";
  ctx.fillRect(inner.x, inner.y, inner.w, inner.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(inner.x, inner.y, inner.w, inner.h);
  ctx.clip();
  pen(ctx, INK * 0.6);
  blob(
    ctx,
    inner.x + inner.w * 0.75,
    inner.y + inner.h * 0.3,
    inner.h * 0.14,
    inner.h * 0.14,
    "#ffe14d",
  );
  blob(
    ctx,
    inner.x + inner.w * 0.3,
    inner.y + inner.h * 1.15,
    inner.w * 0.7,
    inner.h * 0.55,
    "#6cc04a",
  );
  ctx.restore();
  pen(ctx);
  ctx.strokeRect(inner.x, inner.y, inner.w, inner.h);
  ctx.restore();
}

function drawClock(ctx: Ctx, l: RoomLayout) {
  const p = l.picture;
  const r = Math.min(p.w, p.h) * 0.42;
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  pen(ctx);
  blob(ctx, cx, cy, r, r, "#d9483b");
  blob(ctx, cx, cy, r * 0.82, r * 0.82, "#fffaf0");
  pen(ctx, 3);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.66, cy + Math.sin(a) * r * 0.66);
    ctx.lineTo(cx + Math.cos(a) * r * 0.74, cy + Math.sin(a) * r * 0.74);
    ctx.stroke();
  }
  pen(ctx, INK);
  // Ten past ten, like every clock in an advert.
  const hand = (a: number, len: number) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(a) * len, cy - Math.cos(a) * len);
    ctx.stroke();
  };
  hand((10 / 12) * Math.PI * 2 + 0.08, r * 0.42);
  hand((2 / 12) * Math.PI * 2, r * 0.62);
}

function drawHatStand(ctx: Ctx, l: RoomLayout, rng: () => number) {
  const s = l.stand;
  const cx = s.x + s.w / 2;
  pen(ctx);
  const pole = Math.max(6, s.w * 0.12);
  box(ctx, { x: cx - pole / 2, y: s.y + s.w * 0.25, w: pole, h: s.h - s.w * 0.25 }, WOOD_DARK, rng);
  // Three splayed feet.
  pen(ctx, INK * 1.4);
  ctx.strokeStyle = WOOD_DARK;
  line(ctx, cx, s.y + s.h - s.w * 0.25, cx - s.w / 2, s.y + s.h, rng);
  line(ctx, cx, s.y + s.h - s.w * 0.25, cx + s.w / 2, s.y + s.h, rng);
  pen(ctx);
  // A hat and a scarf.
  blob(ctx, cx, s.y + s.w * 0.28, s.w * 0.62, s.w * 0.12, "#2f2b3a");
  blob(ctx, cx, s.y + s.w * 0.1, s.w * 0.36, s.w * 0.24, "#2f2b3a");
  box(
    ctx,
    { x: cx - pole * 1.6, y: s.y + s.w * 0.5, w: pole * 3.2, h: s.h * 0.32 },
    "#c9443c",
    rng,
  );
}

function drawFridge(ctx: Ctx, l: RoomLayout, rng: () => number) {
  const s = l.stand;
  const w = s.w * 1.3;
  const x = s.x + s.w / 2 - w / 2;
  const top = l.height * 0.38;
  const f = { x, y: top, w, h: l.floorTop - top };
  pen(ctx);
  box(ctx, f, FRIDGE, rng);
  line(ctx, f.x, f.y + f.h * 0.36, f.x + f.w, f.y + f.h * 0.36, rng);
  pen(ctx, INK * 1.2);
  line(ctx, f.x + f.w * 0.82, f.y + f.h * 0.12, f.x + f.w * 0.82, f.y + f.h * 0.26, rng);
  line(ctx, f.x + f.w * 0.82, f.y + f.h * 0.44, f.x + f.w * 0.82, f.y + f.h * 0.6, rng);
  pen(ctx);
  // A magnet note.
  box(
    ctx,
    { x: f.x + f.w * 0.2, y: f.y + f.h * 0.1, w: f.w * 0.36, h: f.w * 0.36 },
    "#fff27a",
    rng,
  );
}

function drawTable(ctx: Ctx, l: RoomLayout, rng: () => number) {
  const t = l.table;
  const top = 22;
  const leg = Math.max(10, t.w * 0.06);
  pen(ctx);
  box(ctx, { x: t.x + t.w * 0.08, y: t.y + top, w: leg, h: t.h - top }, WOOD_DARK, rng);
  box(ctx, { x: t.x + t.w * 0.92 - leg, y: t.y + top, w: leg, h: t.h - top }, WOOD_DARK, rng);
  box(ctx, { x: t.x, y: t.y, w: t.w, h: top }, WOOD, rng);
}

function drawMug(ctx: Ctx, l: RoomLayout, rng: () => number) {
  const m = l.mug;
  pen(ctx);
  // Handle first, so the body's outline covers its ends.
  ctx.beginPath();
  ctx.ellipse(m.x + m.w, m.y + m.h * 0.48, m.w * 0.3, m.h * 0.24, 0, -Math.PI / 2, Math.PI / 2);
  ctx.lineWidth = INK * 1.8;
  ctx.stroke();
  ctx.lineWidth = INK * 0.8;
  ctx.strokeStyle = MUG;
  ctx.stroke();
  pen(ctx);
  box(ctx, m, MUG, rng);
  blob(ctx, m.x + m.w / 2, m.y + 2, m.w / 2 - 2, m.h * 0.1, COFFEE);
  // A little red heart on the side.
  ctx.fillStyle = "#e0453a";
  ctx.beginPath();
  ctx.arc(m.x + m.w * 0.4, m.y + m.h * 0.5, m.w * 0.08, 0, Math.PI * 2);
  ctx.arc(m.x + m.w * 0.56, m.y + m.h * 0.5, m.w * 0.08, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlant(ctx: Ctx, l: RoomLayout, rng: () => number) {
  const p = l.plant;
  const potH = p.h * 0.36;
  const potTop = p.y + p.h - potH;
  pen(ctx);
  // Leaves: a fan of long blobs behind the pot.
  const cx = p.x + p.w / 2;
  const leaves = 7;
  for (let i = 0; i < leaves; i++) {
    const a = -Math.PI / 2 + (i / (leaves - 1) - 0.5) * 2.1;
    const len = p.h * (0.36 + 0.08 * Math.cos(i * 1.7));
    blob(
      ctx,
      cx + Math.cos(a) * len * 0.55,
      potTop + Math.sin(a) * len * 0.55,
      len * 0.5,
      p.w * 0.1,
      i % 2 === 0 ? LEAF : LEAF_LIGHT,
      a,
    );
  }
  wobblyPath(
    ctx,
    [
      p.x + p.w * 0.18,
      potTop,
      p.x + p.w * 0.82,
      potTop,
      p.x + p.w * 0.72,
      p.y + p.h,
      p.x + p.w * 0.28,
      p.y + p.h,
    ],
    true,
    rng,
  );
  ctx.fillStyle = POT;
  ctx.fill();
  ctx.stroke();
  box(
    ctx,
    { x: p.x + p.w * 0.12, y: potTop - potH * 0.08, w: p.w * 0.76, h: potH * 0.22 },
    "#b4552f",
    rng,
  );
}

/**
 * Paints `room` ("office" or "kitchen") for `layout` into a `width` x `height`
 * canvas, `k` device px per reference px. Null where there is no canvas.
 */
export function paintRoom(
  room: string,
  layout: RoomLayout,
  seed: number,
  width: number,
  height: number,
  k: number,
): OffscreenCanvas | null {
  return paintCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), (ctx) => {
    const rng = createRng((Math.round(seed) * 2654435761 + 0x5eed) >>> 0);
    ctx.scale(k, k);
    drawShell(ctx, layout, room, rng);
    drawDoor(ctx, layout, rng);
    if (room === "kitchen") {
      drawClock(ctx, layout);
      drawFridge(ctx, layout, rng);
    } else {
      drawPicture(ctx, layout, rng);
      drawHatStand(ctx, layout, rng);
    }
    drawTable(ctx, layout, rng);
    drawPlant(ctx, layout, rng);
    drawMug(ctx, layout, rng);
  });
}

/** The speech bubble's canvas and where it goes, device px (y down). */
interface BubbleArt {
  canvas: OffscreenCanvas | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Largest bubble lettering, ref px, and its share of the bubble's inner width. */
const BUBBLE_FONT = 52;
const BUBBLE_FILL = 0.8;

/**
 * Paints the speech bubble with `text` in the layout's bubble rect, with a tail
 * pointing down towards the middle, at `k` device px per reference px. The
 * lettering shrinks to fit the bubble.
 */
export function paintBubble(text: string, layout: RoomLayout, k: number): BubbleArt {
  const b = layout.bubble;
  const pad = INK * 2;
  const x0 = b.x - pad;
  const y0 = b.y - pad;
  const x1 = Math.max(b.x + b.w, layout.tailX) + pad;
  const y1 = Math.max(b.y + b.h, layout.tailY) + pad;
  const width = Math.max(1, Math.ceil((x1 - x0) * k));
  const height = Math.max(1, Math.ceil((y1 - y0) * k));
  const canvas = paintCanvas(width, height, (ctx) => {
    ctx.scale(k, k);
    ctx.translate(-x0, -y0);
    pen(ctx);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    // Tail, then the bubble over its root, then the tail's fill again to hide the seam.
    const tail = () => {
      ctx.beginPath();
      ctx.moveTo(cx + b.w * 0.12, cy + b.h * 0.3);
      ctx.quadraticCurveTo(cx + b.w * 0.3, cy + b.h * 0.55, layout.tailX, layout.tailY);
      ctx.quadraticCurveTo(cx + b.w * 0.26, cy + b.h * 0.42, cx + b.w * 0.28, cy + b.h * 0.2);
      ctx.closePath();
    };
    tail();
    ctx.fillStyle = BUBBLE;
    ctx.fill();
    ctx.stroke();
    blob(ctx, cx, cy, b.w / 2, b.h / 2, BUBBLE);
    tail();
    ctx.fill();

    ctx.font = comicFont(BUBBLE_FONT);
    // Undefined from the tests' stand-in context, whose methods return nothing.
    const metrics = ctx.measureText(text) as TextMetrics | undefined;
    const measured = metrics === undefined ? 0 : metrics.width;
    const fit = measured > 0 ? Math.min(1, (b.w * BUBBLE_FILL * 0.86) / measured) : 1;
    const px = Math.max(10, Math.floor(Math.min(BUBBLE_FONT, b.h * 0.42) * fit));
    ctx.font = comicFont(px);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = TEXT;
    ctx.fillText(text, cx, cy + px * 0.04);
  });
  return { canvas, x: x0 * k, y: y0 * k, width, height };
}
