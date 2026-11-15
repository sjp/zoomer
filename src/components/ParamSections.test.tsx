// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParamSchema, ParamValue } from "../effects/types";
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
    fireEvent.change(screen.getByRole("slider", { name: /^A/ }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset B" }));
    expect(onParamChange.mock.calls).toEqual([
      ["a", 3],
      ["b", 5],
    ]);
  });
});
