/**
 * The Rollercoaster's geometry, built once on the CPU: the static scene (track,
 * ties, columns, station, trees and the Ferris wheel) as one indexed mesh, the
 * car as a small mesh drawn once per car, and the light bulbs and stars as
 * billboard instances.
 *
 * Vertices are `VERTEX_FLOATS` floats: position, normal, then a material: an
 * index into the effect's palette, plus `ROTATING` for the parts of the Ferris
 * wheel that turn about its axle.
 */
import type { Track } from "./rollercoaster-track";
import { createRng } from "../noise";

export const VERTEX_FLOATS = 7;

/** Palette slots. */
export const MAT_RAIL = 0;
export const MAT_SPINE = 1;
export const MAT_COLUMN = 2;
export const MAT_CONCRETE = 3;
export const MAT_ROOF = 4;
export const MAT_PINE_DARK = 5;
export const MAT_PINE_LIGHT = 6;
export const MAT_TRUNK = 7;
export const MAT_WHEEL = 8;
export const MAT_CAR = 9;
export const MAT_SEAT = 10;
export const MAT_HEAD = 11;
export const MAT_BOGIE = 12;
export const MATERIAL_COUNT = 13;
/** Added to a material for parts that turn with the Ferris wheel. */
export const ROTATING = 16;

/** Rails sit this far either side of the centreline; the spine hangs this far below. */
const RAIL_OFFSET = 0.55;
const SPINE_DROP = 0.6;
const RAIL_RADIUS = 0.12;
const SPINE_RADIUS = 0.26;
const TIE_RADIUS = 0.06;
/** Spacing of the ties along the track, metres. */
const TIE_SPACING = 1.6;

/** The Ferris wheel: hub position, rim radius, and half the gap between its two rims. */
export const WHEEL_CENTRE = [118, 30, -150] as const;
const WHEEL_RADIUS = 24;
const WHEEL_HALF_DEPTH = 1.6;
const WHEEL_SPOKES = 16;
/** One turn every this many seconds. */
export const WHEEL_PERIOD = 120;

/** Length of a car and the gap between car middles, metres. */
export const CAR_SPACING = 2.9;

/** Light kinds, for the billboard pass's per-kind brightness. */
const LIGHT_TRACK = 0;
const LIGHT_WHEEL = 1;
export const LIGHT_STAR = 2;
/** Floats per light: position (or direction, for stars), size, colour, kind. */
export const LIGHT_FLOATS = 8;
/** Stars sit this far from the eye, metres. */
export const STAR_DISTANCE = 1800;

class MeshBuilder {
  readonly v: number[] = [];
  readonly i: number[] = [];

  get vertexCount() {
    return this.v.length / VERTEX_FLOATS;
  }

  vertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, mat: number) {
    this.v.push(px, py, pz, nx, ny, nz, mat);
  }

  quad(a: number, b: number, c: number, d: number) {
    this.i.push(a, b, c, a, c, d);
  }

  /**
   * A tube along the polyline of `centres` (xyz triples) with ring axes `ax`
   * and `ay` per point (unit, square to the line), `sides` round. Closed
   * tubes join the last ring to the first.
   */
  tube(
    centres: ArrayLike<number>,
    ax: ArrayLike<number>,
    ay: ArrayLike<number>,
    radius: number,
    sides: number,
    mat: number,
    closed: boolean,
  ) {
    const n = centres.length / 3;
    const base = this.vertexCount;
    for (let p = 0; p < n; p++) {
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const nx = ax[p * 3] * c + ay[p * 3] * s;
        const ny = ax[p * 3 + 1] * c + ay[p * 3 + 1] * s;
        const nz = ax[p * 3 + 2] * c + ay[p * 3 + 2] * s;
        this.vertex(
          centres[p * 3] + nx * radius,
          centres[p * 3 + 1] + ny * radius,
          centres[p * 3 + 2] + nz * radius,
          nx,
          ny,
          nz,
          mat,
        );
      }
    }
    const segments = closed ? n : n - 1;
    for (let p = 0; p < segments; p++) {
      const r0 = base + p * sides;
      const r1 = base + ((p + 1) % n) * sides;
      for (let k = 0; k < sides; k++) {
        const k1 = (k + 1) % sides;
        this.quad(r0 + k, r0 + k1, r1 + k1, r1 + k);
      }
    }
  }

  /** A cylinder (or cone, with `r1` 0) from `a` to `b`, open-ended. */
  cylinder(
    a: readonly number[],
    b: readonly number[],
    r0: number,
    r1: number,
    sides: number,
    mat: number,
  ) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    const t = [dx / len, dy / len, dz / len];
    const ref = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = cross(t, ref);
    normalise(u);
    const w = cross(t, u);
    // Slope of a cone's side, tilting its normals towards the tip.
    const slope = (r0 - r1) / len;
    const base = this.vertexCount;
    for (let k = 0; k < sides; k++) {
      const ang = (k / sides) * Math.PI * 2;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const rx = u[0] * c + w[0] * s;
      const ry = u[1] * c + w[1] * s;
      const rz = u[2] * c + w[2] * s;
      const nl = Math.hypot(1, slope);
      const nx = (rx + t[0] * slope) / nl;
      const ny = (ry + t[1] * slope) / nl;
      const nz = (rz + t[2] * slope) / nl;
      this.vertex(a[0] + rx * r0, a[1] + ry * r0, a[2] + rz * r0, nx, ny, nz, mat);
      this.vertex(b[0] + rx * r1, b[1] + ry * r1, b[2] + rz * r1, nx, ny, nz, mat);
    }
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      this.quad(base + k * 2, base + k1 * 2, base + k1 * 2 + 1, base + k * 2 + 1);
    }
  }

  /** A box at `c` with half-extent axes `ex`, `ey`, `ez` (orthogonal). */
  box(
    c: readonly number[],
    ex: readonly number[],
    ey: readonly number[],
    ez: readonly number[],
    mat: number,
  ) {
    const axes = [ex, ey, ez];
    for (let f = 0; f < 6; f++) {
      const ax = axes[f >> 1];
      const sign = f & 1 ? -1 : 1;
      const u = axes[((f >> 1) + 1) % 3];
      const w = axes[((f >> 1) + 2) % 3];
      const n = [ax[0] * sign, ax[1] * sign, ax[2] * sign];
      normalise(n);
      const base = this.vertexCount;
      for (const [su, sw] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const ss = sign * su;
        this.vertex(
          c[0] + ax[0] * sign + u[0] * ss + w[0] * sw,
          c[1] + ax[1] * sign + u[1] * ss + w[1] * sw,
          c[2] + ax[2] * sign + u[2] * ss + w[2] * sw,
          n[0],
          n[1],
          n[2],
          mat,
        );
      }
      this.quad(base, base + 1, base + 2, base + 3);
    }
  }

  /** A low-poly sphere at `c`. */
  sphere(c: readonly number[], r: number, mat: number) {
    const rings = 5;
    const sides = 8;
    const base = this.vertexCount;
    for (let y = 0; y <= rings; y++) {
      const phi = (y / rings) * Math.PI;
      for (let k = 0; k < sides; k++) {
        const th = (k / sides) * Math.PI * 2;
        const nx = Math.sin(phi) * Math.cos(th);
        const ny = Math.cos(phi);
        const nz = Math.sin(phi) * Math.sin(th);
        this.vertex(c[0] + nx * r, c[1] + ny * r, c[2] + nz * r, nx, ny, nz, mat);
      }
    }
    for (let y = 0; y < rings; y++) {
      for (let k = 0; k < sides; k++) {
        const k1 = (k + 1) % sides;
        const a = base + y * sides;
        const b = a + sides;
        this.quad(a + k, b + k, b + k1, a + k1);
      }
    }
  }

  build(): Mesh {
    return { vertices: new Float32Array(this.v), indices: new Uint32Array(this.i) };
  }
}

