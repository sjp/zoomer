import type { PaletteName, StyleName } from "./truchet-sim";
import { defineEffectMeta } from "./types";

export const PALETTE_OPTIONS = [
  { value: "slate", label: "Slate" },
  { value: "sand", label: "Sand" },
  { value: "ocean", label: "Ocean" },
  { value: "mono", label: "Monochrome" },
  { value: "neon", label: "Neon" },
] as const satisfies readonly { value: PaletteName; label: string }[];

export const STYLE_OPTIONS = [
  { value: "bands", label: "Bands" },
  { value: "outlines", label: "Outlines" },
  { value: "shaded", label: "Shaded" },
] as const satisfies readonly { value: StyleName; label: string }[];

/** Widest arc band, as a fraction of the tile: the two arcs of a tile touch at (sqrt(2) - 1) / 2 half width. */
export const BAND_WIDTH_MAX = 0.38;

export const truchetMeta = defineEffectMeta({
  id: "truchet",
  name: "Truchet Weave",
  description:
    "A calm grid of tiles whose quarter-circle arcs join into long winding paths; now and then a tile slowly turns and rewires the paths around it.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "slate" },
    tileSize: {
      kind: "number",
      label: "Tile size (px at 1080p)",
      min: 60,
      max: 180,
      step: 5,
      default: 110,
    },
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "bands" },
    bandWidth: {
      kind: "number",
      label: "Arc width",
      min: 0.08,
      max: BAND_WIDTH_MAX,
      step: 0.01,
      default: 0.2,
    },
    flipRate: {
      kind: "number",
      label: "Flips per second",
      min: 0,
      max: 3,
      step: 0.05,
      default: 0.5,
    },
    pathColors: { kind: "boolean", label: "Colour each path", default: true },
    calmCentre: { kind: "boolean", label: "Calm centre", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
  },
  category: "Abstract",
  tags: ["tiles", "pattern", "geometric", "maze", "professional", "minimal"],
  cost: "very low",
  context: "webgl2",
});
