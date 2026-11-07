import { defineEffectMeta } from "../types";

export type SpringTime = "dusk" | "night" | "day";

export const TIME_OPTIONS = [
  { value: "dusk", label: "Dusk" },
  { value: "night", label: "Night" },
  { value: "day", label: "Day" },
] as const satisfies readonly { value: SpringTime; label: string }[];

/** Most flakes at a snowfall of 1. */
export const MAX_SPRING_FLAKES = 700;

export const hotspringMeta = defineEffectMeta({
  id: "hotspring",
  name: "Snowy Hot Spring",
  description:
    "An outdoor hot spring among snow-capped rocks, with steam rolling off the water, snow melting into it and a stone lantern glowing.",
  params: {
    snow: { kind: "number", label: "Snowfall", min: 0, max: 1, step: 0.01, default: 0.5 },
    steam: { kind: "number", label: "Steam", min: 0, max: 1, step: 0.01, default: 0.6 },
    time: { kind: "select", label: "Time of day", options: TIME_OPTIONS, default: "dusk" },
    lantern: { kind: "boolean", label: "Lantern", default: true },
  },
  category: "Nature",
  tags: ["onsen", "japan", "winter", "bath", "relaxing", "pool", "mist", "cold", "warm"],
  cost: "low",
  context: "webgl2",
});
