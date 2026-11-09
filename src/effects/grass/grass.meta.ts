import type { FieldId, SunId } from "./grass-sim";
import { defineEffectMeta } from "../types";

const FIELD_OPTIONS = [
  { value: "meadow", label: "Meadow" },
  { value: "wheat", label: "Wheat" },
  { value: "dry", label: "Dry grass" },
  { value: "lavender", label: "Lavender" },
] as const satisfies readonly { value: FieldId; label: string }[];

const SUN_OPTIONS = [
  { value: "midday", label: "Midday" },
  { value: "golden", label: "Golden hour" },
  { value: "overcast", label: "Overcast" },
] as const satisfies readonly { value: SunId; label: string }[];

export const grassMeta = defineEffectMeta({
  id: "grass",
  name: "Grass Field",
  description: "Tall grass under a soft sky, with slow gusts of wind rolling across the field.",
  params: {
    field: { kind: "select", label: "Field", options: FIELD_OPTIONS, default: "meadow" },
    sun: { kind: "select", label: "Light", options: SUN_OPTIONS, default: "golden" },
    density: { kind: "number", label: "Density", min: 0.25, max: 2, step: 0.05, default: 1 },
    height: {
      kind: "number",
      label: "Grass height",
      min: 0.3,
      max: 0.55,
      step: 0.01,
      default: 0.42,
    },
    wind: { kind: "number", label: "Wind", min: 0, max: 1, step: 0.01, default: 0.45 },
    gusts: { kind: "number", label: "Gusts", min: 0, max: 1, step: 0.01, default: 0.6 },
  },
  category: "Nature",
  tags: ["meadow", "summer", "prairie", "lawn", "breeze"],
  cost: "medium",
  context: "webgl2",
});
