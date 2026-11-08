import { defineEffectMeta } from "../types";

export type BeachTime = "midday" | "afternoon" | "sunset";
export type SunSide = "left" | "right";

export const TIME_OPTIONS = [
  { value: "midday", label: "Midday" },
  { value: "afternoon", label: "Afternoon" },
  { value: "sunset", label: "Sunset" },
] as const satisfies readonly { value: BeachTime; label: string }[];

export const SUN_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: SunSide; label: string }[];

export const beachdayMeta = defineEffectMeta({
  id: "beachday",
  name: "Beach Day",
  description:
    "Sitting on warm sand looking out to sea: small waves break, wash up the beach and drain back, with a glitter path under the sun and slow clouds drifting by.",
  params: {
    time: { kind: "select", label: "Time", options: TIME_OPTIONS, default: "afternoon" },
    waves: { kind: "number", label: "Waves", min: 0, max: 1, step: 0.05, default: 0.4 },
    sun: { kind: "select", label: "Sun", options: SUN_OPTIONS, default: "left" },
    towel: { kind: "boolean", label: "Beach towel", default: true },
    birds: { kind: "boolean", label: "Gulls", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Scenes",
  tags: ["seaside", "ocean", "shore", "surf", "summer", "holiday", "vacation", "sunny", "coast"],
  cost: "low",
  context: "webgl2",
});
