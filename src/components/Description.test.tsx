// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defined } from "../test/defined";
import { Description } from "./Description";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Lays the text out as `lines` lines of 20 px, of which a clamped paragraph shows 2. */
function layOut(lines: number) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(lines * 20);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.clamped === "true" ? Math.min(lines, 2) * 20 : lines * 20;
  });
}

const paragraph = () => defined(document.querySelector<HTMLElement>(".description"));

describe("Description", () => {
  it("clamps long text to two lines with a More / Less toggle", () => {
    layOut(4);
    render(<Description text="A long description" clamp />);
    expect(paragraph().dataset.clamped).toBe("true");
    const more = screen.getByRole("button", { name: "More" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe(paragraph().id);
    fireEvent.click(more);
    expect(paragraph().dataset.clamped).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Less" }));
    expect(paragraph().dataset.clamped).toBe("true");
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
  });

  it("offers no toggle when the text fits", () => {
    layOut(2);
    render(<Description text="Short" clamp />);
    expect(paragraph().dataset.clamped).toBe("true");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the whole text without clamping", () => {
    layOut(4);
    render(<Description text="A long description" clamp={false} />);
    expect(paragraph().dataset.clamped).toBe("false");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
