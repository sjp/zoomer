/**
 * Block Cascade's pieces: a made-up set of thirteen polyominoes from one cell to
 * five, a few of each size, with their distinct quarter-turn rotations. The set
 * leans towards compact shapes and a couple of long ones, so an AI dropping them
 * into a nine-wide well can still fill rows.
 */

/** One rotation of a piece: its cells as (x, y) pairs, y up, packed against x = 0 and y = 0. */
export interface Rotation {
  readonly cells: readonly number[];
  readonly width: number;
  readonly height: number;
}

interface Piece {
  readonly name: string;
  /** Distinct rotations, a quarter turn anticlockwise apart (1, 2 or 4 of them). */
  readonly rotations: readonly Rotation[];
}

/** The most cells a piece has. */
export const MAX_PIECE_CELLS = 5;
/** The tallest any rotation of any piece is, cells. */
export const MAX_PIECE_SIZE = 5;

/** Each piece's cells drawn as rows of text, top row first: `#` is a cell. */
const SHAPES: readonly (readonly [string, readonly string[]])[] = [
  ["dot", ["#"]],
  ["pair", ["##"]],
  ["bar3", ["###"]],
  ["corner3", ["#.", "##"]],
  ["square", ["##", "##"]],
  ["tee", ["###", ".#."]],
  ["hook", ["#..", "###"]],
  ["bar5", ["#####"]],
  ["chair", ["##", "##", "#."]],
  ["cup", ["#.#", "###"]],
  ["corner5", ["#..", "#..", "###"]],
  ["post", ["###", ".#.", ".#."]],
  ["boot", ["#...", "####"]],
];

/** Packs (x, y) pairs against the axes, sorted so equal shapes compare equal. */
function normalise(cells: number[]): Rotation {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < cells.length; i += 2) {
    minX = Math.min(minX, cells[i]);
    minY = Math.min(minY, cells[i + 1]);
    maxX = Math.max(maxX, cells[i]);
    maxY = Math.max(maxY, cells[i + 1]);
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < cells.length; i += 2) {
    pairs.push([cells[i] - minX, cells[i + 1] - minY]);
  }
  pairs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return { cells: pairs.flat(), width: maxX - minX + 1, height: maxY - minY + 1 };
}

function parse(rows: readonly string[]): Rotation {
  const cells: number[] = [];
  rows.forEach((row, r) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "#") {
        cells.push(x, rows.length - 1 - r);
      }
    }
  });
  return normalise(cells);
}

/** The distinct rotations of a shape, starting with the shape as drawn. */
function rotations(base: Rotation): Rotation[] {
  const out: Rotation[] = [base];
  let r = base;
  for (let k = 1; k < 4; k++) {
    const turned: number[] = [];
    for (let i = 0; i < r.cells.length; i += 2) {
      // A quarter turn anticlockwise: (x, y) -> (-y, x).
      turned.push(-r.cells[i + 1], r.cells[i]);
    }
    r = normalise(turned);
    const key = r.cells.join(",");
    if (out.some((o) => o.cells.join(",") === key)) {
      break;
    }
    out.push(r);
  }
  return out;
}

export const PIECES: readonly Piece[] = SHAPES.map(([name, rows]) => ({
  name,
  rotations: rotations(parse(rows)),
}));
