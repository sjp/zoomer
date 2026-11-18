import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import { MAX_SPEED, MIN_SPEED } from "./blockcascade.meta";
import { MAX_PIECE_CELLS, MAX_PIECE_SIZE, PIECES } from "./blockcascade-pieces";
import {
  bagOrder,
  choosePlacement,
  CLEARDOWN_HEIGHT,
  createWell,
  dropRow,
  effectiveSpeed,
  fits,
  MAX_WELL_FRACTION,
  piecePose,
  type PiecePose,
  type Placement,
  SAFE_HEIGHT,
  settleTime,
  shownScore,
  stackHeight,
  stepWell,
  type Well,
  WELL_H,
  WELL_W,
} from "./blockcascade-sim";

const pose: PiecePose = { x: 0, y: 0, alpha: 0, turn: 0, spawnX: 0, spawnY: 0 };

/** Steps a well piece by piece: calls `each` at the start of every drop. */
function play(well: Well, drops: number, speed: number, skill: number, each?: () => void) {
  for (let i = 0; i < drops; i++) {
    each?.();
    stepWell(well, well.drop.end - well.time, speed, skill);
  }
}

describe("the pieces", () => {
  it("has twelve to sixteen shapes of one to five cells, a few of each size", () => {
    expect(PIECES.length).toBeGreaterThanOrEqual(12);
    expect(PIECES.length).toBeLessThanOrEqual(16);
    const sizes = PIECES.map((p) => p.rotations[0].cells.length / 2);
    for (let n = 1; n <= MAX_PIECE_CELLS; n++) {
      expect(sizes).toContain(n);
    }
    expect(Math.max(...sizes)).toBe(MAX_PIECE_CELLS);
  });

  it("does not use the classic seven four-cell set", () => {
    const fours = PIECES.filter((p) => p.rotations[0].cells.length === 8);
    expect(fours.length).toBeLessThan(7);
  });

  it.each(PIECES.map((p) => [p.name, p] as const))(
    "keeps every rotation of %s packed, in bounds and the same size",
    (_, piece) => {
      const n = piece.rotations[0].cells.length;
      for (const rot of piece.rotations) {
        expect(rot.cells.length).toBe(n);
        expect(rot.width).toBeLessThanOrEqual(MAX_PIECE_SIZE);
        expect(rot.height).toBeLessThanOrEqual(MAX_PIECE_SIZE);
        let maxX = 0;
        let maxY = 0;
        let minX = 99;
        let minY = 99;
        for (let i = 0; i < rot.cells.length; i += 2) {
          minX = Math.min(minX, rot.cells[i]);
          minY = Math.min(minY, rot.cells[i + 1]);
          maxX = Math.max(maxX, rot.cells[i]);
          maxY = Math.max(maxY, rot.cells[i + 1]);
        }
        expect([minX, minY, maxX + 1, maxY + 1]).toEqual([0, 0, rot.width, rot.height]);
        // Fits the well at the top in any column it can reach.
        const empty = new Uint8Array(WELL_W * WELL_H);
        expect(fits(empty, rot, 0, WELL_H - rot.height)).toBe(true);
        expect(fits(empty, rot, WELL_W - rot.width, WELL_H - rot.height)).toBe(true);
        expect(fits(empty, rot, WELL_W - rot.width + 1, 0)).toBe(false);
      }
      const keys = new Set(piece.rotations.map((r) => r.cells.join(",")));
      expect(keys.size).toBe(piece.rotations.length);
    },
  );
});

describe("the bag", () => {
  it.each([0, 1, 77])("is the same for seed %i every time and holds every piece once", (seed) => {
    for (let bag = 0; bag < 4; bag++) {
      const a = bagOrder(seed, bag, new Uint8Array(PIECES.length));
      const b = bagOrder(seed, bag, new Uint8Array(PIECES.length));
      expect(a).toEqual(b);
      expect([...a].toSorted((x, y) => x - y)).toEqual(PIECES.map((_, i) => i));
    }
  });

  it("shuffles differently per bag and seed", () => {
    const n = PIECES.length;
    const a = bagOrder(1, 0, new Uint8Array(n)).join(",");
    expect(bagOrder(1, 1, new Uint8Array(n)).join(",")).not.toBe(a);
    expect(bagOrder(2, 0, new Uint8Array(n)).join(",")).not.toBe(a);
  });
});

