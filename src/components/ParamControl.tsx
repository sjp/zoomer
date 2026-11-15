import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { isDefault, sanitizeText, stepDecimals } from "../effects/params";
import type { ParamDef, ParamValue, TextParam } from "../effects/types";

interface Props {
  id: string;
  def: ParamDef;
  value: ParamValue;
  onChange: (value: ParamValue) => void;
  /** Puts the param back to its default; offered while it differs from it. */
  onReset?: (() => void) | undefined;
}

/**
 * Puts one param back to its default. It goes away with the change, so from the
 * keyboard (no click count) focus moves to the field instead; a tap leaves focus
 * alone, so it opens no on-screen keyboard.
 */
function ResetButton({
  inputId,
  label,
  onReset,
}: {
  inputId: string;
  label: string;
  onReset: () => void;
}) {
  return (
    <button
      type="button"
      className="param-reset"
      aria-label={`Reset ${label}`}
      title={`Reset ${label}`}
      onClick={(e) => {
        onReset();
        if (e.detail === 0) {
          document.getElementById(inputId)?.focus();
        }
      }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path
          d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 2.5v2.6h2.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * The label, then a reset button while the value differs from the default, then
 * `after` (a slider's value, which the slider itself also reports) at the end of the
 * row. The button sits outside the label element, so the field's accessible name
 * stays the label alone.
 */
function LabelRow({
  inputId,
  def,
  value,
  onReset,
  after,
  labelId,
}: {
  inputId: string;
  def: ParamDef;
  value: ParamValue;
  onReset: (() => void) | undefined;
  after?: ReactNode;
  /** For a group of buttons, which a label element can't name: the text's id. */
  labelId?: string | undefined;
}) {
  return (
    <div className="control-label">
      {labelId === undefined ? (
        <label htmlFor={inputId}>{def.label}</label>
      ) : (
        <span id={labelId}>{def.label}</span>
      )}
      {onReset && !isDefault(def, value) && (
        <ResetButton inputId={inputId} label={def.label} onReset={onReset} />
      )}
      {after}
    </div>
  );
}

/**
 * A colour's caption under its swatch: the label without a trailing "colour", which
 * the grid makes plain ("Sky top colour" → "Sky top"), keeping a number or a note in
 * brackets after it ("Light colour 1" → "Light 1", "Wax colour (top)" → "Wax (top)").
 */
function swatchCaption(label: string): string {
  return label.replace(/ colour(?=(?: \d+| \([^)]*\))?$)/i, "");
}

/**
 * A colour param as one cell of a swatch grid: the swatch, and under it a short
 * caption that also opens the picker. The full label stays the input's accessible
 * name. The reset button sits beside the caption, clear of the swatch.
 */
export function ColourSwatch({ id, def, value, onChange, onReset }: Props) {
  const inputId = `param-${id}`;
  return (
    <div className="swatch">
      <input
        id={inputId}
        type="color"
        aria-label={def.label}
        title={def.label}
        value={String(value)}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
      <div className="swatch-caption">
        <label htmlFor={inputId}>{swatchCaption(def.label)}</label>
        {onReset && !isDefault(def, value) && (
          <ResetButton inputId={inputId} label={def.label} onReset={onReset} />
        )}
      </div>
    </div>
  );
}

/** The longest option label a select can have and still show as a segmented control. */
const SEGMENT_LABEL_MAX = 10;

/** Whether a select is small enough to show all its options at once: 2–3 short ones. */
function segmentable(options: readonly { label: string }[]): boolean {
  return (
    options.length >= 2 &&
    options.length <= 3 &&
    options.every((o) => o.label.length <= SEGMENT_LABEL_MAX)
  );
}

interface SegmentedProps<T> {
  /** The group's id, which a reset focuses. */
  id?: string;
  /** The id of the text that names the group. */
  labelledBy: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  title?: string | undefined;
}

/**
 * A few options side by side as pressed / unpressed buttons, in place of a select
 * whose options all fit. The group takes its name from the label beside it.
 */
export function Segmented<T extends string | number>({
  id,
  labelledBy,
  options,
  value,
  onChange,
  disabled,
  title,
}: SegmentedProps<T>) {
  return (
    <div
      id={id}
      className="segmented"
      role="group"
      aria-labelledby={labelledBy}
      title={title}
      // Focusable from script only, so a reset from the keyboard can land here.
      tabIndex={-1}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => {
            onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ParamControl({ id, def, value, onChange, onReset }: Props) {
  const inputId = `param-${id}`;
  const label = (after?: ReactNode) => (
    <LabelRow inputId={inputId} def={def} value={value} onReset={onReset} after={after} />
  );
  switch (def.kind) {
    case "number": {
      const n = Number(value);
      // How far along the track the thumb is, for the accent fill up to it.
      const fill = def.max > def.min ? ((n - def.min) / (def.max - def.min)) * 100 : 0;
      const track: Record<string, string> = {
        "--p": `${String(Math.min(100, Math.max(0, fill)))}%`,
      };
      return (
        <div className="control">
          {label(<span className="control-value">{n.toFixed(stepDecimals(def.step))}</span>)}
          <input
            id={inputId}
            type="range"
            style={track}
            min={def.min}
            max={def.max}
            step={def.step}
            value={n}
            onChange={(e) => {
              onChange(Number(e.target.value));
            }}
          />
        </div>
      );
    }
    case "color":
      return (
        <div className="control control-inline">
          {label()}
          <input
            id={inputId}
            type="color"
            value={String(value)}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        </div>
      );
    case "boolean":
      return (
        <div className="control control-inline">
          {label()}
          <input
            id={inputId}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => {
              onChange(e.target.checked);
            }}
          />
        </div>
      );
    case "select":
      if (segmentable(def.options)) {
        return (
          <div className="control">
            <LabelRow
              inputId={inputId}
              labelId={`${inputId}-label`}
              def={def}
              value={value}
              onReset={onReset}
            />
            <Segmented
              id={inputId}
              labelledBy={`${inputId}-label`}
              options={def.options}
              value={String(value)}
              onChange={onChange}
            />
          </div>
        );
      }
      return (
        <div className="control control-inline">
          {label()}
          <select
            id={inputId}
            value={String(value)}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          >
            {def.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    case "text":
      return (
        <TextControl
          inputId={inputId}
          def={def}
          value={String(value)}
          onChange={onChange}
          label={label()}
        />
      );
    default:
      return null;
  }
}

interface TextProps {
  inputId: string;
  def: TextParam;
  value: string;
  onChange: (value: string) => void;
  label: ReactNode;
}

/**
 * A textarea kept sanitised on every edit. While an input method is composing, the
 * raw text is held locally, since normalising or truncating it mid-composition
 * would break the IME; it is sanitised once composition ends.
 *
 * When sanitising changes the text (a stripped character, an over-long line), React
 * writes the new value into the textarea, which moves the caret to the end; it is put
 * back where it was, less whatever was removed before it.
 */
function TextControl({ inputId, def, value, onChange, label }: TextProps) {
  const [composing, setComposing] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef<number | null>(null);
  // Re-renders even when the sanitised value equals the current one, so the caret
  // is still restored after React puts the old value back.
  const [, setCaretRequests] = useState(0);
  useLayoutEffect(() => {
    const caret = caretRef.current;
    if (caret !== null && areaRef.current) {
      caretRef.current = null;
      areaRef.current.setSelectionRange(caret, caret);
    }
  });
  const commit = (area: HTMLTextAreaElement) => {
    const raw = area.value;
    const clean = sanitizeText(def, raw);
    if (clean !== raw) {
      // Sanitising the text before the caret gives the text before it afterwards.
      const before = sanitizeText(def, raw.slice(0, area.selectionStart));
      caretRef.current = Math.min(before.length, clean.length);
      setCaretRequests((n) => n + 1);
    }
    onChange(clean);
  };
  return (
    <div className="control">
      {label}
      <textarea
        ref={areaRef}
        id={inputId}
        rows={def.maxLines}
        cols={def.maxLength}
        spellCheck={false}
        autoComplete="off"
        value={composing ?? value}
        onCompositionStart={(e) => {
          setComposing(e.currentTarget.value);
        }}
        onCompositionEnd={(e) => {
          setComposing(null);
          commit(e.currentTarget);
        }}
        onChange={(e) => {
          if (composing !== null) {
            setComposing(e.target.value);
          } else {
            commit(e.target);
          }
        }}
      />
    </div>
  );
}
