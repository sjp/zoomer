/**
 * The alert overlay: when the stream's made-up events bring a follow, a sub, a
 * gift or a host, a banner drops in at the top centre ("mossy_kettle just
 * followed!") with a little confetti, holds for a few seconds while a soft
 * sheen crosses it, then lifts away (`alert-schedule.ts`).
 *
 * Each banner is drawn on the layer's canvas once, when its alert starts: an
 * icon of our own (a heart, a star, a gift box, a house) and two lines of
 * text. Everything that moves is GPU work: the banner is one panel quad,
 * offset and faded each frame; the sheen and the confetti are sprites from
 * the shared atlas, painted once, the confetti behind the panels.
 *
 * Switched off mid-alert, the banner goes as it normally would, only a little
 * quicker, so it is gone before the layer's fade ends.
 */
import { smoothstep } from "../math";
import type { AnyParamValues } from "../types";
import {
  alertCopy,
  type AlertPose,
  alertShows,
  CONFETTI_KINDS,
  confettiCount,
  type ConfettiPiece,
  confettiPiece,
  createAlertRunner,
  parseAlertLines,
  SHEEN_PEAK,
  sheenSeconds,
} from "./alert-schedule";
import { ALERT_STYLE_OPTIONS, type AlertStyle, alertsMeta } from "./alerts.meta";
import type { OverlayCanvas, OverlayDefinition, OverlayView } from "./overlay-layer";
import type { OverlayLayout } from "./overlay-layout";
import { cssRgba, drawPanel, fillLine, overlayFont, PANEL_MUTED, PANEL_TEXT } from "./overlay-text";
import { eventKinds, type StreamEventKind, type StreamEventKinds } from "./stream-events";

type Ctx = OffscreenCanvasRenderingContext2D;

/** The alerts' seed, for which alerts use the viewer's own lines and how their confetti falls. */
const SEED = 0xa1e2;

/** Banner sizes at 1080p. */
const BANNER_H = 76;
const BANNER_MIN_W = 300;
const BANNER_PAD = 16;
const ICON = 44;
const ICON_GAP = 14;
const TITLE_FONT = 13;
const LINE_FONT = 20;

/** Colours for each kind's icon, bright on the dark panel and no brand's. */
const KIND_COLOURS: Readonly<Record<StreamEventKind, string>> = {
  follow: "#ff7aa8",
  sub: "#ffd166",
  gift: "#5ee0c1",
  host: "#7ab8ff",
};

/** Confetti colours: soft and festive. The first three are strips, the rest dots. */
const CONFETTI_COLOURS = ["#ff9ec7", "#ffd27a", "#8fe3cf", "#a9c7ff", "#c9a7ff", "#ffb38a"];

/** The sheen's tilt, in radians, and its width as a share of the banner's height. */
const SHEEN_TILT = 0.3;
const SHEEN_WIDTH = 0.45;

const text = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);

const styleOf = (v: unknown): AlertStyle =>
  ALERT_STYLE_OPTIONS.find((o) => o.value === v)?.value ?? "banner";

/** The width of `words` in the context's font, or 0 where it gives no metrics. */
function width(ctx: Ctx, words: string): number {
  return (ctx.measureText(words) as TextMetrics | undefined)?.width ?? 0;
}

/**
 * Paints sprite `index` in a `size` square: confetti strips (0-2), dots (3-5),
 * then the sheen, a soft white band that fades to nothing at every edge.
 */
