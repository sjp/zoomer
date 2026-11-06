import { useState } from "react";
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
 */
function TextControl({ inputId, def, value, onChange }: TextProps) {
  const [composing, setComposing] = useState<string | null>(null);
  return (
    <div className="control">
      <label htmlFor={inputId}>{def.label}</label>
      <textarea
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
          onChange(sanitizeText(def, e.currentTarget.value));
        }}
        onChange={(e) => {
          if (composing !== null) setComposing(e.target.value);
          else onChange(sanitizeText(def, e.target.value));
        }}
      />
    </div>
  );
}
