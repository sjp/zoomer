import { describe, expect, it } from "vitest";
import { createRng } from "../noise";
import { fitScale } from "../scene-layout";
import {
  advanceRoom,
  ALBEDO_MAX,
  cardState,
  cardThing,
  CARDS,
  clockMinutes,
  createFlickerShape,
  createRoom,
  dealDeck,
  DARK_LEVEL,
  failingLevel,
  FLICKER_MAX,
  FLICKER_MIN,
  flickerLevel,
  type FlickerRoom,
  HUM_DEPTH,
  humLevel,
  INTERVAL_MAX,
  INTERVAL_MIN,
  MAX_MEAN_STEP,
  MAX_SLOPE,
  shapeFlicker,
  stoppedSecond,
  THING_BOXES,
  THING_CLOCK,
  THING_DOOR,
  THING_FIGURE,
  THINGS,
  TINT_FLOATS,
  TINTS,
  TUBE_X,
  tubePool,
} from "./flickerroom-sim";

const SEEDS = [0, 1, 7, 42, 999];

/** Runs `room` at `dt` until `flickers` more flickers have finished, calling `each` per step. */
function run(
  room: FlickerRoom,
  dt: number,
  flickers: number,
  each: (changed: number) => void = () => {},
  interval = 15,
  presence = 1,
) {
  const end = room.flickers + flickers;
  let guard = 0;
  while ((room.flickers < end || room.active) && guard++ < 1e7) {
    each(advanceRoom(room, dt, interval, presence));
  }
}

