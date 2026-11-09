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
  if (value === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

interface Favourites {
  /** Every starred id, including ones no effect has any more. A new set on each change. */
  get: () => ReadonlySet<string>;
  /** Stars `id`, or unstars it if it's starred, and saves the result. */
  toggle: (id: string) => void;
  subscribe: (listener: () => void) => () => void;
}

/**
 * The favourites store. It follows changes other tabs make: each `storage` event for
 * the key (or for the whole storage being cleared) reloads the stored list, so this
 * tab's next toggle doesn't write over another tab's.
 */
export function createFavourites(
  storage: () => PreferenceStorage | undefined = browserStorage,
  events: Pick<EventTarget, "addEventListener"> | undefined = typeof window === "undefined"
    ? undefined
    : window,
): Favourites {
  const load = () => new Set(parseFavourites(readPreference(FAVOURITES_KEY, storage)));
  const store = createStore<ReadonlySet<string>>(load());
  events?.addEventListener("storage", (e) => {
    // A StorageEvent's key; null when the whole storage was cleared.
    const key = "key" in e ? e.key : undefined;
    if (key === FAVOURITES_KEY || key === null) {
      store.set(load());
    }
  });
  return {
    get: store.get,
    subscribe: store.subscribe,
    toggle: (id) => {
      const next = new Set(store.get());
      if (!next.delete(id)) {
        next.add(id);
      }
      store.set(next);
      writePreference(FAVOURITES_KEY, JSON.stringify([...next]), storage);
    },
  };
}
