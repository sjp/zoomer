/**
 * Small per-browser preferences in `localStorage`. Storage can be missing or throw
 * (private browsing, blocked cookies, a full quota), so every access is guarded:
 * reads fall back to the default and writes are dropped.
 */
import { DEFAULT_SORT, isEffectSort, type EffectSort } from "../effects/list";

export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

/** The browser's storage, or undefined where touching it throws. */
export function browserStorage(): PreferenceStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readPreference(
  key: string,
  storage: () => PreferenceStorage | undefined = browserStorage,
): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writePreference(
  key: string,
  value: string,
  storage: () => PreferenceStorage | undefined = browserStorage,
): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Not remembered; the choice still applies for this session.
  }
}

const SORT_KEY = "zoomer.effectSort";

/** The effect list's sort order, remembered across reloads; "Featured" by default. */
export function loadSort(storage?: () => PreferenceStorage | undefined): EffectSort {
  const value = readPreference(SORT_KEY, storage);
  return isEffectSort(value) ? value : DEFAULT_SORT;
}

export function saveSort(sort: EffectSort, storage?: () => PreferenceStorage | undefined): void {
  writePreference(SORT_KEY, sort, storage);
}
