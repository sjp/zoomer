import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { boardLayout, cardHeight } from "./kanban-layout";
import {
  applyLayout,
  type Board,
  cardPose,
  createBoard,
  createPose,
  MAX_CARDS,
  MAX_PER_COLUMN,
  stepBoard,
  wrapTitle,
} from "./kanban-sim";
import { MAX_PACE, MIN_PACE } from "./kanban.meta";

const SIZES = [
  [1920, 1080],
  [3840, 2160],
  [1440, 1080],
  [1080, 1080],
  [607, 1080],
  [1920, 400],
] as const;

const layoutFor = (w: number, h: number, columns = 4) => boardLayout(w, h, h / 1080, columns);

const live = (b: Board) => b.cols.reduce((n, col) => n + col.length, 0);

/** Problems with column `c`'s fit: too many cards, or the last one past the column's limit. */
function overflow(b: Board): string[] {
  const out: string[] = [];
  const L = b.layout;
  b.cols.forEach((col, c) => {
    if (col.length > MAX_PER_COLUMN) {
      out.push(`column ${String(c)} holds ${String(col.length)}`);
    }
    let y = L.cardsTop;
    for (const card of col) {
      y += cardHeight(L, card.lines.length);
      if (y > L.capBottom[c]) {
        out.push(`column ${String(c)} ends at ${String(y)} past ${String(L.capBottom[c])}`);
      }
      y += L.cardGap;
    }
  });
  return out;
}

/** Runs `seconds` at 30 fps, calling `each` after every step. */
function run(b: Board, seconds: number, pace: number, each?: () => void) {
  for (let i = 0; i < seconds * 30; i++) {
    stepBoard(b, 1 / 30, pace);
    each?.();
  }
}

describe("wrapTitle", () => {
  it("keeps short titles on one line and splits long ones at a space", () => {
    expect(wrapTitle("Q4 planning")).toEqual(["Q4 planning"]);
    expect(wrapTitle("Migrate billing to the new API")).toEqual([
      "Migrate billing to the new",
      "API",
    ]);
  });
});

