import { SANS_FONT_STACK } from "../canvas-texture";
import { unitRgbMemo } from "../color";
import { beginFrame, createUniforms, withScope } from "../gl";
import { createLowResTarget } from "../lowres";
import { smoothstep } from "../math";
import { freeCentre, type Rect } from "../stream-overlay/overlay-layout";
import { createStreamOverlays } from "../stream-overlay/overlay-layer";
import { fillTabular } from "../stream-overlay/overlay-text";
import { createTextLayer, setTextPalette, TEXT_PALETTE_FLOATS, TEXT_ROLES } from "../text-layer";
import { defineEffect } from "../types";
import { type BindTarget, createBackdrops } from "./startingsoon-backdrops";
import { createCardLayout, layoutCard, titleLines, toCardId } from "./startingsoon-card";
import { createCountdown, formatCountdown, toTimerMode } from "./startingsoon-clock";
import { type BackdropId, type CardId, startingsoonMeta, TITLE_LINES } from "./startingsoon.meta";

/** Seconds a new card (or the card's move to a new free rect) cross-fades over. */
const CARD_FADE = 1;
/** Seconds the countdown's digits cross-fade over when what they count to changes. */
const DIGIT_FADE = 0.3;
/** Seconds a backdrop change cross-fades over. */
const BACKDROP_FADE = 1.2;
/** The loader: dots, their diameter and gap (1080p px), its gap from the subtitle, and its cycle (s). */
const LOADER_DOTS = 3;
const DOT_SIZE = 13;
const DOT_GAP = 10;
const LOADER_GAP = 18;
const LOADER_PERIOD = 1.8;
/** Room round each piece of text on the canvas for its shadow, 1080p px. */
const TEXT_PAD = 24;
/** Text colours, 0..1 sRGB: the title and countdown, and the subtitle. */
const TEXT_MAIN = [0.97, 0.96, 1] as const;
const TEXT_MUTED = [0.8, 0.78, 0.88] as const;
const BLACK = [0, 0, 0] as const;

const font = (weight: number, px: number) => `${String(weight)} ${String(px)}px ${SANS_FONT_STACK}`;

const toBackdrop = (value: string): BackdropId =>
  value === "rain" || value === "shapes" || value === "stars" ? value : "blobs";

const sameRect = (a: Readonly<Rect>, b: Readonly<Rect>) =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** One of the card's two copies on the canvas: the one shown, and the one fading in over it. */
interface Slot {
  readonly layout: ReturnType<typeof createCardLayout>;
  /** The free rect it was laid out for. */
  readonly free: Rect;
  card: CardId;
  title: string;
  subtitle: string;
  /** Top of its rows on the canvas. */
  top: number;
  /** The loader's left edge, from the card's left edge (px); NaN when it has none. */
  loaderX: number;
  /** The countdown's two regions: the text in each, which one is shown, and the fade to the other. */
  readonly count: [string, string];
  countShown: number;
  countMix: number;
  countFading: boolean;
  /** What the countdown counts to (see `countKey`), so a change cross-fades. */
  countKey: number;
}

const createSlot = (): Slot => ({
  layout: createCardLayout(),
  free: { x: 0, y: 0, w: 0, h: 0 },
  card: "starting",
  title: "",
  subtitle: "",
  top: 0,
  loaderX: Number.NaN,
  count: ["", ""],
  countShown: 0,
  countMix: 0,
  countFading: false,
  countKey: Number.NaN,
});

/**
 * A stream's holding screen: a centred card (Starting soon, Be right back or
 * Thanks for watching, or the owner's own title) with a subtitle, a slow dotted
 * loader and a countdown, over one of four calm backdrops. The stream overlays
 * draw on top; the card keeps to the free centre rect they leave.
 *
 * The card's text is drawn on a 2D canvas only when it changes (the countdown's
 * figures once a second, in their own rect) and copied to the screen texel for
 * texel. The canvas holds two copies of the card, so a new card, or the card's
 * move to a new free rect, cross-fades from one to the other; each copy has two
 * countdown regions, so the digits cross-fade when the timer changes.
 */
