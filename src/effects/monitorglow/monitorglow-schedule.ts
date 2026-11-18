/**
 * Monitor Glow's palettes for the shared shot schedule (`shot-schedule.ts`):
 * the looks a game or film of each genre throws on the wall, and its pacing.
 */
import { buildPalette, look, type PaletteDef, type ShotPalette } from "../shot-schedule";

export type Genre = "adventure" | "shooter" | "racing" | "horror" | "cosy" | "film";

const MENU = look("#5cff8a", 0.42, 0.62, 0.8);
const LOADING = look("#e8eeff", 0.6, 0.85, 0.6);

const GENRE_DEFS: Readonly<Record<Genre, PaletteDef>> = {
  adventure: {
    looks: [
      look("#5b8cff", 0.55, 0.78, 4),
      look("#6fd08a", 0.5, 0.7, 2),
      look("#ffb066", 0.5, 0.8, 1.5),
      look("#3fa7a0", 0.38, 0.62, 1.5),
      MENU,
      LOADING,
    ],
    shot: [8, 20],
    events: 0.2,
    boost: 0.18,
    bursts: ["#ff8a3a", "#ffc070"],
  },
  shooter: {
    looks: [
      look("#8796b0", 0.5, 0.75, 3),
      look("#d8b27a", 0.5, 0.78, 2),
      look("#4c8f9a", 0.42, 0.66, 2),
      MENU,
      LOADING,
    ],
    shot: [6, 14],
    events: 0.85,
    boost: 0.2,
    bursts: ["#ff8a3a", "#ffe0a0"],
  },
  racing: {
    looks: [
      look("#9fd2ff", 0.6, 0.85, 3),
      look("#ff5ad8", 0.42, 0.7, 1.5),
      look("#4ae0ff", 0.45, 0.72, 1.5),
      look("#ff9a5a", 0.5, 0.8, 1.5),
      LOADING,
    ],
    shot: [5, 14],
    events: 0.2,
    boost: 0.15,
    bursts: ["#fff2d0", "#8ae8ff"],
  },
  horror: {
    looks: [
      look("#2a3a60", 0.2, 0.55, 3),
      look("#c0303a", 0.32, 0.6, 1.5),
      look("#7aa060", 0.22, 0.58, 1.5),
      look("#ffa860", 0.28, 0.62, 1),
      look("#e8eeff", 0.3, 0.7, 0.5),
    ],
    shot: [8, 20],
    events: 0.12,
    boost: 0.16,
    bursts: ["#ff4a3a", "#ffd0a0"],
  },
  cosy: {
    looks: [
      look("#ffc39a", 0.5, 0.8, 2),
      look("#a8e0a0", 0.5, 0.78, 2),
      look("#ffb0d0", 0.45, 0.75, 1.5),
      look("#a8d0ff", 0.5, 0.8, 1.5),
      look("#fff0d8", 0.5, 0.82, 1),
    ],
    shot: [10, 20],
    events: 0.05,
    boost: 0.1,
    bursts: ["#ffe0a0"],
  },
  film: {
    looks: [
      look("#4a6ad0", 0.4, 0.72, 2),
      look("#ffb070", 0.45, 0.78, 2),
      look("#c8cfd8", 0.5, 0.8, 1.5),
      look("#4aa0a8", 0.38, 0.68, 1.5),
      look("#6070a0", 0.18, 0.6, 1),
      look("#e8eeff", 0.55, 0.85, 0.5),
    ],
    shot: [4, 16],
    events: 0.15,
    boost: 0.18,
    bursts: ["#ff8a3a", "#ffd890"],
  },
};

export const GENRE_PALETTES: Readonly<Record<Genre, ShotPalette>> = {
  adventure: buildPalette(GENRE_DEFS.adventure),
  shooter: buildPalette(GENRE_DEFS.shooter),
  racing: buildPalette(GENRE_DEFS.racing),
  horror: buildPalette(GENRE_DEFS.horror),
  cosy: buildPalette(GENRE_DEFS.cosy),
  film: buildPalette(GENRE_DEFS.film),
};
