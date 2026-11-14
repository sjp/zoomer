/**
 * The Backrooms' pure logic: an endless world of yellow office rooms generated a
 * chunk at a time from the seed, the wandering walker whose camera pose the
 * shader draws from, the window of cells uploaded around the camera, and the
 * flicker schedule of the ceiling's light panels.
 *
 * Everything works in cell units on the shared grid of `grid-walk.ts`: cell
 * (x, y) covers [x, x + 1] x [y, y + 1], y points north. A cell is two ceiling
 * tiles wide. A cell is open floor, a solid block of wall, or open floor with a
 * square pillar in the middle; the walker treats pillars as blocked.
 *
 * The world is split into chunks of CHUNK x CHUNK cells. Each chunk owns its west
 * and south edge, a line of wall broken by doorways placed by a hash of the edge,
 * so both chunks beside an edge agree on them without generating each other.
 * Inside, a seeded jumble of partitions, wall blocks and pillars is carved so
 * that every doorway's cell is open, they all connect, and no open cell is a
 * dead end: every open cell has at least two open neighbours, so a walker that
 * never turns back always has somewhere to go.
 */
import {
  DIR_X,
  DIR_Y,
  easedMoveSeconds,
  type GridPose,
  SEG_TURN,
  SEG_WALK,
  updateGridPose,
} from "../grid-walk";
import { clamp } from "../math";
import { createRng, hash32 } from "../noise";
import { MAX_SPEED, MIN_SPEED } from "./backrooms.meta";

export const OPEN = 0;
export const WALL = 1;
export const PILLAR = 2;

/** Cells along a side of a chunk. */
export const CHUNK = 8;
const CELLS = CHUNK * CHUNK;
/** Chunks along a side of the generated-chunk cache: any 8 x 8 block of chunks fits without clashes. */
const CACHE_SIDE = 8;
const CACHE_SLOTS = CACHE_SIDE * CACHE_SIDE;

/** Mixes the world seed, two integers and a salt into a 32-bit hash. */
function mix(seed: number, a: number, b: number, salt: number): number {
  return hash32(hash32(hash32(seed ^ salt) ^ a) + Math.imul(b, 0x9e3779b1));
}

/**
 * The doorways in a chunk edge, as bits 1..7 (position along the edge; 0 is the
 * corner, always wall): `axis` 0 is the west edge of chunk (cx, cy), 1 its south
 * edge. Never empty. Some edges are all doorway (rooms merge into halls), some
 * all but one stub of wall, the rest one or two doorways one to three cells wide.
 */
export function edgeDoors(seed: number, cx: number, cy: number, axis: number): number {
  let h = mix(seed, cx, cy, axis === 0 ? 0x27d4eb2f : 0x165667b1);
  const kind = h & 7;
  h = hash32(h);
  const all = 0xfe;
  if (kind === 0) {
    return all;
  }
  if (kind === 1) {
    return all & ~(1 << (2 + (h % 5)));
  }
  let mask = 0;
  const doors = 1 + ((h >>> 3) & 1);
  for (let d = 0; d < doors; d++) {
    h = hash32(h);
    const at = 1 + (h % 7);
    const width = 1 + ((h >>> 8) % 3);
    for (let k = 0; k < width && at + k < CHUNK; k++) {
      mask |= 1 << (at + k);
    }
  }
  return mask;
}

export interface World {
  /** The 32-bit seed every hash derives from. */
  seed: number;
  /** Chunk coordinates held by each cache slot, and whether the slot is filled. */
  readonly keyX: Int32Array;
  readonly keyY: Int32Array;
  readonly filled: Uint8Array;
  /** CELLS kinds per slot, index `ly * CHUNK + lx`. */
  readonly cells: Uint8Array;
  /** Generation scratch. */
  readonly required: Uint8Array;
  readonly reached: Uint8Array;
  readonly stack: Int8Array;
}

const worldSeed = (seed: number) =>
  hash32(Math.floor(Number.isFinite(seed) ? seed : 0) ^ 0x6a09e667);

export function createWorld(seed: number): World {
  return {
    seed: worldSeed(seed),
    keyX: new Int32Array(CACHE_SLOTS),
    keyY: new Int32Array(CACHE_SLOTS),
    filled: new Uint8Array(CACHE_SLOTS),
    cells: new Uint8Array(CACHE_SLOTS * CELLS),
    required: new Uint8Array(CELLS),
    reached: new Uint8Array(CELLS),
    stack: new Int8Array(CELLS),
  };
}

