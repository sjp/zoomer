import { describe, expect, it } from "vitest";
import { has, lookup } from "./lookup";

const TABLE = { a: 1, b: 2 } as const;

describe("lookup", () => {
  it("returns the entry for a known id", () => {
    expect(lookup(TABLE, "b", "a")).toBe(2);
  });

  it("falls back for unknown and inherited names", () => {
    for (const key of ["zzz", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(lookup(TABLE, key, "a")).toBe(1);
      expect(has(TABLE, key)).toBe(false);
    }
  });
});
