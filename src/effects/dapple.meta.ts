import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const POSITION_OPTIONS = [
  { value: "topRight", label: "Top right" },
  { value: "topLeft", label: "Top left" },
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
  { value: "full", label: "Full" },
] as const;

export const dappleMeta = defineEffectMeta({
  id: "dapple",
  name: "Dappled sunlight",
  description:
    "Soft, swaying dapples of sunlight through leaves on a plain wall, with the odd gust of wind. Very low power.",
  params: {
    wallColor: { kind: "color", label: "Wall colour", default: "#e6ddd0" },
    lightColor: { kind: "color", label: "Sunlight colour", default: "#ffdcaa" },
    shadowTint: { kind: "color", label: "Shadow tint", default: "#b8c4d8" },
    coverage: { kind: "number", label: "Coverage", min: 0, max: 1, step: 0.01, default: 0.35 },
    softness: { kind: "number", label: "Softness", min: 0, max: 1, step: 0.01, default: 0.5 },
    sway: { kind: "number", label: "Sway", min: 0, max: 1, step: 0.01, default: 0.5 },
    gusts: { kind: "number", label: "Gusts", min: 0, max: 1, step: 0.01, default: 0.4 },
    position: {
      kind: "select",
      label: "Position",
      options: POSITION_OPTIONS,
      default: "topRight",
    },
    sunAngle: {
      kind: "number",
      label: "Sun angle (degrees)",
      min: -45,
      max: 45,
      step: 1,
      default: 20,
    },
    windowFrame: { kind: "boolean", label: "Window frame", default: false },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Nature",
  tags: ["trees", "shadows", "komorebi"],
  cost: "very low",
  context: "webgl2",
});
