import { defineEffectMeta } from "./types";

export const MAX_BUBBLES = 40;

export const causticsMeta = defineEffectMeta({
  id: "caustics",
  name: "Underwater Caustics",
  description:
    "Rippling networks of light on a pool floor, or deep water with god rays and rising bubbles.",
  category: "Water",
  tags: ["swimming", "sea", "ocean", "reflections"],
  cost: "low",
  context: "webgl2",
  params: {
    scene: {
      kind: "select",
      label: "Scene",
      options: [
        { value: "pool", label: "Pool floor" },
        { value: "deep", label: "Deep water" },
      ],
      default: "pool",
    },
    waterColor: { kind: "color", label: "Water colour", default: "#1a7896" },
    lightColor: { kind: "color", label: "Light colour", default: "#e6fbff" },
    intensity: { kind: "number", label: "Intensity", min: 0, max: 2, step: 0.05, default: 1 },
    scale: { kind: "number", label: "Cell size", min: 0.5, max: 2, step: 0.05, default: 1 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    chromatic: {
      kind: "number",
      label: "Chromatic split (0 = off)",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
    },
    tiles: { kind: "boolean", label: "Pool tiles (pool floor only)", default: true },
    rays: { kind: "boolean", label: "God rays (deep water only)", default: true },
    bubbles: {
      kind: "number",
      label: "Bubbles (deep water only)",
      min: 0,
      max: MAX_BUBBLES,
      step: 1,
      default: 12,
    },
  },
});
