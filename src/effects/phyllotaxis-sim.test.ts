import { describe, expect, it } from "vitest";
import {
  createHead,
  divergence,
  GOLDEN_ANGLE,
  headLayout,
  type HeadLayout,
  MAX_PETAL_SPRITES,
  PETAL_STRIDE,
  PETALS,
  SEED_STRIDE,
  seedAt,
  seedCount,
  type SeedPoint,
  spiralHue,
  stepHead,
  styleFor,
  STYLES,
  vogelPoint,
  writePetals,
  writeSeeds,
} from "./phyllotaxis-sim";
import { MAX_SEEDS, POSITION_OPTIONS, STYLE_OPTIONS } from "./phyllotaxis.meta";

/** Nearest-neighbour distance for each of seeds `from .. to - 1` among seeds 1 .. n. */
function nearestDistances(phi: number, n: number, from: number, to: number): number[] {
  const xs = new Float64Array(n + 1);
  const ys = new Float64Array(n + 1);
  const p: [number, number] = [0, 0];
  for (let i = 1; i <= n; i++) {
    vogelPoint(i, phi, 1, p);
    xs[i] = p[0];
    ys[i] = p[1];
  }
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    let best = Infinity;
    for (let k = 1; k <= n; k++) {
      if (k === i) continue;
      const d = (xs[k] - xs[i]) ** 2 + (ys[k] - ys[i]) ** 2;
      if (d < best) best = d;
    }
    out.push(Math.sqrt(best));
  }
  return out;
}

const spread = (ds: number[]) => Math.max(...ds) / Math.min(...ds);

describe("vogel model", () => {
  it("has the golden angle at zero offset", () => {
    expect(divergence(0)).toBeCloseTo(GOLDEN_ANGLE, 12);
    expect((GOLDEN_ANGLE * 180) / Math.PI).toBeCloseTo(137.5078, 3);
  });

  it("keeps nearest-neighbour distances nearly uniform at the golden angle", () => {
    // Skip the innermost seeds, which have too few neighbours yet.
    const ds = nearestDistances(GOLDEN_ANGLE, 800, 30, 700);
    expect(spread(ds)).toBeLessThan(1.1);
    // Packing area per seed is π c², so spacing stays near c √π.
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    expect(mean).toBeGreaterThan(1.2);
    expect(mean).toBeLessThan(2.2);
  });

  it("packs far less evenly away from the golden angle", () => {
    for (const offset of [1, -2]) {
      expect(spread(nearestDistances(divergence(offset), 800, 30, 700))).toBeGreaterThan(2);
    }
  });
});

describe("growth", () => {
  it("moves every seed continuously as the growth index advances", () => {
    const h = createHead(500);
    const phi = GOLDEN_ANGLE;
    const p: SeedPoint = { birth: 0, age: 0, angle: 0, rho: 0, alpha: 0 };
    // Positions keyed by birth number, in units of the disc radius.
    const prev = new Map<number, [number, number]>();
    let worst = 0;
    let tracked = 0;
    // Small steps across several integer crossings of s.
    for (let step = 0; step < 300; step++) {
      stepHead(h, 1 / 60, 0.9, 0.5, phi, 500);
      const n = seedCount(h);
      for (let j = 0; j < n; j++) {
        seedAt(h, j, phi, p);
        const x = p.rho * Math.cos(p.angle);
        const y = p.rho * Math.sin(p.angle);
        const last = prev.get(p.birth);
        if (last) {
          worst = Math.max(worst, Math.hypot(x - last[0], y - last[1]));
          tracked++;
          last[0] = x;
          last[1] = y;
        } else {
          prev.set(p.birth, [x, y]);
        }
      }
    }
    expect(tracked).toBeGreaterThan(100000);
    // 0.9 seeds/s and 0.06 rad/s over 1/60 s: well under 1% of the radius.
    expect(worst).toBeLessThan(0.01);
  });

  it("keeps a seed's angle fixed while it drifts outward", () => {
    const h = createHead(400);
    const phi = GOLDEN_ANGLE;
    const p: SeedPoint = { birth: 0, age: 0, angle: 0, rho: 0, alpha: 0 };
    stepHead(h, 1, 0.3, 0, phi, 400);
    seedAt(h, 100, phi, p);
    const { birth, angle, rho } = p;
    for (let i = 0; i < 50; i++) stepHead(h, 0.1, 0.5, 0, phi, 400);
    seedAt(h, Math.floor(h.s) - birth, phi, p);
    expect(p.birth).toBe(birth);
    const da = Math.atan2(Math.sin(p.angle - angle), Math.cos(p.angle - angle));
    expect(Math.abs(da)).toBeLessThan(1e-9);
    expect(p.rho).toBeGreaterThan(rho);
  });

  it("fades seeds in at the centre and out at the rim", () => {
    const h = createHead(1000);
    stepHead(h, 1, 0.5, 0, GOLDEN_ANGLE, 1000);
    const p: SeedPoint = { birth: 0, age: 0, angle: 0, rho: 0, alpha: 0 };
    expect(seedAt(h, 0, GOLDEN_ANGLE, p).alpha).toBeLessThan(0.1);
    expect(seedAt(h, 500, GOLDEN_ANGLE, p).alpha).toBe(1);
    expect(seedAt(h, seedCount(h) - 1, GOLDEN_ANGLE, p).alpha).toBeLessThan(0.01);
  });

  it("eases the count towards a new seed number", () => {
    const h = createHead(1000);
    stepHead(h, 1 / 60, 0.5, 0, GOLDEN_ANGLE, 2000);
    expect(h.count).toBeGreaterThan(1000);
    expect(h.count).toBeLessThan(1100);
    for (let i = 0; i < 600; i++) stepHead(h, 1 / 60, 0.5, 0, GOLDEN_ANGLE, 2000);
    expect(h.count).toBe(2000);
  });

  it("never shows more than the maximum", () => {
    const h = createHead(MAX_SEEDS);
    stepHead(h, 0.5, 0.7, 0, GOLDEN_ANGLE, MAX_SEEDS);
    expect(seedCount(h)).toBeLessThanOrEqual(MAX_SEEDS);
    expect(seedCount(h)).toBeGreaterThan(MAX_SEEDS - 2);
  });
});

