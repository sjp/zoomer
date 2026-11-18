import { defineEffectMeta } from "../types";

const VIEW_OPTIONS = [
  { value: "projector", label: "Facing the projector" },
  { value: "screen", label: "Facing the screen" },
] as const;

const STATE_OPTIONS = [
  { value: "playing", label: "Film playing" },
  { value: "before", label: "Before the show" },
] as const;

const FILM_OPTIONS = [
  { value: "drama", label: "Drama" },
  { value: "scifi", label: "Sci-fi" },
  { value: "western", label: "Western" },
  { value: "animation", label: "Animation" },
] as const;

export const cinemaMeta = defineEffectMeta({
  id: "cinema",
  name: "Cinema Auditorium",
  description:
    "A seat in a classic cinema with red velvet seats: the projector's beam reaches over your head through the dusty dark, or the screen glows behind you between its curtains, its light changing with every shot.",
  params: {
    view: { kind: "select", label: "View", options: VIEW_OPTIONS, default: "projector" },
    state: { kind: "select", label: "Show", options: STATE_OPTIONS, default: "playing" },
    film: { kind: "select", label: "Film", options: FILM_OPTIONS, default: "drama" },
    seats: { kind: "color", label: "Seats", default: "#8c1420" },
    dust: { kind: "number", label: "Dust in the beam", min: 0, max: 1, step: 0.01, default: 0.5 },
  },
  categories: ["Scenes", "Night", "Cosy"],
  tags: ["movie theatre", "movies", "film", "picture house", "big screen"],
  cost: "low",
  context: "webgl2",
});
