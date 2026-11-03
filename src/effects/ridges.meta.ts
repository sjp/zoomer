import type { PaletteId } from "./ridges-sim";
import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const PALETTE_OPTIONS = [
  { value: "ink", label: "Ink wash" },
  { value: "blue", label: "Blue hour" },
  { value: "jade", label: "Jade" },
  { value: "dawn", label: "Dawn" },
] as const satisfies readonly { value: PaletteId; label: string }[];

export const MIN_LAYERS = 4;

export const MAX_LAYERS = 7;

export const ridgesMeta = defineEffectMeta({
  id: "ridges",
  name: "Misty Ridges",
  description:
    "Steep mountain ridges fading into the distance like an ink-wash painting, with banks of fog drifting between them.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "ink" },
    layers: {
      kind: "number",
      label: "Layers",
      min: MIN_LAYERS,
      max: MAX_LAYERS,
      step: 1,
      default: 6,
    },
    peaks: {
      kind: "number",
      label: "Peaks (rolling to jagged)",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.7,
    },
    fog: { kind: "number", label: "Fog", min: 0, max: 1, step: 0.01, default: 0.6 },
    drift: { kind: "number", label: "Fog drift", min: 0, max: 3, step: 0.05, default: 1 },
    pan: { kind: "number", label: "Pan", min: 0, max: 3, step: 0.05, default: 0.3 },
    sun: { kind: "boolean", label: "Sun or moon", default: true },
    pines: { kind: "boolean", label: "Pines", default: true },
    birds: { kind: "boolean", label: "Birds", default: true },
    seed: { kind: "number", label: "Seed", min: 1, max: 100, step: 1, default: 1 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Nature",
  tags: ["mountains", "chinese", "landscape", "guilin"],
  cost: "low",
  context: "webgl2",
});
