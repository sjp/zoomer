import { useId, useLayoutEffect, useRef, useState } from "react";

/**
 * The effect's description. With `clamp` (on a phone, where height is scarce) it shows
 * at most two lines, with a More / Less toggle that appears only when the text runs
 * longer than that. Give it a new key with each new text, so that starts collapsed and is
 * measured afresh.
 */
export function Description({ text, clamp }: { text: string; clamp: boolean }) {
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const clamped = clamp && !expanded;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!clamped || !el) {
      return undefined;
    }
    const measure = () => {
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [clamped]);

  return (
    <div className="description-wrap">
      <p ref={ref} id={id} className="description" data-clamped={clamped}>
        {text}
      </p>
      {clamp && (overflows || expanded) && (
        <button
          type="button"
          className="link-button description-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => {
            setExpanded((e) => !e);
          }}
        >
          {expanded ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}
