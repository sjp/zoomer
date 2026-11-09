import { describe, expect, it } from "vitest";
import {
  bakeShelves,
  layoutShelves,
  SHELF_PANEL_U,
  SHELF_ROWS,
  SHELF_TEX_H,
  SHELF_TEX_W,
  shelfBlurLod,
  shelfCoverage,
  shelfSideWidth,
  SPINE_TOP,
  SPINE_W,
  type ShelfPalette,
} from "./bookshelf";

const OAK: ShelfPalette = {
  wood: "#8a6440",
  back: "#3a2a1e",
  spines: ["#6b3a26", "#4a5a3a", "#7a2c2c", "#d8c9a3"],
};
const GREY: ShelfPalette = { wood: "#6b6254", back: "#2c2924", spines: ["#a89c84", "#8a8070"] };

describe("layoutShelves", () => {
  it("is deterministic per seed and differs between seeds", () => {
    expect(layoutShelves(42)).toEqual(layoutShelves(42));
    expect(layoutShelves(42)).not.toEqual(layoutShelves(43));
  });

  it("fills every shelf of both bookcases with well-formed spines", () => {
    let bad = 0;
    let minCover = 1;
    for (let seed = 0; seed < 100; seed++) {
      const spines = layoutShelves(seed);
      for (const s of spines) {
        const w = s.x1 - s.x0;
        if (
          s.x0 < 0 ||
          s.x1 > SHELF_PANEL_U + 1e-9 ||
          w <= 0 ||
          w > SPINE_W[1] + 1e-9 ||
          s.top < SPINE_TOP[0] ||
          s.top > SPINE_TOP[1] ||
          s.row < 0 ||
          s.row >= SHELF_ROWS
        ) {
          bad++;
        }
      }
      for (const c of shelfCoverage(spines)) {
        minCover = Math.min(minCover, c);
      }
    }
    expect(bad).toBe(0);
    expect(minCover).toBeGreaterThan(0.75);
  });

  it("keeps the spines on each shelf in order without overlapping", () => {
    let overlaps = 0;
    const spines = layoutShelves(7);
    for (let i = 1; i < spines.length; i++) {
      const a = spines[i - 1];
      const b = spines[i];
      if (a.side === b.side && a.row === b.row && b.x0 < a.x1 - 1e-9) {
        overlaps++;
      }
    }
    expect(overlaps).toBe(0);
  });
});

describe("shelfSideWidth", () => {
  it("keeps the bookcases in the outer thirds, leaving the centre clear", () => {
    for (const w of [1440, 1920, 2520, 3840]) {
      expect(shelfSideWidth(w)).toBeLessThanOrEqual(w / 3);
    }
  });
});

describe("bakeShelves", () => {
  /** The oak bake of seed 1, built once and shared by the tests (which only read it). */
  let oak: Uint8Array | undefined;
  const oakBake = () => {
    oak ??= bakeShelves(layoutShelves(1), OAK);
    return oak;
  };

  it("fills the whole texture, deterministically, and mirrors the right bookcase", () => {
    const a = oakBake();
    const b = bakeShelves(layoutShelves(1), OAK);
    expect(a.length).toBe(SHELF_TEX_W * SHELF_TEX_H * 4);
    let diff = 0;
    let opaque = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        diff++;
      }
    }
    for (let i = 3; i < a.length; i += 4) {
      if (a[i] === 255) {
        opaque++;
      }
    }
    expect(diff).toBe(0);
    expect(opaque).toBe(SHELF_TEX_W * SHELF_TEX_H);
    // Both inner panels meet at the seam, so the texels either side of it match.
    const row = Math.floor(SHELF_TEX_H / 2) * SHELF_TEX_W * 4;
    const l = row + (SHELF_TEX_W / 2 - 1) * 4;
    const r = row + (SHELF_TEX_W / 2) * 4;
    expect([a[l], a[l + 1], a[l + 2]]).toEqual([a[r], a[r + 1], a[r + 2]]);
  });

  it("changes with the palette", () => {
    const a = oakBake();
    const b = bakeShelves(layoutShelves(1), GREY);
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        diff++;
      }
    }
    expect(diff).toBeGreaterThan(a.length / 4);
  });
});

describe("shelfBlurLod", () => {
  it("rises with blur and is clamped", () => {
    expect(shelfBlurLod(0)).toBeLessThan(shelfBlurLod(1));
    expect(shelfBlurLod(-1)).toBe(shelfBlurLod(0));
    expect(shelfBlurLod(2)).toBe(shelfBlurLod(1));
  });
});
