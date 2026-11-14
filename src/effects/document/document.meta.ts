import { defineEffectMeta } from "../types";

const LAYOUT_OPTIONS = [
  { value: "page", label: "Page" },
  { value: "margins", label: "Margins" },
] as const;

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

/** Typing speed, characters per second. */
export const MIN_SPEED = 2;
export const MAX_SPEED = 20;

/** Longest title, in code points. */
const TITLE_MAX_LENGTH = 40;

export const documentMeta = defineEffectMeta({
  id: "document",
  name: "Document Page",
  description:
    "A word-processor page quietly writing itself: paragraphs, headings, lists and small tables type out at a human pace, with a slow caret, the odd correction and margin comments.",
  params: {
    layout: { kind: "select", label: "Layout", options: LAYOUT_OPTIONS, default: "page" },
    theme: { kind: "select", label: "Theme", options: THEME_OPTIONS, default: "light" },
    speed: {
      kind: "number",
      label: "Characters per second",
      min: MIN_SPEED,
      max: MAX_SPEED,
      step: 1,
      default: 8,
    },
    comments: { kind: "boolean", label: "Comments", default: true },
    title: {
      kind: "text",
      label: "Title",
      default: "Quarterly Report",
      maxLength: TITLE_MAX_LENGTH,
      maxLines: 1,
    },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Work"],
  tags: ["word", "office", "memo", "report", "typing", "essay", "text editor", "draft"],
  cost: "very low",
  context: "webgl2",
});
