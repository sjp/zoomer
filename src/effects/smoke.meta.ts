import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const SOURCE_OPTIONS = [
  { value: "incense", label: "Incense" },
  { value: "two", label: "Two sticks" },
  { value: "tea", label: "Tea steam" },
] as const;

export const smokeMeta = defineEffectMeta({
  id: "smoke",
  name: "Incense Smoke",
  description:
    "Thin wisps of smoke rise from incense or a cup of tea, curl and fade, lit from one side.",
  params: {
    source: { kind: "select", label: "Source", options: SOURCE_OPTIONS, default: "incense" },
    sourceX: { kind: "number", label: "Source position", min: 0, max: 1, step: 0.01, default: 0.2 },
    density: { kind: "number", label: "Density", min: 0.2, max: 1, step: 0.05, default: 0.7 },
    turbulence: { kind: "number", label: "Turbulence", min: 0, max: 1, step: 0.05, default: 0.5 },
    draft: { kind: "number", label: "Draft", min: -1, max: 1, step: 0.05, default: 0.15 },
    smokeColor: { kind: "color", label: "Smoke colour", default: "#93a4ba" },
    background: { kind: "color", label: "Background", default: "#1a1311" },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  context: "webgl2",
});
