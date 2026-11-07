import type { CentreName, PaletteName } from "./quasi-sim";
import { defineEffectMeta } from "../types";

export const SYMMETRY_OPTIONS = [
  { value: "5", label: "5-fold" },
  { value: "7", label: "7-fold" },
  { value: "9", label: "9-fold" },
  { value: "11", label: "11-fold" },
] as const;

export const PALETTE_OPTIONS = [
  { value: "pastel", label: "Pastel" },
  { value: "jewel", label: "Jewel" },
  { value: "mono", label: "Mono" },
  { value: "sunset", label: "Sunset" },
] as const satisfies readonly { value: PaletteName; label: string }[];

export const CENTRE_OPTIONS = [
  { value: "centre", label: "Centre" },
  { value: "offcentre", label: "Off-centre" },
  { value: "drifting", label: "Drifting" },
] as const satisfies readonly { value: CentreName; label: string }[];

export const quasiMeta = defineEffectMeta({
  id: "quasi",
  name: "Quasicrystal",
  description:
    "Plane waves at evenly spaced angles add up to a soft pattern that never repeats, with rosettes blooming and dissolving as it flows. Very low power.",
  params: {
    symmetry: { kind: "select", label: "Symmetry", options: SYMMETRY_OPTIONS, default: "7" },
    scale: {
      kind: "number",
      label: "Wavelength (px at 1080p)",
      min: 40,
      max: 260,
      step: 1,
      default: 120,
    },
    speed: {
      kind: "number",
      label: "Speed (negative reverses)",
      min: -2,
      max: 2,
      step: 0.05,
      default: 0.5,
    },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "pastel" },
    contrast: { kind: "number", label: "Contrast", min: 0, max: 1, step: 0.01, default: 0.45 },
    centre: { kind: "select", label: "Centre", options: CENTRE_OPTIONS, default: "offcentre" },
  },
  category: "Abstract",
  tags: ["penrose", "interference", "symmetry", "mandala", "geometric", "pattern", "math"],
  cost: "very low",
  context: "webgl2",
});
