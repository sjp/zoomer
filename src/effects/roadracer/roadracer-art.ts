/**
 * Road Racer's pixel art and colours, all pure so they can be tested: a
 * made-up 36-colour sprite palette (with a second "lit" palette for what glows
 * at dusk and night: tail lights, lamps and windows), the sprites drawn into
 * small grids by code (the player's wedge-shaped car in three frames, two
 * kinds of traffic, palms, huts, rocks, bushes, curve signs, street lamps and
 * buildings, a glow and a shadow), and each course's colours.
 */
import { createRng } from "../noise";
import { packPixelAtlas, type PixelGrid } from "../pixel-atlas";

/** Sprite palette, by digit 0-9 then a-z. */
const PALETTE: readonly string[] = [
  "#1a1622", // 0 outline
  "#26262c", // 1 tyre
  "#4a4a56", // 2 dark grey
  "#7d808e", // 3 mid grey
  "#b9bcc8", // 4 light grey
  "#f4f2ea", // 5 white
  "#1fa59a", // 6 body teal
  "#11695f", // 7 body teal, shaded
  "#72dccf", // 8 body teal, lit
  "#1c2a44", // 9 glass
  "#5373a6", // a glass, lit
  "#d8303c", // b tail light
  "#7e1520", // c tail light, dark
  "#f08a24", // d orange
  "#fff0b0", // e lamp glass
  "#8a5a32", // f trunk
  "#5c3a20", // g trunk, dark
  "#3fae4a", // h palm leaf
  "#1f7a35", // i palm leaf, dark
  "#8bd86a", // j palm leaf, lit
  "#e8c879", // k straw
  "#b08a46", // l straw, dark
  "#7fc0e6", // m hut wall
  "#4580b4", // n hut wall, dark
  "#948e86", // o rock
  "#605a56", // p rock, dark
  "#4c9a3a", // q bush
  "#2b6626", // r bush, dark
  "#f2c230", // s sign
  "#8a7f9a", // t building
  "#a36f5a", // u building, brick
  "#3c4c70", // v window that lights at night
  "#2a3550", // w window
  "#e8e4d8", // x van
  "#3a64c8", // y hatchback
  "#233f88", // z hatchback, dark
];

/** What glows when the lights are on, by the same digits; the rest stays dark. */
const LIT: Readonly<Record<string, string>> = {
  b: "#ff5a5a",
  c: "#c03040",
  e: "#fff4c8",
  v: "#ffd27a",
};

/** A grid being drawn: rows of digit characters, "." empty. */
class Pix {
  readonly w: number;
  readonly h: number;
  readonly cells: string[][];
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => "."));
  }
  set(x: number, y: number, c: string): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix >= 0 && iy >= 0 && ix < this.w && iy < this.h) {
      this.cells[iy][ix] = c;
    }
  }
  get(x: number, y: number): string {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.cells[y][x] : ".";
  }
  /** Fills the rect from (x0, y0) to (x1, y1), inclusive. */
  rect(x0: number, y0: number, x1: number, y1: number, c: string): void {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        this.set(x, y, c);
      }
    }
  }
  /** Fills the ellipse in the rect from (x0, y0) to (x1, y1). */
  ellipse(x0: number, y0: number, x1: number, y1: number, c: string): void {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = (x1 - x0 + 1) / 2;
    const ry = (y1 - y0 + 1) / 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const u = (x - cx) / rx;
        const v = (y - cy) / ry;
        if (u * u + v * v <= 1) {
          this.set(x, y, c);
        }
      }
    }
  }
  /** Turns the filled cells with an empty 4-neighbour into `c`, except those in `keep`. */
  outline(c: string, keep = ""): void {
    const edge: [number, number][] = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const v = this.cells[y][x];
        if (v === "." || keep.includes(v)) {
          continue;
        }
        if (
          this.get(x - 1, y) === "." ||
          this.get(x + 1, y) === "." ||
          this.get(x, y - 1) === "." ||
          this.get(x, y + 1) === "."
        ) {
          edge.push([x, y]);
        }
      }
    }
    for (const [x, y] of edge) {
      this.cells[y][x] = c;
    }
  }
  grid(): PixelGrid {
    return this.cells.map((r) => r.join(""));
  }
}

