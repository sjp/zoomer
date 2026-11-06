/**
 * `table[key]`, or `table[fallback]` when `key` is not one of the table's ids, e.g. a
 * select value from an old or hand-edited URL.
 */
export function lookup<K extends string, V>(
  table: Readonly<Record<K, V>>,
  key: string,
  fallback: K,
): V {
  return (table as Readonly<Partial<Record<string, V>>>)[key] ?? table[fallback];
}

/** Whether `table` has an entry for `key`, e.g. a select value from an old or hand-edited URL. */
export function has(table: Readonly<Record<string, unknown>>, key: string): boolean {
  return (table as Readonly<Partial<Record<string, unknown>>>)[key] !== undefined;
}
