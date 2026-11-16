/**
 * The frame overlay: the stream furniture round the speaker, laid out as one.
 *
 * - A border round the speaker area (the `border` slot), drawn behind the
 *   other overlays: a thin accent line with a soft glow and small corner
 *   brackets, in a Clean, Neon or Pixel style. It is drawn on the canvas once
 *   per resize or style change, and only four thin strips round its edge go
 *   to the screen, so the empty middle costs nothing. A style change dips it
 *   out and back in.
 * - A follower goal bar at the top left (`goal.ts`): a label, the count and
 *   target, and a bar whose fill eases. Its panel is redrawn only while
 *   something in it changes.
 * - At the top right, an uptime clock (`LIVE 1:24:07`, redrawn once a second)
 *   and below it a ticker naming the latest follower, which cross-fades to
 *   each new name and never scrolls. Each has its own switch, and fades in
 *   and out in place.
 *
 * The uptime counts from a time of day typed into `uptimeFrom` (the stream's
 * start, so it survives reloads), or from page load when that is empty or
 * not a time.
 */
import { approach, smoothstep } from "../math";
import type { AnyParamValues } from "../types";
import { type ClockTime, lastOccurrence, parseClockTime } from "./clock-time";
import { type FrameStyle, frameMeta, FRAME_STYLE_OPTIONS } from "./frame.meta";
import { createFollowSchedule, createGoal } from "./goal";
import type { OverlayCanvas, OverlayDefinition, OverlayDraw, OverlayView } from "./overlay-layer";
import type { Rect } from "./overlay-layout";
import {
  cssRgba,
  drawPanel,
  fillLine,
  fillTabular,
  measureTabular,
  overlayFont,
  PANEL_MUTED,
  PANEL_TEXT,
  usernameColour,
} from "./overlay-text";
import { makeUsername } from "./usernames";

type Ctx = OffscreenCanvasRenderingContext2D;

/** The made-up followers' seed, and the first follower's viewer number (clear of the chat's). */
const SEED = 0x90a1;
const FOLLOWER_BASE = 100_000;

/** Border sizes at 1080p: room kept for the glow, corner radius, bracket length and offset. */
const FRAME_PAD = 28;
const FRAME_RADIUS = 18;
const BRACKET = 26;
const BRACKET_OUT = 6;

/** Goal panel sizes at 1080p. */
const GOAL_W = 400;
const GOAL_H = 70;
const GOAL_PAD = 14;
const GOAL_FONT = 15;
const BAR_H = 12;

/** Clock and ticker pill sizes at 1080p. */
const PILL_H = 36;
const PILL_GAP = 8;
const PILL_PAD = 12;
const PILL_FONT = 15;
const TICKER_W = 340;
const DOT = 5;

/** The live dot's colour, as in the chat header. */
const LIVE_RED = "#ff5a6e";

/** Seconds a new follower's name takes to cross-fade in, and a switched part to fade. */
export const TICKER_FADE_SECONDS = 0.5;
const PART_FADE_SECONDS = 0.5;
/** Seconds the border takes to fade out (then in again) on a style change. */
const STYLE_DIP_SECONDS = 0.4;

const DAY_MS = 86_400_000;

/** Where the border is drawn within its slot. */
interface FrameGeometry {
  /** The centre of the border line. */
  readonly line: Rect;
  /** Thickness of the strips along the slot's edges that hold all of it. */
  readonly strip: number;
  readonly radius: number;
}

/**
 * The border's geometry in the `border` slot rect at `scale`: the line inset
 * far enough that its glow and brackets stay inside the slot, and the strips
 * along the slot's edges that hold everything drawn (the rest of the slot is
 * empty). Allocates: call it on resize.
 */
