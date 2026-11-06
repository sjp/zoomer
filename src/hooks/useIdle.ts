import { useEffect, useState } from "react";

/** True once there has been no pointer or keyboard activity for `ms`. */
export function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false);

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
