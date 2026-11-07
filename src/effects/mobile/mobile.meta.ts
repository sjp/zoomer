import { defineEffectMeta } from "../types";

export const MIN_LEVELS = 2;
export const MAX_LEVELS = 4;

export const PALETTE_OPTIONS = [
  { value: "primary", label: "Primary" },
  { value: "mono", label: "Monochrome" },
  { value: "pastel", label: "Pastel" },
  { value: "earth", label: "Earth" },
] as const;
export type MobilePaletteId = (typeof PALETTE_OPTIONS)[number]["value"];

export const SIDE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "across", label: "Across" },
] as const;
export type MobileSide = (typeof SIDE_OPTIONS)[number]["value"];

export const mobileMeta = defineEffectMeta({
  id: "mobile",
  name: "Hanging Mobile",
  description:
    "A balanced mobile of wire arms and flat coloured shapes turning slowly in the air, casting soft shadows on a pale wall.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "primary" },
    levels: {
      kind: "number",
      label: "Levels",
      min: MIN_LEVELS,
      max: MAX_LEVELS,
      step: 1,
      default: 3,
    },
    draught: { kind: "number", label: "Draught", min: 0, max: 1, step: 0.05, default: 0.4 },
    wall: { kind: "color", label: "Wall", default: "#ece6da" },
    side: { kind: "select", label: "Hanging", options: SIDE_OPTIONS, default: "right" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Abstract",
  tags: ["calder", "kinetic", "sculpture", "mid-century", "modern art", "balance", "minimal"],
  cost: "very low",
  context: "webgl2",
});