/** Shifts each row sideways by up to `lean` px at the top (0 at row `fixedFrom` and below). */
function shear(src: Pix, lean: number, fixedFrom: number): PixelGrid {
  const out = new Pix(src.w, src.h);
  for (let y = 0; y < src.h; y++) {
    const dx = y >= fixedFrom ? 0 : Math.round((lean * (fixedFrom - y)) / fixedFrom);
    for (let x = 0; x < src.w; x++) {
      const v = src.get(x, y);
      if (v !== ".") {
        out.set(x + dx, y, v);
      }
    }
  }
  return out.grid();
}

/** Width and height of the player car's frames. */
const CAR_W = 52;
const CAR_H = 24;

/** The player's car from behind: a low wedge with a spoiler, twin stripes and a light bar. */
function playerCar(): Pix {
  const p = new Pix(CAR_W, CAR_H);
  const m = 2;
  // Spoiler, on two posts.
  p.rect(m + 4, 1, CAR_W - m - 5, 2, "7");
  p.rect(m + 4, 1, CAR_W - m - 5, 1, "8");
  p.rect(m + 10, 3, m + 11, 4, "2");
  p.rect(CAR_W - m - 12, 3, CAR_W - m - 11, 4, "2");
  // The cabin, narrowing to the roof.
  for (let y = 4; y <= 9; y++) {
    const inset = m + 4 + (9 - y) * 2;
    p.rect(inset, y, CAR_W - 1 - inset, y, y === 4 ? "8" : "6");
  }
  for (let y = 5; y <= 8; y++) {
    const inset = m + 7 + (9 - y) * 2;
    p.rect(inset, y, CAR_W - 1 - inset, y, "9");
  }
  p.set(m + 16, 6, "a");
  p.set(m + 17, 6, "a");
  p.set(m + 15, 7, "a");
  // The body.
  p.rect(m, 10, CAR_W - m - 1, 18, "6");
  p.rect(m, 10, CAR_W - m - 1, 10, "8");
  p.rect(m, 16, CAR_W - m - 1, 18, "7");
  // Tail lights joined by a dark light bar.
  p.rect(m + 2, 12, m + 13, 14, "b");
  p.rect(CAR_W - m - 14, 12, CAR_W - m - 3, 14, "b");
  p.rect(m + 2, 14, m + 13, 14, "c");
  p.rect(CAR_W - m - 14, 14, CAR_W - m - 3, 14, "c");
  p.rect(m + 14, 13, CAR_W - m - 15, 13, "c");
  // Plate and diffuser.
  p.rect(22, 15, 29, 17, "5");
  p.rect(m + 8, 19, CAR_W - m - 9, 20, "2");
  // Twin stripes over the cabin and boot.
  for (const x of [22, 23, 28, 29]) {
    for (let y = 1; y <= 12; y++) {
      if (p.get(x, y) === "6" || p.get(x, y) === "8" || p.get(x, y) === "7") {
        p.set(x, y, "5");
      }
    }
  }
  p.outline("0", "9b");
  // Tyres and exhausts.
  p.rect(m + 1, 17, m + 9, 23, "1");
  p.rect(CAR_W - m - 10, 17, CAR_W - m - 2, 23, "1");
  p.rect(m + 1, 17, m + 9, 17, "2");
  p.rect(CAR_W - m - 10, 17, CAR_W - m - 2, 17, "2");
  p.rect(m + 12, 20, m + 13, 21, "0");
  p.rect(CAR_W - m - 14, 20, CAR_W - m - 13, 21, "0");
  return p;
}

/** A boxy hatchback in `body` / `dark` from behind. */
function hatchback(body: string, dark: string): PixelGrid {
  const w = 44;
  const p = new Pix(w, 28);
  p.rect(5, 1, w - 6, 2, body);
  for (let y = 3; y <= 11; y++) {
    const inset = y < 5 ? 4 : 3;
    p.rect(inset, y, w - 1 - inset, y, body);
  }
  p.rect(7, 3, w - 8, 10, "9");
  p.rect(9, 4, 12, 4, "a");
  p.rect(2, 12, w - 3, 21, body);
  p.rect(2, 19, w - 3, 21, dark);
  p.rect(4, 13, 9, 16, "b");
  p.rect(w - 10, 13, w - 5, 16, "b");
  p.rect(4, 16, 9, 16, "c");
  p.rect(w - 10, 16, w - 5, 16, "c");
  p.rect(18, 15, 25, 17, "5");
  p.rect(2, 22, w - 3, 23, "2");
  p.outline("0", "9b");
  p.rect(3, 22, 9, 27, "1");
  p.rect(w - 10, 22, w - 4, 27, "1");
  return p.grid();
}

