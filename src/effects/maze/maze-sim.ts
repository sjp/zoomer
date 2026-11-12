/**
 * The 3D Maze's pure logic: maze generation (a seeded recursive backtracker), the
 * objects placed in it, the wall-following walker whose camera pose the shader
 * draws from, and the rat that wanders the corridors. Everything here works in
 * cell units: cell (x, y) covers [x, x + 1] x [y, y + 1], y points north, and the
 * walls are one cell high with the eye half-way up.
 *
 * All state lives in preallocated typed arrays sized for the largest maze, so a
 * new maze or a step of the walker allocates nothing.
 */
import { MAX_PATTERN_HZ, capPatternSpeed } from "../motion-limits";
import { createRng, hash32 } from "../noise";
import { MAX_SIZE, MIN_SIZE, MIN_SPEED, MAX_SPEED } from "./maze.meta";

/** Headings: east, north, west, south. A left turn adds 1. */
export const DIR_X: readonly number[] = [1, 0, -1, 0];
export const DIR_Y: readonly number[] = [0, 1, 0, -1];

export const OBJ_NONE = 0;
const OBJ_ICOSA = 1;
const OBJ_OCTA = 2;
export const OBJ_SMILEY = 3;

/** Cells along a side of the data arrays (and the shader's maze texture, plus one). */
export const GRID = MAX_SIZE;

export interface Maze {
  /** Cells along a side of the current maze. */
  size: number;
  /**
   * Per cell (index `y * GRID + x`), a bit per open side: `1 << dir`. The exit
   * cell, the north-east corner, also has its east side open to the outside.
   */
  readonly open: Uint8Array;
  /** Per cell, the object floating in it (`OBJ_*`). */
  readonly objects: Uint8Array;
  /** Generation scratch: visited flags and the backtracking stack. */
  readonly visited: Uint8Array;
  readonly stack: Int16Array;
}

export function createMaze(): Maze {
  return {
    size: MIN_SIZE,
    open: new Uint8Array(GRID * GRID),
    objects: new Uint8Array(GRID * GRID),
    visited: new Uint8Array(GRID * GRID),
    stack: new Int16Array(GRID * GRID),
  };
}

export const clampSize = (size: number) =>
  Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(Number.isFinite(size) ? size : MIN_SIZE)));

export const cellIndex = (x: number, y: number) => y * GRID + x;

/** The exit cell is the north-east corner; its east side is the doorway out. */
export const exitX = (maze: Maze) => maze.size - 1;
export const exitY = (maze: Maze) => maze.size - 1;

/** Whether cell (x, y) of the maze is open towards `dir`. Cells outside are closed. */
export function isOpen(maze: Maze, x: number, y: number, dir: number): boolean {
  if (x < 0 || y < 0 || x >= maze.size || y >= maze.size) {
    return false;
  }
  return (maze.open[cellIndex(x, y)] & (1 << dir)) !== 0;
}

const inside = (maze: Maze, x: number, y: number) =>
  x >= 0 && y >= 0 && x < maze.size && y < maze.size;

/**
 * Carves a perfect maze (exactly one path between any two cells) of `size` cells
 * a side with a recursive backtracker driven by a seeded RNG, opens the exit
 * doorway and places the objects. Allocates only the RNG closure.
 */
export function generateMaze(maze: Maze, size: number, seed: number): void {
  const n = clampSize(size);
  maze.size = n;
  maze.open.fill(0);
  maze.objects.fill(0);
  maze.visited.fill(0);
  const rng = createRng(seed);
  const stack = maze.stack;
  let top = 0;
  stack[top++] = cellIndex(0, 0);
  maze.visited[cellIndex(0, 0)] = 1;
  while (top > 0) {
    const c = stack[top - 1];
    const x = c % GRID;
    const y = (c - x) / GRID;
    // Count the unvisited neighbours, then pick one of them uniformly.
    let count = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR_X[d];
      const ny = y + DIR_Y[d];
      if (inside(maze, nx, ny) && maze.visited[cellIndex(nx, ny)] === 0) {
        count++;
      }
    }
    if (count === 0) {
      top--;
      continue;
    }
    let pick = Math.floor(rng() * count);
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR_X[d];
      const ny = y + DIR_Y[d];
      if (!inside(maze, nx, ny) || maze.visited[cellIndex(nx, ny)] !== 0) {
        continue;
      }
      if (pick-- > 0) {
        continue;
      }
      const ni = cellIndex(nx, ny);
      maze.open[c] |= 1 << d;
      maze.open[ni] |= 1 << ((d + 2) & 3);
      maze.visited[ni] = 1;
      stack[top++] = ni;
      break;
    }
  }
  // The doorway out: the east side (heading 0) of the exit cell.
  maze.open[cellIndex(exitX(maze), exitY(maze))] |= 1;
  placeObjects(maze, seed);
}

