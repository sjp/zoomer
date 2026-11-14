import { defineEffectMeta } from "../types";

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

const PALETTE_OPTIONS = [
  { value: "cool", label: "Cool" },
  { value: "warm", label: "Warm" },
  { value: "mono", label: "Mono" },
] as const;

const DENSITY_OPTIONS = [
  { value: "simple", label: "Simple" },
  { value: "full", label: "Full" },
] as const;

/** Seconds between updates. */
export const MIN_PACE = 1;
export const MAX_PACE = 10;

/** Longest title, in code points. */
const TITLE_MAX_LENGTH = 40;

export const dashboardMeta = defineEffectMeta({
  id: "dashboard",
  name: "Dashboard",
  description:
    "A calm business dashboard for a made-up company: KPI tiles that count to new figures, a line chart that steps along a day at a time, bars, a donut and a top-items table, all updating gently.",
  params: {
    theme: { kind: "select", label: "Theme", options: THEME_OPTIONS, default: "dark" },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "cool" },
    pace: {
      kind: "number",
      label: "Seconds per update",
      min: MIN_PACE,
      max: MAX_PACE,
      step: 0.5,
      default: 3,
    },
    density: { kind: "select", label: "Density", options: DENSITY_OPTIONS, default: "full" },
    title: {
      kind: "text",
      label: "Title",
      default: "Weekly Overview",
      maxLength: TITLE_MAX_LENGTH,
      maxLines: 1,
    },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Work"],
  tags: ["analytics", "kpi", "charts", "metrics", "report", "data", "business", "office", "bi"],
  cost: "very low",
  context: "webgl2",
});
