import type { Rgb } from "../color";
import { createCountFade } from "../fade";
import { approach, clamp } from "../math";
import { MAX_PATTERN_HZ } from "../motion-limits";
import { createRng } from "../noise";
import { takeSteps, type StepClock } from "../step-clock";
import { STREAK_FLOATS } from "../streaks";
import {
  createBouncePoints,
  placeBouncePoint,
  stepBouncePoints,
  type BouncePoints,
} from "../bounce-points";
import { createEchoRing, type EchoRing } from "../echo-ring";
import {
  MAX_POINTS,
  MAX_SHAPES,
  MAX_SPEED,
  MAX_TRAIL,
  MIN_POINTS,
  type MystifyMirror,
} from "./mystify.meta";

/**
 * Mystify's simulation and line layout: `MAX_SHAPES` polygons of up to
 * `MAX_POINTS` bouncing corners each, stepped at a fixed rate, with a history of
 * past outlines sampled every few steps for the echo trail. `write` lays out the
 * frame's lines as streaks for one instanced draw.
 *
 * Every shape and every corner is always simulated, so changing the counts only
 * changes what is drawn: shapes fade in and out, a new corner splits off its
 * neighbour (and so appears without a jump), and a removed corner's two edges
 * cross-fade to the single edge that replaces them.
 */

/** Simulation steps per second. */
export const SIM_RATE = 60;
/** Most steps run in one frame; the rest are dropped rather than caught up. */
const MAX_STEPS_PER_FRAME = 8;

/** Frame heights per second per unit of the `speed` slider. */
export const SPEED_UNIT = 0.1;
/** How fast the speed eases to a new slider value, frame heights per second per second. */
const SPEED_EASE = 0.25;

/**
 * Echoes are sampled about this far apart (frame heights) along a corner's path,
 * as in the original, where a fan of evenly spaced outlines traces each shape.
 */
const ECHO_SPACING = 0.03;
/**
 * Steps between echoes, at least: each echo passes a screen point after the one
 * before, so their interval sets the trail's flicker rate, held under the codec's
 * pattern limit.
 */
export const MIN_ECHO_STEPS = Math.ceil(SIM_RATE / MAX_PATTERN_HZ) + 3;
/** At most: at the slowest speeds, echoes bunch closer rather than lag for seconds. */
const MAX_ECHO_STEPS = 90;

/** Each shape's colour goes round the hue wheel once in this many seconds. */
const HUE_PERIOD = 45;

/** Seconds for a shape to fade in or out when the shape count changes. */
const SHAPE_FADE = 0.8;
/** Corners per second added or removed while the corner count eases to a new value. */
const POINTS_RATE = 1.5;
/** Echoes per second added or removed while the echo count eases. */
const TRAIL_RATE = 8;
/** Seconds to cross between styles, or to show or hide a mirrored copy. */
const STYLE_EASE = 1;
const MIRROR_EASE = 1;
/** Seconds the shapes take to fade out (and back in) when the seed changes. */
const RESEED_FADE = 0.6;

/** Line half widths in reference px: Classic's crisp 1 px-like line, and Modern's. */
const CLASSIC_HALF_WIDTH = 0.75;
const MODERN_HALF_WIDTH = 1;
/** Modern's glow: a wider, dimmer line under each line. */
const GLOW_HALF_WIDTH = 4;
const GLOW_BRIGHTNESS = 0.22;
/** Colour saturation in each style: the pure spectrum, and a slightly softer one. */
const CLASSIC_SATURATION = 1;
const MODERN_SATURATION = 0.8;
/** Reference px kept clear at the frame's edges, so the lines aren't clipped. */
const EDGE_INSET = 2;

/** Floats per history sample: every corner's x and y, then the corner count and the hue. */
const SAMPLE_STRIDE = MAX_POINTS * 2 + 2;
const SAMPLE_POINTS = MAX_POINTS * 2;
const SAMPLE_HUE = MAX_POINTS * 2 + 1;

/** Mirrored copies: none, left–right, top–bottom and both. */
const COPIES = 4;
/** Edges per outline: every corner's, plus one more while a corner cross-fades. */
const EDGES = MAX_POINTS + 1;
/** Streaks `write` can produce: a line and a glow per edge of every outline. */
export const MAX_STREAKS = MAX_SHAPES * (MAX_TRAIL + 1) * EDGES * COPIES * 2;

