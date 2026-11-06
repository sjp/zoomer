import { describe, expect, it } from "vitest";
import { describeError } from "./errors";

describe("describeError", () => {
  it("uses an Error's message", () => {
    expect(describeError(new Error("Shader failed to compile"))).toBe("Shader failed to compile");
  });

  it("falls back to the error's name when the message is empty", () => {
    const err = new TypeError("placeholder");
    err.message = "";
    expect(describeError(err)).toBe("TypeError");
  });

  it("passes strings through", () => {
    expect(describeError("boom")).toBe("boom");
  });

  it("stringifies other values", () => {
    expect(describeError(42)).toBe("42");
    expect(describeError(null)).toBe("null");
  });

  it("survives values that cannot be stringified", () => {
    expect(describeError(Object.create(null))).toBe("Unknown error");
  });
});
