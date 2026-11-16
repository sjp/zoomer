import { describe, expect, it } from "vitest";
import { fallbackWidthEm } from "../neon-tubes";
import { MAX_FONT, signLayout, signLines } from "./neon-sim";
import { NEON_MAX_LENGTH, NEON_MAX_LINES, NEON_POSITION_OPTIONS, neonMeta } from "./neon.meta";
import { sanitizeText } from "../params";

describe("text", () => {
  it("is limited to 2 lines of 24 code points", () => {
    expect(neonMeta.params.text.maxLength).toBe(24);
    expect(neonMeta.params.text.maxLines).toBe(2);
    const long = "é".repeat(40);
    const out = sanitizeText(neonMeta.params.text, `${long}\n${long}\n${long}`);
    const lines = out.split("\n");
    expect(lines.length).toBe(NEON_MAX_LINES);
    expect(lines.map((l) => Array.from(l).length)).toEqual([NEON_MAX_LENGTH, NEON_MAX_LENGTH]);
  });

  it("drops empty lines but keeps each line's colour index", () => {
    expect(signLines("")).toEqual([]);
    expect(signLines("On Air")).toEqual([{ text: "On Air", index: 0 }]);
    expect(signLines("\n  Live ")).toEqual([{ text: "Live", index: 1 }]);
    expect(signLines("A\nB").map((l) => l.index)).toEqual([0, 1]);
  });
});

describe("signLayout", () => {
  const aspects = [4 / 3, 16 / 9, 21 / 9];
  const full = "W".repeat(NEON_MAX_LENGTH);

  it("fits the lettering inside its region at 4:3, 16:9 and 21:9", () => {
    const problems: string[] = [];
    const eps = 1e-9;
    for (const aspect of aspects) {
      for (const { value: position } of NEON_POSITION_OPTIONS) {
        for (const lines of [["On Air"], [full], [full, full], ["Hi", full], ["東".repeat(24)]]) {
          const l = signLayout(
            aspect,
            position,
            lines.map((v) => fallbackWidthEm(v)),
          );
          const [rx, ry, rw, rh] = l.region;
          const tag = `${aspect.toFixed(2)} ${position} ${lines.join("/")}`;
          if (l.x < rx - eps || l.x + l.w > rx + rw + eps) {
            problems.push(`${tag}: x outside region`);
          }
          if (l.y < ry - eps || l.y + l.h > ry + rh + eps) {
            problems.push(`${tag}: y outside region`);
          }
          if (rx < 0 || rx + rw > aspect || ry < 0 || ry + rh > 0.5) {
            problems.push(`${tag}: region outside the upper half of the frame`);
          }
          if (!(l.font > 0.02 && l.font <= MAX_FONT)) {
            problems.push(`${tag}: font ${String(l.font)}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("places the sign left, centred or right", () => {
    const widths = [fallbackWidthEm("On Air")];
    const left = signLayout(16 / 9, "left", widths);
    const centre = signLayout(16 / 9, "centre", widths);
    const right = signLayout(16 / 9, "right", widths);
    expect(left.x + left.w).toBeLessThan(centre.x + centre.w);
    expect(centre.x + centre.w / 2).toBeCloseTo(8 / 9, 9);
    expect(right.x).toBeGreaterThan(centre.x);
    expect([left.align, centre.align, right.align]).toEqual(["left", "center", "right"]);
  });
});
