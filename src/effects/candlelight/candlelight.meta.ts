import { defineEffectMeta } from "../types";

export const LAYOUT_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "both", label: "Both sides" },
  { value: "row", label: "Row" },
] as const;

export const MAX_CANDLES = 7;

export const candlelightMeta = defineEffectMeta({
  id: "candlelight",
  name: "Candlelight",
  description: "A few candles in a dark room, their flames swaying gently and warm light pooling.",
  params: {
    candles: { kind: "number", label: "Candles", min: 1, max: MAX_CANDLES, step: 1, default: 5 },
    layout: { kind: "select", label: "Layout", options: LAYOUT_OPTIONS, default: "both" },
    waxColor: { kind: "color", label: "Wax colour", default: "#f2e4c8" },
    wallColor: { kind: "color", label: "Wall colour", default: "#3a2a22" },
    flicker: { kind: "number", label: "Flicker", min: 0, max: 1, step: 0.01, default: 0.5 },
    draft: { kind: "number", label: "Draft", min: 0, max: 1, step: 0.01, default: 0.3 },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, step: 0.01, default: 0.6 },
    reflection: { kind: "boolean", label: "Reflections", default: true },
  },
  category: "Cosy",
  tags: ["romantic", "candlelit", "cosy"],
  cost: "very low",
  context: "webgl2",
});
