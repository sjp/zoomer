/**
 * The Rollercoaster's circuit: a closed centripetal Catmull–Rom spline through
 * hand-placed points, resampled at an even arc-length step, with a frame at
 * every sample (tangent, normal pointing out of the top of the track, binormal
 * to the rider's right) and the train's physical speed there.
 *
 * World units are metres: x to the right of the side view, y up from the
 * ground, z towards the side-view camera. The train runs along +x at the front
 * (station, lift, drop, loop), turns away at the right, comes back along the
 * back row and turns in again at the left. Track heights are rail height; the
 * spine tube hangs below that.
 */

/** Gravity, m/s². */
export const GRAVITY = 9.81;
/** Chain speed on the station and lift, m/s. */
const CHAIN_SPEED = 3.5;
/** Rolling and air resistance, as a fraction of gravity. */
const FRICTION = 0.011;
/** Speed the brake run brings the train down to at the station, m/s. */
const STATION_SPEED = 3.5;
/** Brake run deceleration, m/s². */
const BRAKE = 2.2;
/** The slowest the train is ever allowed to crawl, m/s. */
export const MIN_SPEED = 2;
/** Steepest bank, radians. */
const MAX_BANK = 1.15;
/** Target sample spacing along the track, metres. */
const TARGET_STEP = 0.5;
/** Spline points per segment for measuring arc length. */
const SUBDIVISIONS = 64;

type Point = readonly [number, number, number];

/**
 * A vertical loop entered at (`x0`, `y0`, `z0`) heading +x: a teardrop whose
 * radius of curvature eases from `rBottom` at the bottom to `rTop` over the top,
 * as real loops are shaped to keep the forces gentle. It drifts back by `dz`
 * from entry to exit, so the exit runs alongside the entry. Points about
 * every 3 m, excluding the entry, including the exit.
 */
function loopPoints(x0: number, y0: number, z0: number, dz: number, rTop: number, rBottom: number) {
  const out: Point[] = [];
  const ds = 0.05;
  let x = x0;
  let y = y0;
  let theta = 0;
  let s = 0;
  let next = 3;
  while (theta < Math.PI * 2) {
    const w = ((1 + Math.cos(theta)) / 2) ** 2;
    theta += ds / (rTop + (rBottom - rTop) * w);
    x += Math.cos(theta) * ds;
    y += Math.sin(theta) * ds;
    s += ds;
    if (s >= next) {
      next += 3;
      out.push([x, y, z0 - (dz * theta) / (Math.PI * 2)]);
    }
  }
  out.push([x, y0, z0 - dz]);
  return out;
}

/**
 * A cosine bump from `x0` to `x1` at depth `z`, rising from `base` by `height`:
 * long and low, so its crest's radius stays wide enough for gentle airtime.
 * Points about every 4 m, excluding both ends.
 */
function hillPoints(x0: number, x1: number, z: number, base: number, height: number) {
  const out: Point[] = [];
  const n = Math.max(2, Math.round(Math.abs(x1 - x0) / 4));
  for (let k = 1; k < n; k++) {
    const u = k / n;
    out.push([x0 + (x1 - x0) * u, base + (height * (1 - Math.cos(u * Math.PI * 2))) / 2, z]);
  }
  return out;
}

const LOOP_ENTRY: Point = [16, 1.9, 2.6];
const LOOP = loopPoints(LOOP_ENTRY[0], LOOP_ENTRY[1], LOOP_ENTRY[2], 4.5, 6, 19);
const LOOP_EXIT = LOOP[LOOP.length - 1];

