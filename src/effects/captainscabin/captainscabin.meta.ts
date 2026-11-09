import { defineEffectMeta } from "../types";

export type CabinWeather = "fair" | "night" | "storm";

const WEATHER_OPTIONS = [
  { value: "fair", label: "Fair" },
  { value: "night", label: "Night" },
  { value: "storm", label: "Storm" },
] as const satisfies readonly { value: CabinWeather; label: string }[];

export const captainscabinMeta = defineEffectMeta({
  id: "captainscabin",
  name: "Captain's Cabin",
  description:
    "The great cabin at the stern of an old sailing ship: dark oak beams, a chart table with a brass sextant, a lantern swinging from a beam and a sweeping row of leaded windows over the wake, rising and falling slowly with the swell.",
  params: {
    weather: { kind: "select", label: "Weather", options: WEATHER_OPTIONS, default: "fair" },
    swell: { kind: "number", label: "Swell", min: 0, max: 1, step: 0.05, default: 0.5 },
    lantern: { kind: "boolean", label: "Lantern lit", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Scenes",
  tags: ["pirate", "sailing", "tall ship", "ocean", "nautical", "voyage", "galleon", "sea"],
  cost: "low",
  context: "webgl2",
});
