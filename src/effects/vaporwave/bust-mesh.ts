/**
 * The Vaporwave bust, built in code: a classical head-and-shoulders bust on a
 * round socle, standing on a square pillar. Low-poly on purpose: the head is a
 * deformed sphere whose front column is pulled out into a ridge of a nose, with
 * brow, cheeks, lips, ears and a cap of lumpy curls pushed in and out of the
 * same grid; the shoulders are a loft of rounded-box rings.
 *
 * Units: the head is about 2 tall, centred on the origin; y is up, +z faces
 * the viewer at rest and the bust turns about the y axis. The pillar stays put.
 */

/** Floats per vertex: position (3), normal (3), and 0 for the turning bust or 1 for the pillar. */
export const BUST_FLOATS = 7;

/** The highest and lowest points of the mesh (head top, pillar foot). */
export const BUST_TOP = 1.12;
export const BUST_BOTTOM = -5.6;
/** No vertex is further than this from the turning axis, so the bust fits any angle. */
export const BUST_RADIUS = 1.6;
/** The pillar's foot plate's half width, and the top of the pillar (the bust stands on it). */
export const PILLAR_HALF = 0.8;
const PILLAR_TOP = -2.5;

interface BustMesh {
  /** `BUST_FLOATS` per vertex. */
  vertices: Float32Array;
  /** Triangles, three indices each. */
  indices: Uint16Array;
}

type Vec3 = [number, number, number];

interface Builder {
  pos: number[];
  nrm: number[];
  part: number[];
  idx: number[];
}

const gauss = (x: number, sigma: number) => Math.exp(-(x * x) / (sigma * sigma));

/**
 * A rows x cols grid surface: `at(u, v)` with u in 0..1 around (the seam
 * duplicated) and v in 0..1 from top to bottom. Normals are smooth: face
 * normals summed per vertex, then summed again over vertices that share a
 * position (the seam and the poles), so the grid shades without creases.
 */
function addGrid(
  b: Builder,
  rows: number,
  cols: number,
  at: (u: number, v: number) => Vec3,
  part: number,
): void {
  const base = b.pos.length / 3;
  const n = (rows + 1) * (cols + 1);
  const pos: Vec3[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      pos.push(at(i / cols, j / rows));
    }
  }
  const acc = new Float64Array(n * 3);
  const tri = (a: number, c: number, d: number) => {
    const [ax, ay, az] = pos[a];
    const [cx, cy, cz] = pos[c];
    const [dx, dy, dz] = pos[d];
    // Outward for a surface going round with u and down with v.
    const e1x = dx - ax;
    const e1y = dy - ay;
    const e1z = dz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const k of [a, c, d]) {
      acc[k * 3] += nx;
      acc[k * 3 + 1] += ny;
      acc[k * 3 + 2] += nz;
    }
    b.idx.push(base + a, base + c, base + d);
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * (cols + 1) + i;
      // (k, k+1) along u, (k, k+cols+1) down v.
      tri(k, k + 1, k + cols + 1);
      tri(k + 1, k + cols + 2, k + cols + 1);
    }
  }
  // Weld: vertices at one position share the summed normal.
  const groups = new Map<string, number[]>();
  pos.forEach((p, k) => {
    const key = p.map((c) => c.toFixed(5)).join(",");
    const list = groups.get(key);
    if (list) {
      list.push(k);
    } else {
      groups.set(key, [k]);
    }
  });
  for (const list of groups.values()) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const k of list) {
      x += acc[k * 3];
      y += acc[k * 3 + 1];
      z += acc[k * 3 + 2];
    }
    const len = Math.hypot(x, y, z) || 1;
    for (const k of list) {
      acc[k * 3] = x / len;
      acc[k * 3 + 1] = y / len;
      acc[k * 3 + 2] = z / len;
    }
  }
  for (let k = 0; k < n; k++) {
    b.pos.push(...pos[k]);
    b.nrm.push(acc[k * 3], acc[k * 3 + 1], acc[k * 3 + 2]);
    b.part.push(part);
  }
}