export const startingsoon = defineEffect(startingsoonMeta, {
  create(gl) {
    return withScope((scope) => {
      const backdrops = createBackdrops(gl, scope);
      const fadeTarget = scope.own(
        createLowResTarget(gl, {
          composite: /* glsl */ `
uniform float uFade;
vec4 composite(vec2 uv) { return texture(uLowRes, uv) * uFade; }
`,
          premultiplied: true,
          keep: true,
          dither: false,
        }),
      );
      const fu = createUniforms(gl, fadeTarget.program, ["uFade"]);
      const text = createTextLayer(gl, scope, 2 * (4 + LOADER_DOTS));
      const overlays = createStreamOverlays(gl, scope);
      const countdown = createCountdown(Date.now());
      const accentRgb = unitRgbMemo();
      const palette = new Float32Array(TEXT_PALETTE_FLOATS);
      const loaderRgb = [0, 0, 0];

      let width = 1;
      let height = 1;
      let scale = 1;
      const frameInfo = { width: 1, height: 1, scale: 1, accent: accentRgb("#000000") };

      // The canvas: two slots of rows (title, subtitle, two countdowns), then the loader dot.
      const maxLayout = createCardLayout();
      const maxFree: Rect = { x: 0, y: 0, w: 0, h: 0 };
      let pad = 1;
      let titleRow = 1;
      let subRow = 1;
      let countRow = 1;
      let slotRows = 1;
      let dotTop = 0;
      let dotSize = 1;

      const slots: [Slot, Slot] = [createSlot(), createSlot()];
      let shown = 0;
      let cardMix = 0;
      let cardFading = false;
      /** The whole card's opacity: it fades in once, when first laid out. */
      let appear = 0;
      let built = false;
      let frames = 0;
      let clock = 0;
      const free: Rect = { x: 0, y: 0, w: 0, h: 0 };

      // The countdown's text, rebuilt only when it changes.
      let content = "";
      let contentKey = Number.NaN;
      let contentSeconds = -1;
      let contentZero = "";

      // The backdrop and its cross-fade.
      let backdrop: BackdropId | null = null;
      let fromBackdrop: BackdropId = "blobs";
      let backdropT = 1;

      const bindCanvas: BindTarget = () => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
      };
      const bindFade: BindTarget = () => {
        fadeTarget.bind();
      };

      const shadow = (ctx: OffscreenCanvasRenderingContext2D, k: number) => {
        ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
        ctx.shadowBlur = Math.round(12 * k);
        ctx.shadowOffsetY = Math.round(3 * k);
      };
      const noShadow = (ctx: OffscreenCanvasRenderingContext2D) => {
        ctx.shadowColor = "rgba(0, 0, 0, 0)";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      };

      const drawTitle = (s: Slot) => {
        text.clear(0, s.top, text.width, titleRow);
        const ctx = text.ctx;
        if (!ctx) {
          return;
        }
        const l = s.layout;
        const lines = titleLines(s.card, s.title);
        shadow(ctx, l.k);
        for (let i = 0; i < lines.length; i++) {
          const y = s.top + pad + (TITLE_LINES - lines.length + i + 0.5) * l.titleLine;
          text.fill(
            lines[i],
            pad + l.card.w / 2,
            y,
            TEXT_ROLES.primary,
            font(800, l.titlePx),
            l.card.w,
            "center",
          );
        }
        noShadow(ctx);
      };

      const drawSubtitle = (s: Slot) => {
        const top = s.top + titleRow;
        text.clear(0, top, text.width, subRow);
        const ctx = text.ctx;
        const l = s.layout;
        const loader = s.card !== "ending";
        const dot = Math.round(DOT_SIZE * l.k);
        const loaderW = loader
          ? LOADER_DOTS * dot + (LOADER_DOTS - 1) * Math.round(DOT_GAP * l.k)
          : 0;
        const words = s.subtitle.trim();
        let textW = 0;
        const f = font(500, l.subtitlePx);
        if (ctx && words.length > 0) {
          ctx.font = f;
          // A canvas without text metrics (tests) measures nothing.
          const metrics = ctx.measureText(words) as TextMetrics | undefined;
          const measured = metrics?.width ?? 0;
          textW = Number.isFinite(measured) ? measured : 0;
        }
        const gap = loader && words.length > 0 ? Math.round(LOADER_GAP * l.k) : 0;
        const room = Math.max(0, l.card.w - loaderW - gap);
        textW = Math.min(textW, room);
        const left = pad + Math.round((l.card.w - (textW + gap + loaderW)) / 2);
        s.loaderX = loader ? left - pad + textW + gap : Number.NaN;
        if (ctx && words.length > 0) {
          shadow(ctx, l.k);
          text.fill(words, left, top + pad + l.subtitle.h / 2, TEXT_ROLES.muted, f, room, "left");
          noShadow(ctx);
        }
      };

      const drawCount = (s: Slot, region: number, value: string, zero: boolean) => {
        const top = s.top + titleRow + subRow + region * countRow;
        text.clear(0, top, text.width, countRow);
        s.count[region] = value;
        const ctx = text.ctx;
        if (!ctx || value.length === 0) {
          return;
        }
        const l = s.layout;
        const y = top + pad + l.countdown.h / 2;
        shadow(ctx, l.k);
        if (zero) {
          text.fill(
            value,
            pad + l.card.w / 2,
            y,
            TEXT_ROLES.primary,
            font(600, Math.round(0.42 * l.countPx)),
            l.card.w,
            "center",
          );
        } else {
          fillTabular(
            ctx,
            value,
            pad + l.card.w / 2,
            y,
            font(700, l.countPx),
            TEXT_ROLES.primary,
            "center",
          );
        }
        noShadow(ctx);
      };

      const build = (s: Slot, card: CardId, title: string, subtitle: string, zero: boolean) => {
        layoutCard(free, scale, s.layout);
        s.free.x = free.x;
        s.free.y = free.y;
        s.free.w = free.w;
        s.free.h = free.h;
        s.card = card;
        s.title = title;
        s.subtitle = subtitle;
        drawTitle(s);
        drawSubtitle(s);
        s.countShown = 0;
        s.countFading = false;
        s.countMix = 0;
        s.countKey = contentKey;
        drawCount(s, 0, content, zero);
        drawCount(s, 1, "", false);
      };

      /** Queues slot `s`'s regions at opacity `alpha`. */
      const emit = (s: Slot, alpha: number) => {
        if (!(alpha > 0)) {
          return;
        }
        const l = s.layout;
        const w = l.card.w + 2 * pad;
        const x = l.card.x - pad;
        text.quad(
          0,
          s.top,
          w,
          l.title.h + 2 * pad,
          x,
          l.title.y - pad,
          w,
          l.title.h + 2 * pad,
          alpha,
        );
        const subTop = s.top + titleRow;
        const subH = l.subtitle.h + 2 * pad;
        text.quad(0, subTop, w, subH, x, l.subtitle.y - pad, w, subH, alpha);
        const countH = l.countdown.h + 2 * pad;
        const mix = s.countFading ? smoothstep(0, 1, s.countMix) : 0;
        for (let r = 0; r < 2; r++) {
          const a = r === s.countShown ? 1 - mix : mix;
          if (s.count[r].length > 0) {
            const top = subTop + subRow + r * countRow;
            text.quad(0, top, w, countH, x, l.countdown.y - pad, w, countH, alpha * a);
          }
        }
        if (Number.isFinite(s.loaderX)) {
          const dot = Math.max(1, Math.round(DOT_SIZE * l.k));
          const step = dot + Math.round(DOT_GAP * l.k);
          const cy = l.subtitle.y + l.subtitle.h / 2;
          for (let i = 0; i < LOADER_DOTS; i++) {
            // Each dot brightens in turn, then all rest: one slow cycle.
            const phase = clock / LOADER_PERIOD - i * 0.2;
            const pulse = Math.max(0, Math.sin(Math.PI * (phase - Math.floor(phase)) * 1.6));
            const a = 0.35 + 0.65 * pulse * pulse;
            const dx = l.card.x + s.loaderX + i * step;
            text.quad(
              0,
              dotTop,
              dotSize,
              dotSize,
              dx,
              Math.round(cy - dot / 2),
              dot,
              dot,
              alpha * a,
            );
          }
        }
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          overlays.resize(v);
          freeCentre(overlays.layout, { left: false, right: false, top: false }, maxFree);
          layoutCard(maxFree, scale, maxLayout);
          pad = Math.ceil(TEXT_PAD * maxLayout.k);
          titleRow = maxLayout.title.h + 2 * pad;
          subRow = maxLayout.subtitle.h + 2 * pad;
          countRow = maxLayout.countdown.h + 2 * pad;
          slotRows = titleRow + subRow + 2 * countRow;
          slots[0].top = 0;
          slots[1].top = slotRows;
          dotTop = 2 * slotRows;
          dotSize = Math.max(2, Math.ceil(DOT_SIZE * maxLayout.k) + 2);
          text.resize(maxLayout.card.w + 2 * pad, dotTop + dotSize);
          const ctx = text.ctx;
          if (ctx) {
            text.clear(0, dotTop, dotSize, dotSize);
            // The loader's dot, in the accent's role.
            ctx.fillStyle = TEXT_ROLES.up;
            ctx.beginPath();
            ctx.arc(dotSize / 2, dotTop + dotSize / 2, dotSize / 2 - 1, 0, 2 * Math.PI);
            ctx.fill();
          }
          // The canvas starts clear: lay the card out again, without a fade.
          built = false;
          cardFading = false;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          clock += step;
          frames++;
          frameInfo.width = width;
          frameInfo.height = height;
          frameInfo.scale = scale;
          frameInfo.accent = accentRgb(p.accent);

          // 1. The backdrop, cross-fading from the last one.
          const want = toBackdrop(p.backdrop);
          if (backdrop === null) {
            backdrop = want;
          } else if (want !== backdrop) {
            if (backdropT < 1 && want === fromBackdrop) {
              // Going back mid-fade: run the fade backwards.
              fromBackdrop = backdrop;
              backdropT = 1 - backdropT;
            } else {
              // Fade from whichever of the two showed more.
              if (backdropT >= 0.5) {
                fromBackdrop = backdrop;
              }
              backdropT = 0;
            }
            backdrop = want;
          }
          backdrops.step(step, frameInfo);
          backdrops.draw(backdrop, bindCanvas, frameInfo);
          if (backdropT < 1) {
            backdropT = Math.min(1, backdropT + step / BACKDROP_FADE);
            fadeTarget.resize(width, height, 1);
            backdrops.draw(fromBackdrop, bindFade, frameInfo);
            bindCanvas();
            gl.useProgram(fadeTarget.program);
            fu.f1("uFade", 1 - smoothstep(0, 1, backdropT));
            fadeTarget.blit();
            if (backdropT >= 1) {
              fadeTarget.release();
            }
          }

          // 2. The card.
          const card = toCardId(p.card);
          const reading = countdown.read(toTimerMode(p.timer), p.countdown, p.endsAt, Date.now());
          const hidden = card === "ending" || reading.mode === "off";
          const zero = !hidden && reading.seconds === 0;
          const key = hidden ? -1 : 2 * reading.version + (zero ? 1 : 0);
          if (
            key !== contentKey ||
            (!zero && reading.seconds !== contentSeconds) ||
            (zero && p.zeroText !== contentZero)
          ) {
            contentKey = key;
            contentSeconds = reading.seconds;
            contentZero = p.zeroText;
            content = hidden ? "" : zero ? p.zeroText.trim() : formatCountdown(reading.seconds);
          }
          // The free rect needs a frame of the overlays' toggles: lay the card out from the second.
          if (frames > 1) {
            overlays.freeRect(free);
            const target = slots[cardFading ? 1 - shown : shown];
            if (!built) {
              build(slots[shown], card, p.title, p.subtitle, zero);
              built = true;
              cardFading = false;
            } else if (card !== target.card || !sameRect(free, target.free)) {
              // A new card, or room for it changed: draw it afresh and fade to it.
              build(slots[1 - shown], card, p.title, p.subtitle, zero);
              if (!cardFading) {
                cardFading = true;
                cardMix = 0;
              }
            } else {
              if (p.title !== target.title) {
                target.title = p.title;
                drawTitle(target);
              }
              if (p.subtitle !== target.subtitle) {
                target.subtitle = p.subtitle;
                drawSubtitle(target);
              }
              if (key !== target.countKey) {
                target.countKey = key;
                drawCount(target, 1 - target.countShown, content, zero);
                if (!target.countFading) {
                  target.countFading = true;
                  target.countMix = 0;
                }
              } else {
                const live = target.countFading ? 1 - target.countShown : target.countShown;
                if (target.count[live] !== content) {
                  drawCount(target, live, content, zero);
                }
              }
            }
            text.flush();
          }
          for (let i = 0; i < 2; i++) {
            const s = slots[i];
            if (s.countFading) {
              s.countMix = Math.min(1, s.countMix + step / DIGIT_FADE);
              if (s.countMix >= 1) {
                s.countShown = 1 - s.countShown;
                s.countFading = false;
                s.countMix = 0;
              }
            }
          }
          if (cardFading) {
            cardMix = Math.min(1, cardMix + step / CARD_FADE);
            if (cardMix >= 1) {
              shown = 1 - shown;
              cardFading = false;
              cardMix = 0;
            }
          }
          if (built) {
            appear = Math.min(1, appear + step / CARD_FADE);
            const fade = smoothstep(0, 1, appear);
            const mix = cardFading ? smoothstep(0, 1, cardMix) : 0;
            emit(slots[shown], fade * (1 - mix));
            if (cardFading) {
              emit(slots[1 - shown], fade * mix);
            }
            const accent = frameInfo.accent;
            // The loader: the accent, lifted towards white so it reads on a backdrop of the same hue.
            for (let c = 0; c < 3; c++) {
              loaderRgb[c] = 0.45 * accent[c] + 0.55;
            }
            setTextPalette(palette, TEXT_MAIN, TEXT_MUTED, loaderRgb, BLACK, BLACK);
            bindCanvas();
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            text.draw(width, height, palette);
            gl.disable(gl.BLEND);
          }

          // 3. The stream overlays, last.
          overlays.frame(dt, p);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
