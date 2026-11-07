import { defineEffectMeta } from "../types";

export const MIN_BALLOONS = 3;

export const MAX_BALLOONS = 10;

export const PALETTE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "pastel", label: "Pastel" },
  { value: "rainbow", label: "Rainbow" },
  { value: "mono", label: "Mono" },
] as const;

export const LIGHT_OPTIONS = [
  { value: "morning", label: "Morning" },
  { value: "midday", label: "Midday" },
  { value: "evening", label: "Evening" },
] as const;

export const balloonsMeta = defineEffectMeta({
  id: "balloons",
  name: "Hot-Air Balloons",
  description:
    "A handful of colourful hot-air balloons drifting slowly across a hazy valley, burners glowing now and then.",
  params: {
    count: {
      kind: "number",
      label: "Balloons",
      min: MIN_BALLOONS,
      max: MAX_BALLOONS,
      step: 1,
      default: 6,
    },
    palette: { kind: "select", label: "Colours", options: PALETTE_OPTIONS, default: "classic" },
    drift: { kind: "number", label: "Drift speed", min: 0, max: 3, step: 0.05, default: 1 },
    burners: { kind: "boolean", label: "Burner flashes", default: true },
    mist: { kind: "boolean", label: "Valley mist", default: true },
    light: { kind: "select", label: "Light", options: LIGHT_OPTIONS, default: "morning" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Sky & weather",
  tags: ["ballooning", "countryside", "cheerful", "flight", "festival", "landscape"],
  cost: "very low",
  context: "webgl2",
});
