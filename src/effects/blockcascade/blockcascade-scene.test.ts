import { describe, expect, it } from "vitest";
import { MAX_MEAN_STEP } from "../motion-limits";
import {
  buildWell,
  createLayout,
  createScene,
  layoutWells,
  MAX_SPRITES,
  meanLevel,
  STRIDE,
} from "./blockcascade-scene";
import { CLEARDOWN_HEIGHT, createWell, stepWell, type Well, WELL_W } from "./blockcascade-sim";

/** Every colour as white: the brightest cells can be, for a worst-case brightness budget. */
const WHITE = [1, 1, 1, 1, 1, 1];

/** Steps `well` drop by drop until one clears at least `rows` rows. */
function untilClear(well: Well, rows: number) {
  for (let i = 0; i < 50_000 && well.drop.clearedCount < rows; i++) {
    stepWell(well, well.drop.end - well.time, 2, 1);
  }
  expect(well.drop.clearedCount).toBeGreaterThanOrEqual(rows);
}

/** The worst change in the frame's mean brightness between 30 fps frames over the current drop. */
function worstMeanStep(wells: Well[], width: number, height: number) {
  const layout = layoutWells(width, height, wells.length === 2, createLayout());
  const scene = createScene();
  const end = Math.max(...wells.map((w) => w.drop.end));
  let prev = -1;
  let worst = 0;
  for (let t = 0; t < end; t += 1 / 30) {
    scene.count = 0;
    wells.forEach((w, k) => {
      w.time = Math.min(t, w.drop.end - 1e-6);
      buildWell(scene, w, layout.boxes[k], layout.cell, 1);
    });
    const m = meanLevel(scene, WHITE, width, height);
    if (prev >= 0) {
      worst = Math.max(worst, Math.abs(m - prev));
    }
    prev = m;
  }
  return worst;
}

describe("the layout", () => {
  it.each([
    [1920, 1080],
    [1280, 720],
    [2560, 1080],
    [3840, 1080],
    [1440, 1080],
  ])("keeps both wells and their headers in the outer thirds at %i x %i", (w, h) => {
    const layout = layoutWells(w, h, true, createLayout());
    expect(layout.count).toBe(2);
    for (const b of layout.boxes) {
      const x0 = b.headerX;
      const x1 = b.headerX + b.headerW;
      expect(x1 <= w / 3 || x0 >= (2 * w) / 3).toBe(true);
      expect(x0).toBeGreaterThan(0);
      expect(x1).toBeLessThan(w);
      // The framed well's height is about 80% of the frame's, all of it inside.
      expect(b.headerY).toBeGreaterThan(0);
      expect(b.y + 18 * layout.cell + layout.pad).toBeLessThan(h);
    }
    // About 80% of the frame's height where the thirds are wide enough.
    expect((18 * layout.cell) / h).toBeGreaterThan(w / h >= 16 / 9 ? 0.7 : 0.5);
  });

  it.each([
    [1080, 1920],
    [1080, 1080],
    [1000, 900],
  ])("shows one well, centred and inside the frame, at %i x %i", (w, h) => {
    const layout = layoutWells(w, h, true, createLayout());
    expect(layout.count).toBe(1);
    const b = layout.boxes[0];
    expect(b.headerX + b.headerW / 2).toBeCloseTo(w / 2);
    expect(b.headerX).toBeGreaterThan(0);
    expect(b.headerY).toBeGreaterThan(0);
    expect(b.y + 18 * layout.cell + layout.pad).toBeLessThan(h);
  });

  it("sits low in a portrait frame", () => {
    const layout = layoutWells(1080, 1920, true, createLayout());
    const b = layout.boxes[0];
    expect(b.headerY).toBeGreaterThan(1920 * 0.25);
    expect(b.y + 18 * layout.cell + layout.pad).toBeGreaterThan(1920 * 0.9);
  });

  it("centres one well when asked, at any aspect", () => {
    const layout = layoutWells(1920, 1080, false, createLayout());
    expect(layout.count).toBe(1);
    const b = layout.boxes[0];
    expect(b.x + (WELL_W / 2) * layout.cell).toBeCloseTo(960);
  });
});

describe("the scene", () => {
  it.each([
    [1920, 1080],
    [2560, 1080],
    [1080, 1920],
  ])(
    "changes the mean brightness by under the cap per frame through a four-row clear (%i x %i)",
    (w, h) => {
      const a = createWell(1, 0, 2, 1);
      untilClear(a, 4);
      const b = createWell(1, 0, 2, 1);
      untilClear(b, 4);
      // Both wells clearing four rows at once, worst case.
      const worst = worstMeanStep(w > h ? [a, b] : [a], w, h);
      expect(worst).toBeGreaterThan(0);
      expect(worst).toBeLessThan(MAX_MEAN_STEP);
    },
  );

  it("changes the mean brightness by under the cap through a clear-down", () => {
    const wells = [createWell(4, 0, 2, 1), createWell(4, 1, 2, 1)];
    for (const well of wells) {
      for (let i = 0; i < 1000 && well.drop.piece >= 0; i++) {
        // Fill the board high, with a hole per row, so the next drop is a clear-down.
        well.board.fill(0);
        for (let y = 0; y < CLEARDOWN_HEIGHT + 2; y++) {
          for (let x = 0; x < WELL_W; x++) {
            well.board[y * WELL_W + x] = x === (y * 4) % WELL_W ? 0 : 1 + (x % 6);
          }
        }
        stepWell(well, well.drop.end - well.time, 2, 1);
      }
      expect(well.drop.piece).toBe(-1);
      expect(well.drop.clearedCount).toBeGreaterThanOrEqual(5);
    }
    expect(worstMeanStep(wells, 1920, 1080)).toBeLessThan(MAX_MEAN_STEP);
  });

  it("stays within its sprite budget with full wells", () => {
    const layout = layoutWells(1920, 1080, true, createLayout());
    const scene = createScene();
    for (let k = 0; k < 2; k++) {
      const well = createWell(2, k, 2, 0.5);
      well.board.fill(3);
      well.time = 0.1;
      buildWell(scene, well, layout.boxes[k], layout.cell, 1);
    }
    expect(scene.count).toBeLessThanOrEqual(MAX_SPRITES);
    for (let i = 0; i < scene.count; i++) {
      expect(Number.isFinite(scene.data[i * STRIDE] + scene.data[i * STRIDE + 1])).toBe(true);
    }
  });
});
