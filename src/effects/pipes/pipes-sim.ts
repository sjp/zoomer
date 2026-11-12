/**
 * The 3D Pipes simulation: pipes growing one grid segment at a time through an
 * invisible lattice of nodes, never entering an occupied node. Pure CPU logic
 * with fixed-size typed arrays, so a round allocates nothing after creation.
 *
 * Each step, every growing pipe moves its head one node along the direction it
 * planned the step before, then plans the next move from the new head (straight
 * on with probability `STRAIGHT`, otherwise a turn into a random free
 * neighbour) and reserves that node at once. Planning a move ahead means each
 * segment knows the joint at both of its ends when it is laid, so nothing laid
 * ever changes afterwards and the renderer can cache it. A pipe with nowhere to
 * go is capped, and a new pipe starts at a random free node.
 *
 * What a step lays down is appended to a piece log (tubes, ball joints, elbows
 * and end caps). Pieces before `frozen` are finished; the ones from the latest
 * step are still growing, and draw a fraction `growth()` of their path, so a
 * pipe end slides forward smoothly between steps. Once `fill` of the volume is
 * taken (or no pipe can start), the picture fades to black over
 * `FADE_SECONDS` and the next round starts empty.
 */
import { MAX_FILL, MAX_PIPES, type PipesJoints } from "./pipes.meta";
import { smoothstep } from "../math";
import { hash32 } from "../noise";
import { type StepClock, takeSteps } from "../step-clock";

/** Nodes across, up and deep. The plan is square, so a camera orbit always fills the frame. */
export const GRID_X = 28;
export const GRID_Y = 16;
export const GRID_Z = 28;

/** Piece kinds in the log. */
export const PIECE_TUBE = 0;
export const PIECE_BALL = 1;
export const PIECE_ELBOW = 2;
export const PIECE_CAP = 3;

/** Joint planned at a pipe's head. */
const JOINT_NONE = 0;
const JOINT_BALL = 1;
const JOINT_ELBOW = 2;

/** Elbow centre-line radius, in node spacings; tubes meeting an elbow stop this short of the node. */
export const BEND_RADIUS = 0.35;
/** End caps' length along the pipe. */
export const CAP_LENGTH = 0.12;
/** The elbow's centre-line length. */
const ARC_LENGTH = (BEND_RADIUS * Math.PI) / 2;
/** Path length over which a ball joint swells from the pipe's width to its own. */
const BALL_GROW = 0.3;
/** Chance of carrying straight on when that node is free. */
const STRAIGHT = 0.6;
export const FADE_SECONDS = 2;
/** Steps one frame may run; more are dropped rather than caught up in a burst. */
const MAX_STEPS_PER_FRAME = 4;
/** Distinct pipe colours; no two growing pipes share one. */
export const PALETTE_SIZE = 8;

/** Unit vector of each direction index: +x, -x, +y, -y, +z, -z. */
export const DIRS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export interface PipesDims {
  x: number;
  y: number;
  z: number;
}

const GRID: PipesDims = { x: GRID_X, y: GRID_Y, z: GRID_Z };

export interface Pipes {
  readonly dims: PipesDims;
  readonly cells: number;
  /** The seed the current round was laid from. */
  seed: number;
  /** Rounds started so far; the first is 1. */
  round: number;
  /** 1 where a node is taken (laid or reserved by a pipe's next move). */
  readonly occ: Uint8Array;
  /** Nodes taken. */
  filled: number;

  /** Per pipe slot: growing, head node, arriving direction (-1 at the start), next move (-1 when stuck), joint planned at the head, colour. */
  readonly active: Uint8Array;
  readonly head: Int32Array;
  readonly dir: Int8Array;
  readonly next: Int8Array;
  readonly joint: Uint8Array;
  readonly colour: Int8Array;

  /** The piece log: pieces `0 .. count - 1`, of which `0 .. frozen - 1` are finished. */
  readonly capacity: number;
  count: number;
  frozen: number;
  readonly kind: Uint8Array;
  /** The node a piece belongs to: a tube's start, a joint's or cap's centre. */
  readonly node: Int32Array;
  /** Tube and cap: axis. Ball and elbow: the incoming direction. */
  readonly dirA: Int8Array;
  /** Ball and elbow: the outgoing direction; -1 otherwise. */
  readonly dirB: Int8Array;
  readonly pieceColour: Uint8Array;
  /** Tubes: 1 where the end meets an elbow (and so stops `BEND_RADIUS` short of the node). */
  readonly trimStart: Uint8Array;
  readonly trimEnd: Uint8Array;
  /** Tubes: 1 where the end sits in a ball joint. */
  readonly ballStart: Uint8Array;
  readonly ballEnd: Uint8Array;
  /** Growth: where along its step's path a piece starts, its own path length, and the step's whole path. */
  readonly pathStart: Float32Array;
  readonly pathLength: Float32Array;
  readonly pathTotal: Float32Array;

