import type { MotionName, PaletteName, PatternName } from "./moire-sim";
import { defineEffectMeta } from "./types";

export const PATTERN_OPTIONS = [
  { value: "rings", label: "Rings" },
  { value: "lines", label: "Lines" },
  { value: "dots", label: "Dots" },
  { value: "ringslines", label: "Rings + lines" },
] as const satisfies readonly { value: PatternName; label: string }[];

export const LAYER_OPTIONS = [
  { value: "two", label: "Two" },
  { value: "three", label: "Three" },
] as const;

export const MOTION_OPTIONS = [
  { value: "rotate", label: "Rotate" },
  { value: "drift", label: "Drift" },
  { value: "breathe", label: "Breathe" },
] as const satisfies readonly { value: MotionName; label: string }[];

export const PALETTE_OPTIONS = [
  { value: "paper", label: "Paper" },
  { value: "slate", label: "Slate" },
  { value: "cream", label: "Cream" },
  { value: "opart", label: "Op art" },
] as const satisfies readonly { value: PaletteName; label: string }[];

export const moireMeta = defineEffectMeta({
  id: "moire",
  name: "Moiré Waves",
  description:
    "Overlaid rings, lines or dots turn and drift slowly against each other, and broad interference bands and rosettes ripple across them.",
  params: {
    pattern: { kind: "select", label: "Pattern", options: PATTERN_OPTIONS, default: "rings" },
    layers: { kind: "select", label: "Layers", options: LAYER_OPTIONS, default: "two" },
    spacing: {
      kind: "number",
      label: "Line spacing (px at 1080p)",
      min: 16,
      max: 80,
      step: 1,
      default: 28,
    },
    motion: { kind: "select", label: "Motion", options: MOTION_OPTIONS, default: "rotate" },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "paper" },
    contrast: { kind: "number", label: "Contrast", min: 0, max: 1, step: 0.01, default: 0.35 },
  },
  category: "Abstract",
  tags: ["op art", "interference", "optical illusion", "geometric", "pattern", "minimal"],
  cost: "very low",
  context: "webgl2",
});
