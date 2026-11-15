import { useCallback, useSyncExternalStore } from "react";

const supported = () => typeof window.matchMedia === "function";

/** Whether a CSS media query matches, following changes (a rotation, a resize). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!supported()) {
        return () => undefined;
      }
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => supported() && window.matchMedia(query).matches);
}

/**
 * False on touch screens without a hovering pointer, where keyboard shortcut hints
 * are noise.
 */
export function useCanHover(): boolean {
  return !useMediaQuery("(hover: none)");
}
