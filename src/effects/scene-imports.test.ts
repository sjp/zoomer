/**
 * The Scenes were each started from an earlier one, so code they share lives in
 * `src/effects/*.ts` where the next scene will find it, rather than in one
 * scene's folder for the others to reach into (which also ties their lazily
 * loaded chunks together).
 *
 * Other effects may still share a `-sim.ts` or helper module from one effect's
 * folder, but none imports another effect's implementation (`<id>/<id>.ts`, the
 * module the registry loads on demand): that would load the other effect's code
 * and shaders with it.
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

/** Modules a file imports with `../<folder>/<module>`, as `<folder>/<module>`. */
function modulesImported(source: string): string[] {
  return [...source.matchAll(/\bfrom\s*["']\.\.\/([\w-]+\/[\w.-]+?)(?:\.ts)?["']/g)].map(
    (m) => m[1],
  );
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

describe("Effect imports", () => {
  const ids = new Set(effects.map((e) => e.id));

  it("reads the module each import names", () => {
    expect(modulesImported(`import { a } from "../caustics/caustics";`)).toEqual([
      "caustics/caustics",
    ]);
    expect(modulesImported(`import type { B } from '../caustics/caustics-sim.ts';`)).toEqual([
      "caustics/caustics-sim",
    ]);
  });

  it("never import another effect's implementation module", () => {
    const bad: string[] = [];
    for (const [path, source] of files) {
      const own = path.split("/")[0];
      for (const module of modulesImported(source)) {
        const [folder, name] = module.split("/");
        if (folder !== own && folder === name && ids.has(folder)) {
          bad.push(`${path} imports ${module}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
