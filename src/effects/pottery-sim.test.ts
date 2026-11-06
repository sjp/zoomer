import { describe, expect, it } from "vitest";
import {
  CLAY_VOLUME,
  clayFor,
  CLAYS,
  copyProfile,
  createLayout,
  createProfile,
  CYCLE_FORMS,
  CYLINDER,
  formFor,
  FORMS,
  holeRadius,
  MOUND,
  PROFILE_N,
  potBox,
  potteryLayout,
  profileAt,
  profileVolume,
  relaxProfile,
  sampleShape,
  shapeRadius,
  TRAY_R,
  wallFor,
  WHEEL_R,
} from "./pottery-sim";
import { CLAY_OPTIONS, CORNER_OPTIONS, FORM_OPTIONS } from "./pottery.meta";

const FORM_IDS = FORM_OPTIONS.map((o) => o.value);
const ASPECTS = [4 / 3, 16 / 9, 21 / 9];

describe("shapeRadius", () => {
  it("passes through the control points", () => {
    const pts = FORMS.vase.points;
    let worst = 0;
    for (let i = 0; i < pts.length; i++) {
      worst = Math.max(worst, Math.abs(shapeRadius(pts, i / (pts.length - 1)) - pts[i]));
    }
    expect(worst).toBeLessThan(1e-12);
  });
});

describe("wallFor", () => {
  it("gives every opened shape a positive wall thinner than its narrowest radius", () => {
    for (const shape of [CYLINDER, FORMS.vase, FORMS.bowl, FORMS.jar]) {
      const w = wallFor(shape);
      expect(w).toBeGreaterThan(0.01);
      expect(w).toBeLessThan(Math.min(...shape.points));
      // At its own height and wall, the shape holds the clay.
      const v = profileVolume(sampleShape(shape), shape.height, w, shape.open);
      expect(Math.abs(v / CLAY_VOLUME - 1)).toBeLessThan(1e-6);
    }
  });
});

describe("profileAt", () => {
  it("starts and ends each cycle as the mound", () => {
    const p = createProfile();
    for (const form of FORM_IDS) {
      for (const phase of [0, 0.05, 0.9999, 3.0, 4.02]) {
        profileAt(phase, form, p);
        expect(p.open).toBeLessThan(0.01);
        expect(Math.abs(p.height - MOUND.height)).toBeLessThan(0.01);
      }
    }
  });

  it("reaches the chosen form while holding", () => {
    const p = createProfile();
    for (const form of ["vase", "bowl", "jar"] as const) {
      profileAt(0.7, form, p);
      expect(p.height).toBeCloseTo(FORMS[form].height, 6);
      expect(p.radius[PROFILE_N - 1]).toBeCloseTo(FORMS[form].points[5], 6);
      expect(p.open).toBe(1);
    }
  });

  it("is continuous in time and positive at every height, over several cycles", () => {
    let a = createProfile();
    let b = createProfile();
    const dt = 2e-3;
    for (const form of FORM_IDS) {
      let worstJump = 0;
      let worstHeightJump = 0;
      let minRadius = Infinity;
      profileAt(0, form, a);
      for (let phase = dt; phase < 4; phase += dt) {
        profileAt(phase, form, b);
        for (let i = 0; i < PROFILE_N; i++) {
          worstJump = Math.max(worstJump, Math.abs(a.radius[i] - b.radius[i]));
          minRadius = Math.min(minRadius, b.radius[i]);
        }
        worstHeightJump = Math.max(worstHeightJump, Math.abs(a.height - b.height));
        [a, b] = [b, a];
      }
      expect(minRadius).toBeGreaterThan(0.03);
      // A step of 1/500 of a cycle (0.12 s at the default) moves nothing by more than a hair.
      expect(worstJump).toBeLessThan(2e-3);
      expect(worstHeightJump).toBeLessThan(0.01);
    }
  });

  it("keeps the clay's volume within a few per cent across the cycle", () => {
    const p = createProfile();
    for (const form of FORM_IDS) {
      let worst = 0;
      for (let phase = 0; phase < 3; phase += 0.002) {
        profileAt(phase, form, p);
        const v = profileVolume(p.radius, p.height, p.wall, p.open);
        worst = Math.max(worst, Math.abs(v / CLAY_VOLUME - 1));
      }
      expect(worst).toBeLessThan(0.03);
    }
  });

  it("keeps the pot on the wheel and a sensible size", () => {
    const p = createProfile();
    let ok = true;
    for (const form of FORM_IDS) {
      for (let phase = 0; phase < 3; phase += 0.01) {
        profileAt(phase, form, p);
        if (p.height < 0.09 || p.height > 0.4) {
          ok = false;
        }
        if (p.radius[0] > WHEEL_R) {
          ok = false;
        }
        if (holeRadius(p) < 0 || holeRadius(p) >= p.radius[PROFILE_N - 1]) {
          ok = false;
        }
      }
    }
    expect(ok).toBe(true);
  });
});

