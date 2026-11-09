import { describe, expect, it } from "vitest";
import { FADE_OUT } from "../fade";
import { createRng } from "../noise";
import {
  buildGrid,
  cellOf,
  createRainSim,
  DEAD,
  dropletFade,
  emitTrail,
  instanceCapacity,
  INSTANCE_STRIDE,
  MAX_RUNNER_R,
  MAX_TRAIL_R,
  MAX_WIPE_STAMPS,
  RESTING,
  RUNNING,
  WIGGLE_WAVELENGTH,
  resizeRainSim,
  runnerStretch,
  spawnRunner,
  STATIC,
  STATIC_MAX_R,
  STATIC_MIN_R,
  stepRainSim,
  TRAIL,
  TRAIL_GRACE,
  wipeCapsule,
  wipeStampCapacity,
  writeDropInstances,
  writeWipeStamps,
  type RainSim,
  type RainSimConfig,
} from "./windowrain-sim";

const SMALL: RainSimConfig = { maxStatic: 200, maxTrails: 40, maxRunners: 8, cellSize: 16 };

const make = (config: RainSimConfig = SMALL, seed = 1) =>
  createRainSim(1920, 1080, createRng(seed), config);

/** Places live static droplet `i` at (x, y) with radius r, mid-life. */
const place = (sim: RainSim, i: number, x: number, y: number, r = 2) => {
  sim.dx[i] = x;
  sim.dy[i] = y;
  sim.dr[i] = r;
  sim.dLife[i] = 10;
  sim.dAge[i] = 5;
  sim.dKind[i] = STATIC;
};

/** A sim with no active drops, for hand-placed scenarios. */
const empty = (config: RainSimConfig = SMALL) => {
  const sim = make(config);
  sim.primed = true;
  return sim;
};

const countKind = (sim: RainSim, kind: number) => sim.dKind.filter((k) => k === kind).length;

describe("grid", () => {
  it("sizes the grid from the window and cell size", () => {
    const sim = make();
    expect(sim.cols).toBe(120);
    expect(sim.rows).toBe(68);
    expect(sim.head.length).toBe(120 * 68);
  });

  it("clamps out-of-window points to edge cells", () => {
    const sim = make();
    expect(cellOf(sim, -50, -50)).toBe(0);
    expect(cellOf(sim, 5000, 5000)).toBe(sim.cols * sim.rows - 1);
    expect(cellOf(sim, 17, 33)).toBe(2 * sim.cols + 1);
  });

  it("links every live droplet into its cell and skips dead ones", () => {
    const sim = empty();
    place(sim, 0, 10, 10);
    place(sim, 1, 12, 14);
    place(sim, 2, 500, 300);
    place(sim, 3, 20, 10);
    sim.dKind[3] = DEAD;
    buildGrid(sim);
    const listed = (c: number) => {
      const out: number[] = [];
      for (let i = sim.head[c]; i !== -1; i = sim.next[i]) {
        out.push(i);
      }
      return out.toSorted((a, b) => a - b);
    };
    expect(listed(cellOf(sim, 10, 10))).toEqual([0, 1]);
    expect(listed(cellOf(sim, 500, 300))).toEqual([2]);
    expect(listed(cellOf(sim, 20, 10))).toEqual([]);
  });

  it("is rebuilt from scratch, so moved droplets leave their old cell", () => {
    const sim = empty();
    place(sim, 0, 10, 10);
    buildGrid(sim);
    sim.dx[0] = 900;
    buildGrid(sim);
    expect(sim.head[cellOf(sim, 10, 10)]).toBe(-1);
    expect(sim.head[cellOf(sim, 900, 10)]).toBe(0);
  });
});

