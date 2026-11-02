/**
 * CPU simulation for the rain-on-a-window effect: pure, allocation-free per step,
 * with no GL dependency so it can be unit tested.
 *
 * Coordinates are reference units (a 1080-unit-tall frame), y down.
 *
 * - **Static droplets** live in a fixed pool (slots `[0, maxStatic)`). Each has a
 *   lifetime: it fades in, sits, fades out and respawns somewhere else. Only the
 *   first `staticCount` slots are active, set from the `rain` amount. When the
 *   rain drops, the slots beyond it fade out (`staticFade`) before they die.
 * - **Trail droplets** live in a ring of `maxTrails` slots after the static ones.
 *   Runners emit them behind themselves; they fade out over a few seconds. When
 *   the slot under the ring cursor is still alive the ring is full and the
 *   emission is skipped, so a visible droplet never pops.
 * - **Runners** are larger drops. A resting runner slowly grows (condensation)
 *   until it breaks loose, then slides down in a wiggly, stop-go path, wiping
 *   droplets it passes (gaining their volume), absorbing resting runners and
 *   losing volume to its trail. Small runners stop; runners leaving the bottom
 *   respawn as small resting drops.
 *
 * Wiping uses a coarse uniform grid of singly linked lists (`head`/`next`),
 * rebuilt each step in O(droplets), so each runner only tests nearby droplets.
 */

import { FADE_OUT, growLive, stepLife, trimLive } from "./fade";

export const DEAD = 0;
export const STATIC = 1;
export const TRAIL = 2;

export const RESTING = 0;
export const RUNNING = 1;

export interface RainSimConfig {
  maxStatic: number;
  maxTrails: number;
  maxRunners: number;
  /** Grid cell size in reference units. Should exceed the largest droplet radius. */
  cellSize: number;
}

export const DEFAULT_CONFIG: Readonly<RainSimConfig> = {
  maxStatic: 3000,
  maxTrails: 1500,
  maxRunners: 48,
  cellSize: 16,
};

export interface RainSimParams {
  /** Amount of drops, 0..1. */
  rain: number;
  /** Runner speed multiplier; 0 freezes runners in place. */
  speed: number;
}

/** Floats per drop instance written by `writeDropInstances`: x, y, radius, stretch, fade. */
export const INSTANCE_STRIDE = 5;

/** Static droplet radius range (reference px); small sizes are much more common. */
export const STATIC_MIN_R = 1.3;
export const STATIC_MAX_R = 5.5;
/** Static droplet lifetime range in seconds. */
const STATIC_LIFE_MIN = 6;
const STATIC_LIFE_SPREAD = 14;
/** Trail droplet lifetime range in seconds. */
const TRAIL_LIFE_MIN = 2;
const TRAIL_LIFE_SPREAD = 3;
/** Fresh trail droplets are not wiped, so a runner never eats its own trail. */
export const TRAIL_GRACE = 0.6;
/** Resting runner growth, reference px per second (randomised per step). */
const GROW_RATE = 0.8;
/** Break-loose radius range. */
const BREAK_MIN = 11;
const BREAK_SPREAD = 7;
/** Spawned runner radius range. */
const SPAWN_MIN_R = 4;
const SPAWN_SPREAD_R = 6;
export const MAX_RUNNER_R = 24;
/** A running drop smaller than this sticks to the glass again. */
export const STOP_R = 7;
/** Fall speed in reference px/s for a drop of radius `BREAK_MIN` at speed 1. */
const BASE_SPEED = 90;
/** Horizontal wiggle as a fraction of the fall speed. */
const WIGGLE = 0.3;
/** Fraction of a wiped droplet's volume the runner gains. */
const ABSORB = 0.5;
/** Fraction of a trail droplet's volume the runner loses. */
const TRAIL_LOSS = 0.3;
/** Wipe radius relative to the runner radius. */
const WIPE = 0.9;
/** Runners fade in over this many seconds. */
const RUNNER_FADE_IN = 1;
/** Longest step simulated, so a stalled tab does not teleport runners. */
export const MAX_DT = 0.1;
const TAU = Math.PI * 2;

export interface RainSim {
  readonly config: Readonly<RainSimConfig>;
  readonly rng: () => number;
  width: number;
  height: number;