/** The circuit's control points, starting at the station. */
const POINTS: readonly Point[] = [
  // Station, heading +x.
  [-94, 1.6, 8],
  [-88, 1.6, 8],
  // Lift hill, about 40 degrees.
  [-82, 2.4, 8],
  [-77, 5.6, 8],
  [-59, 21.4, 8],
  [-53, 25.6, 8],
  // Crest (CREST_POINT).
  [-48, 27.2, 8],
  [-44, 26.4, 8],
  // First drop.
  [-40, 22, 8],
  [-35.5, 12.5, 8],
  [-30.5, 5.6, 7.8],
  [-23, 2.3, 7.2],
  [-13, 1.8, 6.2],
  // The low run through the middle.
  [-3, 1.9, 5],
  [6, 1.9, 3.8],
  // Vertical loop (from LOOP_START to LOOP_END).
  LOOP_ENTRY,
  ...LOOP,
  // Exit, then a low airtime hill and the banked turnaround on the right.
  ...hillPoints(LOOP_EXIT[0] + 6, 80, LOOP_EXIT[2], 1.9, 2.2),
  [80, 1.9, LOOP_EXIT[2] - 0.2],
  [86, 2.2, -4.4],
  [91.5, 3, -10.5],
  [95, 4.2, -21],
  [95.5, 4.6, -29],
  [89, 5, -38],
  [78, 5, -45.5],
  // The back row, heading -x, over two long airtime hills.
  [66, 4.6, -47],
  ...hillPoints(56, 8, -47, 4, 8),
  [8, 4, -47],
  ...hillPoints(-6, -50, -47, 3.6, 6),
  [-50, 3.6, -47],
  [-66, 2.8, -46],
  // Banked turnaround on the left, back towards the station.
  [-82, 2.4, -42],
  [-94, 2.1, -32],
  [-102, 1.8, -19],
  [-106, 1.6, -8],
  [-103, 1.6, 2.5],
  [-99, 1.6, 6.6],
];

/** The top of the lift: the chain lets go there. */
const CREST_POINT = 6;
/** The loop runs between these control points; elsewhere the track stays level unless banked. */
const LOOP_START = 14;
const LOOP_END = LOOP_START + LOOP.length + 1;

export interface Track {
  /** Total length, metres. */
  readonly length: number;
  /** Number of samples, evenly spaced, the first at the station. */
  readonly count: number;
  /** Spacing between samples, metres (`length / count`). */
  readonly step: number;
  /** Per sample, xyz: position, unit tangent, unit normal (out of the top), unit binormal (right). */
  readonly pos: Float64Array;
  readonly tan: Float64Array;
  readonly nrm: Float64Array;
  readonly bin: Float64Array;
  /** Per sample, the train's physical speed, m/s. */
  readonly speed: Float64Array;
  /** Arc length where the chain lets go at the top of the lift. */
  readonly crest: number;
}

/** One centripetal Catmull–Rom segment from `p1` to `p2`, at `u` in [0, 1]. */
function catmullRom(p0: Point, p1: Point, p2: Point, p3: Point, u: number, out: number[]) {
  const knot = (a: Point, b: Point) =>
    Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])) || 1e-6;
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  for (let k = 0; k < 3; k++) {
    const a1 = ((t1 - t) / t1) * p0[k] + (t / t1) * p1[k];
    const a2 = ((t2 - t) / (t2 - t1)) * p1[k] + ((t - t1) / (t2 - t1)) * p2[k];
    const a3 = ((t3 - t) / (t3 - t2)) * p2[k] + ((t - t2) / (t3 - t2)) * p3[k];
    const b1 = ((t2 - t) / t2) * a1 + (t / t2) * a2;
    const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
    out[k] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
  }
}

/** Rotates the vector at `o` in `v` about the unit axis at `o` in `axis` by `angle`. */
function rotateAbout(v: Float64Array, axis: Float64Array, o: number, angle: number) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const ax = axis[o];
  const ay = axis[o + 1];
  const az = axis[o + 2];
  const vx = v[o];
  const vy = v[o + 1];
  const vz = v[o + 2];
  const d = ax * vx + ay * vy + az * vz;
  const cx = ay * vz - az * vy;
  const cy = az * vx - ax * vz;
  const cz = ax * vy - ay * vx;
  v[o] = vx * c + cx * s + ax * d * (1 - c);
  v[o + 1] = vy * c + cy * s + ay * d * (1 - c);
  v[o + 2] = vz * c + cz * s + az * d * (1 - c);
}

