/**
 * `frame()` allocates nothing: at 120 fps even a small string or closure a frame
 * adds up to steady garbage-collection work. Measuring the heap under Node can't
 * check this (numeric code boxes doubles until it is optimised, which swamps a
 * stray string), so this reads each effect's `frame` body instead and rejects the
 * usual culprits: template literals, closures, object and array literals, and
 * `new`.
 *
 * Work that runs only now and then (a rebuild when a param changes, a first-frame
 * setup, an error report) may allocate: put a comment beginning `// Allocates`
 * above it, inside the block it runs in, saying when it runs. That clears the
 * rest of the block. `throw new …` needs no comment.
 *
 * Only `frame` bodies are read, not the helpers they call.
 */
import { describe, expect, it } from "vitest";

const sources = Object.entries(
  import.meta.glob<string>(["./*.ts", "./*/*.ts", "!./**/*.test.ts", "!./**/*.meta.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).map(([path, text]) => [path.replace(/^\.\//, ""), text] as const);

interface Masked {
  /** The source with comments, strings and template literals blanked (newlines kept). */
  code: string;
  /** Where each template literal starts. */
  templates: number[];
  /** Where each `// Allocates` comment starts. */
  markers: number[];
}

const REGEX_BEFORE = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";"]);

/** Blanks everything that isn't code, so braces and keywords can be matched with regexes. */
function mask(src: string): Masked {
  const out = src.split("");
  const templates: number[] = [];
  const markers: number[] = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== "\n") {
        out[k] = " ";
      }
    }
  };
  let last = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (src.startsWith("//", i)) {
      const end = src.includes("\n", i) ? src.indexOf("\n", i) : src.length;
      if (/^\/\/\s*Allocates\b/.test(src.slice(i, end))) {
        markers.push(i);
      }
      blank(i, end);
      i = end;
    } else if (src.startsWith("/*", i)) {
      const end = src.includes("*/", i) ? src.indexOf("*/", i) + 2 : src.length;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        j += src[j] === "\\" ? 2 : 1;
      }
      blank(i + 1, j);
      i = j + 1;
      last = c;
    } else if (c === "`") {
      templates.push(i);
      let j = i + 1;
      let depth = 0;
      while (j < src.length && (depth > 0 || src[j] !== "`")) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src.startsWith("${", j)) {
          depth++;
          j++;
        } else if (src[j] === "}" && depth > 0) {
          depth--;
        }
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      last = c;
    } else if (c === "/" && REGEX_BEFORE.has(last)) {
      // A regex literal, which never spans lines.
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n" && (inClass || src[j] !== "/")) {
        if (src[j] === "\\") {
          j++;
        } else if (src[j] === "[") {
          inClass = true;
        } else if (src[j] === "]") {
          inClass = false;
        }
        j++;
      }
      if (src[j] !== "/") {
        // Not a regex after all: a division.
        last = c;
        i++;
        continue;
      }
      blank(i + 1, j);
      i = j + 1;
      last = "/";
    } else {
      if (!/\s/.test(c)) {
        last = c;
      }
      i++;
    }
  }
  return { code: out.join(""), templates, markers };
}

/** The index of the `}` closing the block whose `{` is at `open`. */
function closing(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") {
      depth++;
    } else if (code[i] === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return code.length;
}

/** The end of the block that contains `at`. */
function blockEnd(code: string, at: number): number {
  let depth = 0;
  for (let i = at; i < code.length; i++) {
    if (code[i] === "{") {
      depth++;
    } else if (code[i] === "}") {
      if (depth === 0) {
        return i;
      }
      depth--;
    }
  }
  return code.length;
}

const PATTERNS: [string, RegExp][] = [
  ["a closure", /=>|\bfunction\b/g],
  ["new", /(?<!\bthrow\s+)\bnew\s+[A-Z]/g],
  ["an object literal", /(?:[(,=:?[]|\breturn|\bof)\s*\{/g],
  ["an array literal", /(?:[(,=:?]|\breturn|\bof)\s*\[/g],
];

/** Allocations in the `frame` bodies of `src`, as `line: what: text`. */
function frameAllocations(src: string): string[] {
  const { code, templates, markers } = mask(src);
  const lines = src.split("\n");
  const lineOf = (at: number) => code.slice(0, at).split("\n").length;
  const found: string[] = [];
  for (const header of code.matchAll(/^[ \t]+frame\([^)]*\)(?:: void)? \{/gm)) {
    const open = header.index + header[0].length - 1;
    const close = closing(code, open);
    const cleared = markers
      .filter((m) => m > open && m < close)
      .map((m) => [m, blockEnd(code, m)] as const);
    const report = (at: number, what: string) => {
      if (cleared.some(([from, to]) => at > from && at < to)) {
        return;
      }
      const line = lineOf(at);
      const text = lines[line - 1].trim();
      // `case 1: {` opens a block, not an object.
      if (what === "an object literal" && /^(case\b.*|default):\s*\{$/.test(text)) {
        return;
      }
      found.push(`${String(line)}: ${what}: ${text}`);
    };
    for (const t of templates) {
      if (t > open && t < close) {
        report(t, "a template literal");
      }
    }
    const body = code.slice(open + 1, close);
    for (const [what, re] of PATTERNS) {
      for (const m of body.matchAll(re)) {
        report(open + 1 + m.index, what);
      }
    }
  }
  return found;
}

describe("frame() allocations", () => {
  it("finds the effects' frame bodies", () => {
    const withFrame = sources.filter(([, src]) => /^[ \t]+frame\(/m.test(src));
    expect(withFrame.length).toBeGreaterThan(100);
  });

  it("spots each kind of allocation, and honours the comment", () => {
    const src = [
      "const fx = {",
      "  frame(dt, p) {",
      "    const key = `${p.a}`;",
      "    const f = () => 1;",
      "    const o = g({ a: 1 });",
      "    const a = [1, 2];",
      "    const s = new Set();",
      "    if (dirty) {",
      "      // Allocates only when the layout changes.",
      "      const b = [3];",
      "    }",
      "    const c = d[0];",
      "    switch (p.k) {",
      "      case 1: {",
      "        break;",
      "      }",
      "    }",
      '    if (!t) throw new Error("x");',
      "  },",
      "};",
    ].join("\n");
    expect(frameAllocations(src)).toEqual([
      "3: a template literal: const key = `${p.a}`;",
      "4: a closure: const f = () => 1;",
      "7: new: const s = new Set();",
      "5: an object literal: const o = g({ a: 1 });",
      "6: an array literal: const a = [1, 2];",
    ]);
  });

  it.each(sources.filter(([, src]) => /^[ \t]+frame\(/m.test(src)))(
    "%s allocates nothing per frame",
    (_path, src) => {
      expect(frameAllocations(src)).toEqual([]);
    },
  );
});
