import { useLayoutEffect, useRef, useState } from "react";
import { sanitizeText, stepDecimals } from "../effects/params";
import type { ParamDef, ParamValue, TextParam } from "../effects/types";

interface Props {
  id: string;
  def: ParamDef;
  value: ParamValue;
  onChange: (value: ParamValue) => void;
}

export function ParamControl({ id, def, value, onChange }: Props) {
  const inputId = `param-${id}`;
  switch (def.kind) {
    case "number":
      return (
        <div className="control">
          <label htmlFor={inputId}>
            {def.label}
            <output>{Number(value).toFixed(stepDecimals(def.step))}</output>
          </label>
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
          <label htmlFor={inputId}>{def.label}</label>
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
          <label htmlFor={inputId}>{def.label}</label>
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
          <label htmlFor={inputId}>{def.label}</label>
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
      return <TextControl inputId={inputId} def={def} value={String(value)} onChange={onChange} />;
    default:
      return null;
  }
}

interface TextProps {
  inputId: string;
  def: TextParam;
  value: string;
  onChange: (value: string) => void;
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
function TextControl({ inputId, def, value, onChange }: TextProps) {
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
      <label htmlFor={inputId}>{def.label}</label>
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
