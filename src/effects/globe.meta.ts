import { defineEffectMeta } from "./types";

export type GlobePosition = "left" | "right";
export type GlobeSceneId = "cabin" | "village" | "lighthouse";

export const POSITION_OPTIONS = [
  { value: "left", label: "Bottom left" },
  { value: "right", label: "Bottom right" },
] as const satisfies readonly { value: GlobePosition; label: string }[];

export const SCENE_OPTIONS = [
  { value: "cabin", label: "Cabin" },
  { value: "village", label: "Village" },
  { value: "lighthouse", label: "Lighthouse" },
] as const satisfies readonly { value: GlobeSceneId; label: string }[];

/** Most flakes the globe holds; the `flakes` param's maximum. */
export const MAX_FLAKES = 600;

export const globeMeta = defineEffectMeta({
  id: "globe",
  name: "Snow Globe",
  description:
    "A glass snow globe on a shelf in the corner that shakes itself now and then, its flakes swirling up and slowly settling over a tiny winter scene.",
  params: {
    position: { kind: "select", label: "Position", options: POSITION_OPTIONS, default: "right" },
    scene: { kind: "select", label: "Scene", options: SCENE_OPTIONS, default: "cabin" },
    interval: { kind: "number", label: "Shake every (s)", min: 0, max: 120, step: 5, default: 40 },
    flakes: { kind: "number", label: "Flakes", min: 50, max: MAX_FLAKES, step: 10, default: 300 },
    size: { kind: "number", label: "Size", min: 0.7, max: 1.2, step: 0.05, default: 1 },
  },
  category: "Cosy",
  tags: ["winter", "christmas", "holiday", "ornament", "village", "cabin", "lighthouse", "festive"],
  cost: "very low",
  context: "webgl2",
});
