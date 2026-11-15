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
 * The label, and beside it a reset button while the value differs from the default.
 * The button sits outside the label element, so the field's accessible name stays the
 * label alone.
 */
function LabelRow({
  inputId,
  def,
  value,
  onReset,
  children,
}: {
  inputId: string;
  def: ParamDef;
  value: ParamValue;
  onReset: (() => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="control-label">
      <label htmlFor={inputId}>
        {def.label}
        {children}
      </label>
      {onReset && !isDefault(def, value) && (
        <button
          type="button"
          className="param-reset"
          aria-label={`Reset ${def.label}`}
          title={`Reset ${def.label}`}
          onClick={(e) => {
            onReset();
            // The button goes away with the change; from the keyboard (no click count),
            // keep focus nearby on the field. A tap doesn't, so it opens no keyboard.
            if (e.detail === 0) {
              document.getElementById(inputId)?.focus();
            }
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
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
      )}
    </div>
  );
}

export function ParamControl({ id, def, value, onChange, onReset }: Props) {
  const inputId = `param-${id}`;
  const label = (children?: ReactNode) => (
    <LabelRow inputId={inputId} def={def} value={value} onReset={onReset}>
      {children}
    </LabelRow>
  );
  switch (def.kind) {
    case "number":
      return (
        <div className="control">
          {label(<output>{Number(value).toFixed(stepDecimals(def.step))}</output>)}
          <input
            id={inputId}
            type="range"
            min={def.min}
            max={def.max}
            step={def.step}
            value={Number(value)}
            onChange={(e) => {
              onChange(Number(e.target.value));
            }}
          />
        </div>
      );
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
