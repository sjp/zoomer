import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const ripplesMeta = defineEffectMeta({
  id: "ripples",
  name: "Pond Ripples",
  description: "Rain drops on dark, still water, sending soft rings through the reflected sky.",
  context: "webgl2",
  params: {
    rate: { kind: "number", label: "Drops per second", min: 0, max: 10, step: 0.1, default: 2.5 },
    ringSpeed: { kind: "number", label: "Ring speed", min: 0.25, max: 3, step: 0.05, default: 1 },
    ringSize: { kind: "number", label: "Ring size", min: 0.5, max: 2, step: 0.05, default: 1 },
    variation: {
      kind: "number",
      label: "Rate variation",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    skyTint: { kind: "color", label: "Sky", default: "#8a9db0" },
    water: { kind: "color", label: "Water", default: "#050b0c" },
    branches: { kind: "boolean", label: "Reflected branches", default: true },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
});
