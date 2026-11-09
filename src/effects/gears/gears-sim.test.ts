import { describe, expect, it } from "vitest";
import {
  advanceDrive,
  balanceAngle,
  CLEARANCE,
  createDrive,
  driveAngle,
  driveOmega,
  type Gear,
  gearAngle,
  growTrain,
  LAYERS,
  LAYOUT_SPECS,
  MAX_RATIO,
  meshPhase,
  regionFits,
  rootAnchors,
  teethPerDriveTurn,
  STYLE_BALANCE,
  TICK_PERIOD,
  tickEase,
  tipRadius,
  toothEdge,
} from "./gears-sim";
import { type GearLayoutId, gearsMeta, MAX_GEARS } from "./gears.meta";
import { MAX_PATTERN_HZ } from "../motion-limits";

const TAU = Math.PI * 2;
const LAYOUTS: GearLayoutId[] = ["corner", "side", "frame"];
const ASPECTS = [16 / 9, 4 / 3, 21 / 9];
const SEEDS = [0, 7, 12, 123, 999];

/** Every (layout, aspect, seed) train, grown once. */
const trains = LAYOUTS.flatMap((layout) =>
  ASPECTS.flatMap((aspect) =>
    SEEDS.map((seed) => ({ layout, aspect, seed, gears: growTrain(layout, aspect, seed) })),
  ),
);

/** Whether point (x, y) is inside gear g's outline at drive angle `drive`. */
function inside(g: Gear, drive: number, x: number, y: number): boolean {
  const dx = x - g.x;
  const dy = y - g.y;
  const local = Math.atan2(dy, dx) - gearAngle(g, drive);
  return Math.hypot(dx, dy) < toothEdge(g.pitchR, g.module, g.teeth, local);
}

