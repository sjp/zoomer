import { smoothstep, wrap } from "./math";

/**
 * Count fades: when a count param rises, the added items start at life 0 and fade
 * in; when it falls, the removed items fade out before they stop being simulated,
 * so a slider drag never pops items in or out. `life[i]` is item `i`'s fade factor
 * in [0, 1]. An effect keeps a `live` count (items to simulate and draw: the
 * target plus any still fading out) and, each frame:
 *
 * ```ts
 * live = growLive(life, live, target);
 * for (let i = 0; i < live; i++) { ...; const l = stepLife(life, i, target, inStep, outStep); ... }
 * live = trimLive(life, live, target);
 * ```
 *
 * All three allocate nothing.
 */

/** Seconds an item removed by a lower count takes to fade out. */
export const FADE_OUT = 0.6;

/**
 * Starts a frame for `target` items: items newly added beyond the live range start
 * at life 0. Returns the new live count, at least `target`.
 */
export function growLive(life: Float32Array, live: number, target: number): number {
  for (let i = live; i < target; i++) {
    life[i] = 0;
  }
  return live > target ? live : target;
}

/**
 * Steps item `i`'s life by `inStep` towards 1 while it is wanted (`i < target`),
 * or by `outStep` towards 0 once it is not. Returns the new life.
 */
export function stepLife(
  life: Float32Array,
  i: number,
  target: number,
  inStep: number,
  outStep: number,
): number {
  const l = i < target ? Math.min(1, life[i] + inStep) : Math.max(0, life[i] - outStep);
  life[i] = l;
  return l;
}

/** Drops fully faded-out items from the top of the live range. Returns the new live count. */
export function trimLive(life: Float32Array, live: number, target: number): number {
  while (live > target && life[live - 1] <= 0) {
    live--;
  }
  return live;
}

/** A count fade over a fixed capacity, stepping only while something is fading. */
interface CountFade {
  /** Each item's fade factor in [0, 1]; items `live` and above are gone. */
  readonly life: Float32Array;
  /** Items to simulate and draw: the target plus any still fading out. */
  readonly live: number;
  /**
   * Steps the fades by `dt` seconds towards `target` items (clamped to the
   * capacity), added items fading in over `fadeIn` seconds and removed ones out
   * over `fadeOut`. Returns whether `life` or `live` changed, so the caller
   * knows to rewrite its instances; once everything has settled it returns
   * false and does no work until the target changes.
   */
  step: (target: number, dt: number, fadeIn: number, fadeOut?: number) => boolean;
  /** Shows `target` items at once, fully, without fading: for a fresh layout. */
  snap: (target: number) => void;
}

export function createCountFade(capacity: number): CountFade {
  const life = new Float32Array(capacity);
  let live = 0;
  let wanted = 0;
  let settled = true;
  const clampTarget = (target: number) =>
    Math.max(0, Math.min(capacity, Number.isFinite(target) ? Math.floor(target) : 0));
  return {
    life,
    get live() {
      return live;
    },
    step(target, dt, fadeIn, fadeOut = FADE_OUT) {
      const t = clampTarget(target);
      if (t !== wanted) {
        wanted = t;
        settled = false;
      }
      if (settled) {
        return false;
      }
      const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
      const inStep = fadeIn > 0 ? d / fadeIn : 1;
      const outStep = fadeOut > 0 ? d / fadeOut : 1;
      live = growLive(life, live, t);
      let done = true;
      for (let i = 0; i < live; i++) {
        const l = stepLife(life, i, t, inStep, outStep);
        if (i < t ? l < 1 : l > 0) {
          done = false;
        }
      }
      live = trimLive(life, live, t);
      settled = done && live === t;
      return true;
    },
    snap(target) {
      const t = clampTarget(target);
      life.fill(1, 0, t);
      live = t;
      wanted = t;
      settled = true;
    },
  };
}

/**
 * Moves point `i` by (`dx`, `dy`) and wraps it into `[minX, minX + spanX) ×
 * [minY, minY + spanY)`, typically the frame plus a margin, so the jump happens
 * off-screen. Returns whether it wrapped: if the margin shrinks (with a size
 * param, say), a wrap can land a point on-screen, so the caller should fade it
 * in again by setting its life to 0.
 */