/** A periodic box filter of half-width `radius` samples, applied `passes` times, in place. */
function smoothPeriodic(values: Float64Array, radius: number, passes: number) {
  const n = values.length;
  const tmp = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += values[(k + n) % n];
    }
    for (let i = 0; i < n; i++) {
      tmp[i] = sum / (2 * radius + 1);
      sum += values[(i + radius + 1) % n] - values[(i - radius + n) % n];
    }
    values.set(tmp);
  }
}

/** The physical speed at every sample (see `Track.speed`). */
function speedProfile(pos: Float64Array, count: number, step: number, crestIndex: number) {
  const speed = new Float64Array(count);
  const top = pos[crestIndex * 3 + 1];
  const length = count * step;
  for (let i = 0; i < count; i++) {
    const s = i * step;
    let v: number;
    if (i <= crestIndex) {
      v = CHAIN_SPEED;
    } else {
      const v2 =
        CHAIN_SPEED * CHAIN_SPEED +
        2 * GRAVITY * (top - pos[i * 3 + 1]) -
        2 * FRICTION * GRAVITY * (s - crestIndex * step);
      v = Math.sqrt(Math.max(MIN_SPEED * MIN_SPEED, v2));
      v = Math.min(v, Math.sqrt(STATION_SPEED * STATION_SPEED + 2 * BRAKE * (length - s)));
    }
    speed[i] = Math.max(MIN_SPEED, v);
  }
  return speed;
}

/**
 * The squared speed the train would have at each sample after the crest with
 * no floor and no brakes: energy left over from the drop, less friction. Every
 * value well above zero means the train clears every hill and the loop.
 */
export function freeSpeedSquared(track: Track): Float64Array {
  const out = new Float64Array(track.count);
  const ci = Math.round(track.crest / track.step);
  const top = track.pos[ci * 3 + 1];
  for (let i = 0; i < track.count; i++) {
    out[i] =
      i <= ci
        ? CHAIN_SPEED * CHAIN_SPEED
        : CHAIN_SPEED * CHAIN_SPEED +
          2 * GRAVITY * (top - track.pos[i * 3 + 1]) -
          2 * FRICTION * GRAVITY * (i - ci) * track.step;
  }
  return out;
}

