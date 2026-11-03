import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const ABOVE_OPTIONS = [
  { value: "sky", label: "Sky" },
  { value: "trees", label: "Trees" },
  { value: "sunset", label: "Sunset" },
] as const;

export const WATER_OPTIONS = [
  { value: "blue", label: "Clear blue" },
  { value: "lake", label: "Green lake" },
  { value: "tropical", label: "Tropical" },
] as const;

export type AboveId = (typeof ABOVE_OPTIONS)[number]["value"];
export type WaterId = (typeof WATER_OPTIONS)[number]["value"];

export const snellMeta = defineEffectMeta({
  id: "snell",
  name: "Snell's Window",
  description:
    "Looking up from under calm water: the whole sky squeezed into a bright, rippling circle with a rainbow rim, framed by dark reflected water, with light shafts and floating motes.",
  params: {
    above: { kind: "select", label: "Above", options: ABOVE_OPTIONS, default: "sky" },
    water: { kind: "select", label: "Water", options: WATER_OPTIONS, default: "blue" },
    ripples: { kind: "number", label: "Ripples", min: 0, max: 1, step: 0.01, default: 0.45 },
    depth: { kind: "number", label: "Depth", min: 0.6, max: 1.4, step: 0.05, default: 1 },
    rays: { kind: "number", label: "Light shafts", min: 0, max: 1, step: 0.01, default: 0.5 },
    leaf: { kind: "boolean", label: "Floating leaves", default: true },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Water",
  tags: ["underwater", "swimming", "pool", "diving", "refraction", "optics", "physics"],
  cost: "low",
  context: "webgl2",
});
