import { defineEffectMeta } from "../types";

type MazeStyle = "classic" | "modern";
type WallKind = "brick" | "stone" | "wood";
type CeilingKind = "tiles" | "sky";
type Hand = "right" | "left";

/** Smallest and largest maze, in cells along a side. */
export const MIN_SIZE = 8;
export const MAX_SIZE = 24;

/** Walking-pace slider range; 1 is about a cell every 1.5 s. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 2;

const STYLE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "modern", label: "Modern" },
] as const satisfies readonly { value: MazeStyle; label: string }[];

export const WALL_OPTIONS = [
  { value: "brick", label: "Brick" },
  { value: "stone", label: "Stone" },
  { value: "wood", label: "Wood" },
] as const satisfies readonly { value: WallKind; label: string }[];

const CEILING_OPTIONS = [
  { value: "tiles", label: "Tiles" },
  { value: "sky", label: "Sky" },
] as const satisfies readonly { value: CeilingKind; label: string }[];

const HAND_OPTIONS = [
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
] as const satisfies readonly { value: Hand; label: string }[];

export const mazeMeta = defineEffectMeta({
  id: "maze",
  name: "3D Maze",
  description:
    "The classic screensaver walk: a first-person stroll through a random red-brick maze, following the wall past spinning polyhedra, a smiley face and the odd rat until it reaches the bright exit and starts a new one.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "classic" },
    speed: {
      kind: "number",
      label: "Walking pace",
      min: MIN_SPEED,
      max: MAX_SPEED,
      step: 0.05,
      default: 1,
    },
    size: {
      kind: "number",
      label: "Maze size",
      min: MIN_SIZE,
      max: MAX_SIZE,
      step: 1,
      default: 12,
    },
    walls: { kind: "select", label: "Walls", options: WALL_OPTIONS, default: "brick" },
    ceiling: { kind: "select", label: "Ceiling", options: CEILING_OPTIONS, default: "tiles" },
    objects: { kind: "boolean", label: "Objects", default: true },
    flip: { kind: "boolean", label: "Flip at polyhedra", default: false },
    hand: { kind: "select", label: "Follow wall", options: HAND_OPTIONS, default: "right" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  category: "Retro",
  tags: ["screensaver", "windows", "labyrinth", "first person", "90s", "bricks", "nostalgia"],
  cost: "low",
  context: "webgl2",
});
