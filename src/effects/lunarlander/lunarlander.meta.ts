import { defineEffectMeta } from "../types";

export type EarthWindow = "left" | "right" | "none";

export const EARTH_OPTIONS = [
  { value: "left", label: "Left window" },
  { value: "right", label: "Right window" },
  { value: "none", label: "None" },
] as const satisfies readonly { value: EarthWindow; label: string }[];

export const lunarlanderMeta = defineEffectMeta({
  id: "lunarlander",
  name: "Lunar Lander Cabin",
  description:
    "Standing in the cramped cabin of a lander parked on the Moon: switches, breakers and gauges all round, and two triangular windows looking out on a grey cratered plain in hard sunlight, with the Earth hanging low in the black sky.",
  params: {
    earth: { kind: "select", label: "Earth", options: EARTH_OPTIONS, default: "left" },
    phase: { kind: "number", label: "Earth's phase", min: 0, max: 1, step: 0.05, default: 0.6 },
    ascent: { kind: "boolean", label: "Lift off every half hour", default: false },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 11 },
  },
  category: "Scenes",
  tags: ["moon", "apollo-era", "space race", "astronaut", "retro", "1960s", "lunar surface"],
  cost: "very low",
  context: "webgl2",
});