  /** Droplets: static slots first, then the trail ring. */
  readonly dx: Float32Array;
  readonly dy: Float32Array;
  readonly dr: Float32Array;
  readonly dAge: Float32Array;
  readonly dLife: Float32Array;
  readonly dKind: Uint8Array;
  /**
   * Count fade of each static slot (see `fade.ts`): slots removed by less rain
   * fade out before they die. 1 while wanted, so it is invisible otherwise.
   */
  readonly staticFade: Float32Array;
  /** Active static slots, `[0, staticCount)`, including any still fading out. */
  staticCount: number;
  /** Next trail slot, `0 .. maxTrails - 1` (offset by `maxStatic` in the arrays). */
  trailCursor: number;

  readonly rx: Float32Array;
  readonly ry: Float32Array;
  readonly rr: Float32Array;
  /** Fall speed, reference px/s. */
  readonly rv: Float32Array;
  readonly rPhase: Float32Array;
  /** Stop-go factor the fall speed relaxes towards. */
  readonly rJerk: Float32Array;
  readonly rBreak: Float32Array;
  /** Distance fallen since the last trail droplet, minus the next spacing. */
  readonly rTravel: Float32Array;
  readonly rAge: Float32Array;
  readonly rState: Uint8Array;
  /** Count fade of each runner slot, like `staticFade`. */
  readonly runnerFade: Float32Array;
  /** How far each runner moved in the last step (0 if it didn't, or respawned). */
  readonly rStepX: Float32Array;
  readonly rStepY: Float32Array;
  /** Active runner slots, `[0, runnerCount)`, including any still fading out. */
  runnerCount: number;

  /** Grid: `cols * rows` list heads (-1 = empty) and per-droplet next links. */
  cols: number;
  rows: number;
  head: Int32Array;
  readonly next: Int32Array;

  /** Whether the first drops have been placed (that first fill gets random ages). */
  primed: boolean;
  /** Instance index of the first runner after `writeDropInstances`. */
  runnerFirst: number;
  /** Runners written by `writeDropInstances`. */
  runnersWritten: number;
  /** Droplets wiped so far (diagnostics and tests). */
  wiped: number;
  /** Trail emissions skipped because the ring was full. */
  trailsSkipped: number;
}

/** Instances `writeDropInstances` can write at most. */
export function instanceCapacity(c: Readonly<RainSimConfig>): number {
  return c.maxStatic + c.maxTrails + c.maxRunners;
}

export function createRainSim(
  width: number,
  height: number,
  rng: () => number,
  config: Readonly<RainSimConfig> = DEFAULT_CONFIG,
): RainSim {
  const nd = config.maxStatic + config.maxTrails;
  const nr = config.maxRunners;
  const sim: RainSim = {
    config,
    rng,
    width: 1,
    height: 1,
    dx: new Float32Array(nd),
    dy: new Float32Array(nd),
    dr: new Float32Array(nd),
    dAge: new Float32Array(nd),
    dLife: new Float32Array(nd),
    dKind: new Uint8Array(nd),
    staticFade: new Float32Array(config.maxStatic).fill(1),
    staticCount: 0,
    trailCursor: 0,
    rx: new Float32Array(nr),
    ry: new Float32Array(nr),
    rr: new Float32Array(nr),
    rv: new Float32Array(nr),
    rPhase: new Float32Array(nr),
    rJerk: new Float32Array(nr),
    rBreak: new Float32Array(nr),
    rTravel: new Float32Array(nr),
    rAge: new Float32Array(nr),
    rState: new Uint8Array(nr),
    runnerFade: new Float32Array(nr).fill(1),
    rStepX: new Float32Array(nr),
    rStepY: new Float32Array(nr),
    runnerCount: 0,
    cols: 0,
    rows: 0,
    head: new Int32Array(0),
    next: new Int32Array(nd),
    primed: false,
    runnerFirst: 0,
    runnersWritten: 0,
    wiped: 0,
    trailsSkipped: 0,
  };
  resizeRainSim(sim, width, height);
  return sim;
}

/**
 * Sets the window size in reference units. x positions scale with the width so
 * the drop layout is kept; the grid is reallocated only when its shape changes.
 */