/** The params the simulation reads; the effect passes its params object. */
interface MystifySettings {
  style: string;
  shapes: number;
  points: number;
  trail: number;
  speed: number;
  mirror: string;
  seed: number;
}

interface Shape {
  points: BouncePoints;
  rng: () => number;
  hue: number;
  history: EchoRing;
}

/** Steps between echoes at `speed` frame heights per second. */
export function echoSteps(speed: number): number {
  const perStep = Math.max(speed, 1e-6) / SIM_RATE;
  return clamp(Math.round(ECHO_SPACING / perStep), MIN_ECHO_STEPS, MAX_ECHO_STEPS);
}

/** One channel of an HSV colour: `n` is 5 for red, 3 for green, 1 for blue. */
function hsvChannel(n: number, h: number, s: number): number {
  const k = (n + (h - Math.floor(h)) * 6) % 6;
  return 1 - s * Math.max(0, Math.min(k, 4 - k, 1));
}

function hueRgb(h: number, s: number, out: Rgb): Rgb {
  out[0] = hsvChannel(5, h, s);
  out[1] = hsvChannel(3, h, s);
  out[2] = hsvChannel(1, h, s);
  return out;
}

const isMirrored = (mirror: string, axis: "horizontal" | "vertical") =>
  mirror === axis || mirror === ("both" satisfies MystifyMirror);

const safe = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

