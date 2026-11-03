import { defineEffectMeta } from "./types";

export const lavalampMeta = defineEffectMeta({
  id: "lavalamp",
  name: "Lava Lamp",
  description: "Soft glowing wax blobs that slowly rise, sink, merge and split.",
  params: {
    count: { kind: "number", label: "Blob count", min: 3, max: 20, step: 1, default: 8 },
    size: { kind: "number", label: "Blob size", min: 0.5, max: 2, step: 0.05, default: 1 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    colorBottom: { kind: "color", label: "Wax colour (bottom)", default: "#ff3d1f" },
    colorTop: { kind: "color", label: "Wax colour (top)", default: "#ffb13b" },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, step: 0.01, default: 0.6 },
    softness: {
      kind: "number",
      label: "Edge softness",
      min: 0.02,
      max: 0.5,
      step: 0.01,
      default: 0.12,
    },
    bgTop: { kind: "color", label: "Background (top)", default: "#0c0420" },
    bgBottom: { kind: "color", label: "Background (bottom)", default: "#3a0b3d" },
    seed: { kind: "number", label: "Blob layout seed", min: 1, max: 9999, step: 1, default: 1 },
  },
  category: "Retro",
  tags: ["70s", "groovy"],
  cost: "low",
  context: "webgl2",
});