export function resizeRainSim(sim: RainSim, width: number, height: number) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const kx = w / sim.width;
  const ky = h / sim.height;
  if (kx !== 1 || ky !== 1) {
    for (let i = 0; i < sim.dx.length; i++) {
      sim.dx[i] *= kx;
      sim.dy[i] *= ky;
    }
    for (let i = 0; i < sim.rx.length; i++) {
      sim.rx[i] *= kx;
      sim.ry[i] *= ky;
    }
    // The last step was in the old coordinates.
    sim.rStepX.fill(0);
    sim.rStepY.fill(0);
  }
  sim.width = w;
  sim.height = h;
  const cols = Math.max(1, Math.ceil(w / sim.config.cellSize));
  const rows = Math.max(1, Math.ceil(h / sim.config.cellSize));
  if (cols !== sim.cols || rows !== sim.rows) {
    sim.cols = cols;
    sim.rows = rows;
    sim.head = new Int32Array(cols * rows).fill(-1);
  }
}

/** Respawns static slot `i` at a random place, fading in (or mid-life if `randomAge`). */
export function spawnStatic(sim: RainSim, i: number, randomAge: boolean) {
  const { rng } = sim;
  const t = rng();
  sim.dx[i] = rng() * sim.width;
  sim.dy[i] = rng() * sim.height;
  sim.dr[i] = STATIC_MIN_R + t * t * t * (STATIC_MAX_R - STATIC_MIN_R);
  const life = STATIC_LIFE_MIN + rng() * STATIC_LIFE_SPREAD;
  sim.dLife[i] = life;
  sim.dAge[i] = randomAge ? rng() * life : 0;
  sim.dKind[i] = STATIC;
}

/** Respawns runner `i` as a small resting drop somewhere in the upper 85%. */
export function spawnRunner(sim: RainSim, i: number) {
  const { rng } = sim;
  sim.rx[i] = rng() * sim.width;
  sim.ry[i] = rng() * sim.height * 0.85;
  sim.rr[i] = SPAWN_MIN_R + rng() * SPAWN_SPREAD_R;
  sim.rBreak[i] = BREAK_MIN + rng() * BREAK_SPREAD;
  sim.rv[i] = 0;
  sim.rPhase[i] = rng() * TAU;
  sim.rJerk[i] = 1;
  sim.rTravel[i] = -trailSpacing(rng);
  sim.rAge[i] = 0;
  sim.rState[i] = RESTING;
  sim.rStepX[i] = 0;
  sim.rStepY[i] = 0;
}

const trailSpacing = (rng: () => number) => 5 + rng() * 10;

/**
 * Emits a trail droplet into the ring. Returns false (and emits nothing) when
 * the slot under the cursor is still alive, i.e. the ring is full.
 */
export function emitTrail(sim: RainSim, x: number, y: number, r: number): boolean {
  const slot = sim.config.maxStatic + sim.trailCursor;
  if (sim.config.maxTrails === 0 || sim.dKind[slot] !== DEAD) {
    sim.trailsSkipped++;
    return false;
  }
  sim.dx[slot] = x;
  sim.dy[slot] = y;
  sim.dr[slot] = r;
  sim.dAge[slot] = 0;
  sim.dLife[slot] = TRAIL_LIFE_MIN + sim.rng() * TRAIL_LIFE_SPREAD;
  sim.dKind[slot] = TRAIL;
  sim.trailCursor = sim.trailCursor + 1 === sim.config.maxTrails ? 0 : sim.trailCursor + 1;
  return true;
}

/** Grid cell of a point, clamped to the grid. */
export function cellOf(sim: RainSim, x: number, y: number): number {
  const cs = sim.config.cellSize;
  const cx = Math.min(sim.cols - 1, Math.max(0, Math.floor(x / cs)));
  const cy = Math.min(sim.rows - 1, Math.max(0, Math.floor(y / cs)));
  return cy * sim.cols + cx;
}

/** Rebuilds the grid lists from every live droplet. */
export function buildGrid(sim: RainSim) {
  const { head, next, dKind } = sim;
  head.fill(-1);
  for (let i = 0; i < dKind.length; i++) {
    if (dKind[i] === DEAD) continue;
    const c = cellOf(sim, sim.dx[i], sim.dy[i]);
    next[i] = head[c];
    head[c] = i;
  }
}