function paintSprite(ctx: Ctx, index: number, size: number) {
  if (index < CONFETTI_KINDS) {
    ctx.fillStyle = CONFETTI_COLOURS[index];
    if (index < 3) {
      ctx.beginPath();
      ctx.roundRect(size * 0.18, size * 0.32, size * 0.64, size * 0.36, size * 0.05);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  // A grid of soft cells: painted once, so 1,024 small fills cost nothing that matters.
  const n = 32;
  const cell = size / n;
  for (let i = 0; i < n; i++) {
    const across = Math.sin((Math.PI * (i + 0.5)) / n) ** 2;
    for (let j = 0; j < n; j++) {
      const v = (j + 0.5) / n;
      const down = smoothstep(0, 0.25, v) * (1 - smoothstep(0.75, 1, v));
      ctx.fillStyle = `rgba(255, 255, 255, ${(across * down).toFixed(3)})`;
      ctx.fillRect(i * cell, j * cell, cell, cell);
    }
  }
}

/** Draws `kind`'s icon in a `r`-radius circle centred on (`cx`, `cy`); `pixel` keeps it square. */
function drawIcon(
  ctx: Ctx,
  kind: StreamEventKind,
  cx: number,
  cy: number,
  r: number,
  pixel: boolean,
) {
  const colour = KIND_COLOURS[kind];
  ctx.save();
  ctx.fillStyle = cssRgba(colour, 0.2);
  ctx.beginPath();
  if (pixel) {
    ctx.rect(cx - r, cy - r, 2 * r, 2 * r);
  } else {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.strokeStyle = colour;
  const u = r * 0.5;
  ctx.beginPath();
  if (kind === "follow") {
    // A heart.
    ctx.moveTo(cx, cy + u * 0.95);
    ctx.bezierCurveTo(cx - u * 1.5, cy - u * 0.1, cx - u * 0.8, cy - u * 1.25, cx, cy - u * 0.45);
    ctx.bezierCurveTo(cx + u * 0.8, cy - u * 1.25, cx + u * 1.5, cy - u * 0.1, cx, cy + u * 0.95);
    ctx.fill();
  } else if (kind === "sub") {
    // A five-pointed star.
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? u * 1.1 : u * 0.48;
      ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  } else if (kind === "gift") {
    // A box with a ribbon and a bow.
    ctx.rect(cx - u * 0.9, cy - u * 0.25, u * 1.8, u * 1.1);
    ctx.rect(cx - u, cy - u * 0.6, u * 2, u * 0.35);
    ctx.fill();
    ctx.fillStyle = cssRgba("#0e0b1a", 0.55);
    ctx.fillRect(cx - u * 0.12, cy - u * 0.6, u * 0.24, u * 1.45);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.ellipse(cx - u * 0.35, cy - u * 0.8, u * 0.32, u * 0.18, -0.5, 0, Math.PI * 2);
    ctx.ellipse(cx + u * 0.35, cy - u * 0.8, u * 0.32, u * 0.18, 0.5, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // A little house.
    ctx.moveTo(cx, cy - u);
    ctx.lineTo(cx + u, cy - u * 0.1);
    ctx.lineTo(cx + u * 0.7, cy - u * 0.1);
    ctx.lineTo(cx + u * 0.7, cy + u * 0.85);
    ctx.lineTo(cx - u * 0.7, cy + u * 0.85);
    ctx.lineTo(cx - u * 0.7, cy - u * 0.1);
    ctx.lineTo(cx - u, cy - u * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = cssRgba("#0e0b1a", 0.55);
    ctx.fillRect(cx - u * 0.2, cy + u * 0.25, u * 0.4, u * 0.6);
  }
  ctx.restore();
}

/** Draws the pixel style's panel: square, with a chunky accent border. */
function drawPixelPanel(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  k: number,
  opacity: number,
  accent: string,
) {
  const b = Math.max(2, Math.round(4 * k));
  ctx.fillStyle = `rgba(14, 11, 26, ${String(Math.min(1, Math.max(0, opacity)))})`;
  ctx.fillRect(x + b, y + b, w - 2 * b, h - 2 * b);
  ctx.fillStyle = accent;
  // The border, its corners left out for a stepped look.
  ctx.fillRect(x + b, y, w - 2 * b, b);
  ctx.fillRect(x + b, y + h - b, w - 2 * b, b);
  ctx.fillRect(x, y + b, b, h - 2 * b);
  ctx.fillRect(x + w - b, y + b, b, h - 2 * b);
}

/** Where the banner is on the canvas, at rest. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const alertsOverlay: OverlayDefinition = {
  meta: alertsMeta,
  create({ events, reserveSprites }) {
    const firstCell = reserveSprites(CONFETTI_KINDS + 1, paintSprite);
    const sheenCell = firstCell + CONFETTI_KINDS;
    const runner = createAlertRunner();

    let ownText: string | null = null;
    let own: string[] = [];
    let style: AlertStyle = "banner";
    let kinds: StreamEventKinds = "all";

    /** The alert drawn on the canvas (its runner version), and where. */
    let drawnVersion = -1;
    const banner: Box = { x: 0, y: 0, w: 0, h: 0 };
    let bannerK = 1;
    let sheenFor = 1;

    let areaLayout: OverlayLayout | null = null;
    /** Where the confetti may go: the frame and the speaker's area, updated on a resize. */
    const area = { width: 1, height: 1, scale: 1, left: 0, right: 0, top: 0 };
    const pose: AlertPose = { alpha: 0, dy: 0, sheen: -1, time: 0 };
    const piece: ConfettiPiece = { x: 0, y: 0, half: 0, angle: 0, flip: 1, alpha: 0, kind: 0 };

    /** Lays out and draws the current alert's banner in the slot (which is clear). */
    const drawBanner = (ctx: Ctx, view: OverlayView) => {
      const current = runner.current;
      banner.w = 0;
      if (current === null) {
        return;
      }
      const slot = view.target("topCentre");
      const k = Math.max(0, Math.min(view.scale, slot.h / BANNER_H, slot.w / BANNER_MIN_W));
      bannerK = k;
      const copy = alertCopy(SEED, current.event, own);
      const pixel = current.style === "pixel";
      const pad = BANNER_PAD * k;
      const icon = ICON * k;
      const titleFont = overlayFont(TITLE_FONT * k, 700);
      const lineFont = overlayFont(LINE_FONT * k, 700);
      const title = copy.title.toUpperCase();
      ctx.font = titleFont;
      const titleW = width(ctx, title);
      ctx.font = lineFont;
      const lineW = width(ctx, copy.line);
      const want = pad + icon + ICON_GAP * k + Math.max(titleW, lineW) + pad;
      const w = Math.round(Math.min(slot.w, Math.max(BANNER_MIN_W * k, want)));
      const h = Math.round(BANNER_H * k);
      banner.x = Math.round(slot.x + (slot.w - w) / 2);
      banner.y = slot.y;
      banner.w = w;
      banner.h = h;
      sheenFor = sheenSeconds(w / Math.max(k, 1e-6));
      if (w <= 0 || h <= 0) {
        return;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(banner.x, banner.y, w, h);
      ctx.clip();
      if (pixel) {
        drawPixelPanel(ctx, banner.x, banner.y, w, h, k, view.opacity, view.accent);
      } else {
        drawPanel(
          ctx,
          banner.x,
          banner.y,
          w,
          h,
          k,
          view.opacity,
          current.style === "minimal" ? null : view.accent,
        );
      }
      const cy = banner.y + h / 2 + (pixel ? 0 : 1.5 * k);
      drawIcon(ctx, current.event.kind, banner.x + pad + icon / 2, cy, icon / 2, pixel);
      const left = banner.x + pad + icon + ICON_GAP * k;
      const room = banner.x + w - pad - left;
      fillLine(ctx, title, left, cy - 12 * k, titleFont, PANEL_MUTED, room);
      fillLine(ctx, copy.line, left, cy + 10 * k, lineFont, PANEL_TEXT, room);
      ctx.restore();
    };

    return {
      update(dt: number, values: Readonly<AnyParamValues>, view: OverlayView) {
        const lines = text(values.alertText, "");
        if (lines !== ownText) {
          ownText = lines;
          own = parseAlertLines(lines);
        }
        style = styleOf(values.alertStyle);
        kinds = eventKinds(values.alertKinds);
        if (view.on) {
          for (const e of events.fresh) {
            if (alertShows(e.kind, kinds)) {
              runner.offer(e, style);
            }
          }
        } else {
          runner.stop();
        }
        runner.step(dt);
        if (view.layout !== areaLayout) {
          areaLayout = view.layout;
          const sp = view.layout.speaker;
          area.width = view.width;
          area.height = view.height;
          area.scale = view.scale;
          area.left = sp.x;
          area.right = sp.x + sp.w;
          area.top = sp.y;
        }
      },
      draw2d(canvas: OverlayCanvas, view, full) {
        if (!full && runner.version === drawnVersion) {
          return;
        }
        drawnVersion = runner.version;
        if (!full) {
          const t = view.target("topCentre");
          canvas.clear(t.x, t.y, t.w, t.h);
        }
        drawBanner(canvas.ctx, view);
      },
      drawGl(out, view) {
        const current = runner.current;
        if (current === null || banner.w <= 0 || drawnVersion !== runner.version) {
          return;
        }
        runner.pose(sheenFor, pose);
        if (!(pose.alpha > 0)) {
          return;
        }
        // Where the slot is shown (it moves only on a resize), and the banner's offset.
        const t = view.target("topCentre");
        const s = view.shown("topCentre");
        const ox = s.x - t.x;
        const oy = s.y - t.y + pose.dy * bannerK;
        const b = banner;
        out.panel(b.x, b.y, b.w, b.h, b.x + ox, b.y + oy, b.w, b.h, pose.alpha);
        if (pose.sheen >= 0) {
          const glint = SHEEN_PEAK * Math.sin(Math.PI * pose.sheen) * pose.alpha;
          out.sprite(
            sheenCell,
            b.x + ox + pose.sheen * b.w,
            b.y + oy + b.h / 2,
            b.h / 2,
            SHEEN_TILT,
            glint,
            false,
            SHEEN_WIDTH,
          );
        }
        if (current.style === "minimal") {
          return;
        }
        const pixel = current.style === "pixel";
        const index = current.event.index;
        const n = confettiCount(SEED, index);
        // The burst comes from behind the banner at rest, whatever its slide.
        const cx = b.x + ox + b.w / 2;
        const cy = b.y + s.y - t.y + b.h / 2;
        for (let i = 0; i < n; i++) {
          confettiPiece(SEED, index, i, pose.time, cx, cy, b.w, area, pixel, piece);
          const alpha = piece.alpha * pose.alpha;
          if (alpha > 0) {
            const cell = firstCell + (pixel ? piece.kind % 3 : piece.kind);
            out.sprite(cell, piece.x, piece.y, piece.half, piece.angle, alpha, true, piece.flip);
          }
        }
      },
    };
  },
};