/** Switches the world to another variation, forgetting every generated chunk. */
export function reseedWorld(world: World, seed: number): void {
  world.seed = worldSeed(seed);
  world.filled.fill(0);
}

const local = (x: number, y: number) => y * CHUNK + x;

/**
 * Whether local cell (lx, ly), lx and ly in 0..CHUNK, is open floor, given the
 * kinds generated so far. Column and row CHUNK are the east and north
 * neighbours' doorway edges.
 */
function passable(
  cells: Uint8Array,
  base: number,
  east: number,
  north: number,
  lx: number,
  ly: number,
): boolean {
  if (lx === CHUNK) {
    return ((east >> ly) & 1) !== 0;
  }
  if (ly === CHUNK) {
    return ((north >> lx) & 1) !== 0;
  }
  return cells[base + local(lx, ly)] === OPEN;
}

/** Interior cells reachable from (sx, sy) over open floor, flagged in `world.reached`. */
function flood(world: World, base: number, sx: number, sy: number): void {
  const { cells, reached, stack } = world;
  reached.fill(0);
  let top = 0;
  reached[local(sx, sy)] = 1;
  stack[top++] = local(sx, sy);
  while (top > 0) {
    const c = stack[--top];
    const x = c % CHUNK;
    const y = (c - x) / CHUNK;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR_X[d];
      const ny = y + DIR_Y[d];
      if (nx < 1 || ny < 1 || nx >= CHUNK || ny >= CHUNK) {
        continue;
      }
      const n = local(nx, ny);
      if (reached[n] === 0 && cells[base + n] === OPEN) {
        reached[n] = 1;
        stack[top++] = n;
      }
    }
  }
}

/** Sets an interior line of wall from `from` to `to` (inclusive) at `at`, across or along. */
function wallLine(
  cells: Uint8Array,
  base: number,
  vertical: boolean,
  at: number,
  from: number,
  to: number,
): void {
  for (let k = from; k <= to; k++) {
    cells[base + (vertical ? local(at, k) : local(k, at))] = WALL;
  }
}