describe("line clears", () => {
  it("removes exactly the full rows and drops the rest", () => {
    const well = createWell(5, 0, 2, 1);
    // Rows 0 and 2 full but for column 4; rows 1 and 3 with a few cells.
    well.board.fill(0);
    for (let x = 0; x < WELL_W; x++) {
      if (x !== 4) {
        well.board[x] = 1;
        well.board[2 * WELL_W + x] = 2;
      }
    }
    well.board[WELL_W + 0] = 3;
    well.board[3 * WELL_W + 8] = 4;
    // An upright bar of three down column 4 fills rows 0 and 2.
    const bar = PIECES.findIndex((p) => p.name === "bar3");
    const upright = PIECES[bar].rotations.findIndex((r) => r.height === 3);
    const y = dropRow(well.board, PIECES[bar].rotations[upright], 4);
    expect(y).toBe(0);
    const d = well.drop;
    d.piece = bar;
    d.rot = upright;
    d.x = 4;
    d.y = 0;
    d.colour = 5;
    d.cleared.fill(0);
    d.cleared[0] = 1;
    d.cleared[2] = 1;
    d.clearedCount = 2;
    d.points = 300;
    const before = well.score;
    // Ends the drop (the next one starts with whatever piece is due).
    stepWell(well, d.end - well.time + 1e-9, 2, 1);
    // Row 1 (the bar's middle cell in column 4, plus column 0) is now row 0;
    // row 3 is now row 1.
    const row = (r: number) => [...well.board.subarray(r * WELL_W, (r + 1) * WELL_W)];
    expect(row(0)).toEqual([3, 0, 0, 0, 6, 0, 0, 0, 0]);
    expect(row(1)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 4]);
    expect(stackHeight(well.board)).toBe(2);
    expect(well.score).toBe(before + 300);
  });
});

/** What's wrong with the drop just started, if anything: an illegal placement or a blocked path. */
function dropProblem(well: Well): string | null {
  const d = well.drop;
  if (d.piece < 0) {
    return stackHeight(well.board) >= CLEARDOWN_HEIGHT ? null : "needless clear-down";
  }
  const rots = PIECES[d.piece].rotations;
  const rot = rots[d.rot];
  const spawn = rots[d.spawnRot];
  // Appears, turns and slides across at the top, then falls straight down.
  if (!fits(well.board, spawn, d.spawnX, WELL_H - spawn.height)) {
    return "no room to appear";
  }
  for (let x = Math.min(d.startX, d.x); x <= Math.max(d.startX, d.x); x++) {
    if (!fits(well.board, rot, x, d.topY)) {
      return "blocked sideways";
    }
  }
  for (let y = d.topY; y >= d.y; y--) {
    if (!fits(well.board, rot, d.x, y)) {
      return "blocked falling";
    }
  }
  return fits(well.board, rot, d.x, d.y - 1) ? "not resting" : null;
}

describe("the AI", () => {
  it.each([
    [0, 1],
    [0, 2],
    [0.7, 3],
    [1, 4],
    [1, 5],
  ])(
    "always places legally and never tops out over 10,000 pieces (skill %s, seed %i)",
    (skill, seed) => {
      const well = createWell(seed, 0, MAX_SPEED, skill);
      let pieces = 0;
      let peak = 0;
      const problems: string[] = [];
      while (pieces < 10_000) {
        const problem = dropProblem(well);
        if (problem !== null) {
          problems.push(problem);
        }
        if (well.drop.piece >= 0) {
          pieces++;
        }
        stepWell(well, well.drop.end - well.time, MAX_SPEED, skill);
        peak = Math.max(peak, stackHeight(well.board));
      }
      expect(problems).toEqual([]);
      expect(peak).toBeLessThanOrEqual(WELL_H);
      expect(well.lines).toBeGreaterThan(pieces / 4);
      // A careful AI seldom needs a clear-down (one in about a thousand pieces);
      // a careless one more often (one in about thirty).
      expect(well.clearDowns).toBeLessThan(skill === 1 ? 25 : 500);
    },
  );

  it("clears the stack down to half height when it gets too high", () => {
    const well = createWell(9, 0, 2, 1);
    well.board.fill(0);
    for (let y = 0; y < CLEARDOWN_HEIGHT; y++) {
      for (let x = 0; x < WELL_W; x++) {
        well.board[y * WELL_W + x] = x === y % WELL_W ? 0 : 1;
      }
    }
    // The piece already falling lands somewhere; then the clear-down is due.
    stepWell(well, well.drop.end - well.time, 2, 1);
    expect(well.drop.piece).toBe(-1);
    stepWell(well, well.drop.end - well.time, 2, 1);
    expect(stackHeight(well.board)).toBeLessThanOrEqual(SAFE_HEIGHT);
  });

  it("finds a clearing move when there is one", () => {
    const board = new Uint8Array(WELL_W * WELL_H);
    for (let x = 0; x < WELL_W; x++) {
      if (x !== 6) {
        board[x] = 1;
      }
    }
    const dot = PIECES.findIndex((p) => p.name === "dot");
    const out: Placement = { rot: 0, x: 0, y: 0 };
    expect(choosePlacement(board, dot, 1, false, 1, out)).toBe(true);
    expect(out).toEqual({ rot: 0, x: 6, y: 0 });
  });
});

