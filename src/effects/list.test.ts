import { describe, expect, it } from "vitest";
import {
  adjacentEffects,
  effectGroup,
  isEffectSort,
  normalizeText,
  searchWords,
  stepEffect,
  visibleEffects,
  type ListableEffect,
  type ListOptions,
} from "./list";
import { DEFAULT_EFFECT_ID, effects } from "./registry";

/** Listed in featured order. */
const list: ListableEffect[] = [
  {
    id: "warp",
    name: "Warp Speed",
    description: "Stars stretch into streaks.",
    category: "Space",
    tags: ["sci-fi"],
    cost: "very low",
  },
  {
    id: "sea",
    name: "Calm Sea at Dusk",
    description: "A gentle swell under a dusk sky.",
    category: "Water",
    tags: ["ocean", "waves"],
    cost: "medium",
  },
  {
    id: "blobs",
    name: "Gradient Blobs",
    description: "Soft colour fields drift and merge.",
    category: "Abstract",
    tags: ["minimal"],
    cost: "very low",
  },
  {
    id: "koi",
    name: "Koi Pond",
    description: "Koi gliding beneath lily pads, with blue water.",
    category: "Water",
    tags: ["fish", "japanese"],
    cost: "medium",
  },
  {
    id: "nebula",
    name: "Nebula",
    description: "Glowing clouds of interstellar gas.",
    category: "Space",
    tags: ["galaxy"],
    cost: "low",
  },
  {
    id: "cafe",
    name: "Café Étoile",
    description: "A sea of tables under the stars.",
    category: "Cosy",
    tags: ["coffee"],
  },
];

const ids = (options: ListOptions) => visibleEffects(list, options).map((e) => e.id);

describe("normalizeText / searchWords", () => {
  it("lowercases, strips accents and splits on punctuation", () => {
    expect(normalizeText("Café Étoile")).toBe("cafe etoile");
    expect(normalizeText("Day–Night  Horizon!")).toBe("day night horizon");
    expect(searchWords("  Blue   WATER ")).toEqual(["blue", "water"]);
    expect(searchWords("  - ")).toEqual([]);
    expect(searchWords(undefined)).toEqual([]);
  });
});

describe("isEffectSort", () => {
  it("accepts only known sorts", () => {
    expect(isEffectSort("az")).toBe(true);
    expect(isEffectSort("lightest")).toBe(true);
    expect(isEffectSort("toString")).toBe(false);
    expect(isEffectSort(null)).toBe(false);
  });
});

describe("visibleEffects", () => {
  it("keeps the featured order", () => {
    expect(ids({ sort: "featured" })).toEqual(["warp", "sea", "blobs", "koi", "nebula", "cafe"]);
  });

  it("sorts A–Z ignoring case and accents", () => {
    expect(ids({ sort: "az" })).toEqual(["cafe", "sea", "blobs", "koi", "nebula", "warp"]);
  });

  it("groups by category in display order, A–Z within each", () => {
    expect(ids({ sort: "category" })).toEqual(["nebula", "warp", "sea", "koi", "cafe", "blobs"]);
    expect(list.map((e) => effectGroup(e, { sort: "category" }))).toEqual([
      "Space",
      "Water",
      "Abstract",
      "Water",
      "Space",
      "Cosy",
    ]);
    expect(effectGroup(list[0], { sort: "az" })).toBeUndefined();
  });

  it("sorts lightest first, featured order within a cost, unknown cost last", () => {
    expect(ids({ sort: "lightest" })).toEqual(["warp", "blobs", "nebula", "sea", "koi", "cafe"]);
  });

  it("filters on name, tag, description and category", () => {
    expect(ids({ sort: "featured", query: "pond" })).toEqual(["koi"]);
    expect(ids({ sort: "featured", query: "galaxy" })).toEqual(["nebula"]);
    expect(ids({ sort: "featured", query: "lily" })).toEqual(["koi"]);
    expect(ids({ sort: "featured", query: "abstract" })).toEqual(["blobs"]);
    expect(ids({ sort: "featured", query: "   " })).toHaveLength(list.length);
    expect(ids({ sort: "featured", query: "zzz" })).toEqual([]);
  });

  it("matches every word, case- and accent-insensitively", () => {
    expect(ids({ sort: "featured", query: "blue water" })).toEqual(["koi"]);
    expect(ids({ sort: "featured", query: "WATER Fish" })).toEqual(["koi"]);
    expect(ids({ sort: "featured", query: "etoile" })).toEqual(["cafe"]);
    expect(ids({ sort: "featured", query: "étoilé" })).toEqual(["cafe"]);
    expect(ids({ sort: "featured", query: "cafe coffee" })).toEqual(["cafe"]);
  });

  it("ranks name matches above other matches", () => {
    // "sea" is in Café Étoile's description but Calm Sea's name.
    expect(ids({ sort: "az", query: "sea" })).toEqual(["sea", "cafe"]);
    // A word starting a name word beats one inside it.
    expect(ids({ sort: "featured", query: "e" })[0]).toBe("cafe");
  });

  it("ranks within each category group", () => {
    // Warp Speed's name matches, so it leads Space despite sorting after Nebula.
    expect(ids({ sort: "category", query: "s" })).toEqual([
      "warp",
      "nebula",
      "sea",
      "koi",
      "cafe",
      "blobs",
    ]);
  });

  it("lists favourites first in the current sort, filtering both groups", () => {
    const favourites = new Set(["koi", "nebula", "gone"]);
    expect(ids({ sort: "featured", favourites })).toEqual([
      "koi",
      "nebula",
      "warp",
      "sea",
      "blobs",
      "cafe",
    ]);
    expect(ids({ sort: "az", favourites })).toEqual([
      "koi",
      "nebula",
      "cafe",
      "sea",
      "blobs",
      "warp",
    ]);
    expect(ids({ sort: "featured", favourites, query: "water" })).toEqual(["koi", "sea"]);
    expect(effectGroup(list[3], { sort: "category", favourites })).toBe("Favourites");
    expect(effectGroup(list[1], { sort: "category", favourites })).toBe("Water");
  });

  it("lists favourites first under every sort, in that sort", () => {
    const favourites = new Set(["cafe", "koi", "warp"]);
    // By category: Space (warp), Water (koi), Cosy (cafe), then the rest by category.
    expect(ids({ sort: "category", favourites })).toEqual([
      "warp",
      "koi",
      "cafe",
      "nebula",
      "sea",
      "blobs",
    ]);
    // Lightest: very low (warp), medium (koi), unknown (cafe); then blobs, nebula, sea.
    expect(ids({ sort: "lightest", favourites })).toEqual([
      "warp",
      "koi",
      "cafe",
      "blobs",
      "nebula",
      "sea",
    ]);
    // Within each group, name matches still rank first.
    expect(ids({ sort: "az", favourites, query: "sea" })).toEqual(["cafe", "sea"]);
    expect(ids({ sort: "az", favourites, query: "s" })).toEqual([
      "warp",
      "cafe",
      "koi",
      "sea",
      "blobs",
      "nebula",
    ]);
    const grouped = (sort: ListOptions["sort"]) =>
      visibleEffects(list, { sort, favourites }).map((e) => effectGroup(e, { sort, favourites }));
    for (const sort of ["featured", "az", "lightest"] as const) {
      expect(grouped(sort)).toEqual([
        ...Array.from({ length: 3 }, () => "Favourites"),
        ...Array.from({ length: 3 }, () => undefined),
      ]);
    }
    expect(grouped("category")).toEqual([
      "Favourites",
      "Favourites",
      "Favourites",
      "Space",
      "Water",
      "Abstract",
    ]);
  });

  it("returns the registry's effects with the default first when featured", () => {
    const out = visibleEffects(effects, { sort: "featured" });
    expect(out).toEqual(effects);
    expect(out[0].id).toBe(DEFAULT_EFFECT_ID);
    expect(visibleEffects(effects, { sort: "az" })).toHaveLength(effects.length);
  });
});

