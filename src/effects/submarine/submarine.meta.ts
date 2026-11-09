import { defineEffectMeta } from "../types";

export type DepthMode = "descend" | "shallows" | "twilight" | "abyss";
type GaugeSide = "left" | "right";

const DEPTH_OPTIONS = [
  { value: "descend", label: "Descend" },
  { value: "shallows", label: "Shallows" },
  { value: "twilight", label: "Twilight" },
  { value: "abyss", label: "Abyss" },
] as const satisfies readonly { value: DepthMode; label: string }[];

const SIDE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: GaugeSide; label: string }[];

/** Most fish in the shallows' shoals, at `life` = 1. */
export const MAX_FISH = 30;

export const submarineMeta = defineEffectMeta({
  id: "submarine",
  name: "Submarine Viewport",
  description:
    "The salon of a brass-and-walnut submarine: a great riveted viewport looks out as the vessel sinks from sunlit shallows past jellyfish and the odd gliding whale into a dark abyss of glowing creatures, while the gauges' needles wander.",
  params: {
    depth: { kind: "select", label: "Depth", options: DEPTH_OPTIONS, default: "descend" },
    life: { kind: "number", label: "Sea life", min: 0, max: 1, step: 0.05, default: 0.6 },
    whale: { kind: "boolean", label: "Whales", default: true },
    side: { kind: "select", label: "Gauges", options: SIDE_OPTIONS, default: "left" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 5 },
  },
  category: "Scenes",
  tags: ["steampunk", "deep sea", "ocean", "nautical", "brass", "underwater", "victorian"],
  cost: "low",
  context: "webgl2",
});
