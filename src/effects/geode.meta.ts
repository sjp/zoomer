import type { MineralName, SideName } from "./geode-sim";
import { defineEffectMeta } from "./types";

export const MINERAL_OPTIONS = [
  { value: "amethyst", label: "Amethyst" },
  { value: "citrine", label: "Citrine" },
  { value: "quartz", label: "Quartz" },
  { value: "celestine", label: "Celestine" },
] as const satisfies readonly { value: MineralName; label: string }[];

export const SIDE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "corner", label: "Bottom corner" },
] as const satisfies readonly { value: SideName; label: string }[];

export const geodeMeta = defineEffectMeta({
  id: "geode",
  name: "Geode",
  description:
    "A split amethyst geode lined with hundreds of crystal points whose faces glint in turn as a soft light circles, ringed by faintly glowing bands of agate.",
  params: {
    mineral: { kind: "select", label: "Mineral", options: MINERAL_OPTIONS, default: "amethyst" },
    light: { kind: "number", label: "Light speed", min: 0, max: 3, step: 0.05, default: 1 },
    glint: { kind: "number", label: "Glint", min: 0, max: 1, step: 0.01, default: 0.7 },
    size: { kind: "number", label: "Size", min: 0.5, max: 1.2, step: 0.01, default: 0.85 },
    side: { kind: "select", label: "Side", options: SIDE_OPTIONS, default: "left" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
  },
  category: "Nature",
  tags: ["crystal", "crystals", "mineral", "gemstone", "quartz", "agate", "rock", "purple", "calm"],
  cost: "low",
  context: "webgl2",
});