/** Number of open sides of a cell. */
function openSides(maze: Maze, i: number): number {
  const o = maze.open[i];
  return (o & 1) + ((o >> 1) & 1) + ((o >> 2) & 1) + ((o >> 3) & 1);
}

/** How many objects a maze of `size` cells a side holds: a few, more in bigger mazes. */
export const objectCount = (size: number) =>
  Math.min(16, Math.max(2, Math.round((size * size) / 36)));

/**
 * Floats objects at dead ends and junctions (never the start or exit cell): the
 * candidates with the lowest hashes, the first a smiley and the rest icosahedra
 * and octahedra.
 */
function placeObjects(maze: Maze, seed: number): void {
  const n = maze.size;
  const want = objectCount(n);
  const salt = hash32(Math.floor(seed) ^ 0x51ed270b);
  const start = cellIndex(0, 0);
  const exit = cellIndex(exitX(maze), exitY(maze));
  let lastScore = -1;
  for (let k = 0; k < want; k++) {
    // The next-lowest score above the previous pick: O(want * cells), tiny.
    let best = -1;
    let bestScore = Infinity;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = cellIndex(x, y);
        const sides = openSides(maze, i);
        if (i === start || i === exit || (sides !== 1 && sides < 3)) {
          continue;
        }
        const score = hash32(i ^ salt);
        if (score > lastScore && score < bestScore) {
          best = i;
          bestScore = score;
        }
      }
    }
    if (best < 0) {
      return;
    }
    lastScore = bestScore;
    maze.objects[best] =
      k === 0 ? OBJ_SMILEY : (hash32(best + salt) & 1) === 0 ? OBJ_ICOSA : OBJ_OCTA;
  }
}

/**
 * Breadth-first distances in cells from (fromX, fromY) to every cell, written to
 * `out` (-1 where unreached). `queue` is scratch of at least GRID * GRID.
 */
export function distanceField(
  maze: Maze,
  fromX: number,
  fromY: number,
  out: Int16Array,
  queue: Int16Array,
): void {
  out.fill(-1);
  if (!inside(maze, fromX, fromY)) {
    return;
  }
  let head = 0;
  let tail = 0;
  const s = cellIndex(fromX, fromY);
  out[s] = 0;
  queue[tail++] = s;
  while (head < tail) {
    const c = queue[head++];
    const x = c % GRID;
    const y = (c - x) / GRID;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR_X[d];
      const ny = y + DIR_Y[d];
      if (!isOpen(maze, x, y, d) || !inside(maze, nx, ny)) {
        continue;
      }
      const ni = cellIndex(nx, ny);
      if (out[ni] < 0) {
        out[ni] = out[c] + 1;
        queue[tail++] = ni;
      }
    }
  }
}

/** Which wall the walker keeps a hand on: -1 follows the right wall, +1 the left. */
export const handSign = (hand: string) => (hand === "left" ? 1 : -1);

/**
 * The wall follower's choice at cell (x, y) heading `dir`, as a turn in quarter
 * turns (+ is left): towards the followed wall if open, else straight, else away
 * from it, else turn around (away from the wall).
 */
export function chooseTurn(maze: Maze, x: number, y: number, dir: number, hand: number): number {
  if (isOpen(maze, x, y, (dir + hand + 4) & 3)) {
    return hand;
  }
  if (isOpen(maze, x, y, dir)) {
    return 0;
  }
  if (isOpen(maze, x, y, (dir - hand + 4) & 3)) {
    return -hand;
  }
  return -2 * hand;
}

// --- Motion limits ---

/**
 * Repeat of the wall, floor and ceiling patterns along a surface, in cells: the
 * brick and board length, and the flagstone and ceiling-tile size.
 */
export const PATTERN_PERIOD = 0.5;
/** Height of a brick, stone or board course, in cells. */
export const COURSE_HEIGHT = 0.25;
/**
 * The distance, in cells, the turn and roll limits are measured at: the nearest
 * floor and ceiling in view (the bottom of the frame looks down to 1 cell ahead)
 * and about the nearest wall swept past in a turn. Nearer patterns appear larger
 * and so cross a point less often.
 */
