import { useEffect, useState } from "preact/hooks";

/**
 * True once there has been no pointer, touch, scroll or keyboard activity for `ms`.
 * With `startIdle`, it's true from the start until the first activity.
 *
 * A touch scroll fires `pointercancel` and then nothing pointer-related, so touches and
 * scrolls count too. `scroll` doesn't bubble, so it's caught on the way down instead,
 * which sees scrolls in any element (a panel, a list).
 */
export function useIdle(ms: number, startIdle = false): boolean {
  const [idle, setIdle] = useState(startIdle);

  useEffect(() => {
    let timer = setTimeout(() => {
      setIdle(true);
    }, ms);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => {
        setIdle(true);
      }, ms);
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) {
      window.addEventListener(e, wake, { passive: true });
    }
    window.addEventListener("scroll", wake, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of events) {
        window.removeEventListener(e, wake);
      }
      window.removeEventListener("scroll", wake, { capture: true });
    };
  }, [ms]);

  return idle;
}
