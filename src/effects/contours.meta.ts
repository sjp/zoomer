import { defineEffectMeta } from "./types";

export const contoursMeta = defineEffectMeta({
  id: "contours",
  name: "Topographic Contours",
  description:
    "A calm topographic map whose contour lines slowly breathe and drift, with optional elevation tint.",
  params: {
    lineColor: { kind: "color", label: "Line colour", default: "#8fbac6" },
    background: { kind: "color", label: "Background", default: "#0e1b21" },
    fill: {
      kind: "select",
      label: "Elevation fill",
      options: [
        { value: "none", label: "None" },
        { value: "bands", label: "Bands" },
        { value: "smooth", label: "Smooth" },
      ],
      default: "smooth",
    },
    lowColor: { kind: "color", label: "Low colour", default: "#0c1a20" },
    highColor: { kind: "color", label: "High colour", default: "#22414b" },
    levels: { kind: "number", label: "Contour levels", min: 4, max: 40, step: 1, default: 16 },
    lineWidth: {
      kind: "number",
      label: "Line width (px at 1080p)",
      min: 0.5,
      max: 4,
      step: 0.1,
      default: 1.2,
    },
    indexEvery: {
      kind: "number",
      label: "Index contour every (0 = off)",
      min: 0,
      max: 10,
      step: 1,
      default: 5,
    },
    scale: { kind: "number", label: "Terrain size", min: 0.2, max: 2, step: 0.05, default: 0.8 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 0.5 },
    sampling: {
      kind: "select",
      label: "Line smoothing",
      options: [
        { value: "bspline", label: "Smooth (B-spline)" },
        { value: "bilinear", label: "Fast (bilinear)" },
      ],
      default: "bspline",
    },
  },
  category: "Abstract",
  tags: ["terrain", "cartography", "topo"],
  cost: "low",
  context: "webgl2",
});
