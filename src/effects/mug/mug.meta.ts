import { defineEffectMeta } from "../types";

type MugPosition = "left" | "right";
export type DrinkId = "tea" | "coffee" | "chocolate";
export type RoomId = "wall" | "window" | "shelves";

export const POSITION_OPTIONS = [
  { value: "left", label: "Bottom left" },
  { value: "right", label: "Bottom right" },
] as const satisfies readonly { value: MugPosition; label: string }[];

export const DRINK_OPTIONS = [
  { value: "tea", label: "Tea" },
  { value: "coffee", label: "Coffee" },
  { value: "chocolate", label: "Hot chocolate" },
] as const satisfies readonly { value: DrinkId; label: string }[];

export const ROOM_OPTIONS = [
  { value: "wall", label: "Warm wall" },
  { value: "window", label: "Window" },
  { value: "shelves", label: "Shelves" },
] as const satisfies readonly { value: RoomId; label: string }[];

export const mugMeta = defineEffectMeta({
  id: "mug",
  name: "Steaming Mug",
  description:
    "A mug of something hot on a table in the corner, with soft steam curling up into a warm, out-of-focus room.",
  params: {
    position: { kind: "select", label: "Position", options: POSITION_OPTIONS, default: "right" },
    mugColor: { kind: "color", label: "Mug colour", default: "#3f6e74" },
    drink: { kind: "select", label: "Drink", options: DRINK_OPTIONS, default: "tea" },
    steam: { kind: "number", label: "Steam", min: 0, max: 1, step: 0.05, default: 0.65 },
    draft: { kind: "number", label: "Draft", min: 0, max: 1, step: 0.05, default: 0.35 },
    room: { kind: "select", label: "Room", options: ROOM_OPTIONS, default: "wall" },
  },
  category: "Cosy",
  tags: ["tea", "coffee", "cup", "hot drink", "cafe", "kitchen", "morning"],
  cost: "low",
  context: "webgl2",
});
