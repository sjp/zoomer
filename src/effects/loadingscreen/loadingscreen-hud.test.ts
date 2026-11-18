import { describe, expect, it } from "vitest";
import {
  BAR_MAX_WIDTH,
  createHudLayout,
  layoutHud,
  TIP_LINES,
  wrapWords,
} from "./loadingscreen-hud";

/** A fake measure: every character 10 px wide. */
const measure = (s: string) => s.length * 10;

describe("HUD layout", () => {
  it.each([
    [1920, 1080],
    [960, 540],
    [3840, 2160],
    [2560, 1080],
    [5120, 2160],
  ])("keeps the tip, bar and emblem out of the middle third at %i x %i", (w, h) => {
    const l = layoutHud(w, h, h / 1080, createHudLayout());
    expect(l.stacked).toBe(false);
    const left = w / 3;
    const right = (2 * w) / 3;
    expect(l.tip.x + l.tip.w).toBeLessThanOrEqual(left);
    expect(l.tip.x).toBeGreaterThan(0);
    for (const b of [l.label, l.bar]) {
      expect(b.x).toBeGreaterThanOrEqual(right);
      expect(b.x + b.w).toBeLessThanOrEqual(w);
    }
    expect(l.emblemX - l.emblemR).toBeGreaterThanOrEqual(right);
    expect(l.emblemX + l.emblemR).toBeLessThan(w);
    expect(l.bar.x + l.bar.w).toBeLessThan(l.emblemX - l.emblemR);
    for (const b of [l.tip, l.label, l.bar]) {
      expect(b.y + b.h).toBeLessThan(h);
      expect(b.y).toBeGreaterThan(h / 2);
    }
    expect(l.emblemY + l.emblemR).toBeLessThan(h);
  });

  it.each([
    [1080, 1920],
    [480, 640],
  ])("stacks across the bottom of a narrow %i x %i frame", (w, h) => {
    const l = layoutHud(w, h, h / 1080, createHudLayout());
    expect(l.stacked).toBe(true);
    expect(l.tip.x + l.tip.w).toBeLessThanOrEqual(w);
    expect(l.bar.y + l.bar.h).toBeLessThan(l.tip.y);
    expect(l.emblemY + l.emblemR).toBeLessThan(l.tip.y);
    expect(l.bar.x).toBeGreaterThan(0);
  });

  it.each([
    [1920, 1080],
    [5120, 1080],
    [1080, 1920],
  ])("keeps the bar no longer than its cap at %i x %i", (w, h) => {
    const k = h / 1080;
    const l = layoutHud(w, h, k, createHudLayout());
    expect(l.bar.w).toBeLessThanOrEqual(Math.round(BAR_MAX_WIDTH * k) + 1);
    expect(l.bar.w).toBeGreaterThan(0);
  });

  it("survives a 1 x 1 frame", () => {
    const l = layoutHud(1, 1, 1 / 1080, createHudLayout());
    expect(l.bar.w).toBeGreaterThanOrEqual(1);
    expect(l.tipPx).toBeGreaterThanOrEqual(1);
  });
});

describe("tip wrapping", () => {
  it("keeps a short tip on one line", () => {
    expect(wrapWords("Short tip here", measure, 300, 400, TIP_LINES)).toEqual(["Short tip here"]);
  });

  it("breaks at spaces, the first line after the prefix", () => {
    expect(wrapWords("aaaa bbbb cccc dddd", measure, 100, 200, 2)).toEqual([
      "aaaa bbbb",
      "cccc dddd",
    ]);
  });

  it("puts the overflow on the last line", () => {
    expect(wrapWords("aaaa bbbb cccc dddd eeee", measure, 50, 50, 2)).toEqual([
      "aaaa",
      "bbbb cccc dddd eeee",
    ]);
  });

  it("gives one empty line for empty text", () => {
    expect(wrapWords("  ", measure, 50, 50, 2)).toEqual([""]);
  });
});
