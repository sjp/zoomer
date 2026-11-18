import { describe, expect, it } from "vitest";
import {
  createLayout,
  DRAFT_GUST,
  DRAFT_LEAN,
  drinkFor,
  DRINKS,
  LIQUID_DROP,
  MUG_BASE_Y,
  MUG_H,
  MUG_R,
  mugDraft,
  mugLayout,
  roomFor,
  ROOMS,
  STEAM_HALF_WIDTH,
  STEAM_SCALE,
  steamGrid,
  steamRegion,
  TABLE_Y,
} from "./mug-sim";
import { DRINK_OPTIONS, POSITION_OPTIONS, ROOM_OPTIONS } from "./mug.meta";
import { STEAM_RADIUS } from "../cup-steam";

const ASPECTS = [4 / 3, 16 / 9, 21 / 9];
const POSITIONS = POSITION_OPTIONS.map((o) => o.value);

describe("mugLayout", () => {
  it("keeps the mug in its bottom corner, inside the outer third, at 4:3, 16:9 and 21:9", () => {
    for (const aspect of ASPECTS) {
      for (const pos of POSITIONS) {
        const l = mugLayout(aspect, pos, createLayout());
        const [x0, y0, x1, y1] = l.box;
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(aspect);
        expect(y0).toBeGreaterThanOrEqual(0);
        expect(y1).toBeLessThan(0.35);
        // Distance of the box's inner edge from the mug's frame edge.
        const inner = pos === "left" ? x1 : aspect - x0;
        expect(l.side).toBe(pos === "left" ? -1 : 1);
        expect(inner).toBeLessThanOrEqual(aspect / 3);
        // The mug sits on the table, its far edge behind the body.
        expect(l.baseY).toBeLessThan(TABLE_Y);
        expect(l.baseY + MUG_H).toBeGreaterThan(TABLE_Y);
      }
    }
  });

  it("puts the handle on the outer side and keeps the box around the body", () => {
    for (const aspect of ASPECTS) {
      const right = mugLayout(aspect, "right", createLayout());
      const left = mugLayout(aspect, "left", createLayout());
      // The handle side reaches further from the centre than the body.
      expect(right.box[2] - right.cx).toBeGreaterThan(MUG_R * 1.5);
      expect(left.cx - left.box[0]).toBeGreaterThan(MUG_R * 1.5);
      // Mirror images of each other.
      expect(right.box[2] - right.cx).toBeCloseTo(left.cx - left.box[0], 12);
      expect(aspect - right.cx).toBeCloseTo(left.cx, 12);
    }
  });

  it("keeps the steam box above the mug and inside the frame", () => {
    for (const aspect of ASPECTS) {
      for (const pos of POSITIONS) {
        const l = mugLayout(aspect, pos, createLayout());
        const [x0, y0, x1, y1] = l.steam;
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(aspect);
        expect(x0).toBeLessThan(l.cx - MUG_R);
        expect(x1).toBeGreaterThan(l.cx + MUG_R);
        expect(y0).toBeLessThan(l.liquidY);
        expect(y1).toBeLessThanOrEqual(1);
        expect(l.liquidY).toBeCloseTo(MUG_BASE_Y + MUG_H - LIQUID_DROP, 12);
      }
    }
  });

  it("falls back to the right for unknown positions", () => {
    expect(mugLayout(16 / 9, "middle", createLayout()).side).toBe(1);
  });
});

describe("steam space", () => {
  it("maps the steam box to sim units centred on the liquid", () => {
    for (const aspect of ASPECTS) {
      const l = mugLayout(aspect, "left", createLayout());
      const r = new Float64Array(4);
      steamRegion(l, r);
      // The source (sim origin) lies inside the region, near its bottom.
      expect(r[0]).toBeLessThan(0);
      expect(r[0] + r[2]).toBeGreaterThan(0);
      expect(r[1]).toBeLessThan(0);
      expect(-r[1] / r[3]).toBeLessThan(0.1);
      expect(r[2]).toBeCloseTo((l.steam[2] - l.steam[0]) * STEAM_SCALE, 12);
      expect(r[3]).toBeCloseTo((l.steam[3] - l.steam[1]) * STEAM_SCALE, 12);
      // The emitter fits inside the region.
      expect(STEAM_HALF_WIDTH + 3 * STEAM_RADIUS).toBeLessThan(-r[0]);
    }
  });

  it("uses the same small grid at every common aspect ratio", () => {
    const grids = ASPECTS.map((a) => {
      const g = [0, 0];
      steamGrid(mugLayout(a, "right", createLayout()), g);
      return g;
    });
    for (const g of grids) {
      expect(g).toEqual(grids[0]);
      expect(Number.isInteger(g[0]) && Number.isInteger(g[1])).toBe(true);
    }
    expect(grids[0][0] * grids[0][1]).toBeLessThan(40000);
    expect(grids[0][0]).toBeGreaterThan(50);
  });
});

describe("mugDraft", () => {
  it("is still at draft 0, and bounded otherwise", () => {
    let maxAbs = 0;
    let zero = true;
    for (let t = 0; t < 400; t += 0.37) {
      zero &&= mugDraft(0, t, 1) === 0;
      maxAbs = Math.max(maxAbs, Math.abs(mugDraft(1, t, 1)), Math.abs(mugDraft(5, t, -1)));
    }
    expect(zero).toBe(true);
    expect(maxAbs).toBeLessThanOrEqual(DRAFT_GUST + DRAFT_LEAN + 1e-12);
    expect(maxAbs).toBeGreaterThan(DRAFT_GUST * 0.5);
  });

  it("is continuous in time", () => {
    const h = 1 / 60;
    let maxStep = 0;
    let prev = mugDraft(1, 0, 1);
    for (let i = 1; i < 60 * 400; i++) {
      const v = mugDraft(1, i * h, 1);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    // Two slow sines (periods of tens of seconds): tiny changes per frame.
    expect(maxStep).toBeLessThan(0.002);
  });

  it("is calm most of the time and leans either way now and then", () => {
    let calm = 0;
    let pos = false;
    let neg = false;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const v = mugDraft(1, i * 0.1, 1) - DRAFT_LEAN;
      if (Math.abs(v) < 0.25 * DRAFT_GUST) {
        calm++;
      }
      pos ||= v > 0.5 * DRAFT_GUST;
      neg ||= v < -0.5 * DRAFT_GUST;
    }
    expect(calm / n).toBeGreaterThan(0.5);
    expect(pos && neg).toBe(true);
  });

  it("leans towards the outer side", () => {
    expect(Math.sign(mugDraft(1, 0, 1))).toBe(1);
    expect(Math.sign(mugDraft(1, 0, -1))).toBe(-1);
  });
});

describe("palettes", () => {
  it("has a look for every drink and room option, with fallbacks", () => {
    for (const o of DRINK_OPTIONS) {
      expect(DRINKS[o.value]).toBeDefined();
    }
    for (const o of ROOM_OPTIONS) {
      expect(ROOMS[o.value]).toBeDefined();
    }
    expect(drinkFor("nope")).toBe(DRINKS.tea);
    expect(roomFor("nope")).toBe(ROOMS.wall);
    expect(roomFor("__proto__")).toBe(ROOMS.wall);
    expect(new Set(Object.values(ROOMS).map((r) => r.kind)).size).toBe(3);
  });
});
