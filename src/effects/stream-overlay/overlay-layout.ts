/**
 * Where the stream overlays go: fixed slots round the speaker, the rule that
 * settles two column overlays wanting the same side, and the ease that slides
 * an overlay to a new slot. Pure maths in device pixels, y down, with every
 * slot on whole pixels so a panel drawn at its slot copies texel for texel.
 *
 * Landscape (width ≥ height): the speaker covers the middle third from the top
 * band down to the bottom edge. A band along the top (at most 12 % of the
 * height) is split into thirds; the columns stand in the outer thirds below it.
 *
 * Portrait (width < height): the outer thirds are too narrow for a readable
 * column, so the columns move to the bottom quarter, side by side, and the
 * speaker area ends above them (on a phone-shaped frame the speaker's head and
 * shoulders sit in the middle, not at the bottom).
 */
import { smoothstep } from "../math";
import type { OverlaySide, OverlaySlot } from "./overlay-types.meta";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayLayout {
  readonly width: number;
  readonly height: number;
  /** The whole frame. */
  readonly full: Rect;
  /** Where the speaker is: nothing but the border goes in it. */
  readonly speaker: Rect;
  /** The band along the top, and its thirds. */
  readonly band: Rect;
  readonly topLeft: Rect;
  readonly topCentre: Rect;
  readonly topRight: Rect;
  /** The two column positions. */
  readonly columnLeft: Rect;
  readonly columnRight: Rect;
  /** Just inside the speaker area, for a frame drawn behind them. */
  readonly border: Rect;
  /** The outer thirds at full height, behind the columns. */
  readonly edgeLeft: Rect;
  readonly edgeRight: Rect;
  /** The gap kept between slots and from the frame's edges. */
  readonly margin: number;
}

/** Seconds an overlay takes to slide to a new slot. */
export const SLOT_EASE_SECONDS = 0.6;

/** Fraction of the height the top band may take, at most. */
export const MAX_BAND_FRACTION = 0.12;

/** A column's widest, as a fraction of the height: about 430 px at 1080p. */
const MAX_COLUMN_WIDTH = 0.4;

const rect = (x: number, y: number, w: number, h: number): Rect => ({
  x,
  y,
  w: Math.max(0, w),
  h: Math.max(0, h),
});

/** Slots for a `width` x `height` device-pixel frame. Allocates: call it on resize. */
export function computeOverlayLayout(width: number, height: number): OverlayLayout {
  const w = Number.isFinite(width) ? Math.max(1, Math.round(width)) : 1;
  const h = Number.isFinite(height) ? Math.max(1, Math.round(height)) : 1;
  const portrait = w < h;
  const margin = Math.max(1, Math.round(0.025 * Math.min(w, h)));
  const half = Math.max(1, Math.round(margin / 2));
  const x1 = Math.round(w / 3);
  const x2 = Math.round((2 * w) / 3);
  // On a tall frame 12 % of the height is a lot; keep the band in proportion to the width.
  const bandBottom = Math.round(Math.min(MAX_BAND_FRACTION * h, (portrait ? 0.2 : 1) * w));
  const band = rect(margin, margin, w - 2 * margin, bandBottom - margin);
  const topLeft = rect(margin, margin, x1 - half - margin, band.h);
  const topCentre = rect(x1 + half, margin, x2 - x1 - 2 * half, band.h);
  const topRight = rect(x2 + half, margin, w - margin - x2 - half, band.h);

  let speaker: Rect;
  let columnLeft: Rect;
  let columnRight: Rect;
  if (portrait) {
    const top = Math.round(0.75 * h);
    speaker = rect(x1, bandBottom, x2 - x1, top - bandBottom);
    const mid = Math.round(w / 2);
    const y = top + half;
    columnLeft = rect(margin, y, mid - half - margin, h - margin - y);
    columnRight = rect(mid + half, y, w - margin - mid - half, h - margin - y);
  } else {
    speaker = rect(x1, bandBottom, x2 - x1, h - bandBottom);
    const colW = Math.min(x1 - half - margin, Math.round(MAX_COLUMN_WIDTH * h));
    const y = bandBottom + margin;
    columnLeft = rect(margin, y, colW, h - margin - y);
    columnRight = rect(w - margin - colW, y, colW, h - margin - y);
  }
  const border = rect(
    speaker.x + margin,
    speaker.y + margin,
    speaker.w - 2 * margin,
    speaker.h - 2 * margin,
  );
  return {
    width: w,
    height: h,
    full: rect(0, 0, w, h),
    speaker,
    band,
    topLeft,
    topCentre,
    topRight,
    columnLeft,
    columnRight,
    border,
    edgeLeft: rect(0, 0, x1, h),
    edgeRight: rect(x2, 0, w - x2, h),
    margin,
  };
}

