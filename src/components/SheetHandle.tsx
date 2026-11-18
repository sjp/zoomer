import type { TargetedPointerEvent } from "preact";
import { useRef } from "preact/hooks";

/** How far a finger moves before a press on the handle counts as a drag, in px. */
const TAP_SLOP = 6;
/** How far a drag must go to move the sheet to its next state, in px. */
const SNAP_DISTANCE = 48;

interface Props {
  /** Whether the sheet is expanded, rather than collapsed to its peek bar. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A drag down from the collapsed sheet: hides the panel. */
  onDismiss: () => void;
  /** The sheet's height under the finger while dragging, in px; null once let go. */
  onDrag: (height: number | null) => void;
  /** The sheet's height when a drag starts, in px. */
  sheetHeight: () => number;
}

/**
 * The bottom sheet's grab handle. A tap (or Enter / Space) toggles the sheet between
 * its peek bar and expanded; a drag moves it with the finger and snaps on release:
 * up to expand, down to collapse, and down again from the peek bar to hide the panel.
 * Only the handle takes `touch-action: none`, so sliders and the scrolling body below
 * keep their own gestures.
 */
export function SheetHandle({ open, onOpenChange, onDismiss, onDrag, sheetHeight }: Props) {
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  // Whether the last press was a drag, so the click that may follow it is ignored.
  const dragged = useRef(false);

  const end = (e: TargetedPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) {
      return;
    }
    drag.current = null;
    if (!dragged.current) {
      return;
    }
    onDrag(null);
    const dy = e.clientY - d.startY;
    if (cancelled) {
      return;
    }
    if (dy <= -SNAP_DISTANCE) {
      onOpenChange(true);
    } else if (dy >= SNAP_DISTANCE) {
      if (open) {
        onOpenChange(false);
      } else {
        onDismiss();
      }
    }
  };

  return (
    <button
      type="button"
      className="sheet-handle"
      aria-expanded={open}
      aria-label={open ? "Collapse controls" : "Expand controls"}
      title={open ? "Collapse controls" : "Expand controls"}
      onPointerDown={(e) => {
        if (e.button !== 0) {
          return;
        }
        dragged.current = false;
        drag.current = { pointerId: e.pointerId, startY: e.clientY, startHeight: sheetHeight() };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || e.pointerId !== d.pointerId) {
          return;
        }
        const dy = e.clientY - d.startY;
        if (!dragged.current && Math.abs(dy) < TAP_SLOP) {
          return;
        }
        dragged.current = true;
        onDrag(d.startHeight - dy);
      }}
      onPointerUp={(e) => {
        end(e, false);
      }}
      onPointerCancel={(e) => {
        end(e, true);
      }}
      onClick={(e) => {
        // A keyboard press has no click count, and never follows a drag.
        if (dragged.current && e.detail !== 0) {
          return;
        }
        onOpenChange(!open);
      }}
    >
      <span className="sheet-handle-bar" aria-hidden="true" />
    </button>
  );
}