export function frameGeometry(border: Readonly<Rect>, scale: number): FrameGeometry {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const room = Math.min(border.w, border.h) / 2;
  const pad = Math.max(0, Math.min(Math.round(FRAME_PAD * s), Math.floor(room / 3)));
  const radius = Math.max(0, Math.min(FRAME_RADIUS * s, room / 3));
  const line = {
    x: border.x + pad,
    y: border.y + pad,
    w: Math.max(0, border.w - 2 * pad),
    h: Math.max(0, border.h - 2 * pad),
  };
  // The line, its glow either side, and the corner's curve.
  const strip = Math.min(Math.floor(room), Math.ceil(2 * pad + 0.3 * radius + 4 * s));
  return { line, strip, radius };
}

const styleOf = (v: unknown): FrameStyle =>
  FRAME_STYLE_OPTIONS.find((o) => o.value === v)?.value ?? "clean";

/**
 * The border's scale: by the frame's shorter side, so on a tall frame (where
 * the speaker area is narrow) it stays as fine as on a wide one.
 */
const frameScale = (view: OverlayView) =>
  Math.min(view.scale, Math.min(view.width, view.height) / 1080);

/** Draws the border in `style` round `geo`'s line, in `accent`. */
function drawFrame(ctx: Ctx, geo: FrameGeometry, style: FrameStyle, s: number, accent: string) {
  const { line: r, radius } = geo;
  if (style === "none" || r.w <= 0 || r.h <= 0) {
    return;
  }
  ctx.save();
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  if (style === "pixel") {
    // Chunky blocks on the pixel grid, the corners stepped, no glow.
    const b = Math.max(2, Math.round(4 * s));
    const x0 = Math.round(r.x);
    const y0 = Math.round(r.y);
    const x1 = Math.round(r.x + r.w) - b;
    const y1 = Math.round(r.y + r.h) - b;
    ctx.fillStyle = cssRgba(accent, 0.9);
    ctx.fillRect(x0 + 2 * b, y0, x1 - x0 - 3 * b, b);
    ctx.fillRect(x0 + 2 * b, y1, x1 - x0 - 3 * b, b);
    ctx.fillRect(x0, y0 + 2 * b, b, y1 - y0 - 3 * b);
    ctx.fillRect(x1, y0 + 2 * b, b, y1 - y0 - 3 * b);
    // The step at each corner, and a two-block bracket outside it.
    const o = 2 * b;
    for (const [cx, cy, dx, dy] of [
      [x0, y0, 1, 1],
      [x1, y0, -1, 1],
      [x0, y1, 1, -1],
      [x1, y1, -1, -1],
    ] as const) {
      ctx.fillStyle = cssRgba(accent, 0.9);
      ctx.fillRect(cx + dx * b, cy + dy * b, b, b);
      ctx.fillStyle = accent;
      const bx = cx - dx * o;
      const by = cy - dy * o;
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(bx + dx * i * b, by, b, b);
        ctx.fillRect(bx, by + dy * i * b, b, b);
      }
    }
    ctx.restore();
    return;
  }
  const neon = style === "neon";
  const width = Math.max(1, (neon ? 3 : 2) * s);
  const glow = (neon ? 16 : 10) * s;
  ctx.shadowColor = cssRgba(accent, neon ? 0.95 : 0.7);
  ctx.shadowBlur = glow;
  ctx.strokeStyle = cssRgba(accent, neon ? 1 : 0.85);
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
  ctx.stroke();
  if (neon) {
    // A pale core along the tube.
    ctx.shadowBlur = glow / 2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
    ctx.lineWidth = Math.max(1, width / 3);
    ctx.stroke();
  }
  // Corner brackets, just outside the line.
  const out = BRACKET_OUT * s;
  const len = Math.min(BRACKET * s, r.w / 3, r.h / 3);
  ctx.shadowBlur = glow * 0.6;
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, (neon ? 3 : 2.5) * s);
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [
    [r.x - out, r.y - out, 1, 1],
    [r.x + r.w + out, r.y - out, -1, 1],
    [r.x - out, r.y + r.h + out, 1, -1],
    [r.x + r.w + out, r.y + r.h + out, -1, -1],
  ] as const) {
    ctx.moveTo(cx, cy + dy * len);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * len, cy);
  }
  ctx.stroke();
  ctx.restore();
}