export const REF_DISTANCE = 1;
/** Focal length in frame heights: the frame spans 0.5 cell either side at 1 cell. */
export const FOCAL = 1;
/** Peak over mean rate of a smoothstep ease (3x^2 - 2x^3 peaks at slope 1.5). */
export const EASE_PEAK = 1.5;
/** Seconds per cell and per quarter turn at a pace of 1, before the motion caps. */
const WALK_SECONDS = 1.5;
const TURN_SECONDS = 0.8;
/** Seconds the walker stands looking at the start sign before setting off. */
const HOLD_SECONDS = 1.5;
/** The upside-down roll: at least this long, longer if the motion limit needs it. */
const ROLL_MIN_SECONDS = 2;
/**
 * Frame-height radius from the centre at which the roll limit is measured: where
 * the wall at REF_DISTANCE sits (it spans half a frame height either side).
 */
export const ROLL_REF_RADIUS = 0.5;

const clampSpeed = (speed: number) =>
  Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number.isFinite(speed) ? speed : 1));

/**
 * Seconds to walk one cell at `speed`, eased in and out: the peak pace keeps
 * bricks, flagstones and tiles passing a point at most MAX_PATTERN_HZ times a
 * second (walking along a wall, its pattern passes at the walking pace whatever
 * the distance).
 */
export function walkSeconds(speed: number): number {
  const peak = capPatternSpeed((EASE_PEAK * clampSpeed(speed)) / WALK_SECONDS, PATTERN_PERIOD);
  return EASE_PEAK / peak;
}

/**
 * Seconds per quarter turn at `speed`: the peak turn rate sweeps the wall
 * pattern at REF_DISTANCE (angular period PATTERN_PERIOD / REF_DISTANCE radians)
 * past a point at most MAX_PATTERN_HZ times a second. This, not the pace, sets
 * the turn time at the default pace and above.
 */
export function turnSeconds(speed: number): number {
  const quarter = Math.PI / 2;
  const peak = capPatternSpeed(
    (EASE_PEAK * quarter * clampSpeed(speed)) / TURN_SECONDS,
    PATTERN_PERIOD / REF_DISTANCE,
  );
  return (EASE_PEAK * quarter) / peak;
}

/**
 * Seconds for the half-turn roll: the courses of the wall at REF_DISTANCE
 * (COURSE_HEIGHT * FOCAL / REF_DISTANCE frame heights apart) cross a point at
 * ROLL_REF_RADIUS at most MAX_PATTERN_HZ times a second.
 */
export const ROLL_SECONDS = Math.max(
  ROLL_MIN_SECONDS,
  (EASE_PEAK * Math.PI * ROLL_REF_RADIUS) /
    (MAX_PATTERN_HZ * ((COURSE_HEIGHT * FOCAL) / REF_DISTANCE)),
);

// --- The walker ---

const SEG_HOLD = 0;
const SEG_TURN = 1;
export const SEG_WALK = 2;
/** Out through the doorway: the walk is over. */
export const SEG_DONE = 3;

interface Walker {
  /** Current cell (the one a walk leaves from). */
  cx: number;
  cy: number;
  /** Heading, 0..3; during a turn, the heading it turns to. */
  dir: number;
  kind: number;
  /** 0..1 through the current segment. */
  progress: number;
  /** Quarter turns of the current turn (+ is left). */
  turn: number;
  /** Turn planned for the cell a walk arrives at, chosen as the walk starts. */
  nextTurn: number;
  /** Whether the current walk speeds up from rest and slows to rest. */
  easeIn: boolean;
  easeOut: boolean;
  /** Walks started so far; the effect watches it to see a new step begin. */
  walks: number;
  /** The camera pose: position in cells and heading in radians (unwrapped). */
  x: number;
  y: number;
  angle: number;
}

export function createWalker(): Walker {
  const w: Walker = {
    cx: 0,
    cy: 0,
    dir: 2,
    kind: SEG_HOLD,
    progress: 0,
    turn: 0,
    nextTurn: 0,
    easeIn: true,
    easeOut: true,
    walks: 0,
    x: 0.5,
    y: 0.5,
    angle: Math.PI,
  };
  return w;
}

