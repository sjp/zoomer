import type { ParamDef, ParamValue } from "../effects/types";

interface Props {
  id: string;
  def: ParamDef;
  value: ParamValue;
  onChange: (value: ParamValue) => void;
}

function decimals(step: number) {
  const s = String(step);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

export function ParamControl({ id, def, value, onChange }: Props) {
  const inputId = `param-${id}`;
  switch (def.kind) {
    case "number":
      return (
        <div className="control">
          <label htmlFor={inputId}>
            {def.label}
            <output>{Number(value).toFixed(decimals(def.step))}</output>
          </label>
          <input
            id={inputId}
            type="range"
            min={def.min}
            max={def.max}
            step={def.step}
            value={Number(value)}
            onChange={(e) => onChange(Number(e.target.value))}
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
            onChange={(e) => onChange(e.target.value)}
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
            onChange={(e) => onChange(e.target.checked)}
          />
        </div>
      );
    case "select":
      return (
        <div className="control control-inline">
          <label htmlFor={inputId}>{def.label}</label>
          <select id={inputId} value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {def.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
  }
}
