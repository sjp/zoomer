import { useEffect } from "react";

/**
 * While `active`, keeps the `--keyboard-inset` CSS variable on the root element at how
 * much of the bottom of the layout viewport the on-screen keyboard covers, in px, so
 * a bottom sheet can sit above it. Mobile browsers shrink only the visual viewport for
 * the keyboard, which neither `dvh` nor a fixed `bottom: 0` follows. Zero while the
 * page is pinch-zoomed, when the visual viewport is smaller for another reason.
 */
export function useKeyboardInset(active: boolean): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) {
      return undefined;
    }
    const root = document.documentElement;
    const update = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      const inset = viewport.scale > 1.01 ? 0 : Math.max(0, Math.round(covered));
      root.style.setProperty("--keyboard-inset", `${String(inset)}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--keyboard-inset");
    };
  }, [active]);
}
