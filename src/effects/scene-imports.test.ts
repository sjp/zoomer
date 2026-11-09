/**
 * The Scenes were each started from an earlier one, so code they share lives in
 * `src/effects/*.ts` where the next scene will find it, rather than in one
 * scene's folder for the others to reach into (which also ties their lazily
 * loaded chunks together).
 */
import { describe, expect, it } from "vitest";
import { effects } from "./registry";

const files = Object.entries(
  import.meta.glob<string>("./*/*.ts", { query: "?raw", import: "default", eager: true }),
).map(([path, text]) => [path.replace(/^\.\//, ""), text] as const);

const sceneFolders = new Set(effects.filter((e) => e.category === "Scenes").map((e) => e.id));

/** Folders a file imports from with `../<folder>/...`, type-only imports included. */
function foldersImported(source: string): string[] {
  return [...source.matchAll(/\bfrom\s*["']\.\.\/([\w-]+)\//g)].map((m) => m[1]);
}

describe("Scene imports", () => {
  it("finds the Scenes by their folders", () => {
    expect(sceneFolders.size).toBeGreaterThan(10);
    for (const id of sceneFolders) {
      expect(files.some(([path]) => path.startsWith(`${id}/`))).toBe(true);
    }
  });

  it("never reach into another scene's folder", () => {
    const bad: string[] = [];
    for (const [path, source] of files) {
      const own = path.split("/")[0];
      if (!sceneFolders.has(own)) {
        continue;
      }
      for (const folder of foldersImported(source)) {
        if (folder !== own && sceneFolders.has(folder)) {
          bad.push(`${path} imports from ${folder}/`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
