/**
 * Flat filled outlines as triangles, for Corporate Memphis's people: each part
 * (a sleeve, a shin, a head) is a strip between two sides of points, filled
 * and ringed with a one-device-px fringe that fades to nothing, so its edge is
 * antialiased without multisampling.
 *
 * Vertex layout (`VERTEX_FLOATS`, reference px, y down): position, then
 * straight RGB and opacity.
 */

export const VERTEX_FLOATS = 6;
/** The most vertices and indices a frame draws (indices are 16-bit). */
export const MAX_VERTICES = 32768;
export const MAX_INDICES = 98304;
/** The most parts a frame records bounds for. */
const MAX_PARTS = 512;
/** The most points along one side of a strip. */
export const MAX_SIDE = 96;

export interface Mesh {
  vertices: Float32Array;
  indices: Uint16Array;
  vertexCount: number;
  indexCount: number;
  /** Per part, for tests: its bounds [x0, y0, x1, y1] (ref px) and tag. */
  bounds: Float64Array;
  tags: Uint8Array;
  partCount: number;
  /** The antialiasing fringe's width, ref px (one device px). */
  feather: number;
}

export function createMesh(): Mesh {
  return {
    vertices: new Float32Array(MAX_VERTICES * VERTEX_FLOATS),
    indices: new Uint16Array(MAX_INDICES),
    vertexCount: 0,
    indexCount: 0,
    bounds: new Float64Array(MAX_PARTS * 4),
    tags: new Uint8Array(MAX_PARTS),
    partCount: 0,
    feather: 1,
  };
}

export function resetMesh(mesh: Mesh, feather: number): void {
  mesh.vertexCount = 0;
  mesh.indexCount = 0;
  mesh.partCount = 0;
  mesh.feather = feather;
}

/**
 * The strip being built: `n` points along each side, ref px. Side "lo" and side
 * "hi" run the same way; the outline is lo forwards, then hi backwards.
 */
export const strip = {
  n: 0,
  lx: new Float64Array(MAX_SIDE),
  ly: new Float64Array(MAX_SIDE),
  hx: new Float64Array(MAX_SIDE),
  hy: new Float64Array(MAX_SIDE),
};

/** Outline point `k` of the strip (0..2n-1), x or y. */
function ox(k: number): number {
  const n = strip.n;
  return k < n ? strip.lx[k] : strip.hx[2 * n - 1 - k];
}
function oy(k: number): number {
  const n = strip.n;
  return k < n ? strip.ly[k] : strip.hy[2 * n - 1 - k];
}

function vertex(mesh: Mesh, x: number, y: number, rgb: ArrayLike<number>, c: number, a: number) {
  const o = mesh.vertexCount * VERTEX_FLOATS;
  const v = mesh.vertices;
  v[o] = x;
  v[o + 1] = y;
  v[o + 2] = rgb[c];
  v[o + 3] = rgb[c + 1];
  v[o + 4] = rgb[c + 2];
  v[o + 5] = a;
  mesh.vertexCount++;
}

function tri(mesh: Mesh, a: number, b: number, c: number): void {
  const i = mesh.indices;
  const o = mesh.indexCount;
  i[o] = a;
  i[o + 1] = b;
  i[o + 2] = c;
  mesh.indexCount += 3;
}

/**
 * Fills the current strip in colour `rgb[c..c+2]` at opacity `alpha`, with its
 * fringe, and records its bounds under `tag`. Does nothing when the mesh is full.
 */
export function fillStrip(
  mesh: Mesh,
  rgb: ArrayLike<number>,
  c: number,
  alpha: number,
  tag: number,
): void {
  const n = strip.n;
  const m = 2 * n;
  if (
    n < 2 ||
    alpha <= 0 ||
    mesh.vertexCount + 2 * m > MAX_VERTICES ||
    mesh.indexCount + 3 * (2 * (n - 1) + 2 * m) > MAX_INDICES ||
    mesh.partCount >= MAX_PARTS
  ) {
    return;
  }
  const base = mesh.vertexCount;
  // The outline's winding says which side is outside.
  let area = 0;
  for (let k = 0; k < m; k++) {
    const k2 = k + 1 === m ? 0 : k + 1;
    area += ox(k) * oy(k2) - ox(k2) * oy(k);
  }
  const out = area > 0 ? 1 : -1;
  const f = mesh.feather;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  // Lo points then hi points, each in strip order; the fringe follows in outline order.
  for (let k = 0; k < m; k++) {
    const x = k < n ? strip.lx[k] : strip.hx[k - n];
    const y = k < n ? strip.ly[k] : strip.hy[k - n];
    vertex(mesh, x, y, rgb, c, alpha);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  for (let k = 0; k < m; k++) {
    // The tangent from the neighbours either side, reaching further past repeats.
    let tx = 0;
    let ty = 0;
    for (let s = 1; s <= 3 && tx * tx + ty * ty < 1e-12; s++) {
      const p = (k - s + m) % m;
      const q = (k + s) % m;
      tx = ox(q) - ox(p);
      ty = oy(q) - oy(p);
    }
    const len = Math.hypot(tx, ty);
    const nx = len > 0 ? (out * ty) / len : 0;
    const ny = len > 0 ? (-out * tx) / len : 0;
    vertex(mesh, ox(k) + nx * f, oy(k) + ny * f, rgb, c, 0);
  }
  // Outline index k to vertex: lo points first, then hi.
  const at = (k: number) => base + (k < n ? k : n + (m - 1 - k));
  for (let i = 0; i < n - 1; i++) {
    const l0 = base + i;
    const h0 = base + n + i;
    tri(mesh, l0, l0 + 1, h0);
    tri(mesh, h0, l0 + 1, h0 + 1);
  }
  for (let k = 0; k < m; k++) {
    const k2 = k + 1 === m ? 0 : k + 1;
    const fa = base + m + k;
    const fb = base + m + k2;
    tri(mesh, at(k), at(k2), fa);
    tri(mesh, fa, at(k2), fb);
  }
  const b = mesh.bounds;
  const o = 4 * mesh.partCount;
  b[o] = x0 - f;
  b[o + 1] = y0 - f;
  b[o + 2] = x1 + f;
  b[o + 3] = y1 + f;
  mesh.tags[mesh.partCount] = tag;
  mesh.partCount++;
}
