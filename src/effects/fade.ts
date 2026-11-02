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
  for (let i = live; i < target; i++) life[i] = 0;
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
  while (live > target && life[live - 1] <= 0) live--;
  return live;
}
