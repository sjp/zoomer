import { describe, expect, it } from "vitest";
import {
  type Box,
  CAPACITY,
  clearBox,
  createField,
  createShiba,
  DEFAULT_PHRASES,
  EDGE_MARGIN,
  type Field,
  type MeasureEm,
  phraseList,
  REF_HEIGHT,
  reseed,
  resizeField,
  setList,
  shibaBox,
  stepField,
  stepShiba,
  targetCount,
  TOUCH_GAP,
  visibleTexts,
  wantedCount,
} from "./suchwow-sim";
import { MAX_COUNT, PHRASE_LENGTH, PHRASE_LINES } from "./suchwow.meta";

const DT = 1 / 30;
const measure: MeasureEm = (text) => Array.from(text).length * 0.5;
const unmeasured: MeasureEm = () => undefined;

/** Twelve phrases of the longest length, all different. */
const LONGEST = Array.from({ length: PHRASE_LINES }, (_, i) =>
  `much wow very long ${String.fromCodePoint(97 + i)}`.padEnd(PHRASE_LENGTH, "w"),
);

const ASPECTS = [
  ["16:9", 16 / 9],
  ["4:3", 4 / 3],
  ["21:9", 21 / 9],
  ["portrait", 9 / 16],
] as const;

const live = (f: Field) => f.phrases.filter((p) => p.live);

const gapBetween = (a: Box, b: Box) =>
  Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY);

/** The phrase's rotated rectangle, now, as an axis-aligned box. */
function nowBox(p: Field["phrases"][number]): Box {
  const c = Math.abs(Math.cos(p.angle));
  const s = Math.abs(Math.sin(p.angle));
  const hw = (p.width * c + p.height * s) / 2;
  const hh = (p.width * s + p.height * c) / 2;
  return { minX: p.x - hw, maxX: p.x + hw, minY: p.y - hh, maxY: p.y + hh };
}

const contains = (outer: Box, inner: Box) =>
  inner.minX >= outer.minX - 1e-6 &&
  inner.maxX <= outer.maxX + 1e-6 &&
  inner.minY >= outer.minY - 1e-6 &&
  inner.maxY <= outer.maxY + 1e-6;

/** Every problem with the layout this frame. */
function layoutProblems(f: Field): string[] {
  const out: string[] = [];
  const centre = clearBox(f.refWidth, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  const shown = live(f);
  for (const p of shown) {
    const now = nowBox(p);
    if (!contains(p.box, now)) {
      out.push(`${p.text} left its box`);
    }
    if (gapBetween(now, centre) < 0) {
      out.push(`${p.text} is in the centre`);
    }
    if (
      now.minX < EDGE_MARGIN - 1e-6 ||
      now.minY < EDGE_MARGIN - 1e-6 ||
      now.maxX > f.refWidth - EDGE_MARGIN + 1e-6 ||
      now.maxY > REF_HEIGHT - EDGE_MARGIN + 1e-6
    ) {
      out.push(`${p.text} is off the edge`);
    }
  }
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      if (gapBetween(nowBox(shown[i]), nowBox(shown[j])) < 0) {
        out.push(`${shown[i].text} overlaps ${shown[j].text}`);
      }
    }
  }
  return out;
}

function run(f: Field, seconds: number, each: () => void, count = MAX_COUNT, motion = 1) {
  for (let t = 0; t < seconds; t += DT) {
    stepField(f, DT, count, motion, false);
    each();
  }
}

describe("phrase list", () => {
  it("uses the built-in list when empty", () => {
    expect(phraseList("")).toEqual([...DEFAULT_PHRASES]);
    expect(phraseList(" \n  \n")).toEqual([...DEFAULT_PHRASES]);
  });

  it("trims, lower-cases and drops repeats", () => {
    expect(phraseList("  Such   Code \nwow\nsuch code\n\nWOW")).toEqual(["such code", "wow"]);
  });
});

