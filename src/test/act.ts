// oxlint-disable-next-line no-restricted-imports -- the one place that wraps it
import { act as preactAct } from "@testing-library/preact";

/**
 * Testing Library's `act`, typed by what its callback returns.
 *
 * Preact's `act` flushes renders and effects before it returns when the callback is
 * synchronous, so there is nothing to wait for; it still returns a promise, typed for
 * every call. An async callback is only flushed once its promise settles, so that call
 * must be awaited. Returning `void` for a synchronous callback and a promise for an
 * async one lets `no-floating-promises` flag exactly the calls that need an `await`.
 */
export function act(callback: () => Promise<void>): Promise<void>;
export function act(callback: () => void): void;
export function act(callback: () => void | Promise<void>): void | Promise<void> {
  const seen = { async: false };
  const done = preactAct(() => {
    const result = callback();
    seen.async = result instanceof Promise;
    return result;
  });
  return seen.async ? done : undefined;
}
