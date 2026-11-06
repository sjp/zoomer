/** A short, human-readable reason for a thrown value, for showing in the UI. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** `err` itself if it is an Error, else an Error carrying its description, with it as the cause. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(describeError(err), { cause: err });
}