/**
 * Wipes droplets within `radius` (plus half the droplet's radius) of the segment
 * (x0, y0)-(x1, y1), using the grid from `buildGrid`. Static droplets respawn
 * elsewhere at once (fading in); trail droplets die, unless younger than
 * `TRAIL_GRACE`. Returns the summed volume (r^3) of the wiped droplets.
 */
export function wipeCapsule(
  sim: RainSim,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): number {
  const cs = sim.config.cellSize;
  const reach = radius + STATIC_MAX_R;
  const cx0 = Math.max(0, Math.floor((Math.min(x0, x1) - reach) / cs));
  const cx1 = Math.min(sim.cols - 1, Math.floor((Math.max(x0, x1) + reach) / cs));
  const cy0 = Math.max(0, Math.floor((Math.min(y0, y1) - reach) / cs));
  const cy1 = Math.min(sim.rows - 1, Math.floor((Math.max(y0, y1) + reach) / cs));
  const sx = x1 - x0;
  const sy = y1 - y0;
  const len2 = sx * sx + sy * sy;
  const inv = len2 > 1e-12 ? 1 / len2 : 0;
  const { head, next, dKind, dx, dy, dr, dAge } = sim;
  let volume = 0;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let i = head[cy * sim.cols + cx]; i !== -1; i = next[i]) {
        const kind = dKind[i];
        if (kind === DEAD || (kind === TRAIL && dAge[i] < TRAIL_GRACE)) continue;
        const px = dx[i] - x0;
        const py = dy[i] - y0;
        const t = Math.min(1, Math.max(0, (px * sx + py * sy) * inv));
        const ex = px - t * sx;
        const ey = py - t * sy;
        const r = dr[i];
        const reachI = radius + r * 0.5;
        if (ex * ex + ey * ey >= reachI * reachI) continue;
        volume += r * r * r;
        sim.wiped++;
        if (kind === STATIC) spawnStatic(sim, i, false);
        else dKind[i] = DEAD;
      }
    }
  }
  return volume;
}

/**
 * Fade of a droplet, 0..1: static droplets fade in over the first 20% of their
 * life and out over the last 30%; trail droplets start full and fade out.
 */
export function dropletFade(kind: number, age: number, life: number): number {
  if (kind === DEAD || life <= 0) return 0;
  const t = Math.min(1, Math.max(0, age / life));
  if (kind === TRAIL) {
    const k = 1 - t;
    return k * k;
  }
  const f = Math.min(1, t / 0.2, (1 - t) / 0.3);
  return f * f * (3 - 2 * f);
}

/** Visual elongation of a running drop: 1 at rest, up to 1.5 when fast. */
export function runnerStretch(state: number, v: number): number {
  return state === RUNNING ? 1 + Math.min(0.5, v / 300) : 1;
}

