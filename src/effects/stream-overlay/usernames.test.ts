import { describe, expect, it } from "vitest";
import {
  makeUsername,
  USERNAME_FIRST_WORDS,
  USERNAME_NUMBERS,
  USERNAME_SECOND_WORDS,
} from "./usernames";

/** Every first-plus-second word pair, lowercase and run together. */
const PAIRS = new Set(USERNAME_FIRST_WORDS.flatMap((a) => USERNAME_SECOND_WORDS.map((b) => a + b)));

/** Whether `name` is a listed word pair, optionally split by `_`, then optionally a listed number. */
function fromLists(name: string): boolean {
  const m = /^([A-Za-z]+)(?:_([a-z]+))?(\d*)$/.exec(name);
  if (m === null) {
    return false;
  }
  const words = (m[1] + (m.at(2) ?? "")).toLowerCase();
  const number = m[3];
  return PAIRS.has(words) && (number === "" || USERNAME_NUMBERS.includes(number));
}

describe("makeUsername", () => {
  it.each([1, 7, 0xdeadbeef])("makes names only from the word lists (seed %i)", (seed) => {
    const bad: string[] = [];
    for (let user = 0; user < 100_000 / 3; user++) {
      const name = makeUsername(seed, user);
      if (!fromLists(name)) {
        bad.push(name);
      }
    }
    expect(bad).toEqual([]);
  });

  it("lists only lowercase words, each once", () => {
    for (const list of [USERNAME_FIRST_WORDS, USERNAME_SECOND_WORDS]) {
      expect(new Set(list).size).toBe(list.length);
      for (const word of list) {
        expect(word).toMatch(/^[a-z]+$/);
      }
    }
  });

  it("is stable per seed and viewer, and varies between them", () => {
    expect(makeUsername(3, 12)).toBe(makeUsername(3, 12));
    const names = new Set(Array.from({ length: 1000 }, (_, i) => makeUsername(3, i)));
    expect(names.size).toBeGreaterThan(950);
    const other = Array.from({ length: 50 }, (_, i) => makeUsername(4, i));
    expect(other.filter((n, i) => n === makeUsername(3, i)).length).toBeLessThan(5);
  });

  it("uses every style: snake case, capitals, run together, with and without a number", () => {
    const names = Array.from({ length: 600 }, (_, i) => makeUsername(9, i));
    expect(names.some((n) => /^[a-z]+_[a-z]+$/.test(n))).toBe(true);
    expect(names.some((n) => /^[a-z]+_[a-z]+\d+$/.test(n))).toBe(true);
    expect(names.some((n) => /^[A-Z][a-z]+[A-Z][a-z]+\d+$/.test(n))).toBe(true);
    expect(names.some((n) => /^[A-Z][a-z]+[A-Z][a-z]+$/.test(n))).toBe(true);
    expect(names.some((n) => /^[a-z]+$/.test(n))).toBe(true);
    expect(names.some((n) => /^[a-z]+\d+$/.test(n))).toBe(true);
  });

  it("keeps names short enough for a narrow column", () => {
    for (let user = 0; user < 5000; user++) {
      expect(makeUsername(1, user).length).toBeLessThanOrEqual(20);
    }
  });
});