/** A tall delivery van from behind, with split rear doors. */
function van(): PixelGrid {
  const w = 40;
  const p = new Pix(w, 34);
  p.rect(2, 1, w - 3, 26, "x");
  p.rect(2, 1, w - 3, 1, "5");
  p.rect(5, 4, 17, 11, "9");
  p.rect(w - 18, 4, w - 6, 11, "9");
  p.rect(6, 5, 8, 5, "a");
  p.rect(19, 3, 20, 25, "4");
  p.rect(3, 18, 5, 23, "b");
  p.rect(w - 6, 18, w - 4, 23, "b");
  p.rect(15, 22, 24, 24, "d");
  p.rect(2, 27, w - 3, 28, "2");
  p.outline("0", "9b");
  p.rect(3, 28, 9, 33, "1");
  p.rect(w - 10, 28, w - 4, 33, "1");
  return p.grid();
}

/** A palm leaning slightly, with drooping fronds and coconuts. */
function palm(lean: number): PixelGrid {
  const w = 36;
  const h = 52;
  const p = new Pix(w, h);
  const top = 13;
  const trunkX = (y: number) => 17 + lean * ((h - 1 - y) / (h - 1 - top)) ** 2;
  for (let y = top; y < h; y++) {
    const x = trunkX(y);
    const ring = (h - y) % 4 === 0;
    p.set(x - 1, y, ring ? "g" : "f");
    p.set(x, y, "f");
    p.set(x + 1, y, ring ? "f" : "g");
  }
  const cx = trunkX(top);
  const fronds = [-2.9, -2.4, -1.75, -1.2, -0.55, 0.0, -3.14];
  for (const a of fronds) {
    const len = 13 + ((a * 7) % 3);
    for (let t = 0; t <= 1; t += 0.03) {
      const x = cx + Math.cos(a) * t * len;
      const y = top - 1 + Math.sin(a) * t * len * 0.6 + t * t * 8;
      p.set(x, y, t > 0.85 ? "j" : "h");
      p.set(x, y + 1, "i");
      if (t > 0.2 && t < 0.8) {
        p.set(x, y + 2, "i");
      }
    }
  }
  p.rect(Math.round(cx) - 1, top, Math.round(cx), top + 1, "g");
  p.set(Math.round(cx) + 1, top + 1, "g");
  return p.grid();
}

/** A beach hut: a striped straw roof over plank walls, a door and a window. */
function hut(): PixelGrid {
  const w = 38;
  const h = 30;
  const p = new Pix(w, h);
  for (let y = 0; y < 12; y++) {
    const half = 3 + y * 1.6;
    for (let x = Math.round(19 - half); x <= Math.round(18 + half); x++) {
      p.set(x, y, (x + y) % 5 === 0 ? "l" : "k");
    }
  }
  p.rect(3, 12, w - 4, h - 1, "m");
  for (let x = 5; x < w - 4; x += 4) {
    p.rect(x, 12, x, h - 1, "n");
  }
  p.rect(3, 12, w - 4, 12, "n");
  p.rect(9, 17, 16, h - 1, "0");
  p.rect(10, 18, 15, h - 1, "9");
  p.rect(22, 16, 31, 22, "4");
  p.rect(23, 17, 30, 21, "v");
  p.rect(26, 17, 26, 21, "4");
  p.outline("0", "k");
  return p.grid();
}

function rock(): PixelGrid {
  const p = new Pix(26, 15);
  p.ellipse(0, 2, 18, 14, "o");
  p.ellipse(10, 0, 25, 14, "o");
  p.ellipse(2, 3, 12, 7, "4");
  p.ellipse(14, 9, 25, 14, "p");
  p.rect(0, 13, 25, 14, "p");
  p.outline("0");
  return p.grid();
}

