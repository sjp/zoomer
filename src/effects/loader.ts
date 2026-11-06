import type { EffectDefinition, EffectMeta } from "./types";

/** A registry entry: an effect's metadata plus a dynamic import of its implementation. */
export type EffectEntry = EffectMeta & {
  /** Imports the implementation module. Call through an {@link EffectLoader}, which caches. */
  load: () => Promise<EffectDefinition>;
};

export interface EffectLoader {
  /** The implementation if it has already loaded, so a cached switch needs no async step. */
  get: (id: string) => EffectDefinition | undefined;
  /**
   * Loads an implementation once: repeated and concurrent calls share one promise. A
   * failed load is dropped from the cache, so the next call tries the import again.
   */
  load: (entry: EffectEntry) => Promise<EffectDefinition>;
  /** Starts loading in the background; failures are ignored (a later `load` retries). */
  prefetch: (entry: EffectEntry) => void;
}

export function createEffectLoader(): EffectLoader {
  const pending = new Map<string, Promise<EffectDefinition>>();
  const loaded = new Map<string, EffectDefinition>();

  const load = (entry: EffectEntry) => {
    let promise = pending.get(entry.id);
    if (!promise) {
      promise = entry.load().then(
        (effect) => {
          // A registry typo would otherwise run one effect under another's params.
          if (effect.id !== entry.id) {
            throw new Error(`Loaded effect "${effect.id}" for "${entry.id}"`);
          }
          loaded.set(entry.id, effect);
          return effect;
        },
        (err: unknown) => {
          pending.delete(entry.id);
          throw err;
        },
      );
      pending.set(entry.id, promise);
    }
    return promise;
  };

  return {
    get: (id) => loaded.get(id),
    load,
    prefetch(entry) {
      load(entry).catch(() => {});
    },
  };
}

/**
 * Hands each result on only while its request is still the latest, so when the user
 * switches A → B → C quickly and the loads finish out of order, only C starts.
 */
export function createLatest<T>() {
  let token = 0;
  return {
    run(promise: Promise<T>, onResult: (value: T) => void, onError: (err: unknown) => void) {
      const mine = ++token;
      void promise.then(
        (value) => {
          if (mine === token) {
            onResult(value);
          }
          return undefined;
        },
        (err: unknown) => {
          if (mine === token) {
            onError(err);
          }
        },
      );
    },
    /** Drops whatever is in flight. */
    cancel() {
      token++;
    },
  };
}

/**
 * Calls `task` when the browser is idle (or after a short timeout where
 * `requestIdleCallback` is missing, as in Safari). Returns a cancel function.
 */
export function whenIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(task, { timeout: 2000 });
    return () => {
      cancelIdleCallback(handle);
    };
  }
  const handle = setTimeout(task, 200);
  return () => {
    clearTimeout(handle);
  };
}
