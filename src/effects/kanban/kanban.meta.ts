import { defineEffectMeta } from "../types";

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

const COLUMN_OPTIONS = [
  { value: "classic", label: "Backlog / To do / In progress / Done" },
  { value: "simple", label: "To do / Doing / Done" },
  { value: "product", label: "Ideas / Next / Now / Shipped" },
] as const;

const STYLE_OPTIONS = [
  { value: "cards", label: "Cards" },
  { value: "sticky", label: "Sticky notes" },
] as const;

/** Column names for each `columns` option, first to last. */
export const COLUMN_SETS: Readonly<Record<string, readonly string[]>> = {
  classic: ["Backlog", "To do", "In progress", "Done"],
  simple: ["To do", "Doing", "Done"],
  product: ["Ideas", "Next", "Now", "Shipped"],
};

/** Seconds between card moves. */
export const MIN_PACE = 4;
export const MAX_PACE = 30;

/** Longest board title, in code points. */
const TITLE_MAX_LENGTH = 32;

export const kanbanMeta = defineEffectMeta({
  id: "kanban",
  name: "Kanban Board",
  description:
    "A project board of task cards in columns. Every so often a card lifts and glides on to the next column as work gets done, new tasks arrive in the backlog and finished ones are archived.",
  params: {
    theme: { kind: "select", label: "Theme", options: THEME_OPTIONS, default: "light" },
    columns: { kind: "select", label: "Columns", options: COLUMN_OPTIONS, default: "classic" },
    pace: {
      kind: "number",
      label: "Seconds between moves",
      min: MIN_PACE,
      max: MAX_PACE,
      step: 1,
      default: 8,
    },
    title: {
      kind: "text",
      label: "Title",
      default: "Sprint Board",
      maxLength: TITLE_MAX_LENGTH,
      maxLines: 1,
    },
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "cards" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Work"],
  tags: ["agile", "sprint", "scrum", "project", "trello", "sticky notes", "todo", "workflow"],
  cost: "very low",
  context: "webgl2",
});
