import { defineEffectMeta } from "../types";

export type WorkLights = "red" | "off";
export type ScopeSide = "left" | "right";

export const LIGHT_OPTIONS = [
  { value: "red", label: "Red" },
  { value: "off", label: "Off" },
] as const satisfies readonly { value: WorkLights; label: string }[];

export const SIDE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: ScopeSide; label: string }[];

/** Shortest and longest mean time between two slews, seconds. */
export const MIN_SLEW_GAP = 60;
export const MAX_SLEW_GAP = 900;

export const observatoryMeta = defineEffectMeta({
  id: "observatory",
  name: "Observatory Dome",
  description:
    "Inside a domed observatory at night: a great white telescope on its equatorial mount looks up through the open slit at the stars and the Milky Way, and every few minutes slews to a new target while the dome turns to follow.",
  params: {
    slewGap: {
      kind: "number",
      label: "Seconds between slews",
      min: MIN_SLEW_GAP,
      max: MAX_SLEW_GAP,
      step: 10,
      default: 180,
    },
    meteors: { kind: "boolean", label: "Meteors", default: true },
    lights: { kind: "select", label: "Work lights", options: LIGHT_OPTIONS, default: "red" },
    side: { kind: "select", label: "Telescope", options: SIDE_OPTIONS, default: "left" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Scenes",
  tags: ["astronomy", "telescope", "night sky", "stars", "stargazing", "space", "science"],
  cost: "low",
  context: "webgl2",
});
