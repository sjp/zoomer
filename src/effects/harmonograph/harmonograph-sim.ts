import { smoothstep } from "../math";

/**
 * CPU side of the harmonograph effect: picks pendulum figures and walks a pen
 * along them, writing fixed-length line segments into a ring that the effect
 * uploads incrementally. Everything here allocates only at creation.
 *
 * The curve is `x(t) = Σ Aᵢ·sin(fᵢ·t + pᵢ)·e^(−dᵢ·t)` with two pendulums per axis.
 * Positions are normalised per figure so the curve's extent is ±1 on each axis;
 * the effect maps that box onto the frame.
 */

/** Floats per segment: start x, start y, end x, end y, birth time (wrapped), palette phase. */
export const SEG_FLOATS = 6;

/** Period the uploaded birth times wrap at, in seconds. Must exceed the longest fade. */
export const TIME_PERIOD = 2048;

/** Most segments a figure is cut into. Two figures plus slack fit in the effect's ring. */
export const FIGURE_SEGMENTS = 6000;

/** Shortest segment, in normalised units (about 1.5 px at 1080p for a centred figure). */
export const MIN_SEG = 0.003;

/** Longest segment allowed; a figure that would need longer ones is too dense. */
export const MAX_SEG = 0.02;

/** Fewest normalised arc-length units a figure may have before it counts as too sparse. */
const MIN_ARC = 12;

/** Seconds between one figure finishing and the next starting. */
const FIGURE_GAP = 2;

/** Segment ages fade from `FADE_HOLD * fadeAge` to `fadeAge`. */
export const FADE_HOLD = 0.2;

/** Fade age as a multiple of the draw time: the previous figure fades while the next draws. */
const FADE_FIGURES = 1.75;

/** Palette cycles along one figure. */
const COLOR_CYCLES = 1.5;

/** Palette stops (the shader's `uPalette` length). */
export const PALETTE_STOPS = 4;

/** Samples used to measure a figure's extent, arc length and spread. */
const MEASURE_SAMPLES = 2048;

/** Amplitude the slowest-decaying pendulum has left at the end of a figure. */
const END_AMP = 0.05;

/** Frequency ratios (x : y), simplest first; complexity widens the choice. */
const RATIOS: readonly (readonly [number, number])[] = [
  [1, 1],
  [2, 3],
  [1, 2],
  [3, 4],
  [2, 1],
  [3, 2],
  [3, 5],
  [4, 5],
  [5, 4],
  [2, 5],
];

/** A figure: four pendulum terms (0 and 1 drive x, 2 and 3 drive y) and derived sizes. */
export interface Figure {
  amp: Float64Array;
  freq: Float64Array;
  phase: Float64Array;
  decay: Float64Array;
  /** Curve-time length of the figure. */
  duration: number;
  /** Reciprocal of the raw extent on each axis, so normalised positions span ±1. */
  invX: number;
  invY: number;
  /** Normalised arc length over [0, duration]. */
  arc: number;
  /** Target segment length (normalised) and the resulting segment count. */
  seg: number;
  segments: number;
  /** Palette phase at the start of the figure. */
  hue: number;
}

export function createFigure(): Figure {
  return {
    amp: new Float64Array(4),
    freq: new Float64Array(4),
    phase: new Float64Array(4),
    decay: new Float64Array(4),
    duration: 1,
    invX: 1,
    invY: 1,
    arc: 0,
    seg: MIN_SEG,
    segments: 0,
    hue: 0,
  };
}

/** Raw (unnormalised) curve position and velocity at curve time `t`, written to `out`. */
function evalCurve(f: Figure, t: number, out: Float64Array): void {
  let x = 0;
  let y = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < 4; i++) {
    const a = f.amp[i] * Math.exp(-f.decay[i] * t);
    const arg = f.freq[i] * t + f.phase[i];
    const s = Math.sin(arg);
    const p = a * s;
    const v = a * (f.freq[i] * Math.cos(arg) - f.decay[i] * s);
    if (i < 2) {
      x += p;
      vx += v;
    } else {
      y += p;
      vy += v;
    }
  }
  out[0] = x;
  out[1] = y;
  out[2] = vx;
  out[3] = vy;
}

