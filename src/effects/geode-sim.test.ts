import { describe, expect, it } from "vitest";
import {
  advancePhase,
  CELL,
  createCrystal,
  crystalAt,
  crystalLean,
  crystalOffset,
  depth,
  ELONG,
  GLINT_EXP,
  JITTER,
  layout,
  type Layout,
  LEAN,
  LEAN_JITTER,
  LIGHT_PERIOD,
  lightPosition,
  mineral,
  MINERALS,
  outline,
  OUTLINE_MAX,
  RIM_W,
  ROUGH,
  SEARCH_OK,
  SHADOW_REACH,
  SLOPE,
  specular,
} from "./geode-sim";
import { MINERAL_OPTIONS, SIDE_OPTIONS } from "./geode.meta";
import { createRng, hash32 } from "./noise";

const newLayout = (): Layout => ({ cx: 0, cy: 0, r: 0, angle: 0, half: 0 });

/** Random local points in the hollow (well inside the agate rim) of outline `o`. */
function hollowPoints(o: ReturnType<typeof outline>, n: number, seed: number): number[][] {
  const rng = createRng(seed);
  const pts: number[][] = [];
  while (pts.length < n) {
    const x = (rng() * 2 - 1) * ELONG;
    const y = rng() * 2 - 1;
    if (depth(x, y, o) > RIM_W + ROUGH) pts.push([x, y]);
  }
  return pts;
}

describe("options", () => {
  it("cover every mineral, and unknown names fall back", () => {
    expect(MINERAL_OPTIONS.map((o) => o.value).sort()).toEqual(Object.keys(MINERALS).sort());
    expect(mineral("nope")).toBe(MINERALS.amethyst);
    expect(mineral("citrine")).toBe(MINERALS.citrine);
    const a = layout("nope", 0.85, 16 / 9, 0, newLayout());
    const b = layout("left", 0.85, 16 / 9, 0, newLayout());
    expect(a).toEqual(b);
    for (const s of SIDE_OPTIONS) expect(layout(s.value, 0.85, 1.5, 0, newLayout()).r).toBe(0.425);
  });
});