describe("wipeCapsule", () => {
  it("wipes droplets along the segment and leaves others", () => {
    const sim = empty();
    sim.staticCount = 4;
    place(sim, 0, 100, 100); // on the start
    place(sim, 1, 104, 150); // near the middle
    place(sim, 2, 100, 230); // past the end
    place(sim, 3, 140, 150); // beside it
    buildGrid(sim);
    const volume = wipeCapsule(sim, 100, 100, 100, 200, 10);
    expect(sim.wiped).toBe(2);
    expect(volume).toBeCloseTo(2 * 8, 3);
    // Wiped static droplets respawn elsewhere, fading in.
    expect(sim.dAge[0]).toBe(0);
    expect(sim.dAge[1]).toBe(0);
    expect(sim.dKind[0]).toBe(STATIC);
    expect(sim.dx[2]).toBe(100);
    expect(sim.dy[2]).toBe(230);
    expect(sim.dAge[2]).toBe(5);
    expect(sim.dAge[3]).toBe(5);
  });

  it("counts half the droplet radius towards contact", () => {
    const sim = empty();
    place(sim, 0, 100, 111.5, 4); // 11.5 away: within 10 + 4/2
    place(sim, 1, 100, 113, 2); // 13 away: beyond 10 + 2/2
    buildGrid(sim);
    wipeCapsule(sim, 100, 100, 100, 100, 10);
    expect(sim.wiped).toBe(1);
    expect(sim.dAge[1]).toBe(5);
  });

  it("finds droplets across cell borders", () => {
    const sim = empty();
    // Cell size 16: the capsule sits in cell 6, the droplets in neighbouring cells.
    place(sim, 0, 95, 100);
    place(sim, 1, 113, 100);
    place(sim, 2, 104, 90);
    buildGrid(sim);
    wipeCapsule(sim, 104, 100, 104, 100, 10);
    expect(sim.wiped).toBe(3);
  });

  it("spares fresh trail droplets and kills older ones", () => {
    const sim = empty();
    expect(emitTrail(sim, 100, 100, 2)).toBe(true);
    expect(emitTrail(sim, 102, 100, 2)).toBe(true);
    const a = SMALL.maxStatic;
    sim.dAge[a + 1] = TRAIL_GRACE + 0.1;
    buildGrid(sim);
    wipeCapsule(sim, 100, 100, 100, 100, 10);
    expect(sim.dKind[a]).toBe(TRAIL);
    expect(sim.dKind[a + 1]).toBe(DEAD);
    expect(sim.wiped).toBe(1);
  });

  it("wipes exactly what a brute-force search over every droplet finds", () => {
    const rng = createRng(77);
    let wipedTotal = 0;
    let missedTotal = 0;
    for (let round = 0; round < 300; round++) {
      const sim = empty();
      sim.staticCount = SMALL.maxStatic;
      const x0 = 200 + rng() * 1500;
      const y0 = 200 + rng() * 600;
      const x1 = x0 + (rng() - 0.5) * 200;
      const y1 = y0 + rng() * 200;
      const radius = rng() * MAX_RUNNER_R;
      // Most droplets sit near the edge of the capsule's reach, on either side of it,
      // where a grid search that misses a cell would show.
      const near = (r: number): [number, number] => {
        const t = rng();
        const a = rng() * Math.PI * 2;
        const d = (radius + r * 0.5) * (0.8 + 0.4 * rng());
        return [x0 + (x1 - x0) * t + Math.cos(a) * d, y0 + (y1 - y0) * t + Math.sin(a) * d];
      };
      for (let i = 0; i < SMALL.maxStatic; i++) {
        const r = STATIC_MIN_R + rng() * (STATIC_MAX_R - STATIC_MIN_R);
        place(sim, i, ...near(r), r);
      }
      // Trail droplets up to twice the largest static one, some still in their grace.
      for (let k = 0; k < SMALL.maxTrails; k++) {
        const r = 0.5 + rng() * (2 * STATIC_MAX_R - 0.5);
        emitTrail(sim, ...near(r), r);
        sim.dAge[SMALL.maxStatic + k] = rng() * 2 * TRAIL_GRACE;
      }

      // Brute force: every live, wipeable droplet within reach of the segment.
      const expected: number[] = [];
      const sx = x1 - x0;
      const sy = y1 - y0;
      for (let i = 0; i < sim.dKind.length; i++) {
        const kind = sim.dKind[i];
        if (kind === DEAD || (kind === TRAIL && sim.dAge[i] < TRAIL_GRACE)) {
          continue;
        }
        const px = sim.dx[i] - x0;
        const py = sim.dy[i] - y0;
        const t = Math.min(1, Math.max(0, (px * sx + py * sy) / (sx * sx + sy * sy)));
        if (Math.hypot(px - t * sx, py - t * sy) < radius + sim.dr[i] * 0.5) {
          expected.push(i);
        } else {
          missedTotal++;
        }
      }
      const before = { x: sim.dx.slice(), y: sim.dy.slice(), kind: sim.dKind.slice() };
      buildGrid(sim);
      wipeCapsule(sim, x0, y0, x1, y1, radius);
      const wiped: number[] = [];
      for (let i = 0; i < sim.dKind.length; i++) {
        const moved = sim.dx[i] !== before.x[i] || sim.dy[i] !== before.y[i];
        if (moved || sim.dKind[i] !== before.kind[i]) {
          wiped.push(i);
        }
      }
      expect(wiped).toEqual(expected);
      expect(sim.wiped).toBe(expected.length);
      wipedTotal += expected.length;
    }
    // Plenty of droplets on both sides of the reach.
    expect(wipedTotal).toBeGreaterThan(5000);
    expect(missedTotal).toBeGreaterThan(5000);
  });
});

describe("trail ring", () => {
  it("emits up to capacity, then skips while the oldest is alive", () => {
    const sim = empty();
    for (let i = 0; i < SMALL.maxTrails; i++) {
      expect(emitTrail(sim, i, 0, 1)).toBe(true);
    }
    expect(sim.trailCursor).toBe(0);
    expect(emitTrail(sim, 0, 0, 1)).toBe(false);
    expect(sim.trailsSkipped).toBe(1);
    expect(countKind(sim, TRAIL)).toBe(SMALL.maxTrails);
    // Freeing the slot under the cursor allows the next emission.
    sim.dKind[SMALL.maxStatic] = DEAD;
    expect(emitTrail(sim, 7, 8, 1)).toBe(true);
    expect(sim.dx[SMALL.maxStatic]).toBe(7);
    expect(sim.trailCursor).toBe(1);
  });

  it("does nothing with zero trail capacity", () => {
    const sim = empty({ ...SMALL, maxTrails: 0 });
    expect(emitTrail(sim, 0, 0, 1)).toBe(false);
  });

  it("trail droplets die at the end of their life", () => {
    const sim = empty();
    emitTrail(sim, 100, 100, 1);
    stepRainSim(sim, 0.1, { rain: 0, speed: 1 });
    expect(sim.dKind[SMALL.maxStatic]).toBe(TRAIL);
    for (let t = 0; t < 60; t++) {
      stepRainSim(sim, 0.1, { rain: 0, speed: 1 });
    }
    expect(sim.dKind[SMALL.maxStatic]).toBe(DEAD);
  });
});

