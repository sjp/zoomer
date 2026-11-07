import { useEffect, useState } from "react";

/**
 * True once there has been no pointer or keyboard activity for `ms`. With `startIdle`,
 * it's true from the start until the first activity.
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
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const e of events) {
      window.addEventListener(e, wake);
    }
    return () => {
      clearTimeout(timer);
      for (const e of events) {
        window.removeEventListener(e, wake);
      }
    };
  }, [ms]);

  return idle;
}
