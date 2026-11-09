/**
 * Lists exports nothing else imports: names a module exports but no other file
 * in `src/`, `e2e/` or `scripts/` (tests included) imports. Each one should be
 * un-exported, deleted, or (when something outside the module graph reads it)
 * added to `ALLOW` below with the reason.
 *
 *   node scripts/unused-exports.mjs
 *
 * Exits 1 when it finds any. It reads import and export statements with
 * regular expressions rather than a full parser, which is enough for this
 * codebase's plain ES module syntax: comments and string literals are blanked
 * first, so GLSL and documentation can't be mistaken for code. A dynamic
 * `import()` or `import * as` of a module counts as using all of its exports;
 * `?raw` imports use none.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DIRS = ["src", "e2e", "scripts"];
const ROOT_FILES = ["vite.config.ts", "vitest.perf.config.ts", "playwright.config.ts"];
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

/**
 * Exports used from outside the module graph, as "path#name" (or "path#*" for
 * every export of a file), with why.
 */
const ALLOW = new Map([
  ["vite.config.ts#*", "read by Vite"],
  ["vitest.perf.config.ts#*", "read by Vitest"],
  ["playwright.config.ts#*", "read by Playwright"],
]);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else if (EXTENSIONS.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * `source` with comments removed and string and template literal contents
 * blanked (template `${...}` expressions are kept), keeping import specifiers:
 * a quoted string directly after `from`, `import` or `import(` survives.
 * @param {string} source
 */
function strip(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  /** @type {number[]} */
  const templates = [];
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (templates.length > 0 && templates[templates.length - 1] === 0 && c === "`") {
      templates.pop();
      out += "`";
      i++;
      continue;
    }
    if (templates.length > 0 && templates[templates.length - 1] === 0) {
      // Inside a template literal's text.
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "$" && next === "{") {
        templates[templates.length - 1] = 1;
        out += "${";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (c === "`") {
      templates.push(0);
      out += "`";
      i++;
      continue;
    }
    if (templates.length > 0 && c === "{") {
      templates[templates.length - 1]++;
    } else if (templates.length > 0 && c === "}") {
      templates[templates.length - 1]--;
      if (templates[templates.length - 1] === 0) {
        out += "}";
        i++;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
      }
      const keep = /(?:\bfrom|\bimport|\bimport\s*\()\s*$/.test(out);
      out += keep ? source.slice(i, j + 1) : `${c}${" ".repeat(Math.max(0, j - i - 1))}${c}`;
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** @param {string} from @param {string} spec @returns {string | null} */
function resolveSpec(from, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    return null;
  }
  const base = spec.startsWith("/") ? join(ROOT, spec) : resolve(dirname(from), spec);
  for (const candidate of [base, ...EXTENSIONS.map((e) => base + e), join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/** Names in an import or export brace list, as [imported, local]. @param {string} list */
function names(list) {
  return list
    .split(",")
    .map((s) => s.trim().replace(/^type\s+/, ""))
    .filter((s) => s !== "")
    .map((s) => {
      const parts = s.split(/\s+as\s+/);
      return /** @type {[string, string]} */ ([parts[0].trim(), parts[parts.length - 1].trim()]);
    });
}

const files = [
  ...DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...ROOT_FILES.map((f) => join(ROOT, f)),
];
/** @type {Map<string, Set<string>>} exported names per file */
const exported = new Map();
/** @type {Map<string, Set<string>>} names other files use, per file ("*" for all) */
const used = new Map();
/** @param {string} file @param {string} name */
const markUsed = (file, name) => {
  let set = used.get(file);
  if (!set) {
    set = new Set();
    used.set(file, set);
  }
  set.add(name);
};

for (const file of files) {
  const code = strip(readFileSync(file, "utf8"));
  /** @type {Set<string>} */
  const own = new Set();
  exported.set(file, own);
  const declared =
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|abstract\s+class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of code.matchAll(declared)) {
    own.add(m[1]);
  }
  for (const m of code.matchAll(
    /^export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*["']([^"']+)["'])?/gm,
  )) {
    const from = /** @type {string | undefined} */ (m[2]);
    const target = from === undefined ? null : resolveSpec(file, from);
    for (const [imported, local] of names(m[1])) {
      own.add(local);
      if (target !== null) {
        markUsed(target, imported);
      }
    }
  }
  for (const m of code.matchAll(/^export\s+\*\s+(?:as\s+\w+\s+)?from\s*["']([^"']+)["']/gm)) {
    const target = resolveSpec(file, m[1]);
    if (target !== null) {
      markUsed(target, "*");
    }
  }
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']/g)) {
    if (m[2].includes("?")) {
      continue;
    }
    const target = resolveSpec(file, m[2]);
    if (target === null) {
      continue;
    }
    const clause = m[1];
    if (/\*\s+as\s+/.test(clause)) {
      markUsed(target, "*");
    }
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const [imported] of names(braces[1])) {
        markUsed(target, imported);
      }
    }
    if (/^[A-Za-z_$][\w$]*\s*(?:,|$)/.test(clause.trim())) {
      markUsed(target, "default");
    }
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const target = resolveSpec(file, m[1]);
    if (target !== null && !m[1].includes("?")) {
      markUsed(target, "*");
    }
  }
}

/** @type {string[]} */
const unused = [];
for (const [file, own] of exported) {
  const rel = relative(ROOT, file);
  const set = used.get(file) ?? new Set();
  if (set.has("*") || ALLOW.has(`${rel}#*`)) {
    continue;
  }
  for (const name of own) {
    if (!set.has(name) && !ALLOW.has(`${rel}#${name}`)) {
      unused.push(`${rel}: ${name}`);
    }
  }
}

for (const line of unused.toSorted()) {
  process.stdout.write(`${line}\n`);
}
if (unused.length > 0) {
  process.stdout.write(
    `${String(unused.length)} unused exports: un-export or delete them, or allow them in scripts/unused-exports.mjs.\n`,
  );
  process.exit(1);
}
