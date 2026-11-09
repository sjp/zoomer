/**
 * Pendulum wave model. Pendulum `i` makes `N + i` whole swings per cycle of `T`
 * seconds, so its angle is `A cos(2π (N + i) t / T)`: exact and periodic, with no
 * integration, and every pendulum is back in line at each multiple of `T`. Lengths
 * follow from the frequencies (`L ∝ 1 / f²`). The rig is placed in 3D, seen
 * through a simple perspective camera, and fitted into its part of the frame.
 */
import { clamp, fract } from "../math";
import { MAX_AMPLITUDE, MAX_PENDULUMS, MIN_PENDULUMS } from "./pendulum.meta";

export type PendulumView = "front" | "angled" | "above";
export type PendulumFinish = "chrome" | "brass" | "coloured";
export type PendulumPlacement = "top" | "left" | "right";

export const REF_HEIGHT = 1080;
const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;

/** Target period of the slowest (longest) pendulum, seconds. */
export const BASE_PERIOD = 2.4;
/** Ball radius the rig is designed around (reference px), before fitting. */
export const BALL_RADIUS = 24;
/** Pivot spacing in ball radii, at most: the balls nearly touch, as in the classic rig. */
export const SPACING_RADII = 2.8;
/** Most the fit may enlarge the rig. */
export const MAX_FIT = 1.25;
/** How fast the swing and the lengths ease after a param change (1/s). */
const EASE_RATE = 2.5;
/** Brightness gain per unit of relative perspective scale (closer is brighter). */
const DEPTH_GAIN = 5;
/** Angles sampled across the swing when fitting the rig. */
const FIT_SAMPLES = 9;

/** Floats per ball: centre x, y, radius (device px, y down), brightness; tint rgb, metal. */
export const BALL_FLOATS = 8;
/** Floats per shadow: segment end a x, y, end b x, y (device px); radius, blur, alpha, 0. */
export const SHADOW_FLOATS = 8;
/** Floats per line, as `createStreakRenderer` lays them out. */
export const LINE_FLOATS = 8;
/** Lines in the bar: a dark body and a highlight along its top. */
export const BAR_LINES = 2;

const STRING_COLOR = [0.6, 0.61, 0.64] as const;
/** Half width of a string, device px at 1080p. */
const STRING_HALF_WIDTH = 0.42;
const BAR_BODY = [0.12, 0.125, 0.14] as const;
const BAR_HIGHLIGHT = [0.5, 0.52, 0.56] as const;
const SHADOW_ALPHA = 0.38;
const BAR_SHADOW_ALPHA = 0.3;

export const CHROME_TINT = [0.9, 0.92, 0.95] as const;
export const BRASS_TINT = [1.0, 0.74, 0.4] as const;

/** Camera yaw (about the vertical) and pitch (looking down), radians. */
export const VIEWS: Record<PendulumView, { yaw: number; pitch: number }> = {
  front: { yaw: 0, pitch: 10 * DEG },
  angled: { yaw: 28 * DEG, pitch: 9 * DEG },
  above: { yaw: 0, pitch: 68 * DEG },
};

const resolveView = (v: string): PendulumView => (v === "front" || v === "above" ? v : "angled");
const resolvePlacement = (p: string): PendulumPlacement =>
  p === "left" || p === "right" ? p : "top";
const resolveFinish = (f: string): PendulumFinish =>
  f === "brass" || f === "coloured" ? f : "chrome";

/** Whole swings the slowest pendulum makes per cycle: about one per `BASE_PERIOD`, at least `count`. */
export function baseOscillations(cycle: number, count: number): number {
  return Math.max(Math.round(cycle / BASE_PERIOD), Math.round(count), 1);
}

/**
 * Angle of pendulum `i`, with `phase` = 2π N t / T and `u` = t / T (both may be
 * wrapped): A cos(2π (N + i) t / T), since i is whole.
 */
export function swingAngle(i: number, phase: number, u: number, amplitude: number): number {
  return amplitude * Math.cos(phase + TAU * i * u);
}

/** Length of pendulum `i` relative to the longest: (N / (N + i))², from L ∝ 1 / f². */
export function lengthRatio(i: number, n: number): number {
  const r = n / (n + i);
  return r * r;
}

/** The cycle clock: `phase` = 2π N t / T wrapped to [0, 2π), `u` = t / T wrapped to [0, 1). */
export interface PendulumClock {
  phase: number;
  u: number;
}