describe("growTrain", () => {
  it("grows a full train with a balance wheel in every layout", () => {
    const bad: string[] = [];
    for (const t of trains) {
      const spec = LAYOUT_SPECS[t.layout];
      const toothed = t.gears.filter((g) => g.teeth > 0).length;
      const balance = t.gears.filter((g) => g.style === STYLE_BALANCE).length;
      if (toothed < spec.count * 0.75 || balance !== 1 || t.gears.length > MAX_GEARS) {
        bad.push(
          `${t.layout} ${t.aspect.toFixed(2)} ${String(t.seed)}: ${String(toothed)} gears, ${String(balance)} balance`,
        );
      }
    }
    expect(bad).toEqual([]);
  });

  it("still grows something in a portrait frame", () => {
    for (const layout of LAYOUTS) {
      expect(growTrain(layout, 9 / 16, 3).length).toBeGreaterThan(2);
    }
  });

  it("is deterministic per seed", () => {
    expect(growTrain("corner", 16 / 9, 5)).toEqual(growTrain("corner", 16 / 9, 5));
    expect(growTrain("corner", 16 / 9, 5)).not.toEqual(growTrain("corner", 16 / 9, 6));
  });

  it("meshes at the sum of the pitch radii, with speeds in the tooth ratio and opposite", () => {
    let bad = 0;
    let meshes = 0;
    for (const { gears } of trains) {
      for (const g of gears) {
        if (g.parent < 0) {
          continue;
        }
        const p = gears[g.parent];
        if (g.axle) {
          if (g.ratio !== p.ratio || g.x !== p.x || g.y !== p.y || g.layer === p.layer) {
            bad++;
          }
          continue;
        }
        meshes++;
        const d = Math.hypot(g.x - p.x, g.y - p.y);
        if (Math.abs(d - (g.pitchR + p.pitchR)) > 1e-12) {
          bad++;
        }
        if (Math.abs(g.ratio * g.teeth + p.ratio * p.teeth) > 1e-9) {
          bad++;
        }
        if (Math.sign(g.ratio) === Math.sign(p.ratio)) {
          bad++;
        }
        if (g.layer !== p.layer) {
          bad++;
        }
        if (Math.abs(g.ratio) > MAX_RATIO) {
          bad++;
        }
      }
    }
    expect(meshes).toBeGreaterThan(200);
    expect(bad).toBe(0);
  });

  it("interleaves the teeth at the contact point for all times", () => {
    let bad = 0;
    let checks = 0;
    for (const { gears } of trains.filter((_, i) => i % 3 === 0)) {
      for (const g of gears) {
        if (g.parent < 0 || g.axle) {
          continue;
        }
        const p = gears[g.parent];
        const alpha = Math.atan2(g.y - p.y, g.x - p.x);
        for (let k = 0; k < 40; k++) {
          const drive = k * 0.37 - 3;
          // Tooth-pitch distance from the nearest tooth centre, for each gear at the contact.
          const w = (gear: Gear, angle: number) => {
            const s = ((angle - gearAngle(gear, drive)) * gear.teeth) / TAU;
            return Math.abs(s - Math.round(s));
          };
          const sum = w(p, alpha) + w(g, alpha + Math.PI);
          checks++;
          if (Math.abs(sum - 0.5) > 1e-6) {
            bad++;
          }
        }
      }
    }
    expect(checks).toBeGreaterThan(1000);
    expect(bad).toBe(0);
  });

  it("never lets meshing teeth overlap", () => {
    let overlaps = 0;
    let samples = 0;
    for (const { gears } of trains.filter((_, i) => i % 6 === 0)) {
      for (const g of gears) {
        if (g.parent < 0 || g.axle) {
          continue;
        }
        const p = gears[g.parent];
        const alpha = Math.atan2(g.y - p.y, g.x - p.x);
        const ux = Math.cos(alpha);
        const uy = Math.sin(alpha);
        const m = g.module;
        for (let k = 0; k < 8; k++) {
          const drive = k * 0.113;
          // A grid over the mesh zone, a few tooth pitches either side of the line of centres.
          for (let i = -6; i <= 6; i++) {
            const along = p.pitchR + (i / 6) * 1.4 * m;
            for (let j = -20; j <= 20; j++) {
              const across = (j / 20) * 3 * Math.PI * m;
              const x = p.x + ux * along - uy * across;
              const y = p.y + uy * along + ux * across;
              samples++;
              if (inside(p, drive, x, y) && inside(g, drive, x, y)) {
                overlaps++;
              }
            }
          }
        }
      }
    }
    expect(samples).toBeGreaterThan(100000);
    expect(overlaps).toBe(0);
  });

  it("keeps gears in the same layer apart and every gear in the region", () => {
    const bad: string[] = [];
    for (const { layout, aspect, seed, gears } of trains) {
      gears.forEach((g, i) => {
        if (!regionFits(layout, aspect, g.x, g.y, tipRadius(g))) {
          bad.push(`${layout} ${String(seed)} #${String(i)} out`);
        }
        if (g.layer < 0 || g.layer >= LAYERS) {
          bad.push(`${layout} ${String(seed)} #${String(i)} layer`);
        }
        for (let j = 0; j < i; j++) {
          const o = gears[j];
          if (o.layer !== g.layer || (g.parent === j && !g.axle) || (o.parent === i && !o.axle)) {
            continue;
          }
          const d = Math.hypot(o.x - g.x, o.y - g.y);
          if (d < tipRadius(o) + tipRadius(g) + CLEARANCE - 1e-12) {
            bad.push(`${layout} ${String(seed)} #${String(i)} overlaps #${String(j)}`);
          }
        }
      });
    }
    expect(bad).toEqual([]);
  });
});

describe("regionFits", () => {
  const a = 16 / 9;
  it("keeps the corner layout in the top-right corner", () => {
    expect(regionFits("corner", a, a - 0.1, 0.9, 0.1)).toBe(true);
    expect(regionFits("corner", a, 0.1, 0.9, 0.05)).toBe(false);
    expect(regionFits("corner", a, a - 0.1, 0.1, 0.05)).toBe(false);
  });
  it("keeps the side layout at the right edge", () => {
    expect(regionFits("side", a, a - 0.2, 0.5, 0.15)).toBe(true);
    expect(regionFits("side", a, a - 0.4, 0.5, 0.15)).toBe(false);
  });
  it("keeps the frame layout out of the middle", () => {
    expect(regionFits("frame", a, 0.1, 0.5, 0.12)).toBe(true);
    expect(regionFits("frame", a, 0.1, 0.5, 0.2)).toBe(false);
    expect(regionFits("frame", a, a / 2, 0.5, 0.01)).toBe(false);
  });
  it("rejects centres outside the frame", () => {
    expect(regionFits("frame", a, -0.01, 0.5, 0.01)).toBe(false);
  });
});

