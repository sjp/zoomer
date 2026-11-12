import { describe, expect, it } from "vitest";
import {
  BEND_RADIUS,
  brightness,
  CAP_LENGTH,
  createPipes,
  DIRS,
  FADE_SECONDS,
  fillTarget,
  growth,
  neighbour,
  PALETTE_SIZE,
  PIECE_BALL,
  PIECE_CAP,
  PIECE_ELBOW,
  PIECE_TUBE,
  type Pipes,
  type PipesDims,
  updatePipes,
} from "./pipes-sim";
import { MAX_FILL, MAX_PIPES, type PipesJoints } from "./pipes.meta";

/** Runs `steps` whole steps at one step a second. */
function run(
  s: Pipes,
  steps: number,
  count = 3,
  joints: PipesJoints = "mixed",
  fill = MAX_FILL,
  seed = s.seed,
) {
  for (let k = 0; k < steps; k++) {
    updatePipes(s, 1, 1, count, joints, fill, seed);
  }
}

/**
 * Replays the piece log: every tube must leave a laid node for one nothing has
 * entered, and every pipe start on an untouched node. Returns the nodes laid
 * and any problems found.
 */
function replay(s: Pipes): { laid: Set<number>; problems: string[] } {
  const laid = new Set<number>();
  const problems: string[] = [];
  for (let i = 0; i < s.count; i++) {
    const kind = s.kind[i];
    const node = s.node[i];
    if (kind === PIECE_TUBE) {
      const to = neighbour(s.dims, node, s.dirA[i]);
      if (to < 0 || !laid.has(node) || laid.has(to)) {
        problems.push(`tube ${String(i)} from ${String(node)} to ${String(to)}`);
      }
      laid.add(to);
    } else if (kind === PIECE_CAP && !laid.has(node)) {
      // A start cap: the pipe's first tube must follow from the same node.
      if (s.kind[i + 1] !== PIECE_TUBE || s.node[i + 1] !== node) {
        problems.push(`cap ${String(i)} on an unlaid node starts no pipe`);
      }
      laid.add(node);
    } else if (!laid.has(node)) {
      problems.push(`piece ${String(i)} on unlaid node ${String(node)}`);
    }
  }
  return { laid, problems };
}

/** Whether the round is about to fade or fading. */
const winding = (s: Pipes) => s.resetPending || s.fading;

/** Free nodes with a free neighbour: where a new pipe could start. */
function startable(s: Pipes): number {
  let n = 0;
  for (let c = 0; c < s.cells; c++) {
    let room = false;
    for (let d = 0; d < 6; d++) {
      const to = neighbour(s.dims, c, d);
      room ||= to >= 0 && s.occ[to] === 0;
    }
    n += s.occ[c] === 0 && room ? 1 : 0;
  }
  return n;
}

