import { describe, expect, it } from "vitest";
import { fallbackWidthEm } from "../neon-tubes";
import { sanitizeText } from "../params";
import {
  designFrame,
  fitSign,
  leafCentre,
  PLANT_BOTTOM,
  PLANT_LAYERS,
  PLANT_LEFT,
  PLANT_RIGHT,
  PLANT_TOP,
  plantParts,
  PLAQUE_H,
  PLAQUE_MAX_W,
  SIGN_MAX_FONT,
  signHum,
  signLine,
  signPlace,
} from "./justchatting-layout";
import { JUST_CHATTING_PARAMS, SIGN_MAX_LENGTH } from "./justchatting.meta";

const SIGN = JUST_CHATTING_PARAMS.sign;

describe("the sign's text", () => {
  it("is one line of at most 18 code points", () => {
    expect(SIGN.maxLines).toBe(1);
    expect(SIGN.maxLength).toBe(SIGN_MAX_LENGTH);
    expect(sanitizeText(SIGN, "good vibes\nonly")).toBe("good vibes");
    const long = sanitizeText(SIGN, "é".repeat(40));
    expect(Array.from(long)).toHaveLength(18);
  });

  it("drops control characters and bidi overrides", () => {
    expect(sanitizeText(SIGN, "hi‮ there\u0007")).toBe("hi there");
  });

  it("is trimmed, and hides the sign when empty", () => {
    expect(signLine("  good vibes  ")).toBe("good vibes");
    expect(signLine("")).toBe("");
    expect(signLine("   ")).toBe("");
    expect(signLine(SIGN.default)).toBe("good vibes");
  });
});

describe("fitSign", () => {
  const texts = ["hi", "good vibes", "just chatting", "W".repeat(18), "東".repeat(18)];
  const widths = [...texts.map((t) => fallbackWidthEm(t)), 18 * 1.1, 0.4, 0, Number.NaN];

  it.each(widths)("keeps a line %s ems wide inside its plaque", (em) => {
    const { plaqueW, lettering: l } = fitSign(em);
    expect(plaqueW).toBeLessThanOrEqual(PLAQUE_MAX_W);
    expect(l.font).toBeGreaterThan(0);
    expect(l.font).toBeLessThanOrEqual(SIGN_MAX_FONT);
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.x + l.w).toBeLessThanOrEqual(plaqueW + 1e-12);
    expect(l.y).toBeGreaterThanOrEqual(0);
    expect(l.y + l.h).toBeLessThanOrEqual(PLAQUE_H);
    expect(l.anchor).toBeCloseTo(plaqueW / 2, 12);
  });

  it("shrinks long text to fit rather than overflowing, and grows the plaque up to its widest", () => {
    const short = fitSign(fallbackWidthEm("hi"));
    const usual = fitSign(fallbackWidthEm("good vibes"));
    const long = fitSign(fallbackWidthEm("W".repeat(18)));
    expect(short.lettering.font).toBe(SIGN_MAX_FONT);
    expect(long.lettering.font).toBeLessThan(usual.lettering.font);
    expect(short.plaqueW).toBeLessThan(usual.plaqueW);
    expect(long.plaqueW).toBeCloseTo(PLAQUE_MAX_W, 12);
    // The long line still fills the plaque's width, padding aside.
    expect(long.lettering.w).toBeGreaterThan(0.8 * PLAQUE_MAX_W);
  });
});

describe("signPlace", () => {
  it.each([4 / 3, 16 / 9, 21 / 9])(
    "puts the widest plaque in an upper outer third, inside the frame, at aspect %s",
    (aspect) => {
      const { halfW, top } = designFrame(aspect);
      for (const side of [1, -1]) {
        const at = signPlace(aspect, side);
        const outer = Math.abs(at.x) + PLAQUE_MAX_W / 2;
        const inner = Math.abs(at.x) - PLAQUE_MAX_W / 2;
        expect(Math.sign(at.x)).toBe(side);
        expect(outer).toBeLessThan(halfW);
        expect(inner).toBeGreaterThan(halfW / 3);
        expect(at.top).toBeLessThan(top);
        expect(at.top - PLAQUE_H).toBeGreaterThan(0.25);
      }
    },
  );
});

describe("signHum", () => {
  it("warms up smoothly, then hums by under 3 %, slowly", () => {
    expect(signHum(0)).toBe(0);
    let prev = signHum(0);
    let fastest = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const dt = 1 / 30;
    for (let t = dt; t < 300; t += dt) {
      const v = signHum(t);
      fastest = Math.max(fastest, Math.abs(v - prev) / dt);
      if (t > 5) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      prev = v;
    }
    expect(lo).toBeGreaterThan(0.97);
    expect(hi).toBeLessThan(1.03);
    expect(hi - lo).toBeLessThan(0.03);
    // The warm-up is the fastest change: under half the brightness a second.
    expect(fastest).toBeLessThan(0.5);
  });
});

describe("plantParts", () => {
  it("is the same every time", () => {
    expect(plantParts()).toEqual(plantParts());
  });

  it("gives every layer stems and leaves, all inside the plant's box", () => {
    const { stems, leaves } = plantParts();
    for (let layer = 0; layer < PLANT_LAYERS; layer++) {
      expect(stems.some((s) => s.layer === layer)).toBe(true);
      expect(leaves.filter((l) => l.layer === layer).length).toBeGreaterThan(8);
    }
    const margin = 0.02;
    for (const l of leaves) {
      for (const t of [0, 0.5, 1]) {
        const x = l.x + t * l.length * Math.cos(l.angle);
        const y = l.y + t * l.length * Math.sin(l.angle);
        expect(x).toBeGreaterThan(PLANT_LEFT + margin);
        expect(x).toBeLessThan(PLANT_RIGHT - margin);
        expect(y).toBeGreaterThan(PLANT_BOTTOM + margin);
        expect(y).toBeLessThan(PLANT_TOP - margin);
      }
      const [cx, cy] = leafCentre(l);
      expect(Number.isFinite(cx) && Number.isFinite(cy)).toBe(true);
    }
  });
});
