import { describe, expect, it } from "vitest";
import {
  CORNER_WINDOWS,
  createLogoSim,
  LOGO_PALETTES,
  logoHeight,
  paletteIndex,
  PLAN_RATE_CAPS,
  REFERENCE_SPEED,
} from "./bouncinglogo-sim";
import { bouncingLogoMeta, MAX_LOGO_SPEED } from "./bouncinglogo.meta";
import { logoLayout } from "./logo-art";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import { createRng } from "../noise";

const ASPECTS = { "16:9": 16 / 9, "4:3": 4 / 3, "21:9": 21 / 9, portrait: 9 / 16 };
const DVD = logoLayout("DVD", () => undefined);

/** Free space (reference px) for the default "DVD" logo `size` screens tall on a canvas of `aspect`. */
function free(aspect: number, size: number): [number, number] {
  const h = logoHeight(size, aspect, DVD.width / DVD.height);
  return [1080 * aspect - (h * DVD.width) / DVD.height, 1080 - h];
}

/**
 * Runs `sim` at 30 fps for `seconds` and returns the longest stretch without a
 * corner hit (the run's start and end included), and the largest rate change seen.
 */
function longestWait(sim: ReturnType<typeof createLogoSim>, speed: number, seconds: number) {
  const dt = 1 / 30;
  let last = 0;
  let worst = 0;
  let rate = 0;
  for (let t = dt; t <= seconds; t += dt) {
    sim.step(dt, speed);
    rate = Math.max(rate, Math.abs(sim.rateX - 1), Math.abs(sim.rateY - 1));
    if (sim.lastCorners > 0) {
      worst = Math.max(worst, t - last);
      last = t;
    }
  }
  return { wait: Math.max(worst, seconds - last), rate };
}

