import { defineEffectMeta } from "../types";

export type LampSide = "left" | "right";

export const LAMP_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: LampSide; label: string }[];

export const porchMeta = defineEffectMeta({
  id: "porch",
  name: "Porch Light Rain",
  description:
    "Looking out from a covered porch at night: steady rain falls through the warm cone of a lamp by the door, drips run off the gutter and the garden beyond stays dark and soft.",
  params: {
    lamp: { kind: "select", label: "Lamp", options: LAMP_OPTIONS, default: "left" },
    lampColor: { kind: "color", label: "Lamp colour", default: "#ffb35c" },
    rain: { kind: "number", label: "Rain", min: 0, max: 1, step: 0.01, default: 0.55 },
    wind: { kind: "number", label: "Wind", min: -1, max: 1, step: 0.01, default: 0.15 },
    drips: { kind: "boolean", label: "Drips from the roof", default: true },
    splashes: { kind: "boolean", label: "Splashes", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 5 },
  },
  category: "Cosy",
  tags: ["night", "storm", "shower", "lantern", "veranda", "garden", "moody", "calm", "rainy"],
  cost: "very low",
  context: "webgl2",
});