describe("spawning", () => {
  it("activates static droplets and runners from the rain amount", () => {
    const sim = make();
    stepRainSim(sim, 1 / 60, { rain: 0.5, speed: 1 });
    expect(sim.staticCount).toBe(100);
    expect(sim.runnerCount).toBe(4);
    expect(countKind(sim, STATIC)).toBe(100);
    stepRainSim(sim, 1 / 60, { rain: 1, speed: 1 });
    expect(sim.staticCount).toBe(200);
    expect(sim.runnerCount).toBe(8);
    for (let t = 0; t < 10; t++) {
      stepRainSim(sim, 0.1, { rain: 1, speed: 1 });
    }
    expect(sim.staticFade[199]).toBe(1);
    // Less rain fades the extra slots out before they die.
    stepRainSim(sim, 0.1, { rain: 0.25, speed: 1 });
    expect(sim.staticCount).toBe(200);
    expect(sim.staticFade[49]).toBe(1);
    expect(sim.staticFade[50]).toBeCloseTo(1 - 0.1 / FADE_OUT, 5);
    expect(sim.runnerFade[2]).toBeCloseTo(1 - 0.1 / FADE_OUT, 5);
    for (let t = 0; t < 10; t++) {
      stepRainSim(sim, 0.1, { rain: 0.25, speed: 1 });
    }
    expect(sim.staticCount).toBe(50);
    expect(sim.runnerCount).toBe(2);
    expect(countKind(sim, STATIC)).toBe(50);
  });

  it("fades slots back in when the rain rises again mid fade-out", () => {
    const sim = make();
    stepRainSim(sim, 0.1, { rain: 1, speed: 1 });
    stepRainSim(sim, 0.1, { rain: 0.5, speed: 1 });
    const x = sim.dx[150];
    const faded = sim.staticFade[150];
    expect(faded).toBeLessThan(1);
    stepRainSim(sim, 0.1, { rain: 1, speed: 1 });
    // The same droplet, not a respawn, brightening again.
    expect(sim.dx[150]).toBe(x);
    expect(sim.staticFade[150]).toBeGreaterThan(faded);
  });

  it("dims fading-out drops in the written instances", () => {
    const sim = empty();
    sim.staticCount = 1;
    place(sim, 0, 10, 10);
    sim.staticFade[0] = 0.5;
    const out = new Float32Array(instanceCapacity(SMALL) * INSTANCE_STRIDE);
    expect(writeDropInstances(sim, out, 1)).toBe(1);
    expect(out[4]).toBeCloseTo(0.5, 5);
  });

  it("clamps the rain amount to capacity", () => {
    const sim = make();
    stepRainSim(sim, 1 / 60, { rain: 5, speed: 1 });
    expect(sim.staticCount).toBe(SMALL.maxStatic);
    expect(sim.runnerCount).toBe(SMALL.maxRunners);
    for (let t = 0; t < 10; t++) {
      stepRainSim(sim, 0.1, { rain: -1, speed: 1 });
    }
    expect(sim.staticCount).toBe(0);
    expect(sim.runnerCount).toBe(0);
    expect(countKind(sim, STATIC)).toBe(0);
  });

  it("starts the first fill mid-life, later additions fade in", () => {
    const sim = make();
    stepRainSim(sim, 0, { rain: 0.5, speed: 1 });
    const ages = Array.from(sim.dAge.subarray(0, 100));
    expect(ages.filter((a) => a > 0).length).toBeGreaterThan(90);
    stepRainSim(sim, 0, { rain: 1, speed: 1 });
    expect(Array.from(sim.dAge.subarray(100, 200)).every((a) => a === 0)).toBe(true);
  });

  it("keeps the mid-life first fill for when rain first rises from 0", () => {
    const sim = make();
    for (let t = 0; t < 5; t++) {
      stepRainSim(sim, 0.1, { rain: 0, speed: 1 });
    }
    expect(sim.primed).toBe(false);
    stepRainSim(sim, 0, { rain: 0.5, speed: 1 });
    const ages = Array.from(sim.dAge.subarray(0, 100));
    expect(ages.filter((a) => a > 0).length).toBeGreaterThan(90);
    expect(sim.primed).toBe(true);
  });

  it("keeps droplets, trails and runners in and around the window", () => {
    const sim = make();
    const out: string[] = [];
    let trails = 0;
    let running = 0;
    for (let t = 0; t < 600; t++) {
      stepRainSim(sim, 1 / 30, { rain: 1, speed: 3 });
      for (let i = 0; i < sim.staticCount; i++) {
        const { dx, dy } = sim;
        if (sim.dKind[i] === STATIC && (dx[i] < 0 || dx[i] > 1920 || dy[i] < 0 || dy[i] > 1080)) {
          out.push(`static ${String(i)} at ${String(dx[i])}, ${String(dy[i])}`);
        }
      }
      // Trails are left just above a runner, which may hang off the bottom edge
      // by up to two radii before it respawns.
      for (let i = SMALL.maxStatic; i < sim.dKind.length; i++) {
        if (sim.dKind[i] !== TRAIL) {
          continue;
        }
        trails++;
        const { dx, dy } = sim;
        if (dx[i] < -MAX_RUNNER_R || dx[i] > 1920 + MAX_RUNNER_R) {
          out.push(`trail x ${String(dx[i])}`);
        }
        if (dy[i] < -MAX_RUNNER_R || dy[i] > 1080 + 3 * MAX_RUNNER_R) {
          out.push(`trail y ${String(dy[i])}`);
        }
      }
      for (let i = 0; i < sim.runnerCount; i++) {
        if (sim.rState[i] === RUNNING) {
          running++;
        }
        if (sim.rx[i] < 0 || sim.rx[i] > 1920) {
          out.push(`runner x ${String(sim.rx[i])}`);
        }
        if (sim.ry[i] < 0 || sim.ry[i] > 1080 + 3 * MAX_RUNNER_R) {
          out.push(`runner y ${String(sim.ry[i])}`);
        }
      }
    }
    expect(out).toEqual([]);
    expect(trails).toBeGreaterThan(1000);
    expect(running).toBeGreaterThan(100);
  });

  it("respawns static droplets when their life ends", () => {
    const sim = empty();
    sim.staticCount = 1;
    place(sim, 0, 50, 50);
    sim.dAge[0] = 9.95;
    stepRainSim(sim, 0.1, { rain: 1 / SMALL.maxStatic, speed: 1 });
    expect(sim.dAge[0]).toBe(0);
    expect(sim.dKind[0]).toBe(STATIC);
  });

  it("is deterministic for a given seed", () => {
    const a = make(SMALL, 42);
    const b = make(SMALL, 42);
    for (let t = 0; t < 100; t++) {
      stepRainSim(a, 1 / 30, { rain: 0.7, speed: 1.5 });
      stepRainSim(b, 1 / 30, { rain: 0.7, speed: 1.5 });
    }
    expect(Array.from(a.rx)).toEqual(Array.from(b.rx));
    expect(Array.from(a.dx)).toEqual(Array.from(b.dx));
  });
});