/** Generates chunk (cx, cy) into cache slot `slot`. */
function generateChunk(world: World, slot: number, cx: number, cy: number): void {
  const { cells, required, reached, seed } = world;
  const base = slot * CELLS;
  const west = edgeDoors(seed, cx, cy, 0);
  const south = edgeDoors(seed, cx, cy, 1);
  const east = edgeDoors(seed, cx + 1, cy, 0);
  const north = edgeDoors(seed, cx, cy + 1, 1);
  const rng = createRng(mix(seed, cx, cy, 0x3c6ef372));
  const pick = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

  cells.fill(OPEN, base, base + CELLS);
  for (let p = 0; p < CHUNK; p++) {
    cells[base + local(0, p)] = ((west >> p) & 1) !== 0 ? OPEN : WALL;
    cells[base + local(p, 0)] = ((south >> p) & 1) !== 0 ? OPEN : WALL;
  }
  // Partitions: whole or part lines of wall across the chunk, with a doorway in the long ones.
  const partitions = pick(1, 3);
  for (let i = 0; i < partitions; i++) {
    const vertical = rng() < 0.5;
    const at = pick(2, CHUNK - 2);
    const from = rng() < 0.5 ? 1 : pick(1, 4);
    const to = Math.min(CHUNK - 1, from + pick(1, 6));
    wallLine(cells, base, vertical, at, from, to);
    if (to - from >= 3) {
      const gap = pick(from, to - 1);
      const width = pick(1, 2);
      for (let k = gap; k < gap + width && k <= to; k++) {
        cells[base + (vertical ? local(at, k) : local(k, at))] = OPEN;
      }
    }
  }
  // Odd blocks of wall, one or two cells.
  const blocks = pick(0, 2);
  for (let i = 0; i < blocks; i++) {
    const x = pick(1, CHUNK - 2);
    const y = pick(1, CHUNK - 2);
    cells[base + local(x, y)] = WALL;
    if (rng() < 0.5) {
      cells[base + (rng() < 0.5 ? local(x + 1, y) : local(x, y + 1))] = WALL;
    }
  }
  // Pillars, only where they stand free.
  const pillars = pick(0, 3);
  for (let i = 0; i < pillars; i++) {
    const x = pick(2, CHUNK - 2);
    const y = pick(2, CHUNK - 2);
    let free = cells[base + local(x, y)] === OPEN;
    for (let d = 0; d < 4 && free; d++) {
      free = cells[base + local(x + DIR_X[d], y + DIR_Y[d])] === OPEN;
    }
    if (free) {
      cells[base + local(x, y)] = PILLAR;
    }
  }

  // The cells inside each doorway must be open floor.
  required.fill(0);
  let firstX = -1;
  let firstY = -1;
  for (let side = 0; side < 4; side++) {
    const mask = side === 0 ? west : side === 1 ? south : side === 2 ? east : north;
    for (let p = 1; p < CHUNK; p++) {
      if (((mask >> p) & 1) === 0) {
        continue;
      }
      const x = side === 0 ? 1 : side === 2 ? CHUNK - 1 : p;
      const y = side === 1 ? 1 : side === 3 ? CHUNK - 1 : p;
      required[local(x, y)] = 1;
      cells[base + local(x, y)] = OPEN;
      if (firstX < 0) {
        firstX = x;
        firstY = y;
      }
    }
  }
  // Connect every doorway to the first: carve an L-shaped path to any cut off.
  flood(world, base, firstX, firstY);
  for (let c = 0; c < CELLS; c++) {
    if (required[c] === 0 || reached[c] !== 0) {
      continue;
    }
    let x = c % CHUNK;
    let y = (c - x) / CHUNK;
    while (x !== firstX || y !== firstY) {
      cells[base + local(x, y)] = OPEN;
      if (x !== firstX) {
        x += Math.sign(firstX - x);
      } else {
        y += Math.sign(firstY - y);
      }
    }
    flood(world, base, firstX, firstY);
  }
  // Pockets left cut off become wall.
  for (let y = 1; y < CHUNK; y++) {
    for (let x = 1; x < CHUNK; x++) {
      const c = local(x, y);
      if (reached[c] === 0 && cells[base + c] === OPEN) {
        cells[base + c] = WALL;
      }
    }
  }
  // Fill dead ends until none are left (filling one can make its neighbour one).
  for (let changed = true; changed;) {
    changed = false;
    for (let y = 1; y < CHUNK; y++) {
      for (let x = 1; x < CHUNK; x++) {
        const c = local(x, y);
        if (required[c] !== 0 || cells[base + c] !== OPEN) {
          continue;
        }
        let ways = 0;
        for (let d = 0; d < 4; d++) {
          ways += passable(cells, base, east, north, x + DIR_X[d], y + DIR_Y[d]) ? 1 : 0;
        }
        if (ways < 2) {
          cells[base + c] = WALL;
          changed = true;
        }
      }
    }
  }
}

/** The kind (OPEN, WALL or PILLAR) of world cell (x, y), generating its chunk if need be. */
export function cellKind(world: World, x: number, y: number): number {
  const cx = Math.floor(x / CHUNK);
  const cy = Math.floor(y / CHUNK);
  const slot = (cx & (CACHE_SIDE - 1)) + (cy & (CACHE_SIDE - 1)) * CACHE_SIDE;
  if (world.filled[slot] === 0 || world.keyX[slot] !== cx || world.keyY[slot] !== cy) {
    generateChunk(world, slot, cx, cy);
    world.keyX[slot] = cx;
    world.keyY[slot] = cy;
    world.filled[slot] = 1;
  }
  return world.cells[slot * CELLS + local(x - cx * CHUNK, y - cy * CHUNK)];
}

export const isOpen = (world: World, x: number, y: number) => cellKind(world, x, y) === OPEN;

/** No light panel above the cell. */
export const PANEL_NONE = 0;
/** A dead panel: the tube is out. */
export const PANEL_DEAD = 1;
export const PANEL_LIT = 2;

/** A panel hangs over every open cell whose coordinates are both even; one in 14 is dead. */
export function panelAt(world: World, x: number, y: number): number {
  if ((x & 1) !== 0 || (y & 1) !== 0 || !isOpen(world, x, y)) {
    return PANEL_NONE;
  }
  return mix(world.seed, x, y, 0x510e527f) % 14 === 0 ? PANEL_DEAD : PANEL_LIT;
}

