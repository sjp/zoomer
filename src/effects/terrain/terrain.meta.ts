import type { PaletteId } from "./terrain-sim";
import { defineEffectMeta } from "../types";

export const PALETTE_OPTIONS = [
  { value: "alpine", label: "Alpine" },
  { value: "desert", label: "Desert" },
  { value: "autumn", label: "Autumn" },
  { value: "alien", label: "Alien" },
] as const satisfies readonly { value: PaletteId; label: string }[];

export const terrainMeta = defineEffectMeta({
  id: "terrain",
  name: "Low-Poly Terrain",
  description: "A slow flight over faceted low-poly hills and lakes, fading into the haze.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "alpine" },
    skyTop: { kind: "color", label: "Sky colour", default: "#4a7fc1" },
    fog: { kind: "color", label: "Horizon and fog colour", default: "#cfdbe6" },
    fogDensity: { kind: "number", label: "Fog density", min: 0, max: 1, step: 0.01, default: 0.35 },
    roughness: { kind: "number", label: "Roughness", min: 0, max: 1, step: 0.01, default: 0.5 },
    water: { kind: "number", label: "Water level", min: 0, max: 1, step: 0.01, default: 0.35 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    seed: { kind: "number", label: "Seed", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Nature",
  tags: ["landscape", "flyover", "polygon", "mountains"],
  cost: "low",
  context: "webgl2",
});
