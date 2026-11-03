import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const MAX_BLOBS = 6;

export const PALETTE_OPTIONS = [
  { value: "dusk", label: "Dusk" },
  { value: "ocean", label: "Ocean" },
  { value: "mint", label: "Mint" },
  { value: "candy", label: "Candy" },
  { value: "mono", label: "Mono" },
  { value: "custom", label: "Custom" },
] as const;

export const blobsMeta = defineEffectMeta({
  id: "blobs",
  name: "Gradient Blobs",
  description: "Large, soft colour fields that slowly drift and merge. Very low power.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "dusk" },
    color1: { kind: "color", label: "Colour 1 (custom)", default: "#ff6f61" },
    color2: { kind: "color", label: "Colour 2 (custom)", default: "#b34fd1" },
    color3: { kind: "color", label: "Colour 3 (custom)", default: "#4a58d9" },
    color4: { kind: "color", label: "Colour 4 (custom)", default: "#ffb36b" },
    background: { kind: "color", label: "Background", default: "#140f2a" },
    blobs: { kind: "number", label: "Blobs", min: 3, max: MAX_BLOBS, step: 1, default: 5 },
    speed: { kind: "number", label: "Speed", min: 0, max: 2, step: 0.05, default: 0.3 },
    softness: { kind: "number", label: "Softness", min: 0.5, max: 1.6, step: 0.05, default: 1 },
    grain: { kind: "number", label: "Grain", min: 0, max: 1, step: 0.01, default: 0.15 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "low" },
  },
  category: "Abstract",
  tags: ["colours", "minimal", "mesh", "mesh gradient"],
  cost: "very low",
  context: "webgl2",
});
