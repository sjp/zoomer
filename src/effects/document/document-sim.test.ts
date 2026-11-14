import { describe, expect, it } from "vitest";
import {
  BLOCK_BULLETS,
  BLOCK_TABLE,
  BLOCK_TITLE,
  carryTypist,
  countWords,
  createDoc,
  createTypist,
  type Doc,
  MAX_SQUIGGLES,
  PHASE_BACKSPACE,
  squiggleAlpha,
  startSegment,
  stepTypist,
  type Typist,
  typedChars,
  typistDone,
  UNTITLED,
} from "./document-sim";

const SEEDS = [0, 1, 7, 42, 999];

/** Everything typed so far, segment by segment, joined with newlines. */
function typedText(doc: Doc, t: Typist): string {
  let s = "";
  for (let i = 0; i <= Math.min(t.seg, doc.segments.length - 1); i++) {
    s += doc.segments[i].text.slice(0, typedChars(doc, t, i)) + "\n";
  }
  return s;
}

describe("createDoc", () => {
  it.each(SEEDS)("is deterministic for seed %d", (seed) => {
    expect(createDoc(seed, 0, "Report")).toEqual(createDoc(seed, 0, "Report"));
  });

  it("differs between seeds and drafts", () => {
    const a = createDoc(1, 0, "Report").segments.map((s) => s.text);
    expect(createDoc(2, 0, "Report").segments.map((s) => s.text)).not.toEqual(a);
    expect(createDoc(1, 1, "Report").segments.map((s) => s.text)).not.toEqual(a);
  });

  it.each(SEEDS)("never makes an empty block or segment for seed %d", (seed) => {
    for (let g = 0; g < 4; g++) {
      const doc = createDoc(seed, g, "");
      for (const b of doc.blocks) {
        expect(b.segCount).toBeGreaterThan(0);
      }
      for (const b of doc.blocks.filter((x) => x.kind === BLOCK_TABLE)) {
        expect(b.rows * b.cols).toBe(b.segCount);
        expect(b.rows).toBeGreaterThanOrEqual(3);
      }
      for (const s of doc.segments) {
        expect(s.text.trim().length).toBeGreaterThan(0);
        expect(s.text).not.toMatch(/ {2}|^ | $/);
        expect(s.words).toBe(countWords(s.text));
      }
    }
  });

  it("opens with the title, or a stand-in when it is blank", () => {
    expect(createDoc(1, 0, "  Plan  ").blocks[0].kind).toBe(BLOCK_TITLE);
    expect(createDoc(1, 0, "  Plan  ").segments[0].text).toBe("Plan");
    expect(createDoc(1, 0, " ").segments[0].text).toBe(UNTITLED);
  });

  it("includes lists and tables across seeds", () => {
    const kinds = new Set<number>();
    for (let seed = 0; seed < 20; seed++) {
      for (const b of createDoc(seed, 0, "R").blocks) {
        kinds.add(b.kind);
      }
    }
    expect(kinds).toContain(BLOCK_BULLETS);
    expect(kinds).toContain(BLOCK_TABLE);
  });

  it("counts the words before each segment", () => {
    const doc = createDoc(3, 0, "Report");
    let n = 0;
    doc.segments.forEach((s, i) => {
      expect(doc.wordsBefore[i]).toBe(n);
      n += countWords(s.text);
    });
    expect(doc.wordsBefore[doc.segments.length]).toBe(n);
  });
});

describe("countWords", () => {
  it.each([
    ["", 0],
    ["one", 1],
    ["one two", 2],
    ["one two ", 2],
    ["+4.5% 12.0", 2],
  ])("counts %j as %d words", (s, n) => {
    expect(countWords(s)).toBe(n);
  });
});

/** Runs a typist through the whole of `doc` at 30 fps, calling `check` after every frame. */
function typeAll(doc: Doc, t: Typist, speed: number, check: () => void) {
  for (let i = 0; i < 400000 && !typistDone(t); i++) {
    stepTypist(doc, t, 1 / 30, speed);
    check();
  }
}

