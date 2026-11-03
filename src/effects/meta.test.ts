/**
 * Effect metadata ships in the entry chunk; implementations load on demand. These
 * checks keep a `.meta.ts` file from pulling an implementation, a simulation or a GL
 * helper into the entry chunk through a runtime import.
 */
import { describe, expect, it } from "vitest";

const sources = (files: Record<string, string>) =>
  Object.entries(files).map(([path, text]) => [path.replace(/^\.\//, ""), text] as const);

const metaFiles = sources(
  import.meta.glob<string>("./*.meta.ts", { query: "?raw", import: "default", eager: true }),
);
const leafFiles = sources(
  import.meta.glob<string>(["./types.ts", "./param-options.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/**
 * Module specifiers a file loads at runtime: static imports and re-exports that aren't
 * type-only, side-effect imports, and dynamic imports. `import type` is erased.
 */
function runtimeImports(source: string): string[] {
  const out: string[] = [];
  const statement = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/gm;
  for (const m of source.matchAll(statement)) {
    if (!m[2]) out.push(m[4]);
  }
  for (const m of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

/** What a `.meta.ts` file may import at runtime: types, shared options and other metadata. */
const META_IMPORT = /^\.\/(types|param-options|[\w-]+\.meta)$/;

describe("runtimeImports", () => {
  it("finds runtime imports and skips type-only ones", () => {
    const source = [
      'import { a } from "./a";',
      'import type { B } from "./b";',
      "import {",
      "  c,",
      "  type D,",
      '} from "./c";',
      'export { e } from "./e";',
      'export type { F } from "./f";',
      'import "./g";',
      'const h = () => import("./h");',
    ].join("\n");
    expect(runtimeImports(source)).toEqual(["./a", "./c", "./e", "./g", "./h"]);
  });
});

describe("effect metadata modules", () => {
  it("exist", () => {
    expect(metaFiles.length).toBeGreaterThan(0);
  });

  it.each(metaFiles)("%s imports only metadata at runtime", (_, source) => {
    expect(runtimeImports(source).filter((s) => !META_IMPORT.test(s))).toEqual([]);
  });

  it.each(leafFiles)("%s imports nothing at runtime", (_, source) => {
    expect(runtimeImports(source)).toEqual([]);
  });
});
