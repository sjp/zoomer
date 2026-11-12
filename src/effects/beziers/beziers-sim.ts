import type { Rgb } from "../color";
import {
  createBouncePoints,
  placeBouncePoint,
  stepBouncePoints,
  type BouncePoints,
} from "../bounce-points";
import {
  ECHO_SIM_RATE,
  echoBrightness,
  echoColor,
  echoLineLook,
  echoSteps,
  hueRgb,
  MIN_ECHO_STEPS,
  type EchoLineLook,
} from "../echo-lines";
import { createEchoRing, type EchoRing } from "../echo-ring";
import { createCountFade } from "../fade";
import { approach, clamp } from "../math";
import { createRng } from "../noise";
import { takeSteps, type StepClock } from "../step-clock";
import { STREAK_FLOATS } from "../streaks";
import { MAX_CURVES, MAX_SEGMENTS, MAX_SPEED, MAX_TRAIL } from "./beziers.meta";

/**
 * The Béziers simulation and line layout: `MAX_CURVES` closed loops of up to
 * `MAX_SEGMENTS` cubic Bézier segments joined end to end, whose control points
 * bounce around the frame, stepped at a fixed rate, with a history of past loops
 * sampled every few steps for the echo trail. `write` flattens every loop into
 * short line pieces and lays them out as streaks for one instanced draw.
 *
 * Segment `j` runs from anchor `3j` through controls `3j + 1` and `3j + 2` to
 * the next segment's anchor, the last one back to anchor 0, so the loop is
 * always closed. A point on a curve is a fixed weighted average of its control
 * points, so it never moves faster than the fastest of them.
 *
 * Every loop and every control point is always simulated, so changing the
 * counts only changes what is drawn: loops fade in and out, a new segment
 * starts folded up on anchor 0 (where the loop closes, so nothing jumps) and
 * unfolds as its points drift apart, and a removed segment cross-fades to the
 * closing curve that replaces it.
 */

/** Most steps run in one frame; the rest are dropped rather than caught up. */
const MAX_STEPS_PER_FRAME = 8;

/** Frame heights per second per unit of the `speed` slider. */
export const SPEED_UNIT = 0.1;
/** How fast the speed eases to a new slider value, frame heights per second per second. */
const SPEED_EASE = 0.25;

/** Each loop's colour goes round the hue wheel once in this many seconds. */
const HUE_PERIOD = 45;

/** Seconds for a loop to fade in or out when the loop count changes. */
const CURVE_FADE = 0.8;
/** Segments per second added or removed while the segment count eases to a new value. */
const SEGMENTS_RATE = 1;
/** Echoes per second added or removed while the echo count eases. */
const TRAIL_RATE = 8;
/** Seconds to cross between styles. */
const STYLE_EASE = 1;
/** Seconds the loops take to fade out (and back in) when the seed changes. */
const RESEED_FADE = 0.6;

/** Reference px kept clear at the frame's edges, so the lines aren't clipped. */
const EDGE_INSET = 2;

/**
 * Largest gap, in reference px, between a curve and the straight pieces drawn
 * for it: well under a line width, so the pieces read as a smooth curve.
 */
const FLATNESS = 0.75;
/** Most line pieces per segment, at any size. */
export const MAX_PIECES = 24;

/** Control points per loop: an anchor and two controls per segment. */
export const POINTS = MAX_SEGMENTS * 3;
/** Floats per history sample: every point's x and y, then the segment count and the hue. */
const SAMPLE_STRIDE = POINTS * 2 + 2;
const SAMPLE_SEGMENTS = POINTS * 2;
const SAMPLE_HUE = POINTS * 2 + 1;

/** Segments per loop drawn at most: every segment, plus one more while a segment cross-fades. */
const DRAWN_SEGMENTS = MAX_SEGMENTS + 1;
/** Streaks `write` can produce: a line and a glow per piece of every loop and echo. */
export const MAX_STREAKS = MAX_CURVES * (MAX_TRAIL + 1) * DRAWN_SEGMENTS * MAX_PIECES * 2;