export function createMystify() {
  const shapes: Shape[] = [];
  for (let i = 0; i < MAX_SHAPES; i++) {
    shapes.push({
      points: createBouncePoints(MAX_POINTS, createRng(i)),
      rng: createRng(i),
      hue: 0,
      history: createEchoRing(MAX_TRAIL, SAMPLE_STRIDE),
    });
  }
  const fade = createCountFade(MAX_SHAPES);
  const clock: StepClock = { acc: 0 };

  let seed = Number.NaN;
  /** Fade for a seed change: the shapes dip out, are rebuilt, and come back. */
  let reseedFade = 1;
  let started = false;
  let speed = 0;
  let pointsMix = MIN_POINTS;
  let trailMix = 0;
  let styleMix = 0;
  let mirrorX = 0;
  let mirrorY = 0;
  /** Steps since the newest echo was sampled, and the current steps between echoes. */
  let sinceSample = 0;
  let interval = MIN_ECHO_STEPS;
  /** Simulated seconds, for the hue drift. */
  let time = 0;
  let aspect = 16 / 9;

  /** Shape `i`'s hue, in turns: spread out per shape and seed, drifting with time. */
  const shapeHue = (i: number) => (seed * 0.618034 + i * 0.37 + time / HUE_PERIOD) % 1;

  function sample() {
    for (const s of shapes) {
      const o = s.history.push();
      const d = s.history.data;
      for (let j = 0; j < MAX_POINTS; j++) {
        d[o + j * 2] = s.points.x[j];
        d[o + j * 2 + 1] = s.points.y[j];
      }
      d[o + SAMPLE_POINTS] = pointsMix;
      d[o + SAMPLE_HUE] = s.hue;
    }
    sinceSample = 0;
  }

  function stepSim() {
    time += 1 / SIM_RATE;
    for (let i = 0; i < MAX_SHAPES; i++) {
      const s = shapes[i];
      stepBouncePoints(s.points, 1 / SIM_RATE, speed, aspect, s.rng);
      s.hue = shapeHue(i);
    }
    sinceSample++;
    interval = echoSteps(speed);
    if (sinceSample >= interval) {
      sample();
    }
  }

  /** Rebuilds the shapes for `seed` and runs the sim long enough to fill the trail. */
  function reseed(next: number) {
    seed = next;
    time = 0;
    for (let i = 0; i < MAX_SHAPES; i++) {
      const base = Math.floor(next) * MAX_SHAPES + i;
      const s = shapes[i];
      s.points = createBouncePoints(MAX_POINTS, createRng(base * 2 + 1));
      s.rng = createRng(base * 2 + 2);
      s.hue = shapeHue(i);
      s.history.clear();
    }
    clock.acc = 0;
    sample();
    while (shapes[0].history.count < MAX_TRAIL) {
      stepSim();
    }
  }

  // Layout state for `write`, shared with its helpers so drawing allocates nothing.
  const head = new Float32Array(SAMPLE_POINTS);
  const now: Rgb = [0, 0, 0];
  const then: Rgb = [0, 0, 0];
  const color: Rgb = [0, 0, 0];
  let out: Float32Array = new Float32Array(0);
  let count = 0;
  let inset = 0;
  let spanX = 1;
  let spanY = 1;
  let halfWidth = 1;
  let glowWidth = 1;
  let glow = 0;

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

  /** Appends the edge from corner `a` to corner `b` of the outline at `o` in `src`, in mirrored copy `copy`. */
  function edge(src: Float32Array, o: number, a: number, b: number, bright: number, copy: number) {
    const ax = src[o + a * 2];
    const ay = src[o + a * 2 + 1];
    const bx = src[o + b * 2];
    const by = src[o + b * 2 + 1];
    const fx = copy & 1;
    const fy = copy >> 1;
    const x0 = inset + (fx ? 1 - ax : ax) * spanX;
    const y0 = inset + (fy ? 1 - ay : ay) * spanY;
    const x1 = inset + (fx ? 1 - bx : bx) * spanX;
    const y1 = inset + (fy ? 1 - by : by) * spanY;
    put(x0, y0, x1, y1, bright, halfWidth);
    if (glow > 0) {
      put(x0, y0, x1, y1, bright * glow, glowWidth);
    }
  }

  /**
   * Draws the outline at `o` in `src` (normalised corners) with `mix` corners
   * (fractional while one cross-fades) at brightness `bright`, in each mirrored copy.
   */
  function outline(src: Float32Array, o: number, mix: number, bright: number) {
    const n = Math.min(MAX_POINTS, Math.max(MIN_POINTS, Math.floor(mix)));
    const f = n < MAX_POINTS ? clamp(mix - n, 0, 1) : 0;
    const last = n - 1;
    for (let c = 0; c < COPIES; c++) {
      const b = bright * (c & 1 ? mirrorX : 1) * (c >> 1 ? mirrorY : 1);
      if (b <= 0) {
        continue;
      }
      for (let j = 0; j < last; j++) {
        edge(src, o, j, j + 1, b, c);
      }
      if (f < 1) {
        edge(src, o, last, 0, b * (1 - f), c);
      }
      if (f > 0) {
        edge(src, o, last, n, b * f, c);
        edge(src, o, n, 0, b * f, c);
      }
    }
  }

  return {
    /** Shapes, for tests: each one's corners and echo history. */
    shapes: shapes as readonly Readonly<Shape>[],

    /** Advances everything by `dt` seconds in a frame `width` / `height` wide. */
    step(dt: number, p: MystifySettings, frameAspect: number) {
      const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
      aspect = Number.isFinite(frameAspect) && frameAspect > 0 ? frameAspect : 1;
      const targetSpeed = clamp(safe(p.speed, 1), 0, MAX_SPEED) * SPEED_UNIT;
      const targetPoints = clamp(Math.round(safe(p.points, 4)), MIN_POINTS, MAX_POINTS);
      const targetTrail = clamp(Math.round(safe(p.trail, 0)), 0, MAX_TRAIL);
      const targetShapes = clamp(Math.round(safe(p.shapes, 1)), 1, MAX_SHAPES);
      const nextSeed = Math.floor(safe(p.seed, 0));
      if (!started) {
        started = true;
        speed = targetSpeed;
        pointsMix = targetPoints;
        trailMix = targetTrail;
        styleMix = p.style === "modern" ? 1 : 0;
        mirrorX = isMirrored(p.mirror, "horizontal") ? 1 : 0;
        mirrorY = isMirrored(p.mirror, "vertical") ? 1 : 0;
        fade.snap(targetShapes);
        reseed(nextSeed);
        return;
      }

      // A new seed fades the shapes out, rebuilds them at the bottom, and fades back in.
      if (nextSeed !== seed) {
        reseedFade = Math.max(0, reseedFade - d / RESEED_FADE);
        if (reseedFade <= 0) {
          // Allocates new shapes, only when the seed changes.
          reseed(nextSeed);
        }
      } else {
        reseedFade = Math.min(1, reseedFade + d / RESEED_FADE);
      }

      speed = approach(speed, targetSpeed, SPEED_EASE * d);
      trailMix = approach(trailMix, targetTrail, TRAIL_RATE * d);
      styleMix = approach(styleMix, p.style === "modern" ? 1 : 0, d / STYLE_EASE);
      mirrorX = approach(mirrorX, isMirrored(p.mirror, "horizontal") ? 1 : 0, d / MIRROR_EASE);
      mirrorY = approach(mirrorY, isMirrored(p.mirror, "vertical") ? 1 : 0, d / MIRROR_EASE);
      fade.step(targetShapes, d, SHAPE_FADE, SHAPE_FADE);

      // A corner that comes back starts where its neighbour is, so it splits off
      // that corner rather than jumping in.
      const before = pointsMix;
      pointsMix = approach(pointsMix, targetPoints, POINTS_RATE * d);
      for (let j = MIN_POINTS; j < MAX_POINTS; j++) {
        if (before <= j && pointsMix > j) {
          for (const s of shapes) {
            placeBouncePoint(s.points, j, j - 1);
          }
        }
      }

      const n = takeSteps(clock, SIM_RATE, d, MAX_STEPS_PER_FRAME);
      for (let k = 0; k < n; k++) {
        stepSim();
      }
    },

    /**
     * Writes the frame's lines into `target` as streaks (`STREAK_FLOATS` each, room
     * for `MAX_STREAKS`) for a `width` × `height` px frame at `scale` px per
     * reference px. Returns the count.
     */
    write(target: Float32Array, width: number, height: number, scale: number): number {
      out = target;
      count = 0;
      inset = Math.min(EDGE_INSET * scale, width / 4, height / 4);
      spanX = width - 2 * inset;
      spanY = height - 2 * inset;
      halfWidth =
        (CLASSIC_HALF_WIDTH + (MODERN_HALF_WIDTH - CLASSIC_HALF_WIDTH) * styleMix) * scale;
      glowWidth = GLOW_HALF_WIDTH * scale;
      glow = GLOW_BRIGHTNESS * styleMix;
      const saturation = CLASSIC_SATURATION + (MODERN_SATURATION - CLASSIC_SATURATION) * styleMix;
      const phase = Math.min(1, (sinceSample + clock.acc) / interval);
      const t = clock.acc;

      for (let i = 0; i < fade.live; i++) {
        const life = fade.life[i] * reseedFade;
        if (life <= 0) {
          continue;
        }
        const s = shapes[i];
        // The newest outline, between the last two steps.
        const pts = s.points;
        for (let j = 0; j < MAX_POINTS; j++) {
          head[j * 2] = pts.prevX[j] + (pts.x[j] - pts.prevX[j]) * t;
          head[j * 2 + 1] = pts.prevY[j] + (pts.y[j] - pts.prevY[j]) * t;
        }
        hueRgb(s.hue, saturation, now);
        color[0] = now[0];
        color[1] = now[1];
        color[2] = now[2];
        outline(head, 0, pointsMix, life);

        // The echoes: in Classic, all in the shape's current colour; in Modern, each
        // in the colour it was drawn in, fading with age.
        const d = s.history.data;
        const echoes = Math.min(Math.ceil(trailMix), s.history.count);
        for (let k = 1; k <= echoes; k++) {
          const weight = clamp(trailMix - k + 1, 0, 1);
          const age = Math.max(0, 1 - (k - 1 + phase) / Math.max(trailMix, 1));
          const b = life * weight * (1 + (age - 1) * styleMix);
          if (b <= 0) {
            continue;
          }
          const o = s.history.offset(k - 1);
          hueRgb(d[o + SAMPLE_HUE], saturation, then);
          color[0] = now[0] + (then[0] - now[0]) * styleMix;
          color[1] = now[1] + (then[1] - now[1]) * styleMix;
          color[2] = now[2] + (then[2] - now[2]) * styleMix;
          outline(d, o, d[o + SAMPLE_POINTS], b);
        }
      }
      return count;
    },
  };
}