/** Builds the circuit. Deterministic: the same track every time. */
export function buildTrack(): Track {
  const m = POINTS.length;
  // 1. Dense polyline along the spline, with the arc length at each control point.
  const dense: number[] = [];
  const at: number[] = [0, 0, 0];
  let crestDense = 0;
  let loopStartDense = 0;
  let loopEndDense = 0;
  for (let j = 0; j < m; j++) {
    if (j === CREST_POINT) {
      crestDense = dense.length / 3;
    } else if (j === LOOP_START) {
      loopStartDense = dense.length / 3;
    } else if (j === LOOP_END) {
      loopEndDense = dense.length / 3;
    }
    const p0 = POINTS[(j - 1 + m) % m];
    const p1 = POINTS[j];
    const p2 = POINTS[(j + 1) % m];
    const p3 = POINTS[(j + 2) % m];
    for (let k = 0; k < SUBDIVISIONS; k++) {
      catmullRom(p0, p1, p2, p3, k / SUBDIVISIONS, at);
      dense.push(at[0], at[1], at[2]);
    }
  }
  const nd = dense.length / 3;
  const cum = new Float64Array(nd + 1);
  for (let i = 0; i < nd; i++) {
    const o = i * 3;
    const q = ((i + 1) % nd) * 3;
    cum[i + 1] =
      cum[i] +
      Math.hypot(dense[q] - dense[o], dense[q + 1] - dense[o + 1], dense[q + 2] - dense[o + 2]);
  }
  const length = cum[nd];
  const count = Math.round(length / TARGET_STEP);
  const step = length / count;

  // 2. Even resampling.
  const pos = new Float64Array(count * 3);
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const s = i * step;
    while (cum[seg + 1] < s) {
      seg++;
    }
    const f = (s - cum[seg]) / (cum[seg + 1] - cum[seg]);
    const o = seg * 3;
    const q = ((seg + 1) % nd) * 3;
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = dense[o + k] + (dense[q + k] - dense[o + k]) * f;
    }
  }
  const crest = cum[crestDense];
  const loopStart = cum[loopStartDense];
  const loopEnd = cum[loopEndDense];
  const crestIndex = Math.round(crest / step);

  // 3. Tangents by central differences.
  const tan = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = ((i - 1 + count) % count) * 3;
    const b = ((i + 1) % count) * 3;
    const x = pos[b] - pos[a];
    const y = pos[b + 1] - pos[a + 1];
    const z = pos[b + 2] - pos[a + 2];
    const l = Math.hypot(x, y, z);
    tan[i * 3] = x / l;
    tan[i * 3 + 1] = y / l;
    tan[i * 3 + 2] = z / l;
  }

  // 4. Normals: level (the up vector square to the tangent) everywhere but the
  // loop, where the track turns over; through the loop, rotation-minimising
  // (double reflection) from its entry, with the slight twist the drift adds
  // spread over the loop so it leaves level again.
  const nrm = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const ty = tan[o + 1];
    const nx = -ty * tan[o];
    const ny = 1 - ty * ty;
    const nz = -ty * tan[o + 2];
    const l = Math.hypot(nx, ny, nz);
    nrm[o] = nx / l;
    nrm[o + 1] = ny / l;
    nrm[o + 2] = nz / l;
  }
  const loopFirst = Math.round(loopStart / step);
  const loopLast = Math.round(loopEnd / step);
  /** The transported normal at the loop's exit. */
  const transported = new Float64Array(3);
  for (let i = loopFirst; i < loopLast; i++) {
    const o = i * 3;
    const q = o + 3;
    const v1x = pos[q] - pos[o];
    const v1y = pos[q + 1] - pos[o + 1];
    const v1z = pos[q + 2] - pos[o + 2];
    const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
    const dr = (2 / c1) * (v1x * nrm[o] + v1y * nrm[o + 1] + v1z * nrm[o + 2]);
    const rLx = nrm[o] - dr * v1x;
    const rLy = nrm[o + 1] - dr * v1y;
    const rLz = nrm[o + 2] - dr * v1z;
    const dt = (2 / c1) * (v1x * tan[o] + v1y * tan[o + 1] + v1z * tan[o + 2]);
    const v2x = tan[q] - (tan[o] - dt * v1x);
    const v2y = tan[q + 1] - (tan[o + 1] - dt * v1y);
    const v2z = tan[q + 2] - (tan[o + 2] - dt * v1z);
    const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
    const d2 = c2 > 1e-18 ? (2 / c2) * (v2x * rLx + v2y * rLy + v2z * rLz) : 0;
    const target = i + 1 < loopLast ? nrm : transported;
    const t = i + 1 < loopLast ? q : 0;
    target[t] = rLx - d2 * v2x;
    target[t + 1] = rLy - d2 * v2y;
    target[t + 2] = rLz - d2 * v2z;
  }
  {
    const e = loopLast * 3;
    const cx = transported[1] * nrm[e + 2] - transported[2] * nrm[e + 1];
    const cy = transported[2] * nrm[e] - transported[0] * nrm[e + 2];
    const cz = transported[0] * nrm[e + 1] - transported[1] * nrm[e];
    const sin = cx * tan[e] + cy * tan[e + 1] + cz * tan[e + 2];
    const cos = transported[0] * nrm[e] + transported[1] * nrm[e + 1] + transported[2] * nrm[e + 2];
    const twist = Math.atan2(sin, cos);
    const span = loopLast - loopFirst;
    for (let i = loopFirst + 1; i < loopLast; i++) {
      rotateAbout(nrm, tan, i * 3, (twist * (i - loopFirst)) / span);
    }
  }

  // 5. Bank into the turns: the angle whose tangent is lateral over vertical acceleration.
  const speed = speedProfile(pos, count, step, crestIndex);
  const bank = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const a = ((i - 1 + count) % count) * 3;
    const b = ((i + 1) % count) * 3;
    const dx = (tan[b] - tan[a]) / (2 * step);
    const dz = (tan[b + 2] - tan[a + 2]) / (2 * step);
    // Turning towards -z (left, going +x) gives a positive value.
    const turn = tan[o + 2] * dx - tan[o] * dz;
    const v = speed[i];
    bank[i] = -Math.max(-MAX_BANK, Math.min(MAX_BANK, Math.atan((v * v * turn) / GRAVITY)));
  }
  smoothPeriodic(bank, Math.round(5 / step), 3);
  for (let i = 0; i < count; i++) {
    rotateAbout(nrm, tan, i * 3, bank[i]);
  }

  // 6. Re-orthonormalise, and the binormal t × n (the rider's right).
  const bin = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const d = nrm[o] * tan[o] + nrm[o + 1] * tan[o + 1] + nrm[o + 2] * tan[o + 2];
    let nx = nrm[o] - d * tan[o];
    let ny = nrm[o + 1] - d * tan[o + 1];
    let nz = nrm[o + 2] - d * tan[o + 2];
    const l = Math.hypot(nx, ny, nz);
    nx /= l;
    ny /= l;
    nz /= l;
    nrm[o] = nx;
    nrm[o + 1] = ny;
    nrm[o + 2] = nz;
    bin[o] = tan[o + 1] * nz - tan[o + 2] * ny;
    bin[o + 1] = tan[o + 2] * nx - tan[o] * nz;
    bin[o + 2] = tan[o] * ny - tan[o + 1] * nx;
  }

  return { length, count, step, pos, tan, nrm, bin, speed, crest };
}

