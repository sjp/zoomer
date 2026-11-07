import { defineEffectMeta } from "../types";

export type FireSide = "left" | "right" | "none";

export const FIRE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "none", label: "None" },
] as const satisfies readonly { value: FireSide; label: string }[];

/** Fastest sky rotation, degrees per minute. */
export const ROTATION_MAX = 20;

export const desertcampMeta = defineEffectMeta({
  id: "desertcamp",
  name: "Desert Night Camp",
  description:
    "A clear desert night: the Milky Way arcs over dark dunes while a small campfire at one edge throws warm, flickering light on the sand.",
  params: {
    fire: { kind: "select", label: "Campfire", options: FIRE_OPTIONS, default: "left" },
    milkyWay: { kind: "number", label: "Milky Way", min: 0, max: 1, step: 0.05, default: 0.6 },
    stars: { kind: "number", label: "Stars", min: 0.1, max: 1, step: 0.05, default: 0.6 },
    rotation: {
      kind: "number",
      label: "Sky rotation (°/min)",
      min: 0,
      max: ROTATION_MAX,
      step: 0.5,
      default: 2,
    },
    meteors: { kind: "boolean", label: "Meteors", default: true },
    tent: { kind: "boolean", label: "Tent", default: true },
    sparks: { kind: "boolean", label: "Sparks", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
  },
  category: "Nature",
  tags: ["camping", "sahara", "wilderness", "galaxy", "bonfire", "stars", "night sky", "calm"],
  cost: "low",
  context: "webgl2",
});