/** Why `measureFigure` rejected a figure, or null if it is fine. */
type Rejection = "collapsed" | "line" | "sparse" | "dense" | null;

const scratch = new Float64Array(4);
/** Raw sample positions from `measureFigure`'s first pass, reused by its second. */
const samples = new Float64Array((MEASURE_SAMPLES + 1) * 2);

/**
 * Measures `f` (extent, normalisation, arc length, segment length) and returns
 * why it is unusable, or null. Rejects figures where one axis barely moves
 * ("collapsed"), that trace little more than a line ("line"), that are too short
 * ("sparse") or that would need segments longer than `MAX_SEG` ("dense").
 */
export function measureFigure(f: Figure): Rejection {
  const n = MEASURE_SAMPLES;
  const dt = f.duration / n;
  let mx = 0;
  let my = 0;
  for (let k = 0; k <= n; k++) {
    evalCurve(f, k * dt, scratch);
    samples[k * 2] = scratch[0];
    samples[k * 2 + 1] = scratch[1];
    mx = Math.max(mx, Math.abs(scratch[0]));
    my = Math.max(my, Math.abs(scratch[1]));
  }
  if (!(mx > 1e-9 && my > 1e-9) || Math.min(mx, my) < 0.35 * Math.max(mx, my)) {
    return "collapsed";
  }
  f.invX = 1 / mx;
  f.invY = 1 / my;

  // Arc length and second moments of the normalised curve.
  let arc = 0;
  let px = 0;
  let py = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k <= n; k++) {
    const x = samples[k * 2] * f.invX;
    const y = samples[k * 2 + 1] * f.invY;
    if (k > 0) {
      arc += Math.hypot(x - px, y - py);
    }
    px = x;
    py = y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  // Eigenvalues of the (uncentred) second-moment matrix: a line has one near zero.
  const tr = sxx + syy;
  const disc = Math.sqrt((sxx - syy) * (sxx - syy) + 4 * sxy * sxy);
  const lo = (tr - disc) / 2;
  const hi = (tr + disc) / 2;
  if (!(hi > 0) || lo < 0.08 * hi) {
    return "line";
  }
  f.arc = arc;
  if (arc < MIN_ARC) {
    return "sparse";
  }
  const seg = Math.max(MIN_SEG, arc / FIGURE_SEGMENTS);
  if (seg > MAX_SEG) {
    return "dense";
  }
  f.seg = seg;
  f.segments = Math.ceil(arc / seg);
  return null;
}

/** Fills `f` with random pendulum settings for `complexity` (0..1); not yet measured. */
function randomFigure(f: Figure, rng: () => number, complexity: number): void {
  const choices = 3 + Math.round(complexity * (RATIOS.length - 3));
  const [a, b] = RATIOS[Math.min(RATIOS.length - 1, Math.floor(rng() * choices))];
  const detune = 0.002 + 0.012 * complexity;
  const jitter = () => 1 + detune * (rng() * 2 - 1);
  // Each axis has its own pendulum plus a weaker coupling at the other axis's frequency.
  f.freq[0] = a * jitter();
  f.freq[1] = b * jitter();
  f.freq[2] = b * jitter();
  f.freq[3] = a * jitter();
  const second = 0.1 + 0.55 * complexity;
  f.amp[0] = 1;
  f.amp[1] = second * (0.3 + 0.7 * rng());
  f.amp[2] = 0.8 + 0.2 * rng();
  f.amp[3] = second * (0.3 + 0.7 * rng());
  for (let i = 0; i < 4; i++) {
    f.phase[i] = rng() * Math.PI * 2;
  }
  // Cycles of the mean frequency over the figure; more with complexity.
  const cycles = 14 + (8 + 10 * complexity) * rng();
  f.duration = (Math.PI * 2 * cycles) / ((a + b) / 2);
  const d = Math.log(1 / END_AMP) / f.duration;
  for (let i = 0; i < 4; i++) {
    f.decay[i] = d * (0.75 + 0.5 * rng());
  }
  f.hue = rng() * PALETTE_STOPS;
}

