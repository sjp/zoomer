import { defineEffectMeta } from "./types";

export type RadiantId = "topLeft" | "topRight" | "offFrame";
export type GroundId = "hills" | "trees" | "tent" | "none";

export const RADIANT_OPTIONS = [
  { value: "topLeft", label: "Top left" },
  { value: "topRight", label: "Top right" },
  { value: "offFrame", label: "Off-frame" },
] as const satisfies readonly { value: RadiantId; label: string }[];

export const GROUND_OPTIONS = [
  { value: "hills", label: "Hills" },
  { value: "trees", label: "Trees" },
  { value: "tent", label: "Tent" },
  { value: "none", label: "None" },
] as const satisfies readonly { value: GroundId; label: string }[];

/** Most meteors per minute. */
export const RATE_MAX = 60;

export const meteorsMeta = defineEffectMeta({
  id: "meteors",
  name: "Meteor Shower",
  description:
    "A still, starry sky over a dark hillside during a meteor shower: every few seconds a meteor streaks out from the same point, and now and then a bright one leaves a glowing trail.",
  params: {
    rate: {
      kind: "number",
      label: "Meteors per minute",
      min: 1,
      max: RATE_MAX,
      step: 1,
      default: 12,
    },
    radiant: { kind: "select", label: "Radiant", options: RADIANT_OPTIONS, default: "topLeft" },
    bright: { kind: "number", label: "Bright share", min: 0, max: 1, step: 0.05, default: 0.2 },
    milkyWay: { kind: "boolean", label: "Milky Way", default: true },
    ground: { kind: "select", label: "Ground", options: GROUND_OPTIONS, default: "trees" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 5 },
  },
  category: "Space",
  tags: ["perseids", "shooting stars", "night sky", "stars", "astronomy", "camping", "calm"],
  cost: "very low",
  context: "webgl2",
});
