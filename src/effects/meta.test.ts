/**
 * Effect metadata ships in the entry chunk; implementations load on demand. These
 * checks keep a `.meta.ts` file from pulling an implementation, a simulation or a GL
 * helper into the entry chunk through a runtime import.
 */
import { describe, expect, it } from "vitest";
import { sanitizeText } from "./params";
import { effects } from "./registry";
import type { TextParam } from "./types";

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

const registrySource = Object.values(
  import.meta.glob<string>("./registry.ts", { query: "?raw", import: "default", eager: true }),
)[0];

/**
 * Module specifiers a file imports statically at runtime: imports and re-exports that
 * aren't type-only, and side-effect imports. `import type` is erased.
 */
function staticImports(source: string): string[] {
  const out: string[] = [];
  const statement = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/gm;
  for (const m of source.matchAll(statement)) {
    if (!m[2]) out.push(m[4]);
  }
  for (const m of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(m[1]);
  return out;
}

/** Module specifiers a file imports with `import()`. */
function dynamicImports(source: string): string[] {
  return [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
}

const runtimeImports = (source: string) => [...staticImports(source), ...dynamicImports(source)];

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

describe("registry", () => {
  it("imports only metadata up front", () => {
    const allowed = (s: string) => META_IMPORT.test(s) || s === "./loader";
    expect(staticImports(registrySource).filter((s) => !allowed(s))).toEqual([]);
  });

  it("loads each implementation next to its metadata", () => {
    const lazy = dynamicImports(registrySource);
    expect(lazy.length).toBeGreaterThan(0);
    const metas = new Set(staticImports(registrySource));
    expect(lazy.filter((s) => !metas.has(`${s}.meta`))).toEqual([]);
  });
});

const textParams = effects.flatMap((e) =>
  Object.entries(e.params)
    .filter((entry): entry is [string, TextParam] => entry[1].kind === "text")
    .map(([key, def]) => [`${e.id}.${key}`, def] as const),
);

describe("text params", () => {
  it("are all found through the registry", () => {
    const declared = metaFiles.reduce((n, [, src]) => n + src.split('kind: "text"').length - 1, 0);
    expect(textParams.length).toBe(declared);
  });

  it.each(textParams)("%s has whole-number limits and a sanitised default", (_, def) => {
    expect(Number.isInteger(def.maxLength) && def.maxLength > 0).toBe(true);
    expect(Number.isInteger(def.maxLines) && def.maxLines > 0).toBe(true);
    expect(sanitizeText(def, def.default)).toBe(def.default);
  });
});
