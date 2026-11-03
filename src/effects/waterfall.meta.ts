import { defineEffectMeta } from "./types";

export type FallSide = "left" | "right";
export type ForestLight = "morning" | "overcast" | "dusk";

export const FALL_SIDE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: FallSide; label: string }[];

export const FOREST_LIGHT_OPTIONS = [
  { value: "morning", label: "Morning" },
  { value: "overcast", label: "Overcast" },
  { value: "dusk", label: "Dusk" },
] as const satisfies readonly { value: ForestLight; label: string }[];

export const waterfallMeta = defineEffectMeta({
  id: "waterfall",
  name: "Forest Waterfall",
  description:
    "A narrow waterfall spills over a mossy ledge into a misty pool in a shaded green forest, with spray at its foot and ripples spreading across the water.",
  params: {
    position: { kind: "select", label: "Position", options: FALL_SIDE_OPTIONS, default: "left" },
    flow: { kind: "number", label: "Flow", min: 0, max: 1, step: 0.01, default: 0.6 },
    mist: { kind: "number", label: "Mist", min: 0, max: 1, step: 0.01, default: 0.5 },
    light: { kind: "select", label: "Light", options: FOREST_LIGHT_OPTIONS, default: "morning" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
  },
  category: "Nature",
  tags: ["cascade", "river", "stream", "woodland", "rainforest", "moss", "ferns", "calm", "spray"],
  cost: "low",
  context: "webgl2",
});
