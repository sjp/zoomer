/**
 * `table[key]`, or `table[fallback]` when `key` is not one of the table's own ids, e.g. a
 * select value from an old or hand-edited URL. Inherited names such as `toString` or
 * `__proto__` are not ids.
 */
export function lookup<K extends string, V>(
  table: Readonly<Record<K, V>>,
  key: string,
  fallback: K,
): V {
  return has(table, key) ? (table as Readonly<Record<string, V>>)[key] : table[fallback];
}

/** Whether `table` has its own entry for `key`, e.g. a select value from an old or hand-edited URL. */
export function has(table: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(table, key);
}
