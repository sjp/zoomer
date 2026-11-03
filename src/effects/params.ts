import type {
  AnyParamValues,
  EffectMeta,
  NumberParam,
  ParamDef,
  ParamSchema,
  ParamValue,
  TextParam,
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

/**
 * How many decimals a slider with this step needs to show its values exactly. Reads
 * the shortest round-trip string, so exponent forms like `1e-7` or `2.5e-8` work.
 */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  const [mantissa, exponent = "0"] = String(step).split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  return Math.min(20, Math.max(0, fraction - Number(exponent)));
}

/**
 * Characters a text param never keeps: C0/C1 controls (line breaks are handled
 * before this runs), lone surrogates, bidi embeddings, overrides, isolates and
 * marks, zero-width joiners, and emoji with their modifiers, variation selectors,
 * keycap marks, flag letters and tag characters. Plain digits, `#` and `*` are
 * emoji-capable but not pictographic, so they stay.
 */
const TEXT_STRIP =
  /[\p{Cc}\p{Cs}\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\p{Variation_Selector}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{e0000}-\u{e007f}]|\u20e3/gu;

/**
 * Makes `raw` a valid value for `def`: NFC-normalised, any line break (`\r\n`,
 * `\r`, U+2028/2029) turned into `\n`, stripped of `TEXT_STRIP`, then cut to
 * `maxLines` lines of `maxLength` code points each. Idempotent, so a sanitised
 * value survives the URL round trip unchanged.
 */
export function sanitizeText(def: TextParam, raw: string): string {
  const lines = raw
    .normalize("NFC")
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")
    .split("\n");
  const maxLines = Math.max(1, Math.floor(def.maxLines));
  const maxLength = Math.max(0, Math.floor(def.maxLength));
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    out.push(Array.from(lines[i].replace(TEXT_STRIP, "")).slice(0, maxLength).join(""));
  }
  // Removing characters can leave a pair that composes, so normalise again.
  return out.join("\n").normalize("NFC");
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
    case "text":
      return sanitizeText(def, raw);
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
export function encodeHash(effect: EffectMeta, values: AnyParamValues): string {
  const params = new URLSearchParams({ effect: effect.id });
  for (const [key, def] of Object.entries(effect.params)) {
    const value = values[key];
    if (value !== undefined && value !== def.default) params.set(key, serialize(def, value));
  }
  return `#${params.toString()}`;
}

/**
 * The effect and values a hash describes. An unknown or missing effect id falls back
 * to `fallback` (the default effect) with its defaults, since the hash's params were
 * meant for a different schema.
 */
export function stateFromHash<E extends EffectMeta>(
  hash: string,
  effects: readonly E[],
  fallback: E,
): { effect: E; values: AnyParamValues } {
  const { effectId, raw } = decodeHash(hash);
  const effect = effects.find((e) => e.id === effectId);
  if (!effect) return { effect: fallback, values: defaults(fallback.params) };
  return { effect, values: parseValues(effect.params, raw) };
}
