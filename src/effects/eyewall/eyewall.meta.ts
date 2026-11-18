import { defineEffectMeta } from "../types";

const IRIS_OPTIONS = [
  { value: "mixed", label: "Mixed" },
  { value: "brown", label: "Brown" },
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "pale", label: "Pale" },
] as const;

const SURFACE_OPTIONS = [
  { value: "shadow", label: "Shadow" },
  { value: "flesh", label: "Flesh" },
  { value: "bark", label: "Bark" },
] as const;

export const eyewallMeta = defineEffectMeta({
  id: "eyewall",
  name: "Eye Wall",
  description:
    "A dark wall packed with eyes of every size, all watching a point that drifts slowly round the middle of the frame. Each blinks in its own time; now and then they all blink together, or turn to stare straight out at you.",
  params: {
    density: { kind: "number", label: "Eyes", min: 0, max: 1, step: 0.05, default: 0.75 },
    clearing: {
      kind: "number",
      label: "Clearing round you",
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.5,
    },
    iris: { kind: "select", label: "Iris colour", options: IRIS_OPTIONS, default: "mixed" },
    surface: { kind: "select", label: "Surface", options: SURFACE_OPTIONS, default: "shadow" },
    blink: { kind: "number", label: "Blinking", min: 0, max: 1, step: 0.05, default: 0.5 },
    events: {
      kind: "number",
      label: "Eerie moments",
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.4,
    },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Fun", "Abstract"],
  tags: ["creepy", "eyes", "watching", "horror", "halloween", "spooky", "uncanny", "blink"],
  cost: "low",
  context: "webgl2",
});
