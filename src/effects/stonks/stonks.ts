import { type CanvasTexture, createCanvasTexture } from "../canvas-texture";
import {
  createChartRenderer,
  niceStep,
  pushArc,
  pushArea,
  pushCandle,
  pushPolyline,
  pushQuad,
  pushRect,
} from "../charts";
import { createColorEase, hexToUnitRgb } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  scopedProgram,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { approach, smoothstep } from "../math";
import { createSettledValue } from "../rebuild";
import { createSpriteBatch } from "../sprites";
import { createTextLayer, TEXT_PALETTE_FLOATS } from "../text-layer";
import { defineEffect } from "../types";
import {
  createMeasure,
  drawAxisLabel,
  drawTickerItem,
  paintArrow,
  paintCaption,
  type StyleId,
  TICKER_INDENT_EM,
  tickerSlotWidth,
} from "./stonks-art";
import {
  arrowBob,
  BOB_HEIGHT,
  candleWicks,
  createChartView,
  createMarket,
  createTicker,
  GRID_X_POINTS,
  GRID_Y_LINES,
  headValue,
  layoutView,
  MARKET_CAPACITY,
  MAX_SPAN,
  pointValue,
  REF_HEIGHT,
  stepMarket,
  stepTicker,
  stepView,
  TICKER_ITEMS,
  viewX,
  viewY,
} from "./stonks-sim";
import { stonksMeta } from "./stonks.meta";

// Layout, reference px.
const MARGIN = 56;
const LABEL_W = 120;
const PLOT_TOP = 150;
const TICKER_H = 64;
const PLOT_GAP = 44;
const CAPTION_X = 64;
const CAPTION_Y = 30;
const CAPTION_PX = 150;
const ARROW_SIZE = 380;
const TICKER_PX = 30;
const LABEL_PX = 19;
const LABEL_ROW = 28;
/** How far gridlines fade in from the plot's edges. */
const EDGE_FADE = 28;

/** Seconds: the style and chart crossfades, the ticker's fade, a caption change, a new variation. */
const STYLE_SECONDS = 1.2;
const CHART_SECONDS = 0.8;
const TICKER_SECONDS = 0.6;
const CAPTION_SECONDS = 0.6;
const SWAP_SECONDS = 0.45;
const GRID_SECONDS = 1;
const COLOR_SECONDS = 1.2;
/** Seconds the caption text, the canvas size and the variation must hold before they're used. */
const SETTLE_TEXT = 0.5;
const SETTLE_SIZE = 0.3;
const SETTLE_SEED = 0.4;

/** Label slots in the text layer: enough for two sets of gridlines while they crossfade. */
const LABEL_SLOTS = 24;
/** Chart mesh vertices: every mark of all three chart looks at the widest span, at once. */
const MESH_CAPACITY = 40000;
/** Points drawn: the widest span, plus one either side and the head. */
const MAX_POINTS = MAX_SPAN + 4;

const LINE_COLORS: Record<string, string> = { green: "#2bff88", cyan: "#2ee6ff", gold: "#ffc93c" };
const RED = hexToUnitRgb("#ff4d6a");
const WHITE = hexToUnitRgb("#ffffff");
const CLIP_GRID = hexToUnitRgb("#c3ccd8");
const CLIP_AXIS = hexToUnitRgb("#59647a");
const BAR_FRONT = hexToUnitRgb("#2f6fd6");
const BAR_LIGHT = hexToUnitRgb("#8fb8ff");
const BAR_TOP = hexToUnitRgb("#6b9cf0");
const BAR_SIDE = hexToUnitRgb("#1b4596");

/** Background gradients (top, bottom) per style, and the corner glow's strength on the terminal. */
const TERM_TOP = hexToUnitRgb("#0b1228");
const TERM_BOTTOM = hexToUnitRgb("#03050d");
const CLIP_TOP = hexToUnitRgb("#ffffff");
const CLIP_BOTTOM = hexToUnitRgb("#e3e9f3");
const GLOW = 0.22;
const TERM_BAND = hexToUnitRgb("#060a18");
const CLIP_BAND = hexToUnitRgb("#dde4ef");