/**
 * The layout's rect for `slot`: for `column`, the column on `side`; for
 * `edges`, the whole frame (an edges overlay draws only within `edgeLeft` and
 * `edgeRight`). Returns the layout's own object, so it allocates nothing.
 */
export function slotRect(layout: OverlayLayout, slot: OverlaySlot, side: OverlaySide): Rect {
  if (slot === "column") {
    return side === "left" ? layout.columnLeft : layout.columnRight;
  }
  return slot === "edges" ? layout.full : layout[slot];
}

/**
 * Settles the column overlays' sides. `wanted` holds each column overlay's
 * chosen side and `occupying` whether it is on (or still fading out), both in
 * registration order. Writes each one's side to `out`, or null for one that
 * isn't occupying a column: the earlier of two wanting the same side keeps it
 * and the later moves to the other. A third would share a side with one of
 * them (there are only two columns). Allocates nothing.
 */
export function assignColumns(
  wanted: readonly OverlaySide[],
  occupying: readonly boolean[],
  out: (OverlaySide | null)[],
): void {
  let left = false;
  let right = false;
  for (let i = 0; i < wanted.length; i++) {
    if (!occupying[i]) {
      out[i] = null;
      continue;
    }
    const want = wanted[i];
    const wantFree = want === "left" ? !left : !right;
    const otherFree = want === "left" ? !right : !left;
    const side: OverlaySide = wantFree || !otherFree ? want : want === "left" ? "right" : "left";
    if (side === "left") {
      left = true;
    } else {
      right = true;
    }
    out[i] = side;
  }
}

/** Which slots are in use, for `freeCentre`. */
export interface SlotUse {
  left: boolean;
  right: boolean;
  /** Any of the top band's thirds. */
  top: boolean;
}

/**
 * Writes to `out` the centred rect that stays clear of the slots in `use`,
 * for a scene's own centred content (a title card): between the columns (the
 * same inset both sides, so it stays centred) and below the band where they
 * are in use, otherwise inside the frame's margin. Allocates nothing.
 */
export function freeCentre(layout: OverlayLayout, use: SlotUse, out: Rect): Rect {
  const { width: w, height: h, margin } = layout;
  const portrait = w < h;
  let inset = margin;
  let bottom = h - margin;
  if (portrait) {
    if (use.left || use.right) {
      bottom = layout.columnLeft.y - margin;
    }
  } else {
    if (use.left) {
      inset = Math.max(inset, layout.columnLeft.x + layout.columnLeft.w + margin);
    }
    if (use.right) {
      inset = Math.max(inset, w - layout.columnRight.x + margin);
    }
  }
  const top = use.top ? layout.band.y + layout.band.h + margin : margin;
  out.x = inset;
  out.y = top;
  out.w = Math.max(0, w - 2 * inset);
  out.h = Math.max(0, bottom - top);
  return out;
}

/** Whether two rects share any area (touching edges don't count). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * An overlay's shown rect, sliding to a new target over `SLOT_EASE_SECONDS`
 * with an ease in and out. A new target mid-slide starts from where it is.
 */
interface RectEase {
  /** Where to draw it now; whole pixels once it has arrived. */
  readonly rect: Readonly<Rect>;
  /** Whether it is still sliding. */
  readonly moving: boolean;
  /** Slides to `target` (copied), or jumps there with `snap` (a resize, the first placement). */
  set: (target: Readonly<Rect>, snap: boolean) => void;
  /** Advances the slide by `dt` seconds. */
  step: (dt: number) => void;
}

export function createRectEase(duration = SLOT_EASE_SECONDS): RectEase {
  const from = rect(0, 0, 0, 0);
  const to = rect(0, 0, 0, 0);
  const now = rect(0, 0, 0, 0);
  let t = 1;
  const copy = (dst: Rect, src: Readonly<Rect>) => {
    dst.x = src.x;
    dst.y = src.y;
    dst.w = src.w;
    dst.h = src.h;
  };
  return {
    rect: now,
    get moving() {
      return t < 1;
    },
    set(target, snap) {
      if (
        !snap &&
        target.x === to.x &&
        target.y === to.y &&
        target.w === to.w &&
        target.h === to.h
      ) {
        return;
      }
      copy(to, target);
      if (snap || duration <= 0) {
        copy(now, target);
        t = 1;
        return;
      }
      copy(from, now);
      t = 0;
    },
    step(dt) {
      if (t >= 1) {
        return;
      }
      t = Math.min(1, t + (Number.isFinite(dt) && dt > 0 ? dt : 0) / duration);
      if (t >= 1) {
        copy(now, to);
        return;
      }
      const e = smoothstep(0, 1, t);
      now.x = from.x + (to.x - from.x) * e;
      now.y = from.y + (to.y - from.y) * e;
      now.w = from.w + (to.w - from.w) * e;
      now.h = from.h + (to.h - from.h) * e;
    },
  };
}