describe("motion", () => {
  it("keeps the box inside the free space at every step, for any dt", () => {
    const rng = createRng(3);
    const bad: string[] = [];
    for (const [name, aspect] of Object.entries(ASPECTS)) {
      for (const mode of ["natural", "sometimes", "often"] as const) {
        const [fw, fh] = free(aspect, 0.18);
        const sim = createLogoSim(7, fw, fh, mode);
        for (let i = 0; i < 3000; i++) {
          // Mostly frames, with now and then a long hidden-tab gap of up to an hour.
          const r = rng();
          const dt = r < 0.98 ? rng() * 0.1 : rng() * 3600;
          sim.step(dt, 20 + 160 * rng());
          const inside =
            sim.x >= -1e-9 && sim.x <= fw + 1e-9 && sim.y >= -1e-9 && sim.y <= fh + 1e-9;
          if (!inside && bad.length < 5) {
            bad.push(`${name} ${mode} step ${String(i)}: ${String(sim.x)}, ${String(sim.y)}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("moves at 45 degrees with perfect reflections when not planning", () => {
    const [fw, fh] = free(16 / 9, 0.18);
    const sim = createLogoSim(1, fw, fh, "natural");
    // Unfolded travel on each axis, from the change in position and direction.
    let travelX = 0;
    let travelY = 0;
    let bounces = 0;
    for (let i = 0; i < 6000; i++) {
      const x0 = sim.x;
      const y0 = sim.y;
      const dx0 = sim.dirX;
      const dy0 = sim.dirY;
      bounces += sim.step(1 / 60, REFERENCE_SPEED);
      travelX +=
        dx0 === sim.dirX ? Math.abs(sim.x - x0) : dx0 > 0 ? 2 * fw - x0 - sim.x : x0 + sim.x;
      travelY +=
        dy0 === sim.dirY ? Math.abs(sim.y - y0) : dy0 > 0 ? 2 * fh - y0 - sim.y : y0 + sim.y;
    }
    expect(sim.rateX).toBe(1);
    expect(sim.rateY).toBe(1);
    expect(travelX).toBeCloseTo(100 * REFERENCE_SPEED, 6);
    expect(travelY).toBeCloseTo(100 * REFERENCE_SPEED, 6);
    expect(bounces).toBe(sim.bounces);
    expect(bounces).toBeGreaterThan(10);
  });

  it("counts both edges hit together as one bounce and one corner", () => {
    // A fresh "often" run starts on course for a corner.
    const sim = createLogoSim(0, 1000, 500, "often");
    let before = 0;
    let hits = 0;
    for (let i = 0; i < 200_000 && hits === 0; i++) {
      before = sim.bounces;
      sim.step(1 / 60, REFERENCE_SPEED);
      hits = sim.lastCorners;
    }
    expect(hits).toBe(1);
    expect(sim.bounces - before).toBe(1);
    expect(sim.corners).toBe(1);
  });

  it("shrinks the logo to fit a narrow canvas", () => {
    expect(logoHeight(0.18, 16 / 9, 2)).toBeCloseTo(0.18 * 1080, 9);
    const narrow = logoHeight(0.35, 9 / 16, 2);
    expect(narrow * 2).toBeLessThan(1080 * (9 / 16));
    expect(logoHeight(0.2, 1, 0)).toBeCloseTo(216, 9);
  });

  it("keeps an axis with no room centred instead of bouncing", () => {
    const sim = createLogoSim(4, -200, 600, "often");
    for (let i = 0; i < 1000; i++) {
      sim.step(0.1, MAX_LOGO_SPEED);
    }
    expect(sim.x).toBe(-100);
    expect(Number.isFinite(sim.y)).toBe(true);
    expect(sim.corners).toBe(0);
  });

  it("keeps the box inside and its direction on a resize", () => {
    const bad: string[] = [];
    for (let seed = 0; seed < 50; seed++) {
      const [fw, fh] = free(16 / 9, 0.18);
      const sim = createLogoSim(seed, fw, fh, "often");
      sim.step(7.3 + seed, REFERENCE_SPEED);
      for (const aspect of [4 / 3, 9 / 16, 21 / 9, 1]) {
        const dirX = sim.dirX;
        const dirY = sim.dirY;
        const [w, h] = free(aspect, 0.25);
        sim.setBounds(w, h);
        if (sim.dirX !== dirX || sim.dirY !== dirY) {
          bad.push(`seed ${String(seed)} turned on resize`);
        }
        if (sim.x < 0 || sim.x > w || sim.y < 0 || sim.y > h) {
          bad.push(`seed ${String(seed)} outside after resize`);
        }
        sim.step(3, REFERENCE_SPEED);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps the box's place as a fraction of the free space on a resize", () => {
    const sim = createLogoSim(9, 1000, 400, "natural");
    sim.step(2.5, REFERENCE_SPEED);
    const fx = sim.x / 1000;
    const fy = sim.y / 400;
    sim.setBounds(1500, 900);
    expect(sim.x / 1500).toBeCloseTo(fx, 12);
    expect(sim.y / 900).toBeCloseTo(fy, 12);
  });

  it("stays under the codec's per-frame limit at the fastest speed", () => {
    // Diagonal motion, with the planner's largest rate change on one axis.
    const cap = Math.max(...Object.values(PLAN_RATE_CAPS));
    const perSecond = Math.hypot(MAX_LOGO_SPEED * (1 + cap), MAX_LOGO_SPEED);
    expect(pxPerReferenceFrame(perSecond / 1080)).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
    expect(bouncingLogoMeta.params.speed.max).toBe(MAX_LOGO_SPEED);
  });
});

describe("corner planner", () => {
  const SPEEDS = [20, 45, REFERENCE_SPEED, 135, MAX_LOGO_SPEED];

  // One test per mode, canvas and speed, so no single test runs the whole sweep.
  const CASES = (["often", "sometimes"] as const).flatMap((mode) =>
    Object.entries(ASPECTS).flatMap(([name, aspect]) =>
      SPEEDS.map((speed) => ({ mode, name, aspect, speed })),
    ),
  );
  it.each(CASES)(
    'hits a corner within the "$mode" window at $name, $speed px/s, from any seed',
    ({ mode, aspect, speed }) => {
      const [, wMax] = CORNER_WINDOWS[mode];
      // Slower speeds stretch the window so the travel between corners stays the same.
      const window = wMax * Math.max(1, REFERENCE_SPEED / speed);
      const bad: string[] = [];
      let largestRate = 0;
      for (let seed = 0; seed < (mode === "often" ? 40 : 12); seed++) {
        const [fw, fh] = free(aspect, 0.18);
        const sim = createLogoSim(seed, fw, fh, mode, speed);
        const { wait, rate } = longestWait(sim, speed, 4 * window);
        largestRate = Math.max(largestRate, rate);
        // One frame of slack for the 30 fps steps.
        if (wait > window + 1 / 30) {
          bad.push(`seed ${String(seed)}: ${wait.toFixed(1)} s`);
        }
      }
      expect(bad).toEqual([]);
      expect(largestRate).toBeLessThanOrEqual(PLAN_RATE_CAPS[mode] + 1e-12);
    },
  );

  it.each(["often", "sometimes"] as const)("nudges the speed to plan %s corners", (mode) => {
    const [, wMax] = CORNER_WINDOWS[mode];
    let largestRate = 0;
    for (let seed = 0; seed < 4; seed++) {
      const [fw, fh] = free(ASPECTS["16:9"], 0.18);
      const sim = createLogoSim(seed, fw, fh, mode, REFERENCE_SPEED);
      largestRate = Math.max(largestRate, longestWait(sim, REFERENCE_SPEED, 4 * wMax).rate);
    }
    expect(largestRate).toBeGreaterThan(0);
  });

  it("still finds corners soon for any logo size and aspect", () => {
    const rng = createRng(11);
    let worst = 0;
    for (let trial = 0; trial < 120; trial++) {
      const aspect = [16 / 9, 4 / 3, 21 / 9, 9 / 16, 1, 32 / 9][trial % 6];
      const size = 0.08 + 0.27 * rng();
      const speed = 20 + 160 * rng();
      const window = CORNER_WINDOWS.often[1] * Math.max(1, REFERENCE_SPEED / speed);
      const [fw, fh] = free(aspect, size);
      const sim = createLogoSim(trial, fw, fh, "often", speed);
      worst = Math.max(worst, longestWait(sim, speed, 5 * window).wait / window);
    }
    expect(worst).toBeLessThan(2);
  });

  it("aims the first corner from a fresh seed inside the window", () => {
    const [wMin, wMax] = CORNER_WINDOWS.often;
    const firsts: number[] = [];
    for (let seed = 0; seed < 30; seed++) {
      const [fw, fh] = free(16 / 9, 0.18);
      const sim = createLogoSim(seed, fw, fh, "often", REFERENCE_SPEED);
      let t = 0;
      while (sim.corners === 0 && t < 2 * wMax) {
        sim.step(1 / 30, REFERENCE_SPEED);
        t += 1 / 30;
      }
      firsts.push(t);
    }
    expect(Math.min(...firsts)).toBeGreaterThanOrEqual(wMin - 1 / 30);
    expect(Math.max(...firsts)).toBeLessThanOrEqual(wMax + 1 / 30);
  });

  it("never plans in Natural mode, and drops a plan on a resize", () => {
    const [fw, fh] = free(16 / 9, 0.18);
    const natural = createLogoSim(2, fw, fh, "natural");
    natural.step(600, REFERENCE_SPEED);
    expect(natural.planned).toBe(false);
    const often = createLogoSim(2, fw, fh, "often");
    expect(often.planned).toBe(true);
    often.setBounds(fw - 50, fh);
    expect(often.planned).toBe(false);
    expect(often.rateX).toBe(1);
    expect(often.rateY).toBe(1);
  });

  it("is deterministic for a seed", () => {
    const run = () => {
      const sim = createLogoSim(5, 1500, 880, "often");
      for (let i = 0; i < 5000; i++) {
        sim.step(1 / 60, REFERENCE_SPEED);
      }
      return [sim.x, sim.y, sim.bounces, sim.corners];
    };
    expect(run()).toEqual(run());
  });
});

describe("colours", () => {
  it("never shows the same colour twice in a row", () => {
    const bad: string[] = [];
    for (const [name, palette] of Object.entries(LOGO_PALETTES)) {
      for (let b = 0; b < 3 * palette.length; b++) {
        if (
          palette[paletteIndex(b, palette.length)] === palette[paletteIndex(b + 1, palette.length)]
        ) {
          bad.push(`${name} after ${String(b)} bounces`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("has seven distinct colours per palette", () => {
    for (const palette of Object.values(LOGO_PALETTES)) {
      expect(new Set(palette).size).toBe(7);
    }
  });

  it("advances the colour on every bounce", () => {
    const [fw, fh] = free(4 / 3, 0.18);
    const sim = createLogoSim(8, fw, fh, "often");
    let changes = 0;
    let bounces = 0;
    for (let i = 0; i < 20_000; i++) {
      const before = paletteIndex(sim.bounces, 7);
      const n = sim.step(1 / 60, REFERENCE_SPEED);
      bounces += n;
      if (n === 1 && paletteIndex(sim.bounces, 7) !== before) {
        changes++;
      }
    }
    expect(bounces).toBeGreaterThan(50);
    expect(changes).toBe(bounces);
  });
});
