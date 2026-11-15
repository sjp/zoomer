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

const OUTPUT_OPEN_KEY = "zoomer.outputOpen";

/** Whether the panel's Output section is open; closed by default. */
export function loadOutputOpen(storage?: () => PreferenceStorage | undefined): boolean {
  return readPreference(OUTPUT_OPEN_KEY, storage) === "open";
}

export function saveOutputOpen(open: boolean, storage?: () => PreferenceStorage | undefined): void {
  writePreference(OUTPUT_OPEN_KEY, open ? "open" : "closed", storage);
}

const CLOSED_SECTIONS_KEY = "zoomer.closedSections";

/**
 * The names of the panel sections the viewer has closed, such as "Colours". Sections
 * are open by default, and a name stays closed across every effect that uses it.
 */
export function loadClosedSections(
  storage?: () => PreferenceStorage | undefined,
): ReadonlySet<string> {
  const raw = readPreference(CLOSED_SECTIONS_KEY, storage);
  if (raw === null) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function saveClosedSections(
  closed: ReadonlySet<string>,
  storage?: () => PreferenceStorage | undefined,
): void {
  writePreference(CLOSED_SECTIONS_KEY, JSON.stringify([...closed]), storage);
}
