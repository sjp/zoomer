/**
 * Compares two directories of effect captures (`e2e/capture.spec.ts`) and lists
 * every effect whose pixels differ, with the largest channel difference and how
 * many pixels differ by more than `--tolerance` levels (default 0).
 *
 *   node scripts/compare-captures.mjs /tmp/before /tmp/after [--tolerance 2]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: compare-captures.mjs <before-dir> <after-dir> [--tolerance n]");
  process.exit(2);
}
const [before, after, ...rest] = args;
const t = rest.indexOf("--tolerance");
const tolerance = t >= 0 ? Number(rest[t + 1]) : 0;
/** @param {string} line */
const print = (line) => process.stdout.write(`${line}\n`);

let differ = 0;
const files = readdirSync(before).filter((f) => f.endsWith(".rgba"));
for (const file of files.toSorted()) {
  let b;
  try {
    b = readFileSync(join(after, file));
  } catch {
    print(`${file}: missing after`);
    differ++;
    continue;
  }
  const a = readFileSync(join(before, file));
  if (a.length !== b.length) {
    print(`${file}: size ${String(a.length)} -> ${String(b.length)}`);
    differ++;
    continue;
  }
  let worst = 0;
  let pixels = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) {
      d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
    }
    worst = Math.max(worst, d);
    if (d > tolerance) {
      pixels++;
    }
  }
  if (pixels > 0) {
    print(`${file.replace(/\.rgba$/, "")}: ${String(pixels)} px differ, max ${String(worst)}`);
    differ++;
  }
}
print(differ === 0 ? "All captures match." : `${String(differ)} effects differ.`);
process.exit(differ === 0 ? 0 : 1);
