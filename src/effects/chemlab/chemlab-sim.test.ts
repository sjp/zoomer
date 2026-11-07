import { describe, expect, it } from "vitest";
import {
  BENCH_Y,
  BOTTLE,
  CHANGE_MAX,
  CHANGE_MIN,
  COLOUR_CHANGE,
  COLOUR_RATE,
  createDistillate,
  createReactions,
  CYLINDER,
  distillateAt,
  dripTime,
  DRIP_SLOT,
  FIRST_REACTION,
  GLOW_RISE,
  HALF_W,
  JAR,
  labLayout,
  type LabLayout,
  liquidColour,
  type Reactions,
  LOW_TOP,
  luma,
  MAX_GAP,
  MAX_PROPS,
  MAX_VESSELS,
  maxFill,
  MIDDLE,
  MIN_GAP,
  minFill,
  PALETTES,
  PALETTE_SIZE,
  paletteFor,
  PUFF,
  reactionGlow,
  reactionPuff,
  reactionStart,
  RECEIVER_DROPS,
  RECEIVER_FULL,
  REACTION_GLOW,
  SHELVES,
  slewColours,
  stepReactions,
  TUBE,
  vapourEmitter,
  vapourGrid,
  vapourRegion,
} from "./chemlab-sim";

const SEEDS = Array.from({ length: 60 }, (_, i) => i * 17);

/** A vessel's horizontal extent: a cylinder's foot is wider than its tube. */
const halfOf = (kind: number, w: number) => (kind === CYLINDER ? w * 1.9 : w);
/** Every vessel and prop as (x, base y, half width, height). */
const things = (l: LabLayout) => [
  ...l.vessels.map((v) => ({ x: v.x, y: v.y, half: halfOf(v.kind, v.w), h: v.h })),
  ...l.props.map((p) => ({ x: p.x, y: p.y, half: p.w, h: p.h })),
];

