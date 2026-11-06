import { describe, expect, it } from "vitest";
import {
  loadSort,
  readPreference,
  saveSort,
  writePreference,
  type PreferenceStorage,
} from "./preferences";

function memoryStorage(): PreferenceStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const throwing: PreferenceStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("sort preference", () => {
  it("survives a reload", () => {
    const storage = memoryStorage();
    expect(loadSort(() => storage)).toBe("featured");
    saveSort("lightest", () => storage);
    expect(loadSort(() => storage)).toBe("lightest");
  });

  it("falls back to Featured for an unknown stored value", () => {
    const storage = memoryStorage();
    storage.setItem("zoomer.effectSort", "newest");
    expect(loadSort(() => storage)).toBe("featured");
  });

  it("falls back to Featured when storage throws or is missing", () => {
    expect(() => {
      saveSort("az", () => throwing);
    }).not.toThrow();
    expect(loadSort(() => throwing)).toBe("featured");
    expect(loadSort(() => undefined)).toBe("featured");
    expect(
      loadSort(() => {
        throw new Error("no window");
      }),
    ).toBe("featured");
  });

  it("reads and writes nothing without a window", () => {
    // Vitest runs in Node, where `window` doesn't exist.
    expect(readPreference("zoomer.effectSort")).toBeNull();
    expect(() => {
      writePreference("zoomer.effectSort", "az");
    }).not.toThrow();
  });
});
