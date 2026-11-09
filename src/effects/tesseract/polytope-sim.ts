import type { Rgb } from "../color";
import { type PolytopeShape, SHAPE_OPTIONS } from "./tesseract.meta";

/**
 * Pure model for the Rotating Tesseract effect: regular 4D polytopes generated from
 * their coordinate sets, rotated in 4D planes and projected to the screen with a
 * perspective divide on W, then on Z.
 */

/** A wireframe polytope with unit circumradius. */
export interface Polytope {
  /** x, y, z, w per vertex. */
  vertices: Float64Array;
  /** Vertex index pairs, one per edge. */
  edges: Uint16Array;
  vertexCount: number;
  edgeCount: number;
}

const PHI = (1 + Math.sqrt(5)) / 2;

/** Whether each of the 24 permutations of four items is even, in `PERMUTATIONS` order. */
const PERMUTATIONS: { order: readonly number[]; even: boolean }[] = (() => {
  const out: { order: number[]; even: boolean }[] = [];
  const visit = (prefix: number[], rest: number[]) => {
    if (rest.length === 0) {
      let inversions = 0;
      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
          if (prefix[i] > prefix[j]) {
            inversions++;
          }
        }
      }
      out.push({ order: prefix, even: inversions % 2 === 0 });
      return;
    }
    for (let k = 0; k < rest.length; k++) {
      visit([...prefix, rest[k]], [...rest.slice(0, k), ...rest.slice(k + 1)]);
    }
  };
  visit([], [0, 1, 2, 3]);
  return out;
})();

/**
 * Every distinct point made by permuting `base` (only its even permutations when
 * `evenOnly`) and flipping the sign of any of its non-zero entries.
 */
export function signedPermutations(base: readonly number[], evenOnly = false): number[][] {
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const { order, even } of PERMUTATIONS) {
    if (evenOnly && !even) {
      continue;
    }
    const p = order.map((i) => base[i]);
    for (let signs = 0; signs < 16; signs++) {
      const v = p.map((x, i) => (signs & (1 << i) ? -x : x));
      const key = v.map((x) => x.toFixed(9)).join(",");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

/** The shape named by a param value, or the tesseract for an unknown one. */
export function toShape(value: string): PolytopeShape {
  for (const o of SHAPE_OPTIONS) {
    if (o.value === value) {
      return o.value;
    }
  }
  return "tesseract";
}

/** The coordinate sets that generate each shape, as [base, evenOnly] pairs. */
function generators(shape: PolytopeShape): [number[], boolean][] {
  switch (shape) {
    case "cell16":
      return [[[1, 0, 0, 0], false]];
    case "cell24":
      return [[[1, 1, 0, 0], false]];
    case "cell120": {
      // The 600 vertices of the 120-cell, circumradius √8 (Coxeter, Regular Polytopes).
      const s5 = Math.sqrt(5);
      const p2 = PHI * PHI;
      return [
        [[0, 0, 2, 2], false],
        [[1, 1, 1, s5], false],
        [[1 / p2, PHI, PHI, PHI], false],
        [[1 / PHI, 1 / PHI, 1 / PHI, p2], false],
        [[0, 1 / p2, 1, p2], true],
        [[0, 1 / PHI, PHI, s5], true],
        [[1 / PHI, 1, PHI, 2], true],
      ];
    }
    case "tesseract":
      break;
  }
  return [[[1, 1, 1, 1], false]];
}

/**
 * Joins every pair of points at the minimum distance between any two of them:
 * for a regular polytope, exactly its edges.
 */
function joinNearest(vertices: Float64Array): Uint16Array {
  const n = vertices.length / 4;
  const d2 = (i: number, j: number) => {
    let s = 0;
    for (let k = 0; k < 4; k++) {
      const d = vertices[i * 4 + k] - vertices[j * 4 + k];
      s += d * d;
    }
    return s;
  };
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = d2(i, j);
      if (d > 1e-12 && d < min) {
        min = d;
      }
    }
  }
  const limit = min * (1 + 1e-6);
  const edges: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (d2(i, j) <= limit) {
        edges.push(i, j);
      }
    }
  }
  return new Uint16Array(edges);
}

