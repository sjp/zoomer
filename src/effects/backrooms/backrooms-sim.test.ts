import { describe, expect, it } from "vitest";
import { DIR_X, DIR_Y, EASE_PEAK, SEG_TURN, SEG_WALK } from "../grid-walk";
import { MAX_PATTERN_HZ } from "../motion-limits";
import { MAX_SPEED, MIN_SPEED } from "./backrooms.meta";
import {
  advanceFlicker,
  advanceWalker,
  cellKind,
  CHUNK,
  createFlicker,
  createWalker,
  createWorld,
  edgeDoors,
  fillWindow,
  flickerLevel,
  isOpen,
  MAX_FLICKERS,
  OPEN,
  PANEL_DEAD,
  PANEL_LIT,
  PANEL_NONE,
  panelAt,
  PATTERN_PERIOD,
  PILLAR,
  REF_DISTANCE,
  reseedWorld,
  resetWalker,
  turnSeconds,
  VIEW_REACH,
  WALL,
  walkSeconds,
  WINDOW,
  windowOrigin,
  type World,
} from "./backrooms-sim";

const SEEDS = [0, 1, 2, 3, 7, 42, 123, 500, 999];
/** Chunks -R..R on each axis. */
const R = 3;
const LO = -R * CHUNK;
const HI = (R + 1) * CHUNK;

const openWays = (world: World, x: number, y: number) => {
  let n = 0;
  for (let d = 0; d < 4; d++) {
    n += isOpen(world, x + DIR_X[d], y + DIR_Y[d]) ? 1 : 0;
  }
  return n;
};

