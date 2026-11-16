/**
 * The speedrun splits overlay: a tall panel in a side column with a title,
 * the split list (name, and the comparison or finished time), the difference
 * against the comparison for each finished split, and a big running timer.
 * The run itself lives in `splits-run.ts`.
 *
 * Only what changes is redrawn: the timer's own rect each tenth, the rows when
 * a split finishes (and while its difference fades in, or the list steps one
 * row), and the title when it is edited. The panel sits at the top of its
 * column, as tall as its rows need, and only that part of the canvas is drawn
 * to the screen.
 */
import { smoothstep } from "../math";
import type { AnyParamValues } from "../types";
import type { OverlayCanvas, OverlayDefinition, OverlayView } from "./overlay-layer";
import {
  cssRgba,
  drawPanel,
  fillLine,
  fillTabular,
  measureTabular,
  overlayFont,
  PANEL_MUTED,
  PANEL_PADDING,
  PANEL_TEXT,
} from "./overlay-text";
import {
  createSplitsSession,
  formatSplitDiff,
  formatSplitTime,
  SPLIT_AHEAD,
  SPLIT_BEST,
  windowStart,
} from "./splits-run";
import { splitsMeta } from "./splits.meta";

type Ctx = OffscreenCanvasRenderingContext2D;

/** Sizes at 1080p. */
const TITLE_LINE = 26;
const TITLE_FONT = 20;
const SUBTITLE_FONT = 17;
const ROW_HEIGHT = 34;
const ROW_FONT = 18;
const DIFF_FONT = 16;
const TIMER_HEIGHT = 64;
const TIMER_FONT = 46;
const GAP = 8;

/** Seconds a finished split's difference takes to fade in, and the list to step a row. */
export const DIFF_FADE_SECONDS = 0.5;
const WINDOW_STEP_SECONDS = 0.3;

/** Colours for a finished split: ahead, behind, and a best segment. */
const AHEAD = "#5fdc8f";
const BEHIND = "#ff7070";
const BEST = "#ffc94a";

/**
 * The most a difference can be, as a fraction of the run so far, for sizing
 * its column (a run strays at most 12 % per segment).
 */
const MAX_DIFF_FRACTION = 0.15;

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

const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const copyBox = (dst: Box, src: Box) => {
  setBox(dst, src.x, src.y, src.w, src.h);
};

/** A param's value as text or a finite number, or `fallback` if it is missing or the wrong kind. */
const text = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
const number = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** The title's lines: the text param's value, blank lines dropped. Allocates. */
const titleLines = (title: string) => title.split("\n").filter((l) => l.trim() !== "");

/** How many title lines `title` has, without allocating. */
function countTitleLines(title: string): number {
  let lines = 0;
  let blank = true;
  for (let i = 0; i <= title.length; i++) {
    const c = i < title.length ? title[i] : "\n";
    if (c === "\n") {
      if (!blank) {
        lines++;
      }
      blank = true;
    } else if (c.trim() !== "") {
      blank = false;
    }
  }
  return Math.min(2, lines);
}