describe("runners", () => {
  /** One runner at (x, y), radius r, in the given state. */
  const oneRunner = (x: number, y: number, r: number, state: number) => {
    const sim = empty();
    sim.runnerCount = 1;
    spawnRunner(sim, 0);
    sim.rx[0] = x;
    sim.ry[0] = y;
    sim.rr[0] = r;
    sim.rState[0] = state;
    // Keep the runner count at 1 under step's rain-based target.
    return { sim, params: { rain: 1 / SMALL.maxRunners, speed: 1 } };
  };

  it("resting drops grow until they break loose", () => {
    const { sim, params } = oneRunner(500, 100, 5, RESTING);
    params.rain = 0.125; // 1 runner, 25 static droplets
    sim.rBreak[0] = 8;
    let t = 0;
    while (sim.rState[0] === RESTING && t < 200) {
      stepRainSim(sim, 0.1, params);
      t++;
    }
    expect(sim.rState[0]).toBe(RUNNING);
    expect(sim.rr[0]).toBeGreaterThanOrEqual(8);
  });

  it("does not break loose at zero speed", () => {
    const { sim } = oneRunner(500, 100, 9, RESTING);
    sim.rBreak[0] = 9;
    for (let t = 0; t < 50; t++) {
      stepRainSim(sim, 0.1, { rain: 0.125, speed: 0 });
    }
    expect(sim.rState[0]).toBe(RESTING);
    expect(sim.ry[0]).toBe(100);
  });

  it("running drops fall, stay in the window horizontally and leave trails", () => {
    const { sim } = oneRunner(1910, 100, 16, RUNNING);
    let lastY = sim.ry[0];
    for (let t = 0; t < 30; t++) {
      stepRainSim(sim, 0.05, { rain: 0.125, speed: 1 });
      expect(sim.ry[0]).toBeGreaterThanOrEqual(lastY);
      expect(sim.rx[0]).toBeLessThanOrEqual(1920);
      lastY = sim.ry[0];
    }
    expect(lastY).toBeGreaterThan(100);
    expect(countKind(sim, TRAIL)).toBeGreaterThan(0);
    const trailYs = Array.from(sim.dy).filter((_, i) => sim.dKind[i] === TRAIL);
    expect(Math.max(...trailYs)).toBeLessThan(sim.ry[0]);
  });

  it("sways slowly from side to side rather than zigzagging", () => {
    const { sim } = oneRunner(960, 0, 40, RUNNING);
    sim.rPhase[0] = 0;
    const reversals: number[] = [];
    let lastStep = 0;
    let xMin = sim.rx[0];
    let xMax = sim.rx[0];
    let fallen = 0;
    for (let t = 0; t < 4000; t++) {
      sim.rr[0] = 40; // Keep it running: trail losses would otherwise stop it.
      // Lift it back up before it leaves the bottom (and respawns elsewhere), so
      // it falls several wavelengths.
      if (sim.ry[0] > 800) {
        sim.ry[0] -= 700;
      }
      stepRainSim(sim, 0.02, { rain: 0.125, speed: 1 });
      expect(sim.rState[0]).toBe(RUNNING);
      fallen += sim.rStepY[0];
      const step = sim.rStepX[0];
      if (step !== 0 && lastStep !== 0 && Math.sign(step) !== Math.sign(lastStep)) {
        reversals.push(fallen);
      }
      if (step !== 0) {
        lastStep = step;
      }
      xMin = Math.min(xMin, sim.rx[0]);
      xMax = Math.max(xMax, sim.rx[0]);
    }
    expect(reversals.length).toBeGreaterThanOrEqual(4);
    const gaps = reversals.slice(1).map((y, i) => y - reversals[i]);
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // Reversals come every half wavelength of fall.
    expect(meanGap).toBeGreaterThan(WIGGLE_WAVELENGTH / 4);
    // Peak excursion is about WIGGLE * wavelength / 2pi (~4 px) either side.
    expect(xMax - xMin).toBeLessThan(15);
  });

  it("wipes static droplets in its path", () => {
    const { sim } = oneRunner(500, 100, 16, RUNNING);
    sim.rx[0] = 500;
    sim.rPhase[0] = 0;
    // Droplets straight below; capacity 25 at rain 0.125, so place in active slots.
    for (let i = 0; i < 10; i++) {
      place(sim, i, 500, 130 + i * 6);
    }
    sim.staticCount = 25;
    for (let i = 10; i < 25; i++) {
      place(sim, i, 1500, 900);
    }
    for (let t = 0; t < 40; t++) {
      stepRainSim(sim, 0.05, { rain: 0.125, speed: 2 });
    }
    expect(sim.ry[0]).toBeGreaterThan(200);
    expect(sim.wiped).toBeGreaterThanOrEqual(10);
    // Far droplets untouched (still mid-life, as placed).
    expect(sim.dx[24]).toBe(1500);
  });

  it("absorbs resting runners it runs into", () => {
    const sim = empty();
    sim.runnerCount = 2;
    spawnRunner(sim, 0);
    spawnRunner(sim, 1);
    sim.rx[0] = 500;
    sim.ry[0] = 100;
    sim.rr[0] = 15;
    sim.rState[0] = RUNNING;
    sim.rv[0] = 100;
    sim.rx[1] = 500;
    sim.ry[1] = 106;
    sim.rr[1] = 8;
    sim.rBreak[1] = 50;
    const before = 15 ** 3 + 8 ** 3;
    stepRainSim(sim, 0.05, { rain: 2 / SMALL.maxRunners, speed: 1 });
    // The resting drop respawned elsewhere; the runner gained most of its volume.
    expect(sim.rx[1] !== 500 || sim.ry[1] !== 106).toBe(true);
    expect(sim.rAge[1]).toBeLessThan(0.06);
    expect(sim.rr[0] ** 3).toBeGreaterThan(before * 0.9);
    expect(sim.rr[0]).toBeLessThanOrEqual(MAX_RUNNER_R);
  });

  it("leaves trail droplets no larger than wipes are sure to reach", () => {
    // A full-size runner swallowing every other runner, all fully grown, at once:
    // the most volume one step can gather.
    const sim = empty();
    sim.runnerCount = SMALL.maxRunners;
    for (let i = 0; i < SMALL.maxRunners; i++) {
      spawnRunner(sim, i);
      sim.rx[i] = 500;
      sim.ry[i] = 101;
      sim.rr[i] = 18;
      sim.rBreak[i] = 50;
    }
    sim.rr[0] = MAX_RUNNER_R;
    sim.rState[0] = RUNNING;
    sim.rv[0] = 300;
    sim.rTravel[0] = 0;
    stepRainSim(sim, 0.1, { rain: 1, speed: 3 });
    const trails = Array.from(sim.dr.subarray(SMALL.maxStatic)).filter(
      (_, k) => sim.dKind[SMALL.maxStatic + k] === TRAIL,
    );
    expect(trails.length).toBeGreaterThan(0);
    // wipeCapsule searches cells STATIC_MAX_R beyond the capsule and wipes within
    // half a droplet's radius, so droplets up to twice STATIC_MAX_R are found.
    expect(Math.max(...trails)).toBeLessThanOrEqual(MAX_TRAIL_R);
    expect(MAX_TRAIL_R).toBeLessThanOrEqual(2 * STATIC_MAX_R);
  });

  it("respawns runners that leave the bottom", () => {
    const { sim } = oneRunner(500, 1075, 20, RUNNING);
    sim.rv[0] = 200;
    for (let t = 0; t < 10; t++) {
      stepRainSim(sim, 0.1, { rain: 0.125, speed: 3 });
    }
    // Either respawned resting, or (if it broke loose again) well above the bottom edge.
    expect(sim.ry[0]).toBeLessThan(1080);
  });

  it("brings a running drop to a halt, and keeps it there, at speed 0", () => {
    const { sim, params } = oneRunner(500, 100, 14, RUNNING);
    for (let t = 0; t < 30; t++) {
      stepRainSim(sim, 1 / 60, params);
    }
    const v = sim.rv[0];
    expect(v).toBeGreaterThan(10);
    params.speed = 0;
    const y0 = sim.ry[0];
    for (let t = 0; t < 60; t++) {
      stepRainSim(sim, 1 / 60, params);
    }
    // The fall eases out at a rate of 4/s, so it coasts at most v / 4 further...
    expect(sim.ry[0] - y0).toBeLessThanOrEqual(v / 4 + 1e-3);
    // ...and after that second has all but stopped, never to start again.
    const y1 = sim.ry[0];
    const x1 = sim.rx[0];
    for (let t = 0; t < 600; t++) {
      stepRainSim(sim, 1 / 60, params);
    }
    expect(sim.ry[0] - y1).toBeLessThan(0.5);
    expect(Math.abs(sim.rx[0] - x1)).toBeLessThan(0.5);
    expect(sim.rv[0]).toBeLessThan(0.01);
  });

  it("does not let a resting drop at speed 0 break loose, even fully grown", () => {
    const { sim, params } = oneRunner(500, 100, 20, RESTING);
    sim.rBreak[0] = 12;
    params.speed = 0;
    for (let t = 0; t < 100; t++) {
      stepRainSim(sim, 0.1, params);
    }
    expect(sim.rState[0]).toBe(RESTING);
    expect(sim.ry[0]).toBe(100);
  });

  it("small runners stop", () => {
    const { sim } = oneRunner(500, 100, 7.05, RUNNING);
    sim.rv[0] = 50;
    for (let t = 0; t < 100 && sim.rState[0] === RUNNING; t++) {
      stepRainSim(sim, 0.05, { rain: 0.125, speed: 1 });
    }
    expect(sim.rState[0]).toBe(RESTING);
  });
});

