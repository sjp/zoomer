import { describe, expect, it } from "vitest";
import { DIR_X, DIR_Y } from "../grid-walk";
import { EASE_PEAK, MAX_PATTERN_HZ } from "../motion-limits";
import { backroomsMeta, MAX_SPEED, MIN_SPEED } from "./backrooms.meta";
import {
  advanceFlicker,
  advanceWalker,
  cellKind,
  CHUNK,
  createFlicker,
  createWalker,
  createWorld,
  CURVE_LENGTH,
  edgeDoors,
  fillWindow,
  flickerLevel,
  isOpen,
  laneAt,
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
  STYLE_CORRIDOR,
  STYLE_HALL,
  STYLE_NONE,
  STYLE_ROOMS,
  VIEW_REACH,
  WALL,
  walkRate,
  WINDOW,
  windowOrigin,
  type World,
} from "./backrooms-sim";

const DEFAULT_SPEED = backroomsMeta.params.speed.default;
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
    const start = (Math.floor(walker.y) - LO) * side + (Math.floor(walker.x) - LO);
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
            const mask = edgeDoors(world, cx, cy, axis);
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

describe("route", () => {
  it.each(SEEDS)("keeps the route's cells open in rooms, corridors and halls (seed %d)", (seed) => {
    const world = createWorld(seed);
    const styles = new Set<number>();
    let lanes = 0;
    let corners = 0;
    for (let cy = -6; cy <= 6; cy++) {
      for (let cx = -6; cx <= 6; cx++) {
        const lane = laneAt(world, cx, cy);
        if (lane.style === STYLE_NONE) {
          continue;
        }
        lanes++;
        corners += lane.corner ? 1 : 0;
        styles.add(lane.style);
        // The middle cell, and every exit's row or column out to the chunk's edge and beyond.
        expect(cellKind(world, cx * CHUNK + 4, cy * CHUNK + 4)).toBe(OPEN);
        for (let d = 0; d < 4; d++) {
          if ((lane.exits & (1 << d)) === 0) {
            continue;
          }
          for (let r = 1; r <= CHUNK / 2; r++) {
            const x = cx * CHUNK + 4 + DIR_X[d] * r;
            const y = cy * CHUNK + 4 + DIR_Y[d] * r;
            expect(cellKind(world, x, y)).toBe(OPEN);
          }
          // The neighbour carries the route on.
          const n = laneAt(world, cx + DIR_X[d], cy + DIR_Y[d]);
          expect(n.exits & (1 << ((d + 2) & 3))).not.toBe(0);
        }
      }
    }
    expect(lanes).toBeGreaterThan(12);
    expect(styles.has(STYLE_NONE)).toBe(false);
    expect(corners).toBeLessThanOrEqual(2);
  });

  it.each(SEEDS)("leads on from chunk to chunk for hundreds of legs (seed %d)", (seed) => {
    const world = createWorld(seed);
    let cx = 0;
    let cy = 0;
    let heading = laneAt(world, cx, cy).dirOut;
    let corners = 0;
    for (let i = 0; i < 5000; i++) {
      cx += DIR_X[heading];
      cy += DIR_Y[heading];
      const lane = laneAt(world, cx, cy);
      expect(lane.style).not.toBe(STYLE_NONE);
      expect(lane.dirIn).toBe(heading);
      corners += lane.corner ? 1 : 0;
      heading = lane.dirOut;
    }
    // Legs are 6 to 11 chunks long.
    expect(corners).toBeGreaterThan(5000 / 12);
    expect(corners).toBeLessThan(5000 / 6);
  });

  it("has every kind of stretch across the variations", () => {
    const styles = new Set<number>();
    let corners = 0;
    for (const seed of SEEDS) {
      const world = createWorld(seed);
      for (let k = -20; k <= 20; k++) {
        for (let j = -20; j <= 20; j++) {
          const lane = laneAt(world, k, j);
          styles.add(lane.style);
          corners += lane.corner ? 1 : 0;
        }
      }
    }
    expect([...styles].toSorted((a, b) => a - b)).toEqual([
      STYLE_NONE,
      STYLE_ROOMS,
      STYLE_CORRIDOR,
      STYLE_HALL,
    ]);
    expect(corners).toBeGreaterThan(SEEDS.length);
  });
});

