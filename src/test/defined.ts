/** Returns `value`, failing the test if it is null or undefined. Use instead of `!` in tests. */
export function defined<T>(value: T, what = "value"): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be defined`);
  }
  return value;
}
