/**
 * Starred effects, remembered per browser in `localStorage` as a JSON list
 * of effect ids. They're personal, so they stay out of the URL hash.
 *
 * Ids of effects that no longer exist stay stored, so an effect that is removed for a
 * while keeps its star; the list ignores them (`visibleEffects`). Without storage the
 * favourites still work for the session, in memory.
 */
import {
  browserStorage,
  readPreference,
  writePreference,
  type PreferenceStorage,
} from "./preferences";
import { createStore } from "./store";

const FAVOURITES_KEY = "zoomer.favourites";

/** The ids in a stored value; anything malformed reads as no favourites. */
export function parseFavourites(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export interface Favourites {
  /** Every starred id, including ones no effect has any more. A new set on each change. */
  get: () => ReadonlySet<string>;
  /** Stars `id`, or unstars it if it's starred, and saves the result. */
  toggle: (id: string) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createFavourites(
  storage: () => PreferenceStorage | undefined = browserStorage,
): Favourites {
  const store = createStore<ReadonlySet<string>>(
    new Set(parseFavourites(readPreference(FAVOURITES_KEY, storage))),
  );
  return {
    get: store.get,
    subscribe: store.subscribe,
    toggle: (id) => {
      const next = new Set(store.get());
      if (!next.delete(id)) next.add(id);
      store.set(next);
      writePreference(FAVOURITES_KEY, JSON.stringify([...next]), storage);
    },
  };
}
