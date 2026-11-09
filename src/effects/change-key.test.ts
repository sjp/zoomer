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

  it("compares strings by value", () => {
    const key = createChangeKey(1);
    key.setText(0, "left");
    key.take();
    key.setText(0, ["le", "ft"].join(""));
    expect(key.take()).toBe(false);
    key.setText(0, "right");
    expect(key.take()).toBe(true);
    key.setText(0, "left");
    expect(key.take()).toBe(true);
  });

  it("compares colours by their RGB value", () => {
    const key = createChangeKey(1);
    key.setColor(0, "#ff8000");
    key.take();
    key.setColor(0, "#FF8000");
    expect(key.take()).toBe(false);
    key.setColor(0, "#ff8001");
    expect(key.take()).toBe(true);
  });

  it("compares free text with the last string at its index", () => {
    const key = createChangeKey(2);
    key.setString(0, "HELLO");
    key.setString(1, "WORLD");
    key.take();
    key.setString(0, ["HEL", "LO"].join(""));
    key.setString(1, "WORLD");
    expect(key.take()).toBe(false);
    key.setString(1, "WORLD\nAGAIN");
    expect(key.take()).toBe(true);
    key.setString(1, "WORLD\nAGAIN");
    expect(key.take()).toBe(false);
  });
});