/** A flat-shaded quad, corners in order round its edge, facing `normal`. */
function addQuad(b: Builder, corners: readonly Vec3[], normal: Vec3, part: number): void {
  const base = b.pos.length / 3;
  for (const c of corners) {
    b.pos.push(...c);
    b.nrm.push(...normal);
    b.part.push(part);
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** A square block from y0 down to y1, half width h: its sides and top (the bottom never shows). */
function addBlock(b: Builder, y0: number, y1: number, h: number, part: number): void {
  addQuad(
    b,
    [
      [-h, y0, -h],
      [h, y0, -h],
      [h, y0, h],
      [-h, y0, h],
    ],
    [0, 1, 0],
    part,
  );
  addQuad(
    b,
    [
      [-h, y0, h],
      [h, y0, h],
      [h, y1, h],
      [-h, y1, h],
    ],
    [0, 0, 1],
    part,
  );
  addQuad(
    b,
    [
      [h, y0, -h],
      [-h, y0, -h],
      [-h, y1, -h],
      [h, y1, -h],
    ],
    [0, 0, -1],
    part,
  );
  addQuad(
    b,
    [
      [h, y0, h],
      [h, y0, -h],
      [h, y1, -h],
      [h, y1, h],
    ],
    [1, 0, 0],
    part,
  );
  addQuad(
    b,
    [
      [-h, y0, -h],
      [-h, y0, h],
      [-h, y1, h],
      [-h, y1, -h],
    ],
    [-1, 0, 0],
    part,
  );
}

/** The nose's push out of the face by height on the head: from the brow down to the tip. */
function noseProfile(y: number): number {
  if (y > 0.35 || y < -0.32) {
    return 0;
  }
  return y > -0.15 ? 0.17 * ((0.35 - y) / 0.5) ** 0.8 : 0.17 * ((y + 0.32) / 0.17);
}

/** A point on the head: u around (0.5 is the front), v from crown to chin. */
function headPoint(u: number, v: number): Vec3 {
  const theta = 2 * Math.PI * u - Math.PI;
  const phi = Math.PI * v;
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const y0 = Math.cos(phi);
  const ring = Math.sin(phi);
  // Ellipsoid: narrower than tall, a little shallower than deep.
  let x = 0.78 * ring * st;
  let y = y0;
  let z = 0.9 * ring * ct;
  const front = Math.max(0, ct);
  // Jaw and chin: the lower head narrows, and the chin comes forward.
  if (y0 < 0) {
    x *= 1 - 0.3 * y0 * y0;
    z *= 1 - 0.12 * y0 * y0;
    z += 0.1 * -y0 * front ** 2;
  }
  // Push along the outward direction: features on the face, curls everywhere else.
  let push = 0;
  push += noseProfile(y0) * gauss(theta, 0.15);
  push += 0.05 * gauss(y0 - 0.22, 0.1) * gauss(theta, 0.7);
  push -= 0.06 * gauss(y0 - 0.02, 0.12) * (gauss(theta - 0.36, 0.16) + gauss(theta + 0.36, 0.16));
  push += 0.035 * gauss(y0 + 0.45, 0.08) * gauss(theta, 0.2);
  push += 0.09 * gauss(y0 + 0.02, 0.18) * gauss(Math.abs(theta) - Math.PI / 2, 0.2);
  // Hair covers the crown and the back, stopping at the brow.
  const hair = Math.min(1, Math.max(0, (y0 - 0.3) / 0.2) + Math.max(0, (-ct - 0.1) / 0.3));
  push += hair * (0.07 + 0.035 * Math.sin(5 * theta) * Math.sin(7 * phi));
  if (push !== 0) {
    const len = Math.hypot(x, y, z);
    x += (push * x) / len;
    y += (push * y) / len;
    z += (push * z) / len;
  }
  return [x, y, z];
}

/** Rings of the shoulders loft: height, half width, half depth, z offset. */
const TORSO: readonly (readonly [number, number, number, number])[] = [
  [-0.85, 0.36, 0.33, -0.12],
  [-1.15, 0.95, 0.45, -0.08],
  [-1.32, 1.36, 0.52, -0.02],
  [-1.55, 1.5, 0.55, 0],
  [-1.85, 1.42, 0.56, 0.02],
  [-2.1, 1.1, 0.5, 0],
  [-2.24, 0.6, 0.4, 0],
  [-2.26, 0, 0, 0],
];

/** The socle under the shoulders, as (height, radius) rings, closed at the bottom. */
const SOCLE: readonly (readonly [number, number])[] = [
  [-2.16, 0.42],
  [-2.3, 0.4],
  [-2.36, 0.56],
  [-2.5, 0.6],
  [-2.5, 0],
];

/** A superellipse ring point: a rounded box for exponents above 2. */
function roundedBox(theta: number, ax: number, az: number, power: number): [number, number] {
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const e = 2 / power;
  return [ax * Math.sign(s) * Math.abs(s) ** e, az * Math.sign(c) * Math.abs(c) ** e];
}

/** Builds the bust and pillar: about a thousand triangles. */
export function buildBustMesh(): BustMesh {
  const b: Builder = { pos: [], nrm: [], part: [], idx: [] };
  addGrid(b, 14, 18, headPoint, 0);
  // The neck, from inside the head down into the shoulders.
  addGrid(
    b,
    2,
    16,
    (u, v) => {
      const t = 2 * Math.PI * u - Math.PI;
      const y = -0.45 - 0.55 * v;
      return [0.34 * Math.sin(t), y, -0.12 + 0.32 * Math.cos(t)];
    },
    0,
  );
  addGrid(
    b,
    TORSO.length - 1,
    20,
    (u, v) => {
      const ring = TORSO[Math.round(v * (TORSO.length - 1))];
      const [x, z] = roundedBox(2 * Math.PI * u - Math.PI, ring[1], ring[2], 2.6);
      return [x, ring[0], z + ring[3]];
    },
    0,
  );
  addGrid(
    b,
    SOCLE.length - 1,
    16,
    (u, v) => {
      const ring = SOCLE[Math.round(v * (SOCLE.length - 1))];
      const t = 2 * Math.PI * u - Math.PI;
      return [ring[1] * Math.sin(t), ring[0], ring[1] * Math.cos(t)];
    },
    0,
  );
  // The pillar: a capital plate, the shaft and a foot plate.
  addBlock(b, PILLAR_TOP, PILLAR_TOP - 0.16, PILLAR_HALF, 1);
  addBlock(b, PILLAR_TOP - 0.16, BUST_BOTTOM + 0.3, 0.62, 1);
  addBlock(b, BUST_BOTTOM + 0.3, BUST_BOTTOM, PILLAR_HALF, 1);

  const count = b.part.length;
  const vertices = new Float32Array(count * BUST_FLOATS);
  for (let k = 0; k < count; k++) {
    const o = k * BUST_FLOATS;
    vertices[o] = b.pos[k * 3];
    vertices[o + 1] = b.pos[k * 3 + 1];
    vertices[o + 2] = b.pos[k * 3 + 2];
    vertices[o + 3] = b.nrm[k * 3];
    vertices[o + 4] = b.nrm[k * 3 + 1];
    vertices[o + 5] = b.nrm[k * 3 + 2];
    vertices[o + 6] = b.part[k];
  }
  return { vertices, indices: new Uint16Array(b.idx) };
}
