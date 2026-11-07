/**
 * Starship Bridge planets: the look of the planet in the outside view, matched
 * to the location readout (each world in `LOCATIONS` has its own colours and
 * weather), with a little seeded variation in cloud cover, sea level, ice, size,
 * position and lighting. "Deep Space" picks from a few looks of its own.
 */
import { LOCATIONS } from "./bridge-live";
import { hexToUnitRgb, type Rgb } from "../color";
import { clamp } from "../math";
import { hash32 } from "../noise";

export interface PlanetStyle {
  ocean: Rgb;
  /** Low and high land colours. */
  landLow: Rgb;
  landHigh: Rgb;
  cloud: Rgb;
  atmosphere: Rgb;
  /** Noise level above which there is land: higher means more ocean. */
  sea: number;
  /** Noise level above which there is cloud: lower means more cloud. */
  clouds: number;
  /** Latitude (radians from the equator) beyond which there is ice. */
  ice: number;
  /** 0 for a rocky world, 1 for a banded gas giant. */
  bands: number;
  /** Strength of the atmosphere's glow at the limb. */
  haze: number;
  /** Planet centre x (fraction of the display width from its centre), top edge y and radius, in display heights. */
  x: number;
  top: number;
  radius: number;
  /** Angle (radians) the sunlight comes from, about the view axis. */
  light: number;
}

interface Base {
  ocean: string;
  landLow: string;
  landHigh: string;
  cloud: string;
  atmosphere: string;
  sea: number;
  clouds: number;
  ice: number;
  bands?: number;
  haze?: number;
}

const OPEN = Math.PI / 2;

/** Each location's world. */
const WORLDS: Readonly<Record<(typeof LOCATIONS)[number], Base>> = {
  EARTH: {
    ocean: "#0f2957",
    landLow: "#40522e",
    landHigh: "#73664d",
    cloud: "#e6ebf2",
    atmosphere: "#4d80ff",
    sea: 0.55,
    clouds: 0.55,
    ice: 1.2,
  },
  RISA: {
    ocean: "#0d4d6b",
    landLow: "#4d6b33",
    landHigh: "#998c66",
    cloud: "#f2f5f7",
    atmosphere: "#66b3ff",
    sea: 0.66,
    clouds: 0.68,
    ice: OPEN,
  },
  "QO'NOS": {
    ocean: "#1f1a14",
    landLow: "#52331f",
    landHigh: "#995926",
    cloud: "#bf9973",
    atmosphere: "#ff8c4d",
    sea: 0.48,
    clouds: 0.5,
    ice: OPEN,
  },
  VULCAN: {
    ocean: "#73301a",
    landLow: "#99471f",
    landHigh: "#cc804d",
    cloud: "#e6c7a6",
    atmosphere: "#ff9959",
    sea: 0.3,
    clouds: 0.75,
    ice: OPEN,
  },
  BAJOR: {
    ocean: "#143352",
    landLow: "#596133",
    landHigh: "#8c734d",
    cloud: "#e6e9ee",
    atmosphere: "#7399ff",
    sea: 0.53,
    clouds: 0.58,
    ice: 1.25,
  },
  BETAZED: {
    ocean: "#1f3366",
    landLow: "#4d664d",
    landHigh: "#80738c",
    cloud: "#ebe6f2",
    atmosphere: "#9980ff",
    sea: 0.56,
    clouds: 0.6,
    ice: 1.3,
  },
  ROMULUS: {
    ocean: "#143333",
    landLow: "#4d5c47",
    landHigh: "#6b705c",
    cloud: "#d9e6df",
    atmosphere: "#66cc99",
    sea: 0.52,
    clouds: 0.6,
    ice: 1.3,
  },
  "CARDASSIA PRIME": {
    ocean: "#33291f",
    landLow: "#736147",
    landHigh: "#998561",
    cloud: "#d9ccb3",
    atmosphere: "#e6b373",
    sea: 0.4,
    clouds: 0.7,
    ice: OPEN,
  },
  FERENGINAR: {
    ocean: "#1a2e24",
    landLow: "#405233",
    landHigh: "#596147",
    cloud: "#b3b8ad",
    atmosphere: "#80cc99",
    sea: 0.5,
    clouds: 0.42,
    ice: OPEN,
  },
  ANDORIA: {
    ocean: "#8ca6cc",
    landLow: "#bfd1e6",
    landHigh: "#e6eef7",
    cloud: "#f2f5fa",
    atmosphere: "#80b3ff",
    sea: 0.45,
    clouds: 0.66,
    ice: 0.9,
  },
  TRILL: {
    ocean: "#0f334d",
    landLow: "#475c38",
    landHigh: "#80755c",
    cloud: "#e6ebf0",
    atmosphere: "#5999ff",
    sea: 0.57,
    clouds: 0.58,
    ice: 1.25,
  },
  "DEEP SPACE": {
    ocean: "#5c4733",
    landLow: "#8c6640",
    landHigh: "#c7a680",
    cloud: "#e6d9c7",
    atmosphere: "#ffcc99",
    sea: 0,
    clouds: 2,
    ice: OPEN,
    bands: 1,
    haze: 0.5,
  },
};