describe("flicker shape", () => {
  it.each(SEEDS)("has 2-4 dips, the deep one never first, within its length (seed %d)", (seed) => {
    const rng = createRng(seed);
    const s = createFlickerShape();
    for (let k = 0; k < 200; k++) {
      shapeFlicker(s, rng);
      expect(s.dips).toBeGreaterThanOrEqual(2);
      expect(s.dips).toBeLessThanOrEqual(4);
      expect(s.main).toBeGreaterThanOrEqual(1);
      expect(s.main).toBeLessThan(s.dips);
      expect(s.duration).toBeGreaterThanOrEqual(FLICKER_MIN - 1e-9);
      expect(s.duration).toBeLessThanOrEqual(FLICKER_MAX + 1e-9);
      expect(flickerLevel(s, s.swapAt)).toBeLessThan(DARK_LEVEL);
      expect(flickerLevel(s, -0.01)).toBe(1);
      expect(flickerLevel(s, s.duration + 0.01)).toBe(1);
    }
  });

  it.each(SEEDS)("never changes faster than MAX_SLOPE, and stays in 0..1 (seed %d)", (seed) => {
    const rng = createRng(seed + 100);
    const s = createFlickerShape();
    const h = 1e-3;
    let steepest = 0;
    let lo = 1;
    let hi = 0;
    for (let k = 0; k < 50; k++) {
      shapeFlicker(s, rng);
      let prev = flickerLevel(s, 0);
      for (let t = h; t <= s.duration; t += h) {
        const l = flickerLevel(s, t);
        lo = Math.min(lo, l);
        hi = Math.max(hi, l);
        steepest = Math.max(steepest, Math.abs(l - prev) / h);
        prev = l;
      }
    }
    expect(steepest).toBeLessThanOrEqual(MAX_SLOPE * 1.001);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it("dims to near off at its deepest", () => {
    const s = createFlickerShape();
    shapeFlicker(s, createRng(3));
    let lowest = 1;
    for (let t = 0; t <= s.duration; t += 0.001) {
      lowest = Math.min(lowest, flickerLevel(s, t));
    }
    expect(lowest).toBeLessThan(0.08);
  });
});

describe("hum", () => {
  it("wobbles the failing tube by at most HUM_DEPTH, and not at all at 0", () => {
    let lo = 1;
    for (let t = 0; t < 120; t += 0.05) {
      const l = humLevel(t, 1, 0.7);
      lo = Math.min(lo, l);
      expect(l).toBeLessThanOrEqual(1);
      expect(humLevel(t, 0, 0.7)).toBe(1);
    }
    expect(lo).toBeGreaterThanOrEqual(1 - HUM_DEPTH - 1e-12);
    expect(lo).toBeLessThan(1 - 0.5 * HUM_DEPTH);
  });
});

describe("schedule", () => {
  it.each(SEEDS)("is the same for the same seed (seed %d)", (seed) => {
    const a = createRoom(seed, 40);
    const b = createRoom(seed, 40);
    const levels: number[] = [];
    run(
      a,
      1 / 30,
      6,
      (c) => {
        levels.push(failingLevel(a, 0.5), c);
      },
      40,
    );
    let i = 0;
    run(
      b,
      1 / 30,
      6,
      (c) => {
        expect(failingLevel(b, 0.5)).toBe(levels[i++]);
        expect(c).toBe(levels[i++]);
      },
      40,
    );
    expect(i).toBe(levels.length);
  });

  it("differs between seeds", () => {
    const starts = SEEDS.map((seed) => {
      const r = createRoom(seed, 40);
      let t = 0;
      while (!r.active) {
        advanceRoom(r, 0.01, 40, 0.3);
        t += 0.01;
      }
      return t.toFixed(2);
    });
    expect(new Set(starts).size).toBeGreaterThan(SEEDS.length - 2);
  });

  it.each([INTERVAL_MIN, 40, INTERVAL_MAX])(
    "averages the interval between flickers (%d s)",
    (interval) => {
      const r = createRoom(5, interval);
      const gaps: number[] = [];
      let gap = 0;
      for (let k = 0; k < 400;) {
        const was = r.active;
        advanceRoom(r, 0.05, interval, 0.3);
        if (!r.active) {
          gap += 0.05;
        }
        if (r.active && !was) {
          gaps.push(gap);
          gap = 0;
          k++;
        }
      }
      const later = gaps.slice(1);
      for (const g of later) {
        expect(g).toBeGreaterThanOrEqual(0.5 * interval - 0.2);
        expect(g).toBeLessThanOrEqual(1.5 * interval + 0.2);
      }
      const mean = later.reduce((a, b) => a + b, 0) / later.length;
      expect(Math.abs(mean / interval - 1)).toBeLessThan(0.08);
    },
  );

  it("latches the interval per gap: a change applies from the next one", () => {
    const r = createRoom(2, 120);
    run(r, 1 / 30, 1, undefined, 120);
    // Between flickers now, waiting out a gap latched at 120 s.
    const wait = r.wait;
    expect(wait).toBeGreaterThan(55);
    advanceRoom(r, 1, 15, 0.3);
    expect(r.wait).toBeCloseTo(wait - 1, 9);
    run(r, 1 / 30, 1, undefined, 15);
    expect(r.wait).toBeLessThanOrEqual(1.5 * 15);
  });

  it("comes soon after the start, whatever the interval", () => {
    const r = createRoom(9, INTERVAL_MAX);
    expect(r.wait).toBeLessThanOrEqual(14);
    expect(r.wait).toBeGreaterThanOrEqual(6);
  });

  it("copes with long and odd steps", () => {
    const r = createRoom(4, 30);
    advanceRoom(r, Number.NaN, 30, 0.3);
    advanceRoom(r, -5, 30, 0.3);
    expect(r.time).toBe(0);
    const changed = advanceRoom(r, 3600, 30, 0.3);
    expect(changed).not.toBe(0);
    expect(r.flickers).toBeGreaterThan(40);
  });
});

describe("changes", () => {
  it.each([1 / 60, 1 / 30, 1 / 24])(
    "are swapped in only while the failing tube is dark (dt %d)",
    (dt) => {
      for (const seed of SEEDS) {
        const r = createRoom(seed, 15);
        let swaps = 0;
        let inactive = 0;
        let brightest = 0;
        run(r, dt, 40, (changed) => {
          if (changed !== 0) {
            swaps++;
            inactive += r.active ? 0 : 1;
            brightest = Math.max(brightest, failingLevel(r, 0), failingLevel(r, 1));
          }
        });
        expect(swaps).toBe(40);
        expect(inactive).toBe(0);
        expect(brightest).toBeLessThan(DARK_LEVEL);
      }
    },
  );

  it.each(SEEDS)("change one thing per flicker (seed %d)", (seed) => {
    const r = createRoom(seed, 15);
    const changes: number[] = [];
    run(r, 1 / 30, 60, (changed) => {
      if (changed !== 0) {
        changes.push(changed);
      }
    });
    expect(changes.length).toBe(60);
    // Exactly one bit each, for a thing there is.
    expect(changes.filter((c) => (c & (c - 1)) !== 0 || c >= 1 << THINGS)).toEqual([]);
  });

  it.each(SEEDS)("deal every card once, chains in order (seed %d)", (seed) => {
    const r = createRoom(seed, 40);
    for (let d = 0; d < 30; d++) {
      dealDeck(r, 1);
      const cards = Array.from(r.deck.subarray(0, r.deckLength));
      expect(cards.length).toBe(CARDS);
      expect(new Set(cards).size).toBe(CARDS);
      // Within each thing, its cards come in the order they're listed.
      for (let thing = 0; thing < THINGS; thing++) {
        const mine = cards.filter((c) => cardThing(c) === thing);
        expect(mine).toEqual(mine.toSorted((a, b) => a - b));
      }
    }
  });

  it.each(SEEDS)("never repeat a change until the deck is spent (seed %d)", (seed) => {
    const r = createRoom(seed, 15);
    // Track (thing, state) pairs played from the current deck.
    let seen = new Set<string>();
    let deck = r.decks;
    const repeats: string[] = [];
    run(r, 1 / 30, 200, (changed) => {
      if (changed === 0 || r.restoring) {
        return;
      }
      if (r.decks !== deck) {
        deck = r.decks;
        seen = new Set();
      }
      const thing = Math.log2(changed);
      const key = `${String(thing)}:${String(r.state[thing])}`;
      if (seen.has(key)) {
        repeats.push(key);
      }
      seen.add(key);
    });
    expect(repeats).toEqual([]);
    expect(r.decks).toBeGreaterThan(5);
  });

  it.each(SEEDS)("drift back to normal after the deck, before the next (seed %d)", (seed) => {
    const r = createRoom(seed, 15);
    let deck = r.decks;
    let checked = 0;
    let unsettled = 0;
    let before: number[] = [];
    run(r, 1 / 30, 200, () => {
      if (r.decks !== deck) {
        // The new deck's first card is played on a room that was all back to normal.
        deck = r.decks;
        unsettled += deck > 1 && before.some((s) => s !== 0) ? 1 : 0;
        checked += deck > 1 ? 1 : 0;
      }
      before = Array.from(r.state);
    });
    expect(unsettled).toBe(0);
    expect(checked).toBeGreaterThan(5);
  });

  it.each(SEEDS)("never bring the figure at a presence of 0 (seed %d)", (seed) => {
    const r = createRoom(seed, 15);
    let figure = 0;
    run(
      r,
      1 / 10,
      300,
      () => {
        figure = Math.max(figure, r.state[THING_FIGURE]);
      },
      15,
      0,
    );
    expect(r.decks).toBeGreaterThan(10);
    expect(figure).toBe(0);
  });

  it("bring the figure in some decks at a low presence, and every deck at 1", () => {
    for (const [presence, lo, hi] of [
      [0.3, 0.15, 0.45],
      [1, 1, 1],
    ] as const) {
      const r = createRoom(11, 40);
      let withFigure = 0;
      for (let d = 0; d < 400; d++) {
        dealDeck(r, presence);
        withFigure += r.deckLength === CARDS ? 1 : 0;
      }
      expect(withFigure / 400).toBeGreaterThanOrEqual(lo);
      expect(withFigure / 400).toBeLessThanOrEqual(hi);
    }
  });

  it("open the door, then open it further", () => {
    const r = createRoom(6, 15);
    const states: number[] = [];
    run(r, 1 / 30, 40, (changed) => {
      if (changed === 1 << THING_DOOR) {
        states.push(r.state[THING_DOOR]);
      }
    });
    expect(states.slice(0, 3)).toEqual([1, 2, 0]);
  });

  it("jump the clock forward hours, and put it back", () => {
    const r = createRoom(8, 15);
    const base = clockMinutes(r);
    const seen: number[] = [];
    run(r, 1 / 30, 40, (changed) => {
      if (changed === 1 << THING_CLOCK) {
        seen.push(r.state[THING_CLOCK] === 0 ? 0 : (clockMinutes(r) - base + 720) % 720);
      }
    });
    expect(seen[0]).toBeGreaterThanOrEqual(120);
    expect(seen[1]).toBe(0);
    expect(cardState(7)).toBe(1);
  });
});

describe("clock", () => {
  it("keeps the time on the dial and the second hand stopped", () => {
    for (const seed of SEEDS) {
      const r = createRoom(seed, 40);
      expect(clockMinutes(r)).toBeGreaterThanOrEqual(0);
      expect(clockMinutes(r)).toBeLessThan(720);
      expect(stoppedSecond(seed)).toBeGreaterThanOrEqual(0);
      expect(stoppedSecond(seed)).toBeLessThan(1);
    }
  });
});

describe("layout", () => {
  const OUTER = 16 / 9 / 6;

  it("keeps the door, the corridor's figure and the clock in the outer thirds", () => {
    for (const thing of [THING_DOOR, THING_FIGURE, THING_CLOCK]) {
      const [x, , hw] = THING_BOXES[thing];
      expect(Math.abs(x) - hw).toBeGreaterThan(OUTER);
    }
  });

  it("hangs the failing tube on the side away from the doorway", () => {
    expect(Math.sign(TUBE_X[0])).toBe(-Math.sign(THING_BOXES[THING_FIGURE][0]));
  });

  it("has a tint for each option, each a full block", () => {
    expect(Object.keys(TINTS)).toEqual(["green", "beige", "night"]);
    for (const t of Object.values(TINTS)) {
      expect(t.length).toBe(TINT_FLOATS);
    }
  });
});

describe("brightness", () => {
  /** The failing tube's share of the frame's mean brightness (0..1 display values) at full. */
  function failingShare(tint: readonly number[], aspect: number): number {
    const k = fitScale(aspect);
    const hw = (0.5 * aspect) / k;
    const hh = 0.5 / k;
    const n = 120;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -hw + ((i + 0.5) / n) * 2 * hw;
        const y = -hh + ((j + 0.5) / n) * 2 * hh;
        sum += tubePool(0, x, y);
      }
    }
    const tube = Math.max(tint[3], tint[4], tint[5]) * tint[6];
    return (sum / (n * n)) * ALBEDO_MAX * tube;
  }

  const cases = Object.keys(TINTS).flatMap((tint) =>
    [16 / 9, 4 / 3, 21 / 9, 9 / 16].map((aspect) => [tint, aspect] as const),
  );

  it.each(cases)(
    "changes the frame's mean by under MAX_MEAN_STEP a frame while flickering (%s, aspect %d)",
    (tint, aspect) => {
      const share = failingShare(TINTS[tint], aspect);
      const r = createRoom(3, 15);
      let prev = failingLevel(r, 1);
      let worst = 0;
      let lowest = 1;
      run(r, 1 / 30, 60, () => {
        const l = failingLevel(r, 1);
        worst = Math.max(worst, Math.abs(l - prev) * share);
        lowest = Math.min(lowest, l);
        prev = l;
      });
      expect(worst).toBeLessThan(MAX_MEAN_STEP);
      // And it does flicker: the tube goes nearly out.
      expect(lowest).toBeLessThan(DARK_LEVEL);
    },
  );

  it("pools each tube's light round its x, brightest high on the wall", () => {
    for (let i = 0; i < TUBE_X.length; i++) {
      expect(tubePool(i, TUBE_X[i], 0.5)).toBeCloseTo(1, 9);
      expect(tubePool(i, TUBE_X[i] + 0.6, 0.2)).toBeLessThan(tubePool(i, TUBE_X[i], 0.2));
      expect(tubePool(i, TUBE_X[i], -0.3)).toBeGreaterThan(tubePool(i, TUBE_X[i], -0.48));
    }
  });
});
