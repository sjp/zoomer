import { defineEffectMeta } from "../types";

/** Code points the title card's one line may hold. */
const TITLE_MAX_LENGTH = 18;

const LIGHTING_OPTIONS = [
  { value: "lamp", label: "Lamp at night" },
  { value: "daylight", label: "Office daylight" },
] as const;

export const evidenceMeta = defineEffectMeta({
  id: "evidence",
  name: "Detective Evidence Board",
  description:
    "A wall-sized corkboard covered in an unsolved case: photos, index cards, newspaper clippings, a map and sticky notes, all tied together with red string between push pins, under the warm pool of a desk lamp. Every minute or two a new clue goes up.",
  params: {
    title: {
      kind: "text",
      label: "Title card (empty hides it)",
      default: "UNSOLVED",
      maxLength: TITLE_MAX_LENGTH,
      maxLines: 1,
    },
    lighting: { kind: "select", label: "Lighting", options: LIGHTING_OPTIONS, default: "lamp" },
    string: { kind: "color", label: "String", default: "#c4202b" },
    density: {
      kind: "number",
      label: "Items pinned up",
      // At most the layout's MAX_DENSITY.
      min: 15,
      max: 30,
      step: 1,
      default: 22,
    },
    grow: { kind: "boolean", label: "Case grows", default: true },
  },
  categories: ["Scenes", "Fun", "Work"],
  tags: [
    "detective",
    "evidence",
    "corkboard",
    "crime",
    "mystery",
    "investigation",
    "red string",
    "conspiracy",
  ],
  cost: "very low",
  context: "webgl2",
});
