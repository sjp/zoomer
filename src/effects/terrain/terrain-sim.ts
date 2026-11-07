/**
 * Pure JS parts of the low-poly terrain flyover (`terrain.ts`): the static mesh in
 * painter's order, the camera path, the palette ramps and the octave texture the
 * vertex shader builds heights from.
 */
import { hexToUnitRgb } from "../color";
import { createNoise, MAX_PERIOD } from "../noise";

/** Terrain texels (grid vertices) along each side of the octave texture; the terrain tiles across x at this. */
export const PERIOD = 256;
/** Rows of cells in the mesh, from just ahead of the camera to where the fog is total. */
export const ROWS = 112;
/** The camera sits this far (plus its fraction of a cell) behind the mesh's first row. */
export const CAM_BACK = 0.25;
/**
 * Half-width of the mesh per unit of forward distance. It must exceed the tangent
 * of the horizontal half field of view plus the largest heading sway (see
 * `MAX_TAN_H` and `cameraAt`), so the mesh's sides are never on screen.
 */
export const MESH_TAN = 1;
/** Largest tangent of the horizontal half field of view (wider canvases narrow the vertical one). */
export const MAX_TAN_H = 0.85;
/** Tangent of the vertical half field of view (about 45 degrees in all). */
export const TAN_V = 0.42;
/** Int16 values per vertex: x, z, then the codes of the triangle's other two corners. */
export const VERTEX_SHORTS = 4;
/** Cells per second at speed 1: hills are about 13 cells apart, so one every ~15 s. */
export const CELLS_PER_SECOND = 0.85;
/** Lattice cells of each octave across the octave texture (see `buildOctaves`). */
export const OCTAVE_PERIODS = [20, 40, 80, 160] as const;

/**
 * Columns either side of the camera's column in row `r`: column c spans x in
 * [c, c + 1], and the row covers columns -K..K. Wide enough to reach the view's
 * edge at the row's far side from the farthest camera position.
 */
export function rowHalfWidth(r: number): number {
  return Math.ceil(MESH_TAN * (r + 2 + CAM_BACK)) + 1;
}

/** Corner offset (dx, dz in -1..1) as the 0..8 code the vertex shader decodes. */
export const cornerCode = (dx: number, dz: number) => dx + 1 + 3 * (dz + 1);

/** Triangles in the mesh. */
export function triangleCount(): number {
  let n = 0;
  for (let r = 0; r < ROWS; r++) {
    n += 2 * (2 * rowHalfWidth(r) + 1);
  }
  return n;
}

/**
 * Builds the de-indexed mesh: every vertex carries its own grid position and its
 * triangle's other two corners, so each vertex can compute the triangle's face
 * normal and colour itself (flat shading with no provoking-vertex subtleties).
 *
 * Triangles come in painter's order, back to front, so no depth buffer is needed:
 * rows far to near; within a row, columns from the outside in towards the
 * camera's column 0 (the camera stays inside x in [0, 1]); within a cell, the
 * triangle on the far side of the diagonal first. Right of the camera (and in
 * column 0) cells split along "\", left of it along "/", so the camera is always
 * on the near triangle's side. A ray to any point then only crosses triangles
 * drawn after it. All triangles wind counter-clockwise seen from above (x right,
 * z forward), which is counter-clockwise on screen, so back faces can be culled.
 */
export function buildMesh(): Int16Array {
  const out = new Int16Array(triangleCount() * 3 * VERTEX_SHORTS);
  let o = 0;
  const vert = (x: number, z: number, ax: number, az: number, bx: number, bz: number) => {
    out[o++] = x;
    out[o++] = z;
    out[o++] = cornerCode(ax - x, az - z);
    out[o++] = cornerCode(bx - x, bz - z);
  };
  /** One counter-clockwise triangle; each vertex lists the other two in winding order. */
  const tri = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => {
    vert(ax, az, bx, bz, cx, cz);
    vert(bx, bz, cx, cz, ax, az);
    vert(cx, cz, ax, az, bx, bz);
  };
  /** A cell right of (or containing) the camera: "\" diagonal, upper-right triangle first. */
  const rightCell = (c: number, r: number) => {
    tri(c + 1, r, c + 1, r + 1, c, r + 1);
    tri(c, r, c + 1, r, c, r + 1);
  };
  /** A cell left of the camera: "/" diagonal, upper-left triangle first. */
  const leftCell = (c: number, r: number) => {
    tri(c, r, c + 1, r + 1, c, r + 1);
    tri(c, r, c + 1, r, c + 1, r + 1);
  };
  for (let r = ROWS - 1; r >= 0; r--) {
    for (let k = rowHalfWidth(r); k >= 1; k--) {
      rightCell(k, r);
      leftCell(-k, r);
    }
    rightCell(0, r);
  }
  return out;
}

