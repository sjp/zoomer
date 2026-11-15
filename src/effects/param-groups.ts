import { isDefault } from "./params";
import type { AnyParamValues, ParamDef, ParamSchema } from "./types";

/** The default sections, for params that don't name one. */
const COLOURS = "Colours";
const SETTINGS = "Settings";

interface ParamGroup {
  name: string;
  keys: string[];
}

/**
 * Splits an effect's params into the panel's sections. Where the effect names groups,
 * they come in the order each first appears, and a param without one goes to the
 * default section for its kind. Otherwise there are at most two: everything but the
 * colours under "Settings", then the colours under "Colours". Keys keep the schema's
 * order within each section.
 */
export function groupParams(schema: ParamSchema): ParamGroup[] {
  const entries = Object.entries(schema);
  const fallback = (def: ParamDef) => (def.kind === "color" ? COLOURS : SETTINGS);
  const named = entries.some(([, def]) => def.group !== undefined);
  const order = named ? [] : [SETTINGS, COLOURS];
  const groups = new Map<string, string[]>(order.map((name) => [name, []]));
  for (const [key, def] of entries) {
    const name = def.group ?? fallback(def);
    const keys = groups.get(name);
    if (keys) {
      keys.push(key);
    } else {
      groups.set(name, [key]);
    }
  }
  return [...groups].filter(([, keys]) => keys.length > 0).map(([name, keys]) => ({ name, keys }));
}

/** How many of the keys have a value other than their param's default. */
export function changedCount(schema: ParamSchema, values: AnyParamValues, keys: readonly string[]) {
  return keys.filter((key) => {
    if (!Object.hasOwn(schema, key)) {
      return false;
    }
    const def = schema[key];
    return !isDefault(def, values[key] ?? def.default);
  }).length;
}
