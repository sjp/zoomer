import { describe, expect, it } from "vitest";
import { FADE_OUT } from "./fade";
import { createRng } from "./noise";
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
  RESTING,
  RUNNING,
  resizeRainSim,
  runnerStretch,
  spawnRunner,
  STATIC,
  stepRainSim,
  TRAIL,
  TRAIL_GRACE,
  wipeCapsule,
  writeDropInstances,
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
      for (let i = sim.head[c]; i !== -1; i = sim.next[i]) out.push(i);
      return out.sort();
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

  it("only visits nearby cells", () => {
    const sim = empty();
    for (let i = 0; i < 100; i++)
      place(sim, i, 1000 + (i % 10) * 20, 500 + Math.floor(i / 10) * 20);
    buildGrid(sim);
    expect(wipeCapsule(sim, 100, 100, 100, 300, 20)).toBe(0);
    expect(sim.wiped).toBe(0);
  });
});

describe("trail ring", () => {
  it("emits up to capacity, then skips while the oldest is alive", () => {
    const sim = empty();
    for (let i = 0; i < SMALL.maxTrails; i++) expect(emitTrail(sim, i, 0, 1)).toBe(true);
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
    for (let t = 0; t < 60; t++) stepRainSim(sim, 0.1, { rain: 0, speed: 1 });
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
    for (let t = 0; t < 10; t++) stepRainSim(sim, 0.1, { rain: 1, speed: 1 });
    expect(sim.staticFade[199]).toBe(1);
    // Less rain fades the extra slots out before they die.
    stepRainSim(sim, 0.1, { rain: 0.25, speed: 1 });
    expect(sim.staticCount).toBe(200);
    expect(sim.staticFade[49]).toBe(1);
    expect(sim.staticFade[50]).toBeCloseTo(1 - 0.1 / FADE_OUT, 5);
    expect(sim.runnerFade[2]).toBeCloseTo(1 - 0.1 / FADE_OUT, 5);
    for (let t = 0; t < 10; t++) stepRainSim(sim, 0.1, { rain: 0.25, speed: 1 });
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
    for (let t = 0; t < 10; t++) stepRainSim(sim, 0.1, { rain: -1, speed: 1 });
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
    for (let t = 0; t < 5; t++) stepRainSim(sim, 0.1, { rain: 0, speed: 1 });
    expect(sim.primed).toBe(false);
    stepRainSim(sim, 0, { rain: 0.5, speed: 1 });
    const ages = Array.from(sim.dAge.subarray(0, 100));
    expect(ages.filter((a) => a > 0).length).toBeGreaterThan(90);
    expect(sim.primed).toBe(true);
  });

  it("keeps droplets inside the window", () => {
    const sim = make();
    for (let t = 0; t < 300; t++) stepRainSim(sim, 0.1, { rain: 1, speed: 2 });
    for (let i = 0; i < sim.staticCount; i++) {
      expect(sim.dx[i]).toBeGreaterThanOrEqual(0);
      expect(sim.dx[i]).toBeLessThanOrEqual(1920);
      expect(sim.dy[i]).toBeGreaterThanOrEqual(0);
      expect(sim.dy[i]).toBeLessThanOrEqual(1080);
    }
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
    for (let t = 0; t < 50; t++) stepRainSim(sim, 0.1, { rain: 0.125, speed: 0 });
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

  it("wipes static droplets in its path", () => {
    const { sim } = oneRunner(500, 100, 16, RUNNING);
    sim.rx[0] = 500;
    sim.rPhase[0] = 0;
    // Droplets straight below; capacity 25 at rain 0.125, so place in active slots.
    for (let i = 0; i < 10; i++) place(sim, i, 500, 130 + i * 6);
    sim.staticCount = 25;
    for (let i = 10; i < 25; i++) place(sim, i, 1500, 900);
    for (let t = 0; t < 40; t++) stepRainSim(sim, 0.05, { rain: 0.125, speed: 2 });
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

  it("respawns runners that leave the bottom", () => {
    const { sim } = oneRunner(500, 1075, 20, RUNNING);
    sim.rv[0] = 200;
    for (let t = 0; t < 10; t++) stepRainSim(sim, 0.1, { rain: 0.125, speed: 3 });
    // Either respawned resting, or (if it broke loose again) well above the bottom edge.
    expect(sim.ry[0]).toBeLessThan(1080);
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

describe("capacity", () => {
  it("never exceeds the trail ring under heavy rain", () => {
    const sim = make({ ...SMALL, maxRunners: 32, maxTrails: 50 });
    for (let t = 0; t < 400; t++) stepRainSim(sim, 0.05, { rain: 1, speed: 3 });
    expect(countKind(sim, TRAIL)).toBeLessThanOrEqual(50);
    expect(sim.trailsSkipped).toBeGreaterThan(0);
    // Static slots never hold trails, and vice versa.
    for (let i = 0; i < SMALL.maxStatic; i++) expect(sim.dKind[i]).not.toBe(TRAIL);
    for (let i = SMALL.maxStatic; i < sim.dKind.length; i++) expect(sim.dKind[i]).not.toBe(STATIC);
  });

  it("keeps runner radii within bounds", () => {
    const sim = make({ ...SMALL, maxStatic: 3000, maxRunners: 32 });
    for (let t = 0; t < 400; t++) {
      stepRainSim(sim, 0.05, { rain: 1, speed: 2 });
      for (let i = 0; i < sim.runnerCount; i++) {
        expect(sim.rr[i]).toBeLessThanOrEqual(MAX_RUNNER_R);
        expect(sim.rr[i]).toBeGreaterThan(0);
      }
    }
  });

  it("writes at most instanceCapacity instances, runners last", () => {
    const sim = make();
    const out = new Float32Array(instanceCapacity(SMALL) * INSTANCE_STRIDE);
    for (let t = 0; t < 100; t++) stepRainSim(sim, 0.05, { rain: 1, speed: 2 });
    const n = writeDropInstances(sim, out, 2);
    expect(n).toBeLessThanOrEqual(instanceCapacity(SMALL));
    expect(sim.runnersWritten).toBe(SMALL.maxRunners);
    expect(sim.runnerFirst).toBe(n - SMALL.maxRunners);
    const r0 = sim.runnerFirst * INSTANCE_STRIDE;
    expect(out[r0]).toBeCloseTo(sim.rx[0] * 2, 3);
    expect(out[r0 + 1]).toBeCloseTo(sim.ry[0] * 2, 3);
    expect(out[r0 + 2]).toBeCloseTo(sim.rr[0] * 2, 3);
    for (let i = 0; i < n; i++) {
      const f = out[i * INSTANCE_STRIDE + 4];
      expect(f).toBeGreaterThan(0);
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