/** Text role colours (primary, muted, up, down, inverse) per style; the terminal's up is the line colour. */
const TERM_ROLES = ["#e9eef8", "#5f6f8f", "#2bff88", "#ff4d6a", "#0b1228"];
const CLIP_ROLES = ["#1d2b4f", "#5d6678", "#138a36", "#c62828", "#ffffff"];

const BACKGROUND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uGlow;
uniform float uGlowRadius;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec3 c = mix(uBottom, uTop, vUv.y);
  // A soft glow in the lower-left corner.
  float d = length(gl_FragCoord.xy) / uGlowRadius;
  c += uGlow * exp(-3.0 * d * d);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

const SPRITE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (device px, y down), half width, half height (px). */
layout(location = 1) in vec4 aSprite;
layout(location = 2) in float aAlpha;
uniform vec2 uResolution;
out vec2 vUv;
flat out float vAlpha;
${TO_CLIP_GLSL}
void main() {
  vUv = aCorner * 0.5 + 0.5;
  vAlpha = aAlpha;
  gl_Position = pxToClip(aSprite.xy + aCorner * aSprite.zw, uResolution);
}
`;

/** Premultiplied art, tinted and faded. */
const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
flat in float vAlpha;
uniform sampler2D uTex;
uniform vec3 uTint;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUv) * vec4(uTint, 1.0) * vAlpha;
}
`;

/** A caption texture and its opacity. */
interface CaptionSlot {
  texture: CanvasTexture;
  alpha: number;
  /** Size in device px at the art scale. */
  width: number;
  height: number;
}

/** An axis label painted in the text layer. */
interface LabelSlot {
  /** Price (log10) it shows; NaN when empty. */
  value: number;
  /** The frame it was last drawn. */
  used: number;
}

/** Sprites: two arrows and two caption slots. */
const MAX_SPRITES = 4;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * "Stonks": a dark trading terminal (or an early-2000s office slide) where the
 * chart only ever goes up. The price walk, view and ticker live in
 * `stonks-sim.ts`; a frame is a background pass, one chart mesh (gridlines,
 * fill, line or candles or 3D bars, the ticker band), one text-layer draw (axis
 * labels and ticker items, painted only when they change) and a few sprites
 * (the arrow and caption).
 */
