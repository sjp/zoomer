import { describe, expect, it } from "vitest";
import { MAX_PATTERN_HZ } from "../motion-limits";
import {
  blueHue,
  blueStyle,
  CLASSIC_CHARS,
  classicGlyphRows,
  classicText,
  copyProgress,
  createProgress,
  createTraceLog,
  CURSOR_HZ,
  cursorAlpha,
  HOLD_MAX,
  HOLD_MIN,
  LINE_MAX,
  LINE_MIN,
  MAX_TRACE_CHARS,
  RESTART_MAX,
  RESTART_MIN,
  stepProgress,
  stepTraceLog,
  tickSeconds,
  TICK_MAX,
  TICK_MIN,
  TOP_PERCENT,
  traceLine,
} from "./bluescreen-sim";

describe("blue screen params", () => {
  it("falls back to Modern and Blue for unknown values", () => {
    expect(blueStyle("kernel")).toBe("kernel");
    expect(blueStyle("classic")).toBe("classic");
    expect(blueStyle("nope")).toBe("modern");
    expect(blueHue("green")).toBe("green");
    expect(blueHue("nope")).toBe("blue");
  });
});

describe("progress", () => {
  it.each([1, 2, 77, 999])(
    "never falls except at a restart and never shows 100 (seed %i)",
    (seed) => {
      const p = createProgress(seed);
      let last = p.percent;
      let version = p.version;
      const steps: [number, number, boolean][] = [];
      // Six simulated hours in half-second steps.
      for (let i = 0; i < 6 * 3600 * 2; i++) {
        stepProgress(p, 0.5);
        if (p.version !== version) {
          steps.push([last, p.percent, p.restarted]);
          version = p.version;
          last = p.percent;
        }
      }
      const rises = steps.filter(([, , restarted]) => !restarted);
      const restarts = steps.filter(([, , restarted]) => restarted);
      expect(Math.max(...steps.map(([, to]) => to))).toBeLessThanOrEqual(TOP_PERCENT);
      expect(rises.every(([from, to]) => to === from + 1)).toBe(true);
      expect(restarts.length).toBeGreaterThan(0);
      for (const [from, to] of restarts) {
        expect(from).toBe(TOP_PERCENT);
        expect(to).toBeGreaterThanOrEqual(RESTART_MIN);
        expect(to).toBeLessThanOrEqual(RESTART_MAX);
      }
    },
  );

  it("ticks every 5 to 20 s, slower near the end, and waits a long while at 99", () => {
    for (let percent = 0; percent < 90; percent++) {
      const t = tickSeconds(3, 0, percent);
      expect(t).toBeGreaterThanOrEqual(TICK_MIN);
      expect(t).toBeLessThanOrEqual(TICK_MAX);
    }
    const near = Array.from({ length: 20 }, (_, i) => tickSeconds(i, 0, 98));
    expect(Math.min(...near)).toBeGreaterThan(TICK_MIN * 2);
    const hold = tickSeconds(3, 0, TOP_PERCENT);
    expect(hold).toBeGreaterThanOrEqual(HOLD_MIN);
    expect(hold).toBeLessThanOrEqual(HOLD_MAX);
  });

  it("is deterministic per seed and differs between seeds", () => {
    const run = (seed: number) => {
      const p = createProgress(seed);
      const out: number[] = [];
      for (let i = 0; i < 600; i++) {
        stepProgress(p, 1);
        out.push(p.percent);
      }
      return out;
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
  });

  it("stands still at speed 0 and copies independently", () => {
    const p = createProgress(1);
    const before = { ...p };
    stepProgress(p, 0);
    expect(p).toEqual(before);
    const q = copyProgress(p);
    stepProgress(q, 1000);
    expect(p).toEqual(before);
    expect(q.version).toBeGreaterThan(0);
  });

  it("handles a huge step without stalling", () => {
    const p = createProgress(1);
    stepProgress(p, 1e9);
    expect(p.percent).toBeLessThanOrEqual(TOP_PERCENT);
    expect(p.timer).toBeGreaterThanOrEqual(0);
  });
});

describe("trace log", () => {
  it("adds a line every 10 to 20 s", () => {
    const log = createTraceLog(4);
    const heads: number[] = [];
    const times: number[] = [];
    let head = log.head;
    for (let t = 0.25; t < 3600; t += 0.25) {
      stepTraceLog(log, 0.25);
      if (log.head !== head) {
        heads.push(log.head - head);
        times.push(t);
        head = log.head;
      }
    }
    expect(heads.every((d) => d === 1)).toBe(true);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(LINE_MIN - 0.25);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(LINE_MAX + 0.25);
    expect(log.head).toBeGreaterThan(100);
  });

  it.each([0, 1, 42, 999])("writes ASCII trace lines of bounded length (seed %i)", (seed) => {
    expect(traceLine(seed, -1)).toBe("");
    for (let i = 0; i < 200; i++) {
      const line = traceLine(seed, i);
      expect(line).toMatch(/^ \[<ffffffff[0-9a-f]{8}>\] [a-z_]+\+0x[0-9a-f]+\/0x[0-9a-f]+$/);
      expect(line.length).toBeLessThanOrEqual(MAX_TRACE_CHARS);
    }
    expect(traceLine(seed, 3)).toBe(traceLine(seed, 3));
  });
});

describe("cursor", () => {
  it("blinks within the codec's pattern limit, softly", () => {
    expect(CURSOR_HZ).toBeLessThanOrEqual(MAX_PATTERN_HZ);
    let prev = cursorAlpha(0);
    let lo = 1;
    let hi = 0;
    for (let t = 1 / 60; t < 3; t += 1 / 60) {
      const a = cursorAlpha(t);
      expect(Math.abs(a - prev)).toBeLessThan(0.2);
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
      prev = a;
    }
    expect(lo).toBeLessThan(0.05);
    expect(hi).toBeGreaterThan(0.95);
  });
});

describe("classic text", () => {
  it("uppercases and keeps only characters the font has", () => {
    const out = classicText("We're done; ok? “yes” — 100% ☃ é\nnext_line");
    expect(out.split("\n")).toHaveLength(2);
    for (const ch of out.replace("\n", "")) {
      expect(CLASSIC_CHARS).toContain(ch);
    }
    expect(out.startsWith("WE'RE DONE: OK? 'YES' - 100% ")).toBe(true);
  });

  it("has a glyph for every character it keeps", () => {
    for (const ch of CLASSIC_CHARS) {
      const rows = classicGlyphRows(ch);
      expect(rows).toHaveLength(7);
      expect(ch === " " || rows.join("").includes("#")).toBe(true);
    }
  });
});