describe("toothEdge", () => {
  it("runs from the tip at a tooth's centre to the root between teeth", () => {
    const m = 0.01;
    const n = 20;
    const r = (m * n) / 2;
    expect(toothEdge(r, m, n, 0)).toBeCloseTo(r + m, 12);
    expect(toothEdge(r, m, n, Math.PI / n)).toBeCloseTo(r - 1.25 * m, 12);
    expect(toothEdge(r, m, n, TAU / n)).toBeCloseTo(r + m, 12);
  });
});

describe("drive", () => {
  it("eases each tick from 0 to 1 with a small overshoot", () => {
    expect(tickEase(0)).toBe(0);
    expect(tickEase(1)).toBeCloseTo(1, 12);
    let peak = 0;
    for (let u = 0; u <= 1; u += 0.01) {
      peak = Math.max(peak, tickEase(u));
    }
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.15);
  });

  it("ticks forwards in steps that track the smooth drive", () => {
    const d = createDrive(true);
    const omega = TAU / 60;
    const dt = 1 / 60;
    let maxLag = 0;
    let backwards = 0;
    let last = driveAngle(d);
    for (let i = 0; i < 1200; i++) {
      advanceDrive(d, dt, omega, true);
      const a = driveAngle(d);
      maxLag = Math.max(maxLag, Math.abs(a - d.smooth));
      // Only the settle may move it back, and only a little.
      if (a < last - 0.2 * omega * TICK_PERIOD) {
        backwards++;
      }
      last = a;
    }
    expect(backwards).toBe(0);
    expect(maxLag).toBeLessThan(1.2 * omega * TICK_PERIOD);
    expect(d.smooth).toBeCloseTo(omega * 20, 9);
  });

  it("doesn't jump when the speed changes or the tick is toggled", () => {
    const d = createDrive(true);
    const dt = 1 / 60;
    let maxJump = 0;
    let last = driveAngle(d);
    for (let i = 0; i < 1800; i++) {
      const omega = i < 600 ? 0.1 : i < 1200 ? 0.4 : 0.2;
      advanceDrive(d, dt, omega, i < 900 || i > 1500);
      const a = driveAngle(d);
      maxJump = Math.max(maxJump, Math.abs(a - last));
      last = a;
    }
    // Bounded by a tick's first-frame kick, even for the one step that catches up
    // after the speed quadruples (at most two steps' worth at the top speed).
    expect(maxJump).toBeLessThan(tickEase(dt / TICK_PERIOD) * 2 * 0.4 * TICK_PERIOD);
  });

  it("turns smoothly with the tick off", () => {
    const d = createDrive(false);
    const dt = 1 / 60;
    let maxJump = 0;
    let last = driveAngle(d);
    for (let i = 0; i < 600; i++) {
      advanceDrive(d, dt, i < 300 ? 0.1 : 0.4, false);
      const a = driveAngle(d);
      maxJump = Math.max(maxJump, Math.abs(a - last));
      last = a;
    }
    expect(maxJump).toBeLessThan(0.4 * dt + 1e-12);
  });

  it("swings the balance wheel each way in turn, never past its amplitude", () => {
    const d = createDrive(true);
    let pos = 0;
    let neg = 0;
    for (let i = 0; i < 240; i++) {
      advanceDrive(d, 1 / 60, 0.1, true);
      const b = balanceAngle(d);
      if (b > 1) {
        pos++;
      }
      if (b < -1) {
        neg++;
      }
    }
    expect(pos).toBeGreaterThan(30);
    expect(neg).toBeGreaterThan(30);
  });
});

describe("driveOmega", () => {
  const { speed } = gearsMeta.params;

  it("keeps every gear's teeth under MAX_PATTERN_HZ at any speed", () => {
    let firstFast:
      | { layout: string; aspect: number; seed: number; rpm: number; hz: number }
      | undefined;
    for (const { layout, aspect, seed, gears } of trains) {
      const teeth = teethPerDriveTurn(gears.slice(0, MAX_GEARS));
      for (let rpm = speed.min; rpm <= speed.max + 1e-9; rpm += speed.step) {
        for (const g of gears.slice(0, MAX_GEARS)) {
          const hz = (driveOmega(rpm, teeth) / TAU) * Math.abs(g.ratio) * g.teeth;
          if (!firstFast && !(hz <= MAX_PATTERN_HZ + 1e-9)) {
            firstFast = { layout, aspect, seed, rpm, hz };
          }
        }
      }
    }
    expect(firstFast).toBeUndefined();
  });

  it("leaves the default speed alone", () => {
    for (const { gears } of trains) {
      const teeth = teethPerDriveTurn(gears.slice(0, MAX_GEARS));
      expect(driveOmega(speed.default, teeth)).toBeCloseTo((speed.default * TAU) / 60, 12);
    }
  });

  it("gives 0 for a bad speed", () => {
    expect(driveOmega(Number.NaN, 40)).toBe(0);
    expect(driveOmega(-1, 40)).toBe(0);
  });
});

