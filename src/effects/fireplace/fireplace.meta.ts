import { QUALITY_OPTIONS } from "../param-options";
import { defineEffectMeta } from "../types";

export const PALETTE_OPTIONS = [
  { value: "wood", label: "Wood fire" },
  { value: "gas", label: "Gas (blue)" },
  { value: "magic", label: "Magic (green/purple)" },
] as const;

export const fireplaceMeta = defineEffectMeta({
  id: "fireplace",
  name: "Fireplace",
  description: "A cosy fire with flickering flames, rising embers and a warm glow.",
  params: {
    height: {
      kind: "number",
      label: "Flame height",
      min: 0.15,
      max: 0.75,
      step: 0.01,
      default: 0.42,
    },
    intensity: { kind: "number", label: "Intensity", min: 0.3, max: 1.6, step: 0.01, default: 1 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "wood" },
    embers: {
      kind: "number",
      label: "Embers (0 = off)",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.35,
    },
    glow: { kind: "number", label: "Glow", min: 0, max: 1.5, step: 0.01, default: 0.7 },
    logs: { kind: "boolean", label: "Logs and hearth", default: true },
    background: { kind: "color", label: "Background", default: "#0a0604" },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Cosy",
  tags: ["hearth", "winter", "log fire", "christmas"],
  cost: "medium",
  context: "webgl2",
});