/** Where the camera is and how it is turned, in mesh space (y up, z forward). */
export interface CameraPose {
  /** Lateral position, kept inside column 0 (x in [0, 1]) as `buildMesh` needs. */
  x: number;
  /** Height above the terrain's zero level. */
  y: number;
  /** Heading in radians, positive turning right. */
  yaw: number;
  /** Horizon height above the canvas centre, in units of the vertical half-height (NDC). */
  horizon: number;
}

export const createPose = (): CameraPose => ({ x: 0.5, y: 0, yaw: 0, horizon: 0 });

/** Camera height, lateral sway and heading sway amplitude (radians). */
export const CAM_HEIGHT = 2.2;
export const SWAY_X = 0.33;
export const SWAY_Y = 0.25;
export const SWAY_YAW = 0.06;
/** Horizon at 42.5% from the top: 0.15 above the centre in NDC, swaying by 0.015. */
export const HORIZON_NDC = 0.15;
export const SWAY_HORIZON = 0.015;

/**
 * The camera's slow sway at `t` seconds (float64, unwrapped): each component a
 * pair of incommensurate sines with periods of a minute or two, so the motion
 * never visibly repeats, is smooth, and stays within its amplitude.
 */
export function cameraAt(t: number, out: CameraPose): CameraPose {
  out.x = 0.5 + SWAY_X * (0.6 * Math.sin(t * 0.071) + 0.4 * Math.sin(t * 0.113 + 1.3));
  out.y = CAM_HEIGHT + SWAY_Y * (0.6 * Math.sin(t * 0.093 + 0.4) + 0.4 * Math.sin(t * 0.051 + 2.1));
  out.yaw = SWAY_YAW * (0.6 * Math.sin(t * 0.047 + 0.7) + 0.4 * Math.sin(t * 0.083 + 2.9));
  out.horizon = HORIZON_NDC + SWAY_HORIZON * Math.sin(t * 0.061 + 1.7);
  return out;
}

/**
 * Mesh-space z of the camera after flying `distance` cells (float64, unwrapped).
 * Mesh row j shows terrain row floor(distance) + j, and the camera sits behind
 * mesh row 0 by CAM_BACK plus the part of the current cell still to fly, so its
 * terrain z, floor(distance) + this, is distance - 1 - CAM_BACK: it moves
 * forward smoothly, with no jump when the whole row count ticks over.
 */
export function cameraMeshZ(distance: number): number {
  return distance - Math.floor(distance) - 1 - CAM_BACK;
}

/**
 * Each octave's noise lattice along z is stretched by a slightly different
 * factor, so the octaves never line up the same way twice: the terrain doesn't
 * repeat along the flight. (The broadest octave alone comes round again after
 * about 3300 cells, roughly an hour at speed 1, under different detail.)
 */
const Z_STRETCH = [1, 1.0731, 0.9417, 1.1129] as const;

/**
 * Writes one row of the octave texture, `PERIOD` RGBA8 texels: texel x of
 * terrain row `row` (any whole number; it doesn't wrap), each channel one octave
 * of gradient noise (`OCTAVE_PERIODS`) mapped from [-1, 1] to 0..255. Rows tile
 * across x at PERIOD but never repeat along z, so the texture is filled as a ring
 * buffer (terrain row r in texture row r mod PERIOD) a row at a time as the
 * camera flies. The shader weights the octaves by roughness, so only the seed
 * and the flight change the contents. Samples are offset off the lattice, where
 * gradient noise is always zero.
 */
export type OctaveRowWriter = (row: number, out: Uint8Array, offset?: number) => void;

export function createOctaveRows(seed: number): OctaveRowWriter {
  const noises = OCTAVE_PERIODS.map((_, c) => createNoise(seed * 4 + c + 1));
  return (row, out, offset = 0) => {
    for (let c = 0; c < OCTAVE_PERIODS.length; c++) {
      const period = OCTAVE_PERIODS[c];
      const noise = noises[c];
      const k = period / PERIOD;
      const z = row * k * Z_STRETCH[c] + 0.61;
      for (let x = 0; x < PERIOD; x++) {
        const v = noise.periodic2(x * k + 0.37, z, period, MAX_PERIOD);
        const b = Math.round((v * 0.5 + 0.5) * 255);
        out[offset + x * 4 + c] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
    }
  };
}

/** Texture row (0..PERIOD-1) holding terrain row `row`. */
export const ringRow = (row: number) => ((row % PERIOD) + PERIOD) % PERIOD;

/** One past the last terrain row the mesh reads when the camera is over row `row`. */
export const rowsNeeded = (row: number) => row + ROWS + 1;

/**
 * Fills a whole PERIOD x PERIOD octave texture as the ring buffer holds it with
 * terrain rows [first, first + PERIOD) in place.
 */
export function buildOctaves(seed: number, first = 0): Uint8Array {
  const data = new Uint8Array(PERIOD * PERIOD * 4);
  const write = createOctaveRows(seed);
  for (let r = first; r < first + PERIOD; r++) {
    write(r, data, ringRow(r) * PERIOD * 4);
  }
  return data;
}

/**
 * Octave weights (summing to `amp`) and base for a roughness in [0, 1]: rougher
 * terrain is taller and keeps more of its fine octaves.
 */
export function octaveWeights(roughness: number, out: Float64Array): number {
  const amp = 2.5 + 4 * roughness;
  const gain = 0.25 + 0.3 * roughness;
  let w = 1;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    out[i] = w;
    sum += w;
    w *= gain;
  }
  // Single octaves rarely pass +-0.7, so stretch the sum to about +-1.
  for (let i = 0; i < 4; i++) {
    out[i] = (out[i] / sum) * amp * 1.4;
  }
  return amp;
}