describe("typist", () => {
  it.each(SEEDS.flatMap((seed) => [2, 8, 20].map((speed) => [seed, speed])))(
    "moves forward except to correct a word, and retypes it (seed %d, %d chars/s)",
    (seed, speed) => {
      const doc = createDoc(seed, 0, "Report");
      const t = createTypist(doc, seed, startSegment(doc, seed));
      let seg = t.seg;
      let chars = t.chars;
      /** The furthest the current correction backed away from, or -1. */
      let backedFrom = -1;
      let corrections = 0;
      const problems: string[] = [];
      typeAll(doc, t, speed, () => {
        if (t.seg < seg) {
          problems.push("went back a segment");
        }
        if (t.seg === seg && t.chars < chars) {
          // Backspacing: only within the word being corrected.
          if (t.phase !== PHASE_BACKSPACE && t.chars < t.fixFrom) {
            problems.push("backspaced outside a correction");
          }
          if (backedFrom < 0) {
            backedFrom = chars;
            corrections++;
          }
        }
        if (t.seg !== seg) {
          // A segment is only left complete, and never mid-correction.
          if (backedFrom >= 0 || chars !== doc.segments[seg].text.length) {
            problems.push("left segment " + String(seg) + " unfinished");
          }
        }
        if (backedFrom >= 0 && t.seg === seg && t.chars >= backedFrom) {
          backedFrom = -1;
        }
        seg = t.seg;
        chars = t.chars;
      });
      expect(problems).toEqual([]);
      expect(typistDone(t)).toBe(true);
      expect(backedFrom).toBe(-1);
      expect(corrections).toBeGreaterThan(speed === 8 ? 0 : -1);
    },
  );

  it.each(SEEDS)("keeps the word count equal to the words typed (seed %d)", (seed) => {
    const doc = createDoc(seed, 1, "Quarterly Report");
    const t = createTypist(doc, seed);
    let frames = 0;
    const wrong: number[] = [];
    typeAll(doc, t, 12, () => {
      if (frames++ % 7 === 0 && t.words !== countWords(typedText(doc, t).replaceAll("\n", " "))) {
        wrong.push(frames);
      }
    });
    expect(wrong).toEqual([]);
    expect(t.words).toBe(doc.wordsBefore[doc.segments.length]);
  });

  it("joins part-way with everything before typed", () => {
    const doc = createDoc(5, 0, "Report");
    const start = startSegment(doc, 5);
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(doc.segments.length / 2);
    const t = createTypist(doc, 5, start);
    expect(t.words).toBe(doc.wordsBefore[start]);
    expect(typedChars(doc, t, start - 1)).toBe(doc.segments[start - 1].text.length);
    expect(typedChars(doc, t, start + 1)).toBe(0);
  });

  it("types at about the speed asked", () => {
    const doc = createDoc(2, 0, "Report");
    const t = createTypist(doc, 2);
    for (let i = 0; i < 30 * 60; i++) {
      stepTypist(doc, t, 1 / 30, 8);
    }
    let chars = 0;
    for (let i = 0; i < t.seg; i++) {
      chars += doc.segments[i].text.length;
    }
    chars += t.chars;
    // Pauses at punctuation and segment ends slow it below the raw rate.
    expect(chars / 60).toBeGreaterThan(4);
    expect(chars / 60).toBeLessThan(9);
  });

  it("shows squiggles that fade away again", () => {
    const doc = createDoc(4, 0, "Report");
    const t = createTypist(doc, 4);
    let seen = 0;
    let bad = 0;
    for (let i = 0; i < 30 * 600; i++) {
      stepTypist(doc, t, 1 / 30, 10);
      for (let k = 0; k < MAX_SQUIGGLES; k++) {
        const a = squiggleAlpha(t, k);
        if (!(a >= 0 && a <= 1) || (a > 0 && t.sqTo[k] <= t.sqFrom[k])) {
          bad++;
        }
        seen += a > 0 ? 1 : 0;
      }
    }
    expect(bad).toBe(0);
    expect(seen).toBeGreaterThan(0);
    for (let k = 0; k < MAX_SQUIGGLES; k++) {
      expect(t.sqAge[k]).toBeLessThan(1e6);
    }
  });

  it("carries its place over to a retitled document", () => {
    const doc = createDoc(6, 0, "Report");
    const t = createTypist(doc, 6, startSegment(doc, 6));
    for (let i = 0; i < 300; i++) {
      stepTypist(doc, t, 1 / 30, 8);
    }
    const next = createDoc(6, 0, "A much longer title than before");
    const u = carryTypist(next, t, 6);
    expect(u.seg).toBe(t.seg);
    expect(u.chars).toBeLessThanOrEqual(t.chars);
    expect(u.words).toBe(countWords(typedText(next, u).replaceAll("\n", " ")));
  });
});