describe("spiralHue", () => {
  it("is constant along a 34-spiral and steps by 1/34 to the next one", () => {
    let bad = 0;
    for (let n = -200; n < 200; n++) {
      if (spiralHue(n + 34) !== spiralHue(n)) bad++;
      const step = (spiralHue(n + 21) - spiralHue(n) + 1) % 1;
      if (Math.abs(step - 1 / 34) > 1e-12) bad++;
      if (!(spiralHue(n) >= 0 && spiralHue(n) < 1)) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe("layout and writers", () => {
  const ASPECTS = [4 / 3, 16 / 9, 21 / 9];

  it("puts the head partly out of frame, away from the centre", () => {
    const l: HeadLayout = { cx: 0, cy: 0, radius: 0 };
    for (const aspect of ASPECTS) {
      const w = 1080 * aspect;
      for (const { value } of POSITION_OPTIONS) {
        headLayout(value, w, l);
        // Petals reach about 1.6 radii: some of that is off the frame.
        const reach = l.radius * 1.6;
        const outside =
          l.cx - reach < 0 || l.cx + reach > w || l.cy - reach < 0 || l.cy + reach > 1080;
        expect(outside).toBe(true);
        expect(Math.abs(l.cx - w / 2)).toBeGreaterThan(w * 0.3);
      }
    }
  });

  it("falls back for unknown select values", () => {
    expect(styleFor("pinecone")).toBe(STYLES.pinecone);
    expect(styleFor("toString")).toBe(STYLES.sunflower);
    const a = headLayout("nowhere", 1920, { cx: 0, cy: 0, radius: 0 });
    const b = headLayout("bottomRight", 1920, { cx: 0, cy: 0, radius: 0 });
    expect(a).toEqual(b);
  });

  it("writes finite instances for every style", () => {
    const seeds = new Float32Array(MAX_SEEDS * SEED_STRIDE);
    const petals = new Float32Array(MAX_PETAL_SPRITES * PETAL_STRIDE);
    const l = headLayout("bottomRight", 1920, { cx: 0, cy: 0, radius: 0 });
    for (const { value } of STYLE_OPTIONS) {
      const style = STYLES[value];
      const h = createHead(1200);
      stepHead(h, 2, 0.6, 0.2, GOLDEN_ANGLE, 1200);
      const n = writeSeeds(h, GOLDEN_ANGLE, style, l, 2, seeds, SEED_STRIDE);
      const k = writePetals(h, style, l, 2, petals, PETAL_STRIDE);
      expect(n).toBe(seedCount(h));
      expect(k).toBe((style.petals ? PETALS * 2 : 0) + (style.backing ? 1 : 0));
      let bad = 0;
      for (let i = 0; i < n * SEED_STRIDE; i++) if (!Number.isFinite(seeds[i])) bad++;
      for (let i = 0; i < k * PETAL_STRIDE; i++) if (!Number.isFinite(petals[i])) bad++;
      expect(bad).toBe(0);
      // Outermost first: the first instance is near the rim, the last at the centre.
      const r0 = Math.hypot(seeds[0] - l.cx * 2, seeds[1] - l.cy * 2);
      const r1 = Math.hypot(
        seeds[(n - 1) * SEED_STRIDE] - l.cx * 2,
        seeds[(n - 1) * SEED_STRIDE + 1] - l.cy * 2,
      );
      expect(r0).toBeGreaterThan(r1);
    }
  });
});
