import { describe, expect, it } from "vitest";
import { MAX_PATTERN_HZ } from "../motion-limits";
import { MAX_SIZE, MAX_SPEED, MIN_SIZE, MIN_SPEED } from "./maze.meta";
import {
  advanceRat,
  advanceWalker,
  cellIndex,
  chooseTurn,
  clampSize,
  COURSE_HEIGHT,
  createMaze,
  createRat,
  createWalker,
  DIR_X,
  DIR_Y,
  distanceField,
  EASE_PEAK,
  exitX,
  exitY,
  FOCAL,
  generateMaze,
  GRID,
  handSign,
  isOpen,
  type Maze,
  OBJ_NONE,
  OBJ_SMILEY,
  objectCount,
  PATTERN_PERIOD,
  placeRat,
  REF_DISTANCE,
  resetWalker,
  ROLL_REF_RADIUS,
  ROLL_SECONDS,
  SEG_DONE,
  SEG_WALK,
  turnSeconds,
  walkEase,
  walkSeconds,
  walkTarget,
} from "./maze-sim";

const SIZES = [MIN_SIZE, 9, 12, 17, MAX_SIZE];
const SEEDS = [0, 1, 2, 7, 42, 123, 999];

/** Open passages counted once each (east and north sides; the exit doorway excluded). */
function passages(maze: Maze): number {
  let n = 0;
  for (let y = 0; y < maze.size; y++) {
    for (let x = 0; x < maze.size; x++) {
      if (isOpen(maze, x, y, 0) && x + 1 < maze.size) {
        n++;
      }
      if (isOpen(maze, x, y, 1)) {
        n++;
      }
    }
  }
  return n;
}

/** Walks the maze to the exit; returns the number of segments, or -1 if it never got out. */
function walkOut(maze: Maze, hand: number, dt = 0.25): number {
  const w = createWalker();
  resetWalker(w);
  const limit = 20 * maze.size * maze.size;
  for (let i = 0; i < limit * 8; i++) {
    advanceWalker(w, maze, dt, hand, 1, 1);
    if (w.kind === SEG_DONE) {
      return w.walks;
    }
  }
  return -1;
}

