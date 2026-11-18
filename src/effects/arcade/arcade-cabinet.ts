/**
 * The Cabinet framing: the upper part of an arcade cabinet in a dim arcade,
 * painted once per size and title on a 2D canvas. The marquee is lit, with
 * the title in chunky dot-matrix blocks; the bezel round the screen carries
 * abstract stars and stripes; the control panel runs along the bottom; two
 * other cabinets glow out of focus in the outer thirds. The screen's rect is
 * left transparent for the CRT pass to fill.
 *
 * Design units are frame heights at 16:9, from the frame's top centre, y down.
 */
import { ARCADE_PALETTE, CYCLE, layoutLogo } from "./arcade-art";

/** Half widths and edges of the cabinet's parts, design units. */
const BODY_HALF = 0.42;
const PANEL_HALF = 0.47;
const MARQUEE = { top: 0.035, bottom: 0.165, half: 0.37 } as const;
const BEZEL = { top: 0.19, bottom: 0.69, half: 0.38 } as const;
const SCREEN = { top: 0.215, bottom: 0.665, half: 0.285 } as const;
const PANEL_TOP = 0.735;

interface CabinetLayout {
  /** Px per design unit. */
  unit: number;
  /** The cabinet's centre line and top, px. */
  cx: number;
  top: number;
  /** The screen's rect, whole px, y down. */
  screenX: number;
  screenY: number;
  screenW: number;
  screenH: number;
}

/**
 * Where the cabinet sits in a `width` x `height` frame: full height at 16:9
 * and wider; narrower frames show it smaller (its panel's full width within
 * 92% of the frame), a little above the middle.
 */
export function cabinetLayout(width: number, height: number): CabinetLayout {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const k = Math.min(1, (w * 0.92) / (2 * PANEL_HALF * h));
  const unit = k * h;
  const top = (1 - k) * h * 0.3;
  const cx = w / 2;
  const x0 = Math.round(cx - SCREEN.half * unit);
  const y0 = Math.round(top + SCREEN.top * unit);
  return {
    unit,
    cx,
    top,
    screenX: x0,
    screenY: y0,
    screenW: Math.max(1, Math.round(cx + SCREEN.half * unit) - x0),
    screenH: Math.max(1, Math.round(top + SCREEN.bottom * unit) - y0),
  };
}

type Ctx = OffscreenCanvasRenderingContext2D;

/** Draws `shape`'s fill blurred by `blur` px, as a shadow cast from off the canvas. */
function soft(ctx: Ctx, colour: string, blur: number, shape: () => void): void {
  const away = 100000;
  ctx.save();
  ctx.shadowColor = colour;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = away;
  ctx.translate(-away, 0);
  ctx.fillStyle = "#000";
  ctx.beginPath();
  shape();
  ctx.fill();
  ctx.restore();
}

function linear(
  ctx: Ctx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  stops: readonly string[],
) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1) as CanvasGradient | undefined;
  if (!g) {
    return stops[0];
  }
  stops.forEach((c, i) => {
    g.addColorStop(i / Math.max(1, stops.length - 1), c);
  });
  return g;
}

function radial(ctx: Ctx, x: number, y: number, r: number, inner: string, outer: string) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r) as CanvasGradient | undefined;
  if (!g) {
    return inner;
  }
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  return g;
}

/** The arcade round the cabinet: wall, floor, and two cabinets glowing out of focus. */
function paintRoom(ctx: Ctx, w: number, h: number, l: CabinetLayout): void {
  ctx.fillStyle = linear(ctx, 0, 0, 0, h, ["#07060f", "#100c22", "#0c0918"]);
  ctx.fillRect(0, 0, w, h);
  const floor = l.top + 0.97 * l.unit;
  ctx.fillStyle = linear(ctx, 0, floor, 0, h, ["#120d1c", "#07050c"]);
  ctx.fillRect(0, floor, w, h - floor);
  const u = l.unit;
  const glows = [
    { dx: -0.74, screen: "rgba(70,150,255,0.55)", marquee: "rgba(255,170,90,0.45)" },
    { dx: 0.76, screen: "rgba(255,80,190,0.5)", marquee: "rgba(120,255,200,0.4)" },
  ];
  for (const g of glows) {
    const x = l.cx + g.dx * u;
    const half = 0.25 * u;
    if (x + half * 2 < 0 || x - half * 2 > w) {
      continue;
    }
    // The cabinet's dark bulk, then its screen and marquee as blurred light.
    soft(ctx, "rgba(2,2,6,0.9)", 0.06 * u, () => {
      ctx.rect(x - half, l.top + 0.08 * u, 2 * half, 1.2 * u);
    });
    soft(ctx, g.screen, 0.12 * u, () => {
      ctx.rect(x - 0.16 * u, l.top + 0.26 * u, 0.32 * u, 0.3 * u);
    });
    soft(ctx, g.marquee, 0.08 * u, () => {
      ctx.rect(x - 0.2 * u, l.top + 0.1 * u, 0.4 * u, 0.07 * u);
    });
    ctx.fillStyle = radial(
      ctx,
      x,
      l.top + 0.9 * u,
      0.5 * u,
      g.screen.replace(/[\d.]+\)$/, "0.12)"),
      "rgba(0,0,0,0)",
    );
    ctx.fillRect(x - 0.6 * u, l.top + 0.4 * u, 1.2 * u, u);
  }
}

