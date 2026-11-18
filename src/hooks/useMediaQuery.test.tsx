// @vitest-environment happy-dom
import { cleanup, renderHook } from "@testing-library/preact";
import { act } from "../test/act";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMedia } from "../test/media";
import { useCanHover, useMediaQuery } from "./useMediaQuery";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useMediaQuery", () => {
  it("follows the query as it starts and stops matching", () => {
    const media = mockMedia([]);
    const { result } = renderHook(() => useMediaQuery("(max-width: 640px)"));
    expect(result.current).toBe(false);
    act(() => {
      media.set(["(max-width: 640px)"]);
    });
    expect(result.current).toBe(true);
  });

  it("can't hover where the primary pointer has no hover", () => {
    mockMedia(["(hover: none)"]);
    expect(renderHook(() => useCanHover()).result.current).toBe(false);
    mockMedia([]);
    expect(renderHook(() => useCanHover()).result.current).toBe(true);
  });
});
