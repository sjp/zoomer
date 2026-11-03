/** "Add Warp Speed to favourites" / "Remove Warp Speed from favourites". */
function favouriteLabel(name: string, starred: boolean): string {
  return starred ? `Remove ${name} from favourites` : `Add ${name} to favourites`;
}

interface Props {
  starred: boolean;
  /** The effect's name, for the label. */
  name: string;
  onToggle: () => void;
  className?: string;
  /** Appended to the tooltip, e.g. a shortcut: " (S)". */
  titleSuffix?: string;
  /**
   * For a star inside a listbox option, which mustn't contain interactive elements:
   * hidden from assistive technology, out of the tab order and never focused, so the
   * search box keeps focus. The list offers the same action from the keyboard.
   */
  hidden?: boolean;
}

/** A star toggle for an effect's favourite state. Clicking it never selects the effect. */
export function StarButton({
  starred,
  name,
  onToggle,
  className,
  titleSuffix = "",
  hidden,
}: Props) {
  const label = favouriteLabel(name, starred);
  return (
    <button
      type="button"
      className={className ? `star-button ${className}` : "star-button"}
      aria-pressed={starred}
      aria-label={label}
      title={label + titleSuffix}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      // In the list, keep focus in the search box.
      onMouseDown={hidden ? (e) => e.preventDefault() : undefined}
      onClick={(e) => {
        // Don't let the click reach the row and select it.
        e.stopPropagation();
        onToggle();
      }}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
          fill={starred ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