describe("meshPhase", () => {
  const gear = (teeth: number, phase: number, ratio: number): Gear => ({
    x: 0,
    y: 0,
    teeth,
    pitchR: teeth / 100,
    module: 0.02,
    layer: 1,
    ratio,
    phase,
    style: 0,
    spokes: 0,
    screws: 0,
    metal: 0,
    tint: 0,
    parent: -1,
    axle: false,
  });
  /** Tooth pitches from the nearest tooth centre to the contact point at `angle`. */
  const pitches = (g: Gear, angle: number, drive: number) =>
    ((angle - gearAngle(g, drive)) * g.teeth) / (2 * Math.PI);
  const frac = (v: number) => v - Math.floor(v);

  it("puts a tooth of one gear in a gap of the other at the contact, at every drive angle", () => {
    for (const [ta, tb, alpha, phase] of [
      [12, 20, 0.3, 0],
      [24, 9, -2.1, 1.7],
      [40, 40, Math.PI, 5],
    ]) {
      const a = gear(ta, phase, 0.8);
      const b = gear(tb, 0, (-a.ratio * ta) / tb);
      b.phase = meshPhase(a, b, alpha);
      for (const drive of [0, 0.37, 2, -11.5, 400]) {
        const sum = pitches(a, alpha, drive) + pitches(b, alpha + Math.PI, drive);
        // Half a pitch apart, to float rounding: tooth meets gap.
        expect(Math.abs(frac(sum) - 0.5)).toBeLessThan(1e-6);
      }
    }
  });

  it("holds for every meshing pair the trains grow", () => {
    const off: string[] = [];
    for (const layout of ["corner", "side", "frame"] as const) {
      const gears = growTrain(layout, 16 / 9, 5);
      for (const g of gears) {
        if (g.parent < 0 || g.axle || g.teeth === 0) {
          continue;
        }
        const p = gears[g.parent];
        const alpha = Math.atan2(g.y - p.y, g.x - p.x);
        for (const drive of [0, 1.3, 50]) {
          const sum = pitches(p, alpha, drive) + pitches(g, alpha + Math.PI, drive);
          if (Math.abs(frac(sum) - 0.5) > 1e-6) {
            off.push(`${layout} gear ${String(gears.indexOf(g))} at drive ${String(drive)}`);
          }
        }
      }
    }
    expect(off).toEqual([]);
  });
});

describe("rootAnchors", () => {
  it("starts each layout's trains inside its region, the drive first", () => {
    const counts = { corner: 1, side: 2, frame: 8 };
    for (const layout of ["corner", "side", "frame"] as const) {
      for (const aspect of [4 / 3, 16 / 9, 21 / 9, 32 / 9]) {
        const anchors = rootAnchors(layout, aspect);
        expect(anchors).toHaveLength(counts[layout]);
        for (const [x, y] of anchors) {
          expect(regionFits(layout, aspect, x, y, 0)).toBe(true);
        }
      }
    }
  });

  it("puts the drive at the top right in every layout", () => {
    for (const layout of ["corner", "side", "frame"] as const) {
      const [[x, y]] = rootAnchors(layout, 16 / 9);
      expect(x).toBeGreaterThan(16 / 9 - 0.25);
      expect(y).toBeGreaterThan(0.7);
    }
  });

  it("spreads the frame layout's trains round all four sides", () => {
    const a = 16 / 9;
    const anchors = rootAnchors("frame", a);
    expect(anchors.some(([x]) => x < 0.2)).toBe(true);
    expect(anchors.some(([x]) => x > a - 0.2)).toBe(true);
    expect(anchors.some(([, y]) => y < 0.2)).toBe(true);
    expect(anchors.some(([, y]) => y > 0.8)).toBe(true);
  });
});