// --- The window of cells around the camera ---

/** Chunks along a side of the window uploaded to the shader; the camera is in the middle one. */
const WINDOW_CHUNKS = 5;
/** Cells along a side of the window. */
export const WINDOW = WINDOW_CHUNKS * CHUNK;
/**
 * The furthest the view reaches, in cells: the camera's chunk is the middle
 * one, so the window holds every cell this far from it.
 */
export const VIEW_REACH = ((WINDOW_CHUNKS - 1) / 2) * CHUNK;

/** The window's south-west cell on one axis for a camera at `c`: a chunk corner. */
export const windowOrigin = (c: number) =>
  (Math.floor(Math.floor(c) / CHUNK) - (WINDOW_CHUNKS - 1) / 2) * CHUNK;

/**
 * Writes the window of WINDOW x WINDOW cells from (ox, oy) as RGBA bytes, row by
 * row from the south: r the kind, g the panel above (`PANEL_*`).
 */
export function fillWindow(world: World, ox: number, oy: number, out: Uint8Array): void {
  for (let y = 0; y < WINDOW; y++) {
    for (let x = 0; x < WINDOW; x++) {
      const o = (y * WINDOW + x) * 4;
      out[o] = cellKind(world, ox + x, oy + y);
      out[o + 1] = panelAt(world, ox + x, oy + y);
      out[o + 2] = 0;
      out[o + 3] = 0;
    }
  }
}

// --- Motion limits ---

/**
 * Repeat of the patterns along every surface, in cells: the ceiling tiles and
 * the wallpaper's stripes and chevrons are half a cell across. The carpet's
 * noise has no repeat and is softer.
 */
export const PATTERN_PERIOD = 0.5;
/**
 * The distance, in cells, the turn limit is measured at: about the nearest wall
 * swept past in a turn. Nearer patterns appear larger and cross a point less
 * often; further ones are filtered out as they shrink and fade into the haze.
 */
export const REF_DISTANCE = 1;
/** Seconds per cell and per quarter turn at a pace of 1, before the motion caps. */
const WALK_SECONDS = 0.8;
const TURN_SECONDS = 1.6;

const clampSpeed = (speed: number) =>
  clamp(Number.isFinite(speed) ? speed : 1, MIN_SPEED, MAX_SPEED);

/**
 * Seconds to walk a cell at `speed`, eased in and out: the peak pace keeps the
 * tiles and wallpaper passing a point at most MAX_PATTERN_HZ times a second.
 */
export const walkSeconds = (speed: number) =>
  easedMoveSeconds(1, clampSpeed(speed) / WALK_SECONDS, PATTERN_PERIOD);

/**
 * Seconds per quarter turn at `speed`: the peak turn rate sweeps the wallpaper
 * at REF_DISTANCE past a point at most MAX_PATTERN_HZ times a second.
 */
export function turnSeconds(speed: number): number {
  const quarter = Math.PI / 2;
  return easedMoveSeconds(
    quarter,
    (quarter * clampSpeed(speed)) / TURN_SECONDS,
    PATTERN_PERIOD / REF_DISTANCE,
  );
}

// --- The walker ---

/** Odds of each choice at a cell where it is open: straight on, and each side. */
const STRAIGHT_WEIGHT = 5;
const SIDE_WEIGHT = 1;

interface Walker extends GridPose {
  /** Turn planned for the cell a walk arrives at, chosen as the walk starts. */
  nextTurn: number;
  /** Walks started so far. */
  walks: number;
  /** Total distance walked, in cells (for the head bob). */
  walked: number;
  rng: () => number;
}

export function createWalker(): Walker {
  return {
    cx: 0,
    cy: 0,
    dir: 0,
    kind: SEG_WALK,
    progress: 0,
    turn: 0,
    nextTurn: 0,
    easeIn: true,
    easeOut: false,
    walks: 0,
    walked: 0,
    x: 0.5,
    y: 0.5,
    angle: 0,
    rng: createRng(0),
  };
}

/**
 * The wanderer's choice at cell (x, y) heading `dir`, in quarter turns (+ is
 * left): straight on or to either side into open floor, mostly straight on.
 * Never back the way it came, unless there is no other way (the world has no
 * dead ends, so only in a world built otherwise).
 */