/**
 * Picks a usable figure into `f`, drawing from `rng` until one passes
 * `measureFigure`. Deterministic for a given rng state. Returns the attempts used.
 */
export function chooseFigure(f: Figure, rng: () => number, complexity: number): number {
  for (let attempt = 1; ; attempt++) {
    randomFigure(f, rng, attempt > 20 ? 0 : complexity);
    if (measureFigure(f) === null) {
      return attempt;
    }
    if (attempt > 200) {
      throw new Error("Harmonograph: no usable figure");
    }
  }
}

/** Segment opacity at `age` seconds for a fade over `fadeAge`. Mirrors the shader. */
export function fadeAlpha(age: number, fadeAge: number): number {
  return 1 - smoothstep(FADE_HOLD * fadeAge, fadeAge, age);
}

interface PenSettings {
  /** Seconds to draw one figure. */
  drawTime: number;
  /** 0..1, used when the next figure is chosen. */
  complexity: number;
}

interface Harmonograph {
  /** Ring of `capacity` segments, `SEG_FLOATS` floats each. */
  readonly data: Float32Array;
  readonly capacity: number;
  readonly figure: Figure;
  /** Slot the next segment goes into. */
  readonly head: number;
  /** Segments still visible: the `live` slots before `head`, oldest first. */
  readonly live: number;
  /** First slot written since `clearDirty`, and how many (at most `capacity`). */
  readonly dirtyStart: number;
  readonly dirtyCount: number;
  /** Seconds since creation, unwrapped. */
  readonly time: number;
  /** Seconds a segment stays visible, from the last `step`'s draw time. */
  readonly fadeAge: number;
  /** Unwrapped birth time of each slot. */
  readonly births: Float64Array;
  /** Advances the pen by `dt` seconds, emitting segments and expiring old ones. */
  step: (dt: number, s: PenSettings) => void;
  clearDirty: () => void;
}

/** Segments emitted per `step` at most, so a long step can't stall a frame. */
const MAX_PER_STEP = 1024;