describe("placement", () => {
  it.each(ASPECTS)("keeps the longest phrases in the ring, apart, at %s", (_, aspect) => {
    const f = createField(3, REF_HEIGHT * aspect, LONGEST, measure);
    const problems = new Set<string>();
    run(f, 90, () => {
      for (const p of layoutProblems(f)) {
        problems.add(p);
      }
    });
    expect([...problems]).toEqual([]);
    expect(f.spawns).toBeGreaterThan(5);
  });

  it.each(ASPECTS)("keeps the built-in phrases in the ring, apart, at %s", (_, aspect) => {
    const f = createField(8, REF_HEIGHT * aspect, DEFAULT_PHRASES, unmeasured);
    const problems = new Set<string>();
    run(f, 90, () => {
      for (const p of layoutProblems(f)) {
        problems.add(p);
      }
    });
    expect([...problems]).toEqual([]);
  });

  it("fills a wide frame to the count", () => {
    const f = createField(1, 1920, DEFAULT_PHRASES, measure);
    stepField(f, DT, 6, 1, false);
    expect(wantedCount(f)).toBe(6);
    expect(visibleTexts(f)).toHaveLength(6);
  });

  it("keeps clear of the shiba's corner once it arrives", () => {
    const f = createField(5, 1920, DEFAULT_PHRASES, measure);
    const corner = shibaBox(1920, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
    let bad = 0;
    for (let t = 0; t < 60; t += DT) {
      stepField(f, DT, MAX_COUNT, 1, true);
      bad += live(f).filter((p) => !p.dismissed && gapBetween(p.box, corner) < 0).length;
    }
    expect(bad).toBe(0);
  });

  it("drops phrases that no longer fit after a resize, and keeps the rest", () => {
    const f = createField(2, 2520, DEFAULT_PHRASES, measure);
    stepField(f, DT, MAX_COUNT, 1, false);
    const before = live(f).map((p) => p.serial);
    resizeField(f, 1440);
    const kept = live(f).filter((p) => !p.dismissed);
    expect(kept.length).toBeGreaterThan(0);
    expect(before).toHaveLength(live(f).length);
    // Once the misfits have faded out, the layout is sound again.
    run(f, 1.5, () => undefined);
    expect(layoutProblems(f)).toEqual([]);
  });
});

describe("turns", () => {
  it("never shows the same phrase twice at once", () => {
    const f = createField(4, 1920, DEFAULT_PHRASES, measure);
    run(f, 120, () => {
      const texts = visibleTexts(f);
      expect(new Set(texts).size).toBe(texts.length);
    });
  });

  it("shows every phrase in a long run, and brings none back before most have had a turn", () => {
    const f = createField(6, 1920, DEFAULT_PHRASES, measure);
    const serials = Array.from({ length: CAPACITY }, () => 0);
    const history: string[] = [];
    run(
      f,
      400,
      () => {
        f.phrases.forEach((p, i) => {
          if (p.serial !== serials[i]) {
            serials[i] = p.serial;
            history.push(p.text);
          }
        });
      },
      3,
    );
    expect(new Set(history)).toEqual(new Set(DEFAULT_PHRASES));
    const returns = history
      .map((text, i) => history.indexOf(text, i + 1) - i)
      .filter((gap) => gap > 0);
    expect(returns.length).toBeGreaterThan(20);
    expect(Math.min(...returns)).toBeGreaterThanOrEqual(DEFAULT_PHRASES.length / 2);
  });

  it("works with a single phrase, one at a time", () => {
    const f = createField(1, 1920, phraseList("wow"), measure);
    let seen = 0;
    run(f, 60, () => {
      const texts = visibleTexts(f);
      expect(texts.length).toBeLessThanOrEqual(1);
      seen += texts.length;
    });
    expect(targetCount(f, 5)).toBe(1);
    expect(seen).toBeGreaterThan(0);
    expect(f.spawns).toBeGreaterThan(3);
  });

  it("takes new phrases from a new list and lets the old ones finish", () => {
    const f = createField(1, 1920, DEFAULT_PHRASES, measure);
    stepField(f, DT, 5, 1, false);
    const old = visibleTexts(f);
    setList(f, ["much new", "very fresh", "such change", "wow", "so edit"]);
    stepField(f, DT, 5, 1, false);
    expect(visibleTexts(f)).toEqual(expect.arrayContaining(old));
    run(f, 30, () => undefined, 5);
    expect(visibleTexts(f).every((t) => f.list.includes(t))).toBe(true);
  });
});

describe("colours", () => {
  it.each(ASPECTS)("never gives touching phrases one colour, at %s", (_, aspect) => {
    const f = createField(9, REF_HEIGHT * aspect, DEFAULT_PHRASES, measure);
    let touching = 0;
    let clashes = 0;
    run(f, 120, () => {
      const shown = live(f);
      for (let i = 0; i < shown.length; i++) {
        for (let j = i + 1; j < shown.length; j++) {
          const near = gapBetween(shown[i].box, shown[j].box) < TOUCH_GAP;
          touching += near ? 1 : 0;
          clashes += near && shown[i].color === shown[j].color ? 1 : 0;
        }
      }
    });
    expect(touching).toBeGreaterThan(0);
    expect(clashes).toBe(0);
  });
});

describe("count and motion", () => {
  it("fades extra phrases out when the count drops", () => {
    const f = createField(1, 1920, DEFAULT_PHRASES, measure);
    stepField(f, DT, 7, 1, false);
    stepField(f, DT, 3, 1, false);
    expect(wantedCount(f)).toBe(3);
    const leaving = live(f).filter((p) => p.dismissed);
    expect(leaving).toHaveLength(4);
    expect(leaving.every((p) => p.alpha > 0.9)).toBe(true);
    run(f, 1.1, () => undefined, 3);
    expect(live(f).filter((p) => p.dismissed)).toHaveLength(0);
  });

  it("fades new phrases in when the count rises, even when still", () => {
    const f = createField(1, 1920, DEFAULT_PHRASES, measure);
    stepField(f, DT, 3, 0, false);
    run(f, 10, () => undefined, 6, 0);
    expect(visibleTexts(f)).toHaveLength(6);
    expect(live(f).every((p) => p.alpha === 1)).toBe(true);
  });

  it("holds a still arrangement at motion 0", () => {
    const f = createField(7, 1920, DEFAULT_PHRASES, measure);
    stepField(f, DT, 5, 0, false);
    const snapshot = () => live(f).map((p) => [p.text, p.x, p.y, p.alpha, p.angle, p.color]);
    const first = snapshot();
    run(f, 60, () => undefined, 5, 0);
    expect(snapshot()).toEqual(first);
  });

  it("swaps the whole arrangement for a new variation", () => {
    const f = createField(1, 1920, DEFAULT_PHRASES, measure);
    stepField(f, DT, 5, 1, false);
    const before = f.spawns;
    reseed(f, 2);
    run(f, 3, () => undefined, 5);
    expect(live(f).every((p) => (f.lastShown.get(p.text) ?? -1) >= before)).toBe(true);
    expect(wantedCount(f)).toBe(5);
  });
});

describe("shiba", () => {
  it("blinks and glances now and then", () => {
    const s = createShiba(1);
    let blinks = 0;
    let maxLook = 0;
    let wasBlink = false;
    for (let t = 0; t < 60; t += DT) {
      stepShiba(s, DT, 1, true);
      if (s.blink && !wasBlink) {
        blinks++;
      }
      wasBlink = s.blink;
      maxLook = Math.max(maxLook, s.look);
    }
    expect(s.presence).toBe(1);
    expect(blinks).toBeGreaterThan(5);
    expect(maxLook).toBe(1);
  });

  it("holds still at motion 0 and fades out when switched off", () => {
    const s = createShiba(1);
    stepShiba(s, DT, 0, true);
    const look = s.look;
    const blink = s.blink;
    for (let t = 0; t < 30; t += DT) {
      stepShiba(s, DT, 0, true);
      expect([s.look, s.blink]).toEqual([look, blink]);
    }
    for (let t = 0; t < 1.1; t += DT) {
      stepShiba(s, DT, 0, false);
    }
    expect(s.presence).toBe(0);
  });
});