describe("formFor", () => {
  it("throws the chosen form, or each form in turn under Cycle", () => {
    expect(formFor("bowl", 7)).toBe("bowl");
    const seen = [0, 1, 2, 3, -1].map((i) => formFor("cycle", i));
    expect(seen).toEqual([...CYCLE_FORMS, CYCLE_FORMS[0], CYCLE_FORMS[2]]);
  });
});

describe("relaxProfile", () => {
  it("eases towards the target and lands on it", () => {
    const shown = profileAt(0.7, "vase", createProfile());
    const target = profileAt(0.7, "bowl", createProfile());
    const before = Math.abs(shown.height - target.height);
    relaxProfile(shown, target, 0.25);
    expect(Math.abs(shown.height - target.height)).toBeCloseTo(before * 0.75, 9);
    relaxProfile(shown, target, 1);
    expect(shown.height).toBe(target.height);
    expect(Array.from(shown.radius)).toEqual(Array.from(target.radius));
    const copy = copyProfile(target, createProfile());
    expect(copy.open).toBe(target.open);
  });
});

describe("potteryLayout", () => {
  it("keeps the wheel in its bottom corner, inside the outer third", () => {
    for (const aspect of ASPECTS) {
      for (const { value } of CORNER_OPTIONS) {
        const l = potteryLayout(aspect, value, createLayout());
        expect(l.side).toBe(value === "left" ? -1 : 1);
        const [x0, y0, x1, y1] = l.wheelBox;
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(aspect);
        expect(y0).toBe(0);
        expect(y1).toBeLessThan(0.35);
        const inner = value === "left" ? l.cx + TRAY_R * l.scale : aspect - l.cx + TRAY_R * l.scale;
        expect(inner).toBeLessThanOrEqual(aspect / 3);
      }
    }
  });

  it("boxes the pot tightly above the wheel", () => {
    const l = potteryLayout(16 / 9, "right", createLayout());
    const box: [number, number, number, number] = [0, 0, 0, 0];
    const p = profileAt(0.7, "vase", createProfile());
    potBox(l, p, box);
    expect(box[0]).toBeLessThan(l.cx - 0.098);
    expect(box[2]).toBeGreaterThan(l.cx + 0.098);
    expect(box[2] - box[0]).toBeLessThan(0.23);
    expect(box[3]).toBeGreaterThan(l.baseY + p.height * 0.95);
    expect(box[3]).toBeLessThan(0.7);
    expect(box[1]).toBeLessThan(l.baseY);
  });
});

describe("clays", () => {
  it("has a palette for every option", () => {
    for (const { value } of CLAY_OPTIONS) {
      expect(clayFor(value)).toBe(CLAYS[value]);
    }
    expect(clayFor("glaze")).toBe(CLAYS.terracotta);
    expect(formFor("teapot", 4)).toBe(CYCLE_FORMS[1]);
  });
});
