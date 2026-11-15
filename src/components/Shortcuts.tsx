import { useEffect, useId, useRef } from "react";

/** The keyboard shortcuts, as the app handles them in `App.tsx`. */
const SHORTCUTS = [
  [["/"], "Search effects"],
  [["←", "→"], "Previous or next effect"],
  [["S"], "Star the effect"],
  [["H"], "Hide or show the controls"],
  [["F"], "Fullscreen"],
  [["?"], "Show these shortcuts"],
] as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * A quiet "Shortcuts" button that toggles a small popover listing the keyboard
 * shortcuts (as `?` does). Escape or a click anywhere else closes it.
 */
export function Shortcuts({ open, onOpenChange }: Props) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || ref.current?.contains(e.target) !== true) {
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={ref} className="shortcuts">
      <button
        type="button"
        className="text-button"
        aria-expanded={open}
        aria-controls={id}
        title="Keyboard shortcuts (?)"
        onClick={() => {
          onOpenChange(!open);
        }}
      >
        Shortcuts
      </button>
      <div
        id={id}
        className="shortcuts-popover"
        role="dialog"
        aria-label="Keyboard shortcuts"
        hidden={!open}
      >
        <dl>
          {SHORTCUTS.map(([keys, action]) => (
            <div key={action}>
              <dt>
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
