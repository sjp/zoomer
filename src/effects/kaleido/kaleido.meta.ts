import type { PaletteName, ViewName } from "./kaleido-sim";
import { defineEffectMeta } from "../types";

export const SEGMENT_OPTIONS = [
  { value: "6", label: "6" },
  { value: "8", label: "8" },
  { value: "12", label: "12" },
] as const;

export const PALETTE_OPTIONS = [
  { value: "jewel", label: "Jewel" },
  { value: "pastel", label: "Pastel" },
  { value: "mono", label: "Mono" },
] as const satisfies readonly { value: PaletteName; label: string }[];

export const VIEW_OPTIONS = [
  { value: "full", label: "Full frame" },
  { value: "circle", label: "Circle" },
] as const satisfies readonly { value: ViewName; label: string }[];

/** View rotation limit, degrees per second either way. */
export const ROTATION_MAX = 12;

export const kaleidoMeta = defineEffectMeta({
  id: "kaleido",
  name: "Kaleidoscope",
  description:
    "Coloured glass chips, beads and rods tumble slowly in a kaleidoscope's chamber while mirrors repeat them into a turning, ever-changing mandala.",
  params: {
    segments: { kind: "select", label: "Segments", options: SEGMENT_OPTIONS, default: "8" },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "jewel" },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    rotation: {
      kind: "number",
      label: "Rotation (°/s)",
      min: -ROTATION_MAX,
      max: ROTATION_MAX,
      step: 0.5,
      default: 2,
    },
    view: { kind: "select", label: "View", options: VIEW_OPTIONS, default: "full" },
    contrast: { kind: "number", label: "Contrast", min: 0, max: 1, step: 0.05, default: 0.8 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 5 },
  },
  category: "Abstract",
  tags: ["mandala", "mirror", "symmetry", "stained glass", "psychedelic", "toy", "pattern"],
  cost: "very low",
  context: "webgl2",
});
