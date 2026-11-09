// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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

    /** Types into the textarea the way a browser does: a new value, then the caret. */
    function edit(area: HTMLTextAreaElement, text: string, caret: number) {
      // The prototype's setter, so React's value tracker sees a real edit.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        area,
        text,
      );
      area.setSelectionRange(caret, caret);
      fireEvent.input(area);
    }

    /** A text control whose parent keeps the value, as the app does. */
    function renderStateful(initial: string) {
      function Host() {
        const [value, setValue] = useState<ParamValue>(initial);
        return <ParamControl id="p" def={def} value={value} onChange={setValue} />;
      }
      render(<Host />);
      return screen.getByLabelText<HTMLTextAreaElement>("Sign");
    }

    it("keeps the caret in place when sanitising strips a character before it", () => {
      const area = renderStateful("abd");
      // "c" typed after a bidi override that was pasted after "ab": caret after the "c".
      edit(area, "ab\u202ecd", 4);
      expect(area.value).toBe("abcd");
      expect(area.selectionStart).toBe(3);
      expect(area.selectionEnd).toBe(3);
    });

    it("keeps the caret in place when a typed character overfills the line", () => {
      const area = renderStateful("abcde\nfg");
      // "x" typed after "ab" on a full line pushes the last character off the end.
      edit(area, "abxcde\nfg", 3);
      expect(area.value).toBe("abxcd\nfg");
      expect(area.selectionStart).toBe(3);
    });

    it("keeps the caret in place when the sanitised text is unchanged", () => {
      const area = renderStateful("abcd");
      // A stripped character typed after "ab": React puts the old value back.
      edit(area, "ab\u202ecd", 3);
      expect(area.value).toBe("abcd");
      expect(area.selectionStart).toBe(2);
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
