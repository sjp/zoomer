import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  it("uses the clipboard API when it works", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const legacyCopy = vi.fn<(text: string) => boolean>(() => true);
    await expect(copyText("a", { writeText, legacyCopy })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("a");
    expect(legacyCopy).not.toHaveBeenCalled();
  });

  it("falls back to the old way when the API is missing, as off localhost over http", async () => {
    const legacyCopy = vi.fn<(text: string) => boolean>(() => true);
    await expect(copyText("b", { legacyCopy })).resolves.toBe(true);
    expect(legacyCopy).toHaveBeenCalledWith("b");
  });

  it("falls back when the API refuses", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() =>
      Promise.reject(new Error("Document is not focused")),
    );
    const legacyCopy = vi.fn<(text: string) => boolean>(() => true);
    await expect(copyText("c", { writeText, legacyCopy })).resolves.toBe(true);
    expect(legacyCopy).toHaveBeenCalledWith("c");
  });

  it("reports failure when neither works", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() =>
      Promise.reject(new Error("denied")),
    );
    await expect(copyText("d", { writeText, legacyCopy: () => false })).resolves.toBe(false);
  });
});