function chooseTurn(w: Walker, world: World, x: number, y: number, dir: number): number {
  const ahead = isOpen(world, x + DIR_X[dir], y + DIR_Y[dir]) ? STRAIGHT_WEIGHT : 0;
  const left = (dir + 1) & 3;
  const right = (dir + 3) & 3;
  const l = isOpen(world, x + DIR_X[left], y + DIR_Y[left]) ? SIDE_WEIGHT : 0;
  const r = isOpen(world, x + DIR_X[right], y + DIR_Y[right]) ? SIDE_WEIGHT : 0;
  const total = ahead + l + r;
  if (total === 0) {
    return 2;
  }
  const u = w.rng() * total;
  return u < ahead ? 0 : u < ahead + l ? 1 : -1;
}

/** Starts a walk from the current cell along the heading, planning the turn after it. */
function startWalk(w: Walker, world: World, easeIn: boolean): void {
  w.nextTurn = chooseTurn(w, world, w.cx + DIR_X[w.dir], w.cy + DIR_Y[w.dir], w.dir);
  w.kind = SEG_WALK;
  w.progress = 0;
  w.easeIn = easeIn;
  w.easeOut = w.nextTurn !== 0;
  w.walks++;
}

/** Headings tried for the first walk, in order: on through the doorway first. */
const START_HEADINGS = [0, 1, 3, 2] as const;

/**
 * Puts the walker in the world's first doorway cell (always open), facing open
 * floor, and sets off from rest with its own seeded choices.
 */
export function resetWalker(w: Walker, world: World): void {
  const doors = edgeDoors(world.seed, 0, 0, 0);
  // The lowest doorway in the west edge of chunk (0, 0).
  const p = 31 - Math.clz32(doors & -doors);
  w.cx = 1;
  w.cy = p;
  w.rng = createRng(hash32(world.seed ^ 0x1f83d9ab));
  w.dir = 0;
  for (const d of START_HEADINGS) {
    if (isOpen(world, w.cx + DIR_X[d], w.cy + DIR_Y[d])) {
      w.dir = d;
      break;
    }
  }
  w.turn = 0;
  w.walks = 0;
  startWalk(w, world, true);
  updateGridPose(w);
}

/** Ends the current segment and starts the next. */
function nextSegment(w: Walker, world: World): void {
  if (w.kind === SEG_TURN) {
    startWalk(w, world, true);
    return;
  }
  w.cx += DIR_X[w.dir];
  w.cy += DIR_Y[w.dir];
  if (w.nextTurn === 0) {
    startWalk(w, world, false);
    return;
  }
  w.kind = SEG_TURN;
  w.progress = 0;
  w.turn = w.nextTurn;
  w.dir = (w.dir + w.nextTurn + 4) & 3;
}

/**
 * Advances the walker by `dt` seconds with the given segment times, carrying
 * leftover time into the following segments, and updates its pose.
 */
export function advanceWalker(
  w: Walker,
  world: World,
  dt: number,
  walkTime: number,
  turnTime: number,
): void {
  let left = Math.max(0, dt);
  const x0 = w.x;
  const y0 = w.y;
  // A handful of segments per frame at most; the cap only guards odd inputs.
  for (let i = 0; i < 16; i++) {
    const dur = w.kind === SEG_TURN ? turnTime * Math.abs(w.turn) : walkTime;
    const remaining = (1 - w.progress) * dur;
    if (left < remaining) {
      w.progress += left / dur;
      break;
    }
    left -= remaining;
    nextSegment(w, world);
  }
  updateGridPose(w);
  w.walked += Math.hypot(w.x - x0, w.y - y0);
}

// --- Flickering panels ---

/** Panels flickering at once, at most. */
export const MAX_FLICKERS = 2;
/** Flicker events per second per slot at a flicker of 1. */
const EVENT_RATE = 1 / 8;
/** How far from the camera, in cells, a flickering panel may be. */
const FLICKER_REACH = 6;
/** Dims: duration and depth ranges. */
const DIM_SECONDS = [2, 3] as const;
const DIM_DEPTH = [0.45, 0.75] as const;
/** Buzzes: duration, mean dimming, wobble and fade in and out. */
const BUZZ_SECONDS = [3, 5] as const;
const BUZZ_DEPTH = 0.4;
const BUZZ_WOBBLE = 0.08;
const BUZZ_EDGE = 0.7;
/** The wobble's two rates, Hz: slow enough never to strobe. */
const BUZZ_HZ_A = 1.1;
const BUZZ_HZ_B = 1.7;