describe("generateMaze", () => {
  it("makes a perfect maze: connected, with exactly one path between cells", () => {
    const maze = createMaze();
    const dist = new Int16Array(GRID * GRID);
    const queue = new Int16Array(GRID * GRID);
    for (const size of SIZES) {
      for (const seed of SEEDS) {
        generateMaze(maze, size, seed);
        // Connected (every cell reached) with cells - 1 passages: a spanning tree.
        distanceField(maze, 0, 0, dist, queue);
        let unreached = 0;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            unreached += dist[cellIndex(x, y)] < 0 ? 1 : 0;
          }
        }
        expect(unreached).toBe(0);
        expect(passages(maze)).toBe(size * size - 1);
        expect(dist[cellIndex(exitX(maze), exitY(maze))]).toBeGreaterThan(0);
      }
    }
  });

  it("keeps walls consistent from both sides, closes the border and opens the exit", () => {
    const maze = createMaze();
    generateMaze(maze, 12, 5);
    const bad: string[] = [];
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        for (let d = 0; d < 4; d++) {
          const nx = x + DIR_X[d];
          const ny = y + DIR_Y[d];
          const border = nx < 0 || ny < 0 || nx >= 12 || ny >= 12;
          const want = border ? x === 11 && y === 11 && d === 0 : isOpen(maze, nx, ny, (d + 2) & 3);
          if (isOpen(maze, x, y, d) !== want) {
            bad.push(`${String(x)},${String(y)} side ${String(d)}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("is deterministic per seed and differs between seeds", () => {
    const a = createMaze();
    const b = createMaze();
    generateMaze(a, 12, 3);
    generateMaze(b, 12, 3);
    expect(a.open).toEqual(b.open);
    generateMaze(b, 12, 4);
    expect(a.open).not.toEqual(b.open);
  });

  it("places a few objects at dead ends and junctions, one of them a smiley", () => {
    const maze = createMaze();
    for (const size of SIZES) {
      generateMaze(maze, size, 11);
      let count = 0;
      let smileys = 0;
      for (let i = 0; i < maze.objects.length; i++) {
        if (maze.objects[i] === OBJ_NONE) {
          continue;
        }
        count++;
        smileys += maze.objects[i] === OBJ_SMILEY ? 1 : 0;
        const o = maze.open[i];
        const sides = (o & 1) + ((o >> 1) & 1) + ((o >> 2) & 1) + ((o >> 3) & 1);
        expect(sides === 1 || sides >= 3).toBe(true);
      }
      expect(count).toBe(objectCount(size));
      expect(smileys).toBe(1);
      expect(maze.objects[cellIndex(0, 0)]).toBe(OBJ_NONE);
      expect(maze.objects[cellIndex(size - 1, size - 1)]).toBe(OBJ_NONE);
    }
  });
});

describe("wall follower", () => {
  it("reaches the exit from the start for every seed and size, either hand", () => {
    const maze = createMaze();
    for (const size of SIZES) {
      for (const seed of SEEDS) {
        generateMaze(maze, size, seed);
        for (const hand of [handSign("right"), handSign("left")]) {
          const walks = walkOut(maze, hand);
          expect(walks).toBeGreaterThan(0);
          // A wall follower walks each passage at most twice.
          expect(walks).toBeLessThanOrEqual(2 * size * size + 1);
        }
      }
    }
  });

  it("still gets out when the hand changes part-way", () => {
    const maze = createMaze();
    for (const seed of SEEDS) {
      for (const switchAt of [10, 50, 200]) {
        generateMaze(maze, 16, seed);
        const w = createWalker();
        resetWalker(w);
        for (let i = 0; i < 100_000 && w.kind !== SEG_DONE; i++) {
          advanceWalker(w, maze, 0.25, i < switchAt ? -1 : 1, 1, 1);
        }
        expect(w.kind).toBe(SEG_DONE);
      }
    }
  });

  it("moves the camera continuously, with no jumps in position or heading", () => {
    const maze = createMaze();
    for (const seed of [1, 2, 3]) {
      generateMaze(maze, 10, seed);
      const w = createWalker();
      resetWalker(w);
      const dt = 1 / 60;
      const walk = walkSeconds(1);
      const turn = turnSeconds(1);
      // Bounds on one frame's step: the peak pace and the peak turn rate.
      const maxStep = (EASE_PEAK / walk) * dt * 1.0001;
      const maxTurn = ((EASE_PEAK * Math.PI) / 2 / turn) * dt * 1.0001;
      let px = w.x;
      let py = w.y;
      let pa = w.angle;
      let step = 0;
      let rot = 0;
      for (let i = 0; i < 200_000 && w.kind !== SEG_DONE; i++) {
        advanceWalker(w, maze, dt, -1, walk, turn);
        step = Math.max(step, Math.hypot(w.x - px, w.y - py));
        // Headings are compared modulo a full turn.
        rot = Math.max(rot, Math.abs(Math.atan2(Math.sin(w.angle - pa), Math.cos(w.angle - pa))));
        px = w.x;
        py = w.y;
        pa = w.angle;
      }
      expect(w.kind).toBe(SEG_DONE);
      expect(step).toBeLessThanOrEqual(maxStep);
      expect(rot).toBeLessThanOrEqual(maxTurn);
    }
  });

  it("stays on cell centre lines: walks along the heading, turns in place", () => {
    const maze = createMaze();
    generateMaze(maze, 10, 4);
    const w = createWalker();
    resetWalker(w);
    let offLine = 0;
    let throughWall = 0;
    for (let i = 0; i < 20_000 && w.kind !== SEG_DONE; i++) {
      advanceWalker(w, maze, 0.05, -1, 1, 1);
      const onX = Math.abs((w.x % 1) - 0.5) < 1e-9;
      const onY = Math.abs((w.y % 1) - 0.5) < 1e-9;
      offLine += onX || onY ? 0 : 1;
      throughWall += w.kind === SEG_WALK && !isOpen(maze, w.cx, w.cy, w.dir) ? 1 : 0;
    }
    expect(w.kind).toBe(SEG_DONE);
    expect([offLine, throughWall]).toEqual([0, 0]);
  });

  it("eases each walk end that starts or stops, and cruises otherwise", () => {
    for (const [a, b] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      expect(walkEase(0, a, b)).toBe(0);
      expect(walkEase(1, a, b)).toBeCloseTo(1, 12);
      const h = 1e-6;
      const startRate = walkEase(h, a, b) / h;
      const endRate = (1 - walkEase(1 - h, a, b)) / h;
      expect(startRate).toBeCloseTo(a ? 0 : 1, 4);
      expect(endRate).toBeCloseTo(b ? 0 : 1, 4);
      let prev = 0;
      let minRate = Infinity;
      let maxRate = 0;
      for (let i = 1; i <= 64; i++) {
        const s = walkEase(i / 64, a, b);
        minRate = Math.min(minRate, (s - prev) * 64);
        maxRate = Math.max(maxRate, (s - prev) * 64);
        prev = s;
      }
      // Never backwards, and no faster than smoothstep's peak.
      expect(minRate).toBeGreaterThanOrEqual(0);
      expect(maxRate).toBeLessThanOrEqual(EASE_PEAK + 1e-9);
    }
  });
});

describe("wall follower choices", () => {
  it("prefers the followed wall's side, then straight, then the other side, then back", () => {
    const maze = createMaze();
    generateMaze(maze, 8, 1);
    const i = cellIndex(3, 3);
    const saved = maze.open[i];
    // Open east and north and west: heading north, a right hand turns east (-1).
    maze.open[i] = 0b0111;
    expect(chooseTurn(maze, 3, 3, 1, handSign("right"))).toBe(-1);
    expect(chooseTurn(maze, 3, 3, 1, handSign("left"))).toBe(1);
    // Only straight on and behind.
    maze.open[i] = 0b1010;
    expect(chooseTurn(maze, 3, 3, 1, handSign("right"))).toBe(0);
    // A dead end: turn around, away from the followed wall.
    maze.open[i] = 0b1000;
    expect(chooseTurn(maze, 3, 3, 1, handSign("right"))).toBe(2);
    expect(chooseTurn(maze, 3, 3, 1, handSign("left"))).toBe(-2);
    maze.open[i] = saved;
  });

  it("names the cell a walk heads into, and -1 through the exit", () => {
    const maze = createMaze();
    generateMaze(maze, 8, 1);
    const w = createWalker();
    resetWalker(w);
    expect(walkTarget(w, maze)).toBe(cellIndex(0, 0));
    w.kind = SEG_WALK;
    w.dir = 0;
    expect(walkTarget(w, maze)).toBe(cellIndex(1, 0));
    w.cx = 7;
    w.cy = 7;
    expect(walkTarget(w, maze)).toBe(-1);
  });

  it("clamps the maze size to whole cells in range", () => {
    expect([clampSize(3), clampSize(12.4), clampSize(99), clampSize(Number.NaN)]).toEqual([
      MIN_SIZE,
      12,
      MAX_SIZE,
      MIN_SIZE,
    ]);
  });
});

describe("motion limits", () => {
  const speeds = [MIN_SPEED, 1, MAX_SPEED, 1e9, Number.NaN, -1];

  it("walks bricks, flagstones and tiles past a point at most MAX_PATTERN_HZ", () => {
    for (const s of speeds) {
      const peak = EASE_PEAK / walkSeconds(s);
      expect(peak / PATTERN_PERIOD).toBeLessThanOrEqual(MAX_PATTERN_HZ + 1e-9);
      expect(Number.isFinite(walkSeconds(s))).toBe(true);
    }
    expect(walkSeconds(1)).toBeCloseTo(1.5, 6);
  });

  it("turns slowly enough that the swept wall pattern stays within MAX_PATTERN_HZ", () => {
    for (const s of speeds) {
      const omega = (EASE_PEAK * Math.PI) / 2 / turnSeconds(s);
      const angularPeriod = PATTERN_PERIOD / REF_DISTANCE;
      expect(omega / angularPeriod).toBeLessThanOrEqual(MAX_PATTERN_HZ + 1e-9);
      expect(Number.isFinite(turnSeconds(s))).toBe(true);
    }
    // At the slowest pace the turn is set by the pace, not the cap.
    expect(turnSeconds(MIN_SPEED)).toBeCloseTo(0.8 / MIN_SPEED, 6);
  });

  it("rolls upside down over at least 2 s within MAX_PATTERN_HZ", () => {
    expect(ROLL_SECONDS).toBeGreaterThanOrEqual(2);
    const omega = (EASE_PEAK * Math.PI) / ROLL_SECONDS;
    const period = (COURSE_HEIGHT * FOCAL) / REF_DISTANCE;
    expect((omega * ROLL_REF_RADIUS) / period).toBeLessThanOrEqual(MAX_PATTERN_HZ + 1e-9);
  });
});

describe("rat", () => {
  it("only moves through open passages and never into the blocked cell", () => {
    const maze = createMaze();
    generateMaze(maze, 12, 8);
    const dist = new Int16Array(GRID * GRID);
    const queue = new Int16Array(GRID * GRID);
    distanceField(maze, 0, 0, dist, queue);
    const rat = createRat(8);
    placeRat(rat, maze, dist);
    expect(dist[cellIndex(rat.cx, rat.cy)]).toBe(6);
    const blocked = cellIndex(5, 5);
    distanceField(maze, 5, 5, dist, queue);
    let px = rat.x;
    let py = rat.y;
    let badMoves = 0;
    let intoBlocked = 0;
    let moves = 0;
    let maxStep = 0;
    for (let i = 0; i < 5000; i++) {
      const cx = rat.cx;
      const cy = rat.cy;
      advanceRat(rat, maze, 1 / 30, dist, blocked);
      if (rat.cx !== cx || rat.cy !== cy) {
        moves++;
        const d = DIR_X.findIndex((dx, k) => dx === rat.cx - cx && DIR_Y[k] === rat.cy - cy);
        badMoves += d >= 0 && isOpen(maze, cx, cy, d) ? 0 : 1;
      }
      intoBlocked += cellIndex(rat.cx, rat.cy) === blocked ? 1 : 0;
      maxStep = Math.max(maxStep, Math.hypot(rat.x - px, rat.y - py));
      px = rat.x;
      py = rat.y;
    }
    expect(moves).toBeGreaterThan(20);
    expect([badMoves, intoBlocked]).toEqual([0, 0]);
    expect(maxStep).toBeLessThan(0.05);
  });
});
