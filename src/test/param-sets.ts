import { defaults, sanitizeText } from "../effects/params";
import type { AnyParamValues, ParamSchema } from "../effects/types";

/**
 * Param sets that reach the ends of every slider and every select option: the
 * defaults, every slider at its max, every slider at its min, each select option
 * in turn, then the defaults again.
 */
export function paramSets(schema: ParamSchema): AnyParamValues[] {
  const base = defaults(schema);
  const atMin: AnyParamValues = { ...base };
  const atMax: AnyParamValues = { ...base };
  const sets = [base, atMax, atMin];
  for (const [key, def] of Object.entries(schema)) {
    if (def.kind === "number") {
      atMin[key] = def.min;
      atMax[key] = def.max;
    } else if (def.kind === "boolean") {
      atMin[key] = !def.default;
      atMax[key] = !def.default;
    } else if (def.kind === "color") {
      atMin[key] = "#000000";
      atMax[key] = "#ffffff";
    } else if (def.kind === "text") {
      // Empty, and every line full of mixed characters, some with no glyph.
      atMin[key] = "";
      const line = "Wa9 #?é東".repeat(def.maxLength);
      atMax[key] = sanitizeText(def, Array.from({ length: def.maxLines }, () => line).join("\n"));
    } else {
      for (const o of def.options) {
        sets.push({ ...base, [key]: o.value });
      }
    }
  }
  sets.push(base);
  return sets;
}