/** `seconds` as `H:MM:SS`. */
export function formatUptime(seconds: number): string {
  const t = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const sec = t % 60;
  const two = (n: number) => (n < 10 ? `0${String(n)}` : String(n));
  return `${String(h)}:${two(m)}:${two(sec)}`;
}

/** Whole seconds of uptime, from a typed start time or from page load. */
interface UptimeClock {
  /**
   * The uptime at `now` (ms since the epoch): since the last time `from` (a
   * clock time as typed) came round, so under a day, or since `pageLoad` when
   * `from` doesn't parse. Allocates only when `from` changes or the start
   * moves on a day.
   */
  read: (from: string, now: number) => number;
}

export function createUptimeClock(pageLoad: number): UptimeClock {
  let text: string | null = null;
  let time: ClockTime | null = null;
  let start = Number.NaN;
  return {
    read(from, now) {
      if (from !== text) {
        text = from;
        time = parseClockTime(from);
        start = Number.NaN;
      }
      if (time === null) {
        start = pageLoad;
      } else if (!(start <= now && now - start < DAY_MS)) {
        start = lastOccurrence(time, now);
      }
      return Math.max(0, Math.floor((now - start) / 1000));
    },
  };
}

/** A part's place on the canvas. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const box = (): Box => ({ x: 0, y: 0, w: 0, h: 0 });

const setBox = (b: Box, x: number, y: number, w: number, h: number) => {
  b.x = Math.round(x);
  b.y = Math.round(y);
  b.w = Math.max(0, Math.round(w));
  b.h = Math.max(0, Math.round(h));
};

/** A param's value as text or a finite number, or `fallback`. */
const text = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
const number = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** The four strips along the edges of slot rect `t`, `strip` thick, written to `out`. */
function stripsOf(t: Readonly<Rect>, strip: number, out: Box[]) {
  setBox(out[0], t.x, t.y, t.w, strip);
  setBox(out[1], t.x, t.y + t.h - strip, t.w, strip);
  setBox(out[2], t.x, t.y + strip, strip, t.h - 2 * strip);
  setBox(out[3], t.x + t.w - strip, t.y + strip, strip, t.h - 2 * strip);
}

/** Queues canvas rect `r` of `slot`, mapped from the slot's target to where it is shown. */
function queue(
  out: OverlayDraw,
  view: OverlayView,
  slot: "topLeft" | "topRight" | "border",
  r: Box,
  alpha: number,
  back = false,
) {
  const t = view.target(slot);
  if (r.w <= 0 || r.h <= 0 || t.w <= 0 || t.h <= 0) {
    return;
  }
  const s = view.shown(slot);
  const kx = s.w / t.w;
  const ky = s.h / t.h;
  out.panel(
    r.x,
    r.y,
    r.w,
    r.h,
    s.x + (r.x - t.x) * kx,
    s.y + (r.y - t.y) * ky,
    r.w * kx,
    r.h * ky,
    alpha,
    back,
  );
}

