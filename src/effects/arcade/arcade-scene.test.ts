import { describe, expect, it } from "vitest";
import { MAX_PACE, MIN_PACE } from "./arcade.meta";
import { buildAtlas, layoutLogo } from "./arcade-art";
import {
  buildScene,
  createScene,
  createView,
  MAX_SPRITES,
  meanLevel,
  STRIDE,
  wipeIn,
  WIPE_SOFT,
} from "./arcade-scene";
import { effectivePace, highScores, isWide, LOOP_SECONDS, PHASES, planDemo } from "./arcade-sim";

/** The most the frame's mean brightness may change from one frame to the next at 30 fps. */
const MAX_MEAN_STEP = 0.02;

const atlas = buildAtlas();

function view(width: number, height: number, seed = 3, title = "STAR SALVAGE", initials = "") {
  const wide = isWide(width, height);
  const logo = layoutLogo(title, width * 0.9, height * 0.3, 6);
  return createView(
    width,
    height,
    seed,
    planDemo(seed, width, height),
    logo,
    highScores(seed, initials),
    wide,
  );
}

const SIZES: [number, number][] = [
  [398, 224],
  [531, 224],
  [299, 224],
  [256, 455],
];

describe("the scene", () => {
  it.each(SIZES.flatMap(([w, h]) => [MIN_PACE, MAX_PACE].map((p) => [w, h, p] as const)))(
    "changes the mean brightness by under the cap per frame over a loop (%i x %i, pace %s)",
    (w, h, pace) => {
      const v = view(w, h);
      const scene = createScene();
      const dt = (1 / 30) * effectivePace(pace);
      let prev = -1;
      let worst = 0;
      let peak = 0;
      for (let t = 0; t < LOOP_SECONDS + 1; t += dt) {
        buildScene(scene, atlas.cells, v, t, t);
        const m = meanLevel(scene, w, h);
        if (prev >= 0) {
          worst = Math.max(worst, Math.abs(m - prev));
        }
        peak = Math.max(peak, m);
        prev = m;
      }
      expect(worst).toBeLessThan(MAX_MEAN_STEP);
      expect(peak).toBeGreaterThan(0.01);
      expect(peak).toBeLessThan(0.3);
    },
  );

  it.each(SIZES)("stays within its sprite budget and the game's bounds at %i x %i", (w, h) => {
    const v = view(w, h, 7, "WWWW WWWW WWWW W", "MMM");
    const scene = createScene();
    let most = 0;
    let nonFinite = 0;
    // The furthest any sprite reaches past each edge: its right edge to the
    // left, its left edge to the right and its top edge below.
    let leftmost = Number.POSITIVE_INFINITY;
    let rightmost = Number.NEGATIVE_INFINITY;
    let lowest = Number.NEGATIVE_INFINITY;
    for (let t = 0; t < LOOP_SECONDS; t += 0.25) {
      buildScene(scene, atlas.cells, v, t, t);
      most = Math.max(most, scene.count);
      for (let i = 0; i < scene.count; i++) {
        const o = i * STRIDE;
        const [cx, cy, hw, hh] = scene.data.subarray(o, o + 4);
        if (!Number.isFinite(cx + cy + hw + hh)) {
          nonFinite++;
        }
        leftmost = Math.min(leftmost, cx + hw);
        rightmost = Math.max(rightmost, cx - hw);
        lowest = Math.max(lowest, cy - hh);
      }
    }
    expect(most).toBeLessThan(MAX_SPRITES);
    expect(nonFinite).toBe(0);
    expect(leftmost).toBeGreaterThan(-24);
    expect(rightmost).toBeLessThan(w + 24);
    expect(lowest).toBeLessThan(h + 24);
  });

  it("keeps the demo's HUD and the table in the outer thirds at wide aspects", () => {
    const w = 398;
    const v = view(w, 224);
    expect(v.wide).toBe(true);
    for (let i = 0; i < v.rows.length; i++) {
      const x0 = v.rowX[i];
      const x1 = x0 + v.rows[i].length * 6 * v.rowScale;
      expect(x1 <= w / 3 || x0 >= (2 * w) / 3).toBe(true);
    }
    // The score and DEMO PLAY: every glyph left of a third or right of two.
    const scene = createScene();
    const demoStart = PHASES[0].seconds + 2;
    buildScene(scene, atlas.cells, v, demoStart, 0);
    const hudMiddle: number[] = [];
    for (let i = 0; i < scene.count; i++) {
      const o = i * STRIDE;
      const cx = scene.data[o];
      const cy = scene.data[o + 1];
      const hh = scene.data[o + 3];
      // Glyphs (7 px tall) in the HUD band.
      if (cy - hh < 20 && hh * 2 === 7 && cx > w / 3 && cx < (2 * w) / 3) {
        hudMiddle.push(cx);
      }
    }
    expect(hudMiddle).toEqual([]);
  });

  it("splits the table into two columns only when wide", () => {
    const narrow = view(299, 224);
    expect(narrow.wide).toBe(false);
    expect(new Set(narrow.rowX).size).toBe(1);
    const wide = view(531, 224);
    expect(new Set(wide.rowX).size).toBe(2);
  });

  it("wipes from the top down", () => {
    expect(wipeIn(0, 0)).toBe(0);
    expect(wipeIn(0, WIPE_SOFT)).toBe(1);
    expect(wipeIn(100, 50)).toBe(0);
  });
});