function bush(): PixelGrid {
  const p = new Pix(26, 13);
  p.ellipse(0, 3, 12, 12, "q");
  p.ellipse(7, 0, 19, 12, "q");
  p.ellipse(14, 4, 25, 12, "q");
  p.ellipse(15, 8, 25, 12, "r");
  p.ellipse(1, 8, 10, 12, "r");
  p.set(9, 3, "j");
  p.set(15, 2, "j");
  p.set(5, 6, "j");
  p.set(20, 6, "j");
  p.outline("r");
  return p.grid();
}

/** A curve sign: a yellow board with a chevron pointing right, on a post. */
function sign(): PixelGrid {
  const p = new Pix(18, 26);
  p.rect(0, 0, 17, 13, "s");
  for (let y = 2; y <= 11; y++) {
    const x = 5 + Math.round(5 - Math.abs(y - 6.5));
    p.rect(x, y, x + 2, y, "0");
  }
  p.outline("0");
  p.rect(8, 14, 9, 25, "3");
  p.rect(9, 14, 9, 25, "2");
  return p.grid();
}

/** A street lamp: a pole with an arm reaching left to the lamp. */
function lamp(): PixelGrid {
  const p = new Pix(14, 50);
  p.rect(10, 4, 11, 49, "3");
  p.rect(11, 4, 11, 49, "2");
  p.rect(2, 3, 11, 4, "3");
  p.rect(0, 5, 6, 5, "2");
  p.rect(1, 6, 5, 7, "e");
  p.rect(9, 46, 12, 49, "2");
  return p.grid();
}

/** A building `w` x `h` in `wall`, with a grid of windows of which about `litShare` light up at night. */
function building(w: number, h: number, wall: string, seed: number): PixelGrid {
  const p = new Pix(w, h);
  p.rect(0, 2, w - 1, h - 1, wall);
  p.rect(1, 0, w - 2, 1, "2");
  let k = seed;
  for (let y = 5; y + 3 < h - 3; y += 6) {
    for (let x = 3; x + 3 < w - 1; x += 5) {
      k = (k * 1103515245 + 12345) >>> 0;
      p.rect(x, y, x + 2, y + 3, (k >>> 16) % 10 < 6 ? "v" : "w");
    }
  }
  p.rect(w - 2, 2, w - 1, h - 1, "2");
  p.rect(Math.floor(w / 2) - 3, h - 6, Math.floor(w / 2) + 2, h - 1, "w");
  p.outline("0");
  return p.grid();
}

/** A stepped round glow, brightest in the middle (drawn added on). */
function glow(): PixelGrid {
  const size = 16;
  const p = new Pix(size, size);
  const steps = ["2", "3", "4", "5"];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      if (r < 1) {
        p.set(x, y, steps[Math.min(3, Math.floor((1 - r) * 4.5))]);
      }
    }
  }
  return p.grid();
}

function shadow(): PixelGrid {
  const p = new Pix(24, 6);
  p.ellipse(0, 0, 23, 5, "0");
  return p.grid();
}

/** Sprite kinds, in atlas cell order. */
export const SPRITE = {
  car: 0,
  carLeft: 1,
  carRight: 2,
  hatchBlue: 3,
  hatchOrange: 4,
  van: 5,
  palm: 6,
  palmLean: 7,
  hut: 8,
  rock: 9,
  bush: 10,
  sign: 11,
  lamp: 12,
  building0: 13,
  building1: 14,
  building2: 15,
  glow: 16,
  shadow: 17,
} as const;

/** World height of each sprite kind (width follows its cell's aspect). */
export const SPRITE_HEIGHT: readonly number[] = [
  0.6, 0.6, 0.6, 0.62, 0.62, 0.8, 3.3, 3.1, 1.9, 0.6, 0.5, 1.15, 3.1, 5, 4, 6.2, 1, 1,
];

function grids(): PixelGrid[] {
  const car = playerCar();
  return [
    car.grid(),
    shear(car, -2, 17),
    shear(car, 2, 17),
    hatchback("y", "z"),
    hatchback("d", "c"),
    van(),
    palm(-3),
    palm(5),
    hut(),
    rock(),
    bush(),
    sign(),
    lamp(),
    building(30, 52, "t", 7),
    building(36, 42, "u", 3),
    building(28, 64, "3", 11),
    glow(),
    shadow(),
  ];
}

const ATLAS_WIDTH = 256;

