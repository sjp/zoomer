import type { PaletteName } from "./glass-sim";
import { defineEffectMeta } from "./types";

export const PALETTE_OPTIONS = [
  { value: "cathedral", label: "Cathedral" },
  { value: "tiffany", label: "Tiffany" },
  { value: "modern", label: "Modern" },
] as const satisfies readonly { value: PaletteName; label: string }[];

export const glassMeta = defineEffectMeta({
  id: "glass",
  name: "Stained glass",
  description:
    "A backlit stained-glass window of jewel-toned panes in dark lead, with a soft patch of sunlight drifting across.",
  params: {
    palette: {
      kind: "select",
      label: "Palette",
      options: PALETTE_OPTIONS,
      default: "cathedral",
    },
    cellSize: {
      kind: "number",
      label: "Pane size (px at 1080p)",
      min: 100,
      max: 260,
      step: 5,
      default: 160,
    },
    leadWidth: {
      kind: "number",
      label: "Lead width (px at 1080p)",
      min: 2,
      max: 14,
      step: 0.5,
      default: 6,
    },
    leadColor: { kind: "color", label: "Lead colour", default: "#303236" },
    drift: { kind: "number", label: "Drift", min: 0, max: 1, step: 0.01, default: 0.5 },
    light: { kind: "number", label: "Sunlight", min: 0, max: 1, step: 0.01, default: 0.6 },
    texture: { kind: "number", label: "Glass texture", min: 0, max: 1, step: 0.01, default: 0.5 },
  },
  category: "Abstract",
  tags: ["church", "mosaic", "colourful", "cathedral"],
  cost: "low",
  context: "webgl2",
});
