import { defineEffectMeta } from "../types";

export const SCENE_IDS = ["hills", "ocean", "forest", "night"] as const;
/** Range of the `layers` param: the scenery layers, not counting sun, clouds and the like. */
export const MIN_LAYERS = 5;
export const MAX_LAYERS = 8;

export const PALETTE_IDS = ["scene", "sunset", "pastel", "autumn", "mono"] as const;

const SCENE_LABELS: Record<(typeof SCENE_IDS)[number], string> = {
  hills: "Hills",
  ocean: "Ocean",
  forest: "Forest",
  night: "Night",
};

const PALETTE_LABELS: Record<(typeof PALETTE_IDS)[number], string> = {
  scene: "Scene default",
  sunset: "Sunset",
  pastel: "Pastel",
  autumn: "Autumn",
  mono: "Monochrome",
};

export const papercutMeta = defineEffectMeta({
  id: "papercut",
  name: "Paper-cut Layers",
  description:
    "A layered paper-cut shadow box of hills, waves or forest, with soft shadows between the sheets.",
  params: {
    scene: {
      kind: "select",
      label: "Scene",
      options: SCENE_IDS.map((value) => ({ value, label: SCENE_LABELS[value] })),
      default: "hills",
    },
    palette: {
      kind: "select",
      label: "Palette",
      options: PALETTE_IDS.map((value) => ({ value, label: PALETTE_LABELS[value] })),
      default: "scene",
    },
    layers: {
      kind: "number",
      label: "Layers",
      min: MIN_LAYERS,
      max: MAX_LAYERS,
      step: 1,
      default: 6,
    },
    shadow: { kind: "number", label: "Shadow", min: 0, max: 1, step: 0.01, default: 0.6 },
    depth: { kind: "number", label: "Layer depth", min: 0.25, max: 2, step: 0.01, default: 1 },
    motion: { kind: "number", label: "Motion", min: 0, max: 1, step: 0.01, default: 0.5 },
    texture: { kind: "number", label: "Paper texture", min: 0, max: 1, step: 0.01, default: 0.5 },
  },
  category: "Nature",
  tags: ["papercraft", "diorama", "craft"],
  cost: "low",
  context: "webgl2",
});