export const frameOverlay: OverlayDefinition = {
  meta: frameMeta,
  create() {
    const pageLoad = Date.now() - performance.now();
    const uptime = createUptimeClock(pageLoad);
    const goal = createGoal();
    const follows = createFollowSchedule(SEED);

    let seconds = 0;
    let label = "";
    /** The ticker's names: the one fading out and the one fading in. */
    let tickerFrom = "";
    let tickerTo = makeUsername(SEED, FOLLOWER_BASE);
    let tickerT = 1;
    /** Bumped with each new name. */
    let tickerVersion = 0;

    // The border's style: the one on the canvas, and the one asked for.
    let started = false;
    let style: FrameStyle = "clean";
    let wantStyle: FrameStyle = "clean";
    let styleValue: unknown = null;
    let frameAlpha = 1;
    let frameDirty = false;

    // Each top-right part's fade, for its switch.
    let uptimeAlpha = 1;
    let tickerAlpha = 1;

    // Where things are on the canvas, set when everything is drawn.
    let geo: FrameGeometry | null = null;
    let geoFor: Rect | null = null;
    let geoScale = 0;
    const strips = [box(), box(), box(), box()];
    const goalBox = box();
    const clockBox = box();
    const tickerBox = box();
    /** Scale of the goal panel, and of the top-right pills (smaller where their slot is). */
    let goalK = 1;
    let pillK = 1;
    let clockLeft = 0;

    // What was last drawn.
    let drawnSeconds = -1;
    let drawnVersion = -1;
    let drawnLabel: string | null = null;
    let drawnFill = -1;
    let drawnGlow = -1;
    let drawnTickerT = -1;
    let drawnTickerVersion = -1;

    /** Clears `area`, then draws `content` clipped to it. */
    const redraw = (canvas: OverlayCanvas, area: Box, content: (ctx: Ctx) => void) => {
      if (area.w <= 0 || area.h <= 0) {
        return;
      }
      const ctx = canvas.ctx;
      canvas.clear(area.x, area.y, area.w, area.h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.x, area.y, area.w, area.h);
      ctx.clip();
      content(ctx);
      ctx.restore();
    };

    /** Places the goal panel and the pills in their slots. Measures with `ctx`. */
    const layOut = (ctx: Ctx, view: OverlayView) => {
      const s = view.scale;
      const left = view.target("topLeft");
      goalK = Math.max(0, Math.min(s, left.w / GOAL_W, left.h / GOAL_H));
      setBox(goalBox, left.x, left.y, GOAL_W * goalK, GOAL_H * goalK);

      const right = view.target("topRight");
      pillK = Math.max(0, Math.min(s, right.w / TICKER_W, right.h / (2 * PILL_H + PILL_GAP)));
      const k = pillK;
      const pad = PILL_PAD * k;
      // Wide enough for any uptime under a day, so it never resizes.
      const live = measureTabular(ctx, "LIVE", overlayFont(PILL_FONT * k, 700));
      const digits = measureTabular(ctx, "00:00:00", overlayFont(PILL_FONT * k, 600));
      const clockW = Math.min(right.w, pad + 2 * DOT * k + 8 * k + live + 8 * k + digits + pad);
      setBox(clockBox, right.x + right.w - clockW, right.y, clockW, PILL_H * k);
      clockLeft = pad + 2 * DOT * k + 8 * k + live + 8 * k;
      const tickerW = Math.min(right.w, TICKER_W * k);
      setBox(
        tickerBox,
        right.x + right.w - tickerW,
        right.y + (PILL_H + PILL_GAP) * k,
        tickerW,
        PILL_H * k,
      );
    };

    const drawGoal = (ctx: Ctx, view: OverlayView) => {
      const k = goalK;
      const b = goalBox;
      drawPanel(ctx, b.x, b.y, b.w, b.h, k, view.opacity);
      const pad = GOAL_PAD * k;
      const font = overlayFont(GOAL_FONT * k, 600);
      const rowY = b.y + pad + 9 * k;
      const count = `${String(goal.count)} / ${String(goal.target)}`;
      const countW = measureTabular(ctx, count, font);
      fillTabular(ctx, count, b.x + b.w - pad, rowY, font, PANEL_TEXT, "right");
      fillLine(ctx, label, b.x + pad, rowY, font, PANEL_TEXT, b.w - 2 * pad - countW - 10 * k);
      // The bar: a faint track and the accent fill, glowing while a reached goal holds.
      const barW = b.w - 2 * pad;
      const barH = Math.max(2, BAR_H * k);
      const barY = b.y + b.h - pad - barH;
      ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
      ctx.beginPath();
      ctx.roundRect(b.x + pad, barY, barW, barH, barH / 2);
      ctx.fill();
      if (goal.fill > 0) {
        const w = Math.max(barH, goal.fill * barW);
        if (goal.glow > 0) {
          ctx.shadowColor = cssRgba(view.accent, 0.9 * goal.glow);
          ctx.shadowBlur = 10 * k * goal.glow;
        }
        ctx.fillStyle = view.accent;
        ctx.beginPath();
        ctx.roundRect(b.x + pad, barY, w, barH, barH / 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    };

    const drawClock = (ctx: Ctx, view: OverlayView) => {
      const k = pillK;
      const b = clockBox;
      drawPanel(ctx, b.x, b.y, b.w, b.h, k, view.opacity);
      const cy = b.y + b.h / 2;
      const pad = PILL_PAD * k;
      ctx.fillStyle = LIVE_RED;
      ctx.beginPath();
      ctx.arc(b.x + pad + DOT * k, cy, DOT * k, 0, Math.PI * 2);
      ctx.fill();
      fillTabular(
        ctx,
        "LIVE",
        b.x + pad + 2 * DOT * k + 8 * k,
        cy,
        overlayFont(PILL_FONT * k, 700),
        PANEL_TEXT,
      );
      fillTabular(
        ctx,
        formatUptime(seconds),
        b.x + clockLeft,
        cy,
        overlayFont(PILL_FONT * k, 600),
        PANEL_TEXT,
      );
    };

    /** One ticker line: the muted label, then the name in its colour. */
    const tickerLine = (ctx: Ctx, name: string, alpha: number) => {
      if (alpha <= 0 || name === "") {
        return;
      }
      const k = pillK;
      const b = tickerBox;
      const pad = PILL_PAD * k;
      const cy = b.y + b.h / 2;
      ctx.globalAlpha = alpha;
      const lead = fillLine(
        ctx,
        "Latest follower:",
        b.x + pad,
        cy,
        overlayFont(PILL_FONT * k),
        PANEL_MUTED,
        b.w - 2 * pad,
      );
      const x = b.x + pad + lead + 6 * k;
      fillLine(
        ctx,
        name,
        x,
        cy,
        overlayFont(PILL_FONT * k, 700),
        usernameColour(name),
        b.x + b.w - pad - x,
      );
      ctx.globalAlpha = 1;
    };

    const drawTicker = (ctx: Ctx, view: OverlayView) => {
      const b = tickerBox;
      drawPanel(ctx, b.x, b.y, b.w, b.h, pillK, view.opacity);
      const e = smoothstep(0, 1, tickerT);
      tickerLine(ctx, tickerFrom, 1 - e);
      tickerLine(ctx, tickerTo, e);
    };

    /**
     * Draws the border. With `partial` (a style change) it clears and draws
     * only the strips that hold it; otherwise the layer has cleared the slot.
     */
    const drawBorder = (canvas: OverlayCanvas, view: OverlayView, partial: boolean) => {
      if (geo === null) {
        return;
      }
      const t = view.target("border");
      const st = geo.strip;
      const ctx = canvas.ctx;
      ctx.save();
      ctx.beginPath();
      if (partial) {
        stripsOf(t, st, strips);
        for (const r of strips) {
          canvas.clear(r.x, r.y, r.w, r.h);
          ctx.rect(r.x, r.y, r.w, r.h);
        }
      } else {
        ctx.rect(t.x, t.y, t.w, t.h);
      }
      ctx.clip();
      drawFrame(ctx, geo, style, frameScale(view), view.accent);
      ctx.restore();
    };

    return {
      update(dt: number, values: Readonly<AnyParamValues>, view: OverlayView) {
        const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
        goal.configure(number(values.goalStart, 0.8), number(values.goalTarget, 100));
        const n = follows.step(step);
        if (n > 0) {
          goal.add(n);
          tickerFrom = tickerT < 0.5 ? tickerFrom : tickerTo;
          tickerTo = makeUsername(SEED, FOLLOWER_BASE + follows.follows);
          tickerT = 0;
          tickerVersion++;
        }
        goal.step(step);
        tickerT = Math.min(1, tickerT + step / TICKER_FADE_SECONDS);
        seconds = uptime.read(text(values.uptimeFrom, ""), Date.now());
        label = text(values.goalLabel, "");

        const wantUptime = values.uptime !== false;
        const wantTicker = values.ticker !== false;
        if (values.frameStyle !== styleValue) {
          styleValue = values.frameStyle;
          wantStyle = styleOf(styleValue);
        }
        if (!started) {
          started = true;
          style = wantStyle;
          uptimeAlpha = wantUptime ? 1 : 0;
          tickerAlpha = wantTicker ? 1 : 0;
        }
        const fade = step / PART_FADE_SECONDS;
        uptimeAlpha = approach(uptimeAlpha, wantUptime ? 1 : 0, fade);
        tickerAlpha = approach(tickerAlpha, wantTicker ? 1 : 0, fade);
        // A new style: fade the old one out, swap, fade the new one in.
        const dip = step / STYLE_DIP_SECONDS;
        if (wantStyle !== style) {
          // Nothing shows with no border, so there is nothing to fade out.
          frameAlpha = style === "none" ? 0 : approach(frameAlpha, 0, dip);
          if (frameAlpha <= 0) {
            style = wantStyle;
            frameDirty = true;
          }
        } else {
          frameAlpha = style === "none" ? 0 : approach(frameAlpha, 1, dip);
        }

        const border = view.target("border");
        if (border !== geoFor || view.scale !== geoScale) {
          geoFor = border;
          geoScale = view.scale;
          geo = frameGeometry(border, frameScale(view));
        }
      },
      draw2d(canvas, view, full) {
        const ctx = canvas.ctx;
        const fill = goal.fill;
        const glow = goal.glow;
        if (full) {
          layOut(ctx, view);
          drawBorder(canvas, view, false);
          drawGoal(ctx, view);
          drawClock(ctx, view);
          drawTicker(ctx, view);
        } else {
          if (frameDirty) {
            drawBorder(canvas, view, true);
          }
          if (
            goal.version !== drawnVersion ||
            label !== drawnLabel ||
            fill !== drawnFill ||
            glow !== drawnGlow
          ) {
            redraw(canvas, goalBox, (c) => {
              drawGoal(c, view);
            });
          }
          if (seconds !== drawnSeconds && uptimeAlpha > 0) {
            redraw(canvas, clockBox, (c) => {
              drawClock(c, view);
            });
          }
          if (
            (tickerT !== drawnTickerT || tickerVersion !== drawnTickerVersion) &&
            tickerAlpha > 0
          ) {
            redraw(canvas, tickerBox, (c) => {
              drawTicker(c, view);
            });
          }
        }
        frameDirty = false;
        drawnVersion = goal.version;
        drawnLabel = label;
        drawnFill = fill;
        drawnGlow = glow;
        // A hidden part is drawn afresh when it comes back.
        drawnSeconds = uptimeAlpha > 0 ? seconds : -1;
        drawnTickerT = tickerAlpha > 0 ? tickerT : -1;
        drawnTickerVersion = tickerVersion;
      },
      drawGl(out, view) {
        const fade = view.fade;
        if (geo !== null && style !== "none") {
          stripsOf(view.target("border"), geo.strip, strips);
          for (const r of strips) {
            queue(out, view, "border", r, fade * frameAlpha, true);
          }
        }
        queue(out, view, "topLeft", goalBox, fade);
        queue(out, view, "topRight", clockBox, fade * uptimeAlpha);
        queue(out, view, "topRight", tickerBox, fade * tickerAlpha);
      },
    };
  },
};
