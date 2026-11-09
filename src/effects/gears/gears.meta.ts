import { defineEffectMeta } from "../types";

export type GearLayoutId = "corner" | "side" | "frame";
type GearMetalId = "brass" | "steel" | "mixed";
export type GearBackdropId = "plate" | "wood" | "paper";

const GEAR_LAYOUT_OPTIONS = [
  { value: "corner", label: "Corner" },
  { value: "side", label: "Side" },
  { value: "frame", label: "Frame" },
] as const satisfies readonly { value: GearLayoutId; label: string }[];

const GEAR_METAL_OPTIONS = [
  { value: "brass", label: "Brass" },
  { value: "steel", label: "Steel" },
  { value: "mixed", label: "Mixed" },
] as const satisfies readonly { value: GearMetalId; label: string }[];

const GEAR_BACKDROP_OPTIONS = [
  { value: "plate", label: "Dark plate" },
  { value: "wood", label: "Wood" },
  { value: "paper", label: "Paper" },
] as const satisfies readonly { value: GearBackdropId; label: string }[];

/** Most gears (including the balance wheel) any layout grows. */
export const MAX_GEARS = 48;

export const gearsMeta = defineEffectMeta({
  id: "gears",
  name: "Clockwork Gears",
  description:
    "A train of brass and steel gears meshing at the right ratios in warm, low light, with a balance wheel swinging back and forth and the drive ticking forwards.",
  params: {
    layout: { kind: "select", label: "Layout", options: GEAR_LAYOUT_OPTIONS, default: "corner" },
    speed: { kind: "number", label: "Speed (rpm)", min: 0.25, max: 4, step: 0.25, default: 1 },
    tick: { kind: "boolean", label: "Escapement tick", default: true },
    metal: { kind: "select", label: "Metal", options: GEAR_METAL_OPTIONS, default: "mixed" },
    backdrop: {
      kind: "select",
      label: "Backdrop",
      options: GEAR_BACKDROP_OPTIONS,
      default: "plate",
    },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 12 },
  },
  category: "Retro",
  tags: ["clock", "cogs", "mechanism", "steampunk", "watch", "machinery", "copper", "workshop"],
  cost: "very low",
  context: "webgl2",
});