export interface Mesh {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

function cross(a: readonly number[], b: readonly number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalise(v: number[]): void {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= l;
  v[1] /= l;
  v[2] /= l;
}

/** Arc lengths of the columns: upright track, high enough, nothing else in the way below. */
export function columnSites(track: Track): number[] {
  const out: number[] = [];
  const every = Math.round(9 / track.step);
  const { pos, nrm } = track;
  for (let i = 0; i < track.count; i += every) {
    const o = i * 3;
    if (nrm[o + 1] < 0.55 || pos[o + 1] < 2) {
      continue;
    }
    if (columnBlocked(track, i)) {
      continue;
    }
    out.push(i * track.step);
  }
  return out;
}

/** Whether another stretch of track passes within the column under sample `i`. */
export function columnBlocked(track: Track, i: number): boolean {
  const { pos } = track;
  const x = pos[i * 3];
  const top = pos[i * 3 + 1] - SPINE_DROP;
  const z = pos[i * 3 + 2];
  const near = Math.round(4 / track.step);
  for (let j = 0; j < track.count; j++) {
    const gap = Math.abs(j - i);
    if (Math.min(gap, track.count - gap) <= near) {
      continue;
    }
    const y = pos[j * 3 + 1];
    if (y > top + 1.5) {
      continue;
    }
    if (Math.hypot(pos[j * 3] - x, pos[j * 3 + 2] - z) < 2.2) {
      return true;
    }
  }
  return false;
}

/** Horizontal distance from (x, z) to the nearest track sample (checking every few). */
function distanceToTrack(track: Track, x: number, z: number): number {
  let best = Infinity;
  for (let j = 0; j < track.count; j += 4) {
    best = Math.min(best, Math.hypot(track.pos[j * 3] - x, track.pos[j * 3 + 2] - z));
  }
  return best;
}

/** The station's extent along x and the far side of its platform in z. */
const STATION = { x0: -97, x1: -83, z: 8 };

/** Tree positions and sizes: x, z, height, radius, light (0/1). Deterministic. */
export function treeSites(track: Track): number[] {
  const rng = createRng(1187);
  const out: number[] = [];
  let tries = 0;
  while (out.length < 110 * 5 && tries < 4000) {
    tries++;
    const x = -230 + rng() * 460;
    const z = -190 + rng() * 225;
    const h = 7 + rng() * 6;
    const r = h * (0.26 + rng() * 0.08);
    const light = rng() < 0.4 ? 1 : 0;
    // Clear of the track, the station and the Ferris wheel; nothing in front of the middle.
    if (distanceToTrack(track, x, z) < r + 8) {
      continue;
    }
    if (x > STATION.x0 - 8 && x < STATION.x1 + 8 && z > -2 && z < 22) {
      continue;
    }
    if (Math.hypot(x - WHEEL_CENTRE[0], z - WHEEL_CENTRE[2]) < 20) {
      continue;
    }
    if (z > 14 && Math.abs(x) < 90) {
      continue;
    }
    out.push(x, z, h, r, light);
  }
  return out;
}

/** The static scene: track, ties, columns, station, trees and the Ferris wheel. */
export function buildScene(track: Track): Mesh {
  const m = new MeshBuilder();
  const { count, pos, nrm, bin } = track;

  // Rails and spine, one ring per metre.
  const every = Math.max(1, Math.round(1 / track.step));
  const rings = Math.floor(count / every);
  const left = new Float64Array(rings * 3);
  const right = new Float64Array(rings * 3);
  const spine = new Float64Array(rings * 3);
  const ax = new Float64Array(rings * 3);
  const ay = new Float64Array(rings * 3);
  for (let r = 0; r < rings; r++) {
    const o = r * every * 3;
    for (let k = 0; k < 3; k++) {
      left[r * 3 + k] = pos[o + k] - bin[o + k] * RAIL_OFFSET;
      right[r * 3 + k] = pos[o + k] + bin[o + k] * RAIL_OFFSET;
      spine[r * 3 + k] = pos[o + k] - nrm[o + k] * SPINE_DROP;
      ax[r * 3 + k] = bin[o + k];
      ay[r * 3 + k] = nrm[o + k];
    }
  }
  m.tube(left, ax, ay, RAIL_RADIUS, 8, MAT_RAIL, true);
  m.tube(right, ax, ay, RAIL_RADIUS, 8, MAT_RAIL, true);
  m.tube(spine, ax, ay, SPINE_RADIUS, 10, MAT_SPINE, true);

  // Ties: a strut from each rail down to the spine.
  const tieEvery = Math.max(1, Math.round(TIE_SPACING / track.step));
  for (let i = 0; i < count; i += tieEvery) {
    const o = i * 3;
    const sp = [0, 1, 2].map((k) => pos[o + k] - nrm[o + k] * SPINE_DROP);
    for (const side of [-1, 1]) {
      const rail = [0, 1, 2].map((k) => pos[o + k] + bin[o + k] * RAIL_OFFSET * side);
      m.cylinder(rail, sp, TIE_RADIUS, TIE_RADIUS, 4, MAT_SPINE);
    }
  }

  // Columns down to the ground, on concrete footings.
  for (const s of columnSites(track)) {
    const i = Math.round(s / track.step);
    const o = i * 3;
    const top = [0, 1, 2].map((k) => pos[o + k] - nrm[o + k] * SPINE_DROP);
    const radius = 0.26 + top[1] * 0.006;
    m.cylinder([top[0], 0.4, top[2]], top, radius, radius, 8, MAT_COLUMN);
    m.box([top[0], 0.2, top[2]], [0.7, 0, 0], [0, 0.2, 0], [0, 0, 0.7], MAT_CONCRETE);
  }

  // Station: a platform beside the track and a roof on four posts.
  {
    const { x0, x1, z } = STATION;
    const cx = (x0 + x1) / 2;
    const hx = (x1 - x0) / 2;
    m.box([cx, 0.55, z + 2.6], [hx, 0, 0], [0, 0.55, 0], [0, 0, 1.6], MAT_CONCRETE);
    m.box([cx, 5.2, z + 0.8], [hx + 0.8, 0, 0], [0, 0.18, 0], [0, 0, 3.8], MAT_ROOF);
    for (const px of [x0 + 0.5, x1 - 0.5]) {
      for (const pz of [z - 2.2, z + 3.8]) {
        m.cylinder([px, 0, pz], [px, 5.05, pz], 0.14, 0.14, 6, MAT_COLUMN);
      }
    }
  }

  // Pines: a trunk and two stacked cones.
  const trees = treeSites(track);
  for (let t = 0; t < trees.length; t += 5) {
    const [x, z, h, r, light] = trees.slice(t, t + 5);
    const mat = light ? MAT_PINE_LIGHT : MAT_PINE_DARK;
    m.cylinder([x, 0, z], [x, h * 0.3, z], r * 0.12, r * 0.1, 5, MAT_TRUNK);
    m.cylinder([x, h * 0.18, z], [x, h * 0.75, z], r, 0, 9, mat);
    m.cylinder([x, h * 0.5, z], [x, h, z], r * 0.72, 0, 9, mat);
  }

  // The Ferris wheel: two rims, spokes and cross-struts turning on the axle; legs and hub fixed.
  {
    const [wx, wy, wz] = WHEEL_CENTRE;
    const rim = (k: number, dz: number) => {
      const a = (k / 48) * Math.PI * 2;
      return [wx + Math.cos(a) * WHEEL_RADIUS, wy + Math.sin(a) * WHEEL_RADIUS, wz + dz];
    };
    for (const dz of [-WHEEL_HALF_DEPTH, WHEEL_HALF_DEPTH]) {
      for (let k = 0; k < 48; k++) {
        m.cylinder(rim(k, dz), rim(k + 1, dz), 0.3, 0.3, 5, MAT_WHEEL + ROTATING);
      }
      for (let k = 0; k < WHEEL_SPOKES; k++) {
        const end = rim((k * 48) / WHEEL_SPOKES, dz);
        m.cylinder([wx, wy, wz + dz * 0.4], end, 0.12, 0.12, 4, MAT_WHEEL + ROTATING);
      }
    }
    for (let k = 0; k < WHEEL_SPOKES; k++) {
      const a = rim((k * 48) / WHEEL_SPOKES, -WHEEL_HALF_DEPTH);
      const b = rim((k * 48) / WHEEL_SPOKES, WHEEL_HALF_DEPTH);
      m.cylinder(a, b, 0.14, 0.14, 4, MAT_WHEEL + ROTATING);
      // A gondola round each strut: square on, so turning with the wheel doesn't show.
      m.box(
        [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, wz],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        MAT_CAR + ROTATING,
      );
    }
    m.cylinder([wx, wy, wz - 3], [wx, wy, wz + 3], 0.9, 0.9, 10, MAT_WHEEL);
    for (const dz of [-3, 3]) {
      for (const dx of [-1, 1]) {
        m.cylinder([wx, wy, wz + dz], [wx + dx * 15, 0, wz + dz * 2.2], 0.55, 0.55, 6, MAT_WHEEL);
      }
    }
  }

  return m.build();
}

/**
 * One car, in its own frame: x forward along the track, y up out of it, z to
 * the right, with the rails at y = 0. A bogie, the body, two rows of seat
 * backs and four riders' heads.
 */
export function buildCar(): Mesh {
  const m = new MeshBuilder();
  const X = [1, 0, 0];
  const Y = [0, 1, 0];
  const Z = [0, 0, 1];
  const s = (v: number[], k: number) => v.map((c) => c * k);
  m.box([0, 0.1, 0], s(X, 1.0), s(Y, 0.14), s(Z, 0.66), MAT_BOGIE);
  m.box([0, 0.56, 0], s(X, 1.25), s(Y, 0.32), s(Z, 0.8), MAT_CAR);
  m.box([1.28, 0.5, 0], s(X, 0.12), s(Y, 0.24), s(Z, 0.72), MAT_BOGIE);
  for (const row of [0.35, -0.75]) {
    m.box([row - 0.18, 1.06, 0], s(X, 0.08), s(Y, 0.24), s(Z, 0.72), MAT_SEAT);
    for (const side of [-0.36, 0.36]) {
      m.sphere([row + 0.05, 1.32, side], 0.17, MAT_HEAD);
    }
  }
  return m.build();
}

/** The light bulbs along the rails and round the wheel, and the stars. Deterministic. */
export function buildLights(track: Track): Float32Array {
  const out: number[] = [];
  const { count, pos, nrm, bin } = track;
  const every = Math.max(1, Math.round(2.2 / track.step));
  for (let i = 0; i < count; i += every) {
    const o = i * 3;
    for (const side of [-1, 1]) {
      out.push(
        pos[o] + bin[o] * (RAIL_OFFSET + 0.22) * side + nrm[o] * 0.08,
        pos[o + 1] + bin[o + 1] * (RAIL_OFFSET + 0.22) * side + nrm[o + 1] * 0.08,
        pos[o + 2] + bin[o + 2] * (RAIL_OFFSET + 0.22) * side + nrm[o + 2] * 0.08,
        0.22,
        1,
        0.82,
        0.5,
        LIGHT_TRACK,
      );
    }
  }
  const wheelColours = [
    [1, 0.35, 0.3],
    [1, 0.85, 0.35],
    [0.4, 0.75, 1],
    [0.5, 1, 0.55],
  ];
  const [wx, wy, wz] = WHEEL_CENTRE;
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    const c = wheelColours[k % 4];
    out.push(
      wx + Math.cos(a) * WHEEL_RADIUS,
      wy + Math.sin(a) * WHEEL_RADIUS,
      wz + WHEEL_HALF_DEPTH + 0.4,
      0.7,
      c[0],
      c[1],
      c[2],
      LIGHT_WHEEL,
    );
  }
  for (let k = 0; k < WHEEL_SPOKES; k++) {
    const a = (k / WHEEL_SPOKES) * Math.PI * 2;
    for (let j = 1; j <= 3; j++) {
      const r = (WHEEL_RADIUS * j) / 4;
      out.push(
        wx + Math.cos(a) * r,
        wy + Math.sin(a) * r,
        wz + WHEEL_HALF_DEPTH + 0.4,
        0.5,
        1,
        0.9,
        0.7,
        LIGHT_WHEEL,
      );
    }
  }
  // Stars: directions above the hills, stored as unit vectors.
  const rng = createRng(4021);
  for (let k = 0; k < 700; k++) {
    const az = rng() * Math.PI * 2;
    // Denser towards the horizon, where the side view looks.
    const el = Math.asin(0.05 + rng() ** 2 * 0.95);
    const bright = 0.35 + rng() ** 3 * 0.65;
    const warm = rng();
    out.push(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      -Math.cos(el) * Math.cos(az),
      2.2 + bright * 2.4,
      bright * (0.85 + warm * 0.15),
      bright * 0.9,
      bright * (1 - warm * 0.15),
      LIGHT_STAR,
    );
  }
  return new Float32Array(out);
}