describe("labLayout", () => {
  it("is deterministic per seed, and differs between seeds", () => {
    expect(labLayout(42)).toEqual(labLayout(42));
    const a = JSON.stringify(labLayout(1));
    expect(SEEDS.filter((s) => JSON.stringify(labLayout(s)) === a).length).toBeLessThanOrEqual(1);
  });

  it.each(SEEDS)("keeps seed %i's glassware in the frame, within its limits", (seed) => {
    const l = labLayout(seed);
    expect(l.vessels.length).toBeLessThanOrEqual(MAX_VESSELS);
    expect(l.props.length).toBeLessThanOrEqual(MAX_PROPS);
    for (const v of things(l)) {
      expect(v.x - v.half).toBeGreaterThanOrEqual(-HALF_W);
      expect(v.x + v.half).toBeLessThanOrEqual(HALF_W);
      expect(v.y).toBeGreaterThanOrEqual(BENCH_Y);
      expect(v.y + v.h).toBeLessThan(0.5);
    }
    expect(l.still).toBeGreaterThanOrEqual(0);
    expect(l.receiver).toBeGreaterThanOrEqual(0);
  });

  it.each(SEEDS)("never overlaps seed %i's vessels or bottles", (seed) => {
    const l = labLayout(seed);
    const boxes = [
      ...l.vessels.map((v) => [
        v.x - halfOf(v.kind, v.w),
        v.x + halfOf(v.kind, v.w),
        v.y,
        v.y + v.h,
      ]),
      ...l.props
        .filter((p) => p.kind === BOTTLE || p.kind === JAR)
        .map((p) => [p.x - p.w, p.x + p.w, p.y, p.y + p.h]),
    ];
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a0, a1, ay0, ay1] = boxes[i];
        const [b0, b1, by0, by1] = boxes[j];
        if (!(a1 <= b0 || b1 <= a0 || ay1 <= by0 || by1 <= ay0)) {
          overlaps.push(`${String(i)} and ${String(j)}`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it.each(SEEDS)("keeps the middle third clear for seed %i, apart from low items", (seed) => {
    const l = labLayout(seed);
    const inMiddle = things(l).filter((v) => v.x + v.half > -MIDDLE && v.x - v.half < MIDDLE);
    expect(inMiddle.filter((v) => v.y + v.h > LOW_TOP + 1e-9)).toEqual([]);
  });

  it.each(SEEDS)(
    "stands seed %i's things on a shelf or the bench, under the next shelf up",
    (seed) => {
      const l = labLayout(seed);
      const misplaced = things(l).filter((v) => {
        const shelf = SHELVES.find((s) => Math.abs(v.y - s.y) < 1e-9 && v.x > s.x0 && v.x < s.x1);
        if (shelf) {
          return v.x - v.half < shelf.x0 || v.x + v.half > shelf.x1 || v.h > shelf.maxH + 1e-9;
        }
        // On the bench, on a tripod over a burner, or in a rack, under the lower shelves.
        return v.y >= 0 || v.y + v.h >= SHELVES[1].y - 0.01;
      });
      expect(misplaced).toEqual([]);
    },
  );

  it.each(SEEDS)("fills seed %i's vessels within their walls", (seed) => {
    const l = labLayout(seed);
    for (const v of l.vessels) {
      expect(v.fill).toBeGreaterThanOrEqual(minFill(v.kind, v.h));
      expect(v.fill).toBeLessThanOrEqual(maxFill(v.kind, v.w, v.h) + 1e-12);
      expect(maxFill(v.kind, v.w, v.h)).toBeLessThan(v.h);
      expect(v.entry).toBeGreaterThanOrEqual(0);
      expect(v.entry).toBeLessThan(PALETTE_SIZE);
    }
  });

  it("has burners, test tubes, a dry-ice beaker and a glowing cylinder for most seeds", () => {
    const layouts = SEEDS.map((s) => labLayout(s));
    expect(layouts.every((l) => l.vessels.some((v) => v.heated))).toBe(true);
    expect(layouts.filter((l) => l.lava >= 0).length).toBeGreaterThan(SEEDS.length * 0.8);
    expect(layouts.filter((l) => l.vessels.some((v) => v.spill)).length).toBe(SEEDS.length);
    expect(layouts.filter((l) => l.vessels.some((v) => v.kind === TUBE)).length).toBeGreaterThan(
      SEEDS.length / 3,
    );
  });

  it.each(SEEDS)("picks seed %i's vapour sources on their own side", (seed) => {
    const l = labLayout(seed);
    const sources = [...l.emitters].map((e, i) => ({ e, i })).filter(({ e }) => e >= 0);
    expect(sources.map(({ e }) => e)).not.toContain(l.still);
    expect(sources.map(({ e, i }) => Math.sign(l.vessels[e].x) === (i < 2 ? -1 : 1))).not.toContain(
      false,
    );
    expect(l.emitters[0]).toBeGreaterThanOrEqual(0);
    expect(l.emitters[2]).toBeGreaterThanOrEqual(0);
  });
});

describe("palettes", () => {
  it("has six bright colours in each, and falls back to Mixed", () => {
    for (const p of Object.values(PALETTES)) {
      expect(p).toHaveLength(PALETTE_SIZE);
      expect(Math.min(...p.map((c) => Math.max(...c)))).toBeGreaterThan(0.8);
      expect(Math.max(...p.flat())).toBeLessThanOrEqual(1);
    }
    expect(paletteFor("nope")).toBe(PALETTES.mixed);
  });

  it("slews shown colours no faster than the comfort rate", () => {
    const shown = new Float32Array([Number.NaN, 0, 0]);
    const target = new Float32Array([1, 1, 0]);
    expect(slewColours(shown, target, COLOUR_RATE, 0.1)).toBe(true);
    expect(shown[0]).toBe(1);
    expect(shown[1]).toBeCloseTo(COLOUR_RATE * 0.1, 6);
    for (let i = 0; i < 100; i++) {
      slewColours(shown, target, COLOUR_RATE, 0.1);
    }
    expect(slewColours(shown, target, COLOUR_RATE, 0.1)).toBe(false);
    expect(COLOUR_RATE).toBeLessThanOrEqual(1);
  });
});

/** Steps reactions for `seconds` at `dt`, calling `each` after every step. */
function runReactions(
  l: LabLayout,
  seed: number,
  seconds: number,
  dt: number,
  each: (t: number, r: Reactions) => void,
  enabled = true,
): Reactions {
  const r = createReactions(l);
  for (let t = 0; t <= seconds; t += dt) {
    stepReactions(r, l, seed, t, enabled);
    each(t, r);
  }
  return r;
}

/** The reactions started over a run, in order. */
function startedReactions(l: LabLayout, seed: number, seconds: number, dt: number) {
  const out: {
    start: number;
    kind: number;
    vessel: number;
    from: number;
    to: number;
    duration: number;
  }[] = [];
  runReactions(l, seed, seconds, dt, (_t, r) => {
    if (r.vessel >= 0 && out.at(-1)?.start !== r.start) {
      out.push({
        start: r.start,
        kind: r.kind,
        vessel: r.vessel,
        from: r.from,
        to: r.to,
        duration: r.duration,
      });
    }
  });
  return out;
}

describe("reactions", () => {
  it("come one to three minutes apart, the first soon", () => {
    for (const seed of [0, 7, 99]) {
      expect(reactionStart(0, seed)).toBe(FIRST_REACTION);
      const gaps = Array.from(
        { length: 200 },
        (_, k) => reactionStart(k + 1, seed) - reactionStart(k, seed),
      );
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MIN_GAP);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(MAX_GAP);
    }
    expect(MIN_GAP).toBeGreaterThanOrEqual(60);
    expect(MAX_GAP).toBeLessThanOrEqual(180);
  });

  it("change colours over 3 to 5 seconds, keeping their gap", () => {
    const seed = 7;
    const started = startedReactions(labLayout(seed), seed, 1500, 0.25);
    expect(started.length).toBeGreaterThanOrEqual(8);
    const changes = started.filter((r) => r.kind === COLOUR_CHANGE);
    expect(changes.length).toBeGreaterThan(0);
    expect(Math.min(...changes.map((r) => r.duration))).toBeGreaterThanOrEqual(CHANGE_MIN);
    expect(Math.max(...changes.map((r) => r.duration))).toBeLessThanOrEqual(CHANGE_MAX);
    expect(changes.filter((r) => r.to === r.from)).toEqual([]);
    const gaps = started.slice(1).map((r, i) => r.start - started[i].start);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MIN_GAP);
  });

  it("change colours continuously, never flashing", () => {
    const seed = 7;
    const l = labLayout(seed);
    const pal = PALETTES.mixed;
    const n = l.vessels.length;
    const prev = new Float32Array(n * 3);
    const cur = new Float32Array(n * 3);
    const dt = 1 / 20;
    let maxStep = 0;
    let maxLumaRate = 0;
    runReactions(l, seed, 900, dt, (t, r) => {
      for (let v = 0; v < n; v++) {
        liquidColour(r, v, t, pal, cur, v * 3);
      }
      // The first step has nothing to compare with.
      const from = t > 0 ? 0 : n;
      for (let v = from; v < n; v++) {
        for (let k = 0; k < 3; k++) {
          maxStep = Math.max(maxStep, Math.abs(cur[v * 3 + k] - prev[v * 3 + k]));
        }
        const dl = Math.abs(luma(cur.subarray(v * 3)) - luma(prev.subarray(v * 3)));
        maxLumaRate = Math.max(maxLumaRate, dl / dt);
      }
      prev.set(cur);
    });
    expect(maxStep).toBeGreaterThan(0);
    // Smoothstep's steepest slope over the shortest change, for a full channel swing.
    expect(maxStep).toBeLessThanOrEqual((1.5 / CHANGE_MIN) * dt + 1e-6);
    expect(maxLumaRate).toBeLessThan(0.5);
  });

  it("ramp a reacting flask's glow over at least a second, and cap it", () => {
    const seed = 3;
    const l = labLayout(seed);
    let peak = 0;
    let maxRate = 0;
    let prev = 0;
    let puffMin = 0;
    let puffMax = 0;
    const dt = 1 / 30;
    runReactions(l, seed, 700, dt, (t, r) => {
      let glow = 0;
      for (let v = 0; v < l.vessels.length; v++) {
        glow = Math.max(glow, reactionGlow(r, v, t));
        puffMin = Math.min(puffMin, reactionPuff(r, v, t));
        puffMax = Math.max(puffMax, reactionPuff(r, v, t));
      }
      peak = Math.max(peak, glow);
      maxRate = Math.max(maxRate, Math.abs(glow - prev) / dt);
      prev = glow;
    });
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(REACTION_GLOW);
    // No faster than rising to the peak in one second.
    expect(maxRate).toBeLessThanOrEqual(REACTION_GLOW);
    expect(GLOW_RISE).toBeGreaterThanOrEqual(1);
    expect(puffMin).toBe(0);
    expect(puffMax).toBeLessThanOrEqual(1);
  });

  it("start none while switched off, but finish one under way", () => {
    const seed = 11;
    const l = labLayout(seed);
    const off = runReactions(l, seed, 600, 0.5, () => undefined, false);
    expect(off.vessel).toBe(-1);
    const on = createReactions(l);
    stepReactions(on, l, seed, FIRST_REACTION + 1, true);
    expect(on.vessel).toBeGreaterThanOrEqual(0);
    const v = on.vessel;
    stepReactions(on, l, seed, FIRST_REACTION + 2, false);
    expect(on.vessel).toBe(v);
    const out = new Float32Array(3);
    liquidColour(on, v, FIRST_REACTION + 20, PALETTES.mixed, out, 0);
    expect([...out]).toEqual(PALETTES.mixed[on.to].map((c) => Math.fround(c)));
  });

  it("puff only from vapour sources, leaving the colour alone, and never touch the distillation", () => {
    for (const seed of [1, 2, 5, 8, 13]) {
      const l = labLayout(seed);
      const started = startedReactions(l, seed, 3000, 1);
      const puffs = started.filter((r) => r.kind === PUFF);
      expect(puffs.filter((r) => !l.emitters.includes(r.vessel) || r.to !== r.from)).toEqual([]);
      expect(started.map((r) => r.vessel)).not.toContain(l.receiver);
      expect(started.map((r) => r.vessel)).not.toContain(l.still);
    }
  });
});

describe("distillation", () => {
  it("drips every 2 to 4 seconds while filling", () => {
    const times = Array.from({ length: 400 }, (_, s) => dripTime(s));
    const gaps = times
      .slice(1)
      .map((t, i) => t - times[i])
      .filter((g) => Number.isFinite(g));
    expect(gaps.length).toBeGreaterThan(300);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(4);
  });

  it("fills the receiver steadily over minutes, then fades it back to empty", () => {
    const d = createDistillate();
    let prevLevel = distillateAt(0, d).level;
    let prevOpacity = d.opacity;
    let full = 0;
    let maxRise = 0;
    const bad: string[] = [];
    for (let t = 0; t < RECEIVER_DROPS * DRIP_SLOT * 2.5; t += 0.05) {
      distillateAt(t, d);
      if (d.level < 0 || d.level > RECEIVER_FULL + 1e-9 || d.opacity < 0 || d.opacity > 1) {
        bad.push(`out of range at ${t.toFixed(2)}`);
      }
      if (d.drop < 0 || d.drop > 1 || d.fall < 0 || d.fall > 1) {
        bad.push(`drop out of range at ${t.toFixed(2)}`);
      }
      // It only empties once faded out.
      if (d.level < prevLevel && (prevOpacity !== 0 || d.level !== 0)) {
        bad.push(`emptied while visible at ${t.toFixed(2)}`);
      }
      maxRise = Math.max(maxRise, d.level - prevLevel);
      full = Math.max(full, d.level);
      prevLevel = d.level;
      prevOpacity = d.opacity;
    }
    expect(bad).toEqual([]);
    // One drop's worth at most, spread over its settling.
    expect(maxRise).toBeLessThan((RECEIVER_FULL / RECEIVER_DROPS) * 0.2);
    expect(full).toBeCloseTo(RECEIVER_FULL, 6);
    expect(RECEIVER_DROPS * DRIP_SLOT).toBeGreaterThanOrEqual(120);
  });
});

describe("vapour", () => {
  it("puts each source inside its field and turns it off at nothing", () => {
    const bad: string[] = [];
    const region = new Float64Array(4);
    const e = new Float64Array(4);
    for (const seed of SEEDS) {
      const l = labLayout(seed);
      for (let side = 0; side < 2; side++) {
        vapourRegion(side, region);
        for (let slot = 0; slot < 2; slot++) {
          vapourEmitter(l, side, slot, 1, 0, e);
          const on = l.emitters[side * 2 + slot] >= 0;
          const inside =
            e[0] > region[0] &&
            e[0] < region[0] + region[2] &&
            e[1] > region[1] &&
            e[1] < region[1] + region[3];
          if (on && (!inside || !(e[3] > 0 && e[3] <= 1))) {
            bad.push(`seed ${String(seed)} side ${String(side)} slot ${String(slot)}`);
          }
          if (!on && e[3] !== 0) {
            bad.push(`seed ${String(seed)} side ${String(side)} slot ${String(slot)} not off`);
          }
          vapourEmitter(l, side, slot, 0, 1, e);
          if (e[3] !== 0) {
            bad.push(
              `seed ${String(seed)} side ${String(side)} slot ${String(slot)} puffs with no vapour`,
            );
          }
        }
      }
    }
    expect(bad).toEqual([]);
    const grid = new Int32Array(2);
    vapourGrid(0, grid);
    expect(grid[0] * grid[1]).toBeLessThan(30000);
  });
});
