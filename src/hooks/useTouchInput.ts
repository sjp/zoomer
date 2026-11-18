import { useEffect, useState } from "preact/hooks";

/**
 * Whether the latest pointer input came from a touch screen. A pen or mouse that
 * moves or presses afterwards switches it back, so a laptop with a touch screen
 * follows whichever the user last reached for.
 */
export function useTouchInput(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      setTouch(e.pointerType === "touch");
    };
    window.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
    window.addEventListener("pointermove", onPointer, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointer, { capture: true });
      window.removeEventListener("pointermove", onPointer, { capture: true });
    };
  }, []);
  return touch;
}