describe("outline and layout", () => {
  it("is deterministic per seed, and differs between seeds", () => {
    expect(outline(7)).toEqual(outline(7));
    expect(outline(7).phase).not.toEqual(outline(8).phase);
  });

  it("stays inside the quad, with the hollow inside the rim", () => {
    let bad = 0;
    for (let seed = 0; seed < 20; seed++) {
      const o = outline(seed);
      const l = layout("left", 1, 16 / 9, o.tilt, newLayout());
      if (!(depth(0, 0, o) > RIM_W)) bad++;
      for (let i = 0; i < 360; i++) {
        const a = (i / 360) * 2 * Math.PI;
        // Walk out along the ray to where the depth (with roughness) is surely negative.
        const x = Math.cos(a) * ELONG * (1 + OUTLINE_MAX + ROUGH / 2);
        const y = Math.sin(a) * (1 + OUTLINE_MAX + ROUGH / 2);
        if (depth(x, y, o) - ROUGH / 2 >= 0) bad++;
        // That point, in frame heights, lies within the quad (a square of half side
        // l.half around the centre) with room for the shadow beyond it.
        if (Math.hypot(x, y) * l.r > l.half - SHADOW_REACH * l.r + 1e-12) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("hugs the chosen side", () => {
    const aspect = 16 / 9;
    const l = layout("left", 0.85, aspect, 0, newLayout());
    const r = layout("right", 0.85, aspect, 0, newLayout());
    const c = layout("corner", 0.85, aspect, 0, newLayout());
    expect(l.cx).toBeLessThan(aspect / 3);
    expect(r.cx).toBeGreaterThan((2 * aspect) / 3);
    expect(r.cx).toBeCloseTo(aspect - l.cx, 12);
    expect(c.cx).toBeGreaterThan((2 * aspect) / 3);
    expect(c.cy).toBeLessThan(0.35);
  });
});

describe("crystals", () => {
  it("keep their seeds inside the exact 3x3 search", () => {
    expect(SEARCH_OK).toBe(true);
    const o = [0, 0];
    let worst = 0;
    for (let i = 0; i < 5000; i++) {
      crystalOffset(hash32(i), o);
      worst = Math.max(worst, Math.hypot(o[0], o[1]));
    }
    expect(worst).toBeLessThanOrEqual(JITTER + 1e-12);
  });

  it("assign every point in the hollow to exactly one crystal", () => {
    const o = outline(3);
    const a = createCrystal();
    const b = createCrystal();
    let bad = 0;
    for (const [x, y] of hollowPoints(o, 3000, 115)) {
      crystalAt(x, y, o, a, 1);
      crystalAt(x, y, o, b, 3);
      // The 3x3 lookup finds the nearest seed of a wide search.
      if (a.hash !== b.hash || a.seedX !== b.seedX || a.seedY !== b.seedY) bad++;
      // The point is inside its crystal: nearer its seed than any other, and off the edge.
      if (!(a.edge >= 0)) bad++;
      if (Math.hypot(x - a.seedX, y - a.seedY) > CELL * 1.5) bad++;
    }
    expect(bad).toBe(0);
  });

  it("number in the hundreds", () => {
    const o = outline(3);
    const c = createCrystal();
    const seen = new Set<number>();
    for (let y = -1; y <= 1; y += CELL / 4) {
      for (let x = -ELONG; x <= ELONG; x += CELL / 4) {
        if (depth(x, y, o) > RIM_W) seen.add(crystalAt(x, y, o, c).hash);
      }
    }
    expect(seen.size).toBeGreaterThan(150);
    expect(seen.size).toBeLessThan(600);
  });

  it("lean less than their faces slope, so every face faces outward", () => {
    expect(LEAN + LEAN_JITTER).toBeLessThan(SLOPE[0]);
    const lean = [0, 0];
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const h = hash32(i * 7 + 1);
      crystalLean(h, Math.cos(i) * (i % 13) * 0.1, Math.sin(i) * (i % 11) * 0.1, lean);
      worst = Math.max(worst, Math.hypot(lean[0], lean[1]));
    }
    expect(worst).toBeLessThanOrEqual(LEAN + LEAN_JITTER + 1e-12);

    const o = outline(5);
    const c = createCrystal();
    const d = createCrystal();
    let bad = 0;
    for (const [x, y] of hollowPoints(o, 3000, 116)) {
      crystalAt(x, y, o, c);
      const n = c.normal;
      if (Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) > 1e-12) bad++;
      // The face drops from the crystal's ridge to its base edge: its normal faces
      // the viewer and leans across that edge, out of the crystal.
      if (!(n[2] > 0) || !(n[0] * c.edgeX + n[1] * c.edgeY > 0)) bad++;
      // The edge direction is right: a small step along it nears the edge.
      const step = Math.min(c.edge, 0.01) * CELL;
      crystalAt(x + c.edgeX * step, y + c.edgeY * step, o, d);
      if (d.hash === c.hash && !(d.edge < c.edge)) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe("light and glints", () => {
  it("advances the light's phase, wrapped, and clamps bad speeds", () => {
    expect(advancePhase(0.9, LIGHT_PERIOD * 0.2, 1 / LIGHT_PERIOD)).toBeCloseTo(0.1, 12);
    expect(advancePhase(0.4, 1, -1)).toBe(0.4);
    expect(advancePhase(0.4, 1, Number.NaN)).toBe(0.4);
    const l = lightPosition(0.25, 0, [0, 0, 0]);
    expect(l[0]).toBeCloseTo(0, 12);
    expect(l[1]).toBeGreaterThan(0);
    expect(l[2]).toBeGreaterThan(0);
  });

  it("glint is continuous in the light angle and fades over many frames", () => {
    const o = outline(3);
    const c = createCrystal();
    const light = [0, 0, 0];
    // Light phase per frame at the top speed (3) and 60 fps: a full circuit in 960 frames.
    const frames = Math.round(LIGHT_PERIOD * 20);
    let worstStep = 0;
    let peak = 0;
    let glinting = 0;
    for (const [x, y] of hollowPoints(o, 300, 117)) {
      crystalAt(x, y, o, c);
      let first = 0;
      let last = 0;
      let max = 0;
      for (let i = 0; i <= frames; i++) {
        lightPosition(i / frames, 0.25, light);
        const g = specular(c.normal, x, y, light, GLINT_EXP);
        if (i === 0) first = g;
        else worstStep = Math.max(worstStep, Math.abs(g - last));
        last = g;
        max = Math.max(max, g);
      }
      // Back where it started after a full circuit.
      if (Math.abs(last - first) > 1e-9) worstStep = Infinity;
      peak = Math.max(peak, max);
      if (max > 0.5) glinting++;
    }
    // Some faces glint fully at some point of the circuit, but only some.
    expect(peak).toBeGreaterThan(0.9);
    expect(glinting).toBeGreaterThan(10);
    expect(glinting).toBeLessThan(250);
    // Even at top speed a glint rises or falls by under 8% a frame: over a dozen
    // frames from dark to full, a fade rather than a sparkle.
    expect(worstStep).toBeLessThan(0.08);
  });
});
