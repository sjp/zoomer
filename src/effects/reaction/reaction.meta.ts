import { defineEffectMeta } from "../types";

export const PATTERN_OPTIONS = [
  { value: "coral", label: "Coral" },
  { value: "spots", label: "Spots" },
  { value: "stripes", label: "Stripes" },
  { value: "labyrinth", label: "Labyrinth" },
  { value: "mitosis", label: "Mitosis" },
] as const;

export const reactionMeta = defineEffectMeta({
  id: "reaction",
  name: "Reaction–Diffusion",
  description: "Living Turing patterns (coral, spots, stripes, mazes) slowly grow and reorganise.",
  params: {
    pattern: { kind: "select", label: "Pattern", options: PATTERN_OPTIONS, default: "coral" },
    color1: { kind: "color", label: "Colour 1 (background)", default: "#0a1224" },
    color2: { kind: "color", label: "Colour 2", default: "#1f6f8b" },
    color3: { kind: "color", label: "Colour 3", default: "#f2d89b" },
    scale: { kind: "number", label: "Feature size", min: 2, max: 6, step: 0.25, default: 3 },
    speed: { kind: "number", label: "Speed (steps/s)", min: 0, max: 960, step: 10, default: 240 },
    drift: { kind: "number", label: "Drift", min: 0, max: 1, step: 0.01, default: 0.5 },
    emboss: { kind: "number", label: "Emboss", min: 0, max: 1, step: 0.01, default: 0.5 },
    regrow: { kind: "boolean", label: "Retreat and regrow when complete", default: true },
    hold: {
      kind: "number",
      label: "Hold before retreating (s)",
      min: 0,
      max: 120,
      step: 1,
      default: 10,
    },
    reseed: { kind: "boolean", label: "Reseed (toggle)", default: false },
  },
  category: "Science",
  tags: ["biology", "simulation", "organic", "morphogenesis"],
  cost: "medium",
  context: "webgl2",
});