export function createHarmonograph(
  capacity: number,
  rng: () => number,
  complexity = 0.5,
): Harmonograph {
  const data = new Float32Array(capacity * SEG_FLOATS);
  const births = new Float64Array(capacity);
  const figure = createFigure();
  const pos = new Float64Array(4);
  let head = 0;
  let live = 0;
  let dirtyStart = 0;
  let dirtyCount = 0;
  let time = 0;
  let fadeAge = 1;
  // Pen state within the current figure.
  let penT = 0;
  let penX = 0;
  let penY = 0;
  let emitted = 0;
  let budget = 0;
  let gap = 0;
  let maxStep = 1;

  function startFigure(c: number) {
    chooseFigure(figure, rng, c);
    penT = 0;
    evalCurve(figure, 0, pos);
    penX = pos[0] * figure.invX;
    penY = pos[1] * figure.invY;
    emitted = 0;
    budget = 0;
    let fmax = 0;
    for (let i = 0; i < 4; i++) {
      fmax = Math.max(fmax, figure.freq[i]);
    }
    maxStep = (Math.PI * 2) / (fmax * 8);
  }

  /** Normalised pen position at curve time `t`, into penNext. */
  let nextX = 0;
  let nextY = 0;
  function at(t: number) {
    evalCurve(figure, t, pos);
    nextX = pos[0] * figure.invX;
    nextY = pos[1] * figure.invY;
  }

  /** Moves the pen one segment length along the curve. Returns false at the end. */
  function advance(): boolean {
    const f = figure;
    if (penT >= f.duration) {
      return false;
    }
    const L = f.seg;
    // March along the curve in steps sized from the local speed (at most an
    // eighth of the fastest pendulum's period, so no loop is skipped) until the
    // chord from the pen reaches L, then bisect for the crossing. Near cusps the
    // pen slows to a stop, so the speed alone would badly misjudge the step.
    let t0 = penT;
    let len0 = 0;
    for (let guard = 0; guard < 64; guard++) {
      evalCurve(f, t0, pos);
      const speed = Math.hypot(pos[2] * f.invX, pos[3] * f.invY);
      const want = (L - len0) * 1.05;
      const h = speed * maxStep > want ? Math.max(want / speed, maxStep * 1e-3) : maxStep;
      const t1 = t0 + h;
      if (t1 >= f.duration) {
        at(f.duration);
        if (Math.hypot(nextX - penX, nextY - penY) < L) {
          penT = f.duration;
          return true;
        }
        return bisect(t0, f.duration, L);
      }
      at(t1);
      const len1 = Math.hypot(nextX - penX, nextY - penY);
      if (len1 >= L) {
        return bisect(t0, t1, L);
      }
      t0 = t1;
      len0 = len1;
    }
    at(t0);
    penT = t0;
    return true;
  }

  /** Finds t in (lo, hi] where the chord from the pen is L (shorter at lo, not at hi). */
  function bisect(lo: number, hi: number, L: number): boolean {
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      at(mid);
      const len = Math.hypot(nextX - penX, nextY - penY);
      if (Math.abs(len - L) < 0.005 * L) {
        penT = mid;
        return true;
      }
      if (len < L) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    at(hi);
    penT = hi;
    return true;
  }

  function emit(startX: number, startY: number) {
    const o = head * SEG_FLOATS;
    data[o] = startX;
    data[o + 1] = startY;
    data[o + 2] = penX;
    data[o + 3] = penY;
    data[o + 4] = time % TIME_PERIOD;
    let phase =
      (figure.hue + (COLOR_CYCLES * PALETTE_STOPS * emitted) / figure.segments) % PALETTE_STOPS;
    if (phase < 0) {
      phase += PALETTE_STOPS;
    }
    data[o + 5] = phase;
    births[head] = time;
    if (dirtyCount === 0) {
      dirtyStart = head;
    }
    if (dirtyCount < capacity) {
      dirtyCount++;
    }
    head = head + 1 === capacity ? 0 : head + 1;
    if (live < capacity) {
      live++;
    }
    emitted++;
  }

  startFigure(complexity);

  return {
    data,
    capacity,
    figure,
    births,
    get head() {
      return head;
    },
    get live() {
      return live;
    },
    get dirtyStart() {
      return dirtyStart;
    },
    get dirtyCount() {
      return dirtyCount;
    },
    get time() {
      return time;
    },
    get fadeAge() {
      return fadeAge;
    },
    step(dt, s) {
      time += dt;
      fadeAge = FADE_FIGURES * s.drawTime;
      if (gap > 0) {
        gap -= dt;
        if (gap <= 0) {
          startFigure(s.complexity);
        }
      } else {
        budget += (dt * figure.segments) / s.drawTime;
        let n = 0;
        while (budget >= 1 && n < MAX_PER_STEP) {
          const sx = penX;
          const sy = penY;
          if (!advance()) {
            gap = FIGURE_GAP;
            budget = 0;
            break;
          }
          penX = nextX;
          penY = nextY;
          emit(sx, sy);
          budget -= 1;
          n++;
        }
        if (n === MAX_PER_STEP) {
          budget = Math.min(budget, 1);
        }
      }
      // Expire segments past the fade, oldest first.
      let oldest = head - live;
      if (oldest < 0) {
        oldest += capacity;
      }
      while (live > 0 && time - births[oldest] >= fadeAge) {
        live--;
        oldest = oldest + 1 === capacity ? 0 : oldest + 1;
      }
    },
    clearDirty() {
      dirtyCount = 0;
    },
  };
}
