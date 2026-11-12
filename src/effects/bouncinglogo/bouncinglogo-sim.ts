/**
 * The Bouncing Logo's motion: a box drifting at 45 degrees inside the canvas,
 * reflecting off each edge, with an optional planner that nudges one axis's
 * speed so the box reaches a corner exactly every so often.
 *
 * Positions are the box's top-left corner within the free space (the canvas
 * minus the box), in reference px (1080 tall). The motion is measured as path
 * length `s`: each axis moves `rate * s`, where the rates are 1 except while a
 * planned corner is under way. Speed changes therefore never disturb a plan.
 */
import { createRng } from "../noise";
import type { BouncingLogoCorners } from "./bouncinglogo.meta";

/** The speed the corner windows are stated at, reference px per second. */
export const REFERENCE_SPEED = 90;

/**
 * Seconds between corner hits that "Sometimes" and "Often" aim for, at
 * REFERENCE_SPEED or faster. Slower speeds stretch the window, so the logo's
 * travel between corners stays the same.
 */
export const CORNER_WINDOWS = {
  sometimes: [120, 300],
  often: [30, 60],
} as const satisfies Record<Exclude<BouncingLogoCorners, "natural">, readonly [number, number]>;

/**
 * Most the planner changes one axis's speed by, as a fraction. Plans start only
 * at a bounce, where the direction flips anyway, so the slight change of angle
 * hides in the reflection: 45 to 45.6 degrees for "Sometimes". "Often" needs
 * more room to find a corner within its shorter window, up to 47.3 degrees.
 */
export const PLAN_RATE_CAPS = {
  sometimes: 0.02,
  often: 0.08,
} as const satisfies Record<keyof typeof CORNER_WINDOWS, number>;

/** Axes with less free space than this (reference px) stay centred and never bounce. */
const MIN_FREE = 8;
/** Two edge hits this close (reference px of path) count as one corner hit. */
const CORNER_TOLERANCE = 1;
/** Bounces handled one by one per step; past that a long gap folds in one go. */
const MAX_EVENTS_PER_STEP = 64;
/** Most arrivals the planner looks at per axis and pass. */
const MAX_PLAN_ARRIVALS = 256;
/** Window-length stretches of path the planner searches before giving up until the next bounce. */
const PLAN_PASSES = 4;

/**
 * The colour cycles, in order: the logo takes the next colour on every bounce.
 * Neighbours (the last and first included) always differ, so a bounce always
 * changes the colour.
 */
export const LOGO_PALETTES = {
  // Magenta, cyan, yellow, green, orange, blue, purple.
  classic: ["#ff2bd6", "#00e1ff", "#ffe500", "#3dff5a", "#ff8a00", "#2f6bff", "#a23dff"],
  pastel: ["#ffa8ec", "#a8f1ff", "#fff3a3", "#b5ffbe", "#ffcc9a", "#abc3ff", "#d6b3ff"],
} as const;

/** The palette entry for the colour after `bounces` bounces, of `n` colours. */
export function paletteIndex(bounces: number, n: number): number {
  return n > 0 ? ((bounces % n) + n) % n : 0;
}

/** Most of the canvas width the logo may take, so a narrow canvas still leaves room to drift. */
const MAX_WIDTH_FRACTION = 0.8;

/**
 * Height of the logo's box in reference px: `size` of the canvas height, shrunk
 * if need be so it is at most MAX_WIDTH_FRACTION of the canvas width. `aspect`
 * is the canvas's width / height and `logoAspect` the logo's.
 */
export function logoHeight(size: number, aspect: number, logoAspect: number): number {
  const h = Math.max(0, size) * 1080;
  return logoAspect > 0 ? Math.min(h, (MAX_WIDTH_FRACTION * 1080 * aspect) / logoAspect) : h;
}

interface LogoSim {
  /** Top-left of the box within the free space, reference px. */
  readonly x: number;
  readonly y: number;
  /** Direction of travel per axis, +1 or -1. */
  readonly dirX: number;
  readonly dirY: number;
  /** Speed multiplier per axis, within the mode's PLAN_RATE_CAPS of 1. */
  readonly rateX: number;
  readonly rateY: number;
  /** Advances by one on every bounce, corner hits included. */
  readonly bounces: number;
  /** Corner hits so far. */
  readonly corners: number;
  /** Corner hits in the last `step`. */
  readonly lastCorners: number;
  /** Whether a planned corner is under way. */
  readonly planned: boolean;
  /**
   * Sets the free space (canvas minus box, reference px), keeping the box's
   * position as a fraction of it and its direction. Drops any plan: the next
   * bounce makes a new one.
   */
  setBounds: (freeW: number, freeH: number) => void;
  /** How often to aim for corners. Takes effect from the next bounce. */
  setMode: (mode: BouncingLogoCorners) => void;
  /**
   * Moves `speed` reference px per second for `dt` seconds (any length), and
   * returns the bounces on the way.
   */
  step: (dt: number, speed: number) => number;
  /** Places the box from `seed`: start position and direction. Keeps the counts. */
  reset: (seed: number) => void;
}

