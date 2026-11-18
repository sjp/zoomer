// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParamSchema, ParamValue } from "../effects/types";
import { defined } from "../test/defined";
import { ParamSections } from "./ParamSections";

afterEach(() => {
  cleanup();
});

const num = (label: string, group?: string) =>
  ({
    kind: "number",
    label,
    min: 0,
    max: 10,
    step: 1,
    default: 5,
    ...(group === undefined ? {} : { group }),
  }) as const;
const colour = (label: string, group?: string) =>
  ({
    kind: "color",
    label,
    default: "#000000",
    ...(group === undefined ? {} : { group }),
  }) as const;

function renderSections(schema: ParamSchema, values: Record<string, ParamValue> = {}) {
  const onToggle = vi.fn<(name: string) => void>();
  const onParamChange = vi.fn<(key: string, value: ParamValue) => void>();
  const view = render(
    <ParamSections
      effectId="test"
      schema={schema}
      values={values}
      closed={new Set(["Colours"])}
      onToggle={onToggle}
      onParamChange={onParamChange}
    />,
  );
  return { onToggle, onParamChange, view };
}

describe("ParamSections", () => {
  it("shows a lone section's controls without a header", () => {
    renderSections({ a: num("A"), b: num("B") });
    expect(screen.getAllByRole("slider")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gives each section a header that controls its region, with the changed count", () => {
    const { onToggle } = renderSections(
      { a: num("A"), b: num("B"), c: colour("C") },
      { a: 1, b: 2 },
    );
    const settings = screen.getByRole("button", { name: "Settings 2 changed" });
    expect(settings.getAttribute("aria-expanded")).toBe("true");
    const region = document.getElementById(settings.getAttribute("aria-controls") ?? "");
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.contains(screen.getByRole("slider", { name: /^A/ }))).toBe(true);
    // Closed sections stay mounted but hidden.
    const colours = screen.getByRole("button", { name: "Colours" });
    expect(colours.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(colours.getAttribute("aria-controls") ?? "")?.hidden).toBe(true);
    fireEvent.click(colours);
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("Colours");
  });

  it("reports changes and resets by key", () => {
    const { onParamChange } = renderSections({ a: num("A"), b: num("B", "X") }, { b: 9 });
    fireEvent.input(screen.getByRole("slider", { name: /^A/ }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset B" }));
    expect(onParamChange.mock.calls).toEqual([
      ["a", 3],
      ["b", 5],
    ]);
  });

  it("shows consecutive colours as captioned swatches, named by their full label", () => {
    const { onParamChange } = renderSections(
      {
        a: colour("Light colour 1", "Look"),
        b: colour("Sky top colour", "Look"),
        c: colour("Wax colour (top)", "Look"),
        d: num("Size", "Look"),
        e: colour("Background", "Look"),
      },
      { b: "#ffffff" },
    );
    expect(document.querySelectorAll(".swatches")).toHaveLength(1);
    const grid = [defined(document.querySelector(".swatches"), "the swatch grid")];
    expect([...grid[0].querySelectorAll("label")].map((l) => l.textContent)).toEqual([
      "Light 1",
      "Sky top",
      "Wax (top)",
    ]);
    const sky = screen.getByLabelText<HTMLInputElement>("Sky top colour");
    expect(sky.type).toBe("color");
    expect(grid[0].contains(sky)).toBe(true);
    // The caption opens the same picker.
    expect(screen.getByText("Sky top").closest("label")?.htmlFor).toBe(sky.id);
    // A colour on its own keeps an ordinary row.
    expect(grid[0].contains(screen.getByLabelText("Background"))).toBe(false);
    fireEvent.input(sky, { target: { value: "#123456" } });
    const reset = screen.getByRole("button", { name: "Reset Sky top colour" });
    expect(reset.closest("label")).toBeNull();
    fireEvent.click(reset);
    expect(onParamChange.mock.calls).toEqual([
      ["b", "#123456"],
      ["b", "#000000"],
    ]);
  });
});