describe("the timeline", () => {
  it("gives the same state however finely it is stepped", () => {
    const a = createWell(3, 1, 2, 0.7);
    const b = createWell(3, 1, 2, 0.7);
    for (let i = 0; i < 60 * 120; i++) {
      stepWell(a, 1 / 60, 2, 0.7);
    }
    stepWell(b, 50, 2, 0.7);
    stepWell(b, 70, 2, 0.7);
    expect(b.board).toEqual(a.board);
    expect(b.score).toBe(a.score);
    expect(b.time).toBeCloseTo(a.time, 6);
  });

  it("plays different games in the two wells and for different seeds", () => {
    const a = createWell(3, 0, 2, 0.7);
    const b = createWell(3, 1, 2, 0.7);
    const c = createWell(4, 0, 2, 0.7);
    stepWell(a, 60, 2, 0.7);
    stepWell(b, 60, 2, 0.7);
    stepWell(c, 60, 2, 0.7);
    expect(a.board).not.toEqual(b.board);
    expect(a.board).not.toEqual(c.board);
  });

  it("counts the score up after a clear", () => {
    const well = createWell(1, 0, 2, 1);
    play(well, 2000, 2, 1);
    while (well.drop.points === 0) {
      stepWell(well, well.drop.end - well.time, 2, 1);
    }
    const d = well.drop;
    expect(shownScore(well, d.landAt)).toBe(well.score);
    expect(shownScore(well, d.end)).toBe(well.score + d.points);
  });

  it("caps the speed so a falling piece stays within the per-frame motion limit", () => {
    expect(effectiveSpeed(MIN_SPEED)).toBe(MIN_SPEED);
    expect(effectiveSpeed(Number.NaN)).toBe(MIN_SPEED);
    expect(effectiveSpeed(MAX_SPEED)).toBeGreaterThan(3);
    const cell = MAX_WELL_FRACTION / WELL_H;
    for (const speed of [MIN_SPEED, 2, 4, MAX_SPEED, 100]) {
      // Sample the piece's motion at 30 fps over a long drop, in frame heights.
      const well = createWell(2, 0, speed, 1);
      play(well, 30, speed, 1);
      const d = well.drop;
      let worst = 0;
      let prevX = Number.NaN;
      let prevY = Number.NaN;
      for (let t = 0; t < d.landAt; t += 1 / 120) {
        piecePose(d, t, pose);
        if (!Number.isNaN(prevX)) {
          worst = Math.max(worst, Math.hypot(pose.x - prevX, pose.y - prevY));
        }
        prevX = pose.x;
        prevY = pose.y;
      }
      // Cells per 1/120 s to px per 1/30 s at 1080p.
      const px = pxPerReferenceFrame(worst * cell * 120);
      expect(px).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME + 1e-6);
    }
  });

  it("settles the rows above a clear within the motion limit", () => {
    for (let rows = 1; rows <= WELL_H; rows++) {
      const peak = (1.5 * rows * (MAX_WELL_FRACTION / WELL_H)) / settleTime(rows);
      expect(pxPerReferenceFrame(peak)).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME + 1e-6);
    }
    expect(settleTime(1)).toBeCloseTo(0.4);
  });
});
