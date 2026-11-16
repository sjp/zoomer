/**
 * Where the neon sign (neon.ts) puts its lettering. The tubes themselves, their
 * light on the wall, the clips and the shimmer are in `neon-tubes.ts`.
 *
 * Lengths are in frame heights.
 */
import type { NeonPosition } from "./neon.meta";

// Layout, in frame heights.
/** Gap above the sign's lettering. */
const TOP_MARGIN = 0.07;
/** Gap between the lettering and the frame's side edge. */
const SIDE_MARGIN = 0.06;
/** Largest font size, for a short phrase. */
export const MAX_FONT = 0.14;
/** Distance between line centres, in font sizes. */
export const LINE_PITCH = 1.2;
/** Tallest the lettering may be, so the sign stays in the upper part of the frame. */
const REGION_HEIGHT = 0.32;

/** Width of the lettering's region (frame heights) at this aspect ratio. */
function regionWidth(aspect: number, position: NeonPosition): number {
  if (position === "centre") {
    return Math.max(0.1, Math.min(aspect - 2 * SIDE_MARGIN, 0.62 * aspect));
  }
  return Math.max(0.1, 0.42 * aspect - SIDE_MARGIN);
}

interface SignLayout {
  /** Font size (frame heights). */
  font: number;
  /** The lettering's box: left, top, width and height (frame heights, y down). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The region the box must fit inside: left, top, width and height. */
  region: [number, number, number, number];
  /** Canvas text alignment and the x every line is anchored at (frame heights). */
  align: "left" | "center" | "right";
  anchor: number;
}

/**
 * Sizes and places the lettering: as large as `MAX_FONT` allows, shrunk so the
 * widest line fits the region's width and every line fits its height.
 * `widthsEm` are the lines' advance widths at a font size of 1.
 */
export function signLayout(
  aspect: number,
  position: NeonPosition,
  widthsEm: readonly number[],
): SignLayout {
  const lines = Math.max(1, widthsEm.length);
  const widest = Math.max(1e-3, ...widthsEm);
  const rw = regionWidth(aspect, position);
  const font = Math.min(MAX_FONT, rw / widest, REGION_HEIGHT / (lines * LINE_PITCH));
  const w = widest * font;
  const h = lines * LINE_PITCH * font;
  const rx =
    position === "left"
      ? SIDE_MARGIN
      : position === "right"
        ? aspect - SIDE_MARGIN - rw
        : 0.5 * (aspect - rw);
  const x = position === "left" ? rx : position === "right" ? rx + rw - w : 0.5 * (aspect - w);
  const align = position === "left" ? "left" : position === "right" ? "right" : "center";
  const anchor = position === "left" ? x : position === "right" ? x + w : 0.5 * aspect;
  return {
    font,
    x,
    y: TOP_MARGIN,
    w,
    h,
    region: [rx, TOP_MARGIN, rw, REGION_HEIGHT],
    align,
    anchor,
  };
}

/** The lines the sign shows, with their index (0 or 1, for the colour); empty lines are dropped. */
export function signLines(text: string): { text: string; index: number }[] {
  return text
    .split("\n")
    .map((line, index) => ({ text: line.trim(), index }))
    .filter((l) => l.text.length > 0);
}