describe("lowering the rain", () => {
  it("fades the runners it no longer wants out, then stops stepping and drawing them", () => {
    const sim = make();
    for (let t = 0; t < 600; t++) {
      stepRainSim(sim, 1 / 30, { rain: 1, speed: 1.5 });
    }
    expect(sim.runnerCount).toBe(SMALL.maxRunners);
    const kept = Math.round(0.25 * SMALL.maxRunners);
    stepRainSim(sim, 1 / 30, { rain: 0.25, speed: 1.5 });
    // Still simulated while they fade.
    expect(sim.runnerCount).toBe(SMALL.maxRunners);
    expect(sim.runnerFade[kept]).toBeLessThan(1);
    expect(sim.runnerFade[0]).toBe(1);
    for (let t = 0; t < Math.ceil((FADE_OUT / (1 / 30)) * 1.1); t++) {
      stepRainSim(sim, 1 / 30, { rain: 0.25, speed: 1.5 });
    }
    expect(sim.runnerCount).toBe(kept);
    // Frozen where they were: no longer stepped.
    const ry = sim.ry.slice(kept);
    for (let t = 0; t < 30; t++) {
      stepRainSim(sim, 1 / 30, { rain: 0.25, speed: 1.5 });
    }
    expect(sim.ry.slice(kept)).toEqual(ry);
    const out = new Float32Array(instanceCapacity(SMALL) * INSTANCE_STRIDE);
    writeDropInstances(sim, out, 1);
    expect(sim.runnersWritten).toBeLessThanOrEqual(kept);
  });

  it("fades out and drops the static droplets it no longer wants", () => {
    const sim = make();
    for (let t = 0; t < 60; t++) {
      stepRainSim(sim, 1 / 30, { rain: 1, speed: 1 });
    }
    for (let t = 0; t < 60; t++) {
      stepRainSim(sim, 1 / 30, { rain: 0.5, speed: 1 });
    }
    expect(sim.staticCount).toBe(SMALL.maxStatic / 2);
    expect(countKind(sim, STATIC)).toBe(SMALL.maxStatic / 2);
  });
});

