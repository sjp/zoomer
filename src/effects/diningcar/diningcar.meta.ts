import { defineEffectMeta } from "../types";

export type Drink = "red" | "white" | "tea";

export const DRINK_OPTIONS = [
  { value: "red", label: "Red wine" },
  { value: "white", label: "White wine" },
  { value: "tea", label: "Tea" },
] as const satisfies readonly { value: Drink; label: string }[];

export const diningcarMeta = defineEffectMeta({
  id: "diningcar",
  name: "Night Train Dining Car",
  description:
    "A table in the dining car of a night express: polished wood, a white cloth, a glowing table lamp and a glass of wine, while moonlit hills, farm lights and the odd small station slide past the window.",
  params: {
    speed: { kind: "number", label: "Train speed", min: 0, max: 1, step: 0.05, default: 0.4 },
    moon: { kind: "boolean", label: "Moonlight", default: true },
    stations: { kind: "number", label: "Stations", min: 0, max: 1, step: 0.05, default: 0.5 },
    drink: { kind: "select", label: "Drink", options: DRINK_OPTIONS, default: "red" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
  },
  category: "Scenes",
  tags: ["railway", "sleeper", "travel", "night", "cosy", "vintage", "restaurant", "countryside"],
  cost: "low",
  context: "webgl2",
});
