import { defineEffectMeta } from "./types";

/** Plants (vines) alive at once; also the density param's maximum. */
export const MAX_PLANTS = 10;

export const vinesMeta = defineEffectMeta({
  id: "vines",
  name: "Creeping Vines",
  description:
    "Leafy vines that slowly grow in from the edges, flower, then wither and drop their leaves.",
  params: {
    plant: {
      kind: "select",
      label: "Plant",
      options: [
        { value: "ivy", label: "Ivy" },
        { value: "morningGlory", label: "Morning glory" },
        { value: "wisteria", label: "Wisteria" },
      ],
      default: "ivy",
    },
    growth: { kind: "number", label: "Growth speed", min: 0.25, max: 3, step: 0.05, default: 1 },
    density: {
      kind: "number",
      label: "Vines at once",
      min: 1,
      max: MAX_PLANTS,
      step: 1,
      default: 5,
    },
    border: {
      kind: "number",
      label: "Reach in from the edges",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    flowers: { kind: "number", label: "Flowers", min: 0, max: 1, step: 0.01, default: 0.4 },
    wall: {
      kind: "select",
      label: "Wall",
      options: [
        { value: "painted", label: "Painted" },
        { value: "wood", label: "Wood panels" },
        { value: "dark", label: "Dark" },
      ],
      default: "painted",
    },
    background: { kind: "color", label: "Wall colour", default: "#d8cdb9" },
  },
  context: "webgl2",
});
