import { defineEffectMeta } from "../types";

const STYLE_OPTIONS = [
  { value: "comic", label: "Comic" },
  { value: "painted", label: "Painted" },
] as const;

const ROOM_OPTIONS = [
  { value: "office", label: "Office" },
  { value: "kitchen", label: "Kitchen" },
] as const;

/** Code points in the one-line speech bubble. */
const CAPTION_LENGTH = 24;

export const thisisfineMeta = defineEffectMeta({
  id: "thisisfine",
  name: "This Is Fine",
  description:
    "A cosy cartoon room calmly on fire: flames lick along the walls and smoke pools under the ceiling while the coffee steams, the picture hangs crooked and everything is perfectly normal.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "comic" },
    intensity: {
      kind: "number",
      label: "Fire spread",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    smoke: { kind: "number", label: "Smoke", min: 0, max: 1, step: 0.01, default: 0.6 },
    room: { kind: "select", label: "Room", options: ROOM_OPTIONS, default: "office" },
    caption: { kind: "boolean", label: "Speech bubble", default: false },
    text: {
      kind: "text",
      label: "Speech bubble text",
      default: "This is fine.",
      maxLength: CAPTION_LENGTH,
      maxLines: 1,
    },
    motion: { kind: "number", label: "Motion", min: 0, max: 1, step: 0.05, default: 1 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Fun", "Retro"],
  tags: [
    "meme",
    "office",
    "kitchen",
    "cartoon",
    "comic",
    "ironic",
    "everything is fine",
    "burning",
    "blaze",
    "denial",
  ],
  cost: "low",
  context: "webgl2",
});