interface FlickerSlot {
  active: boolean;
  /** World cell of the panel. */
  x: number;
  y: number;
  buzz: boolean;
  /** Seconds into the event, and its length. */
  t: number;
  duration: number;
  depth: number;
  phaseA: number;
  phaseB: number;
  /** Progress towards the next event, and the progress that starts it. */
  wait: number;
  due: number;
}

export interface Flicker {
  readonly slots: FlickerSlot[];
  rng: () => number;
}

export function createFlicker(seed: number): Flicker {
  const rng = createRng(hash32(Math.floor(seed) ^ 0x9b05688c));
  const slots: FlickerSlot[] = [];
  for (let i = 0; i < MAX_FLICKERS; i++) {
    slots.push({
      active: false,
      x: 0,
      y: 0,
      buzz: false,
      t: 0,
      duration: 1,
      depth: 0,
      phaseA: 0,
      phaseB: 0,
      wait: 0,
      // The slots start staggered, so the first events don't come together.
      due: (i + 0.5 + rng()) / MAX_FLICKERS,
    });
  }
  return { slots, rng };
}

const lerp = (range: readonly [number, number], u: number) => range[0] + (range[1] - range[0]) * u;

/** Brightness of a slot's panel, 0..1 of full: 1 when the slot is idle. */
export function flickerLevel(s: FlickerSlot): number {
  if (!s.active) {
    return 1;
  }
  const u = clamp(s.t / s.duration, 0, 1);
  if (!s.buzz) {
    const b = Math.sin(Math.PI * u);
    return 1 - s.depth * b * b;
  }
  const edge = Math.min(s.t, s.duration - s.t) / BUZZ_EDGE;
  const e = clamp(edge, 0, 1);
  const env = e * e * (3 - 2 * e);
  const wobble =
    0.6 * Math.sin(2 * Math.PI * BUZZ_HZ_A * s.t + s.phaseA) +
    0.4 * Math.sin(2 * Math.PI * BUZZ_HZ_B * s.t + s.phaseB);
  return 1 - env * (BUZZ_DEPTH + BUZZ_WOBBLE * wobble);
}

/** Starts an event on a lit panel near (camX, camY) not already flickering; false if none was found. */
function startEvent(f: Flicker, s: FlickerSlot, world: World, camX: number, camY: number): boolean {
  const reach = FLICKER_REACH / 2;
  const x = 2 * Math.round(camX / 2 + (f.rng() * 2 - 1) * reach);
  const y = 2 * Math.round(camY / 2 + (f.rng() * 2 - 1) * reach);
  if (panelAt(world, x, y) !== PANEL_LIT) {
    return false;
  }
  for (const o of f.slots) {
    if (o !== s && o.active && o.x === x && o.y === y) {
      return false;
    }
  }
  s.active = true;
  s.x = x;
  s.y = y;
  s.t = 0;
  s.buzz = f.rng() < 0.4;
  s.duration = s.buzz ? lerp(BUZZ_SECONDS, f.rng()) : lerp(DIM_SECONDS, f.rng());
  s.depth = lerp(DIM_DEPTH, f.rng());
  s.phaseA = f.rng() * Math.PI * 2;
  s.phaseB = f.rng() * Math.PI * 2;
  return true;
}

/**
 * Runs the flicker schedule for `dt` seconds: each slot's event plays out, then
 * the slot waits for its next at a rate set by `amount` (0 never starts one),
 * on a lit panel near the camera.
 */
export function advanceFlicker(
  f: Flicker,
  world: World,
  dt: number,
  amount: number,
  camX: number,
  camY: number,
): void {
  const step = Math.max(0, dt);
  const rate = clamp(Number.isFinite(amount) ? amount : 0, 0, 1) * EVENT_RATE;
  for (const s of f.slots) {
    if (s.active) {
      s.t += step;
      if (s.t >= s.duration) {
        s.active = false;
        s.wait = 0;
        s.due = 0.5 + f.rng();
      }
      continue;
    }
    s.wait += step * rate;
    if (s.wait >= s.due && !startEvent(f, s, world, camX, camY)) {
      // No lit panel there: look again a little later.
      s.wait = s.due - 0.05;
    }
  }
}
