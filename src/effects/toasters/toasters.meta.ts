import { defineEffectMeta } from "../types";

export const MAX_TOASTERS = 20;
export const MAX_TOAST = 20;
/** Flight speed slider limit, as a multiple of the default cruising speed. */
export const MAX_SPEED = 3;

const STYLE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "modern", label: "Modern" },
] as const;

export const DONENESS_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "golden", label: "Golden" },
  { value: "dark", label: "Dark" },
  { value: "mixed", label: "Mixed" },
] as const;

export const toastersMeta = defineEffectMeta({
  id: "toasters",
  name: "Flying Toasters",
  description:
    "Chrome toasters on white feathered wings flap across a black sky with slices of toast, down and to the left.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "classic" },
    toasters: {
      kind: "number",
      label: "Toasters",
      min: 3,
      max: MAX_TOASTERS,
      step: 1,
      default: 10,
    },
    toast: { kind: "number", label: "Toast", min: 0, max: MAX_TOAST, step: 1, default: 6 },
    doneness: { kind: "select", label: "Doneness", options: DONENESS_OPTIONS, default: "mixed" },
    speed: { kind: "number", label: "Speed", min: 0, max: MAX_SPEED, step: 0.05, default: 1 },
    background: { kind: "color", label: "Background", default: "#000000" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  category: "Retro",
  tags: ["screensaver", "after dark", "wings", "bread", "mac", "90s", "kitchen"],
  cost: "very low",
  context: "webgl2",
});