/**
 * Advances the clock by `dt` seconds. Changing `cycle` or `n` changes only the
 * rate, so every angle stays continuous, and the swings still line up whenever
 * `u` wraps: the part that differs between pendulums is always 2π i u.
 */
export function advanceClock(c: PendulumClock, dt: number, cycle: number, n: number): void {
  const du = Math.max(0, dt) / Math.max(cycle, 1e-6);
  c.u = fract(c.u + du);
  c.phase = (c.phase + TAU * n * du) % TAU;
}

/** HSV (all 0..1) to RGB, written into `out` at `o`. */
export function hsvToRgb(h: number, s: number, v: number, out: Float32Array, o: number): void {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  out[o] = f(5);
  out[o + 1] = f(3);
  out[o + 2] = f(1);
}

export interface RigConfig {
  count: number;
  view: string;
  placement: string;
  /** Frame width in reference px (1080 tall). */
  refWidth: number;
}

/** The region the rig is fitted into, reference px. */
export function placementBox(
  placement: PendulumPlacement,
  refWidth: number,
): { x0: number; x1: number; y0: number; y1: number } {
  const w = refWidth;
  const h = REF_HEIGHT;
  if (placement === "left") {
    return { x0: 0.04 * w, x1: w / 3 - 0.03 * w, y0: 0.08 * h, y1: 0.82 * h };
  }
  if (placement === "right") {
    return { x0: (2 * w) / 3 + 0.03 * w, x1: 0.96 * w, y0: 0.08 * h, y1: 0.82 * h };
  }
  return { x0: 0.06 * w, x1: 0.94 * w, y0: 0.06 * h, y1: 0.48 * h };
}

export type PendulumRig = ReturnType<typeof createPendulumRig>;

/**
 * The rig: geometry (`configure`), motion (`update`) and per-frame instance data
 * (`fill`). Allocates nothing after creation.
 */