export interface SpriteAtlas {
  width: number;
  /** Height of each half: the day colours on top, what glows below. */
  half: number;
  /** RGBA8 of `width` x 2 `half`, rows top first. */
  pixels: Uint8Array;
  /** Rects, px from the top-left, by `SPRITE` kind. */
  cells: { x: number; y: number; w: number; h: number }[];
}

/** Packs the sprites into one atlas: their day colours, then the same rects in their lit colours. */
export function buildSpriteAtlas(): SpriteAtlas {
  const g = grids();
  const day = packPixelAtlas(g, PALETTE, ATLAS_WIDTH, 1);
  const litGrids = g.map((rows) => rows.map((r) => r.replace(/./g, (c) => (c in LIT ? c : "."))));
  const litPalette = PALETTE.map((hex, i) => LIT[i.toString(36)] ?? hex);
  const lit = packPixelAtlas(litGrids, litPalette, ATLAS_WIDTH, 1);
  const pixels = new Uint8Array(day.pixels.length * 2);
  pixels.set(day.pixels);
  pixels.set(lit.pixels, day.pixels.length);
  return { width: ATLAS_WIDTH, half: day.height, pixels, cells: day.cells };
}

// ---------------------------------------------------------------------------
// Course colours

/** Colours the road shader takes, in order. */
export const SCENE_COLOURS = [
  "skyTop",
  "skyMid",
  "skyHorizon",
  "sun",
  "sunHalo",
  "cloudLight",
  "cloudShade",
  "far",
  "farLight",
  "near",
  "nearDark",
  "fog",
  "roadA",
  "roadB",
  "rumbleA",
  "rumbleB",
  "line",
  "vergeA",
  "vergeB",
  "sandA",
  "sandB",
  "sea",
  "seaFar",
  "star",
] as const;

type SceneColours = Record<(typeof SCENE_COLOURS)[number], string>;

export interface CourseLook {
  colours: SceneColours;
  /** Sun (or moon) centre, frame heights from the centre and horizon, and its radius. */
  sun: readonly [number, number, number];
  /** 1 for the city's skyline, windows and stars; 0 for mountains and hills. */
  night: number;
  /** 1 where the sea lies beyond the sand on the left. */
  sea: number;
  /** How much of the sky the clouds cover, 0..1. */
  clouds: number;
  /** Multiplies the sprites' day colours. */
  spriteTint: readonly [number, number, number];
  /** How bright the lit colours glow. */
  lit: number;
  /** Shadows: opacity, length (x their width) and how far they reach right. */
  shadow: readonly [number, number, number];
  /** Scenery kinds this course shows. */
  scenery: "coast" | "city";
  /** HUD text: main, labels, the map's dot, the text's shadow. */
  hud: readonly [string, string, string, string];
}