export const stonks = defineEffect(stonksMeta, {
  create(gl) {
    return withScope((scope) => {
      const background = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BACKGROUND_FRAGMENT);
      const ub = createUniforms(gl, background, ["uTop", "uBottom", "uGlow", "uGlowRadius"]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const chart = createChartRenderer(gl, scope, MESH_CAPACITY);
      const text = createTextLayer(gl, scope, 64);
      const spriteProgram = scopedProgram(gl, scope, SPRITE_VERTEX, SPRITE_FRAGMENT);
      const us = createUniforms(gl, spriteProgram, ["uResolution", "uTex", "uTint"]);
      const batch = scope.own(createSpriteBatch(gl, MAX_SPRITES, [4, 1]));
      gl.useProgram(spriteProgram);
      us.i1("uTex", 0);
      gl.useProgram(null);
      const arrows = [
        createCanvasTexture(gl, scope, { premultiply: true }),
        createCanvasTexture(gl, scope, { premultiply: true }),
      ];
      const captions: CaptionSlot[] = [0, 1].map(() => ({
        texture: createCanvasTexture(gl, scope, { premultiply: true }),
        alpha: 0,
        width: 1,
        height: 1,
      }));
      const labels: LabelSlot[] = Array.from({ length: LABEL_SLOTS }, () => ({
        value: Number.NaN,
        used: -1,
      }));

      const measure = createMeasure();
      const settledText = createSettledValue<string>(SETTLE_TEXT);
      const settledSize = createSettledValue<number>(SETTLE_SIZE);
      const settledSeed = createSettledValue<number>(SETTLE_SEED);
      const lineEase = createColorEase(3);
      const lineTarget = new Float32Array(3);
      const palette = new Float32Array(TEXT_PALETTE_FLOATS);
      const termRoles = new Float32Array(TEXT_PALETTE_FLOATS);
      const clipRoles = new Float32Array(TEXT_PALETTE_FLOATS);
      for (let k = 0; k < 5; k++) {
        termRoles.set(hexToUnitRgb(TERM_ROLES[k]), 3 * k);
        clipRoles.set(hexToUnitRgb(CLIP_ROLES[k]), 3 * k);
      }
      const scratch = new Float32Array(3);
      const xs = new Float32Array(MAX_POINTS);
      const ys = new Float32Array(MAX_POINTS);
      const wick = { up: 0, down: 0 };
      const data = batch.data;
      const stride = batch.stride;

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      /** Device px per reference px the art is painted at: the scale once the size settles. */
      let artScale = 0;
      let paintedSize = -1;
      let market = createMarket(0);
      let view = createChartView();
      let ticker = createTicker(0);
      let started = false;
      let time = 0;
      let frameNo = 0;
      /** Eased mixes: style (0 terminal, 1 slide), chart (0 line, 1 candles), ticker, the chart's fade-through. */
      let styleT = 0;
      let chartT = 0;
      let tickerA = 1;
      let swapA = 1;
      let lineKey = "";
      /** The caption slot showing the latest caption, and what it shows. */
      let front = 0;
      let shownCaption = "";
      let shownStyle = "";
      let shownScale = 0;
      /** The ticker's painted slot width and row height (device px), and its font size. */
      let slotW = 1;
      let rowH = 1;
      let tickerPx = 1;
      let labelX = 0;
      let labelRow = 1;
      let labelPx = 1;
      /** Price gridline spacing (log10), the one fading out, and the crossfade between them. */
      let gridStep = 0;
      let oldStep = 0;
      let gridFade = 1;
      let gridLo = Number.NaN;
      let gridHi = Number.NaN;

      // Plot rect, reference px.
      let plotL = 0;
      let plotR = 1;
      let plotT = 0;
      let plotB = 1;

      const layout = () => {
        plotL = MARGIN;
        plotR = Math.max(plotL + 1, refWidth - MARGIN - LABEL_W);
        plotT = PLOT_TOP;
        plotB = REF_HEIGHT - TICKER_H - PLOT_GAP;
      };

      /** Lays out the text layer for the art scale and marks everything for repainting. */
      const layoutText = () => {
        tickerPx = Math.max(4, Math.round(TICKER_PX * artScale));
        slotW = tickerSlotWidth(tickerPx, measure);
        rowH = Math.ceil(tickerPx * 1.5);
        labelPx = Math.max(4, Math.round(LABEL_PX * artScale));
        labelRow = Math.ceil(LABEL_ROW * artScale);
        labelX = slotW + 4;
        const labelW = Math.ceil(LABEL_W * artScale);
        text.resize(labelX + labelW, Math.max(TICKER_ITEMS * rowH, LABEL_SLOTS * labelRow));
        for (const it of ticker.items) {
          it.changed = true;
        }
        for (const l of labels) {
          l.value = Number.NaN;
          l.used = -1;
        }
      };

      /** The label slot showing `value`, painting it into the least recently used slot if none does. */
      const labelSlot = (value: number): number => {
        let oldest = 0;
        for (let i = 0; i < LABEL_SLOTS; i++) {
          const l = labels[i];
          if (Math.abs(l.value - value) <= 1e-9 * Math.max(1, Math.abs(value))) {
            l.used = frameNo;
            return i;
          }
          if (l.used < labels[oldest].used) {
            oldest = i;
          }
        }
        const l = labels[oldest];
        if (l.used === frameNo) {
          return -1;
        }
        l.value = value;
        l.used = frameNo;
        const ctx = text.ctx;
        if (ctx) {
          const y = oldest * labelRow;
          text.clear(labelX, y, text.width - labelX, labelRow);
          drawAxisLabel(ctx, value, labelX + 2, y + labelRow / 2, labelPx);
        }
        return oldest;
      };

      /** Draws the price gridlines `step` apart (and their labels) at opacity `alpha`. */
      const priceGrid = (step: number, alpha: number, clip: number, color: ArrayLike<number>) => {
        const y = view.y;
        if (!(step > 0) || !(alpha > 0) || !(y.hi > y.lo)) {
          return;
        }
        const mesh = chart.mesh;
        const first = Math.ceil(y.lo / step);
        const last = Math.floor(y.hi / step);
        const lineW = Math.max(1, Math.round(scale));
        for (let k = first; k <= last && k - first < 16; k++) {
          const v = k * step;
          const ry = plotT + viewY(view, v);
          const fade =
            smoothstep(plotT, plotT + EDGE_FADE, ry) *
            (1 - smoothstep(plotB - EDGE_FADE, plotB, ry));
          const a = alpha * fade;
          if (!(a > 0.002)) {
            continue;
          }
          const dy = Math.round(ry * scale);
          pushRect(
            mesh,
            plotL * scale,
            dy,
            plotR * scale,
            dy + lineW,
            color,
            a * lerp(0.07, 1, clip),
          );
          const slot = labelSlot(v);
          if (slot >= 0) {
            const lh = labelRow * (scale / artScale);
            text.quad(
              labelX,
              slot * labelRow,
              text.width - labelX,
              labelRow,
              (plotR + 12) * scale,
              ry * scale - lh / 2,
              (text.width - labelX) * (scale / artScale),
              lh,
              a,
            );
          }
        }
      };

      let spriteCount = 0;
      const put = (cx: number, cy: number, hw: number, hh: number, alpha: number) => {
        const o = spriteCount * stride;
        spriteCount++;
        data[o] = cx;
        data[o + 1] = cy;
        data[o + 2] = hw;
        data[o + 3] = hh;
        data[o + 4] = alpha;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / REF_HEIGHT;
          refWidth = width / scale;
          layout();
          if (started) {
            layoutView(view, market, plotR - plotL, plotB - plotT);
          }
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          frameNo++;
          const style: StyleId = p.style === "clipart" ? "clipart" : "terminal";
          const caption = settledText.update(p.text, step);
          const seed = settledSeed.update(Math.floor(p.seed), step);
          const size = settledSize.update(width * 65536 + height, step);

          if (!started) {
            // Allocates the market, view and tape once, on the first frame.
            started = true;
            market = createMarket(seed);
            ticker = createTicker(seed);
            view = createChartView();
            layoutView(view, market, plotR - plotL, plotB - plotT);
          }
          // A new variation fades the chart and tape out, swaps them, and fades back in.
          if (seed !== market.seed) {
            swapA = Math.max(0, swapA - step / SWAP_SECONDS);
            if (swapA <= 0) {
              // Allocates a new market, view and tape, once per settled variation.
              market = createMarket(seed);
              ticker = createTicker(seed);
              view = createChartView();
              layoutView(view, market, plotR - plotL, plotB - plotT);
              gridStep = 0;
              oldStep = 0;
              gridFade = 1;
            }
          } else {
            swapA = Math.min(1, swapA + step / SWAP_SECONDS);
          }
          stepMarket(market, step, p.speed, p.crash);
          stepTicker(ticker, step);
          stepView(view, market, step);

          styleT = approach(styleT, style === "clipart" ? 1 : 0, step / STYLE_SECONDS);
          chartT = approach(chartT, p.chart === "candles" ? 1 : 0, step / CHART_SECONDS);
          tickerA = approach(tickerA, p.ticker ? 1 : 0, step / TICKER_SECONDS);
          const clip = smoothstep(0, 1, styleT);
          const candles = smoothstep(0, 1, chartT);
          if (lineKey !== p.color) {
            // Allocates the colour, only when the colour select changes.
            lineKey = p.color;
            lineTarget.set(hexToUnitRgb(LINE_COLORS[p.color] ?? LINE_COLORS.green));
          }
          const line = lineEase.step(lineTarget, step, COLOR_SECONDS);

          // The art follows the canvas size once it settles.
          if (size !== paintedSize) {
            // Allocates the arrow art and text layer canvas, once per settled canvas size.
            paintedSize = size;
            artScale = scale;
            layoutText();
            const arrowPx = Math.round(Math.min(ARROW_SIZE, refWidth * 0.28) * artScale);
            arrows[0].upload(paintArrow("terminal", arrowPx));
            arrows[1].upload(paintArrow("clipart", arrowPx));
          }

          // Background.
          gl.useProgram(background);
          ub.f3(
            "uTop",
            lerp(TERM_TOP[0], CLIP_TOP[0], clip),
            lerp(TERM_TOP[1], CLIP_TOP[1], clip),
            lerp(TERM_TOP[2], CLIP_TOP[2], clip),
          );
          ub.f3(
            "uBottom",
            lerp(TERM_BOTTOM[0], CLIP_BOTTOM[0], clip),
            lerp(TERM_BOTTOM[1], CLIP_BOTTOM[1], clip),
            lerp(TERM_BOTTOM[2], CLIP_BOTTOM[2], clip),
          );
          const glow = GLOW * (1 - clip);
          ub.f3("uGlow", line[0] * glow, line[1] * glow, line[2] * glow);
          ub.f1("uGlowRadius", 0.9 * height);
          triangle.draw();

          // The chart mesh: the plot (clipped to it), then the ticker band.
          const mesh = chart.mesh;
          mesh.count = 0;
          const fade = swapA;
          const termA = (1 - clip) * fade;
          const pointPx = ((plotR - plotL) / view.span) * scale;
          const x0 = plotL * scale;
          const yTop = plotT * scale;
          const yBottom = plotB * scale;

          // Time gridlines on the terminal.
          const gridColor = scratch;
          gridColor[0] = lerp(1, CLIP_GRID[0], clip);
          gridColor[1] = lerp(1, CLIP_GRID[1], clip);
          gridColor[2] = lerp(1, CLIP_GRID[2], clip);
          if (termA > 0) {
            const lineW = Math.max(1, Math.round(scale));
            const firstK = Math.ceil(view.x.lo / GRID_X_POINTS);
            for (let k = firstK; k * GRID_X_POINTS <= view.x.hi; k++) {
              const gx = plotL + viewX(view, k * GRID_X_POINTS);
              const a =
                smoothstep(plotL, plotL + EDGE_FADE, gx) *
                (1 - smoothstep(plotR - EDGE_FADE, plotR, gx));
              pushRect(
                mesh,
                Math.round(gx * scale),
                yTop,
                Math.round(gx * scale) + lineW,
                yBottom,
                WHITE,
                0.05 * a * termA,
              );
            }
          }
          // Price gridlines, crossfading when their spacing changes.
          if (view.y.toLo !== gridLo || view.y.toHi !== gridHi) {
            gridLo = view.y.toLo;
            gridHi = view.y.toHi;
            const next = niceStep(gridHi - gridLo, GRID_Y_LINES);
            if (gridStep <= 0) {
              gridStep = next;
            } else if (Math.abs(next - gridStep) > 1e-12 * next) {
              oldStep = gridStep;
              gridStep = next;
              gridFade = 0;
            }
          }
          gridFade = Math.min(1, gridFade + step / GRID_SECONDS);
          const gf = smoothstep(0, 1, gridFade);
          priceGrid(oldStep, (1 - gf) * fade, clip, gridColor);
          priceGrid(gridStep, gf * fade, clip, gridColor);

          // The line's points: from just left of the view to the head.
          const pos = market.pos;
          const iHead = Math.floor(pos);
          const i0 = Math.max(
            Math.floor(view.x.lo) - 1,
            market.count - MARKET_CAPACITY,
            0,
            iHead - MAX_POINTS + 2,
          );
          let n = 0;
          for (let i = i0; i <= iHead; i++) {
            xs[n] = (plotL + viewX(view, i)) * scale;
            ys[n] = (plotT + viewY(view, pointValue(market, i))) * scale;
            n++;
          }
          const head = headValue(market);
          const hx = (plotL + viewX(view, pos)) * scale;
          const hy = (plotT + viewY(view, head)) * scale;
          xs[n] = hx;
          ys[n] = hy;
          n++;

          const lineA = termA * (1 - candles);
          if (lineA > 0) {
            pushArea(mesh, xs, ys, 0, n, yBottom, line, 0.3 * lineA, 0);
            pushPolyline(mesh, xs, ys, 0, n, 14 * scale, line, 0.12 * lineA);
            pushPolyline(mesh, xs, ys, 0, n, 4 * scale, line, lineA);
            pushArc(mesh, hx, hy, -1, 16 * scale, 0, 2 * Math.PI, line, 0.18 * lineA);
            pushArc(mesh, hx, hy, -1, 6 * scale, 0, 2 * Math.PI, line, lineA);
          }
          const candleA = termA * candles;
          if (candleA > 0) {
            const body = Math.max(1, 0.6 * pointPx);
            const wickW = Math.max(1, 2 * scale);
            for (let k = 1; k < n; k++) {
              const i = i0 + k;
              const open = pointValue(market, i - 1);
              const last = k === n - 1;
              const close = last ? head : pointValue(market, i);
              candleWicks(market, i, wick);
              const grow = last ? pos - iHead : 1;
              const hi = Math.max(open, close) + wick.up * grow;
              const lo = Math.min(open, close) - wick.down * grow;
              const cx = (plotL + viewX(view, i - 0.5)) * scale;
              pushCandle(
                mesh,
                cx,
                body,
                wickW,
                (plotT + viewY(view, open)) * scale,
                (plotT + viewY(view, close)) * scale,
                (plotT + viewY(view, hi)) * scale,
                (plotT + viewY(view, lo)) * scale,
                close >= open ? line : RED,
                candleA,
              );
            }
          }
          const barA = clip * fade;
          if (barA > 0) {
            const bw = 0.62 * pointPx;
            const depth = 0.18 * pointPx;
            // The points' bars, then the next one growing with the head.
            for (let k = 0; k < n; k++) {
              const last = k === n - 1;
              const i = last ? iHead + 1 : i0 + k;
              const a = last ? barA * smoothstep(0, 0.3, pos - iHead) : barA;
              const l = (plotL + viewX(view, i)) * scale - bw / 2;
              const r = l + bw;
              const top = Math.min(yBottom - 1, ys[k]);
              pushQuad(
                mesh,
                l,
                top,
                l + depth,
                top - depth,
                r + depth,
                top - depth,
                r,
                top,
                BAR_TOP,
                a,
              );
              pushQuad(
                mesh,
                r,
                top,
                r + depth,
                top - depth,
                r + depth,
                yBottom - depth,
                r,
                yBottom,
                BAR_SIDE,
                a,
              );
              pushRect(mesh, l, top, r, yBottom, BAR_FRONT, a);
              pushRect(mesh, l, top, l + bw * 0.2, yBottom, BAR_LIGHT, 0.55 * a);
            }
            pushRect(
              mesh,
              x0,
              yBottom,
              plotR * scale,
              yBottom + Math.max(2, 2 * scale),
              CLIP_AXIS,
              barA,
            );
          }
          const plotCount = mesh.count;

          // The ticker band, and a soft tint behind each price that just ticked up.
          const bandA = tickerA;
          const bandTop = (REF_HEIGHT - TICKER_H) * scale;
          if (bandA > 0) {
            scratch[0] = lerp(TERM_BAND[0], CLIP_BAND[0], clip);
            scratch[1] = lerp(TERM_BAND[1], CLIP_BAND[1], clip);
            scratch[2] = lerp(TERM_BAND[2], CLIP_BAND[2], clip);
            pushRect(mesh, 0, bandTop, width, height, scratch, 0.92 * bandA);
            pushRect(
              mesh,
              0,
              bandTop,
              width,
              bandTop + Math.max(1, 2 * scale),
              line,
              lerp(0.5, 0, clip) * bandA,
            );
          }

          // Ticker items: repaint the ones whose price changed, then lay the tape out.
          const ctx = text.ctx;
          for (let i = 0; i < TICKER_ITEMS; i++) {
            const it = ticker.items[i];
            if (it.changed && ctx) {
              it.changed = false;
              text.clear(0, i * rowH, slotW, rowH);
              // Allocates the item's label, only when its price changes.
              drawTickerItem(ctx, it, tickerPx * TICKER_INDENT_EM, i * rowH + rowH / 2, tickerPx);
            }
          }
          const itemA = bandA * fade;
          if (itemA > 0) {
            const k = scale / artScale;
            const slotRef = slotW / artScale;
            const period = slotRef * TICKER_ITEMS;
            const offset = ticker.scroll % period;
            let slot = Math.floor(offset / slotRef);
            let sx = -(offset - slot * slotRef);
            const cy = REF_HEIGHT - TICKER_H / 2;
            for (let guard = 0; sx < refWidth && guard < 64; guard++) {
              const item = ticker.items[slot % TICKER_ITEMS];
              if (item.tint > 0) {
                pushRect(
                  mesh,
                  sx * scale,
                  bandTop + 3 * scale,
                  (sx + slotRef - (TICKER_PX * 1.6) / 2) * scale,
                  height,
                  line,
                  0.16 * item.tint * itemA,
                );
              }
              text.quad(
                0,
                (slot % TICKER_ITEMS) * rowH,
                slotW,
                rowH,
                sx * scale,
                cy * scale - (rowH * k) / 2,
                slotW * k,
                rowH * k,
                itemA,
              );
              sx += slotRef;
              slot++;
            }
          }

          chart.upload();
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.enable(gl.SCISSOR_TEST);
          const sx0 = Math.floor(x0);
          const sy0 = Math.floor(height - yBottom - Math.max(2, 2 * scale));
          gl.scissor(
            sx0,
            sy0,
            Math.max(0, Math.ceil(plotR * scale) - sx0 + Math.ceil(pointPx)),
            Math.max(0, height - sy0),
          );
          chart.draw(width, height, 0, plotCount);
          gl.disable(gl.SCISSOR_TEST);
          chart.draw(width, height, plotCount, mesh.count - plotCount);

          // Labels and ticker text, coloured by role.
          for (let r = 0; r < TEXT_PALETTE_FLOATS; r++) {
            palette[r] = lerp(termRoles[r], clipRoles[r], clip);
          }
          for (let c = 0; c < 3; c++) {
            palette[6 + c] = lerp(line[c], clipRoles[6 + c], clip);
          }
          text.flush();
          text.draw(width, height, palette);

          // Caption: a new text, style or art scale paints the back slot and crossfades to it.
          if (caption !== shownCaption || style !== shownStyle || artScale !== shownScale) {
            // Allocates the new caption's art, once per settled change.
            shownCaption = caption;
            shownStyle = style;
            shownScale = artScale;
            front = 1 - front;
            const c = captions[front];
            const maxW = Math.min(refWidth * 0.5, 980) * artScale;
            const art = paintCaption(
              caption,
              style,
              Math.round(CAPTION_PX * artScale),
              maxW,
              measure,
            );
            c.texture.upload(art);
            c.width = art ? art.width : 1;
            c.height = art ? art.height : 1;
          }
          for (let i = 0; i < 2; i++) {
            const c = captions[i];
            c.alpha = approach(c.alpha, i === front ? 1 : 0, step / CAPTION_SECONDS);
          }

          // Sprites: the arrows (one per style), then the captions.
          spriteCount = 0;
          const arrowRef = Math.min(ARROW_SIZE, refWidth * 0.28);
          const ax = plotR - arrowRef * 0.55;
          const ay = plotB - arrowRef * 0.6 - arrowBob(time) * BOB_HEIGHT;
          const ah = (arrowRef / 2) * scale;
          put(ax * scale, ay * scale, ah, ah, 1 - clip);
          put(ax * scale, ay * scale, ah, ah, clip);
          const k = scale / artScale;
          for (let i = 0; i < 2; i++) {
            const c = captions[i];
            put(
              CAPTION_X * scale + (c.width * k) / 2,
              CAPTION_Y * scale + (c.height * k) / 2,
              (c.width * k) / 2,
              (c.height * k) / 2,
              c.alpha,
            );
          }
          batch.upload(spriteCount);
          gl.useProgram(spriteProgram);
          us.f2("uResolution", width, height);
          gl.activeTexture(gl.TEXTURE0);
          for (let i = 0; i < 2; i++) {
            const a = i === 0 ? 1 - clip : clip;
            if (a > 0) {
              us.f3("uTint", i === 0 ? line[0] : 1, i === 0 ? line[1] : 1, i === 0 ? line[2] : 1);
              gl.bindTexture(gl.TEXTURE_2D, arrows[i].texture);
              batch.draw(i, 1);
            }
          }
          us.f3("uTint", 1, 1, 1);
          for (let i = 0; i < 2; i++) {
            if (captions[i].alpha > 0) {
              gl.bindTexture(gl.TEXTURE_2D, captions[i].texture.texture);
              batch.draw(2 + i, 1);
            }
          }
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
