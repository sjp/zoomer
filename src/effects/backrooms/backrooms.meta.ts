import { defineEffectMeta } from "../types";

type BackroomsStyle = "footage" | "clean";

/** Walking-pace slider range; 1 is about a cell (two ceiling tiles) every 0.8 s. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 2;

const STYLE_OPTIONS = [
  { value: "footage", label: "Found footage" },
  { value: "clean", label: "Clean" },
] as const satisfies readonly { value: BackroomsStyle; label: string }[];

export const backroomsMeta = defineEffectMeta({
  id: "backrooms",
  name: "The Backrooms",
  description:
    "A slow first-person drift through an endless maze of empty office rooms: mono-yellow wallpaper, damp carpet and humming fluorescent panels, the far rooms dissolving into a pale yellow haze.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "footage" },
    speed: {
      kind: "number",
      label: "Walking pace",
      min: MIN_SPEED,
      max: MAX_SPEED,
      step: 0.05,
      default: 1,
    },
    flicker: { kind: "number", label: "Flicker", min: 0, max: 1, step: 0.05, default: 0.4 },
    haze: { kind: "number", label: "Haze", min: 0, max: 1, step: 0.05, default: 0.5 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Fun", "Retro"],
  tags: [
    "meme",
    "liminal",
    "level 0",
    "first person",
    "creepypasta",
    "endless",
    "found footage",
    "camcorder",
    "eerie",
  ],
  cost: "low",
  context: "webgl2",
});
