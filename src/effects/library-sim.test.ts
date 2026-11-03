import { describe, expect, it } from "vitest";
import {
  beamGeometry,
  beamHalfWidth,
  beamMaskLocal,
  CLOUD_DEPTH,
  CLOUD_SLOT,
  cloudLight,
  createBeamGeometry,
  createMotes,
  lampPosition,
  moteGlint,
  REF_HEIGHT,
  ROOM_PALETTES,
  stepMotes,
} from "./library-sim";
import { PALETTE_OPTIONS } from "./library.meta";

describe("ROOM_PALETTES", () => {
  it("has a palette for every option", () => {
    for (const { value } of PALETTE_OPTIONS)
      expect(ROOM_PALETTES[value].spines.length).toBeGreaterThan(3);
  });
});

describe("beam", () => {
  it("starts off-frame above a top corner and reaches into the frame", () => {
    for (const side of ["left", "right"] as const) {
      const g = beamGeometry(createBeamGeometry(), side, 1920);
      expect(g.oy).toBeGreaterThan(REF_HEIGHT);
      expect(side === "left" ? g.ox < 0 : g.ox > 1920).toBe(true);
      const ex = g.ox + g.length * g.dx;
      const ey = g.oy + g.length * g.dy;
      expect(ex).toBeGreaterThan(0);
      expect(ex).toBeLessThan(1920);
      expect(ey).toBeGreaterThan(REF_HEIGHT * 0.3);
      expect(Math.hypot(g.dx, g.dy)).toBeCloseTo(1);
      expect(g.dx * g.nx + g.dy * g.ny).toBeCloseTo(0);
    }
  });

  it("has a mask in [0, 1] that is 0 at the box's edges and full in the core", () => {
    const g = beamGeometry(createBeamGeometry(), "left", 1920);
    let bad = 0;
    for (let i = 0; i <= 200; i++) {
      const s = (i / 200) * g.length;
      for (let j = -20; j <= 20; j++) {
        const m = beamMaskLocal(g, s, (j / 20) * g.halfBox);
        if (!(m >= 0 && m <= 1)) bad++;
      }
      if (beamMaskLocal(g, s, beamHalfWidth(s)) !== 0) bad++;
      if (beamMaskLocal(g, s, -g.halfBox) !== 0) bad++;
    }
    expect(bad).toBe(0);
    expect(beamMaskLocal(g, 0, 0)).toBe(0);
    expect(beamMaskLocal(g, g.length, 0)).toBe(0);
    expect(beamMaskLocal(g, g.length * 0.45, 0)).toBe(1);
  });
});

describe("lampPosition", () => {
  it("stands opposite the window, out of the centre third", () => {
    const at = (beam: "left" | "right" | "off") => lampPosition({ x: 0, y: 0 }, beam, 1920);
    expect(at("left").x).toBeGreaterThan(1920 * (2 / 3));
    expect(at("off").x).toBeGreaterThan(1920 * (2 / 3));
    expect(at("right").x).toBeLessThan(1920 / 3);
  });
});

describe("cloudLight", () => {
  it("is continuous, bounded, dips 40–70% once per slot and returns to 1", () => {
    const step = 0.05;
    let prev = cloudLight(9, 0);
    let maxJump = 0;
    let bad = 0;
    let slotMin = 1;
    let slotEnd = 0;
    const minima: number[] = [];
    for (let t = step; t <= CLOUD_SLOT * 10; t += step) {
      const v = cloudLight(9, t);
      if (!(v >= 1 - CLOUD_DEPTH[1] - 1e-9 && v <= 1)) bad++;
      maxJump = Math.max(maxJump, Math.abs(v - prev));
      prev = v;
      slotMin = Math.min(slotMin, v);
      // Each slot ends in clear sky.
      const local = t % CLOUD_SLOT;
      if (local > CLOUD_SLOT - 2 * step) slotEnd = Math.max(slotEnd, 1 - v);
      if (local + step >= CLOUD_SLOT) {
        minima.push(slotMin);
        slotMin = 1;
      }
    }
    expect(bad).toBe(0);
    // Fades last at least 3 s, so a 50 ms step moves the light by well under 3%.
    expect(maxJump).toBeLessThan(0.03);
    expect(slotEnd).toBe(0);
    expect(minima.length).toBeGreaterThanOrEqual(9);
    for (const m of minima) {
      expect(m).toBeGreaterThanOrEqual(1 - CLOUD_DEPTH[1] - 1e-6);
      expect(m).toBeLessThanOrEqual(1 - CLOUD_DEPTH[0] + 1e-6);
    }
  });

  it("is deterministic per seed and differs between seeds", () => {
    let same = 0;
    let differ = 0;
    for (let t = 0; t < 600; t += 1) {
      if (cloudLight(3, t) === cloudLight(3, t)) same++;
      if (cloudLight(3, t) !== cloudLight(4, t)) differ++;
    }
    expect(same).toBe(600);
    expect(differ).toBeGreaterThan(0);
  });
});

describe("motes", () => {
  it("are deterministic per seed", () => {
    expect(createMotes(5, 50)).toEqual(createMotes(5, 50));
  });

  it("stay inside the beam's box as they drift, and actually move", () => {
    const g = beamGeometry(createBeamGeometry(), "right", 1920);
    const m = createMotes(2, 300);
    const s0 = Float64Array.from(m.s);
    let outside = 0;
    let time = 0;
    for (let f = 0; f < 600; f++) {
      stepMotes(m, g, 300, time, 1 / 30);
      time += 1 / 30;
      for (let i = 0; i < 300; i++) {
        if (!(m.s[i] >= 0 && m.s[i] < 1 && m.t[i] >= -1 && m.t[i] < 1)) outside++;
      }
    }
    expect(outside).toBe(0);
    let moved = 0;
    for (let i = 0; i < 300; i++) moved += Math.abs(m.s[i] - s0[i]) * g.length;
    // 20 s at a few px/s: the average mote has moved tens of px but not across the frame.
    expect(moved / 300).toBeGreaterThan(10);
    expect(moved / 300).toBeLessThan(400);
  });

  it("glint brighter only where the beam is strong", () => {
    let maxDark = 0;
    let maxLit = 0;
    for (let p = 0; p < 2 * Math.PI; p += 0.01) {
      maxDark = Math.max(maxDark, moteGlint(p, 0));
      maxLit = Math.max(maxLit, moteGlint(p, 1));
    }
    expect(maxDark).toBeCloseTo(0.55);
    expect(maxLit).toBeGreaterThan(1.3);
  });
});
