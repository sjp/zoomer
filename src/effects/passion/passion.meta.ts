import { defineEffectMeta } from "../types";

const STYLE_OPTIONS = [
  { value: "meme", label: "Meme" },
  { value: "wordart", label: "WordArt" },
] as const;

/** The clip-art animals, in the order the critter atlas stacks them. */
export const CRITTER_OPTIONS = [
  { value: "frog", label: "Frog" },
  { value: "cat", label: "Cat" },
  { value: "dog", label: "Dog" },
  { value: "duck", label: "Duck" },
  { value: "bunny", label: "Bunny" },
  { value: "turtle", label: "Turtle" },
] as const;

export type CritterId = (typeof CRITTER_OPTIONS)[number]["value"];

const SIDE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "none", label: "None" },
] as const;

/** Caption lines, and code points per line. */
export const CAPTION_LINES = 2;
export const CAPTION_LENGTH = 28;

export const passionMeta = defineEffectMeta({
  id: "passion",
  name: "Graphic Design Is My Passion",
  description:
    "A proudly awful clip-art composition: a banded blue sky, chunky clouds, a friendly animal on bright green grass and a caption in clashing colours, gently bobbing.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "meme" },
    text: {
      kind: "text",
      label: "Caption",
      default: "graphic design is my passion",
      maxLength: CAPTION_LENGTH,
      maxLines: CAPTION_LINES,
    },
    critter: { kind: "select", label: "Critter", options: CRITTER_OPTIONS, default: "frog" },
    side: { kind: "select", label: "Critter side", options: SIDE_OPTIONS, default: "right" },
    extras: { kind: "boolean", label: "Flare and sparkles", default: false },
    motion: { kind: "number", label: "Motion", min: 0, max: 1, step: 0.05, default: 1 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  category: "Retro",
  tags: [
    "meme",
    "clip art",
    "wordart",
    "papyrus",
    "comic sans",
    "frog",
    "animals",
    "ironic",
    "2000s",
  ],
  cost: "very low",
  context: "webgl2",
});
