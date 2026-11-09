import { defineEffectMeta } from "../types";

export const SHAPE_OPTIONS = [
  { value: "tesseract", label: "Tesseract" },
  { value: "cell16", label: "16-cell" },
  { value: "cell24", label: "24-cell" },
  { value: "cell120", label: "120-cell" },
] as const;

export type PolytopeShape = (typeof SHAPE_OPTIONS)[number]["value"];

const COLOUR_OPTIONS = [
  { value: "cyan", label: "Cyan" },
  { value: "magenta", label: "Magenta" },
  { value: "white", label: "White" },
  { value: "rainbow", label: "Depth rainbow" },
] as const;

const POSITION_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "centre", label: "Centre" },
] as const;

export const tesseractMeta = defineEffectMeta({
  id: "tesseract",
  name: "Rotating Tesseract",
  description:
    "A glowing wireframe hypercube turning slowly through four dimensions, its inner cube endlessly folding out to become the outer one.",
  params: {
    shape: { kind: "select", label: "Shape", options: SHAPE_OPTIONS, default: "tesseract" },
    speed: { kind: "number", label: "Rotation speed", min: 0, max: 3, step: 0.05, default: 1 },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, step: 0.01, default: 0.6 },
    colour: { kind: "select", label: "Colour", options: COLOUR_OPTIONS, default: "cyan" },
    position: { kind: "select", label: "Position", options: POSITION_OPTIONS, default: "right" },
  },
  category: "Science",
  tags: ["4d", "hypercube", "polytope", "geometry", "wireframe", "maths", "sci-fi"],
  cost: "very low",
  context: "webgl2",
});