/** Index of the sample at or before `s`, and the fraction on to the next, wrapping round. */
function locate(track: Track, s: number): [number, number, number] {
  const u = (((s / track.step) % track.count) + track.count) % track.count;
  const i = Math.min(track.count - 1, Math.floor(u));
  return [i, (i + 1) % track.count, u - i];
}

/**
 * The frame at arc length `s` (wrapping round): position, tangent, normal and
 * binormal, as 12 numbers into `out` from `o`. Interpolated between samples,
 * then re-orthonormalised.
 */
export function frameAt(track: Track, s: number, out: Float32Array | Float64Array, o = 0): void {
  const [i, j, f] = locate(track, s);
  const a = i * 3;
  const b = j * 3;
  const { pos, tan, nrm } = track;
  let tx = tan[a] + (tan[b] - tan[a]) * f;
  let ty = tan[a + 1] + (tan[b + 1] - tan[a + 1]) * f;
  let tz = tan[a + 2] + (tan[b + 2] - tan[a + 2]) * f;
  const tl = Math.hypot(tx, ty, tz);
  tx /= tl;
  ty /= tl;
  tz /= tl;
  let nx = nrm[a] + (nrm[b] - nrm[a]) * f;
  let ny = nrm[a + 1] + (nrm[b + 1] - nrm[a + 1]) * f;
  let nz = nrm[a + 2] + (nrm[b + 2] - nrm[a + 2]) * f;
  const d = nx * tx + ny * ty + nz * tz;
  nx -= d * tx;
  ny -= d * ty;
  nz -= d * tz;
  const nl = Math.hypot(nx, ny, nz);
  nx /= nl;
  ny /= nl;
  nz /= nl;
  out[o] = pos[a] + (pos[b] - pos[a]) * f;
  out[o + 1] = pos[a + 1] + (pos[b + 1] - pos[a + 1]) * f;
  out[o + 2] = pos[a + 2] + (pos[b + 2] - pos[a + 2]) * f;
  out[o + 3] = tx;
  out[o + 4] = ty;
  out[o + 5] = tz;
  out[o + 6] = nx;
  out[o + 7] = ny;
  out[o + 8] = nz;
  out[o + 9] = ty * nz - tz * ny;
  out[o + 10] = tz * nx - tx * nz;
  out[o + 11] = tx * ny - ty * nx;
}

/** The track's bounding box: min xyz then max xyz. */
export function trackBounds(track: Track): [number, number, number, number, number, number] {
  const b: [number, number, number, number, number, number] = [
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity,
  ];
  for (let i = 0; i < track.count; i++) {
    for (let k = 0; k < 3; k++) {
      const v = track.pos[i * 3 + k];
      b[k] = Math.min(b[k], v);
      b[k + 3] = Math.max(b[k + 3], v);
    }
  }
  return b;
}
