import { defineEffectMeta } from "../types";

/** Most strings (swags) or strands per side minus one (curtain). */
export const MAX_STRINGS = 4;

export const PALETTE_OPTIONS = [
  { value: "warm", label: "Warm white" },
  { value: "vintage", label: "Vintage" },
  { value: "cool", label: "Cool white" },
  { value: "gold", label: "Gold" },
] as const;

export const LAYOUT_OPTIONS = [
  { value: "swags", label: "Swags" },
  { value: "curtain", label: "Curtain" },
  { value: "both", label: "Both" },
] as const;

export const PATTERN_OPTIONS = [
  { value: "twinkle", label: "Twinkle" },
  { value: "chase", label: "Slow chase" },
  { value: "steady", label: "Steady" },
] as const;

export const fairylightsMeta = defineEffectMeta({
  id: "fairylights",
  name: "Fairy Lights",
  description:
    "Strings of small warm bulbs draped in soft swags across the top of a dark wall, twinkling slowly, the far ones blurred into bokeh.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "warm" },
    strings: { kind: "number", label: "Strings", min: 1, max: MAX_STRINGS, step: 1, default: 3 },
    layout: { kind: "select", label: "Layout", options: LAYOUT_OPTIONS, default: "swags" },
    twinkle: { kind: "number", label: "Twinkle", min: 0, max: 1, step: 0.01, default: 0.6 },
    pattern: { kind: "select", label: "Pattern", options: PATTERN_OPTIONS, default: "twinkle" },
    wall: { kind: "color", label: "Wall colour", default: "#1d1512" },
    focus: { kind: "number", label: "Background blur", min: 0, max: 1, step: 0.01, default: 0.7 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 12 },
  },
  category: "Cosy",
  tags: ["christmas", "festive", "string lights", "garland", "party", "bokeh", "holiday"],
  cost: "very low",
  context: "webgl2",
});
