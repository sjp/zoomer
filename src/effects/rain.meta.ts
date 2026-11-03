import { defineEffectMeta } from "./types";

export const rainMeta = defineEffectMeta({
  id: "rain",
  name: "Digital Rain",
  description: "Cascading columns of glowing glyphs.",
  params: {
    fontSize: { kind: "number", label: "Glyph size", min: 8, max: 48, step: 1, default: 20 },
    speed: { kind: "number", label: "Speed", min: 1, max: 40, step: 0.5, default: 14 },
    density: { kind: "number", label: "Density", min: 0.05, max: 1, step: 0.01, default: 0.7 },
    fade: { kind: "number", label: "Trail fade", min: 0.03, max: 0.3, step: 0.005, default: 0.07 },
    charset: {
      kind: "select",
      label: "Characters",
      options: [
        { value: "katakana", label: "Katakana" },
        { value: "binary", label: "Binary" },
        { value: "hex", label: "Hex" },
        { value: "latin", label: "Latin" },
      ],
      default: "katakana",
    },
    color: { kind: "color", label: "Glyph colour", default: "#00ff66" },
    brightHead: { kind: "boolean", label: "Bright leading glyph", default: true },
    background: { kind: "color", label: "Background", default: "#000000" },
  },
  category: "Retro",
  tags: ["matrix", "code", "hacker", "green", "terminal"],
  cost: "low",
  context: "webgl2",
});