export const COURSES: Readonly<Record<"coast" | "sunset" | "night", CourseLook>> = {
  coast: {
    colours: {
      skyTop: "#2f7fe0",
      skyMid: "#62aef0",
      skyHorizon: "#bfe4f8",
      sun: "#fffbe6",
      sunHalo: "#e6f6ff",
      cloudLight: "#ffffff",
      cloudShade: "#d2e4f2",
      far: "#7f9fc4",
      farLight: "#e6eef8",
      near: "#5a9e5a",
      nearDark: "#3f8048",
      fog: "#c6e2f2",
      roadA: "#8a8a92",
      roadB: "#808088",
      rumbleA: "#f4f4f4",
      rumbleB: "#d8403c",
      line: "#fafafa",
      vergeA: "#62b84c",
      vergeB: "#56a844",
      sandA: "#f0dca0",
      sandB: "#e6d092",
      sea: "#2a8cc8",
      seaFar: "#5ab0e0",
      star: "#ffffff",
    },
    sun: [-0.6, -0.33, 0.045],
    night: 0,
    sea: 1,
    clouds: 0.5,
    spriteTint: [1, 1, 1],
    lit: 0,
    shadow: [0.3, 0.8, 0.05],
    scenery: "coast",
    hud: ["#ffffff", "#ffe27a", "#ff4a4a", "#10223a"],
  },
  sunset: {
    colours: {
      skyTop: "#2c2a6a",
      skyMid: "#c4507a",
      skyHorizon: "#ffb060",
      sun: "#ffe08a",
      sunHalo: "#ff9a5a",
      cloudLight: "#ffb890",
      cloudShade: "#8a4a7a",
      far: "#6a3e78",
      farLight: "#c06a80",
      near: "#3e2c52",
      nearDark: "#2e2242",
      fog: "#f0a070",
      roadA: "#6a5a68",
      roadB: "#625262",
      rumbleA: "#f0d8c8",
      rumbleB: "#c03a40",
      line: "#ffe8d0",
      vergeA: "#7a7a3e",
      vergeB: "#6e6e36",
      sandA: "#d8a070",
      sandB: "#cc9466",
      sea: "#5a4a8a",
      seaFar: "#e08a70",
      star: "#ffffff",
    },
    sun: [0.55, -0.07, 0.11],
    night: 0,
    sea: 1,
    clouds: 0.35,
    spriteTint: [0.8, 0.62, 0.62],
    lit: 0.5,
    shadow: [0.4, 2.4, 0.9],
    scenery: "coast",
    hud: ["#fff2e0", "#ffc070", "#ffe060", "#2a1430"],
  },
  night: {
    colours: {
      skyTop: "#060a1e",
      skyMid: "#0e1a40",
      skyHorizon: "#24325e",
      sun: "#f0f0e0",
      sunHalo: "#2a3a6a",
      cloudLight: "#2a3660",
      cloudShade: "#1a2448",
      far: "#141c36",
      farLight: "#ffd27a",
      near: "#0c1226",
      nearDark: "#ffb860",
      fog: "#1e2a50",
      roadA: "#2e2e3a",
      roadB: "#2a2a36",
      rumbleA: "#8a8a96",
      rumbleB: "#7a2a36",
      line: "#d8d8c8",
      vergeA: "#3a3a46",
      vergeB: "#34343f",
      sandA: "#3a3a46",
      sandB: "#34343f",
      sea: "#0a1230",
      seaFar: "#18244a",
      star: "#e8ecff",
    },
    sun: [0.62, -0.32, 0.03],
    night: 1,
    sea: 0,
    clouds: 0.25,
    spriteTint: [0.32, 0.36, 0.55],
    lit: 1,
    shadow: [0, 1, 0],
    scenery: "city",
    hud: ["#e8f4ff", "#7ad8ff", "#ff5ac8", "#000010"],
  },
};

// ---------------------------------------------------------------------------
// Backdrop

/** Texels round the backdrop's loop. */
export const BACKDROP_WIDTH = 512;

/**
 * The background layers' outlines as one RGBA8 row of `BACKDROP_WIDTH`
 * texels, each a height 0..255 that loops round: far mountains (R), near hills
 * (G), and a far and a near city skyline (B, A) in flat-topped blocks.
 */
export function buildBackdrop(): Uint8Array {
  const out = new Uint8Array(BACKDROP_WIDTH * 4);
  const rng = createRng(20231);
  const wave = (channel: number, harmonics: number, falloff: number, power: number) => {
    const phase = Array.from({ length: harmonics }, () => rng() * Math.PI * 2);
    const values = new Float32Array(BACKDROP_WIDTH);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < BACKDROP_WIDTH; i++) {
      const u = i / BACKDROP_WIDTH;
      let v = 0;
      for (let k = 1; k <= harmonics; k++) {
        v += Math.sin(2 * Math.PI * k * u + phase[k - 1]) / k ** falloff;
      }
      values[i] = v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    for (let i = 0; i < BACKDROP_WIDTH; i++) {
      out[i * 4 + channel] = Math.round(((values[i] - lo) / (hi - lo)) ** power * 255);
    }
  };
  const blocks = (channel: number, minW: number, maxW: number, minH: number) => {
    let i = 0;
    while (i < BACKDROP_WIDTH) {
      const w = Math.min(BACKDROP_WIDTH - i, minW + Math.floor(rng() * (maxW - minW)));
      const h = minH + rng() * (1 - minH);
      for (let k = 0; k < w; k++) {
        out[(i + k) * 4 + channel] = Math.round(h * 255);
      }
      i += w;
    }
  };
  wave(0, 24, 1.2, 1.3);
  wave(1, 6, 1.8, 1);
  blocks(2, 4, 12, 0.2);
  blocks(3, 8, 20, 0.3);
  return out;
}