/** Builds `shape`, scaled to unit circumradius. */
export function buildPolytope(shape: PolytopeShape): Polytope {
  const points: number[][] = [];
  for (const [base, even] of generators(shape)) {
    points.push(...signedPermutations(base, even));
  }
  const radius = Math.hypot(...points[0]);
  const vertices = new Float64Array(points.length * 4);
  points.forEach((p, i) => {
    for (let k = 0; k < 4; k++) {
      vertices[i * 4 + k] = p[k] / radius;
    }
  });
  const edges = joinNearest(vertices);
  return { vertices, edges, vertexCount: points.length, edgeCount: edges.length / 2 };
}

/** Rotates rows `i` and `j` of the row-major 4×4 `m` by `angle` in their plane. */
function rotateRows(m: Float64Array, i: number, j: number, angle: number): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let k = 0; k < 4; k++) {
    const a = m[i * 4 + k];
    const b = m[j * 4 + k];
    m[i * 4 + k] = c * a - s * b;
    m[j * 4 + k] = s * a + c * b;
  }
}

/**
 * Writes the row-major 4×4 rotation `R_xz(xz) · R_yz(yz) · R_xw(xw)` to `out`:
 * the double rotation in the XW and YZ planes, then a 3D turn in XZ.
 */
export function rotationMatrix(out: Float64Array, xw: number, yz: number, xz: number): void {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  rotateRows(out, 0, 3, xw);
  rotateRows(out, 1, 2, yz);
  rotateRows(out, 0, 2, xz);
}

/** Floats per projected vertex in `projectPolytope`'s output: x, y, nearness. */
export const PROJECTED_FLOATS = 3;
/** Distance of the 4D eye from the centre along W, in circumradii. */
const EYE_W = 2.5;
/** Distance of the 3D eye from the centre along Z, in circumradii. */
export const EYE_Z = 4;

/**
 * Rotates each vertex of `poly` by `m`, projects it from 4D to 3D (perspective on
 * W, scaled so a vertex at w = 1 keeps its size) and then to the plane (perspective
 * on Z, scaled so z = 0 keeps its size). Writes x and y (y up, in circumradii,
 * within ±EYE_Z / (EYE_Z - 1)) and a nearness in [0, 1] that weighs the 4D depth
 * over the 3D one, to `out`.
 */
export function projectPolytope(poly: Polytope, m: Float64Array, out: Float32Array): void {
  const v = poly.vertices;
  for (let i = 0; i < poly.vertexCount; i++) {
    const x0 = v[i * 4];
    const y0 = v[i * 4 + 1];
    const z0 = v[i * 4 + 2];
    const w0 = v[i * 4 + 3];
    const x = m[0] * x0 + m[1] * y0 + m[2] * z0 + m[3] * w0;
    const y = m[4] * x0 + m[5] * y0 + m[6] * z0 + m[7] * w0;
    const z = m[8] * x0 + m[9] * y0 + m[10] * z0 + m[11] * w0;
    const w = m[12] * x0 + m[13] * y0 + m[14] * z0 + m[15] * w0;
    const s4 = (EYE_W - 1) / (EYE_W - w);
    const z3 = z * s4;
    const s = (s4 * EYE_Z) / (EYE_Z - z3);
    const o = i * PROJECTED_FLOATS;
    out[o] = x * s;
    out[o + 1] = y * s;
    const near = 0.65 * (w + 1) * 0.5 + 0.35 * (z3 + 1) * 0.5;
    out[o + 2] = near < 0 ? 0 : near > 1 ? 1 : near;
  }
}

const RAINBOW_SATURATION = 0.75;

/** One channel of a full-value HSV colour: hue `h` in 0..6, saturation `s`, channel offset `n`. */
function hsvChannel(n: number, h: number, s: number): number {
  const k = (n + h) % 6;
  return 1 - s * Math.max(0, Math.min(k, 4 - k, 1));
}

/**
 * Depth rainbow: violet-blue when far (0) through green to orange-red when near (1),
 * at full value and 0.75 saturation. Writes linear-ish 0..1 RGB to `out`.
 */
export function rainbow(t: number, out: Rgb): Rgb {
  const h = 0.72 * (1 - (t < 0 ? 0 : t > 1 ? 1 : t)) * 6;
  out[0] = hsvChannel(5, h, RAINBOW_SATURATION);
  out[1] = hsvChannel(3, h, RAINBOW_SATURATION);
  out[2] = hsvChannel(1, h, RAINBOW_SATURATION);
  return out;
}