/** A sparkle star: four long points and four short ones. */
function star(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.28;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.fill();
}

/** The bezel's art beside the screen: slanted stripes and a few stars. */
function paintBezelArt(ctx: Ctx, l: CabinetLayout, side: number): void {
  const u = l.unit;
  const x0 = l.cx + side * SCREEN.half * u;
  const x1 = l.cx + side * BEZEL.half * u;
  const y0 = l.top + BEZEL.top * u;
  const y1 = l.top + BEZEL.bottom * u;
  ctx.save();
  ctx.beginPath();
  ctx.rect(Math.min(x0, x1), y0, Math.abs(x1 - x0), y1 - y0);
  ctx.clip();
  const stripes = ["#ff5a5a", "#ffb03c", "#ffe066", "#4aa8ff"];
  const band = 0.022 * u;
  stripes.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    const yy = y1 - 0.05 * u - i * band * 1.35;
    ctx.moveTo(x0 - side * 0.02 * u, yy);
    ctx.lineTo(x1 + side * 0.02 * u, yy - 0.16 * u);
    ctx.lineTo(x1 + side * 0.02 * u, yy - 0.16 * u - band);
    ctx.lineTo(x0 - side * 0.02 * u, yy - band);
    ctx.closePath();
    ctx.fill();
  });
  const stars: [number, number, number, string][] = [
    [0.45, 0.12, 0.022, "#ffffff"],
    [0.7, 0.3, 0.014, "#9fd0ff"],
    [0.35, 0.45, 0.012, "#ffe066"],
    [0.6, 0.6, 0.018, "#ffffff"],
  ];
  for (const [fx, fy, r, c] of stars) {
    ctx.fillStyle = c;
    star(ctx, x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy, r * u);
  }
  ctx.restore();
}

/** The marquee: a backlit panel with the title in blocks, each column a colour along the palette. */
function paintMarquee(ctx: Ctx, l: CabinetLayout, title: string): void {
  const u = l.unit;
  const x = l.cx - MARQUEE.half * u;
  const y = l.top + MARQUEE.top * u;
  const mw = 2 * MARQUEE.half * u;
  const mh = (MARQUEE.bottom - MARQUEE.top) * u;
  soft(ctx, "rgba(150,120,255,0.55)", 0.05 * u, () => {
    ctx.rect(x, y, mw, mh);
  });
  ctx.fillStyle = linear(ctx, 0, y, 0, y + mh, ["#2a1a6a", "#151040", "#2a1a6a"]);
  ctx.fillRect(x, y, mw, mh);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(x, y + mh * 0.08, mw, mh * 0.18);
  const logo = layoutLogo(title, mw * 0.86, mh * 0.66, 64);
  const s = logo.size;
  const lx = l.cx - (logo.cols * s) / 2;
  const ly = y + (mh - logo.rows * s) / 2;
  const colour = (col: number) =>
    ARCADE_PALETTE[CYCLE[Math.floor((col / Math.max(1, logo.cols)) * CYCLE.length) % CYCLE.length]];
  ctx.save();
  ctx.shadowColor = "rgba(255,255,255,0.6)";
  ctx.shadowBlur = s * 1.5;
  for (let i = 0; i < logo.count; i++) {
    const col = logo.dots[i * 2];
    const row = logo.dots[i * 2 + 1];
    ctx.fillStyle = colour(col);
    ctx.fillRect(lx + col * s, ly + row * s, s * 0.92, s * 0.92);
  }
  ctx.restore();
  // The frame round it.
  ctx.strokeStyle = "#0a0a12";
  ctx.lineWidth = 0.008 * u;
  ctx.strokeRect(x, y, mw, mh);
}

