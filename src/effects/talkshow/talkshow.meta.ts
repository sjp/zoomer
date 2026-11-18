import { defineEffectMeta } from "../types";

/** Code points in the desk front's title. */
export const TITLE_MAX_LENGTH = 16;

const BACKDROP_OPTIONS = [
  { value: "night", label: "Skyline night" },
  { value: "dusk", label: "Skyline dusk" },
  { value: "curtain", label: "Curtain" },
] as const;

const DESK_OPTIONS = [
  { value: "wood", label: "Wood" },
  { value: "retro", label: "Retro" },
  { value: "glass", label: "Glass" },
] as const;

export const talkshowMeta = defineEffectMeta({
  id: "talkshow",
  name: "Late-Night Talk Desk",
  description:
    "Hosting a late-night show from behind a wooden desk: a painted city skyline glows behind you under the stage lights, the band's corner shimmers out of focus, and a vintage microphone and a mug sit at the end of the desk.",
  params: {
    backdrop: { kind: "select", label: "Backdrop", options: BACKDROP_OPTIONS, default: "night" },
    desk: { kind: "select", label: "Desk", options: DESK_OPTIONS, default: "wood" },
    title: {
      kind: "text",
      label: "Desk title (empty hides it)",
      default: "TONIGHT",
      maxLength: TITLE_MAX_LENGTH,
      maxLines: 1,
    },
    titleColor: { kind: "color", label: "Title colour", default: "#ffe9c4" },
    mic: { kind: "boolean", label: "Desk microphone", default: true },
    applause: { kind: "boolean", label: "Applause sign", default: false },
    warmth: { kind: "number", label: "Key light warmth", min: 0, max: 1, step: 0.01, default: 0.6 },
  },
  categories: ["Scenes", "Night", "Fun"],
  tags: ["talk show", "late night", "tv", "studio", "chat show", "comedy", "monologue"],
  cost: "low",
  context: "webgl2",
});
