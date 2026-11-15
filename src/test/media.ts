import { vi } from "vitest";

/**
 * Makes `window.matchMedia` match exactly the given queries (compared as written).
 * `set` changes them later and tells listeners, as a rotation or resize would.
 */
export function mockMedia(matching: readonly string[] = []) {
  let current = new Set(matching);
  const listeners = new Set<() => void>();
  const spy = vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        media: query,
        get matches() {
          return current.has(query);
        },
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          listeners.delete(listener);
        },
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
  return {
    spy,
    set(next: readonly string[]) {
      current = new Set(next);
      for (const listener of listeners) {
        listener();
      }
    },
  };
}