describe("world", () => {
  it.each(SEEDS)("has no dead ends: every open cell has two open neighbours (seed %d)", (seed) => {
    const world = createWorld(seed);
    const bad: string[] = [];
    let open = 0;
    for (let y = LO; y < HI; y++) {
      for (let x = LO; x < HI; x++) {
        if (isOpen(world, x, y)) {
          open++;
          if (openWays(world, x, y) < 2) {
            bad.push(`${String(x)},${String(y)}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
    // Mostly floor: a jumble of rooms, not a solid block.
    expect(open / ((HI - LO) * (HI - LO))).toBeGreaterThan(0.45);
  });

  it.each(SEEDS)("connects every open cell in a block of chunks (seed %d)", (seed) => {
    const world = createWorld(seed);
    const side = HI - LO;
    const seen = new Uint8Array(side * side);
    const queue: number[] = [];
    const walker = createWalker();
    resetWalker(walker, world);
    const start = (walker.cy - LO) * side + (walker.cx - LO);
    seen[start] = 1;
    queue.push(start);
    while (queue.length > 0) {
      const c = queue.pop() ?? 0;
      const x = (c % side) + LO;
      const y = Math.floor(c / side) + LO;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIR_X[d];
        const ny = y + DIR_Y[d];
        if (nx < LO || ny < LO || nx >= HI || ny >= HI || !isOpen(world, nx, ny)) {
          continue;
        }
        const n = (ny - LO) * side + (nx - LO);
        if (seen[n] === 0) {
          seen[n] = 1;
          queue.push(n);
        }
      }
    }
    let unreached = 0;
    for (let y = LO; y < HI; y++) {
      for (let x = LO; x < HI; x++) {
        unreached += isOpen(world, x, y) && seen[(y - LO) * side + (x - LO)] === 0 ? 1 : 0;
      }
    }
    expect(unreached).toBe(0);
  });

  it("opens every doorway onto floor on both sides", () => {
    for (const seed of SEEDS) {
      const world = createWorld(seed);
      for (let cy = -R; cy <= R; cy++) {
        for (let cx = -R; cx <= R; cx++) {
          for (const axis of [0, 1]) {
            const mask = edgeDoors(world.seed, cx, cy, axis);
            expect(mask & 0xfe).toBeGreaterThan(0);
            expect(mask & ~0xfe).toBe(0);
            for (let p = 1; p < CHUNK; p++) {
              if (((mask >> p) & 1) === 0) {
                continue;
              }
              const x = cx * CHUNK + (axis === 0 ? 0 : p);
              const y = cy * CHUNK + (axis === 0 ? p : 0);
              const [ax, ay] = axis === 0 ? [x - 1, y] : [x, y - 1];
              const [bx, by] = axis === 0 ? [x + 1, y] : [x, y + 1];
              expect([
                cellKind(world, x, y),
                cellKind(world, ax, ay),
                cellKind(world, bx, by),
              ]).toEqual([OPEN, OPEN, OPEN]);
            }
          }
        }
      }
    }
  });

  it("has walls, pillars and lit panels, with some panels dead", () => {
    const world = createWorld(1);
    const kinds = [0, 0, 0];
    const panels = [0, 0, 0];
    for (let y = LO; y < HI; y++) {
      for (let x = LO; x < HI; x++) {
        kinds[cellKind(world, x, y)]++;
        panels[panelAt(world, x, y)]++;
      }
    }
    expect(kinds[WALL]).toBeGreaterThan(0);
    expect(kinds[PILLAR]).toBeGreaterThan(0);
    expect(panels[PANEL_LIT]).toBeGreaterThan(panels[PANEL_DEAD] * 5);
    expect(panels[PANEL_DEAD]).toBeGreaterThan(0);
    expect(panelAt(world, 1, 0)).toBe(PANEL_NONE);
  });

  it("gives a cell the same content whatever was generated before it", () => {
    for (const seed of [1, 42]) {
      const a = createWorld(seed);
      const b = createWorld(seed);
      const want: number[] = [];
      for (let y = LO; y < HI; y++) {
        for (let x = LO; x < HI; x++) {
          want.push(cellKind(a, x, y));
        }
      }
      // Visit the same cells in another order, with far-off chunks in between
      // that evict the cache slots of nearby ones.
      const got: number[] = Array.from({ length: want.length });
      let i = 0;
      for (let y = HI - 1; y >= LO; y--) {
        for (let x = HI - 1; x >= LO; x--) {
          cellKind(b, x + 9 * CHUNK * ((i & 1) === 0 ? 1 : -1), y);
          got[(y - LO) * (HI - LO) + (x - LO)] = cellKind(b, x, y);
          i++;
        }
      }
      expect(got).toEqual(want);
    }
  });

  it("differs between variations and comes back when reseeded", () => {
    const world = createWorld(3);
    const sample = () => {
      const out: number[] = [];
      for (let x = 0; x < 64; x++) {
        out.push(cellKind(world, x, 5));
      }
      return out;
    };
    const first = sample();
    reseedWorld(world, 4);
    expect(sample()).not.toEqual(first);
    reseedWorld(world, 3);
    expect(sample()).toEqual(first);
  });
});

describe("window", () => {
  it("keeps the camera's chunk in the middle, VIEW_REACH from every side", () => {
    for (const c of [-17.5, -8, -0.2, 0, 3.9, 8, 1234.5]) {
      const o = windowOrigin(c);
      expect(Math.abs(o % CHUNK)).toBe(0);
      expect(c - o).toBeGreaterThanOrEqual(VIEW_REACH);
      expect(o + WINDOW - c).toBeGreaterThan(VIEW_REACH);
    }
  });

  it("writes the same cells from either side of a chunk boundary", () => {
    const world = createWorld(9);
    const a = new Uint8Array(WINDOW * WINDOW * 4);
    const b = new Uint8Array(WINDOW * WINDOW * 4);
    fillWindow(world, 0, 0, a);
    fillWindow(world, CHUNK, -CHUNK, b);
    const diff: string[] = [];
    for (let y = 0; y < WINDOW - CHUNK; y++) {
      for (let x = CHUNK; x < WINDOW; x++) {
        const ia = (y * WINDOW + x) * 4;
        const ib = ((y + CHUNK) * WINDOW + (x - CHUNK)) * 4;
        if (a[ia] !== b[ib] || a[ia + 1] !== b[ib + 1]) {
          diff.push(`${String(x)},${String(y)}`);
        }
      }
    }
    expect(diff).toEqual([]);
    expect(a[0]).toBe(cellKind(world, 0, 0));
    expect(a[(3 * WINDOW + 5) * 4 + 1]).toBe(panelAt(world, 5, 3));
  });
});

describe("walker", () => {
  it.each(SEEDS)("wanders on forever without turning back (seed %d)", (seed) => {
    const world = createWorld(seed);
    const w = createWalker();
    resetWalker(w, world);
    const dt = 1 / 30;
    const walk = walkSeconds(MAX_SPEED);
    const turn = turnSeconds(MAX_SPEED);
    const maxStep = (EASE_PEAK / walk) * dt * 1.0001;
    const maxTurn = ((EASE_PEAK * Math.PI) / 2 / turn) * dt * 1.0001;
    let px = w.x;
    let py = w.y;
    let pa = w.angle;
    let step = 0;
    let rot = 0;
    let reversals = 0;
    let blocked = 0;
    let far = 0;
    const sx = w.x;
    const sy = w.y;
    for (let i = 0; i < 20_000; i++) {
      advanceWalker(w, world, dt, walk, turn);
      reversals += w.kind === SEG_TURN && Math.abs(w.turn) > 1 ? 1 : 0;
      blocked += isOpen(world, w.cx, w.cy) ? 0 : 1;
      if (w.kind === SEG_WALK) {
        blocked += isOpen(world, w.cx + DIR_X[w.dir], w.cy + DIR_Y[w.dir]) ? 0 : 1;
      }
      step = Math.max(step, Math.hypot(w.x - px, w.y - py));
      rot = Math.max(rot, Math.abs(Math.atan2(Math.sin(w.angle - pa), Math.cos(w.angle - pa))));
      far = Math.max(far, Math.hypot(w.x - sx, w.y - sy));
      px = w.x;
      py = w.y;
      pa = w.angle;
    }
    expect([reversals, blocked]).toEqual([0, 0]);
    expect(step).toBeLessThanOrEqual(maxStep);
    expect(rot).toBeLessThanOrEqual(maxTurn);
    expect(w.walks).toBeGreaterThan(500);
    // It roams across chunks rather than circling one room.
    expect(far).toBeGreaterThan(2 * CHUNK);
  });

  it("walks the same path for the same variation", () => {
    const run = (seed: number) => {
      const world = createWorld(seed);
      const w = createWalker();
      resetWalker(w, world);
      for (let i = 0; i < 2000; i++) {
        advanceWalker(w, world, 1 / 30, walkSeconds(1), turnSeconds(1));
      }
      return [w.x, w.y, w.angle];
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
  });

  it("counts the distance walked", () => {
    const world = createWorld(2);
    const w = createWalker();
    resetWalker(w, world);
    advanceWalker(w, world, walkSeconds(1) * 10, walkSeconds(1), turnSeconds(1));
    expect(w.walked).toBeGreaterThan(0);
  });
});

describe("motion limits", () => {
  const speeds = [MIN_SPEED, 1, MAX_SPEED, 1e9, Number.NaN, -1];

  it.each(speeds)("walks tiles and wallpaper past a point within MAX_PATTERN_HZ at %d", (s) => {
    const peak = EASE_PEAK / walkSeconds(s);
    expect(peak / PATTERN_PERIOD).toBeLessThanOrEqual(MAX_PATTERN_HZ + 1e-9);
    expect(Number.isFinite(walkSeconds(s))).toBe(true);
  });

  it.each(speeds)("turns within MAX_PATTERN_HZ of swept wallpaper at %d", (s) => {
    const omega = (EASE_PEAK * Math.PI) / 2 / turnSeconds(s);
    expect(omega / (PATTERN_PERIOD / REF_DISTANCE)).toBeLessThanOrEqual(MAX_PATTERN_HZ + 1e-9);
    expect(Number.isFinite(turnSeconds(s))).toBe(true);
  });

  it("walks about a room every three to four seconds at the default pace", () => {
    // A room is about five cells across.
    expect(5 * walkSeconds(1)).toBeGreaterThan(3);
    expect(5 * walkSeconds(1)).toBeLessThan(4.5);
  });
});

describe("flicker", () => {
  /**
   * The most of the frame's light one panel gives: the frame's floor, walls and
   * ceiling are lit by many panels plus a flat ambient, so even standing under
   * one it gives well under this.
   */
  const PANEL_SHARE = 1 / 3;

  it("never dims the frame by more than a few percent between frames", () => {
    const world = createWorld(1);
    const f = createFlicker(1);
    const prev = new Float64Array(MAX_FLICKERS).fill(1);
    let worst = 0;
    let events = 0;
    let lowest = 1;
    for (let i = 0; i < 30 * 600; i++) {
      advanceFlicker(f, world, 1 / 30, 1, 4.5, 3.5);
      let drop = 0;
      for (let k = 0; k < MAX_FLICKERS; k++) {
        const s = f.slots[k];
        const level = flickerLevel(s);
        drop += Math.abs(level - prev[k]);
        events += s.active && s.t === 1 / 30 ? 1 : 0;
        lowest = Math.min(lowest, level);
        prev[k] = level;
      }
      worst = Math.max(worst, drop * PANEL_SHARE);
    }
    expect(worst).toBeLessThan(0.04);
    expect(events).toBeGreaterThan(50);
    // Dims go well down, but a panel is never fully off for long.
    expect(lowest).toBeLessThan(0.5);
    expect(lowest).toBeGreaterThan(0.2);
  });

  it("only flickers lit panels near the camera, never two on the same panel", () => {
    const world = createWorld(4);
    const f = createFlicker(4);
    const bad: string[] = [];
    let flickers = 0;
    for (let i = 0; i < 30 * 300; i++) {
      advanceFlicker(f, world, 1 / 30, 1, 20.5, -9.5);
      const [a, b] = f.slots;
      for (const s of f.slots) {
        if (!s.active) {
          continue;
        }
        flickers++;
        const near = Math.abs(s.x - 20.5) < 8 && Math.abs(s.y + 9.5) < 8;
        if (panelAt(world, s.x, s.y) !== PANEL_LIT || !near) {
          bad.push(`${String(s.x)},${String(s.y)}`);
        }
      }
      if (a.active && b.active && a.x === b.x && a.y === b.y) {
        bad.push("shared");
      }
    }
    expect(bad).toEqual([]);
    expect(flickers).toBeGreaterThan(0);
  });

  it("stays steady at a flicker of 0", () => {
    const world = createWorld(1);
    const f = createFlicker(1);
    for (let i = 0; i < 30 * 300; i++) {
      advanceFlicker(f, world, 1 / 30, 0, 0.5, 0.5);
      expect(f.slots.every((s) => !s.active)).toBe(true);
    }
  });

  it("schedules the same events for the same variation", () => {
    const run = () => {
      const world = createWorld(2);
      const f = createFlicker(2);
      const out: number[] = [];
      for (let i = 0; i < 30 * 60; i++) {
        advanceFlicker(f, world, 1 / 30, 0.7, 3.5, 3.5);
        out.push(flickerLevel(f.slots[0]), flickerLevel(f.slots[1]));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