export function driftPoint(
  xs: Float32Array,
  ys: Float32Array,
  i: number,
  dx: number,
  dy: number,
  minX: number,
  minY: number,
  spanX: number,
  spanY: number,
): boolean {
  const x = xs[i] + dx;
  const y = ys[i] + dy;
  const wx = wrap(x, minX, spanX);
  const wy = wrap(y, minY, spanY);
  xs[i] = wx;
  ys[i] = wy;
  return wx !== x || wy !== y;
}

/**
 * A fade-through: fades something out over `half` seconds, lets the caller swap
 * it at the bottom, then fades it back in over `half` seconds. Each frame:
 *
 * ```ts
 * if (swap.idle && wantsChange) { swap.start(); }
 * if (swap.step(dt)) { ...swap now, while it is invisible... }
 * draw(swap.alpha);
 * ```
 *
 * Allocates nothing.
 */
interface FadeThrough {
  /** Neither fading out nor in. */
  readonly idle: boolean;
  /** Fading out, before the swap. */
  readonly fadingOut: boolean;
  /** The eased opacity: 1 while idle, smoothstepping down to 0 and back up. */
  readonly alpha: number;
  /** Starts fading out (from the top, whatever the phase). */
  start: () => void;
  /** Stops at once, fully shown. */
  cancel: () => void;
  /**
   * Steps by `dt` seconds. Returns true on the frame the fade-out ends: the
   * caller swaps then, and the fade-in starts from the next step.
   */
  step: (dt: number) => boolean;
}

export function createFadeThrough(half: number): FadeThrough {
  /** 0 idle, 1 fading out, 2 fading in. */
  let phase = 0;
  let t = 0;
  return {
    get idle() {
      return phase === 0;
    },
    get fadingOut() {
      return phase === 1;
    },
    get alpha() {
      return phase === 1 ? 1 - smoothstep(0, 1, t) : phase === 2 ? smoothstep(0, 1, t) : 1;
    },
    start() {
      phase = 1;
      t = 0;
    },
    cancel() {
      phase = 0;
    },
    step(dt) {
      if (phase === 1) {
        t = Math.min(1, t + dt / half);
        if (t >= 1) {
          phase = 2;
          t = 0;
          return true;
        }
      } else if (phase === 2) {
        t = Math.min(1, t + dt / half);
        if (t >= 1) {
          phase = 0;
        }
      }
      return false;
    },
  };
}

/**
 * Two slots crossfading one change at a time: `current` is shown; on a change
 * the caller fills `next` and calls `start`, then `next` fades in over
 * `seconds` (`mix` rising linearly from 0 to 1). When it is fully in, the old
 * slot is handed to `release` (to free its textures), the slots swap and the
 * fade goes idle. Each frame:
 *
 * ```ts
 * if (!fade.fading && changed) { fill(fade.next); fade.start(); }
 * fade.step(dt);
 * draw(fade.current, 1);
 * if (fade.fading) { draw(fade.next, fade.mix); }
 * ```
 *
 * Allocates nothing per frame.
 */
interface CrossfadeSlots<S> {
  /** The slot shown; while fading, the outgoing one. */
  readonly current: S;
  /** The other slot: the incoming one while fading, free otherwise. */
  readonly next: S;
  /** Whether `next` is fading in over `current`. */
  readonly fading: boolean;
  /** How far the fade has got, linear in [0, 1]; 0 while idle. */
  readonly mix: number;
  /** Starts fading `next` in from 0 (the caller has filled it). Ignored while fading. */
  start: () => void;
  /**
   * Steps the fade by `dt` seconds. On the step it completes, releases the old
   * slot, makes `next` current and goes idle (`mix` back to 0).
   */
  step: (dt: number) => void;
}

export function createCrossfadeSlots<S>(
  slots: readonly [S, S],
  seconds: number,
  release: (slot: S) => void,
): CrossfadeSlots<S> {
  let current = 0;
  let mix = 0;
  let fading = false;
  return {
    get current() {
      return slots[current];
    },
    get next() {
      return slots[1 - current];
    },
    get fading() {
      return fading;
    },
    get mix() {
      return mix;
    },
    start() {
      if (!fading) {
        fading = true;
        mix = 0;
      }
    },
    step(dt) {
      if (!fading) {
        return;
      }
      const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
      mix = seconds > 0 ? Math.min(1, mix + d / seconds) : 1;
      if (mix >= 1) {
        release(slots[current]);
        current = 1 - current;
        fading = false;
        mix = 0;
      }
    },
  };
}
