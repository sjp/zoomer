import { describe, expect, it } from "vitest";
import { visibleEffects } from "../effects/list";
import { effects } from "../effects/registry";
import { createFavourites, parseFavourites } from "./favourites";
import type { PreferenceStorage } from "./preferences";

function memoryStorage(): PreferenceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const KEY = "zoomer.favourites";

describe("favourites", () => {
  it("toggles ids on and off and survives a reload", () => {
    const storage = memoryStorage();
    const favourites = createFavourites(() => storage);
    expect([...favourites.get()]).toEqual([]);
    favourites.toggle("warp");
    favourites.toggle("koi");
    expect([...favourites.get()]).toEqual(["warp", "koi"]);
    favourites.toggle("warp");
    expect([...favourites.get()]).toEqual(["koi"]);
    expect([...createFavourites(() => storage).get()]).toEqual(["koi"]);
  });

  it("gives a new set and notifies on each change", () => {
    const favourites = createFavourites(() => memoryStorage());
    const before = favourites.get();
    let calls = 0;
    const unsubscribe = favourites.subscribe(() => calls++);
    favourites.toggle("warp");
    expect(favourites.get()).not.toBe(before);
    expect(before.has("warp")).toBe(false);
    expect(calls).toBe(1);
    unsubscribe();
    favourites.toggle("warp");
    expect(calls).toBe(1);
  });

  it("ignores unknown stored ids in the list but keeps them", () => {
    const storage = memoryStorage();
    storage.setItem(KEY, JSON.stringify(["retired-effect", "warp"]));
    const favourites = createFavourites(() => storage);
    const listed = visibleEffects(effects, { sort: "az", favourites: favourites.get() });
    expect(listed).toHaveLength(effects.length);
    expect(listed[0].id).toBe("warp");
    favourites.toggle("warp");
    expect(JSON.parse(storage.data.get(KEY) ?? "")).toEqual(["retired-effect"]);
  });

  it("reads malformed stored values as no favourites", () => {
    expect(parseFavourites(null)).toEqual([]);
    expect(parseFavourites("not json")).toEqual([]);
    expect(parseFavourites('{"warp":true}')).toEqual([]);
    expect(parseFavourites('["warp", 3, null, "koi"]')).toEqual(["warp", "koi"]);
  });

  it("works in memory when storage throws or is missing", () => {
    const throwing: PreferenceStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    for (const storage of [
      () => throwing,
      () => undefined,
      () => {
        throw new Error("no window");
      },
    ]) {
      const favourites = createFavourites(storage);
      expect(favourites.get().size).toBe(0);
      expect(() => {
        favourites.toggle("warp");
      }).not.toThrow();
      expect([...favourites.get()]).toEqual(["warp"]);
    }
  });

  it("works in memory without a window", () => {
    // Vitest runs in Node, where `window` doesn't exist.
    const favourites = createFavourites();
    favourites.toggle("warp");
    expect(favourites.get().has("warp")).toBe(true);
  });
});
