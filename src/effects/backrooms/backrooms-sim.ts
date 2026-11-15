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
 * dead end: every open cell has at least two open neighbours.
 *
 * Through it all runs the route the walker follows: long straight legs of six
 * to eleven chunks down the middle row or column of each chunk, joined by wide
 * curves, turning left and right by turns so it never doubles back. The cells
 * it passes are always open: lined-up doorways through the rooms, a corridor
 * now and then, an open pillared hall now and then, and a hall at every bend.
 */
import { DIR_X, DIR_Y } from "../grid-walk";
import { approach, clamp, smoothstep } from "../math";
import { capPatternSpeed, EASE_PEAK, MAX_PATTERN_HZ } from "../motion-limits";
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
 * The seeded doorways in a chunk edge, as bits 1..7 (position along the edge; 0
 * is the corner, always wall): `axis` 0 is the west edge of chunk (cx, cy), 1
 * its south edge. Never empty. Some edges are all doorway (rooms merge into
 * halls), some all but one stub of wall, the rest one or two doorways one to
 * three cells wide.
 */
function seededDoors(seed: number, cx: number, cy: number, axis: number): number {
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

// --- The route ---

/** The route's row or column within a chunk. */
const LANE = CHUNK / 2;
/** Leg lengths, in chunks: a minute or two of walking at the default pace. */
const LEG_MIN = 6;
const LEG_MAX = 11;

/** What a chunk is along the route (`LaneInfo.style`). */
export const STYLE_NONE = 0;
/** The route passes through rooms, by doorways lined up along it. */
export const STYLE_ROOMS = 1;
/** A corridor walled along both sides, with the odd opening. */
export const STYLE_CORRIDOR = 2;
/** An open hall with a few pillars; every bend is one. */
export const STYLE_HALL = 3;

/** A chunk's place on the route, in world headings. */
interface LaneInfo {
  style: number;
  /** Whether the route bends here, from heading `dirIn` to `dirOut`. */
  corner: boolean;
  dirIn: number;
  dirOut: number;
  /** Headings by which the route leaves the chunk, as bits 1 << heading. */
  exits: number;
}

const NO_LANE: LaneInfo = { style: STYLE_NONE, corner: false, dirIn: 0, dirOut: 0, exits: 0 };

/**
 * The route is laid out in a canonical frame, heading east first then turning
 * north, east, north and so on, and turned into the world by one of the eight
 * orientations of the square (`World.orient`: quarter turns in bits 0-1, a
 * mirror in y in bit 2), about the start chunk (0, 0).
 */
function orientDir(orient: number, d: number): number {
  return (((orient & 4) !== 0 ? 4 - d : d) + orient) & 3;
}

/** Turns a vector by `q` quarter turns anticlockwise. */
function turnVec(x: number, y: number, q: number): [number, number] {
  switch (q & 3) {
    case 1:
      return [-y, x];
    case 2:
      return [-x, -y];
    case 3:
      return [y, -x];
    default:
      return [x, y];
  }
}

/** A canonical vector into the world. */
function toWorld(orient: number, x: number, y: number): [number, number] {
  return turnVec(x, (orient & 4) !== 0 ? -y : y, orient);
}

/** A world vector into the canonical frame. */
function toCanonical(orient: number, x: number, y: number): [number, number] {
  const [u, v] = turnVec(x, y, -orient);
  return [u, (orient & 4) !== 0 ? -v : v];
}

/** Canonical heading of leg k: east for even legs, north for odd. */
const legDir = (k: number) => ((k & 1) === 0 ? 0 : 1);

/** Makes sure the route's corners up to index `k` are laid out. */
function extendRoute(world: World, k: number): void {
  const { routeU, routeV } = world;
  while (routeU.length <= k) {
    const leg = routeU.length - 1;
    const len = LEG_MIN + (mix(world.seed, leg, 0, 0x5be0cd19) % (LEG_MAX - LEG_MIN + 1));
    const east = legDir(leg) === 0;
    routeU.push(routeU[leg] + (east ? len : 0));
    routeV.push(routeV[leg] + (east ? 0 : len));
  }
}

/** The style of a straight stretch of the route through chunk (u, v), canonical. */
function straightStyle(seed: number, u: number, v: number): number {
  const h = mix(seed, u, v, 0x1f83d9ab) & 7;
  return h < 4 ? STYLE_ROOMS : h < 6 ? STYLE_CORRIDOR : STYLE_HALL;
}

/** The lane in chunk (u, v): a straight stretch heading canonical `d`, or a bend from `d` to `e`. */
function lane(world: World, u: number, v: number, d: number, e: number): LaneInfo {
  const o = world.orient;
  const dirIn = orientDir(o, d);
  const dirOut = orientDir(o, e);
  const corner = d !== e;
  return {
    style: corner ? STYLE_HALL : straightStyle(world.seed, u, v),
    corner,
    dirIn,
    dirOut,
    exits: (1 << ((dirIn + 2) & 3)) | (1 << dirOut),
  };
}

/**
 * The route's place in world chunk (cx, cy). Behind the start the route runs
 * on straight forever; ahead, the corners rise in both u and v, so the search
 * stops at the first corner past the chunk.
 */
export function laneAt(world: World, cx: number, cy: number): LaneInfo {
  const [u, v] = toCanonical(world.orient, cx, cy);
  if (v === 0 && u <= 0) {
    return lane(world, u, v, 0, 0);
  }
  if (u < 0 || v < 0) {
    return NO_LANE;
  }
  const { routeU, routeV } = world;
  for (let k = 0; ; k++) {
    extendRoute(world, k + 2);
    const au = routeU[k];
    const av = routeV[k];
    if (au > u || av > v) {
      return NO_LANE;
    }
    const bu = routeU[k + 1];
    const bv = routeV[k + 1];
    const on = legDir(k) === 0 ? v === av && u <= bu : u === au && v <= bv;
    if (on) {
      const d = legDir(k);
      return u === bu && v === bv ? lane(world, u, v, d, legDir(k + 1)) : lane(world, u, v, d, d);
    }
  }
}

/** The route's doorway in an edge, as an `edgeDoors` bit. */
const LANE_DOOR = 1 << LANE;

/**
 * The doorways in a chunk edge, as bits 1..7 (position along the edge; 0 is the
 * corner, always wall): `axis` 0 is the west edge of chunk (cx, cy), 1 its south
 * edge. Never empty. The seeded doorways, and where the route crosses, its
 * doorway too: the edge opens right up beside a hall, and between two stretches
 * of corridor it is only the corridor's width.
 */
export function edgeDoors(world: World, cx: number, cy: number, axis: number): number {
  const seeded = seededDoors(world.seed, cx, cy, axis);
  const here = laneAt(world, cx, cy);
  // Crossing west (heading 2) or south (heading 3).
  if ((here.exits & (1 << (axis === 0 ? 2 : 3))) === 0) {
    return seeded;
  }
  const there = axis === 0 ? laneAt(world, cx - 1, cy) : laneAt(world, cx, cy - 1);
  if (here.style === STYLE_HALL || there.style === STYLE_HALL) {
    return 0xfe;
  }
  if (here.style === STYLE_CORRIDOR && there.style === STYLE_CORRIDOR) {
    return LANE_DOOR;
  }
  return seeded | LANE_DOOR;
}

export interface World {
  /** The 32-bit seed every hash derives from. */
  seed: number;
  /** The route's orientation in the world, 0..7 (see `orientDir`). */
  orient: number;
  /** The route's corners in canonical chunks, from the start chunk (0, 0); laid out as needed. */
  readonly routeU: number[];
  readonly routeV: number[];
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

const worldOrient = (seed: number) => hash32(seed ^ 0x3f84d5b5) & 7;

export function createWorld(seed: number): World {
  const s = worldSeed(seed);
  return {
    seed: s,
    orient: worldOrient(s),
    routeU: [0],
    routeV: [0],
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
  world.orient = worldOrient(world.seed);
  world.routeU.length = 1;
  world.routeV.length = 1;
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
  const { cells, required, seed } = world;
  const base = slot * CELLS;
  const west = edgeDoors(world, cx, cy, 0);
  const south = edgeDoors(world, cx, cy, 1);
  const east = edgeDoors(world, cx + 1, cy, 0);
  const north = edgeDoors(world, cx, cy + 1, 1);
  const route = laneAt(world, cx, cy);
  const rng = createRng(mix(seed, cx, cy, 0x3c6ef372));
  const pick = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

  cells.fill(OPEN, base, base + CELLS);
  for (let p = 0; p < CHUNK; p++) {
    cells[base + local(0, p)] = ((west >> p) & 1) !== 0 ? OPEN : WALL;
    cells[base + local(p, 0)] = ((south >> p) & 1) !== 0 ? OPEN : WALL;
  }
  if (route.style === STYLE_HALL) {
    hallPillars(cells, base, route, rng);
  } else {
    furnish(cells, base, rng, pick);
  }
  if (route.style === STYLE_CORRIDOR) {
    corridorWalls(cells, base, route, pick);
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
  // So must the route's cells: its row or column, or both halves at a bend.
  if (route.style !== STYLE_NONE) {
    for (let k = 1; k < CHUNK; k++) {
      const d = k < LANE ? (route.dirIn + 2) & 3 : route.dirOut;
      const r = Math.abs(k - LANE);
      const c = local(LANE + DIR_X[d] * r, LANE + DIR_Y[d] * r);
      required[c] = 1;
      cells[base + c] = OPEN;
    }
  }
  connect(world, base, east, north, firstX, firstY);
}

/** Partitions, odd blocks of wall and pillars: the jumble of rooms. */
function furnish(
  cells: Uint8Array,
  base: number,
  rng: () => number,
  pick: (lo: number, hi: number) => number,
): void {
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
}

/**
 * Pillars in a hall, two cells off the route: at a bend, in the three quarters
 * the curve doesn't cut through; on a straight, a seeded few in two rows either
 * side.
 */
function hallPillars(cells: Uint8Array, base: number, route: LaneInfo, rng: () => number): void {
  const ax = DIR_X[route.dirIn];
  const ay = DIR_Y[route.dirIn];
  if (route.corner) {
    const bx = DIR_X[route.dirOut];
    const by = DIR_Y[route.dirOut];
    for (const [s, t] of [
      [1, -1],
      [1, 1],
      [-1, -1],
    ]) {
      cells[base + local(LANE + 2 * (s * ax + t * bx), LANE + 2 * (s * ay + t * by))] = PILLAR;
    }
    return;
  }
  for (const along of [-2, 0, 2]) {
    for (const side of [-2, 2]) {
      if (rng() < 0.6) {
        cells[base + local(LANE + along * ax - side * ay, LANE + along * ay + side * ax)] = PILLAR;
      }
    }
  }
}

/** Walls along both sides of the route, with up to two openings into the rooms beside it. */
function corridorWalls(
  cells: Uint8Array,
  base: number,
  route: LaneInfo,
  pick: (lo: number, hi: number) => number,
): void {
  const alongX = DIR_X[route.dirIn] !== 0;
  const at = (k: number, side: number) =>
    base + (alongX ? local(k, LANE + side) : local(LANE + side, k));
  for (let k = 1; k < CHUNK; k++) {
    cells[at(k, -1)] = WALL;
    cells[at(k, 1)] = WALL;
  }
  const openings = pick(0, 2);
  for (let i = 0; i < openings; i++) {
    cells[at(pick(2, CHUNK - 2), pick(0, 1) === 0 ? -1 : 1)] = OPEN;
  }
}

/**
 * Joins up the chunk round its required cells: every one is connected to the
 * first doorway (an L-shaped path carved to any cut off), pockets left cut off
 * become wall, and dead ends are filled until none are left.
 */
function connect(
  world: World,
  base: number,
  east: number,
  north: number,
  firstX: number,
  firstY: number,
): void {
  const { cells, required, reached } = world;
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
 * swept past on a bend. Nearer patterns appear larger and cross a point less
 * often; further ones are filtered out as they shrink and fade into the haze.
 */
export const REF_DISTANCE = 1;
/** Seconds per cell at a pace of 1, before the motion caps. */
const WALK_SECONDS = 0.8;

const clampSpeed = (speed: number) =>
  clamp(Number.isFinite(speed) ? speed : 1, MIN_SPEED, MAX_SPEED);

// --- The bends ---

/** How far before and after the corner cell's centre a bend starts and ends, in cells. */
const CURVE_CUT = 3;
/** Steps of the bend's table. */
const CURVE_STEPS = 64;
/**
 * A bend turns the heading a quarter turn with a smoothstep along its length,
 * so the turn rate rises from nothing and falls back to it. The table holds the
 * distance covered along the heading in and along the heading out, per cell of
 * bend, at CURVE_STEPS + 1 even steps through it (pairs, from the start).
 */
const CURVE_TABLE = (() => {
  const table = new Float64Array(2 * (CURVE_STEPS + 1));
  const sub = 32;
  const du = 1 / (CURVE_STEPS * sub);
  let a = 0;
  let b = 0;
  for (let i = 0; i < CURVE_STEPS; i++) {
    for (let j = 0; j < sub; j++) {
      const turn = (Math.PI / 2) * smoothstep(0, 1, (i * sub + j + 0.5) * du);
      a += Math.cos(turn) * du;
      b += Math.sin(turn) * du;
    }
    table[2 * i + 2] = a;
    table[2 * i + 3] = b;
  }
  return table;
})();
/** The bend's length, in cells: it covers CURVE_CUT along the heading in. */
export const CURVE_LENGTH = CURVE_CUT / CURVE_TABLE[2 * CURVE_STEPS];
/** How far past the corner along the heading out the bend ends: CURVE_CUT, give or take rounding. */
const CURVE_OUT = CURVE_LENGTH * CURVE_TABLE[2 * CURVE_STEPS + 1];

/**
 * Walking rate in cells a second at `speed`: the tiles and wallpaper pass a
 * point at most MAX_PATTERN_HZ times a second, and so does the wallpaper at
 * REF_DISTANCE swept past at a bend's peak turn rate.
 */
export function walkRate(speed: number): number {
  const turnPerCell = (EASE_PEAK * Math.PI) / 2 / CURVE_LENGTH;
  const turnCap = (MAX_PATTERN_HZ * PATTERN_PERIOD) / REF_DISTANCE / turnPerCell;
  return Math.min(capPatternSpeed(clampSpeed(speed) / WALK_SECONDS, PATTERN_PERIOD), turnCap);
}

// --- The walker ---

/** Cells a second the walking rate changes by each second: from rest, and on a pace change. */
const ACCEL = 0.4;
/** Drift sideways within the route's row of cells: amplitude in cells, and its two wavelengths. */
const DRIFT = 0.18;
const DRIFT_WAVE_A = 23;
const DRIFT_WAVE_B = 9.7;
/** The start: the centre of the route's cell in chunk (0, 0), on both axes. */
const START = LANE + 0.5;

interface Walker {
  /** The route leg it is on: leg k runs from corner k to corner k + 1. */
  leg: number;
  /** Whether it is on the bend at the leg's end, rather than its straight. */
  bending: boolean;
  /** Cells into the straight or the bend. */
  along: number;
  /** Walking rate, cells a second. */
  rate: number;
  /** Total distance walked, in cells (for the head bob and the drift). */
  walked: number;
  /** Phases of the sideways drift. */
  phaseA: number;
  phaseB: number;
  /** The camera pose: position in cells and heading in radians. */
  x: number;
  y: number;
  angle: number;
}

export function createWalker(): Walker {
  return {
    leg: 0,
    bending: false,
    along: 0,
    rate: 0,
    walked: 0,
    phaseA: 0,
    phaseB: 0,
    x: START,
    y: START,
    angle: 0,
  };
}

/** Length of leg k's straight, in cells: corner to corner, less the bends at either end. */
function straightLength(world: World, k: number): number {
  extendRoute(world, k + 1);
  const chunks = world.routeU[k + 1] - world.routeU[k] + (world.routeV[k + 1] - world.routeV[k]);
  return CHUNK * chunks - CURVE_CUT - (k > 0 ? CURVE_OUT : 0);
}

/** Sets the camera pose from the walker's place on the route. */
function updatePose(w: Walker, world: World): void {
  const k = w.leg;
  extendRoute(world, k + 1);
  const east = legDir(k) === 0;
  const dx = east ? 1 : 0;
  const dy = east ? 0 : 1;
  // The corner ahead, in canonical cells.
  const nx = CHUNK * world.routeU[k + 1] + START;
  const ny = CHUNK * world.routeV[k + 1] + START;
  let px: number;
  let py: number;
  let th = east ? 0 : Math.PI / 2;
  if (!w.bending) {
    const back = CURVE_CUT + straightLength(world, k) - w.along;
    px = nx - dx * back;
    py = ny - dy * back;
  } else {
    const u = clamp(w.along / CURVE_LENGTH, 0, 1);
    const f = u * CURVE_STEPS;
    const i = Math.min(Math.floor(f), CURVE_STEPS - 1);
    const t = f - i;
    const a = CURVE_TABLE[2 * i] + (CURVE_TABLE[2 * i + 2] - CURVE_TABLE[2 * i]) * t;
    const b = CURVE_TABLE[2 * i + 1] + (CURVE_TABLE[2 * i + 3] - CURVE_TABLE[2 * i + 1]) * t;
    // The heading out is the other axis: east turns left to north, north right to east.
    px = nx - dx * CURVE_CUT + CURVE_LENGTH * (a * dx + b * dy);
    py = ny - dy * CURVE_CUT + CURVE_LENGTH * (a * dy + b * dx);
    th += (east ? 1 : -1) * (Math.PI / 2) * smoothstep(0, 1, u);
  }
  const s = w.walked * 2 * Math.PI;
  const drift =
    DRIFT *
    (0.6 * Math.sin(s / DRIFT_WAVE_A + w.phaseA) + 0.4 * Math.sin(s / DRIFT_WAVE_B + w.phaseB));
  px -= Math.sin(th) * drift;
  py += Math.cos(th) * drift;
  const o = world.orient;
  const [wx, wy] = toWorld(o, px - START, py - START);
  w.x = wx + START;
  w.y = wy + START;
  w.angle = ((o & 4) !== 0 ? -th : th) + (o & 3) * (Math.PI / 2);
}

/** Puts the walker at rest at the start of the route, with its own seeded drift. */
export function resetWalker(w: Walker, world: World): void {
  const rng = createRng(hash32(world.seed ^ 0x1f83d9ab));
  w.leg = 0;
  w.bending = false;
  w.along = 0;
  w.rate = 0;
  w.walked = 0;
  w.phaseA = rng() * Math.PI * 2;
  w.phaseB = rng() * Math.PI * 2;
  updatePose(w, world);
}

/**
 * Advances the walker by `dt` seconds along the route, its walking rate easing
 * towards `rate` cells a second, and updates its pose.
 */
export function advanceWalker(w: Walker, world: World, dt: number, rate: number): void {
  const step = Math.max(0, dt);
  const r0 = w.rate;
  w.rate = approach(w.rate, Math.max(0, Number.isFinite(rate) ? rate : 0), step * ACCEL);
  const ds = 0.5 * (r0 + w.rate) * step;
  w.walked += ds;
  w.along += ds;
  // A leg is many cells long; the cap only guards odd inputs.
  for (let i = 0; i < 16; i++) {
    const len = w.bending ? CURVE_LENGTH : straightLength(world, w.leg);
    if (w.along < len) {
      break;
    }
    w.along -= len;
    if (w.bending) {
      w.bending = false;
      w.leg++;
    } else {
      w.bending = true;
    }
  }
  updatePose(w, world);
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
