import { useLayoutEffect, useRef, useState } from "preact/hooks";

/**
 * Reads a value that lives outside the component tree (a `Store`, a media query) and
 * re-renders when it changes. `subscribe` registers a listener and returns its
 * unsubscribe; keep it stable (module-level, a store method or `useCallback`), since a
 * new one re-subscribes. `getSnapshot` must return the same value (by `Object.is`)
 * until the source changes.
 *
 * Every render reads a fresh snapshot, and the listener re-renders only when the
 * snapshot differs from the one last rendered. The snapshot is checked again right
 * after subscribing, so a change between render and subscribe isn't lost.
 */
export function useExternalStore<T>(
  subscribe: (onChange: () => void) => () => void,
  getSnapshot: () => T,
): T {
  const value = getSnapshot();
  const [, setVersion] = useState(0);
  const latest = useRef({ value, getSnapshot });
  useLayoutEffect(() => {
    latest.current = { value, getSnapshot };
  });
  useLayoutEffect(() => {
    const check = () => {
      if (!Object.is(latest.current.getSnapshot(), latest.current.value)) {
        setVersion((version) => version + 1);
      }
    };
    const unsubscribe = subscribe(check);
    check();
    return unsubscribe;
  }, [subscribe]);
  return value;
}