/** Looks "Deep Space" picks from: a gas giant, a barren grey moon and a violet world. */
const WANDERERS: readonly Base[] = [
  WORLDS["DEEP SPACE"],
  {
    ocean: "#4d4d4d",
    landLow: "#666361",
    landHigh: "#8c8985",
    cloud: "#999999",
    atmosphere: "#000000",
    sea: 0,
    clouds: 2,
    ice: OPEN,
    haze: 0,
  },
  {
    ocean: "#2e1f4d",
    landLow: "#594073",
    landHigh: "#8c6b99",
    cloud: "#e0d6eb",
    atmosphere: "#b380ff",
    sea: 0.5,
    clouds: 0.6,
    ice: 1.3,
  },
];

function rand(a: number, b: number, c: number): number {
  return hash32(a ^ hash32(Math.imul(b, 0x9e3779b1) ^ hash32(c + 0x2f6b))) / 4294967296;
}

/** A colour nudged by up to ±`amount` of itself per channel. */
function nudge(hex: string, u: number, v: number, w: number, amount: number): Rgb {
  const c = hexToUnitRgb(hex);
  return [
    clamp(c[0] * (1 + amount * (2 * u - 1)), 0, 1),
    clamp(c[1] * (1 + amount * (2 * v - 1)), 0, 1),
    clamp(c[2] * (1 + amount * (2 * w - 1)), 0, 1),
  ];
}

/**
 * The planet for location `location` (an index into `LOCATIONS`) on this visit
 * (`visit` numbers the location's 15-minute holds), with seeded variation.
 */
export function planetStyle(location: number, visit: number, seed: number): PlanetStyle {
  const name = LOCATIONS[((location % LOCATIONS.length) + LOCATIONS.length) % LOCATIONS.length];
  const key = Math.floor(seed) * 131 + visit;
  const r = (k: number) => rand(key, location, k);
  const base =
    name === "DEEP SPACE"
      ? (WANDERERS[Math.floor(r(0) * WANDERERS.length)] ?? WORLDS[name])
      : WORLDS[name];
  const c = (hex: string, k: number) => nudge(hex, r(k), r(k + 1), r(k + 2), 0.08);
  const radius = 0.9 + 0.3 * r(20);
  return {
    ocean: c(base.ocean, 1),
    landLow: c(base.landLow, 4),
    landHigh: c(base.landHigh, 7),
    cloud: c(base.cloud, 10),
    atmosphere: c(base.atmosphere, 13),
    sea: base.sea + 0.06 * (r(16) - 0.5),
    clouds: base.clouds + 0.1 * (r(17) - 0.5),
    ice: base.ice + 0.15 * (r(18) - 0.5),
    bands: base.bands ?? 0,
    haze: (base.haze ?? 1) * (0.8 + 0.4 * r(19)),
    x: 0.3 * (r(21) - 0.5),
    top: -0.22 + 0.1 * (r(22) - 0.5),
    radius,
    light: 0.6 + 0.5 * (r(23) - 0.5),
  };
}
