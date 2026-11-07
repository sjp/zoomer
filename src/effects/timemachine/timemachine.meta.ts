import { defineEffectMeta } from "../types";

export type TravelDirection = "forward" | "backward";
export type OutsideScene = "garden" | "street" | "seaside";

export const DIRECTION_OPTIONS = [
  { value: "forward", label: "Forward" },
  { value: "backward", label: "Backward" },
] as const satisfies readonly { value: TravelDirection; label: string }[];

export const OUTSIDE_OPTIONS = [
  { value: "garden", label: "Garden" },
  { value: "street", label: "City street" },
  { value: "seaside", label: "Seaside" },
] as const satisfies readonly { value: OutsideScene; label: string }[];

/** The fastest and slowest day, in seconds. */
export const MIN_DAY_SECONDS = 5;
export const MAX_DAY_SECONDS = 120;

export const timemachineMeta = defineEffectMeta({
  id: "timemachine",
  name: "Victorian Time Machine",
  description:
    "Seated in a Victorian time machine: a deep-buttoned red velvet chair, a great brass and crystal disc turning behind it and a date counter rolling on, while outside the sun and moon sweep across the sky and the seasons roll by.",
  params: {
    speed: {
      kind: "number",
      label: "Seconds per day",
      min: MIN_DAY_SECONDS,
      max: MAX_DAY_SECONDS,
      step: 1,
      default: 30,
    },
    direction: {
      kind: "select",
      label: "Direction",
      options: DIRECTION_OPTIONS,
      default: "forward",
    },
    scene: { kind: "select", label: "Outside", options: OUTSIDE_OPTIONS, default: "garden" },
    year: { kind: "number", label: "Starting year", min: 1, max: 9999, step: 1, default: 1887 },
  },
  category: "Scenes",
  tags: ["steampunk", "time travel", "seasons", "time-lapse", "brass", "victorian", "clockwork"],
  cost: "low",
  context: "webgl2",
});