/** Distance to the edge ahead on one axis, or Infinity when the axis is locked. */
function ahead(pos: number, dir: number, free: number): number {
  if (free < MIN_FREE) {
    return Infinity;
  }
  return dir > 0 ? free - pos : pos;
}

/** Folds `pos` moved `d` along an axis of free space `free`; returns the new position. */
function fold(pos: number, dir: number, free: number, d: number): number {
  const span = 2 * free;
  const u = (dir > 0 ? pos : span - pos) + d;
  const w = u - Math.floor(u / span) * span;
  return w <= free ? w : span - w;
}

/** The direction after `fold` (same arguments). */
function foldDir(pos: number, dir: number, free: number, d: number): number {
  const span = 2 * free;
  const u = (dir > 0 ? pos : span - pos) + d;
  const w = u - Math.floor(u / span) * span;
  return w < free ? 1 : -1;
}

export function createLogoSim(
  seed: number,
  freeW: number,
  freeH: number,
  initialMode: BouncingLogoCorners,
  initialSpeed = REFERENCE_SPEED,
): LogoSim {
  let fw = freeW;
  let fh = freeH;
  let x = 0;
  let y = 0;
  let dirX = 1;
  let dirY = 1;
  let rateX = 1;
  let rateY = 1;
  let bounces = 0;
  let corners = 0;
  let lastCorners = 0;
  let planned = false;
  /** Path length (on the `since` clock) at which the planned corner is due. */
  let planEnd = 0;
  /** Set when the mode changes, so the next bounce plans afresh. */
  let stale = false;
  let mode = initialMode;
  /** Path length since the last corner hit (or the start). */
  let since = 0;
  /** The speed the windows are scaled by, latched per step. */
  let windowSpeed = initialSpeed;
  let rng = createRng(seed);

  const lockAxes = () => {
    if (fw < MIN_FREE) {
      x = fw / 2;
    }
    if (fh < MIN_FREE) {
      y = fh / 2;
    }
  };

  /**
   * Aims for a corner by changing one axis's rate (the other stays at 1): every
   * pair of edge arrivals that the cap can bring together within the window is a
   * candidate, and one is picked at random. With none, the next stretch of path
   * as long as the window is searched, and so on. Once the window has passed, the
   * search starts from here.
   */
  const plan = () => {
    rateX = 1;
    rateY = 1;
    planned = false;
    stale = false;
    if (mode === "natural" || fw < MIN_FREE || fh < MIN_FREE) {
      return;
    }
    const [wMin, wMax] = CORNER_WINDOWS[mode];
    const cap = PLAN_RATE_CAPS[mode];
    const k = Math.max(windowSpeed, REFERENCE_SPEED);
    const span = (wMax - wMin) * k;
    let lo = Math.max(0, wMin * k - since);
    let hi = wMax * k - since;
    if (hi <= 0) {
      lo = 0;
      hi = span;
    }
    const ax = ahead(x, dirX, fw);
    const ay = ahead(y, dirY, fh);
    let count = 0;
    for (let pass = 0; pass < PLAN_PASSES && count === 0; pass++) {
      // Adjust x to meet a y arrival (axis 0), then y to meet an x arrival.
      for (let axis = 0; axis < 2; axis++) {
        const fixedFirst = axis === 0 ? ay : ax;
        const fixedSpan = axis === 0 ? fh : fw;
        const movedFirst = axis === 0 ? ax : ay;
        const movedSpan = axis === 0 ? fw : fh;
        const first = Math.max(0, Math.ceil((lo - fixedFirst) / fixedSpan));
        for (let m = first; m < first + MAX_PLAN_ARRIVALS; m++) {
          const s = fixedFirst + m * fixedSpan;
          if (s > hi) {
            break;
          }
          if (s <= 0) {
            continue;
          }
          const jLo = Math.max(0, Math.ceil((s * (1 - cap) - movedFirst) / movedSpan));
          const jHi = Math.floor((s * (1 + cap) - movedFirst) / movedSpan);
          for (let j = jLo; j <= jHi; j++) {
            const rate = (movedFirst + j * movedSpan) / s;
            if (Math.abs(rate - 1) > cap) {
              continue;
            }
            count++;
            if (rng() * count < 1) {
              rateX = axis === 0 ? rate : 1;
              rateY = axis === 0 ? 1 : rate;
              planned = true;
              planEnd = since + s;
            }
          }
        }
      }
      lo = hi;
      hi += span;
    }
  };

  /**
   * Places the box from seed `s`. With a corner mode, the start is traced back
   * from a corner by a distance within the window, so the first corner hit comes
   * on time without any plan; "Natural" starts anywhere.
   */
  const reset = (s: number) => {
    rng = createRng(s);
    rateX = 1;
    rateY = 1;
    planned = false;
    since = 0;
    const fx = rng();
    const fy = rng();
    dirX = rng() < 0.5 ? -1 : 1;
    dirY = rng() < 0.5 ? -1 : 1;
    if (mode === "natural") {
      x = fw * fx;
      y = fh * fy;
    } else {
      // Run back from the corner the box is heading for.
      const [wMin, wMax] = CORNER_WINDOWS[mode];
      const d = (wMin + (wMax - wMin) * fx) * Math.max(windowSpeed, REFERENCE_SPEED);
      const cx = dirX > 0 ? fw : 0;
      const cy = dirY > 0 ? fh : 0;
      x = fold(cx, -dirX, fw, d);
      y = fold(cy, -dirY, fh, d);
      const bx = -foldDir(cx, -dirX, fw, d);
      const by = -foldDir(cy, -dirY, fh, d);
      dirX = bx;
      dirY = by;
      planned = fw >= MIN_FREE && fh >= MIN_FREE;
      planEnd = d;
    }
    lockAxes();
  };

  const step = (dt: number, speed: number): number => {
    lastCorners = 0;
    if (!(dt > 0) || !(speed > 0) || !Number.isFinite(dt * speed)) {
      return 0;
    }
    windowSpeed = speed;
    let left = dt * speed;
    let n = 0;
    while (left > 0) {
      const tx = ahead(x, dirX, fw) / rateX;
      const ty = ahead(y, dirY, fh) / rateY;
      const t = Math.min(tx, ty);
      if (t > left) {
        break;
      }
      if (n >= MAX_EVENTS_PER_STEP) {
        // A long gap: fold the rest in one go and count it as one bounce.
        if (fw >= MIN_FREE) {
          const d = rateX * left;
          const nx = fold(x, dirX, fw, d);
          dirX = foldDir(x, dirX, fw, d);
          x = nx;
        }
        if (fh >= MIN_FREE) {
          const d = rateY * left;
          const ny = fold(y, dirY, fh, d);
          dirY = foldDir(y, dirY, fh, d);
          y = ny;
        }
        since += left;
        left = 0;
        bounces++;
        n++;
        plan();
        return n;
      }
      const corner = Math.abs(tx - ty) <= CORNER_TOLERANCE;
      left -= t;
      since += t;
      if (tx === t || corner) {
        x = dirX > 0 ? fw : 0;
        dirX = -dirX;
      } else if (fw >= MIN_FREE) {
        x += dirX * rateX * t;
      }
      if (ty === t || corner) {
        y = dirY > 0 ? fh : 0;
        dirY = -dirY;
      } else if (fh >= MIN_FREE) {
        y += dirY * rateY * t;
      }
      bounces++;
      n++;
      if (corner) {
        corners++;
        lastCorners++;
        since = 0;
        plan();
      } else if (!planned || stale || since > planEnd + CORNER_TOLERANCE) {
        plan();
      }
    }
    if (left > 0) {
      if (fw >= MIN_FREE) {
        x += dirX * rateX * left;
      }
      if (fh >= MIN_FREE) {
        y += dirY * rateY * left;
      }
      since += left;
    }
    return n;
  };

  reset(seed);

  return {
    get x() {
      return x;
    },
    get y() {
      return y;
    },
    get dirX() {
      return dirX;
    },
    get dirY() {
      return dirY;
    },
    get rateX() {
      return rateX;
    },
    get rateY() {
      return rateY;
    },
    get bounces() {
      return bounces;
    },
    get corners() {
      return corners;
    },
    get lastCorners() {
      return lastCorners;
    },
    get planned() {
      return planned;
    },
    setBounds(w, h) {
      if (w === fw && h === fh) {
        return;
      }
      const fx = fw >= MIN_FREE ? x / fw : 0.5;
      const fy = fh >= MIN_FREE ? y / fh : 0.5;
      fw = w;
      fh = h;
      x = Math.min(Math.max(fx, 0), 1) * fw;
      y = Math.min(Math.max(fy, 0), 1) * fh;
      rateX = 1;
      rateY = 1;
      planned = false;
      lockAxes();
    },
    setMode(m) {
      if (m !== mode) {
        mode = m;
        stale = true;
      }
    },
    step,
    reset,
  };
}