describe("walker", () => {
  /** Whether the camera at (x, y) keeps `clear` cells from every wall and pillar. */
  const clearAt = (world: World, x: number, y: number, clear: number) => {
    for (let j = Math.floor(y - 1); j <= Math.floor(y + 1); j++) {
      for (let i = Math.floor(x - 1); i <= Math.floor(x + 1); i++) {
        const kind = cellKind(world, i, j);
        const half = kind === WALL ? 0.5 : kind === PILLAR ? 0.22 : -1;
        if (half < 0) {
          continue;
        }
        const dx = Math.max(Math.abs(x - i - 0.5) - half, 0);
        const dy = Math.max(Math.abs(y - j - 0.5) - half, 0);
        if (Math.hypot(dx, dy) < clear) {
          return false;
        }
      }
    }
    return true;
  };

  it.each(SEEDS)(
    "walks on and on along open floor, bending only now and then (seed %d)",
    (seed) => {
      const world = createWorld(seed);
      const w = createWalker();
      resetWalker(w, world);
      const dt = 1 / 30;
      const rate = walkRate(DEFAULT_SPEED);
      let px = w.x;
      let py = w.y;
      let pa = w.angle;
      let step = 0;
      let rot = 0;
      let blocked = 0;
      const bends: number[] = [];
      let bending = false;
      // Twenty minutes.
      for (let i = 0; i < 30 * 1200; i++) {
        advanceWalker(w, world, dt, rate);
        blocked += clearAt(world, w.x, w.y, 0.25) ? 0 : 1;
        step = Math.max(step, Math.hypot(w.x - px, w.y - py));
        const da = Math.atan2(Math.sin(w.angle - pa), Math.cos(w.angle - pa));
        rot = Math.max(rot, Math.abs(da));
        const turning = Math.abs(da) > 1e-9;
        if (turning && !bending) {
          bends.push(i * dt);
        }
        bending = turning;
        px = w.x;
        py = w.y;
        pa = w.angle;
      }
      expect(blocked).toBe(0);
      // Its own pace, and the drift a little on top.
      expect(step).toBeLessThanOrEqual(rate * dt * 1.1);
      // A bend's peak turn rate sweeps the wallpaper REF_DISTANCE away within MAX_PATTERN_HZ.
      expect(rot / dt).toBeLessThanOrEqual((MAX_PATTERN_HZ * PATTERN_PERIOD) / REF_DISTANCE);
      // A bend every minute or two.
      expect(bends.length).toBeGreaterThanOrEqual(8);
      const gaps = bends.slice(1).map((t, k) => t - bends[k]);
      expect(Math.min(...gaps)).toBeGreaterThan(55);
      expect(Math.max(...gaps)).toBeLessThan(130);
      expect(bends[0]).toBeGreaterThan(55);
    },
  );

  it("holds its heading on the straights, sweeping only at the bends", () => {
    const world = createWorld(3);
    const w = createWalker();
    resetWalker(w, world);
    const start = w.angle;
    for (let i = 0; i < 30 * 40; i++) {
      advanceWalker(w, world, 1 / 30, walkRate(DEFAULT_SPEED));
      expect(w.angle).toBe(start);
    }
  });

  it("bends round a quarter turn and alternates left and right", () => {
    const world = createWorld(8);
    const w = createWalker();
    resetWalker(w, world);
    const headings = [w.angle];
    let leg = 0;
    for (let i = 0; i < 30 * 600; i++) {
      advanceWalker(w, world, 1 / 30, walkRate(MAX_SPEED));
      if (w.leg !== leg) {
        leg = w.leg;
        headings.push(w.angle);
      }
    }
    expect(headings.length).toBeGreaterThan(4);
    const turns = headings.slice(1).map((a, k) => {
      const d = a - headings[k];
      return Math.round((Math.atan2(Math.sin(d), Math.cos(d)) / (Math.PI / 2)) * 1e6) / 1e6;
    });
    expect(turns.map((t) => Math.abs(t))).toEqual(turns.map(() => 1));
    expect(turns.slice(1)).toEqual(turns.slice(0, -1).map((t) => -t));
  });

  it("starts from rest and eases up to pace", () => {
    const world = createWorld(1);
    const w = createWalker();
    resetWalker(w, world);
    const x0 = w.x;
    const y0 = w.y;
    advanceWalker(w, world, 1 / 30, walkRate(1));
    expect(Math.hypot(w.x - x0, w.y - y0)).toBeLessThan(0.01);
    for (let i = 0; i < 30 * 10; i++) {
      advanceWalker(w, world, 1 / 30, walkRate(1));
    }
    expect(w.rate).toBe(walkRate(1));
  });

  it("walks the same path for the same variation", () => {
    const run = (seed: number) => {
      const world = createWorld(seed);
      const w = createWalker();
      resetWalker(w, world);
      for (let i = 0; i < 30 * 200; i++) {
        advanceWalker(w, world, 1 / 30, walkRate(1));
      }
      return [w.x, w.y, w.angle];
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
  });

  it("heads off in different directions for different variations", () => {
    const headings = new Set<number>();
    for (const seed of SEEDS) {
      const world = createWorld(seed);
      const w = createWalker();
      resetWalker(w, world);
      headings.add(Math.round(Math.atan2(Math.sin(w.angle), Math.cos(w.angle)) * 100));
    }
    expect(headings.size).toBeGreaterThan(2);
  });

  it("counts the distance walked", () => {
    const world = createWorld(2);
    const w = createWalker();
    resetWalker(w, world);
    for (let i = 0; i < 30 * 10; i++) {
      advanceWalker(w, world, 1 / 30, walkRate(1));
    }
    expect(w.walked).toBeGreaterThan(5);
  });
});

describe("motion limits", () => {
  const speeds = [MIN_SPEED, 1, MAX_SPEED, 1e9, Number.NaN, -1];

  it.each(speeds)("walks tiles and wallpaper past a point within MAX_PATTERN_HZ at %d", (s) => {
    expect(walkRate(s) / PATTERN_PERIOD).toBeLessThanOrEqual(MAX_PATTERN_HZ + 1e-9);
    expect(walkRate(s)).toBeGreaterThan(0);
  });

  it.each(speeds)("bends within MAX_PATTERN_HZ of swept wallpaper at %d", (s) => {
    const omega = (walkRate(s) * EASE_PEAK * Math.PI) / 2 / CURVE_LENGTH;
    expect(omega / (PATTERN_PERIOD / REF_DISTANCE)).toBeLessThanOrEqual(MAX_PATTERN_HZ + 1e-9);
  });

  it("walks about a room every six to seven and a half seconds at the default pace", () => {
    // A room is about five cells across.
    expect(5 / walkRate(DEFAULT_SPEED)).toBeGreaterThan(6);
    expect(5 / walkRate(DEFAULT_SPEED)).toBeLessThan(7.5);
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
      advanceFlicker(f, world, 1 / 30, 1, 4.5, 3.5, 0);
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
      advanceFlicker(f, world, 1 / 30, 1, 20.5, -9.5, i * 0.001);
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

  it.each([0, 1, 2, 3])("flickers panels mostly ahead of the camera (heading %d)", (q) => {
    const heading = (q * Math.PI) / 2;
    const fx = Math.cos(heading);
    const fy = Math.sin(heading);
    let ahead = 0;
    let events = 0;
    for (const seed of SEEDS) {
      const world = createWorld(seed);
      const f = createFlicker(seed);
      for (let i = 0; i < 30 * 300; i++) {
        advanceFlicker(f, world, 1 / 30, 1, 10.5, 6.5, heading);
        for (const s of f.slots) {
          if (s.active && s.t === 1 / 30) {
            events++;
            ahead += (s.x + 0.5 - 10.5) * fx + (s.y + 0.5 - 6.5) * fy > 0 ? 1 : 0;
          }
        }
      }
    }
    expect(events).toBeGreaterThan(100);
    expect(ahead / events).toBeGreaterThan(0.75);
  });

  it("stays steady at a flicker of 0", () => {
    const world = createWorld(1);
    const f = createFlicker(1);
    for (let i = 0; i < 30 * 300; i++) {
      advanceFlicker(f, world, 1 / 30, 0, 0.5, 0.5, 0);
      expect(f.slots.every((s) => !s.active)).toBe(true);
    }
  });

  it("schedules the same events for the same variation", () => {
    const run = () => {
      const world = createWorld(2);
      const f = createFlicker(2);
      const out: number[] = [];
      for (let i = 0; i < 30 * 60; i++) {
        advanceFlicker(f, world, 1 / 30, 0.7, 3.5, 3.5, 1);
        out.push(flickerLevel(f.slots[0]), flickerLevel(f.slots[1]));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