export const splitsOverlay: OverlayDefinition = {
  meta: splitsMeta,
  create() {
    const session = createSplitsSession(1);
    /** The overlay's own clock, which keeps running while a finished run holds. */
    let clock = 0;
    /** When each split's finish was noticed, on `clock`. */
    let shownAt = new Float64Array(32);
    let seenRun = -1;
    let seenCurrent = 0;

    let title = "";
    let titleCount = 0;

    // The list window: eases between whole-row starts.
    let windowFrom = 0;
    let windowTo = 0;
    let windowT = 1;
    let windowPos = 0;
    let visible = 1;

    // Where things go this frame, and where they were last drawn.
    const panel = box();
    const titleBox = box();
    const rowsBox = box();
    const timerBox = box();
    const drawnPanel = box();
    let drawnTitle: string | null = null;
    let drawnNames = -1;
    let drawnCurrent = -1;
    let drawnWindow = -1;
    let drawnTenths = -1;
    let drawnDone = false;
    let drawnFading = false;
    /** The rows need drawing again for a fading difference. */
    let fading = false;

    /** Lays out the panel in `view`'s column for this run's rows and the title. */
    const layOut = (view: OverlayView) => {
      const s = view.scale;
      const t = view.target("column");
      const pad = PANEL_PADDING * s;
      const titleH = titleCount > 0 ? titleCount * TITLE_LINE * s + GAP * s : 0;
      const fixed = 2 * pad + titleH + TIMER_HEIGHT * s + GAP * s;
      const rowH = ROW_HEIGHT * s;
      const fits = Math.floor((t.h - fixed) / rowH);
      visible = Math.max(1, Math.min(session.count, fits));
      const h = Math.min(t.h, fixed + visible * rowH);
      setBox(panel, t.x, t.y, t.w, h);
      const inner = pad / 2;
      setBox(titleBox, panel.x + inner, panel.y + pad, panel.w - pad, titleH - GAP * s);
      setBox(rowsBox, panel.x + inner, panel.y + pad + titleH, panel.w - pad, visible * rowH);
      setBox(
        timerBox,
        panel.x + inner,
        rowsBox.y + rowsBox.h + GAP * s,
        panel.w - pad,
        TIMER_HEIGHT * s,
      );
    };

    const update = (dt: number, values: Readonly<AnyParamValues>, view: OverlayView) => {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      clock += step;
      session.configure(
        text(values.splitsList, ""),
        number(values.splitsLength, 5),
        number(values.splitsLuck, 0.5),
      );
      session.step(step);

      // Note when splits finish, for their differences' fade.
      if (session.run !== seenRun) {
        seenRun = session.run;
        seenCurrent = 0;
        if (shownAt.length < session.count) {
          shownAt = new Float64Array(session.count);
        }
      }
      for (; seenCurrent < session.current; seenCurrent++) {
        shownAt[seenCurrent] = clock;
      }

      const heading = text(values.splitsTitle, "");
      if (heading !== title) {
        title = heading;
        titleCount = countTitleLines(heading);
      }
      layOut(view);

      // Step the list window a row at a time; a jump (a new run) snaps.
      const target = windowStart(session.current, session.count, visible);
      if (target !== windowTo) {
        const from = windowPos;
        windowTo = target;
        if (Math.abs(target - from) <= 1 && session.current > 0) {
          windowFrom = from;
          windowT = 0;
        } else {
          windowT = 1;
        }
      }
      windowT = Math.min(1, windowT + step / WINDOW_STEP_SECONDS);
      windowPos = windowFrom + (windowTo - windowFrom) * smoothstep(0, 1, windowT);
      if (windowT >= 1) {
        windowPos = windowTo;
        windowFrom = windowTo;
      }

      fading = false;
      for (let i = 0; i < session.current; i++) {
        if (clock - shownAt[i] < DIFF_FADE_SECONDS) {
          fading = true;
          break;
        }
      }
    };

    /** Clears `area`, repaints the panel behind it, and draws `content` clipped to it. */
    const redraw = (canvas: OverlayCanvas, view: OverlayView, area: Box, content: () => void) => {
      if (area.w <= 0 || area.h <= 0) {
        return;
      }
      const ctx = canvas.ctx;
      canvas.clear(area.x, area.y, area.w, area.h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.x, area.y, area.w, area.h);
      ctx.clip();
      drawPanel(ctx, panel.x, panel.y, panel.w, panel.h, view.scale, view.opacity, view.accent);
      content();
      ctx.restore();
    };

    const drawTitle = (ctx: Ctx, view: OverlayView) => {
      const s = view.scale;
      const lines = titleLines(title);
      for (let i = 0; i < titleCount; i++) {
        fillLine(
          ctx,
          lines[i],
          titleBox.x + (PANEL_PADDING * s) / 2,
          titleBox.y + (i + 0.5) * TITLE_LINE * s,
          i === 0 ? overlayFont(TITLE_FONT * s, 600) : overlayFont(SUBTITLE_FONT * s),
          i === 0 ? PANEL_TEXT : PANEL_MUTED,
          titleBox.w - PANEL_PADDING * s,
        );
      }
    };

    const drawRows = (ctx: Ctx, view: OverlayView) => {
      const s = view.scale;
      const rowH = ROW_HEIGHT * s;
      const n = session.count;
      const inset = (PANEL_PADDING * s) / 2;
      const left = rowsBox.x + inset;
      const right = rowsBox.x + rowsBox.w - inset;
      // Column widths from the longest times this run can show, so names don't shift.
      const total = session.comparison[n - 1];
      const rowFont = overlayFont(ROW_FONT * s);
      const diffFont = overlayFont(DIFF_FONT * s, 600);
      const timeW = measureTabular(ctx, formatSplitTime(total * (1 + MAX_DIFF_FRACTION)), rowFont);
      const diffW = measureTabular(ctx, formatSplitDiff(total * MAX_DIFF_FRACTION), diffFont);
      const colGap = 10 * s;
      const diffRight = right - timeW - colGap;
      const nameW = diffRight - diffW - colGap - left;

      // Whole pixels, so the rows stay crisp while the list steps.
      const first = Math.floor(windowPos);
      for (let k = first; k < Math.min(n, first + visible + 1); k++) {
        const y = rowsBox.y + Math.round((k - windowPos) * rowH);
        const cy = y + rowH / 2;
        if (k === session.current) {
          ctx.fillStyle = cssRgba(view.accent, 0.28);
          ctx.beginPath();
          ctx.roundRect(rowsBox.x, y + s, rowsBox.w, rowH - 2 * s, 6 * s);
          ctx.fill();
          ctx.fillStyle = view.accent;
          ctx.fillRect(
            rowsBox.x,
            Math.round(y + 6 * s),
            Math.max(1, Math.round(3 * s)),
            Math.round(rowH - 12 * s),
          );
        }
        fillLine(ctx, session.names[k], left, cy, rowFont, PANEL_TEXT, nameW);
        const done = k < session.current;
        const time = done ? session.finished[k] : session.comparison[k];
        fillTabular(
          ctx,
          formatSplitTime(time),
          right,
          cy,
          rowFont,
          done ? PANEL_TEXT : PANEL_MUTED,
          "right",
        );
        if (done) {
          const result = session.results[k];
          const colour = result === SPLIT_BEST ? BEST : result === SPLIT_AHEAD ? AHEAD : BEHIND;
          ctx.globalAlpha = smoothstep(0, 1, (clock - shownAt[k]) / DIFF_FADE_SECONDS);
          fillTabular(
            ctx,
            formatSplitDiff(session.diffs[k]),
            diffRight,
            cy,
            diffFont,
            colour,
            "right",
          );
          ctx.globalAlpha = 1;
        }
      }
    };

    const drawTimer = (ctx: Ctx, view: OverlayView) => {
      const s = view.scale;
      const n = session.count;
      const done = session.current >= n;
      const colour = !done ? PANEL_TEXT : session.diffs[n - 1] < 0 ? AHEAD : BEHIND;
      fillTabular(
        ctx,
        formatSplitTime(session.time),
        timerBox.x + timerBox.w - (PANEL_PADDING * s) / 2,
        timerBox.y + timerBox.h / 2,
        overlayFont(TIMER_FONT * s, 700),
        colour,
        "right",
      );
    };

    return {
      update,
      draw2d(canvas, view, full) {
        const ctx = canvas.ctx;
        const tenths = Math.floor(session.time * 10 + 1e-6);
        const done = session.current >= session.count;
        if (full || !sameBox(panel, drawnPanel)) {
          if (!full) {
            // The panel changed size: clear the whole column and start again.
            const t = view.target("column");
            canvas.clear(t.x, t.y, t.w, t.h);
          }
          drawPanel(ctx, panel.x, panel.y, panel.w, panel.h, view.scale, view.opacity, view.accent);
          drawTitle(ctx, view);
          drawRows(ctx, view);
          drawTimer(ctx, view);
          copyBox(drawnPanel, panel);
        } else {
          if (title !== drawnTitle) {
            redraw(canvas, view, titleBox, () => {
              drawTitle(ctx, view);
            });
          }
          if (
            fading ||
            drawnFading ||
            session.namesVersion !== drawnNames ||
            session.current !== drawnCurrent ||
            windowPos !== drawnWindow
          ) {
            redraw(canvas, view, rowsBox, () => {
              drawRows(ctx, view);
            });
          }
          if (tenths !== drawnTenths || done !== drawnDone) {
            redraw(canvas, view, timerBox, () => {
              drawTimer(ctx, view);
            });
          }
        }
        drawnTitle = title;
        drawnNames = session.namesVersion;
        drawnCurrent = session.current;
        drawnWindow = windowPos;
        drawnTenths = tenths;
        drawnDone = done;
        drawnFading = fading;
      },
      drawGl(out, view) {
        const t = view.target("column");
        const s = view.shown("column");
        if (drawnPanel.w <= 0 || drawnPanel.h <= 0 || t.w <= 0 || t.h <= 0) {
          return;
        }
        const kx = s.w / t.w;
        const ky = s.h / t.h;
        out.panel(
          drawnPanel.x,
          drawnPanel.y,
          drawnPanel.w,
          drawnPanel.h,
          s.x + (drawnPanel.x - t.x) * kx,
          s.y + (drawnPanel.y - t.y) * ky,
          drawnPanel.w * kx,
          drawnPanel.h * ky,
          view.fade,
        );
      },
    };
  },
};
