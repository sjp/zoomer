import { defineEffectMeta } from "./types";

export const MAX_POINTS = 400;

export const constellationMeta = defineEffectMeta({
  id: "constellation",
  name: "Constellation Network",
  description:
    "Slowly drifting points joined by fine lines that fade in and out with distance, the classic plexus tech background.",
  params: {
    count: { kind: "number", label: "Points", min: 50, max: MAX_POINTS, step: 1, default: 140 },
    linkDistance: {
      kind: "number",
      label: "Link distance (fraction of height)",
      min: 0.05,
      max: 0.3,
      step: 0.005,
      default: 0.17,
    },
    speed: { kind: "number", label: "Drift speed", min: 0, max: 4, step: 0.05, default: 0.8 },
    depth: { kind: "number", label: "Depth", min: 0, max: 1, step: 0.01, default: 0.6 },
    pointSize: { kind: "number", label: "Point size", min: 0.5, max: 6, step: 0.1, default: 2.2 },
    lineWidth: { kind: "number", label: "Line width", min: 0.25, max: 3, step: 0.05, default: 1 },
    lineOpacity: {
      kind: "number",
      label: "Line opacity",
      min: 0.05,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    pointColor: { kind: "color", label: "Point colour", default: "#d6ecff" },
    lineColor: { kind: "color", label: "Line colour", default: "#5aa9ff" },
    backgroundTop: { kind: "color", label: "Background top colour", default: "#040814" },
    backgroundBottom: { kind: "color", label: "Background bottom colour", default: "#0b1a33" },
  },
  category: "Abstract",
  tags: ["nodes", "connections", "web", "dots", "corporate"],
  cost: "low",
  context: "webgl2",
});