describe("pipes sim", () => {
  it("never lays a pipe into a taken node", () => {
    for (const joints of ["balls", "elbows", "mixed"] as const) {
      const s = createPipes(11);
      run(s, 400, MAX_PIPES, joints);
      expect(s.fading).toBe(false);
      const { laid, problems } = replay(s);
      expect(problems).toEqual([]);
      expect(laid.size).toBeGreaterThan(400);
      // Every laid node is marked, and the only other marked nodes are reservations.
      let reserved = 0;
      for (let slot = 0; slot < MAX_PIPES; slot++) {
        const ahead = s.active[slot] === 1 && s.next[slot] >= 0;
        reserved += ahead && !laid.has(neighbour(s.dims, s.head[slot], s.next[slot])) ? 1 : 0;
      }
      let marked = 0;
      let unmarked = 0;
      for (let c = 0; c < s.cells; c++) {
        marked += s.occ[c];
        unmarked += laid.has(c) && s.occ[c] === 0 ? 1 : 0;
      }
      expect(unmarked).toBe(0);
      expect(marked).toBe(laid.size + reserved);
      expect(s.filled).toBe(marked);
    }
  });

  it("joins tubes, joints and caps end to end", () => {
    const s = createPipes(5);
    run(s, 200, 4, "mixed");
    const problems: string[] = [];
    let balls = 0;
    let elbows = 0;
    for (let i = 0; i < s.count; i++) {
      const kind = s.kind[i];
      balls += kind === PIECE_BALL ? 1 : 0;
      elbows += kind === PIECE_ELBOW ? 1 : 0;
      if (kind === PIECE_BALL || kind === PIECE_ELBOW) {
        // A joint turns at right angles and is followed by its tube out of the same node.
        const a = DIRS[s.dirA[i]];
        const b = DIRS[s.dirB[i]];
        const ok =
          a[0] * b[0] + a[1] * b[1] + a[2] * b[2] === 0 &&
          s.kind[i + 1] === PIECE_TUBE &&
          s.node[i + 1] === s.node[i] &&
          s.dirA[i + 1] === s.dirB[i] &&
          s.trimStart[i + 1] === (kind === PIECE_ELBOW ? 1 : 0) &&
          s.ballStart[i + 1] === (kind === PIECE_BALL ? 1 : 0);
        if (!ok) {
          problems.push(`joint ${String(i)}`);
        }
      }
      if (kind === PIECE_TUBE) {
        const length = 1 - (s.trimStart[i] + s.trimEnd[i]) * BEND_RADIUS;
        if (
          Math.abs(s.pathLength[i] - length) > 1e-6 ||
          Math.abs(s.pathStart[i] + s.pathLength[i] - s.pathTotal[i]) > 1e-6
        ) {
          problems.push(`tube ${String(i)} length`);
        }
      }
      if (kind === PIECE_CAP && Math.abs(s.pathLength[i] - CAP_LENGTH) > 1e-6) {
        problems.push(`cap ${String(i)} length`);
      }
      if (s.pieceColour[i] >= PALETTE_SIZE) {
        problems.push(`piece ${String(i)} colour`);
      }
    }
    expect(problems).toEqual([]);
    expect(balls).toBeGreaterThan(5);
    expect(elbows).toBeGreaterThan(5);
  });

  it("lays only the joint kind asked for, without changing the route", () => {
    const route = (joints: PipesJoints) => {
      const s = createPipes(21);
      run(s, 150, 3, joints);
      const out: number[] = [];
      for (let i = 0; i < s.count; i++) {
        if (s.kind[i] === PIECE_TUBE) {
          out.push(s.node[i], s.dirA[i]);
        }
      }
      return { kinds: Array.from(s.kind.subarray(0, s.count)), out };
    };
    const balls = route("balls");
    const elbows = route("elbows");
    expect(elbows.out).toEqual(balls.out);
    expect(balls.kinds).not.toContain(PIECE_ELBOW);
    expect(elbows.kinds).not.toContain(PIECE_BALL);
  });

  it("gives growing pipes different colours", () => {
    const s = createPipes(3);
    let clashes = 0;
    for (let k = 0; k < 300; k++) {
      run(s, 1, MAX_PIPES);
      let seen = 0;
      for (let slot = 0; slot < MAX_PIPES; slot++) {
        const bit = s.active[slot] === 1 ? 1 << s.colour[slot] : 0;
        clashes += seen & bit ? 1 : 0;
        seen |= bit;
      }
    }
    expect(clashes).toBe(0);
  });

  it("caps a stuck pipe and starts another on a free node, or resets when none is free", () => {
    // A thin volume boxes pipes in quickly.
    const dims: PipesDims = { x: 4, y: 1, z: 4 };
    const problems: string[] = [];
    let restarts = 0;
    let resets = 0;
    for (let seed = 0; seed < 20; seed++) {
      const s = createPipes(seed, dims);
      for (let k = 0; k < 40 && !winding(s); k++) {
        const stuck = s.active[0] === 1 && s.next[0] < 0;
        const before = s.count;
        run(s, 1, 1, "mixed", 1);
        if (!stuck) {
          continue;
        }
        if (s.kind[before] !== PIECE_CAP) {
          problems.push(`seed ${String(seed)}: stuck pipe not capped`);
        }
        if (s.active[0] === 1) {
          restarts++;
          // The new pipe starts on a node no earlier piece touched.
          const start = s.node[before + 1];
          if (s.kind[before + 1] !== PIECE_CAP || s.node.subarray(0, before).includes(start)) {
            problems.push(`seed ${String(seed)}: restart on a taken node`);
          }
        } else {
          resets++;
          if (!s.resetPending || startable(s) > 0) {
            problems.push(`seed ${String(seed)}: no restart, though a node was free`);
          }
        }
      }
      problems.push(...replay(s).problems);
    }
    expect(problems).toEqual([]);
    expect(restarts).toBeGreaterThan(0);
    expect(resets).toBeGreaterThan(0);
  });

  it("fades out and starts a new round when the volume is full", () => {
    const s = createPipes(2, { x: 3, y: 1, z: 2 });
    run(s, 30, 2, "mixed", 1);
    expect(s.round).toBeGreaterThan(1);
  });

  it("lays the same pipes for the same seed, and others for another", () => {
    const a = createPipes(42);
    const b = createPipes(42);
    const c = createPipes(43);
    run(a, 120, 3);
    run(b, 120, 3);
    run(c, 120, 3, "mixed", MAX_FILL, 43);
    expect(b.count).toBe(a.count);
    expect(Array.from(b.node.subarray(0, b.count))).toEqual(
      Array.from(a.node.subarray(0, a.count)),
    );
    expect(Array.from(b.dirA.subarray(0, b.count))).toEqual(
      Array.from(a.dirA.subarray(0, a.count)),
    );
    expect(Array.from(c.node.subarray(0, 50))).not.toEqual(Array.from(a.node.subarray(0, 50)));
  });

  it("fades over two seconds once the fill is reached, then starts empty", () => {
    const s = createPipes(8);
    const fill = 0.05;
    const target = fillTarget(s, fill);
    for (let k = 0; !s.fading && k < 10_000; k++) {
      updatePipes(s, 0.1, 10, 6, "mixed", fill, 8);
    }
    expect(s.fading).toBe(true);
    expect(s.filled).toBeGreaterThanOrEqual(target);
    expect(s.frozen).toBe(s.count);
    expect(growth(s)).toBe(1);
    expect(brightness(s)).toBe(1);
    const round = s.round;
    const count = s.count;
    // Nothing grows while it fades, and the brightness eases down.
    let last = 1;
    let rises = 0;
    let biggestDrop = 0;
    for (let t = 0; t < FADE_SECONDS - 0.15; t += 0.1) {
      updatePipes(s, 0.1, 10, 6, "mixed", fill, 8);
      const b = brightness(s);
      rises += b > last ? 1 : 0;
      biggestDrop = Math.max(biggestDrop, last - b);
      last = b;
    }
    expect(s.count).toBe(count);
    expect(s.round).toBe(round);
    expect(rises).toBe(0);
    expect(biggestDrop).toBeLessThan(0.1);
    expect(last).toBeLessThan(0.05);
    updatePipes(s, 0.2, 10, 6, "mixed", fill, 8);
    expect(s.round).toBe(round + 1);
    expect(s.count).toBe(0);
    expect(s.filled).toBe(0);
    expect(s.occ.every((v) => v === 0)).toBe(true);
    expect(brightness(s)).toBe(1);
    // And it grows again.
    run(s, 3, 3, "mixed", fill, 8);
    expect(s.count).toBeGreaterThan(0);
  });

  it("fades out before switching to a new seed", () => {
    const s = createPipes(1);
    run(s, 10, 3, "mixed", MAX_FILL, 1);
    run(s, 1, 3, "mixed", MAX_FILL, 2);
    expect(s.fading || s.resetPending).toBe(true);
    expect(s.seed).toBe(1);
    run(s, 4, 3, "mixed", MAX_FILL, 2);
    expect(s.seed).toBe(2);
    expect(s.fading).toBe(false);
  });

  it("caps pipes beyond a lowered count and frees their reserved node", () => {
    const s = createPipes(4);
    run(s, 10, 5);
    const filled = s.filled;
    run(s, 1, 2);
    let growing = 0;
    for (let slot = 0; slot < MAX_PIPES; slot++) {
      growing += s.active[slot];
    }
    expect(growing).toBe(2);
    // Two pipes moved one node on; three capped and gave theirs back.
    expect(s.filled).toBe(filled + 2 - 3);
    expect(replay(s).problems).toEqual([]);
  });

  it("grows smoothly between steps", () => {
    const s = createPipes(6);
    updatePipes(s, 1, 1, 3, "mixed", MAX_FILL, 6);
    updatePipes(s, 0.25, 1, 3, "mixed", MAX_FILL, 6);
    expect(growth(s)).toBeCloseTo(0.25, 6);
    expect(s.frozen).toBe(0);
    updatePipes(s, 0.8, 1, 3, "mixed", MAX_FILL, 6);
    expect(s.frozen).toBeGreaterThan(0);
    expect(growth(s)).toBeCloseTo(0.05, 6);
  });
});