/**
 * Paints the arcade and the cabinet for a `width` x `height` frame, leaving
 * the screen's rect transparent.
 */
export function paintCabinet(ctx: Ctx, width: number, height: number, title: string): void {
  const l = cabinetLayout(width, height);
  const u = l.unit;
  const cx = l.cx;
  const t = l.top;
  paintRoom(ctx, width, height, l);
  // The body: dark laminate sides, lit faintly from the front.
  ctx.fillStyle = linear(ctx, cx - BODY_HALF * u, 0, cx + BODY_HALF * u, 0, [
    "#0d0d14",
    "#1b1a26",
    "#1b1a26",
    "#0d0d14",
  ]);
  ctx.fillRect(cx - BODY_HALF * u, t - 0.05 * u, 2 * BODY_HALF * u, height);
  // Side trim, a pale stripe down each edge.
  ctx.fillStyle = "#2d2b3d";
  ctx.fillRect(cx - BODY_HALF * u, t - 0.05 * u, 0.012 * u, height);
  ctx.fillRect(cx + BODY_HALF * u - 0.012 * u, t - 0.05 * u, 0.012 * u, height);
  paintMarquee(ctx, l, title);
  // The bezel: black glass round the screen, with its art either side.
  const by = t + BEZEL.top * u;
  const bh = (BEZEL.bottom - BEZEL.top) * u;
  ctx.fillStyle = "#050508";
  ctx.fillRect(cx - BEZEL.half * u, by, 2 * BEZEL.half * u, bh);
  paintBezelArt(ctx, l, -1);
  paintBezelArt(ctx, l, 1);
  // The screen's own glow on the bezel's glass.
  soft(ctx, "rgba(120,150,255,0.18)", 0.03 * u, () => {
    ctx.rect(l.screenX, l.screenY, l.screenW, l.screenH);
  });
  // The ledge under the bezel, then the control panel, sloping towards the player.
  ctx.fillStyle = "#24222f";
  ctx.fillRect(cx - BODY_HALF * u, t + BEZEL.bottom * u, 2 * BODY_HALF * u, 0.02 * u);
  const py = t + PANEL_TOP * u;
  ctx.fillStyle = linear(ctx, 0, py, 0, py + 0.3 * u, ["#2b2840", "#191726"]);
  ctx.beginPath();
  ctx.moveTo(cx - BODY_HALF * u, py);
  ctx.lineTo(cx + BODY_HALF * u, py);
  ctx.lineTo(cx + PANEL_HALF * u, py + 0.27 * u);
  ctx.lineTo(cx - PANEL_HALF * u, py + 0.27 * u);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#3a3653";
  ctx.fillRect(cx - BODY_HALF * u, py, 2 * BODY_HALF * u, 0.008 * u);
  // A joystick on the left, three buttons on the right: in the outer parts, clear of the speaker.
  const ky = py + 0.12 * u;
  ctx.fillStyle = "#0b0a10";
  ctx.beginPath();
  ctx.ellipse(cx - 0.3 * u, ky + 0.03 * u, 0.04 * u, 0.015 * u, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#777";
  ctx.fillRect(cx - 0.305 * u, ky - 0.04 * u, 0.01 * u, 0.07 * u);
  ctx.fillStyle = radial(ctx, cx - 0.31 * u, ky - 0.055 * u, 0.03 * u, "#ff8a8a", "#c42a2a");
  ctx.beginPath();
  ctx.arc(cx - 0.3 * u, ky - 0.045 * u, 0.026 * u, 0, Math.PI * 2);
  ctx.fill();
  const buttons = ["#ffd84a", "#4aa8ff", "#6ce05c"];
  buttons.forEach((c, i) => {
    const bx = cx + (0.18 + i * 0.075) * u;
    const byy = ky + (i === 1 ? -0.01 : 0.01) * u;
    ctx.fillStyle = "#0b0a10";
    ctx.beginPath();
    ctx.ellipse(bx, byy + 0.008 * u, 0.026 * u, 0.017 * u, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.ellipse(bx, byy, 0.022 * u, 0.014 * u, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.clearRect(l.screenX, l.screenY, l.screenW, l.screenH);
}