  readonly clock: StepClock;
  /** The volume is full enough: fade out at the next step. */
  resetPending: boolean;
  fading: boolean;
  /** Fade-out progress, 0 to 1. */
  fade: number;
  /** Two mulberry32 states: [0] for the layout, [1] for joint kinds, so the joints param never shifts the layout. */
  readonly rng: Uint32Array;
  /** Free directions, while planning. */
  readonly scratch: Int8Array;
}

/** Most pieces a round can lay: at most four per node taken (tube, joint, start and end cap). */
function capacityFor(cells: number): number {
  return 4 * (Math.ceil(MAX_FILL * cells) + 2 * MAX_PIPES + 1);
}

export function createPipes(seed: number, dims: PipesDims = GRID): Pipes {
  const cells = dims.x * dims.y * dims.z;
  const capacity = capacityFor(cells);
  const s: Pipes = {
    dims,
    cells,
    seed: Math.floor(seed),
    round: 0,
    occ: new Uint8Array(cells),
    filled: 0,
    active: new Uint8Array(MAX_PIPES),
    head: new Int32Array(MAX_PIPES),
    dir: new Int8Array(MAX_PIPES),
    next: new Int8Array(MAX_PIPES),
    joint: new Uint8Array(MAX_PIPES),
    colour: new Int8Array(MAX_PIPES),
    capacity,
    count: 0,
    frozen: 0,
    kind: new Uint8Array(capacity),
    node: new Int32Array(capacity),
    dirA: new Int8Array(capacity),
    dirB: new Int8Array(capacity),
    pieceColour: new Uint8Array(capacity),
    trimStart: new Uint8Array(capacity),
    trimEnd: new Uint8Array(capacity),
    ballStart: new Uint8Array(capacity),
    ballEnd: new Uint8Array(capacity),
    pathStart: new Float32Array(capacity),
    pathLength: new Float32Array(capacity),
    pathTotal: new Float32Array(capacity),
    clock: { acc: 0 },
    resetPending: false,
    fading: false,
    fade: 0,
    rng: new Uint32Array(2),
    scratch: new Int8Array(6),
  };
  newRound(s, s.seed);
  return s;
}

/** Clears the volume and starts the next round from `seed`. */
function newRound(s: Pipes, seed: number): void {
  s.seed = seed;
  s.round++;
  s.occ.fill(0);
  s.filled = 0;
  s.active.fill(0);
  s.count = 0;
  s.frozen = 0;
  s.clock.acc = 0;
  s.resetPending = false;
  s.fading = false;
  s.fade = 0;
  // Each round of a seed lays different pipes, the same every time.
  s.rng[0] = hash32(seed ^ hash32(s.round * 2 + 1));
  s.rng[1] = hash32(seed ^ hash32(s.round * 2 + 2) ^ 0x5bd1e995);
}