describe("capacity", () => {
  it("never exceeds the trail ring under heavy rain", () => {
    const sim = make({ ...SMALL, maxRunners: 32, maxTrails: 50 });
    for (let t = 0; t < 400; t++) {
      stepRainSim(sim, 0.05, { rain: 1, speed: 3 });
    }
    expect(countKind(sim, TRAIL)).toBeLessThanOrEqual(50);
    expect(sim.trailsSkipped).toBeGreaterThan(0);
    // Static slots never hold trails, and vice versa.
    for (let i = 0; i < SMALL.maxStatic; i++) {
      expect(sim.dKind[i]).not.toBe(TRAIL);
    }
    for (let i = SMALL.maxStatic; i < sim.dKind.length; i++) {
      expect(sim.dKind[i]).not.toBe(STATIC);
    }
  });

  it("keeps runner radii within bounds", () => {
    const sim = make({ ...SMALL, maxStatic: 3000, maxRunners: 32 });
    let firstBad: { t: number; i: number; r: number } | undefined;
    for (let t = 0; t < 400; t++) {
      stepRainSim(sim, 0.05, { rain: 1, speed: 2 });
      for (let i = 0; i < sim.runnerCount; i++) {
        const r = sim.rr[i];
        if (!firstBad && !(r <= MAX_RUNNER_R && r > 0)) {
          firstBad = { t, i, r };
        }
      }
    }
    expect(firstBad).toBeUndefined();
  });

  it("writes at most instanceCapacity instances, runners last", () => {
    const sim = make();
    const out = new Float32Array(instanceCapacity(SMALL) * INSTANCE_STRIDE);
    for (let t = 0; t < 100; t++) {
      stepRainSim(sim, 0.05, { rain: 1, speed: 2 });
    }
    const n = writeDropInstances(sim, out, 2);
    expect(n).toBeLessThanOrEqual(instanceCapacity(SMALL));
    expect(sim.runnersWritten).toBe(SMALL.maxRunners);
    expect(sim.runnerFirst).toBe(n - SMALL.maxRunners);
    const r0 = sim.runnerFirst * INSTANCE_STRIDE;
    expect(out[r0]).toBeCloseTo(sim.rx[0] * 2, 3);
    expect(out[r0 + 1]).toBeCloseTo(sim.ry[0] * 2, 3);
    expect(out[r0 + 2]).toBeCloseTo(sim.rr[0] * 2, 3);
    // Invisible droplets are skipped; runners are always written, and one that
    // respawned this step (left the bottom) is still at fade 0.
    for (let i = 0; i < n; i++) {
      const f = out[i * INSTANCE_STRIDE + 4];
      expect(f).toBeGreaterThanOrEqual(i < sim.runnerFirst ? Number.EPSILON : 0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it("skips inactive and invisible droplets when writing", () => {
    const sim = empty();
    sim.staticCount = 2;
    place(sim, 0, 10, 10);
    place(sim, 1, 20, 10);
    sim.dAge[1] = 0; // just spawned: invisible
    place(sim, 5, 30, 10); // beyond staticCount: inactive
    const out = new Float32Array(instanceCapacity(SMALL) * INSTANCE_STRIDE);
    expect(writeDropInstances(sim, out, 1)).toBe(1);
    expect(out[0]).toBe(10);
    expect(sim.runnerFirst).toBe(1);
  });
});

describe("helpers", () => {
  it("fades static droplets in and out, trails out", () => {
    expect(dropletFade(STATIC, 0, 10)).toBe(0);
    expect(dropletFade(STATIC, 5, 10)).toBe(1);
    expect(dropletFade(STATIC, 10, 10)).toBe(0);
    expect(dropletFade(STATIC, 1, 10)).toBeCloseTo(0.5, 5);
    expect(dropletFade(TRAIL, 0, 4)).toBe(1);
    expect(dropletFade(TRAIL, 2, 4)).toBeCloseTo(0.25, 5);
    expect(dropletFade(DEAD, 2, 4)).toBe(0);
  });

  it("stretches running drops with speed, up to 1.5", () => {
    expect(runnerStretch(RESTING, 500)).toBe(1);
    expect(runnerStretch(RUNNING, 0)).toBe(1);
    expect(runnerStretch(RUNNING, 75)).toBeCloseTo(1.25, 5);
    expect(runnerStretch(RUNNING, 1e4)).toBe(1.5);
  });

  it("rescales positions and the grid on resize", () => {
    const sim = empty();
    place(sim, 0, 960, 540);
    sim.rx[0] = 1920;
    resizeRainSim(sim, 960, 1080);
    expect(sim.dx[0]).toBe(480);
    expect(sim.dy[0]).toBe(540);
    expect(sim.rx[0]).toBe(960);
    expect(sim.cols).toBe(60);
    const head = sim.head;
    resizeRainSim(sim, 960, 1080);
    expect(sim.head).toBe(head);
  });

  it("keeps every drop in bounds across resizes, down to a 1x1 window", () => {
    const sim = make();
    const params = { rain: 1, speed: 2 };
    for (const [w, h] of [
      [1920, 1080],
      [800, 1200],
      [3000, 400],
      [0, 0],
      [1, 1],
      [640, 360],
    ]) {
      for (let t = 0; t < 60; t++) {
        stepRainSim(sim, 1 / 30, params);
      }
      resizeRainSim(sim, w, h);
      const W = Math.max(1, w);
      const H = Math.max(1, h);
      expect([sim.width, sim.height]).toEqual([W, H]);
      expect(sim.cols).toBe(Math.max(1, Math.ceil(W / SMALL.cellSize)));
      expect(sim.rows).toBe(Math.max(1, Math.ceil(H / SMALL.cellSize)));
      expect(sim.head.length).toBe(sim.cols * sim.rows);
      for (let i = 0; i < sim.staticCount; i++) {
        expect(sim.dx[i]).toBeGreaterThanOrEqual(0);
        expect(sim.dx[i]).toBeLessThanOrEqual(W + 1e-3);
        expect(sim.dy[i]).toBeGreaterThanOrEqual(0);
        expect(sim.dy[i]).toBeLessThanOrEqual(H + 1e-3);
      }
      for (let i = 0; i < sim.runnerCount; i++) {
        expect(sim.rx[i]).toBeGreaterThanOrEqual(0);
        expect(sim.rx[i]).toBeLessThanOrEqual(W + 1e-3);
        expect(sim.rStepX[i]).toBe(0);
        expect(sim.rStepY[i]).toBe(0);
      }
      // The grid still lists every live droplet once.
      buildGrid(sim);
      let listed = 0;
      for (const first of sim.head) {
        for (let i = first; i !== -1; i = sim.next[i]) {
          listed++;
        }
      }
      expect(listed).toBe(sim.dKind.length - countKind(sim, DEAD));
    }
  });

  it("clamps long steps", () => {
    const { sim } = (() => {
      const s = empty();
      s.runnerCount = 1;
      spawnRunner(s, 0);
      s.rx[0] = 500;
      s.ry[0] = 100;
      s.rr[0] = 16;
      s.rState[0] = RUNNING;
      s.rv[0] = 100;
      return { sim: s };
    })();
    stepRainSim(sim, 10, { rain: 0.125, speed: 1 });
    expect(sim.ry[0]).toBeLessThan(150);
  });
});

describe("writeWipeStamps", () => {
  /** One running drop at (x, y), radius r, that last moved by (sx, sy). */
  const setup = (sx: number, sy: number, r = 10) => {
    const sim = empty();
    sim.runnerCount = 1;
    spawnRunner(sim, 0);
    sim.rx[0] = 500;
    sim.ry[0] = 300;
    sim.rr[0] = r;
    sim.rAge[0] = 10;
    sim.rState[0] = RUNNING;
    sim.rv[0] = 200;
    sim.rStepX[0] = sx;
    sim.rStepY[0] = sy;
    const out = new Float32Array(
      (instanceCapacity(SMALL) + wipeStampCapacity(SMALL)) * INSTANCE_STRIDE,
    );
    const n = writeDropInstances(sim, out, 2);
    return { sim, out, n };
  };

  it("writes nothing for a step within the spacing", () => {
    const { sim, out, n } = setup(0, 5);
    expect(writeWipeStamps(sim, out, 2, n, 0.5)).toBe(0);
  });

  it("fills a long step with evenly spaced copies of the runner", () => {
    // 60 units at most 5 apart would need 12 intervals; capped at MAX_WIPE_STAMPS + 1
    // = 9, with the runner and the last frame's position at the ends.
    expect(MAX_WIPE_STAMPS).toBe(8);
    const { sim, out, n } = setup(0, 60);
    const k = writeWipeStamps(sim, out, 2, n, 0.5);
    expect(k).toBe(MAX_WIPE_STAMPS);
    const runner = sim.runnerFirst * INSTANCE_STRIDE;
    let lastY = out[runner + 1];
    for (let i = 0; i < k; i++) {
      const o = (n + i) * INSTANCE_STRIDE;
      expect(out[o]).toBeCloseTo(1000, 3);
      expect(lastY - out[o + 1]).toBeCloseTo((60 / 9) * 2, 3);
      lastY = out[o + 1];
      for (let c = 2; c < 5; c++) {
        expect(out[o + c]).toBe(out[runner + c]);
      }
    }
    // The last stamp stops one interval short of where the runner was.
    expect(lastY).toBeCloseTo((300 - 60 + 60 / 9) * 2, 3);
  });

  it("spaces stamps at most `spacing` radii apart below the cap", () => {
    const { sim, out, n } = setup(9, 12); // 15 units, 5 apart: 3 intervals
    expect(writeWipeStamps(sim, out, 1, n, 0.5)).toBe(2);
  });

  it("records each runner's step, and none after a respawn", () => {
    const sim = empty();
    sim.runnerCount = 1;
    spawnRunner(sim, 0);
    sim.ry[0] = 100;
    sim.rr[0] = 16;
    sim.rState[0] = RUNNING;
    const y0 = sim.ry[0];
    const x0 = sim.rx[0];
    stepRainSim(sim, 0.1, { rain: 1 / SMALL.maxRunners, speed: 3 });
    expect(sim.rStepY[0]).toBeCloseTo(sim.ry[0] - y0, 3);
    expect(sim.rStepX[0]).toBeCloseTo(sim.rx[0] - x0, 3);
    expect(sim.rStepY[0]).toBeGreaterThan(0);
    spawnRunner(sim, 0);
    expect([sim.rStepX[0], sim.rStepY[0]]).toEqual([0, 0]);
  });

  it("follows the runners directly, so the fog wipe draws only runners and their stamps", () => {
    // The effect wipes the fog with one draw of instances runnerFirst onwards,
    // runnersWritten + stamps long: runners must be the last drops written and
    // the stamps must start right after them.
    const sim = make();
    const cap = instanceCapacity(SMALL) + wipeStampCapacity(SMALL);
    const out = new Float32Array(cap * INSTANCE_STRIDE);
    for (let t = 0; t < 40; t++) {
      stepRainSim(sim, 0.1, { rain: 1, speed: 3 });
    }
    const n = writeDropInstances(sim, out, 1);
    const k = writeWipeStamps(sim, out, 1, n, 0.5);
    expect(sim.runnersWritten).toBeGreaterThan(0);
    expect(sim.runnerFirst + sim.runnersWritten).toBe(n);
    const radii = new Set(
      Array.from({ length: sim.runnersWritten }, (_, i) => Math.fround(sim.rr[i])),
    );
    for (let i = sim.runnerFirst; i < n + k; i++) {
      expect(radii.has(out[i * INSTANCE_STRIDE + 2])).toBe(true);
    }
    for (let r = 0; r < sim.runnersWritten; r++) {
      const o = (sim.runnerFirst + r) * INSTANCE_STRIDE;
      expect([out[o], out[o + 1]]).toEqual([Math.fround(sim.rx[r]), Math.fround(sim.ry[r])]);
    }
    // Everything before is a static droplet or trail, none of them a runner.
    for (let i = 0; i < sim.runnerFirst; i++) {
      expect(out[i * INSTANCE_STRIDE + 2]).toBeLessThanOrEqual(Math.max(STATIC_MAX_R, MAX_TRAIL_R));
    }
  });

  it("stamps fast runners at a low frame rate, within capacity", () => {
    const sim = make();
    const cap = instanceCapacity(SMALL) + wipeStampCapacity(SMALL);
    const out = new Float32Array(cap * INSTANCE_STRIDE);
    for (let t = 0; t < 40; t++) {
      stepRainSim(sim, 0.1, { rain: 1, speed: 3 });
    }
    const n = writeDropInstances(sim, out, 1);
    const k = writeWipeStamps(sim, out, 1, n, 0.5);
    expect(k).toBeGreaterThan(0);
    expect(n + k).toBeLessThanOrEqual(cap);
  });
});
