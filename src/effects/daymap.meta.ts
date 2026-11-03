import { defineEffectMeta } from "./types";

export const daymapMeta = defineEffectMeta({
  id: "daymap",
  name: "Daylight World Map",
  description:
    "A world map with the real day and night: the soft shadow of night sweeps slowly across it with the clock.",
  params: {
    style: {
      kind: "select",
      label: "Style",
      options: [
        { value: "night", label: "Night blue" },
        { value: "paper", label: "Paper" },
        { value: "satellite", label: "Satellite-ish" },
      ],
      default: "night",
    },
    centre: { kind: "number", label: "Centre longitude", min: -180, max: 180, step: 5, default: 0 },
    twilight: {
      kind: "select",
      label: "Twilight",
      options: [
        { value: "smooth", label: "Smooth" },
        { value: "bands", label: "Bands" },
      ],
      default: "smooth",
    },
    cities: { kind: "boolean", label: "City lights", default: true },
    glow: { kind: "boolean", label: "Sun glow", default: true },
    moon: { kind: "boolean", label: "Moon marker", default: false },
    pins: {
      kind: "select",
      label: "City pins",
      options: [
        { value: "none", label: "None" },
        { value: "world", label: "SF, New York, London, Tokyo" },
        { value: "americas", label: "SF, Chicago, New York, São Paulo" },
        { value: "atlantic", label: "New York, São Paulo, London, Berlin" },
        { value: "asia", label: "Dubai, Mumbai, Singapore, Sydney" },
      ],
      default: "none",
    },
    grid: {
      kind: "select",
      label: "Lines",
      options: [
        { value: "none", label: "None" },
        { value: "dateline", label: "Date line" },
        { value: "graticule", label: "Graticule" },
      ],
      default: "none",
    },
    demo: { kind: "boolean", label: "Demo (one day a minute)", default: false },
  },
  context: "webgl2",
});
