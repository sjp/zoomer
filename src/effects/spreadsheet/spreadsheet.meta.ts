import { defineEffectMeta } from "../types";

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

const CHART_OPTIONS = [
  { value: "bar", label: "Bar" },
  { value: "line", label: "Line" },
  { value: "none", label: "None" },
] as const;

/** Seconds between edits. */
export const MIN_PACE = 2;
export const MAX_PACE = 12;

/** Cell size, as a multiple of the 1080p default. */
export const MIN_ZOOM = 0.8;
export const MAX_ZOOM = 1.6;

export const spreadsheetMeta = defineEffectMeta({
  id: "spreadsheet",
  name: "Spreadsheet",
  description:
    "A pale grid of cells filling in slowly, as if someone off-screen were typing in figures: totals recalculate, a small chart follows along, and the middle stays calm.",
  params: {
    theme: { kind: "select", label: "Theme", options: THEME_OPTIONS, default: "light" },
    accent: { kind: "color", label: "Accent", default: "#3f8a5f" },
    pace: {
      kind: "number",
      label: "Seconds per edit",
      min: MIN_PACE,
      max: MAX_PACE,
      step: 0.5,
      default: 4,
    },
    chart: { kind: "select", label: "Chart", options: CHART_OPTIONS, default: "bar" },
    zoom: {
      kind: "number",
      label: "Cell size",
      min: MIN_ZOOM,
      max: MAX_ZOOM,
      step: 0.05,
      default: 1,
    },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Work"],
  tags: ["excel", "office", "numbers", "accounts", "budget", "cells", "finance", "accounting"],
  cost: "very low",
  context: "webgl2",
});
