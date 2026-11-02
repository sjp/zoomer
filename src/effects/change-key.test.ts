import { describe, expect, it } from "vitest";
import { createChangeKey } from "./change-key";

describe("createChangeKey", () => {
  it("is dirty on first use, then only when an input changes", () => {
    const key = createChangeKey(2);
    key.set(0, 0);
    key.set(1, 0);
    expect(key.take()).toBe(true);
    key.set(0, 0);
    key.set(1, 0);
    expect(key.take()).toBe(false);
    key.set(1, 0.5);
    expect(key.take()).toBe(true);
    expect(key.take()).toBe(false);
  });

  it("stays dirty until taken, even if the input changes back", () => {
    const key = createChangeKey(1);
    key.set(0, 1);
    key.take();
    key.set(0, 2);
    key.set(0, 1);
    expect(key.take()).toBe(true);
  });

  it("can be invalidated", () => {
    const key = createChangeKey(1);
    key.take();
    key.invalidate();
    expect(key.take()).toBe(true);
  });
});
