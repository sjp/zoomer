/**
 * Select options shared by several effects' params. Effect `.meta.ts` modules import
 * these, so this module must stay free of imports (it ships in the entry chunk).
 */

/** Options for a `quality` select param; `qualityDivisor` in `lowres.ts` maps them. */
export const QUALITY_OPTIONS = [
  { value: "high", label: "High" },
  { value: "balanced", label: "Balanced" },
  { value: "low", label: "Low (saves power)" },
] as const;
