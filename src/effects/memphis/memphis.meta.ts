import { defineEffectMeta } from "../types";

const PALETTE_OPTIONS = [
  { value: "startup", label: "Startup" },
  { value: "fintech", label: "Fintech" },
  { value: "wellness", label: "Wellness" },
] as const;

/** The most people on screen: two at each side. */
export const MAX_PEOPLE = 4;

export const memphisMeta = defineEffectMeta({
  id: "memphis",
  name: "Corporate Memphis",
  description:
    "The flat tech landing-page illustration style: lanky purple and blue people with tiny heads wave, hold up laptops, sit on giant coins and stretch impossibly long arms into a high five, among oversized plants and floating charts, ticks and speech bubbles.",
  params: {
    people: {
      kind: "number",
      label: "People",
      min: 0,
      max: MAX_PEOPLE,
      step: 1,
      default: 3,
    },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "startup" },
    props: { kind: "boolean", label: "Floating props", default: true },
    motion: { kind: "number", label: "Motion", min: 0, max: 1, step: 0.05, default: 1 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Fun", "Retro"],
  tags: [
    "meme",
    "corporate",
    "flat illustration",
    "alegria",
    "tech",
    "office",
    "ironic",
    "landing page",
    "startup",
    "vector art",
  ],
  cost: "very low",
  context: "webgl2",
});
