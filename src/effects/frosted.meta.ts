import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const GLASS_OPTIONS = [
  { value: "frosted", label: "Frosted" },
  { value: "reeded", label: "Reeded" },
  { value: "clear", label: "Clear-ish" },
] as const;

export const MAX_SHAPES = 5;

export const PALETTE_OPTIONS = [
  { value: "dusk", label: "Dusk" },
  { value: "lagoon", label: "Lagoon" },
  { value: "orchid", label: "Orchid" },
  { value: "ember", label: "Ember" },
  { value: "slate", label: "Slate" },
  { value: "custom", label: "Custom" },
] as const;

export const frostedMeta = defineEffectMeta({
  id: "frosted",
  name: "Frosted Glass",
  description: "Soft colour shapes drifting behind frosted or reeded glass. Very low power.",
  params: {
    glass: { kind: "select", label: "Glass", options: GLASS_OPTIONS, default: "frosted" },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "dusk" },
    color1: { kind: "color", label: "Colour 1 (custom)", default: "#ff5e7a" },
    color2: { kind: "color", label: "Colour 2 (custom)", default: "#7b4dff" },
    color3: { kind: "color", label: "Colour 3 (custom)", default: "#ffb347" },
    background: { kind: "color", label: "Background", default: "#120e24" },
    shapes: { kind: "number", label: "Shapes", min: 2, max: MAX_SHAPES, step: 1, default: 4 },
    blur: { kind: "number", label: "Blur", min: 0, max: 1, step: 0.01, default: 0.55 },
    fluteWidth: {
      kind: "number",
      label: "Flute width (reeded)",
      min: 30,
      max: 60,
      step: 1,
      default: 42,
    },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    frost: { kind: "number", label: "Frost", min: 0, max: 1, step: 0.01, default: 0.5 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Abstract",
  tags: ["blur", "minimal", "gradient", "frost"],
  cost: "very low",
  context: "webgl2",
});