export function createPendulumRig() {
  const pivotX = new Float64Array(MAX_PENDULUMS);
  const length = new Float64Array(MAX_PENDULUMS);
  const angle = new Float64Array(MAX_PENDULUMS);
  // Per-ball projected values, before sorting.
  const ballX = new Float64Array(MAX_PENDULUMS);
  const ballY = new Float64Array(MAX_PENDULUMS);
  const ballR = new Float64Array(MAX_PENDULUMS);
  const ballLight = new Float64Array(MAX_PENDULUMS);
  const ballDepth = new Float64Array(MAX_PENDULUMS);
  const order = new Int32Array(MAX_PENDULUMS);
  const tints = new Float32Array(MAX_PENDULUMS * 3);
  /** Projection scratch: screen x, y (reference units, y down, about the bar centre), scale, depth. */
  const pr = { x: 0, y: 0, s: 1, d: 0 };

  const clock: PendulumClock = { phase: 0, u: 0 };
  const cam = { cy: 1, sy: 0, cp: 1, sp: 0, dist: 1000 };
  /** Light travel direction (world: x right, y down, z toward the viewer). */
  const light = { x: 0, y: 0, z: 0 };
  /** Backdrop plane: points where dot(p, normal) = offset; normal is an axis. */
  let floorView = false;
  let planeOffset = 0;

  const state = {
    count: 0,
    view: "angled" as PendulumView,
    placement: "top" as PendulumPlacement,
    /** Bar length, longest string, ball and bar radius (world units ≈ reference px). */
    barLength: 0,
    longest: 0,
    radius: 0,
    barRadius: 0,
    /** Whole swings of the slowest pendulum per cycle, and its eased value for the lengths. */
    n: 0,
    nShown: Number.NaN,
    /** Eased amplitude, radians. */
    amplitude: Number.NaN,
    /** Fit: reference px = offset + k * projected. */
    k: 1,
    ox: 0,
    oy: 0,
    /** Soft backdrop spot behind the rig, reference px: centre and radii. */
    spot: { x: 0, y: 0, rx: 1, ry: 1 },
    /** Key light direction in view space (x right, y up, z toward the viewer), unit. */
    key: [0, 0, 1] as [number, number, number],
    ballCount: 0,
    stringCount: 0,
    barCount: 0,
    shadowCount: 0,
  };
  let fittedN = Number.NaN;
  let configured = false;
  let builtFinish = "";

  const project = (x: number, y: number, z: number) => {
    const x1 = x * cam.cy + z * cam.sy;
    const z1 = -x * cam.sy + z * cam.cy;
    const y2 = y * cam.cp + z1 * cam.sp;
    const d = z1 * cam.cp - y * cam.sp;
    const s = cam.dist / (cam.dist - d);
    pr.x = x1 * s;
    pr.y = y2 * s;
    pr.s = s;
    pr.d = d;
  };

  /** Where the light from point p meets the backdrop; written to sx, sy, sz, st (distance). */
  const sh = { x: 0, y: 0, z: 0, t: 0 };
  const shadowPoint = (x: number, y: number, z: number) => {
    const t = floorView ? (planeOffset - y) / light.y : (planeOffset - z) / light.z;
    sh.t = Math.max(0, t);
    sh.x = x + light.x * sh.t;
    sh.y = y + light.y * sh.t;
    sh.z = z + light.z * sh.t;
  };

  const box = { x0: 0, x1: 0, y0: 0, y1: 0 };

  /** Fits the swept rig (every swing angle up to the maximum) into the placement box. */
  const fit = () => {
    const n = state.count;
    const maxA = MAX_AMPLITUDE * DEG;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const grow = (r: number) => {
      minX = Math.min(minX, pr.x - r);
      maxX = Math.max(maxX, pr.x + r);
      minY = Math.min(minY, pr.y - r);
      maxY = Math.max(maxY, pr.y + r);
    };
    const half = state.barLength / 2;
    project(-half, 0, 0);
    grow(state.barRadius * pr.s);
    project(half, 0, 0);
    grow(state.barRadius * pr.s);
    for (let i = 0; i < n; i++) {
      const len = state.longest * lengthRatio(i, state.nShown);
      for (let j = 0; j < FIT_SAMPLES; j++) {
        const a = maxA * ((2 * j) / (FIT_SAMPLES - 1) - 1);
        project(pivotX[i], len * Math.cos(a), len * Math.sin(a));
        grow(state.radius * pr.s);
      }
    }
    const bw = maxX - minX;
    const bh = maxY - minY;
    const boxW = box.x1 - box.x0;
    const boxH = box.y1 - box.y0;
    const k = Math.min(boxW / bw, boxH / bh, MAX_FIT);
    state.k = k;
    state.ox = box.x0 + (boxW - k * bw) / 2 - k * minX;
    state.oy = box.y0 - k * minY;
    const spot = state.spot;
    spot.x = state.ox + (k * (minX + maxX)) / 2;
    spot.y = state.oy + (k * (minY + maxY)) / 2;
    spot.rx = (k * bw) / 2 + 220;
    spot.ry = (k * bh) / 2 + 220;
    fittedN = state.nShown;
  };

  const buildTints = (finish: PendulumFinish) => {
    builtFinish = finish;
    const n = state.count;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      if (finish === "coloured") {
        hsvToRgb((0.85 * i) / Math.max(1, n - 1), 0.62, 0.9, tints, o);
      } else {
        const t = finish === "brass" ? BRASS_TINT : CHROME_TINT;
        tints[o] = t[0];
        tints[o + 1] = t[1];
        tints[o + 2] = t[2];
      }
    }
  };

  return {
    state,
    clock,
    /** Lengths and angles of the current frame (first `state.count`). */
    length,
    angle,

    /** Rebuilds the geometry. The motion carries on where it was. */
    configure(cfg: RigConfig): void {
      const n = clamp(Math.round(cfg.count), MIN_PENDULUMS, MAX_PENDULUMS);
      const view = resolveView(cfg.view);
      const placement = resolvePlacement(cfg.placement);
      state.count = n;
      state.view = view;
      state.placement = placement;
      Object.assign(box, placementBox(placement, cfg.refWidth));
      const boxW = box.x1 - box.x0;
      const boxH = box.y1 - box.y0;
      const spacing = Math.min(boxW / n, SPACING_RADII * BALL_RADIUS);
      state.radius = spacing / SPACING_RADII;
      state.barRadius = Math.max(0.42 * state.radius, 4);
      state.barLength = spacing * n;
      state.longest = 0.85 * boxH;
      for (let i = 0; i < n; i++) {
        pivotX[i] = spacing * (i + 0.5 - n / 2);
      }

      // The left rig is mirrored: its light comes from the frame's centre side, and
      // its yaw turns the backdrop the opposite way, so the shadows stay near the rig.
      const side = placement === "left" ? -1 : 1;
      const v = VIEWS[view];
      const yaw = v.yaw * side;
      cam.cy = Math.cos(yaw);
      cam.sy = Math.sin(yaw);
      cam.cp = Math.cos(v.pitch);
      cam.sp = Math.sin(v.pitch);
      cam.dist = 2.4 * Math.max(state.barLength, state.longest);

      // Light from the front, above and a little to one side.
      floorView = view === "above";
      let lx: number;
      let ly: number;
      let lz: number;
      if (floorView) {
        lx = 0.3 * side;
        ly = 1;
        lz = 0.3;
        planeOffset = 1.3 * state.longest + state.radius;
      } else {
        lx = 0.25 * side;
        ly = 0.55;
        lz = -1;
        planeOffset = -(
          state.longest * Math.sin(MAX_AMPLITUDE * DEG) +
          state.radius +
          0.1 * state.longest
        );
      }
      const ll = Math.hypot(lx, ly, lz);
      light.x = lx / ll;
      light.y = ly / ll;
      light.z = lz / ll;
      // The key light in view space: toward the light, through the camera rotation.
      const kx = -light.x;
      const ky = -light.y;
      const kz = -light.z;
      const x1 = kx * cam.cy + kz * cam.sy;
      const z1 = -kx * cam.sy + kz * cam.cy;
      const y2 = ky * cam.cp + z1 * cam.sp;
      const d = z1 * cam.cp - ky * cam.sp;
      const kl = Math.hypot(x1, y2, d);
      state.key[0] = x1 / kl;
      state.key[1] = -y2 / kl;
      state.key[2] = d / kl;

      configured = true;
      fittedN = Number.NaN;
      builtFinish = "";
    },

    /**
     * Advances the clock and eases the swing and lengths toward the params: the
     * pattern's `cycle` (s) and the swing `amplitude` (degrees).
     */
    update(dt: number, cycle: number, amplitude: number): void {
      const n = baseOscillations(cycle, state.count);
      state.n = n;
      const target = clamp(amplitude, 0, MAX_AMPLITUDE) * DEG;
      const e = 1 - Math.exp(-Math.max(0, dt) * EASE_RATE);
      if (Number.isNaN(state.nShown)) {
        state.nShown = n;
      } else {
        state.nShown += (n - state.nShown) * e;
      }
      if (Math.abs(state.nShown - n) < 1e-4) {
        state.nShown = n;
      }
      if (Number.isNaN(state.amplitude)) {
        state.amplitude = target;
      } else {
        state.amplitude += (target - state.amplitude) * e;
      }
      advanceClock(clock, dt, cycle, n);
      for (let i = 0; i < state.count; i++) {
        length[i] = state.longest * lengthRatio(i, state.nShown);
        angle[i] = swingAngle(i, clock.phase, clock.u, state.amplitude);
      }
    },

    /**
     * Writes the frame's instance data in device px (`scale` per reference px):
     * balls farthest first, one string per pendulum, the bar, and the soft
     * shadows (one per ball, then the bar's).
     */
    fill(
      scale: number,
      finish: string,
      balls: Float32Array,
      strings: Float32Array,
      bar: Float32Array,
      shadows: Float32Array,
    ): void {
      if (!configured) {
        throw new Error("Pendulum rig: configure before fill");
      }
      if (fittedN !== state.nShown) {
        fit();
      }
      const f = resolveFinish(finish);
      if (f !== builtFinish) {
        buildTints(f);
      }
      const n = state.count;
      const k = state.k * scale;
      const ox = state.ox * scale;
      const oy = state.oy * scale;
      const metal = f === "coloured" ? 0 : 1;

      for (let i = 0; i < n; i++) {
        const len = length[i];
        const a = angle[i];
        const px = pivotX[i];
        const by = len * Math.cos(a);
        const bz = len * Math.sin(a);

        project(px, 0, 0);
        const sx0 = ox + k * pr.x;
        const sy0 = oy + k * pr.y;
        // Brightness follows how much nearer the swing has brought the ball.
        project(px, len, 0);
        const restS = pr.s;
        project(px, by, bz);
        const cx = ox + k * pr.x;
        const cy = oy + k * pr.y;
        ballX[i] = cx;
        ballY[i] = cy;
        ballR[i] = state.radius * pr.s * k;
        ballLight[i] = clamp(1 + DEPTH_GAIN * (pr.s / restS - 1), 0.6, 1.4);
        ballDepth[i] = pr.d;
        order[i] = i;

        const so = i * LINE_FLOATS;
        strings[so] = sx0;
        strings[so + 1] = sy0;
        strings[so + 2] = cx;
        strings[so + 3] = cy;
        strings[so + 4] = STRING_COLOR[0];
        strings[so + 5] = STRING_COLOR[1];
        strings[so + 6] = STRING_COLOR[2];
        strings[so + 7] = STRING_HALF_WIDTH * scale;

        shadowPoint(px, by, bz);
        project(sh.x, sh.y, sh.z);
        const r = state.radius * pr.s * k;
        const ho = i * SHADOW_FLOATS;
        shadows[ho] = ox + k * pr.x;
        shadows[ho + 1] = oy + k * pr.y;
        shadows[ho + 2] = shadows[ho];
        shadows[ho + 3] = shadows[ho + 1];
        shadows[ho + 4] = r;
        shadows[ho + 5] = Math.max(0.5, (0.3 * state.radius + 0.07 * sh.t) * pr.s * k);
        shadows[ho + 6] = SHADOW_ALPHA / (1 + sh.t / (2 * state.longest));
        shadows[ho + 7] = 0;
      }

      // Painter's order: farthest ball first (insertion sort; at most 24).
      for (let i = 1; i < n; i++) {
        const v = order[i];
        const dv = ballDepth[v];
        let j = i - 1;
        while (j >= 0 && ballDepth[order[j]] > dv) {
          order[j + 1] = order[j];
          j--;
        }
        order[j + 1] = v;
      }
      for (let j = 0; j < n; j++) {
        const i = order[j];
        const o = j * BALL_FLOATS;
        balls[o] = ballX[i];
        balls[o + 1] = ballY[i];
        balls[o + 2] = ballR[i];
        balls[o + 3] = ballLight[i];
        balls[o + 4] = tints[i * 3];
        balls[o + 5] = tints[i * 3 + 1];
        balls[o + 6] = tints[i * 3 + 2];
        balls[o + 7] = metal;
      }

      // The bar: a dark body with a highlight along its upper edge.
      const half = state.barLength / 2;
      project(-half, 0, 0);
      const ax = ox + k * pr.x;
      const ay = oy + k * pr.y;
      const as = pr.s;
      project(half, 0, 0);
      const bx = ox + k * pr.x;
      const byy = oy + k * pr.y;
      const hw = state.barRadius * k * 0.5 * (as + pr.s);
      writeLine(bar, 0, ax, ay, bx, byy, BAR_BODY, hw);
      const lift = 0.38 * hw;
      writeLine(bar, 1, ax, ay - lift, bx, byy - lift, BAR_HIGHLIGHT, 0.28 * hw);

      // The bar's shadow: a soft capsule between its ends' shadows.
      shadowPoint(-half, 0, 0);
      project(sh.x, sh.y, sh.z);
      const ho = n * SHADOW_FLOATS;
      shadows[ho] = ox + k * pr.x;
      shadows[ho + 1] = oy + k * pr.y;
      const barT = sh.t;
      shadowPoint(half, 0, 0);
      project(sh.x, sh.y, sh.z);
      shadows[ho + 2] = ox + k * pr.x;
      shadows[ho + 3] = oy + k * pr.y;
      shadows[ho + 4] = hw;
      shadows[ho + 5] = Math.max(0.5, (0.3 * state.radius + 0.07 * 0.5 * (barT + sh.t)) * k);
      shadows[ho + 6] = BAR_SHADOW_ALPHA / (1 + barT / (2 * state.longest));
      shadows[ho + 7] = 0;

      state.ballCount = n;
      state.stringCount = n;
      state.barCount = BAR_LINES;
      state.shadowCount = n + 1;
    },
  };
}

function writeLine(
  out: Float32Array,
  index: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  color: readonly [number, number, number],
  halfWidth: number,
): void {
  const o = index * LINE_FLOATS;
  out[o] = ax;
  out[o + 1] = ay;
  out[o + 2] = bx;
  out[o + 3] = by;
  out[o + 4] = color[0];
  out[o + 5] = color[1];
  out[o + 6] = color[2];
  out[o + 7] = halfWidth;
}
