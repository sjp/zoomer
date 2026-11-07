import { defineEffectMeta } from "../types";

export const SCENE_OPTIONS = [
  { value: "lights", label: "Twilight lights" },
  { value: "trees", label: "Snowy trees" },
  { value: "plain", label: "Plain" },
] as const;

/** Range of the `growth` param: a multiplier on the whole grow / hold / melt cycle. */
export const MIN_GROWTH = 0.25;
export const MAX_GROWTH = 4;

export const frostMeta = defineEffectMeta({
  id: "frost",
  name: "Frost Ferns",
  description:
    "Feathery ice crystals slowly grow across a cold window from its edges, then melt and regrow in a new pattern.",
  params: {
    scene: { kind: "select", label: "Behind the glass", options: SCENE_OPTIONS, default: "lights" },
    coverage: { kind: "number", label: "Coverage", min: 0, max: 1, step: 0.01, default: 0.75 },
    growth: {
      kind: "number",
      label: "Growth speed",
      min: MIN_GROWTH,
      max: MAX_GROWTH,
      step: 0.05,
      default: 1,
    },
    cycle: { kind: "boolean", label: "Melt and regrow", default: true },
    sparkle: { kind: "number", label: "Sparkle", min: 0, max: 1, step: 0.01, default: 0.4 },
    tint: { kind: "color", label: "Ice tint", default: "#d6ebff" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Sky & weather",
  tags: ["winter", "ice", "frozen", "cold", "crystals", "snow", "christmas", "cosy", "dendrites"],
  cost: "low",
  context: "webgl2",
});