/** The params the simulation reads; the effect passes its params object. */
interface BeziersSettings {
  style: string;
  curves: number;
  segments: number;
  trail: number;
  speed: number;
  seed: number;
}

interface Loop {
  points: BouncePoints;
  rng: () => number;
  hue: number;
  history: EchoRing;
}

/**
 * Line pieces for a cubic with control points `p0`–`p3` (px) so the pieces stay
 * within `tolerance` px of the curve (Wang's bound), from 1 to `MAX_PIECES`.
 */
export function bezierPieces(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tolerance: number,
): number {
  const ax = x0 - 2 * x1 + x2;
  const ay = y0 - 2 * y1 + y2;
  const bx = x1 - 2 * x2 + x3;
  const by = y1 - 2 * y2 + y3;
  const m = Math.sqrt(Math.max(ax * ax + ay * ay, bx * bx + by * by));
  const n = Math.ceil(Math.sqrt((0.75 * m) / Math.max(tolerance, 1e-6)));
  return n >= 1 ? Math.min(n, MAX_PIECES) : 1;
}

const safe = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

export function createBeziers() {
  const loops: Loop[] = [];
  for (let i = 0; i < MAX_CURVES; i++) {
    loops.push({
      points: createBouncePoints(POINTS, createRng(i)),
      rng: createRng(i),
      hue: 0,
      history: createEchoRing(MAX_TRAIL, SAMPLE_STRIDE),
    });
  }
  const fade = createCountFade(MAX_CURVES);
  const clock: StepClock = { acc: 0 };

  let seed = Number.NaN;
  /** Fade for a seed change: the loops dip out, are rebuilt, and come back. */
  let reseedFade = 1;
  let started = false;
  let speed = 0;
  let segmentsMix = 1;
  let trailMix = 0;
  let styleMix = 0;
  /** Steps since the newest echo was sampled, and the current steps between echoes. */
  let sinceSample = 0;
  let interval = MIN_ECHO_STEPS;
  /** Simulated seconds, for the hue drift. */
  let time = 0;
  let aspect = 16 / 9;

  /** Loop `i`'s hue, in turns: spread out per loop and seed, drifting with time. */
  const loopHue = (i: number) => (seed * 0.618034 + i * 0.37 + time / HUE_PERIOD) % 1;

  function sample() {
    for (const l of loops) {
      const o = l.history.push();
      const d = l.history.data;
      for (let j = 0; j < POINTS; j++) {
        d[o + j * 2] = l.points.x[j];
        d[o + j * 2 + 1] = l.points.y[j];
      }
      d[o + SAMPLE_SEGMENTS] = segmentsMix;
      d[o + SAMPLE_HUE] = l.hue;
    }
    sinceSample = 0;
  }

  function stepSim() {
    time += 1 / ECHO_SIM_RATE;
    for (let i = 0; i < MAX_CURVES; i++) {
      const l = loops[i];
      stepBouncePoints(l.points, 1 / ECHO_SIM_RATE, speed, aspect, l.rng);
      l.hue = loopHue(i);
    }
    sinceSample++;
    interval = echoSteps(speed);
    if (sinceSample >= interval) {
      sample();
    }
  }

  /** Rebuilds the loops for `seed` and runs the sim long enough to fill the trail. */
  function reseed(next: number) {
    seed = next;
    time = 0;
    for (let i = 0; i < MAX_CURVES; i++) {
      const base = Math.floor(next) * MAX_CURVES + i;
      const l = loops[i];
      l.points = createBouncePoints(POINTS, createRng(base * 2 + 1));
      l.rng = createRng(base * 2 + 2);
      l.hue = loopHue(i);
      l.history.clear();
    }
    clock.acc = 0;
    sample();
    while (loops[0].history.count < MAX_TRAIL) {
      stepSim();
    }
  }

  // Layout state for `write`, shared with its helpers so drawing allocates nothing.
  const head = new Float32Array(POINTS * 2);
  const now: Rgb = [0, 0, 0];
  const then: Rgb = [0, 0, 0];
  const color: Rgb = [0, 0, 0];
  const look: EchoLineLook = { halfWidth: 1, glowWidth: 1, glow: 0, saturation: 1 };
  let out: Float32Array = new Float32Array(0);
  let count = 0;
  let inset = 0;
  let spanX = 1;
  let spanY = 1;
  let tolerance = FLATNESS;

  function put(x0: number, y0: number, x1: number, y1: number, bright: number, r: number) {
    const o = count * STREAK_FLOATS;
    out[o] = x0;
    out[o + 1] = y0;
    out[o + 2] = x1;
    out[o + 3] = y1;
    out[o + 4] = color[0] * bright;
    out[o + 5] = color[1] * bright;
    out[o + 6] = color[2] * bright;
    out[o + 7] = r;
    count++;
  }

  /**
   * Appends the cubic from anchor `a` through controls `a + 1`, `a + 2` to anchor
   * `b` of the loop at `o` in `src`, as line pieces.
   */
  function segment(src: Float32Array, o: number, a: number, b: number, bright: number) {
    const x0 = inset + src[o + a * 2] * spanX;
    const y0 = inset + src[o + a * 2 + 1] * spanY;
    const x1 = inset + src[o + a * 2 + 2] * spanX;
    const y1 = inset + src[o + a * 2 + 3] * spanY;
    const x2 = inset + src[o + a * 2 + 4] * spanX;
    const y2 = inset + src[o + a * 2 + 5] * spanY;
    const x3 = inset + src[o + b * 2] * spanX;
    const y3 = inset + src[o + b * 2 + 1] * spanY;
    const n = bezierPieces(x0, y0, x1, y1, x2, y2, x3, y3, tolerance);
    let px = x0;
    let py = y0;
    for (let i = 1; i <= n; i++) {
      let qx = x3;
      let qy = y3;
      if (i < n) {
        const t = i / n;
        const s = 1 - t;
        const w0 = s * s * s;
        const w1 = 3 * s * s * t;
        const w2 = 3 * s * t * t;
        const w3 = t * t * t;
        qx = w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3;
        qy = w0 * y0 + w1 * y1 + w2 * y2 + w3 * y3;
      }
      put(px, py, qx, qy, bright, look.halfWidth);
      if (look.glow > 0) {
        put(px, py, qx, qy, bright * look.glow, look.glowWidth);
      }
      px = qx;
      py = qy;
    }
  }

  /**
   * Draws the loop at `o` in `src` (normalised points) with `mix` segments
   * (fractional while one cross-fades) at brightness `bright`.
   */
  function loop(src: Float32Array, o: number, mix: number, bright: number) {
    const n = Math.min(MAX_SEGMENTS, Math.max(1, Math.floor(mix)));
    const f = n < MAX_SEGMENTS ? clamp(mix - n, 0, 1) : 0;
    const last = n - 1;
    for (let j = 0; j < last; j++) {
      segment(src, o, j * 3, (j + 1) * 3, bright);
    }
    if (f < 1) {
      segment(src, o, last * 3, 0, bright * (1 - f));
    }
    if (f > 0) {
      segment(src, o, last * 3, n * 3, bright * f);
      segment(src, o, n * 3, 0, bright * f);
    }
  }

  return {
    /** Loops, for tests: each one's control points and echo history. */
    loops: loops as readonly Readonly<Loop>[],

    /** Advances everything by `dt` seconds in a frame `width` / `height` wide. */
    step(dt: number, p: BeziersSettings, frameAspect: number) {
      const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
      aspect = Number.isFinite(frameAspect) && frameAspect > 0 ? frameAspect : 1;
      const targetSpeed = clamp(safe(p.speed, 1), 0, MAX_SPEED) * SPEED_UNIT;
      const targetSegments = clamp(Math.round(safe(p.segments, 2)), 1, MAX_SEGMENTS);
      const targetTrail = clamp(Math.round(safe(p.trail, 0)), 0, MAX_TRAIL);
      const targetCurves = clamp(Math.round(safe(p.curves, 1)), 1, MAX_CURVES);
      const nextSeed = Math.floor(safe(p.seed, 0));
      if (!started) {
        started = true;
        speed = targetSpeed;
        segmentsMix = targetSegments;
        trailMix = targetTrail;
        styleMix = p.style === "modern" ? 1 : 0;
        fade.snap(targetCurves);
        reseed(nextSeed);
        return;
      }

      // A new seed fades the loops out, rebuilds them at the bottom, and fades back in.
      if (nextSeed !== seed) {
        reseedFade = Math.max(0, reseedFade - d / RESEED_FADE);
        if (reseedFade <= 0) {
          // Allocates new loops, only when the seed changes.
          reseed(nextSeed);
        }
      } else {
        reseedFade = Math.min(1, reseedFade + d / RESEED_FADE);
      }

      speed = approach(speed, targetSpeed, SPEED_EASE * d);
      trailMix = approach(trailMix, targetTrail, TRAIL_RATE * d);
      styleMix = approach(styleMix, p.style === "modern" ? 1 : 0, d / STYLE_EASE);
      fade.step(targetCurves, d, CURVE_FADE, CURVE_FADE);

      // A segment that comes back starts folded up on anchor 0, where the loop
      // closes, so the closing curve is unchanged; it unfolds as its points drift.
      const before = segmentsMix;
      segmentsMix = approach(segmentsMix, targetSegments, SEGMENTS_RATE * d);
      for (let j = 1; j < MAX_SEGMENTS; j++) {
        if (before <= j && segmentsMix > j) {
          for (const l of loops) {
            placeBouncePoint(l.points, j * 3, 0);
            placeBouncePoint(l.points, j * 3 + 1, 0);
            placeBouncePoint(l.points, j * 3 + 2, 0);
          }
        }
      }

      const n = takeSteps(clock, ECHO_SIM_RATE, d, MAX_STEPS_PER_FRAME);
      for (let k = 0; k < n; k++) {
        stepSim();
      }
    },

    /**
     * Writes the frame's line pieces into `target` as streaks (`STREAK_FLOATS`
     * each, room for `MAX_STREAKS`) for a `width` × `height` px frame at `scale`
     * px per reference px. Returns the count.
     */
    write(target: Float32Array, width: number, height: number, scale: number): number {
      out = target;
      count = 0;
      inset = Math.min(EDGE_INSET * scale, width / 4, height / 4);
      spanX = width - 2 * inset;
      spanY = height - 2 * inset;
      tolerance = FLATNESS * scale;
      echoLineLook(styleMix, scale, look);
      const phase = Math.min(1, (sinceSample + clock.acc) / interval);
      const t = clock.acc;

      for (let i = 0; i < fade.live; i++) {
        const life = fade.life[i] * reseedFade;
        if (life <= 0) {
          continue;
        }
        const l = loops[i];
        // The newest loop, between the last two steps.
        const pts = l.points;
        for (let j = 0; j < POINTS; j++) {
          head[j * 2] = pts.prevX[j] + (pts.x[j] - pts.prevX[j]) * t;
          head[j * 2 + 1] = pts.prevY[j] + (pts.y[j] - pts.prevY[j]) * t;
        }
        hueRgb(l.hue, look.saturation, now);
        color[0] = now[0];
        color[1] = now[1];
        color[2] = now[2];
        loop(head, 0, segmentsMix, life);

        // The echoes: in Classic, all in the loop's current colour; in Modern, each
        // in the colour it was drawn in, fading with age.
        const d = l.history.data;
        const echoes = Math.min(Math.ceil(trailMix), l.history.count);
        for (let k = 1; k <= echoes; k++) {
          const b = life * echoBrightness(k, trailMix, phase, styleMix);
          if (b <= 0) {
            continue;
          }
          const o = l.history.offset(k - 1);
          echoColor(now, hueRgb(d[o + SAMPLE_HUE], look.saturation, then), styleMix, color);
          loop(d, o, d[o + SAMPLE_SEGMENTS], b);
        }
      }
      return count;
    },
  };
}
