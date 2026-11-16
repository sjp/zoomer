import { describe, expect, it } from "vitest";
import { OVERLAY_METAS } from "../stream-overlay/overlay-params.meta";
import {
  computeOverlayLayout,
  freeCentre,
  type Rect,
  rectsOverlap,
  type SlotUse,
} from "../stream-overlay/overlay-layout";
import {
  CARD_TITLES,
  createCardLayout,
  layoutCard,
  titleLines,
  toCardId,
} from "./startingsoon-card";

const ASPECTS = [
  ["16:9", 1920, 1080],
  ["4:3", 1440, 1080],
  ["21:9", 2520, 1080],
  ["9:16", 1080, 1920],
] as const;

/**
 * The slots each combination of overlays uses: a column overlay alone can
 * stand on either side, so it gives both cases.
 */
function overlayUses(): { name: string; use: SlotUse }[] {
  const out: { name: string; use: SlotUse }[] = [];
  const n = OVERLAY_METAS.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const on = OVERLAY_METAS.filter((_, i) => (mask & (1 << i)) !== 0);
    const columns = on.filter((m) => m.slots.includes("column")).length;
    const top = on.some((m) => m.slots.some((s) => s.startsWith("top")));
    const name = on.length > 0 ? on.map((m) => m.id).join("+") : "none";
    if (columns === 1) {
      out.push({ name: `${name} (left)`, use: { left: true, right: false, top } });
      out.push({ name: `${name} (right)`, use: { left: false, right: true, top } });
    } else {
      out.push({ name, use: { left: columns > 1, right: columns > 1, top } });
    }
  }
  return out;
}

const CASES = ASPECTS.flatMap(([aspect, w, h]) =>
  overlayUses().map(({ name, use }) => [aspect, name, w, h, use] as const),
);

const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

describe("card titles", () => {
  it("use the card's own title when the text is empty or blank", () => {
    expect(titleLines("starting", "")).toEqual(["Starting soon"]);
    expect(titleLines("brb", "  \n ")).toEqual(["Be right back"]);
    expect(titleLines("ending", "")).toEqual([CARD_TITLES.ending]);
  });

  it("use the typed text, at most two trimmed lines", () => {
    expect(titleLines("brb", " Back in five ")).toEqual(["Back in five"]);
    expect(titleLines("brb", "Grabbing\n\na coffee\nextra")).toEqual(["Grabbing", "a coffee"]);
  });

  it("map unknown card values to Starting soon", () => {
    expect(toCardId("brb")).toBe("brb");
    expect(toCardId("ending")).toBe("ending");
    expect(toCardId("other")).toBe("starting");
  });
});

describe("layoutCard", () => {
  it.each(CASES)("at %s with %s stays inside the free rect", (_, __, w, h, use) => {
    const layout = computeOverlayLayout(w, h);
    const free = freeCentre(layout, use, { x: 0, y: 0, w: 0, h: 0 });
    const card = layoutCard(free, h / 1080, createCardLayout());
    expect(card.card.w).toBeGreaterThan(0);
    expect(card.card.h).toBeGreaterThan(0);
    for (const part of [card.card, card.title, card.subtitle, card.countdown]) {
      expect(inside(part, free)).toBe(true);
      expect(Number.isInteger(part.x) && Number.isInteger(part.y)).toBe(true);
    }
    const taken = [
      use.left ? layout.columnLeft : null,
      use.right ? layout.columnRight : null,
      use.top ? layout.band : null,
    ].filter((r) => r !== null);
    expect(taken.filter((r) => rectsOverlap(card.card, r))).toEqual([]);
    // Centred across the frame.
    expect(Math.abs(card.card.x + card.card.w / 2 - w / 2)).toBeLessThanOrEqual(1);
  });

  it("stacks title, subtitle and countdown top to bottom without overlap", () => {
    const card = layoutCard({ x: 30, y: 30, w: 1860, h: 1020 }, 1, createCardLayout());
    expect(card.title.y + card.title.h).toBeLessThanOrEqual(card.subtitle.y);
    expect(card.subtitle.y + card.subtitle.h).toBeLessThanOrEqual(card.countdown.y);
    expect(card.countdown.y + card.countdown.h).toBe(card.card.y + card.card.h);
    expect(card.k).toBe(1);
  });

  it("sits a little above the middle of an open frame", () => {
    const card = layoutCard({ x: 27, y: 27, w: 1866, h: 1026 }, 1, createCardLayout());
    const centre = card.card.y + card.card.h / 2;
    expect(centre).toBeLessThan(540);
    expect(centre).toBeGreaterThan(400);
  });

  it("narrows and shrinks between the columns", () => {
    const layout = computeOverlayLayout(1920, 1080);
    const open = layoutCard(
      freeCentre(layout, { left: false, right: false, top: false }, { x: 0, y: 0, w: 0, h: 0 }),
      1,
      createCardLayout(),
    );
    const between = layoutCard(
      freeCentre(layout, { left: true, right: true, top: true }, { x: 0, y: 0, w: 0, h: 0 }),
      1,
      createCardLayout(),
    );
    expect(between.card.w).toBeLessThan(open.card.w);
    expect(between.k).toBeLessThan(open.k);
    expect(between.titlePx).toBeLessThan(open.titlePx);
  });

  it("scales with the frame", () => {
    const hd = layoutCard({ x: 27, y: 27, w: 1866, h: 1026 }, 1, createCardLayout());
    const uhd = layoutCard({ x: 54, y: 54, w: 3732, h: 2052 }, 2, createCardLayout());
    expect(uhd.titlePx).toBe(2 * hd.titlePx);
    expect(uhd.countPx).toBe(2 * hd.countPx);
  });

  it("collapses to nothing in an empty rect", () => {
    const card = layoutCard({ x: 10, y: 10, w: 0, h: 0 }, 1, createCardLayout());
    expect(card.card.w).toBe(0);
    expect(card.card.h).toBe(0);
  });
});