/** Advances the simulation by `dt` seconds (clamped to `MAX_DT`). */
export function stepRainSim(sim: RainSim, dtIn: number, p: RainSimParams) {
  const dt = Math.min(MAX_DT, Math.max(0, dtIn));
  const { config, rng } = sim;
  const rain = Math.min(1, Math.max(0, p.rain));

  // Active static droplets follow the rain amount. The very first fill starts
  // mid-life so the window is not empty, nor all fading in together. Slots the
  // rain no longer wants fade out first (and back in if it rises again).
  const fadeStep = dt / FADE_OUT;
  const targetStatic = Math.round(rain * config.maxStatic);
  for (let i = sim.staticCount; i < targetStatic; i++) spawnStatic(sim, i, !sim.primed);
  sim.staticCount = growLive(sim.staticFade, sim.staticCount, targetStatic);
  for (let i = 0; i < sim.staticCount; i++) {
    stepLife(sim.staticFade, i, targetStatic, fadeStep, fadeStep);
  }
  const staticLive = trimLive(sim.staticFade, sim.staticCount, targetStatic);
  for (let i = staticLive; i < sim.staticCount; i++) sim.dKind[i] = DEAD;
  sim.staticCount = staticLive;

  const targetRunners = Math.round(rain * config.maxRunners);
  for (let i = sim.runnerCount; i < targetRunners; i++) {
    spawnRunner(sim, i);
    if (!sim.primed) {
      // Start partway grown, and already visible.
      sim.rr[i] = SPAWN_MIN_R + rng() * (sim.rBreak[i] - SPAWN_MIN_R);
      sim.rAge[i] = RUNNER_FADE_IN;
    }
  }
  sim.runnerCount = growLive(sim.runnerFade, sim.runnerCount, targetRunners);
  for (let i = 0; i < sim.runnerCount; i++) {
    stepLife(sim.runnerFade, i, targetRunners, fadeStep, fadeStep);
  }
  sim.runnerCount = trimLive(sim.runnerFade, sim.runnerCount, targetRunners);
  // Only once there was something to place: a start at rain 0 must not use up the
  // mid-life first fill, or raising the rain later fades every droplet in together.
  if (targetStatic > 0 || targetRunners > 0) sim.primed = true;

  // Age droplets.
  const { dKind, dAge, dLife } = sim;
  for (let i = 0; i < sim.staticCount; i++) {
    const age = dAge[i] + dt;
    if (dKind[i] === DEAD || age >= dLife[i]) spawnStatic(sim, i, false);
    else dAge[i] = age;
  }
  const trailEnd = config.maxStatic + config.maxTrails;
  for (let i = config.maxStatic; i < trailEnd; i++) {
    if (dKind[i] === DEAD) continue;
    const age = dAge[i] + dt;
    if (age >= dLife[i]) dKind[i] = DEAD;
    else dAge[i] = age;
  }

  buildGrid(sim);

  const { rx, ry, rr, rv, rState } = sim;
  const speed = Math.max(0, p.speed);
  for (let i = 0; i < sim.runnerCount; i++) {
    sim.rAge[i] += dt;
    sim.rStepX[i] = 0;
    sim.rStepY[i] = 0;
    if (rState[i] === RESTING) {
      if (rr[i] < sim.rBreak[i]) {
        rr[i] = Math.min(sim.rBreak[i], rr[i] + GROW_RATE * dt * (0.5 + rng()));
      } else if (speed > 0) {
        rState[i] = RUNNING;
        rv[i] = 0;
        sim.rJerk[i] = 1;
      }
      continue;
    }

    // Stop-go: now and then pick a new pace, and ease the speed towards it.
    if (rng() < dt * 1.5) sim.rJerk[i] = 0.25 + rng();
    const target = BASE_SPEED * speed * (rr[i] / BREAK_MIN) * sim.rJerk[i];
    rv[i] += (target - rv[i]) * Math.min(1, dt * 4);
    const v = rv[i];
    // Wiggle phase advances with distance, so slow drops wiggle slowly.
    sim.rPhase[i] += dt * v * 0.04 * (0.5 + rng());
    const x0 = rx[i];
    const y0 = ry[i];
    const x1 = Math.min(sim.width, Math.max(0, x0 + Math.sin(sim.rPhase[i]) * v * WIGGLE * dt));
    const y1 = y0 + v * dt;
    rx[i] = x1;
    ry[i] = y1;
    sim.rStepX[i] = x1 - x0;
    sim.rStepY[i] = y1 - y0;

    // Collect droplets and resting runners in the way.
    let vol = rr[i] * rr[i] * rr[i];
    vol += wipeCapsule(sim, x0, y0, x1, y1, rr[i] * WIPE) * ABSORB;
    for (let j = 0; j < sim.runnerCount; j++) {
      if (j === i || rState[j] !== RESTING) continue;
      const ex = rx[j] - x1;
      const ey = ry[j] - y1;
      const reach = rr[i] + rr[j] * 0.5;
      if (ex * ex + ey * ey < reach * reach) {
        vol += rr[j] * rr[j] * rr[j];
        spawnRunner(sim, j);
      }
    }

    // Leave a trail of tiny droplets behind.
    sim.rTravel[i] += y1 - y0;
    let r = Math.cbrt(vol);
    while (sim.rTravel[i] >= 0) {
      sim.rTravel[i] -= trailSpacing(rng);
      const tr = r * (0.18 + 0.17 * rng());
      if (emitTrail(sim, x0 + (rng() - 0.5) * r * 0.5, y0 - r * 0.7, tr)) {
        vol = Math.max(0, vol - tr * tr * tr * TRAIL_LOSS);
        r = Math.cbrt(vol);
      }
    }
    rr[i] = Math.min(MAX_RUNNER_R, r);

    if (y1 - rr[i] * 2 > sim.height) spawnRunner(sim, i);
    else if (rr[i] < STOP_R) {
      rState[i] = RESTING;
      rv[i] = 0;
      sim.rBreak[i] = BREAK_MIN + rng() * BREAK_SPREAD;
    }
  }
}

