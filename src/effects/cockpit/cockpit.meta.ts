import { defineEffectMeta } from "../types";

type ViewId = "cycle" | "sublight" | "hyperspace";

const VIEW_OPTIONS = [
  { value: "cycle", label: "Cycle" },
  { value: "sublight", label: "Sublight only" },
  { value: "hyperspace", label: "Hyperspace only" },
] as const satisfies readonly { value: ViewId; label: string }[];

/** Fewest and most seconds of sublight flight between one jump and the next. */
export const MIN_JUMP_GAP = 30;
export const MAX_JUMP_GAP = 600;

export const cockpitMeta = defineEffectMeta({
  id: "cockpit",
  name: "Freighter Cockpit",
  description:
    "The cockpit of a battered light freighter, seen from behind the pilots' seats: stars drift past the ribbed canopy, and now and then the ship jumps into a swirling blue tunnel.",
  params: {
    view: { kind: "select", label: "View", options: VIEW_OPTIONS, default: "cycle" },
    jumpGap: {
      kind: "number",
      label: "Seconds between jumps",
      min: MIN_JUMP_GAP,
      max: MAX_JUMP_GAP,
      step: 10,
      default: 150,
    },
    asteroids: { kind: "number", label: "Asteroids", min: 0, max: 1, step: 0.05, default: 0.5 },
    lights: { kind: "number", label: "Console activity", min: 0, max: 1, step: 0.05, default: 0.5 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
  },
  category: "Scenes",
  tags: ["sci-fi", "spaceship", "hyperspace", "pilot", "lightspeed", "starship", "space travel"],
  cost: "low",
  context: "webgl2",
});