/** Puts the walker in the start cell, facing the start sign on its west wall. */
export function resetWalker(w: Walker): void {
  w.cx = 0;
  w.cy = 0;
  w.dir = 2;
  w.kind = SEG_HOLD;
  w.progress = 0;
  w.turn = 0;
  w.nextTurn = 0;
  w.easeIn = true;
  w.easeOut = true;
  updatePose(w);
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Fraction of a cell walked at `t`: smoothstep when starting and stopping, a
 * cubic that starts from rest and leaves at the cruising rate (and its mirror)
 * when only one end stops, and a straight line when cruising through.
 */
export function walkEase(t: number, easeIn: boolean, easeOut: boolean): number {
  if (easeIn && easeOut) {
    return smooth(t);
  }
  if (easeIn) {
    return t * t * (2 - t);
  }
  if (easeOut) {
    const u = 1 - t;
    return 1 - u * u * (2 - u);
  }
  return t;
}

function updatePose(w: Walker): void {
  const q = Math.PI / 2;
  const cx = w.cx + 0.5;
  const cy = w.cy + 0.5;
  if (w.kind === SEG_TURN) {
    w.x = cx;
    w.y = cy;
    w.angle = (w.dir - w.turn + w.turn * smooth(w.progress)) * q;
  } else if (w.kind === SEG_WALK) {
    const s = walkEase(w.progress, w.easeIn, w.easeOut);
    w.x = cx + DIR_X[w.dir] * s;
    w.y = cy + DIR_Y[w.dir] * s;
    w.angle = w.dir * q;
  } else {
    w.x = cx;
    w.y = cy;
    w.angle = w.dir * q;
  }
}

/** Starts a walk from the current cell along the heading, planning the turn after it. */
function startWalk(w: Walker, maze: Maze, hand: number, easeIn: boolean): void {
  const nx = w.cx + DIR_X[w.dir];
  const ny = w.cy + DIR_Y[w.dir];
  const out = !inside(maze, nx, ny);
  w.nextTurn = out ? 0 : chooseTurn(maze, nx, ny, w.dir, hand);
  w.kind = SEG_WALK;
  w.easeIn = easeIn;
  w.easeOut = out || w.nextTurn !== 0;
  w.walks++;
}

/** Starts a turn (if `turn` is non-zero) or a walk from the current cell. */
function startMove(w: Walker, maze: Maze, hand: number, turn: number, fromWalk: boolean): void {
  if (turn !== 0) {
    w.kind = SEG_TURN;
    w.turn = turn;
    w.dir = (w.dir + turn + 4) & 3;
  } else {
    startWalk(w, maze, hand, !fromWalk);
  }
}

/** Ends the current segment and starts the next. */
function nextSegment(w: Walker, maze: Maze, hand: number): void {
  w.progress = 0;
  if (w.kind === SEG_HOLD) {
    startMove(w, maze, hand, chooseTurn(maze, w.cx, w.cy, w.dir, hand), false);
  } else if (w.kind === SEG_TURN) {
    startWalk(w, maze, hand, true);
  } else if (w.kind === SEG_WALK) {
    w.cx += DIR_X[w.dir];
    w.cy += DIR_Y[w.dir];
    if (!inside(maze, w.cx, w.cy)) {
      w.kind = SEG_DONE;
      return;
    }
    startMove(w, maze, hand, w.nextTurn, true);
  }
}

/**
 * Advances the walker by `dt` seconds with the given hand (`handSign`) and
 * segment times, carrying leftover time into the following segments, and
 * updates its pose. Stops once out of the exit (`kind === SEG_DONE`).
 */
export function advanceWalker(
  w: Walker,
  maze: Maze,
  dt: number,
  hand: number,
  walkTime: number,
  turnTime: number,
): void {
  let left = Math.max(0, dt);
  // A handful of segments per frame at most; the cap only guards odd inputs.
  for (let i = 0; i < 16 && w.kind !== SEG_DONE; i++) {
    const dur =
      w.kind === SEG_HOLD
        ? HOLD_SECONDS
        : w.kind === SEG_TURN
          ? turnTime * Math.abs(w.turn)
          : walkTime;
    const remaining = (1 - w.progress) * dur;
    if (left < remaining) {
      w.progress += left / dur;
      break;
    }
    left -= remaining;
    nextSegment(w, maze, hand);
  }
  updatePose(w);
}

/** The cell the walker is heading into during a walk (else its own cell), as an index or -1 outside. */
export function walkTarget(w: Walker, maze: Maze): number {
  const x = w.kind === SEG_WALK ? w.cx + DIR_X[w.dir] : w.cx;
  const y = w.kind === SEG_WALK ? w.cy + DIR_Y[w.dir] : w.cy;
  return inside(maze, x, y) ? cellIndex(x, y) : -1;
}

// --- The rat ---

/** Rat pace in cells per second: small and grey, so it can scurry. */
const RAT_SPEED = 0.9;
/** Beyond this many cells from the walker, the rat mostly heads towards it. */
const RAT_NEAR = 4;

interface Rat {
  cx: number;
  cy: number;
  dir: number;
  /** 0..1 along the move to the next cell; ignored while paused. */
  progress: number;
  moving: boolean;
  /** Seconds left to sit still. */
  pause: number;
  x: number;
  y: number;
  readonly rng: () => number;
}

export function createRat(seed: number): Rat {
  return {
    cx: 0,
    cy: 0,
    dir: 0,
    progress: 0,
    moving: false,
    pause: 0,
    x: 0.5,
    y: 0.5,
    rng: createRng(hash32(Math.floor(seed) ^ 0x2a7c15e3)),
  };
}

/**
 * Puts the rat in the cell whose distance from the start (`dist`, from
 * `distanceField`) is closest to a few cells, so it is met early.
 */
export function placeRat(rat: Rat, maze: Maze, dist: Int16Array): void {
  let best = cellIndex(0, 0);
  let bestErr = Infinity;
  for (let y = 0; y < maze.size; y++) {
    for (let x = 0; x < maze.size; x++) {
      const i = cellIndex(x, y);
      const err = Math.abs(dist[i] - 6) + rat.rng() * 0.5;
      if (dist[i] >= 0 && err < bestErr) {
        best = i;
        bestErr = err;
      }
    }
  }
  rat.cx = best % GRID;
  rat.cy = (best - rat.cx) / GRID;
  rat.moving = false;
  rat.pause = 1;
  rat.x = rat.cx + 0.5;
  rat.y = rat.cy + 0.5;
}

/** Picks the rat's next move at a cell centre, or pauses if it has nowhere to go. */
function ratChoose(rat: Rat, maze: Maze, dist: Int16Array, blocked: number): void {
  const here = cellIndex(rat.cx, rat.cy);
  const towards = dist[here] > RAT_NEAR && rat.rng() < 0.75;
  let count = 0;
  let pick = -1;
  let bestDist = Infinity;
  for (let k = 0; k < 4; k++) {
    // Start from the heading after the current one, so ties don't always favour east.
    const d = (k + rat.dir + 1) & 3;
    const nx = rat.cx + DIR_X[d];
    const ny = rat.cy + DIR_Y[d];
    if (!isOpen(maze, rat.cx, rat.cy, d) || !inside(maze, nx, ny)) {
      continue;
    }
    const ni = cellIndex(nx, ny);
    if (ni === blocked || d === ((rat.dir + 2) & 3)) {
      continue;
    }
    count++;
    if (towards) {
      if (dist[ni] >= 0 && dist[ni] < bestDist) {
        bestDist = dist[ni];
        pick = d;
      }
    } else if (rat.rng() * count < 1) {
      pick = d;
    }
  }
  if (pick < 0) {
    // Dead end (or the walker ahead): turn back unless that is blocked too.
    const back = (rat.dir + 2) & 3;
    const bi = cellIndex(rat.cx + DIR_X[back], rat.cy + DIR_Y[back]);
    if (isOpen(maze, rat.cx, rat.cy, back) && bi !== blocked) {
      pick = back;
    }
  }
  if (pick < 0) {
    rat.pause = 0.5;
    return;
  }
  rat.dir = pick;
  rat.moving = true;
  rat.progress = 0;
  // Now and then it stops to sniff at the next cell.
  if (rat.rng() < 0.15) {
    rat.pause = 0.5 + 1.5 * rat.rng();
  }
}

/**
 * Moves the rat at RAT_SPEED, picking a new passage at each cell centre: towards
 * the walker (`dist` from the walker's cell) while far from it, at random when
 * near, and never into the walker's cell (`blocked`).
 */
export function advanceRat(
  rat: Rat,
  maze: Maze,
  dt: number,
  dist: Int16Array,
  blocked: number,
): void {
  let left = Math.max(0, dt);
  for (let i = 0; i < 8 && left > 0; i++) {
    if (rat.pause > 0) {
      const p = Math.min(rat.pause, left);
      rat.pause -= p;
      left -= p;
      continue;
    }
    if (!rat.moving) {
      ratChoose(rat, maze, dist, blocked);
      continue;
    }
    const remaining = (1 - rat.progress) / RAT_SPEED;
    if (left < remaining) {
      rat.progress += left * RAT_SPEED;
      left = 0;
    } else {
      left -= remaining;
      rat.cx += DIR_X[rat.dir];
      rat.cy += DIR_Y[rat.dir];
      rat.moving = false;
      rat.progress = 0;
    }
  }
  const s = rat.moving ? rat.progress : 0;
  rat.x = rat.cx + 0.5 + DIR_X[rat.dir] * s;
  rat.y = rat.cy + 0.5 + DIR_Y[rat.dir] * s;
}
