import type { AnyParamValues, EffectDefinition, ParamDef, ParamSchema, ParamValue } from "./types";

export function defaults(schema: ParamSchema): AnyParamValues {
  const values: AnyParamValues = {};
  for (const [key, def] of Object.entries(schema)) values[key] = def.default;
  return values;
}

/** Converts a raw string (from the URL) to a valid value, or undefined if invalid. */
export function coerce(def: ParamDef, raw: string): ParamValue | undefined {
  switch (def.kind) {
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) return undefined;
      return Math.min(def.max, Math.max(def.min, n));
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
