/**
 * The chat column overlay: a translucent panel down one side with a thin
 * header and a made-up live chat (from `chat-feed.ts`). Each line has an
 * optional badge, the viewer's name in its own colour, then the message, which
 * may wrap to two lines and show emotes inline (`emote-art.ts`). The layer's
 * shared stream events (follows, subs, gifts, hosts) show as highlighted
 * lines among the messages.
 *
 * The chat never scrolls continuously. When the feed brings new lines in, the
 * message area is redrawn once at its new resting state; for the next quarter
 * second the GPU shows that drawing offset downwards by the new lines' height,
 * easing to rest, with the new lines fading in. So the column steps up by a
 * line and sits still, and the canvas is touched once per step.
 *
 * That needs the panel's background apart from its text. The canvas holds,
 * top to bottom in the column: the header (the top of the panel, with the
 * title), the messages on a clear background (with room above them for the
 * lines pushed out of view during a step), and the footer (the bottom of the
 * panel). On screen the panel is the header, a one-pixel row of the header's
 * plain background stretched down behind the messages, and the footer, with
 * the messages drawn over them in horizontal bands: the top few bands fade
 * out the oldest lines, and the bottom band fades the new ones in.
 */
import { smoothstep } from "../math";
import type { AnyParamValues } from "../types";
import {
  CHAT_BADGE_COUNT,
  CHAT_MAX_BATCH,
  CHAT_PREFILL,
  chatEventLine,
  type ChatMessage,
  chatMessage,
  type ChatToken,
  chatTokens,
  createChatFeed,
  parseChatLines,
} from "./chat-feed";
import { chatMeta } from "./chat.meta";
import { paintEmote } from "./emote-art";
import type { OverlayCanvas, OverlayDefinition, OverlayView } from "./overlay-layer";
import {
  cssRgba,
  drawPanel,
  fillLine,
  overlayFont,
  PANEL_MUTED,
  PANEL_PADDING,
  PANEL_TEXT,
  usernameColour,
} from "./overlay-text";

type Ctx = OffscreenCanvasRenderingContext2D;

/** The chat's seed: every scene shows the same made-up regulars. */
const SEED = 0x5eed;

/** Event lines waiting beyond this many (after a burst) are dropped, oldest first. */
const MAX_WAITING_EVENTS = 4;

/** Sizes at 1080p. */
const HEADER = 40;
const TITLE_FONT = 17;
const FOOTER = 14;
const LINE = 24;
const MESSAGE_GAP = 6;
const FONT = 16;
const EMOTE = 22;
const BADGE = 12;
/** Height of the fade at the top of the messages, and how many bands it is drawn in. */
const FADE = 44;
const FADE_BANDS = 8;

/** Seconds the column takes to step up, and a new line to fade in. */
export const CHAT_STEP_EASE_SECONDS = 0.25;
const NEW_FADE_SECONDS = 0.4;

/** Lines kept, newest last: more than the tallest column shows. */
const HISTORY = 40;

/** Badge colours, by shape (1 to `CHAT_BADGE_COUNT`); the first takes the accent. */
const BADGE_COLOURS = ["", "#5cc8ff", "#ffc94a", "#6fe38a"];

/** A run of words, or an emote, of a laid-out chat line. */
interface Placed {
  /** Left edge, from the message area's inner left. */
  readonly x: number;
  /** 0 or 1. */
  readonly line: number;
  /** The words (or the emote's `:id:`). */
  text: string;
  /** The emote's index, or -1 for words. */
  readonly emote: number;
  /** Width the run may take before it is cut with an ellipsis. */
  maxWidth: number;
}

/** A message, with its layout for the current width and scale. */
interface Entry {
  readonly message: ChatMessage;
  readonly tokens: ChatToken[];
  /** The layout below is for this layout version (`layoutVersion`), or stale. */
  version: number;
  lines: number;
  /** Room the name (and its colon) takes after the badge. */
  nameWidth: number;
  /** The words and emotes after the name. */
  placed: Placed[];
}

/** A param's value as text or a finite number, or `fallback`. */
const text = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
const number = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** The width of `words` in the context's font, or 0 where it gives no metrics. */
function width(ctx: Ctx, words: string): number {
  return (ctx.measureText(words) as TextMetrics | undefined)?.width ?? 0;
}

