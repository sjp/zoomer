import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

/** Largest flock; the bird buffers are this size whatever the params. */
export const MAX_BIRDS = 40000;

export const SKY_OPTIONS = [
  { value: "dusk", label: "Dusk" },
  { value: "overcast", label: "Overcast" },
  { value: "wintergold", label: "Winter gold" },
] as const;

export const HORIZON_OPTIONS = [
  { value: "reeds", label: "Reeds" },
  { value: "trees", label: "Trees" },
  { value: "none", label: "None" },
] as const;

export const murmurationMeta = defineEffectMeta({
  id: "murmuration",
  name: "Starling Murmuration",
  description:
    "A vast flock of starlings swirls against a dusk sky, folding and stretching into one shape-shifting cloud.",
  params: {
    sky: { kind: "select", label: "Sky", options: SKY_OPTIONS, default: "dusk" },
    birds: {
      kind: "number",
      label: "Birds",
      min: 10000,
      max: MAX_BIRDS,
      step: 1000,
      default: 24000,
    },
    speed: { kind: "number", label: "Speed", min: 0.25, max: 2, step: 0.05, default: 1 },
    cohesion: { kind: "number", label: "Cohesion", min: 0, max: 1, step: 0.05, default: 0.5 },
    horizon: { kind: "select", label: "Horizon", options: HORIZON_OPTIONS, default: "reeds" },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "high" },
  },
  category: "Nature",
  tags: ["birds", "flock", "boids", "swarm", "sunset", "evening", "wildlife", "emergent"],
  cost: "low",
  context: "webgl2",
});
