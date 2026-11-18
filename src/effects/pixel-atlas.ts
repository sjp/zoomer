/**
 * Pixel-art sprite atlases: sprites written as rows of palette digits ("."
 * transparent), packed in rows into one RGBA8 texture for drawing with nearest
 * sampling. Pure, so the art and its brightness can be tested.
 */
import { hexToRgb } from "./color";

/** A sprite: rows of palette digits (0-9 then a-z), "." (or any other character) transparent. */
export type PixelGrid = readonly string[];

/** One sprite in the atlas: its rect (px, y down) and its mean luminance over the rect. */
export interface AtlasCell {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Mean luminance (0..1) of the cell, transparent texels counting as black. */
  lum: number;
}

interface PixelAtlas {
  width: number;
  height: number;
  /** RGBA8, rows top first, straight alpha (0 or 255). */
  pixels: Uint8Array;
  cells: AtlasCell[];
}

/** Rec. 601 luma of 0-255 channels, 0..1. */
export const luma = (r: number, g: number, b: number) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

/**
 * Packs `grids` into an atlas `width` px wide, in rows, with `pad` transparent
 * px round each cell (so a scaled or rotated sprite never samples its
 * neighbour). Digit `d` of a grid takes `palette[d]`; digits past the palette's
 * end are transparent.
 */
export function packPixelAtlas(
  grids: readonly PixelGrid[],
  palette: readonly string[],
  width: number,
  pad: number,
): PixelAtlas {
  const cells: AtlasCell[] = [];
  let x = pad;
  let y = pad;
  let rowH = 0;
  for (const g of grids) {
    const w = Math.max(...g.map((r) => r.length));
    const h = g.length;
    if (x + w + pad > width) {
      x = pad;
      y += rowH + pad;
      rowH = 0;
    }
    cells.push({ x, y, w, h, lum: 0 });
    x += w + pad;
    rowH = Math.max(rowH, h);
  }
  const height = y + rowH + pad;
  const pixels = new Uint8Array(width * height * 4);
  const rgb = palette.map((hex) => hexToRgb(hex));
  grids.forEach((g, i) => {
    const cell = cells[i];
    let sum = 0;
    g.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const digit = Number.parseInt(row[rx], 36);
        if (!(digit < rgb.length)) {
          continue;
        }
        const [r, gr, b] = rgb[digit];
        const o = ((cell.y + ry) * width + cell.x + rx) * 4;
        pixels[o] = r;
        pixels[o + 1] = gr;
        pixels[o + 2] = b;
        pixels[o + 3] = 255;
        sum += luma(r, gr, b);
      }
    });
    cell.lum = sum / (cell.w * cell.h);
  });
  return { width, height, pixels, cells };
}