/** Sizes at the current scale, in whole device pixels. */
interface Metrics {
  readonly s: number;
  readonly header: number;
  readonly footer: number;
  readonly line: number;
  readonly gap: number;
  readonly pad: number;
  readonly badge: number;
  readonly emote: number;
  readonly fade: number;
  /** The most a step can bring in: two two-line messages. */
  readonly room: number;
}

function metrics(s: number): Metrics {
  const line = Math.max(1, Math.round(LINE * s));
  const gap = Math.max(1, Math.round(MESSAGE_GAP * s));
  return {
    s,
    header: Math.max(4, Math.round(HEADER * s)),
    footer: Math.max(2, Math.round(FOOTER * s)),
    line,
    gap,
    pad: Math.round(PANEL_PADDING * s),
    badge: Math.max(1, Math.round(BADGE * s)),
    emote: Math.max(1, Math.round(EMOTE * s)),
    fade: Math.round(FADE * s),
    room: CHAT_MAX_BATCH * (2 * line + gap),
  };
}

/** A laid-out chat line: how many lines it takes, and its runs of words and emotes. */
interface WrappedChat {
  lines: number;
  placed: Placed[];
}

/**
 * Wraps a message's `tokens` into at most two lines `inner` wide, the first
 * starting at `start` (after the badge and name). Neighbouring words on a line
 * join into one run, measured whole with `measure` so the font's own spacing
 * and kerning hold; an emote is `emote` wide. What doesn't fit on the second
 * line is cut: a word with an ellipsis (`fitText` does that when drawn, given
 * the room left as `maxWidth`) if at least two `em` are left, otherwise an
 * ellipsis alone. Allocates.
 */
export function wrapChatTokens(
  tokens: readonly ChatToken[],
  start: number,
  inner: number,
  measure: (text: string) => number,
  emote: number,
  em: number,
): WrappedChat {
  const space = measure(" ") || 0.28 * em;
  const placed: Placed[] = [];
  let line = 0;
  let x = start;
  /** The run of words being built on this line, if the last thing placed was a word. */
  let run: Placed | null = null;
  for (const token of tokens) {
    if (token.emote < 0 && run !== null) {
      // Join the run, measured whole.
      const joined = `${run.text} ${token.text}`;
      const w = measure(joined);
      if (run.x + w <= inner) {
        run.text = joined;
        run.maxWidth = w + 1;
        x = run.x + w;
        continue;
      }
      if (line === 1) {
        // Cut within the run.
        run.text = joined;
        run.maxWidth = inner - run.x;
        break;
      }
    }
    const w = token.emote >= 0 ? emote : measure(token.text);
    let at = x === 0 ? 0 : x + space;
    if (at + w > inner && line === 0 && x > 0) {
      line = 1;
      at = 0;
    }
    if (at + w > inner) {
      // It doesn't fit on the last line: cut it, or mark the cut.
      const room = inner - at;
      if (token.emote < 0 && room > 2 * em) {
        placed.push({ x: at, line, text: token.text, emote: -1, maxWidth: room });
      } else if (room >= measure("…")) {
        placed.push({ x: at, line, text: "…", emote: -1, maxWidth: room });
      }
      break;
    }
    const item: Placed = { x: at, line, text: token.text, emote: token.emote, maxWidth: w + 1 };
    placed.push(item);
    run = token.emote < 0 ? item : null;
    x = at + w;
  }
  return { lines: line + 1, placed };
}

/** Lays out `entry` for an inner width of `inner`, measuring with `ctx` (0 without metrics). */
function layOut(ctx: Ctx, entry: Entry, inner: number, m: Metrics): void {
  const msg = entry.message;
  const em = FONT * m.s;
  let x = msg.badge > 0 ? m.badge + Math.round(5 * m.s) : 0;
  ctx.font = overlayFont(em, 700);
  entry.nameWidth = Math.max(
    0,
    Math.min(width(ctx, msg.event ? msg.name : `${msg.name}:`), inner - x),
  );
  x += entry.nameWidth;
  ctx.font = overlayFont(em, msg.event ? 600 : 400);
  const wrapped = wrapChatTokens(entry.tokens, x, inner, (t) => width(ctx, t), m.emote, em);
  entry.placed = wrapped.placed;
  entry.lines = wrapped.lines;
}

