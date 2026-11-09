// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParamDef, ParamValue } from "../effects/types";
import { ParamControl } from "./ParamControl";

afterEach(() => {
  cleanup();
});

function renderControl(def: ParamDef, value: ParamValue) {
  const onChange = vi.fn<(v: ParamValue) => void>();
  const view = render(<ParamControl id="p" def={def} value={value} onChange={onChange} />);
  return { onChange, view };
}

describe("ParamControl", () => {
  it("renders a slider with its value and reports numbers", () => {
    const { onChange } = renderControl(
      { kind: "number", label: "Speed", min: 0, max: 2, step: 0.05, default: 1 },
      1.5,
    );
    const input = screen.getByRole<HTMLInputElement>("slider");
    expect(input.type).toBe("range");
    expect(screen.getByText("1.50")).toBeTruthy();
    fireEvent.change(input, { target: { value: "0.25" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(0.25);
  });

  it("renders a colour input and reports the hex string", () => {
    const { onChange } = renderControl(
      { kind: "color", label: "Tint", default: "#000000" },
      "#112233",
    );
    const input = screen.getByLabelText<HTMLInputElement>("Tint");
    expect(input.value).toBe("#112233");
    fireEvent.input(input, { target: { value: "#abcdef" } });
    expect(onChange).toHaveBeenLastCalledWith("#abcdef");
  });

  it("renders a checkbox and reports booleans", () => {
    const { onChange } = renderControl({ kind: "boolean", label: "Glow", default: true }, true);
    const input = screen.getByLabelText<HTMLInputElement>("Glow");
    expect(input.checked).toBe(true);
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("renders a select with every option and reports the value", () => {
    const { onChange } = renderControl(
      {
        kind: "select",
        label: "Mode",
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
        default: "a",
      },
      "a",
    );
    const select = screen.getByLabelText<HTMLSelectElement>("Mode");
    expect([...select.options].map((o) => o.textContent)).toEqual(["Alpha", "Beta"]);
    fireEvent.change(select, { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("b");
  });

  describe("text", () => {
    const def: ParamDef = { kind: "text", label: "Sign", default: "", maxLength: 5, maxLines: 2 };

    it("sanitises each edit", () => {
      const { onChange } = renderControl(def, "");
      const area = screen.getByLabelText<HTMLTextAreaElement>("Sign");
      expect(area.getAttribute("rows")).toBe("2");
      fireEvent.change(area, { target: { value: "abcdefgh\nij\nkl‮" } });
      expect(onChange).toHaveBeenCalledExactlyOnceWith("abcde\nij");
    });

    it("holds raw text while an input method composes, then sanitises once", () => {
      const { onChange } = renderControl(def, "ab");
      const area = screen.getByLabelText<HTMLTextAreaElement>("Sign");
      fireEvent.compositionStart(area);
      fireEvent.change(area, { target: { value: "abcdefg" } });
      expect(onChange).not.toHaveBeenCalled();
      expect(area.value).toBe("abcdefg");
      fireEvent.compositionEnd(area);
      expect(onChange).toHaveBeenCalledExactlyOnceWith("abcde");
    });
  });
});
