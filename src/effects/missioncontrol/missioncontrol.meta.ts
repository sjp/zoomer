import { defineEffectMeta } from "../types";

type PhosphorId = "green" | "white" | "amber";
type ClockId = "mission" | "local";

const PHOSPHOR_OPTIONS = [
  { value: "green", label: "Green" },
  { value: "white", label: "White" },
  { value: "amber", label: "Amber" },
] as const satisfies readonly { value: PhosphorId; label: string }[];

const CLOCK_OPTIONS = [
  { value: "mission", label: "Mission time" },
  { value: "local", label: "Local time" },
] as const satisfies readonly { value: ClockId; label: string }[];

/** Fewest and most seconds between one liftoff and the next. */
export const MIN_LAUNCH_GAP = 60;
export const MAX_LAUNCH_GAP = 1200;

export const missioncontrolMeta = defineEffectMeta({
  id: "missioncontrol",
  name: "Mission Control",
  description:
    "A dim space-flight control room seen from the back row: tiers of consoles with glowing CRTs face a wall-sized world map where an orbit track crawls along, with a launch now and then.",
  params: {
    launches: { kind: "boolean", label: "Launches", default: true },
    launchGap: {
      kind: "number",
      label: "Seconds between launches",
      min: MIN_LAUNCH_GAP,
      max: MAX_LAUNCH_GAP,
      step: 30,
      default: 300,
    },
    activity: { kind: "number", label: "Activity", min: 0, max: 1, step: 0.05, default: 0.4 },
    phosphor: {
      kind: "select",
      label: "CRT phosphor",
      options: PHOSPHOR_OPTIONS,
      default: "green",
    },
    clock: { kind: "select", label: "Big clock", options: CLOCK_OPTIONS, default: "mission" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Scenes",
  tags: ["space race", "nasa-era", "launch", "control room", "retro", "rocket", "orbit", "1960s"],
  cost: "low",
  context: "webgl2",
});
