import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const inkMeta = defineEffectMeta({
  id: "ink",
  name: "Ink in Water",
  description: "Plumes of ink curling slowly through clear water, or an endless marbled swirl.",
  context: "webgl2",
  params: {
    mode: {
      kind: "select",
      label: "Mode",
      options: [
        { value: "drops", label: "Drops" },
        { value: "marbling", label: "Marbling" },
      ],
      default: "drops",
    },
    water: {
      kind: "select",
      label: "Water",
      options: [
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ],
      default: "light",
    },
    lightWater: { kind: "color", label: "Light water colour", default: "#f2f1ec" },
    darkWater: { kind: "color", label: "Dark water colour", default: "#06080c" },
    color1: { kind: "color", label: "Ink 1", default: "#1b3b8c" },
    color2: { kind: "color", label: "Ink 2", default: "#b3204d" },
    color3: { kind: "color", label: "Ink 3", default: "#127a6c" },
    inks: { kind: "number", label: "Inks", min: 2, max: 3, step: 1, default: 3 },
    frequency: {
      kind: "number",
      label: "Drop frequency (drops only)",
      min: 0.25,
      max: 3,
      step: 0.05,
      default: 1,
    },
    turbulence: { kind: "number", label: "Turbulence", min: 0, max: 2, step: 0.05, default: 1 },
    detail: { kind: "number", label: "Detail", min: 0, max: 1, step: 0.05, default: 0.5 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
});