/** mulberry32, in [0, 1), advancing stream `i`. */
function random(s: Pipes, i: number): number {
  const a = (s.rng[i] + 0x6d2b79f5) >>> 0;
  s.rng[i] = a;
  let t = Math.imul(a ^ (a >>> 15), a | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The node one step from `cell` in direction `d`, or -1 off the grid. */
export function neighbour(dims: PipesDims, cell: number, d: number): number {
  const x = cell % dims.x;
  const y = Math.floor(cell / dims.x) % dims.y;
  const z = Math.floor(cell / (dims.x * dims.y));
  const v = DIRS[d];
  const nx = x + v[0];
  const ny = y + v[1];
  const nz = z + v[2];
  if (nx < 0 || ny < 0 || nz < 0 || nx >= dims.x || ny >= dims.y || nz >= dims.z) {
    return -1;
  }
  return nx + dims.x * (ny + dims.y * nz);
}

function isFree(s: Pipes, cell: number, d: number): boolean {
  const n = neighbour(s.dims, cell, d);
  return n >= 0 && s.occ[n] === 0;
}

function hasFreeNeighbour(s: Pipes, cell: number): boolean {
  for (let d = 0; d < 6; d++) {
    if (isFree(s, cell, d)) {
      return true;
    }
  }
  return false;
}

/** Nodes taken before the volume fades and starts again, for a `fill` fraction. */
export function fillTarget(s: Pipes, fill: number): number {
  const f = Math.min(1, Math.max(0, Number.isFinite(fill) ? fill : 0));
  return Math.max(1, Math.ceil(f * s.cells));
}

function append(
  s: Pipes,
  kind: number,
  node: number,
  a: number,
  b: number,
  colour: number,
  pathStart: number,
  pathLength: number,
): number {
  const i = s.count++;
  s.kind[i] = kind;
  s.node[i] = node;
  s.dirA[i] = a;
  s.dirB[i] = b;
  s.pieceColour[i] = colour;
  s.trimStart[i] = 0;
  s.trimEnd[i] = 0;
  s.ballStart[i] = 0;
  s.ballEnd[i] = 0;
  s.pathStart[i] = pathStart;
  s.pathLength[i] = pathLength;
  s.pathTotal[i] = pathLength;
  return i;
}

function take(s: Pipes, cell: number): void {
  s.occ[cell] = 1;
  s.filled++;
}

/**
 * Plans the next move of the pipe in `slot` from its head `cell`, arriving along
 * `d` (-1 at the start), and reserves the node it moves into. Sets `next` to -1
 * when every neighbour is taken.
 */
function plan(s: Pipes, slot: number, cell: number, d: number, joints: PipesJoints): void {
  const straight = d >= 0 && isFree(s, cell, d);
  let move = -1;
  let joint = JOINT_NONE;
  if (straight && random(s, 0) < STRAIGHT) {
    move = d;
  } else {
    let m = 0;
    for (let k = 0; k < 6; k++) {
      if (k !== d && isFree(s, cell, k)) {
        s.scratch[m++] = k;
      }
    }
    if (m > 0) {
      move = s.scratch[Math.min(m - 1, Math.floor(random(s, 0) * m))];
      if (d >= 0) {
        // Always draw, so the joints param never changes later draws of this stream.
        const r = random(s, 1);
        joint =
          joints === "balls"
            ? JOINT_BALL
            : joints === "elbows"
              ? JOINT_ELBOW
              : r < 0.5
                ? JOINT_BALL
                : JOINT_ELBOW;
      }
    } else if (straight) {
      move = d;
    }
  }
  s.next[slot] = move;
  s.joint[slot] = joint;
  if (move >= 0) {
    take(s, neighbour(s.dims, cell, move));
  }
}

/**
 * Moves the pipe in `slot` one node along its planned move: the joint at its
 * head, then the tube to the next node, whose far end already knows the joint
 * planned there. Pieces from `first` on share the step's path for growth.
 */
function advance(s: Pipes, slot: number, joints: PipesJoints, first: number): void {
  const h = s.head[slot];
  const d = s.dir[slot];
  const n = s.next[slot];
  const j = s.joint[slot];
  const c = s.colour[slot];
  let path = 0;
  if (j === JOINT_BALL) {
    append(s, PIECE_BALL, h, d, n, c, 0, BALL_GROW);
  } else if (j === JOINT_ELBOW) {
    append(s, PIECE_ELBOW, h, d, n, c, 0, ARC_LENGTH);
    path = ARC_LENGTH;
  }
  const h2 = neighbour(s.dims, h, n);
  plan(s, slot, h2, n, joints);
  const trimStart = j === JOINT_ELBOW ? 1 : 0;
  const trimEnd = s.joint[slot] === JOINT_ELBOW ? 1 : 0;
  const length = 1 - (trimStart + trimEnd) * BEND_RADIUS;
  const t = append(s, PIECE_TUBE, h, n, -1, c, path, length);
  s.trimStart[t] = trimStart;
  s.trimEnd[t] = trimEnd;
  s.ballStart[t] = j === JOINT_BALL ? 1 : 0;
  s.ballEnd[t] = s.joint[slot] === JOINT_BALL ? 1 : 0;
  for (let k = first; k < s.count; k++) {
    s.pathTotal[k] = path + length;
  }
  s.head[slot] = h2;
  s.dir[slot] = n;
}

/** Caps the pipe in `slot` at its head and frees the slot, giving back a reserved node. */
function endPipe(s: Pipes, slot: number): void {
  const h = s.head[slot];
  append(s, PIECE_CAP, h, s.dir[slot], -1, s.colour[slot], 0, CAP_LENGTH);
  const n = s.next[slot];
  if (n >= 0) {
    s.occ[neighbour(s.dims, h, n)] = 0;
    s.filled--;
  }
  s.active[slot] = 0;
}

/** A random free node with a free neighbour, or -1 when there is none. */
function pickStart(s: Pipes): number {
  for (let k = 0; k < 32; k++) {
    const c = Math.min(s.cells - 1, Math.floor(random(s, 0) * s.cells));
    if (s.occ[c] === 0 && hasFreeNeighbour(s, c)) {
      return c;
    }
  }
  const offset = Math.min(s.cells - 1, Math.floor(random(s, 0) * s.cells));
  for (let k = 0; k < s.cells; k++) {
    const c = (offset + k) % s.cells;
    if (s.occ[c] === 0 && hasFreeNeighbour(s, c)) {
      return c;
    }
  }
  return -1;
}

/** A colour no growing pipe has. */
function pickColour(s: Pipes): number {
  let used = 0;
  for (let k = 0; k < MAX_PIPES; k++) {
    if (s.active[k] === 1) {
      used |= 1 << s.colour[k];
    }
  }
  let free = 0;
  for (let c = 0; c < PALETTE_SIZE; c++) {
    free += (used >> c) & 1 ? 0 : 1;
  }
  let pick = Math.min(free - 1, Math.floor(random(s, 0) * free));
  for (let c = 0; c < PALETTE_SIZE; c++) {
    if (!((used >> c) & 1) && pick-- === 0) {
      return c;
    }
  }
  return 0;
}

/** Starts a pipe in `slot` at a random free node; false when no node has room. */
function startPipe(s: Pipes, slot: number, joints: PipesJoints): boolean {
  const start = pickStart(s);
  if (start < 0) {
    return false;
  }
  s.colour[slot] = pickColour(s);
  s.active[slot] = 1;
  take(s, start);
  s.head[slot] = start;
  s.dir[slot] = -1;
  plan(s, slot, start, -1, joints);
  const first = append(s, PIECE_CAP, start, s.next[slot], -1, s.colour[slot], 0, CAP_LENGTH);
  advance(s, slot, joints, first);
  return true;
}

/** Room for one more step's pieces: an end cap, start cap, joint and tube per pipe. */
const PIECES_PER_STEP = 4 * MAX_PIPES;

/** One growth step for up to `count` pipes, flagging a reset once `target` nodes are taken. */
function step(s: Pipes, count: number, joints: PipesJoints, target: number): void {
  s.frozen = s.count;
  if (s.count + PIECES_PER_STEP > s.capacity) {
    s.resetPending = true;
    return;
  }
  for (let slot = 0; slot < MAX_PIPES; slot++) {
    if (s.active[slot] === 0) {
      continue;
    }
    if (slot >= count || s.next[slot] < 0) {
      endPipe(s, slot);
    } else {
      advance(s, slot, joints, s.count);
    }
  }
  let room = true;
  for (let slot = 0; slot < count && room; slot++) {
    if (s.active[slot] === 0 && s.filled < target) {
      room = startPipe(s, slot, joints);
    }
  }
  let growing = false;
  for (let slot = 0; slot < MAX_PIPES; slot++) {
    growing ||= s.active[slot] === 1;
  }
  if (s.filled >= target || (!room && !growing)) {
    s.resetPending = true;
  }
}

/**
 * Advances the pipes by `dt` seconds at `rate` steps a second, with up to
 * `count` pipes growing at once and the volume fading out and starting again
 * once `fill` of it is taken. A new `seed` fades out the round under way and
 * starts the next from it (at once if nothing is laid yet).
 */
export function updatePipes(
  s: Pipes,
  dt: number,
  rate: number,
  count: number,
  joints: PipesJoints,
  fill: number,
  seed: number,
): void {
  const want = Math.floor(seed);
  if (s.fading) {
    s.fade += Math.max(0, dt) / FADE_SECONDS;
    if (s.fade >= 1) {
      newRound(s, want);
    }
    return;
  }
  if (want !== s.seed) {
    if (s.count === 0) {
      newRound(s, want);
    } else {
      s.resetPending = true;
    }
  }
  const pipes = Math.min(MAX_PIPES, Math.max(1, Math.floor(count)));
  const target = fillTarget(s, fill);
  const n = takeSteps(s.clock, rate, dt, MAX_STEPS_PER_FRAME);
  for (let k = 0; k < n; k++) {
    if (s.resetPending) {
      // The last step's pieces have finished growing: freeze them all and fade.
      s.frozen = s.count;
      s.fading = true;
      s.fade = 0;
      s.clock.acc = 0;
      return;
    }
    step(s, pipes, joints, target);
  }
}

/** How far the growing pieces are along their step's path, 0 to 1. */
export function growth(s: Pipes): number {
  return s.fading ? 1 : Math.min(1, Math.max(0, s.clock.acc));
}

/** Picture brightness: 1, easing to 0 over the fade before a new round. */
export function brightness(s: Pipes): number {
  return s.fading ? 1 - smoothstep(0, 1, s.fade) : 1;
}
