import { defineEffectMeta } from "../types";

/** Top of the activity slider, in toggles per second. */
export const MAX_TOGGLE_RATE = 1000;

export const cityMeta = defineEffectMeta({
  id: "city",
  name: "City at Night",
  description:
    "A night skyline from a high window: lit windows that slowly change, red roof beacons and the odd passing aircraft.",
  params: {
    skyTop: { kind: "color", label: "Sky top colour", default: "#050a22" },
    skyHorizon: { kind: "color", label: "Horizon glow colour", default: "#4a3463" },
    buildings: { kind: "color", label: "Building colour", default: "#06060c" },
    density: { kind: "number", label: "Density", min: 0, max: 1, step: 0.01, default: 0.5 },
    litWindows: {
      kind: "number",
      label: "Lit windows",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.32,
    },
    warmth: { kind: "number", label: "Warmth", min: 0, max: 1, step: 0.01, default: 0.7 },
    activity: {
      kind: "number",
      label: "Activity (toggles per second)",
      min: 0,
      max: MAX_TOGGLE_RATE,
      step: 1,
      default: 4,
    },
    beacons: { kind: "boolean", label: "Roof beacons", default: true },
    aircraft: { kind: "boolean", label: "Aircraft", default: true },
    seed: { kind: "number", label: "Seed", min: 1, max: 999, step: 1, default: 7 },
  },
  category: "Cosy",
  tags: ["buildings", "urban", "lights", "skyscrapers", "high-rise"],
  cost: "very low",
  context: "webgl2",
});
