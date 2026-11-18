// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelErrorBoundary } from "./PanelErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Broken(): never {
  throw new Error("boom");
}

describe("PanelErrorBoundary", () => {
  it("renders its children while they work", () => {
    render(
      <PanelErrorBoundary>
        <p>controls</p>
      </PanelErrorBoundary>,
    );
    expect(screen.getByText("controls")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a fallback with a reload button when a child throws, and logs the error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <div>
        <PanelErrorBoundary>
          <Broken />
        </PanelErrorBoundary>
        <p>canvas</p>
      </div>,
    );
    expect(screen.getByRole("alert").textContent).toContain("The controls crashed");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    // The rest of the tree (the canvas, in the app) keeps rendering.
    expect(screen.getByText("canvas")).toBeTruthy();
    expect(error.mock.calls[0]?.slice(0, 2)).toEqual([
      "The control panel crashed:",
      new Error("boom"),
    ]);
  });
});
