import { describe, expect, it } from "vitest";
import { changedCount, groupParams } from "./param-groups";
import type { ParamSchema } from "./types";

const num = (label: string, group?: string) =>
  ({
    kind: "number",
    label,
    min: 0,
    max: 10,
    step: 1,
    default: 5,
    ...(group === undefined ? {} : { group }),
  }) as const;
const colour = (label: string, group?: string) =>
  ({
    kind: "color",
    label,
    default: "#000000",
    ...(group === undefined ? {} : { group }),
  }) as const;

describe("groupParams", () => {
  it("follows the effect's groups, in the order each first appears", () => {
    const schema: ParamSchema = {
      a: num("A", "Lights"),
      b: num("B", "Motion"),
      c: colour("C", "Colours"),
      d: num("D", "Lights"),
      e: colour("E", "Colours"),
    };
    expect(groupParams(schema)).toEqual([
      { name: "Lights", keys: ["a", "d"] },
      { name: "Motion", keys: ["b"] },
      { name: "Colours", keys: ["c", "e"] },
    ]);
  });

  it("puts params without a group in the default section for their kind", () => {
    expect(groupParams({ a: num("A", "Motion"), b: colour("B"), c: num("C") })).toEqual([
      { name: "Motion", keys: ["a"] },
      { name: "Colours", keys: ["b"] },
      { name: "Settings", keys: ["c"] },
    ]);
  });

  it("splits an ungrouped effect into Settings, then Colours", () => {
    expect(groupParams({ a: colour("A"), b: num("B"), c: colour("C") })).toEqual([
      { name: "Settings", keys: ["b"] },
      { name: "Colours", keys: ["a", "c"] },
    ]);
    expect(groupParams({ a: num("A") })).toEqual([{ name: "Settings", keys: ["a"] }]);
    expect(groupParams({})).toEqual([]);
  });
});

describe("changedCount", () => {
  it("counts the keys whose value differs from the default", () => {
    const schema: ParamSchema = { a: num("A"), b: num("B"), c: colour("C") };
    expect(changedCount(schema, {}, ["a", "b", "c"])).toBe(0);
    expect(changedCount(schema, { a: 5, b: 6, c: "#000000" }, ["a", "b", "c"])).toBe(1);
    // A colour differing only in case is unchanged.
    expect(changedCount(schema, { b: 6, c: "#ABCDEF" }, ["a", "c"])).toBe(1);
    expect(changedCount(schema, { b: 6 }, ["a"])).toBe(0);
  });
});
