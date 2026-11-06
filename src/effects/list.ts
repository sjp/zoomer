/**
 * The effect list as the user sees it: sorted, filtered by the search box and, with
 * favourites, starred effects first. The picker and ← / → both go through
 * {@link visibleEffects}, so they can't disagree about the order.
 */
import { EFFECT_CATEGORIES, EFFECT_COSTS, type EffectMeta } from "./types";

/** Sort orders, keyed by the value stored in preferences, with their labels. */
export const EFFECT_SORTS = {
  featured: "Featured",
  az: "A–Z",
  category: "By category",
  lightest: "Lightest first",
} as const;
export type EffectSort = keyof typeof EFFECT_SORTS;
export const DEFAULT_SORT: EffectSort = "featured";

export function isEffectSort(value: unknown): value is EffectSort {
  return typeof value === "string" && Object.hasOwn(EFFECT_SORTS, value);
}

/** What the list needs to know about an effect. */
export type ListableEffect = Pick<
  EffectMeta,
  "id" | "name" | "description" | "category" | "tags" | "cost"
>;

export interface ListOptions {
  sort: EffectSort;
  /** Search text. Every word must match the name, description, tags or category. */
  query?: string;
  /**
   * Ids of starred effects. They come first, in their own group, in the
   * current sort; the rest follow. Ids of effects not in the list are ignored.
   */
  favourites?: ReadonlySet<string>;
}

/** The heading for the favourites group. */
export const FAVOURITES_GROUP = "Favourites";

/** Lowercases, strips accents and turns punctuation into spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The words of a search query, normalised; empty when there's nothing to search for. */
export function searchWords(query: string | undefined): string[] {
  const text = normalizeText(query ?? "");
  return text ? text.split(" ") : [];
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

const categoryIndex = new Map<string, number>(EFFECT_CATEGORIES.map((c, i) => [c, i]));
const costIndex = new Map<string, number>(EFFECT_COSTS.map((c, i) => [c, i]));

/** How well an effect's name matches: a word starting a name word scores 2, inside one 1. */
function nameScore(name: string, words: readonly string[]): number {
  const nameWords = name.split(" ");
  let score = 0;
  for (const w of words) {
    if (nameWords.some((n) => n.startsWith(w))) score += 2;
    else if (name.includes(w)) score += 1;
  }
  return score;
}

/**
 * The effects to list, in order. `effects` is in the featured order (the registry's),
 * which also breaks every tie. With a query, effects whose name matches rank above
 * those matching only by tag, description or category, within each group.
 */
export function visibleEffects<T extends ListableEffect>(
  effects: readonly T[],
  options: ListOptions,
): T[] {
  const { sort, favourites } = options;
  const words = searchWords(options.query);
  const rows: { effect: T; index: number; favourite: number; score: number }[] = [];
  for (const [index, effect] of effects.entries()) {
    const name = normalizeText(effect.name);
    if (words.length > 0) {
      const text = normalizeText(
        [effect.name, effect.description, effect.category, ...effect.tags].join(" "),
      );
      if (!words.every((w) => text.includes(w))) continue;
    }
    rows.push({
      effect,
      index,
      favourite: favourites?.has(effect.id) ? 0 : 1,
      score: words.length > 0 ? nameScore(name, words) : 0,
    });
  }
  const byCategory = (e: T) => categoryIndex.get(e.category) ?? EFFECT_CATEGORIES.length;
  const byCost = (e: T) => (e.cost ? (costIndex.get(e.cost) ?? 0) : EFFECT_COSTS.length);
  rows.sort(
    (a, b) =>
      a.favourite - b.favourite ||
      (sort === "category" ? byCategory(a.effect) - byCategory(b.effect) : 0) ||
      b.score - a.score ||
      (sort === "az" || sort === "category" ? collator.compare(a.effect.name, b.effect.name) : 0) ||
      (sort === "lightest" ? byCost(a.effect) - byCost(b.effect) : 0) ||
      a.index - b.index,
  );
  return rows.map((r) => r.effect);
}

/**
 * The heading an effect is listed under, if the list is grouped: "Favourites" for a
 * starred effect, else its category when sorting by category.
 */
export function effectGroup(effect: ListableEffect, options: ListOptions): string | undefined {
  if (options.favourites?.has(effect.id)) return FAVOURITES_GROUP;
  return options.sort === "category" ? effect.category : undefined;
}

/**
 * The effect ← (`dir` -1) or → (`dir` 1) moves to from `currentId`, wrapping at either
 * end. If the search hides the current effect, it steps from where the current effect
 * would sort without the search. Undefined when nothing is listed.
 */
export function stepEffect<T extends ListableEffect>(
  effects: readonly T[],
  options: ListOptions,
  currentId: string,
  dir: 1 | -1,
): T | undefined {
  const visible = visibleEffects(effects, options);
  const n = visible.length;
  if (n === 0) return undefined;
  const i = visible.findIndex((e) => e.id === currentId);
  if (i >= 0) return visible[(i + dir + n) % n];

  const all = visibleEffects(effects, { ...options, query: undefined });
  const from = all.findIndex((e) => e.id === currentId);
  if (from < 0) return dir > 0 ? visible[0] : visible[n - 1];
  const shown = new Set(visible);
  for (let k = 1; k < all.length; k++) {
    const e = all[(((from + dir * k) % all.length) + all.length) % all.length];
    if (shown.has(e)) return e;
  }
  return undefined;
}

/** The effects ← and → lead to, to prefetch: next first, without repeats or the current one. */
export function adjacentEffects<T extends ListableEffect>(
  effects: readonly T[],
  options: ListOptions,
  currentId: string,
): T[] {
  const out: T[] = [];
  for (const dir of [1, -1] as const) {
    const e = stepEffect(effects, options, currentId, dir);
    if (e && e.id !== currentId && !out.includes(e)) out.push(e);
  }
  return out;
}
