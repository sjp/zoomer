import type {
  AnyParamValues,
  EffectDefinition,
  NumberParam,
  ParamDef,
  ParamSchema,
  ParamValue,
} from "./types";

export function defaults(schema: ParamSchema): AnyParamValues {
  const values: AnyParamValues = {};
  for (const [key, def] of Object.entries(schema)) values[key] = def.default;
  return values;
}

/**
 * Clamps `n` to the param's range and snaps it to the nearest `min + k·step`, the
 * values its slider can produce, so a hand-edited URL can't give an effect a
 * fractional count. Rounded to 12 decimals so float error in `k·step` doesn't
 * leave values like 0.30000000000000004.
 */
export function snap(def: NumberParam, n: number): number {
  const clamped = Math.min(def.max, Math.max(def.min, n));
  if (!(def.step > 0)) return clamped;
  let k = Math.round((clamped - def.min) / def.step);
  // Like a range input, stay on the grid below an off-grid max.
  if (def.min + k * def.step > def.max) k--;
  return Number((def.min + k * def.step).toFixed(12));
}

/** Converts a raw string (from the URL) to a valid value, or undefined if invalid. */
export function coerce(def: ParamDef, raw: string): ParamValue | undefined {
  switch (def.kind) {
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) return undefined;
      return snap(def, n);
    }
    case "color": {
      const hex = raw.startsWith("#") ? raw : `#${raw}`;
      return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : undefined;
    }
    case "boolean":
      if (raw === "1" || raw === "true") return true;
      if (raw === "0" || raw === "false") return false;
      return undefined;
    case "select":
      return def.options.some((o) => o.value === raw) ? raw : undefined;
  }
}

/** Builds a full set of values, falling back to defaults for missing or invalid entries. */
export function parseValues(schema: ParamSchema, raw: Record<string, string>): AnyParamValues {
  const values = defaults(schema);
  for (const [key, def] of Object.entries(schema)) {
    if (key in raw) {
      const value = coerce(def, raw[key]);
      if (value !== undefined) values[key] = value;
    }
  }
  return values;
}

function serialize(def: ParamDef, value: ParamValue): string {
  if (def.kind === "boolean") return value ? "1" : "0";
  if (def.kind === "color") return String(value).replace(/^#/, "");
  return String(value);
}

export function decodeHash(hash: string): { effectId?: string; raw: Record<string, string> } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const raw: Record<string, string> = {};
  for (const [key, value] of params) raw[key] = value;
  const { effect: effectId, ...rest } = raw;
  return { effectId, raw: rest };
}

/** Encodes the effect and its non-default values, e.g. `#effect=warp&speed=5`. */
export function encodeHash(effect: EffectDefinition, values: AnyParamValues): string {
  const params = new URLSearchParams({ effect: effect.id });
  for (const [key, def] of Object.entries(effect.params)) {
    const value = values[key];
    if (value !== undefined && value !== def.default) params.set(key, serialize(def, value));
  }
  return `#${params.toString()}`;
}

/**
 * The effect and values a hash describes. An unknown or missing effect id falls back
 * to the first effect with its defaults, since the hash's params were meant for a
 * different schema.
 */
export function stateFromHash(
  hash: string,
  effects: readonly EffectDefinition[],
): { effect: EffectDefinition; values: AnyParamValues } {
  const { effectId, raw } = decodeHash(hash);
  const effect = effects.find((e) => e.id === effectId);
  if (!effect) return { effect: effects[0], values: defaults(effects[0].params) };
  return { effect, values: parseValues(effect.params, raw) };
}