/** Draws badge `shape` (1 to `CHAT_BADGE_COUNT`) centred on (`cx`, `cy`), `size` across. */
function drawBadge(ctx: Ctx, shape: number, cx: number, cy: number, size: number, accent: string) {
  const r = size / 2;
  ctx.beginPath();
  if (shape === 1) {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  } else if (shape === 2) {
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
  } else if (shape === 3) {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? r * 1.1 : r * 0.48;
      ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
  } else {
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  }
  ctx.closePath();
  ctx.fillStyle = shape === 1 ? accent : BADGE_COLOURS[(shape - 1) % CHAT_BADGE_COUNT];
  ctx.fill();
}

export const chatOverlay: OverlayDefinition = {
  meta: chatMeta,
  create({ events }) {
    const feed = createChatFeed(SEED);
    const entries: Entry[] = [];
    /** Event lines from the stream, waiting for the column's next step. */
    const waiting: ChatMessage[] = [];
    let ownText: string | null = null;
    let own: string[] = [];

    let title = "";
    let drawnTitle: string | null = null;
    /** Lines brought in since the messages were last drawn. */
    let pending = 0;

    // The step under way: its height, and how far through it and the new lines' fade are.
    let stepHeight = 0;
    let stepT = 1;
    let fadeT = 1;
    /** Height of the newest lines, fading in. */
    let newHeight = 0;

    let m = metrics(1);
    /** Bumped when the width or scale changes, so each message is laid out again. */
    let layoutVersion = 0;
    let layoutWidth = -1;
    let layoutScale = -1;
    /** Whether the canvas holds a drawing yet. */
    let drawn = false;
    /** Band edges, scratch for `drawGl`. */
    const cuts = new Float64Array(FADE_BANDS + 4);

    const add = (message: ChatMessage) => {
      entries.push({
        message,
        tokens: chatTokens(message.text),
        version: -1,
        lines: 1,
        nameWidth: 0,
        placed: [],
      });
      if (entries.length > HISTORY) {
        entries.shift();
      }
    };

    const entryHeight = (e: Entry) => e.lines * m.line + m.gap;

    const ensureLayout = (ctx: Ctx, e: Entry, inner: number) => {
      if (e.version !== layoutVersion) {
        layOut(ctx, e, inner, m);
        e.version = layoutVersion;
      }
    };

    const drawHeader = (canvas: OverlayCanvas, view: OverlayView) => {
      const ctx = canvas.ctx;
      const t = view.target("column");
      canvas.clear(t.x, t.y, t.w, m.header);
      ctx.save();
      ctx.beginPath();
      ctx.rect(t.x, t.y, t.w, m.header);
      ctx.clip();
      drawPanel(ctx, t.x, t.y, t.w, t.h, m.s, view.opacity, view.accent);
      // A small live dot, then the title.
      const cy = t.y + Math.round((m.header + 3 * m.s) / 2);
      const dot = Math.max(1, Math.round(4 * m.s));
      ctx.fillStyle = "#ff5a6e";
      ctx.beginPath();
      ctx.arc(t.x + m.pad + dot, cy, dot, 0, Math.PI * 2);
      ctx.fill();
      const left = t.x + m.pad + 2 * dot + Math.round(8 * m.s);
      fillLine(
        ctx,
        title,
        left,
        cy,
        overlayFont(TITLE_FONT * m.s, 600),
        PANEL_TEXT,
        t.x + t.w - m.pad - left,
      );
      ctx.restore();
      drawnTitle = title;
    };

    const drawFooter = (canvas: OverlayCanvas, view: OverlayView) => {
      const ctx = canvas.ctx;
      const t = view.target("column");
      const y = t.y + t.h - m.footer;
      canvas.clear(t.x, y, t.w, m.footer);
      ctx.save();
      ctx.beginPath();
      ctx.rect(t.x, y, t.w, m.footer);
      ctx.clip();
      drawPanel(ctx, t.x, t.y, t.w, t.h, m.s, view.opacity, view.accent);
      ctx.restore();
    };

    /** Draws one message with its top at `y`. */
    const drawEntry = (
      ctx: Ctx,
      e: Entry,
      left: number,
      inner: number,
      y: number,
      view: OverlayView,
    ) => {
      const msg = e.message;
      const s = m.s;
      const h = entryHeight(e);
      const lineY = (line: number) => y + m.gap / 2 + (line + 0.5) * m.line;
      if (msg.event) {
        ctx.fillStyle = cssRgba(view.accent, 0.24);
        ctx.beginPath();
        ctx.roundRect(left - m.pad / 2, y + 1, inner + m.pad, h - 2, 6 * s);
        ctx.fill();
        ctx.fillStyle = view.accent;
        ctx.fillRect(
          left - m.pad / 2,
          Math.round(y + 5 * s),
          Math.max(1, Math.round(3 * s)),
          Math.round(h - 10 * s),
        );
      }
      let x = left;
      if (msg.badge > 0) {
        drawBadge(ctx, msg.badge, x + m.badge / 2, lineY(0), m.badge, view.accent);
        x += m.badge + Math.round(5 * s);
      }
      const bold = overlayFont(FONT * s, 700);
      const font = overlayFont(FONT * s, msg.event ? 600 : 400);
      fillLine(ctx, msg.name, x, lineY(0), bold, usernameColour(msg.name), e.nameWidth + 1);
      if (!msg.event) {
        ctx.font = bold;
        const nameOnly = Math.min(width(ctx, msg.name), e.nameWidth);
        fillLine(ctx, ":", x + nameOnly, lineY(0), bold, PANEL_MUTED, inner);
      }
      for (const p of e.placed) {
        const cy = lineY(p.line);
        if (p.emote >= 0) {
          ctx.save();
          ctx.translate(Math.round(left + p.x), Math.round(cy - m.emote / 2));
          paintEmote(ctx, p.emote, m.emote);
          ctx.restore();
        } else {
          fillLine(ctx, p.text, left + p.x, cy, font, PANEL_TEXT, p.maxWidth);
        }
      }
    };

    /** Redraws the message area at rest: newest at the bottom, up into the room above the view. */
    const drawMessages = (canvas: OverlayCanvas, view: OverlayView) => {
      const ctx = canvas.ctx;
      const t = view.target("column");
      const top = t.y + m.header;
      const bottom = t.y + t.h - m.footer;
      canvas.clear(t.x, top, t.w, bottom - top);
      if (bottom <= top) {
        return;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(t.x, top, t.w, bottom - top);
      ctx.clip();
      const left = t.x + m.pad;
      const inner = t.w - 2 * m.pad;
      let y = bottom;
      for (let i = entries.length - 1; i >= 0 && y > top; i--) {
        const e = entries[i];
        ensureLayout(ctx, e, inner);
        y -= entryHeight(e);
        drawEntry(ctx, e, left, inner, y, view);
      }
      ctx.restore();
    };

    return {
      update(dt: number, values: Readonly<AnyParamValues>, view: OverlayView) {
        const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
        const lines = text(values.chatLines, "");
        if (lines !== ownText) {
          ownText = lines;
          own = parseChatLines(lines);
        }
        if (entries.length === 0) {
          for (let i = Math.max(0, CHAT_PREFILL - HISTORY); i < CHAT_PREFILL; i++) {
            add(chatMessage(SEED, i, own));
          }
        }
        for (const e of events.fresh) {
          waiting.push(chatEventLine(e));
          if (waiting.length > MAX_WAITING_EVENTS) {
            waiting.shift();
          }
        }
        const n = feed.step(step, number(values.chatBusy, 0.3), waiting.length);
        const shown = feed.events;
        for (let i = feed.released - (n - shown); i < feed.released; i++) {
          add(chatMessage(SEED, i, own));
        }
        for (let i = 0; i < shown; i++) {
          const line = waiting.shift();
          if (line !== undefined) {
            add(line);
          }
        }
        pending = Math.min(HISTORY, pending + n);
        title = text(values.chatTitle, "");
        stepT = Math.min(1, stepT + step / CHAT_STEP_EASE_SECONDS);
        fadeT = Math.min(1, fadeT + step / NEW_FADE_SECONDS);
        const s = view.scale;
        if (s !== m.s) {
          m = metrics(s);
        }
      },
      draw2d(canvas, view, full) {
        const t = view.target("column");
        if (t.w !== layoutWidth || m.s !== layoutScale) {
          layoutWidth = t.w;
          layoutScale = m.s;
          layoutVersion++;
        }
        if (full) {
          drawHeader(canvas, view);
          drawMessages(canvas, view);
          drawFooter(canvas, view);
          pending = 0;
          stepT = 1;
          fadeT = 1;
          drawn = true;
          return;
        }
        if (title !== drawnTitle) {
          drawHeader(canvas, view);
        }
        if (pending > 0) {
          const inner = t.w - 2 * m.pad;
          let h = 0;
          for (let i = Math.max(0, entries.length - pending); i < entries.length; i++) {
            ensureLayout(canvas.ctx, entries[i], inner);
            h += entryHeight(entries[i]);
          }
          drawMessages(canvas, view);
          newHeight = h;
          stepHeight = Math.min(h, m.room);
          stepT = 0;
          fadeT = 0;
          pending = 0;
        }
      },
      drawGl(out, view) {
        if (!drawn) {
          return;
        }
        const t = view.target("column");
        const shown = view.shown("column");
        if (t.w <= 0 || t.h <= 0) {
          return;
        }
        const kx = shown.w / t.w;
        const ky = shown.h / t.h;
        const fade = view.fade;
        const top = t.y + m.header;
        const bottom = t.y + t.h - m.footer;
        const visible = Math.max(0, bottom - top - m.room);
        const viewTop = bottom - visible;
        const dw = t.w * kx;
        // Local y (from the panel's top) to the screen.
        const at = (y: number) => shown.y + y * ky;

        out.panel(t.x, t.y, t.w, m.header, shown.x, at(0), dw, m.header * ky, fade);
        if (visible > 0) {
          // A plain row near the bottom of the header, stretched behind the messages.
          out.panel(t.x, top - 2, t.w, 1, shown.x, at(m.header), dw, visible * ky, fade);
        }
        out.panel(
          t.x,
          bottom,
          t.w,
          m.footer,
          shown.x,
          at(m.header + visible),
          dw,
          m.footer * ky,
          fade,
        );
        if (visible <= 0) {
          return;
        }

        const offset = stepT < 1 ? stepHeight * (1 - smoothstep(0, 1, stepT)) : 0;
        const newAlpha = fadeT < 1 ? smoothstep(0, 1, fadeT) : 1;
        // Where the new lines start, in local y.
        const newTop = fadeT < 1 ? bottom - newHeight - viewTop + m.header + offset : Infinity;
        const end = m.header + visible;
        const fadeEnd = m.header + Math.min(m.fade, visible);
        let n = 0;
        cuts[n++] = m.header;
        for (let j = 1; j <= FADE_BANDS; j++) {
          cuts[n++] = m.header + Math.round(((fadeEnd - m.header) * j) / FADE_BANDS);
        }
        if (newTop > fadeEnd && newTop < end) {
          cuts[n++] = newTop;
        }
        cuts[n++] = end;
        for (let i = 0; i + 1 < n; i++) {
          const a = cuts[i];
          const b = cuts[i + 1];
          if (b <= a) {
            continue;
          }
          const mid = (a + b) / 2;
          const edge =
            mid < fadeEnd
              ? (Math.floor(((mid - m.header) * FADE_BANDS) / (fadeEnd - m.header)) + 1) /
                (FADE_BANDS + 1)
              : 1;
          const alpha = fade * edge * (mid >= newTop ? newAlpha : 1);
          // The canvas row shown at local y `a`, kept within the message area.
          const src = a - m.header - offset + viewTop;
          const from = Math.max(src, top);
          const y0 = a + (from - src);
          if (b <= y0) {
            continue;
          }
          out.panel(t.x, from, t.w, b - y0, shown.x, at(y0), dw, (b - y0) * ky, alpha);
        }
      },
    };
  },
};
