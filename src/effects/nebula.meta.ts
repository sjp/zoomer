import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const PALETTE_OPTIONS = [
  { value: "orion", label: "Orion" },
  { value: "carina", label: "Carina" },
  { value: "veil", label: "Veil" },
  { value: "custom", label: "Custom" },
] as const;

export const nebulaMeta = defineEffectMeta({
  id: "nebula",
  name: "Nebula",
  description:
    "Glowing clouds of interstellar gas with dark dust lanes and a still starfield, slowly swirling.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "orion" },
    color1: { kind: "color", label: "Colour 1", default: "#29c4b4" },
    color2: { kind: "color", label: "Colour 2", default: "#d6409f" },
    color3: { kind: "color", label: "Colour 3", default: "#f0b440" },
    density: { kind: "number", label: "Gas density", min: 0, max: 1, step: 0.01, default: 0.55 },
    dust: { kind: "number", label: "Dust lanes", min: 0, max: 1, step: 0.01, default: 0.6 },
    stars: { kind: "number", label: "Stars", min: 0, max: 1, step: 0.01, default: 0.5 },
    spikes: { kind: "boolean", label: "Diffraction spikes", default: true },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
    seed: { kind: "number", label: "Seed", min: 0, max: 999, step: 1, default: 1 },
  },
  context: "webgl2",
});
