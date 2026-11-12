/**
 * Runs before every Vitest file. Each test starts on fake timers pinned to
 * `TEST_TIME` (in the Vitest config), so nothing in a unit test reads the real clock: `Date`,
 * `performance.now`, `setTimeout` / `setInterval` and `requestAnimationFrame`
 * only move when a test advances them. Effects that show the wall clock (Scenes'
 * clocks and tickers), and loops that work to a time budget (background builds,
 * prewarms), then behave the same on every run and every machine: with the clock
 * standing still, a budgeted loop runs to completion in one call.
 *
 * Tests that call `vi.useFakeTimers()` themselves get the same pinned start, which
 * `test.fakeTimers` in the Vitest config sets for every install. The frame-timing tests (`*.perf.test.ts`)
 * measure real time and have their own config, without this file.
 */
import { afterEach, beforeEach, vi } from "vitest";

// Testing Library's `waitFor` and `findBy*` advance fake time instead of polling on
// real timers when they see a Jest-style global with `advanceTimersByTime`.
Object.assign(globalThis, {
  jest: {
    advanceTimersByTime: (ms: number) => {
      vi.advanceTimersByTime(ms);
    },
  },
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});
