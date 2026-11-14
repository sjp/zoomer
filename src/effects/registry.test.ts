import { describe, expect, it } from "vitest";
import { defaults, encodeHash, stateFromHash } from "./params";
import { LIFECYCLE_SHARDS, lifecycleShard } from "../test/lifecycle";
import { defaultEffect, effects } from "./registry";
import { EFFECT_CATEGORIES, EFFECT_COSTS } from "./types";

describe.each(effects.map((e) => [e.id, e] as const))("%s", (_, entry) => {
  it("loads an implementation that matches its metadata", async () => {
    const effect = await entry.load();
    expect(effect.id).toBe(entry.id);
    expect(effect.name).toBe(entry.name);
    expect(effect.description).toBe(entry.description);
    expect(effect.context).toBe(entry.context);
    expect(effect.params).toBe(entry.params);
    expect(typeof effect.create).toBe("function");
  });

  it("round-trips through the URL hash using metadata only", () => {
    const values = defaults(entry.params);
    const state = stateFromHash(encodeHash(entry, values), effects, defaultEffect);
    expect(state.effect).toBe(entry);
    expect(state.values).toEqual(values);
  });

  it("has one to three categories, a cost and lowercase search tags", () => {
    expect(entry.categories.length).toBeGreaterThanOrEqual(1);
    expect(entry.categories.length).toBeLessThanOrEqual(3);
    expect(new Set(entry.categories).size).toBe(entry.categories.length);
    for (const category of entry.categories) {
      expect(EFFECT_CATEGORIES).toContain(category);
    }
    expect(EFFECT_COSTS).toContain(entry.cost);
    expect(entry.tags.length).toBeGreaterThan(0);
    for (const tag of entry.tags) {
      expect(tag).toMatch(/^[a-z0-9][a-z0-9 '-]*$/);
    }
  });
});

describe("lifecycle tests", () => {
  it("have a file for every shard, so no effect goes unchecked", () => {
    const files = Object.keys(import.meta.glob("./lifecycle-*.test.ts")).toSorted();
    expect(files).toEqual(
      Array.from(
        { length: LIFECYCLE_SHARDS },
        (_, n) => `./lifecycle-${String(n)}.test.ts`,
      ).toSorted(),
    );
  });

  it("put every effect in exactly one shard", () => {
    for (const entry of effects) {
      const shard = lifecycleShard(entry.id);
      expect(Number.isInteger(shard)).toBe(true);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(LIFECYCLE_SHARDS);
    }
  });

  it("spread the effects roughly evenly over the shards", () => {
    const counts = Array.from({ length: LIFECYCLE_SHARDS }, () => 0);
    for (const entry of effects) {
      counts[lifecycleShard(entry.id)]++;
    }
    const mean = effects.length / LIFECYCLE_SHARDS;
    for (const count of counts) {
      expect(count).toBeGreaterThan(mean / 2);
      expect(count).toBeLessThan(mean * 2);
    }
  });
});