/** Writes visible droplets in slots `[from, to)` at float offset `o`; returns the new offset. */
function writeDroplets(
  sim: RainSim,
  out: Float32Array,
  scale: number,
  o: number,
  from: number,
  to: number,
): number {
  const { dKind, dx, dy, dr, dAge, dLife, staticFade } = sim;
  const statics = staticFade.length;
  for (let i = from; i < to; i++) {
    const kind = dKind[i];
    if (kind === DEAD) continue;
    const f = dropletFade(kind, dAge[i], dLife[i]) * (i < statics ? staticFade[i] : 1);
    if (f <= 0.01) continue;
    out[o] = dx[i] * scale;
    out[o + 1] = dy[i] * scale;
    // Evaporating droplets shrink as well as fade.
    out[o + 2] = dr[i] * (0.55 + 0.45 * f) * scale;
    out[o + 3] = 1;
    out[o + 4] = f;
    o += INSTANCE_STRIDE;
  }
  return o;
}

/**
 * Writes the visible drops as instances (see `INSTANCE_STRIDE`), in draw order:
 * static droplets, trails, then runners on top. Positions and radii are
 * multiplied by `scale` (device px per reference unit). Sets `runnerFirst` and
 * `runnersWritten`. Returns the instance count.
 */
export function writeDropInstances(sim: RainSim, out: Float32Array, scale: number): number {
  const { config } = sim;
  let o = writeDroplets(sim, out, scale, 0, 0, sim.staticCount);
  o = writeDroplets(sim, out, scale, o, config.maxStatic, config.maxStatic + config.maxTrails);
  const runnerFirst = o / INSTANCE_STRIDE;
  for (let i = 0; i < sim.runnerCount; i++) {
    out[o] = sim.rx[i] * scale;
    out[o + 1] = sim.ry[i] * scale;
    out[o + 2] = sim.rr[i] * scale;
    out[o + 3] = runnerStretch(sim.rState[i], sim.rv[i]);
    out[o + 4] = Math.min(1, sim.rAge[i] / RUNNER_FADE_IN) * sim.runnerFade[i];
    o += INSTANCE_STRIDE;
  }
  sim.runnerFirst = runnerFirst;
  sim.runnersWritten = sim.runnerCount;
  return o / INSTANCE_STRIDE;
}

/** Extra wipe stamps per runner at most, filling the gap a fast step leaves. */
export const MAX_WIPE_STAMPS = 8;

/** Instances `writeWipeStamps` can write at most. */
export function wipeStampCapacity(c: Readonly<RainSimConfig>): number {
  return c.maxRunners * MAX_WIPE_STAMPS;
}

/**
 * Fills the gaps in the fog wipe at low frame rates. Each runner's own instance
 * stamps one disc where it is now, and the last frame's stamped where it was, so
 * a step longer than the disc leaves unwiped fog in between. This writes copies
 * of each runner's instance (from `writeDropInstances`, which must run first)
 * back along its last step, spaced at most `spacing` times its radius, starting
 * at instance `first`; returns how many it wrote. Draw them together with the
 * runners: they directly follow the runners when `first` is the instance count.
 */
export function writeWipeStamps(
  sim: RainSim,
  out: Float32Array,
  scale: number,
  first: number,
  spacing: number,
): number {
  let o = first * INSTANCE_STRIDE;
  const start = o;
  for (let i = 0; i < sim.runnersWritten; i++) {
    const sx = sim.rStepX[i];
    const sy = sim.rStepY[i];
    const gap = spacing * sim.rr[i];
    if (!(gap > 0)) continue;
    const n = Math.min(MAX_WIPE_STAMPS + 1, Math.ceil(Math.hypot(sx, sy) / gap));
    if (n < 2) continue;
    const src = (sim.runnerFirst + i) * INSTANCE_STRIDE;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out[o] = out[src] - sx * t * scale;
      out[o + 1] = out[src + 1] - sy * t * scale;
      out[o + 2] = out[src + 2];
      out[o + 3] = out[src + 3];
      out[o + 4] = out[src + 4];
      o += INSTANCE_STRIDE;
    }
  }
  return (o - start) / INSTANCE_STRIDE;
}