describe("stepEffect", () => {
  const step = (options: ListOptions, from: string, dir: 1 | -1) =>
    stepEffect(list, options, from, dir)?.id;

  it("steps through the sorted list and wraps at both ends", () => {
    const az: ListOptions = { sort: "az" };
    expect(step(az, "cafe", 1)).toBe("sea");
    expect(step(az, "cafe", -1)).toBe("warp");
    expect(step(az, "warp", 1)).toBe("cafe");
  });

  it("steps through the filtered list", () => {
    const water: ListOptions = { sort: "featured", query: "water" };
    expect(step(water, "sea", 1)).toBe("koi");
    expect(step(water, "koi", 1)).toBe("sea");
    expect(step(water, "sea", -1)).toBe("koi");
  });

  it("steps from where a filtered-out effect would sort", () => {
    const water: ListOptions = { sort: "featured", query: "water" };
    // Featured: warp, sea, blobs, koi, nebula, cafe. Blobs sits between sea and koi.
    expect(step(water, "blobs", 1)).toBe("koi");
    expect(step(water, "blobs", -1)).toBe("sea");
    // Nebula comes after koi, so → wraps round to sea.
    expect(step(water, "nebula", 1)).toBe("sea");
    expect(step(water, "nebula", -1)).toBe("koi");
    // An unknown id goes to either end.
    expect(step(water, "gone", 1)).toBe("sea");
    expect(step(water, "gone", -1)).toBe("koi");
  });

  it("returns nothing when nothing matches", () => {
    expect(step({ sort: "featured", query: "zzz" }, "warp", 1)).toBeUndefined();
  });

  it("follows favourites first", () => {
    const options: ListOptions = { sort: "featured", favourites: new Set(["nebula"]) };
    expect(step(options, "nebula", 1)).toBe("warp");
    expect(step(options, "warp", -1)).toBe("nebula");
  });
});

describe("adjacentEffects", () => {
  it("returns next then previous, without repeats or the current effect", () => {
    const adjacentIds = (options: ListOptions, from: string) =>
      adjacentEffects(list, options, from).map((e) => e.id);
    expect(adjacentIds({ sort: "featured" }, "sea")).toEqual(["blobs", "warp"]);
    expect(adjacentIds({ sort: "featured", query: "water" }, "sea")).toEqual(["koi"]);
    expect(adjacentIds({ sort: "featured", query: "pond" }, "koi")).toEqual([]);
    expect(adjacentIds({ sort: "featured", query: "pond" }, "warp")).toEqual(["koi"]);
  });
});
