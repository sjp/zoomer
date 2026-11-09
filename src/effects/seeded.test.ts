/**
 * Effects are deterministic: every random layout and simulation draws from a
 * seeded RNG (`createRng` in `noise.ts`, seeded by a constant or the effect's
 * seed param), so tests can pin what they draw and a link brings back the same
 * look. `Math.random` would make each load different.
 */
import { describe, expect, it } from "vitest";

const files = Object.entries(
  import.meta.glob<string>(["./*.ts", "./*/*.ts", "!./**/*.test.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

describe("effect randomness", () => {
  it("finds the effect sources", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("never uses Math.random", () => {
    const bad = files.filter(([, source]) => /\bMath\.random\b/.test(source)).map(([p]) => p);
    expect(bad).toEqual([]);
  });
});
