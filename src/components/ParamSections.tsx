import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { changedCount, groupParams } from "../effects/param-groups";
import type { AnyParamValues, ParamSchema, ParamValue } from "../effects/types";
import { ColourSwatch, ParamControl } from "./ParamControl";

interface SectionProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  /** Shown as "N changed" in the header when above zero. */
  changed?: number;
  children: ComponentChildren;
}

/**
 * A collapsible panel section: a header button with a chevron, the section's name
 * and how many of its settings differ from their defaults, over a region it shows
 * and hides. The region stays mounted while closed, so `aria-controls` always points
 * at it.
 */
export function Section({ title, open, onToggle, changed = 0, children }: SectionProps) {
  const id = useId();
  return (
    <section className="panel-section">
      <button
        type="button"
        className="section-header"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={onToggle}
      >
        <svg
          className="section-chevron"
          viewBox="0 0 20 20"
          width="14"
          height="14"
          aria-hidden="true"
        >
          <path
            d="M7.5 5l5 5-5 5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span id={`${id}-title`} className="section-title">
          {title}
        </span>
        {changed > 0 && <span className="section-changed">{changed} changed</span>}
      </button>
      <div
        id={`${id}-body`}
        className="section-body"
        role="region"
        aria-labelledby={`${id}-title`}
        hidden={!open}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * Splits keys into runs, so consecutive colours can share a swatch grid while every
 * other param, and a colour on its own, keeps its own row.
 */
function colourRuns(schema: ParamSchema, keys: readonly string[]) {
  const runs: { colours: boolean; keys: string[] }[] = [];
  for (const key of keys) {
    const colours = schema[key].kind === "color";
    const last = runs.at(-1);
    if (last && last.colours && colours) {
      last.keys.push(key);
    } else {
      runs.push({ colours, keys: [key] });
    }
  }
  return runs;
}

interface Props {
  /** Keys the controls' ids, so switching effect gives every control a fresh state. */
  effectId: string;
  schema: ParamSchema;
  values: AnyParamValues;
  /** Names of the sections the viewer has closed. */
  closed: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onParamChange: (key: string, value: ParamValue) => void;
}

/**
 * An effect's params in collapsible sections (see `groupParams`). With a single
 * section there's nothing to tell apart, so its controls show without a header.
 */
export function ParamSections({
  effectId,
  schema,
  values,
  closed,
  onToggle,
  onParamChange,
}: Props) {
  const groups = groupParams(schema);
  const props = (key: string) => {
    const def = schema[key];
    return {
      key: `${effectId}-${key}`,
      id: key,
      def,
      value: values[key] ?? def.default,
      onChange: (v: ParamValue) => {
        onParamChange(key, v);
      },
      onReset: () => {
        onParamChange(key, def.default);
      },
    };
  };
  const controls = (keys: readonly string[]) => (
    <div className="controls">
      {colourRuns(schema, keys).map((run) =>
        run.colours && run.keys.length > 1 ? (
          <div key={`${effectId}-${run.keys.join(",")}`} className="swatches">
            {run.keys.map((key) => {
              const { key: itemKey, ...rest } = props(key);
              return <ColourSwatch key={itemKey} {...rest} />;
            })}
          </div>
        ) : (
          run.keys.map((key) => {
            const { key: itemKey, ...rest } = props(key);
            return <ParamControl key={itemKey} {...rest} />;
          })
        ),
      )}
    </div>
  );
  if (groups.length === 1) {
    return <div className="panel-section">{controls(groups[0].keys)}</div>;
  }
  return (
    <>
      {groups.map(({ name, keys }) => (
        <Section
          key={name}
          title={name}
          open={!closed.has(name)}
          onToggle={() => {
            onToggle(name);
          }}
          changed={changedCount(schema, values, keys)}
        >
          {controls(keys)}
        </Section>
      ))}
    </>
  );
}
