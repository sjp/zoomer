import type { MouthName, PaletteName } from "./icecave-sim";
import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const COLOUR_OPTIONS = [
  { value: "glacier", label: "Glacier blue" },
  { value: "turquoise", label: "Turquoise" },
  { value: "deep", label: "Deep" },
] as const satisfies readonly { value: PaletteName; label: string }[];

export const MOUTH_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "far", label: "Far end" },
] as const satisfies readonly { value: MouthName; label: string }[];

export const icecaveMeta = defineEffectMeta({
  id: "icecave",
  name: "Ice Cave",
  description:
    "Inside a glacier: scalloped walls of translucent blue ice glowing where daylight filters through, slow ripples of light, meltwater dripping from icicles and a bright cave mouth.",
  params: {
    colour: { kind: "select", label: "Colour", options: COLOUR_OPTIONS, default: "glacier" },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, step: 0.01, default: 0.7 },
    drips: { kind: "number", label: "Drips", min: 0, max: 2, step: 0.05, default: 1 },
    mouth: { kind: "select", label: "Cave mouth", options: MOUTH_OPTIONS, default: "right" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Nature",
  tags: ["frozen", "winter", "iceland", "cold", "grotto", "tunnel", "polar", "calm"],
  cost: "low",
  context: "webgl2",
});
