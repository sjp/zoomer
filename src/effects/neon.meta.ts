import { defineEffectMeta } from "./types";

export type NeonWall = "brick" | "concrete" | "tile";
export type NeonPosition = "left" | "centre" | "right";

export const NEON_WALL_OPTIONS = [
  { value: "brick", label: "Brick" },
  { value: "concrete", label: "Concrete" },
  { value: "tile", label: "Dark tile" },
] as const satisfies readonly { value: NeonWall; label: string }[];

export const NEON_POSITION_OPTIONS = [
  { value: "left", label: "Top left" },
  { value: "centre", label: "Top centre" },
  { value: "right", label: "Top right" },
] as const satisfies readonly { value: NeonPosition; label: string }[];

/** Code points per line of the sign's text. */
export const NEON_MAX_LENGTH = 24;
/** Lines of text the sign shows. */
export const NEON_MAX_LINES = 2;

export const neonMeta = defineEffectMeta({
  id: "neon",
  name: "Neon Sign",
  description:
    "Your own words in glowing glass tubes on a wall at night, with a soft coloured glow on the bricks and a slow, gentle shimmer.",
  params: {
    text: {
      kind: "text",
      label: "Text",
      default: "On Air",
      maxLength: NEON_MAX_LENGTH,
      maxLines: NEON_MAX_LINES,
    },
    colour: { kind: "color", label: "Tube colour", default: "#ff2f8e" },
    twoTone: { kind: "boolean", label: "Own colour for line 2", default: false },
    second: { kind: "color", label: "Line 2 colour", default: "#36d6ff" },
    wall: { kind: "select", label: "Wall", options: NEON_WALL_OPTIONS, default: "brick" },
    position: {
      kind: "select",
      label: "Position",
      options: NEON_POSITION_OPTIONS,
      default: "centre",
    },
    shimmer: { kind: "number", label: "Shimmer", min: 0, max: 1, step: 0.05, default: 0.5 },
  },
  category: "Retro",
  tags: ["lettering", "name", "message", "custom text", "on air", "bar", "pub", "studio"],
  cost: "very low",
  context: "webgl2",
});
