import type { LightId, OpeningId } from "./bamboo-sim";
import { defineEffectMeta } from "./types";

export const LIGHT_OPTIONS = [
  { value: "morning", label: "Morning" },
  { value: "midday", label: "Midday" },
  { value: "misty", label: "Misty" },
] as const satisfies readonly { value: LightId; label: string }[];

export const OPENING_OPTIONS = [
  { value: "centre", label: "Centre" },
  { value: "none", label: "None" },
] as const satisfies readonly { value: OpeningId; label: string }[];

export const bambooMeta = defineEffectMeta({
  id: "bamboo",
  name: "Bamboo Grove",
  description:
    "Standing in a dense bamboo grove: tall green stems sway in slow gusts, leaves flutter high up and soft light filters through the haze.",
  params: {
    light: { kind: "select", label: "Light", options: LIGHT_OPTIONS, default: "morning" },
    density: { kind: "number", label: "Density", min: 0.3, max: 2, step: 0.05, default: 1 },
    wind: { kind: "number", label: "Wind", min: 0, max: 1, step: 0.01, default: 0.4 },
    opening: { kind: "select", label: "Opening", options: OPENING_OPTIONS, default: "centre" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 9 },
  },
  category: "Nature",
  tags: ["forest", "japan", "zen", "trees", "green", "calm", "arashiyama"],
  cost: "low",
  context: "webgl2",
});
