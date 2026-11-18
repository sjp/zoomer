import { describe, expect, it } from "vitest";
import {
  advanceGrow,
  cardAlpha,
  cardsUp,
  coversTitle,
  createGrow,
  drawDuration,
  GROW_GAP_MAX,
  GROW_GAP_MIN,
  itemExtents,
  KIND_CLIPPING,
  KIND_MAP,
  KIND_STICKY,
  layoutBoard,
  LOOSE_ITEM,
  MAX_ADDED,
  MAX_DENSITY,
  MAX_ITEMS,
  MAX_PIN_STRINGS,
  pinPoint,
  shelfPack,
  type BoardLayout,
  type GrowState,
  WORDS,
  stringProgress,
  stringsShown,
} from "./evidence-layout";
import { EASE_PEAK, MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";

const SEEDS = [0, 1, 7, 42, 999];

/** Whether point (x, y) px lies within `item`'s tilted rectangle in a frame. */
function inside(
  layout: BoardLayout,
  i: number,
  x: number,
  y: number,
  w: number,
  h: number,
  unit: number,
) {
  const item = layout.items[i];
  const dx = x - item.u * w;
  const dy = y - item.v * h;
  const c = Math.cos(item.angle);
  const s = Math.sin(item.angle);
  const lx = c * dx + s * dy;
  const ly = -s * dx + c * dy;
  return Math.abs(lx) <= item.hw * unit + 1e-6 && Math.abs(ly) <= item.hh * unit + 1e-6;
}

/** Strings ending on each item among the first `count`. */
function degrees(layout: BoardLayout, count: number): number[] {
  const d = Array.from({ length: MAX_DENSITY }, () => 0);
  for (let k = 0; k < stringsShown(layout, count); k++) {
    d[layout.strings[k].a]++;
    d[layout.strings[k].b]++;
  }
  return d;
}

describe("layoutBoard", () => {
  it.each(SEEDS)("is deterministic for seed %i", (seed) => {
    expect(layoutBoard(seed)).toEqual(layoutBoard(seed));
  });

  it("differs between seeds", () => {
    expect(layoutBoard(1).items[5]).not.toEqual(layoutBoard(2).items[5]);
  });

  it.each(SEEDS)("lays out every item within the frame for seed %i", (seed) => {
    for (const item of layoutBoard(seed).items) {
      expect(item.u).toBeGreaterThan(0);
      expect(item.u).toBeLessThan(1);
      expect(item.v).toBeGreaterThan(0);
      expect(item.v).toBeLessThan(1);
      expect(Math.abs(item.angle)).toBeLessThan(0.2);
    }
  });

  it.each(SEEDS)("puts the map first and the loose clipping next for seed %i", (seed) => {
    const layout = layoutBoard(seed);
    expect(layout.items[0].kind).toBe(KIND_MAP);
    expect(layout.items[LOOSE_ITEM].kind).toBe(KIND_CLIPPING);
  });

  it.each(SEEDS)("keeps every item off the title card for seed %i", (seed) => {
    const layout = layoutBoard(seed);
    for (const item of layout.items) {
      expect(coversTitle(item, layout.title)).toBe(false);
    }
  });

  it.each(SEEDS)("ties every item's strings to pins of items before it for seed %i", (seed) => {
    const layout = layoutBoard(seed);
    for (const s of layout.strings) {
      expect(s.b).toBeGreaterThanOrEqual(0);
      expect(s.b).toBeLessThan(s.a);
      expect(s.a).toBeLessThan(MAX_DENSITY);
    }
    // In order of their newer end, so a prefix of items has a prefix of strings.
    for (let k = 1; k < layout.strings.length; k++) {
      expect(layout.strings[k].a).toBeGreaterThanOrEqual(layout.strings[k - 1].a);
    }
  });

  it.each(SEEDS)("gives no pin more than three of the board's strings for seed %i", (seed) => {
    const layout = layoutBoard(seed);
    let most = 0;
    for (let n = 15; n <= MAX_DENSITY; n++) {
      most = Math.max(most, ...degrees(layout, n));
    }
    expect(most).toBeLessThanOrEqual(MAX_PIN_STRINGS - 1);
  });

  it.each(SEEDS)("joins the shown items into one web at every density for seed %i", (seed) => {
    const layout = layoutBoard(seed);
    for (let n = 15; n <= MAX_DENSITY; n++) {
      const root = Array.from({ length: n }, (_, i) => i);
      const find = (i: number): number => (root[i] === i ? i : find(root[i]));
      for (let k = 0; k < stringsShown(layout, n); k++) {
        root[find(layout.strings[k].a)] = find(layout.strings[k].b);
      }
      const roots = new Set(root.map((_, i) => find(i)));
      expect(roots.size).toBe(1);
    }
  });

  it.each(SEEDS)("runs some strings across the board for seed %i", (seed) => {
    const layout = layoutBoard(seed);
    const across = layout.strings.filter(
      (s) => (layout.items[s.a].u - 0.5) * (layout.items[s.b].u - 0.5) < 0,
    );
    expect(across.length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    [1920, 1080],
    [1280, 720],
    [2560, 1080],
    [1080, 1920],
  ])("puts every pin inside its item at %i x %i", (w, h) => {
    const layout = layoutBoard(3);
    const unit = h * Math.min(1, w / h / (16 / 9));
    const p = new Float64Array(2);
    for (let i = 0; i < MAX_DENSITY; i++) {
      pinPoint(layout.items[i], w, h, unit, p);
      expect(inside(layout, i, p[0], p[1], w, h, unit)).toBe(true);
      // Near the top edge, above the centre.
      expect(p[1]).toBeLessThan(layout.items[i].v * h);
    }
  });

  it("measures a tilted item's bounding box", () => {
    const item = { ...layoutBoard(1).items[0], hw: 0.1, hh: 0.05, angle: Math.PI / 2 };
    const [ex, ey] = itemExtents(item);
    expect(ex).toBeCloseTo(0.05, 9);
    expect(ey).toBeCloseTo(0.1, 9);
  });
});

/** Runs the growing case for `seconds` at `fps`, calling `each` after every step. */
function run(
  g: GrowState,
  layout: BoardLayout,
  seconds: number,
  density: number,
  on = true,
  each?: (g: GrowState) => void,
  fps = 10,
) {
  for (let i = 0; i < seconds * fps; i++) {
    advanceGrow(g, layout, 1 / fps, density, on);
    each?.(g);
  }
}

describe("advanceGrow", () => {
  const layout = layoutBoard(5);

  it("adds nothing in the first half minute", () => {
    const g = createGrow(5);
    run(g, layout, 29, 22);
    expect(g.spawned).toBe(0);
  });

  it("is deterministic per seed", () => {
    const a = createGrow(9);
    const b = createGrow(9);
    run(a, layout, 900, 22);
    run(b, layout, 900, 22);
    expect(a).toEqual(b);
  });

  it("adds a card every one to two minutes", () => {
    const g = createGrow(5);
    const times: number[] = [];
    run(g, layout, 1500, 22, true, (s) => {
      if (s.spawned > times.length) {
        times.push(s.time);
      }
    });
    expect(times.length).toBeGreaterThanOrEqual(10);
    expect(times[0]).toBeLessThanOrEqual(60.1);
    for (let k = 1; k < times.length; k++) {
      const gap = times[k] - times[k - 1];
      expect(gap).toBeGreaterThanOrEqual(GROW_GAP_MIN - 0.11);
      expect(gap).toBeLessThanOrEqual(GROW_GAP_MAX + 0.11);
    }
  });

  it.each([15, 22, 30])(
    "never holds more than the cap at density %i, then takes the oldest down",
    (density) => {
      const g = createGrow(5);
      let peak = 0;
      let cleared = false;
      /** Each card taken down, with the ids of the cards still up at the time. */
      const removals: { id: number; rest: number[] }[] = [];
      let up: number[] = [];
      run(g, layout, 6000, density, true, (s) => {
        const n = cardsUp(s);
        peak = Math.max(peak, n);
        const now = s.cards.filter((c) => c.live && c.leaving < 0).map((c) => c.id);
        removals.push(...up.filter((id) => !now.includes(id)).map((id) => ({ id, rest: now })));
        up = now;
        cleared ||= peak > 0 && n === 0;
      });
      // Taken down oldest first.
      for (const [k, r] of removals.entries()) {
        expect(r.rest.every((other) => other > r.id)).toBe(true);
        expect(k === 0 || r.id > removals[k - 1].id).toBe(true);
      }
      expect(removals.length).toBeGreaterThan(0);
      expect(density + peak).toBeLessThanOrEqual(MAX_ITEMS);
      expect(peak).toBe(Math.min(MAX_ITEMS - density, density, MAX_ADDED));
      expect(cleared).toBe(true);
    },
  );

  it("places added cards in the outer thirds, off the title card", () => {
    const g = createGrow(11);
    let seen = 0;
    let nearest = Number.POSITIVE_INFINITY;
    const onTitle = new Set<number>();
    run(
      g,
      layout,
      3000,
      22,
      true,
      (s) => {
        for (const c of s.cards.filter((card) => card.live)) {
          seen++;
          nearest = Math.min(nearest, Math.abs(c.item.u - 0.5));
          if (coversTitle(c.item, layout.title)) {
            onTitle.add(c.id);
          }
        }
      },
      2,
    );
    expect(seen).toBeGreaterThan(0);
    expect(nearest).toBeGreaterThanOrEqual(1 / 6 - 1e-9);
    expect([...onTitle]).toEqual([]);
  });

  it.each([15, 22, 30])(
    "keeps every pin to four strings, each landing on a shown item at density %i",
    (density) => {
      const g = createGrow(13);
      let furthest = 0;
      let most = 0;
      // Two steps a second is enough to see every card up.
      run(
        g,
        layout,
        4000,
        density,
        true,
        (s) => {
          const d = degrees(layout, density);
          for (const c of s.cards.filter((card) => card.live)) {
            furthest = Math.max(furthest, c.target);
            d[c.target]++;
          }
          most = Math.max(most, ...d);
        },
        2,
      );
      expect(furthest).toBeLessThan(density);
      expect(most).toBeLessThanOrEqual(MAX_PIN_STRINGS);
    },
  );

  it("takes down cards tied to items the density removes", () => {
    const g = createGrow(5);
    run(g, layout, 1500, 30);
    expect(g.cards.some((c) => c.live && c.target >= 15)).toBe(true);
    run(g, layout, 2, 15);
    expect(g.cards.every((c) => !c.live || c.target < 15)).toBe(true);
  });

  it("takes every card down when switched off, and starts again when on", () => {
    const g = createGrow(5);
    run(g, layout, 600, 22);
    expect(cardsUp(g)).toBeGreaterThan(0);
    run(g, layout, 2, 22, false);
    expect(g.cards.every((c) => !c.live)).toBe(true);
    const spawned = g.spawned;
    run(g, layout, 29, 22);
    expect(g.spawned).toBe(spawned);
    run(g, layout, 32, 22);
    expect(g.spawned).toBe(spawned + 1);
  });

  it("fades a card in, then draws its string over three to four seconds", () => {
    const g = createGrow(5);
    run(g, layout, 61, 22);
    const card = g.cards.find((c) => c.live);
    expect(card).toBeDefined();
    if (!card) {
      return;
    }
    expect(cardAlpha(card, card.born)).toBe(0);
    expect(cardAlpha(card, card.born + 0.5)).toBeCloseTo(0.5, 9);
    expect(cardAlpha(card, card.born + 1)).toBe(1);
    expect(stringProgress(card, card.born + 1, 0.3)).toBe(0);
    expect(card.drawTime).toBeGreaterThanOrEqual(3);
    expect(card.drawTime).toBeLessThanOrEqual(4);
    expect(stringProgress(card, card.born + 1 + card.drawTime, 0.3)).toBe(1);
    expect(stringProgress(card, card.born + 1 + card.drawTime / 2, 0.3)).toBeCloseTo(0.5, 9);
  });

  it.each([0.1, 0.5, 1, 2])(
    "draws a string %f frame heights long within the codec limit",
    (length) => {
      const g = createGrow(5);
      run(g, layout, 61, 22);
      const card = g.cards.find((c) => c.live);
      if (!card) {
        throw new Error("no card");
      }
      const peakPxPerFrame = (length * 1080 * EASE_PEAK) / (30 * drawDuration(card, length));
      expect(peakPxPerFrame).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME + 1e-9);
    },
  );
});

describe("words", () => {
  it.each(SEEDS)("gives sticky notes only short words for seed %i", (seed) => {
    const layout = layoutBoard(seed);
    for (const sticky of layout.items.filter((item) => item.kind === KIND_STICKY)) {
      expect(WORDS[sticky.word].length).toBeLessThanOrEqual(7);
    }
  });
});

describe("shelfPack", () => {
  it("packs rects in rows without overlap, within the width", () => {
    const n = 40;
    const sizes = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      sizes[2 * i] = 30 + ((i * 37) % 90);
      sizes[2 * i + 1] = 20 + ((i * 53) % 70);
    }
    const at = new Float64Array(2 * n);
    const h = shelfPack(sizes, n, 400, 2, at);
    for (let i = 0; i < n; i++) {
      expect(at[2 * i]).toBeGreaterThanOrEqual(2);
      expect(at[2 * i] + sizes[2 * i]).toBeLessThanOrEqual(398);
      expect(at[2 * i + 1] + sizes[2 * i + 1]).toBeLessThanOrEqual(h - 2);
      for (let j = 0; j < i; j++) {
        const apart =
          at[2 * i] >= at[2 * j] + sizes[2 * j] + 2 ||
          at[2 * j] >= at[2 * i] + sizes[2 * i] + 2 ||
          at[2 * i + 1] >= at[2 * j + 1] + sizes[2 * j + 1] + 2 ||
          at[2 * j + 1] >= at[2 * i + 1] + sizes[2 * i + 1] + 2;
        expect(apart).toBe(true);
      }
    }
  });

  it("gives a rect wider than the row a row of its own", () => {
    const sizes = new Float64Array([50, 10, 500, 20, 50, 10]);
    const at = new Float64Array(6);
    const h = shelfPack(sizes, 3, 200, 2, at);
    expect([at[1], at[3], at[5]]).toEqual([2, 14, 36]);
    expect(h).toBe(48);
  });
});
