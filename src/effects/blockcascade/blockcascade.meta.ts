import { defineEffectMeta } from "../types";

const WELLS_OPTIONS = [
  { value: "two", label: "Two" },
  { value: "one", label: "One" },
] as const;

const STYLE_OPTIONS = [
  { value: "glass", label: "Glass" },
  { value: "pixel", label: "Pixel" },
  { value: "neon", label: "Neon" },
] as const;

const PALETTE_OPTIONS = [
  { value: "candy", label: "Candy" },
  { value: "pastel", label: "Pastel" },
  { value: "ocean", label: "Ocean" },
  { value: "mono", label: "Mono" },
] as const;

/** The speed slider's range, rows a second (capped further for the codec). */
export const MIN_SPEED = 1;
export const MAX_SPEED = 6;

export const blockCascadeMeta = defineEffectMeta({
  id: "blockcascade",
  name: "Block Cascade",
  description:
    "A falling-block puzzle playing itself, calmly and well: pieces of one to five blocks drop into two wells at the sides, full rows glow and clear, and the scores tick up. It never ends.",
  params: {
    wells: { kind: "select", label: "Wells", options: WELLS_OPTIONS, default: "two" },
    style: { kind: "select", label: "Blocks", options: STYLE_OPTIONS, default: "glass" },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "candy" },
    speed: {
      kind: "number",
      label: "Speed",
      min: MIN_SPEED,
      max: MAX_SPEED,
      step: 0.5,
      default: 2,
    },
    skill: { kind: "number", label: "Skill", min: 0, max: 1, step: 0.05, default: 0.7 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Games", "Geometric", "Calm"],
  tags: ["falling blocks", "block game", "line clear", "polyomino", "idle", "retro gaming"],
  cost: "very low",
  context: "webgl2",
});