/** One stop of a height colour ramp. */
export interface RampStop {
  /** Normalised height, 0 (shore) to 1 (highest peaks). */
  at: number;
  color: string;
  /** How far steep slopes here turn to the palette's rock colour, 0..1. */
  rock: number;
}

export interface TerrainPalette {
  /** Ascending `at`. */
  stops: readonly RampStop[];
  rock: string;
  water: string;
}

export const PALETTES = {
  alpine: {
    stops: [
      { at: 0, color: "#d6cc98", rock: 0 },
      { at: 0.07, color: "#86b04f", rock: 0.5 },
      { at: 0.32, color: "#3f7a3a", rock: 1 },
      { at: 0.58, color: "#6f7a5e", rock: 1 },
      { at: 0.74, color: "#8e8e8e", rock: 0.8 },
      { at: 0.82, color: "#eef1f5", rock: 0.3 },
      { at: 1, color: "#ffffff", rock: 0 },
    ],
    rock: "#6c6763",
    water: "#2f6f9a",
  },
  desert: {
    stops: [
      { at: 0, color: "#ecd6a0", rock: 0.1 },
      { at: 0.3, color: "#ddb06e", rock: 0.5 },
      { at: 0.6, color: "#c88752", rock: 0.9 },
      { at: 1, color: "#a8603e", rock: 1 },
    ],
    rock: "#94563a",
    water: "#3aa3a0",
  },
  autumn: {
    stops: [
      { at: 0, color: "#c9b37a", rock: 0 },
      { at: 0.1, color: "#d9822b", rock: 0.4 },
      { at: 0.35, color: "#b8471f", rock: 0.8 },
      { at: 0.55, color: "#e0ad3a", rock: 0.8 },
      { at: 0.75, color: "#7d6a5a", rock: 1 },
      { at: 0.88, color: "#ebe7df", rock: 0.2 },
      { at: 1, color: "#ffffff", rock: 0 },
    ],
    rock: "#6b5b52",
    water: "#3b6c86",
  },
  alien: {
    stops: [
      { at: 0, color: "#2de0c0", rock: 0 },
      { at: 0.25, color: "#7a3fd1", rock: 0.5 },
      { at: 0.55, color: "#d13fa8", rock: 0.8 },
      { at: 0.8, color: "#ff9de2", rock: 0.3 },
      { at: 1, color: "#fff4b0", rock: 0 },
    ],
    rock: "#3a2a5c",
    water: "#c03a8a",
  },
} satisfies Record<string, TerrainPalette>;

export type PaletteId = keyof typeof PALETTES;

/** Texels in the ramp lookup table. */
export const RAMP_SIZE = 64;

/**
 * Fills `out` (`RAMP_SIZE * 4` floats) with the ramp sampled at texel i =
 * height i / (RAMP_SIZE - 1): RGB 0..1 and rockiness, linear between stops and
 * held flat beyond the first and last.
 */
export function buildRamp(stops: readonly RampStop[], out: Float32Array): void {
  for (let i = 0; i < RAMP_SIZE; i++) {
    const t = i / (RAMP_SIZE - 1);
    let j = 0;
    while (j < stops.length - 2 && stops[j + 1].at <= t) {
      j++;
    }
    const a = stops[j];
    const b = stops[Math.min(j + 1, stops.length - 1)];
    const span = b.at - a.at;
    const f = span > 0 ? Math.min(1, Math.max(0, (t - a.at) / span)) : 0;
    const ca = hexToUnitRgb(a.color);
    const cb = hexToUnitRgb(b.color);
    const o = i * 4;
    out[o] = ca[0] + (cb[0] - ca[0]) * f;
    out[o + 1] = ca[1] + (cb[1] - ca[1]) * f;
    out[o + 2] = ca[2] + (cb[2] - ca[2]) * f;
    out[o + 3] = a.rock + (b.rock - a.rock) * f;
  }
}