describe("kanban board", () => {
  it.each(SIZES)("starts part-filled and within its columns at %i x %i", (w, h) => {
    const b = createBoard(1, layoutFor(w, h), 8);
    expect(overflow(b)).toEqual([]);
    expect(live(b)).toBeGreaterThan(0);
    expect(b.cards.length).toBeLessThanOrEqual(MAX_CARDS);
  });

  it.each(SIZES)("never overflows a column at %i x %i", (w, h) => {
    const b = createBoard(3, layoutFor(w, h), MIN_PACE);
    const problems = new Set<string>();
    run(b, 400, MIN_PACE, () => {
      for (const p of overflow(b)) {
        problems.add(p);
      }
    });
    expect([...problems]).toEqual([]);
    expect(b.moveCount).toBeGreaterThan(20);
  });

  it.each([1, 2, 77])(
    "conserves cards: only arrivals add and archiving removes (seed %i)",
    (seed) => {
      const b = createBoard(seed, layoutFor(1920, 1080), MIN_PACE);
      const start = live(b);
      let bad = 0;
      run(b, 300, MIN_PACE, () => {
        if (live(b) !== start + b.arrivals - b.archives) {
          bad++;
        }
      });
      expect(bad).toBe(0);
      expect(b.arrivals).toBeGreaterThan(0);
      expect(b.archives).toBeGreaterThan(0);
    },
  );

  it("moves cards forward one column at a time, never back", () => {
    const b = createBoard(5, layoutFor(1920, 1080), MIN_PACE);
    let seen = 0;
    const bad: string[] = [];
    run(b, 300, MIN_PACE, () => {
      if (b.moveCount !== seen) {
        seen = b.moveCount;
        if (b.lastTo !== b.lastFrom + 1) {
          bad.push(`${String(b.lastFrom)} -> ${String(b.lastTo)}`);
        }
      }
    });
    expect(seen).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });

  it("is deterministic per seed", () => {
    const trace = (seed: number) => {
      const b = createBoard(seed, layoutFor(1920, 1080), 8);
      const out: string[] = [];
      let seen = 0;
      run(b, 200, 8, () => {
        if (b.moveCount !== seen) {
          seen = b.moveCount;
          out.push(`${b.time.toFixed(3)}:${String(b.lastFrom)}:${String(b.cols[b.lastTo][0].id)}`);
        }
      });
      return out;
    };
    expect(trace(4)).toEqual(trace(4));
    expect(trace(4)).not.toEqual(trace(5));
  });

  it("waits a whole pace between moves", () => {
    const b = createBoard(2, layoutFor(1920, 1080), MAX_PACE);
    const times: number[] = [];
    let seen = 0;
    run(b, 200, MAX_PACE, () => {
      if (b.moveCount !== seen) {
        seen = b.moveCount;
        times.push(b.time);
      }
    });
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(MAX_PACE - 1e-6);
    }
  });

  it("ticks checklists in the column before last, and finishes them in the last", () => {
    const b = createBoard(6, layoutFor(1920, 1080), MIN_PACE);
    let ticks = 0;
    const versions = new Map(b.cards.map((c) => [c.id, c.version]));
    run(b, 300, MIN_PACE, () => {
      for (const c of b.cards) {
        if (c.version !== (versions.get(c.id) ?? 0)) {
          ticks++;
          versions.set(c.id, c.version);
        }
      }
    });
    expect(ticks).toBeGreaterThan(3);
    const settled = b.cols[b.cols.length - 1].filter((c) => c !== b.mover);
    expect(settled.filter((c) => c.checkDone !== c.checkTotal)).toEqual([]);
  });

  it.each(SIZES)(
    "keeps every card under the codec's speed limit at the fastest pace (%i x %i)",
    (w, h) => {
      const L = layoutFor(w, h);
      const b = createBoard(8, L, MIN_PACE);
      // Sample at 120 fps and measure the distance per 1/30 s at 1080p.
      const prev = new Map<number, { x: number; y: number }>();
      const pose = createPose();
      let worst = 0;
      const steps = 4;
      let tick = 0;
      for (let i = 0; i < 200 * 120; i++) {
        stepBoard(b, 1 / 120, MIN_PACE);
        if (++tick < steps) {
          continue;
        }
        tick = 0;
        for (const c of b.cards) {
          cardPose(c, b.time, pose);
          const p = prev.get(c.id);
          if (p) {
            worst = Math.max(worst, Math.hypot(pose.x - p.x, pose.y - p.y) / L.s);
          }
          prev.set(c.id, { x: pose.x, y: pose.y });
        }
      }
      expect(b.moveCount).toBeGreaterThan(10);
      expect(worst).toBeGreaterThan(0);
      expect(worst).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
    },
  );

  it("glides cards between layouts without a pose jump, merging and splitting columns", () => {
    const four = layoutFor(1920, 1080, 4);
    const three = layoutFor(1920, 1080, 3);
    const b = createBoard(9, four, 8);
    run(b, 30, 8);
    const pose = createPose();
    const before = new Map(b.cards.map((c) => [c.id, { ...cardPose(c, b.time, pose) }]));
    const start = live(b);
    const archived = b.archives;
    applyLayout(b, three, false);
    expect(b.cols.length).toBe(3);
    expect(overflow(b)).toEqual([]);
    expect(live(b)).toBe(start - (b.archives - archived));
    for (const c of b.cards) {
      const p = before.get(c.id);
      cardPose(c, b.time, pose);
      expect(pose.x).toBeCloseTo(p?.x ?? Number.NaN, 6);
      expect(pose.y).toBeCloseTo(p?.y ?? Number.NaN, 6);
    }
    run(b, 60, 8, () => {
      expect(overflow(b)).toEqual([]);
    });
    applyLayout(b, four, false);
    expect(b.cols.length).toBe(4);
    expect(b.cols[0]).toEqual([]);
    run(b, 60, 8, () => {
      expect(overflow(b)).toEqual([]);
    });
  });

  it("snaps to a resize, dropping what no longer fits", () => {
    const b = createBoard(10, layoutFor(1920, 1080), 8);
    run(b, 20, 8);
    applyLayout(b, layoutFor(1920, 400), true);
    expect(overflow(b)).toEqual([]);
    expect(b.cards.every((c) => c.col >= 0 && c.fx === c.tx && c.fy === c.ty)).toBe(true);
    run(b, 60, 8);
    expect(overflow(b)).toEqual([]);
  });
});
