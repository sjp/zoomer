import { describe, expect, it } from "vitest";
import { bokeh, bokehLightCount } from "./bokeh";

describe("bokehLightCount", () => {
  const p = bokeh.params;

  it("leaves the default settings alone", () => {
    expect(bokehLightCount(p.count.default, p.size.default, p.sizeVariation.default, 1920)).toBe(
      p.count.default,
    );
    expect(bokehLightCount(p.count.max, p.size.default, p.sizeVariation.default, 1920)).toBe(
      p.count.max,
    );
  });

  it("draws far fewer lights at the largest sizes", () => {
    const n = bokehLightCount(p.count.max, p.size.max, p.sizeVariation.max, 1920);
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(40);
  });

  it("falls with size and variation and rises with screen width", () => {
    const a = bokehLightCount(200, 150, 0.5, 1920);
    expect(bokehLightCount(200, 180, 0.5, 1920)).toBeLessThan(a);
    expect(bokehLightCount(200, 150, 0.8, 1920)).toBeLessThan(a);
    expect(bokehLightCount(200, 150, 0.5, 3840)).toBeGreaterThan(a);
    expect(bokehLightCount(200, 150, 0, 1920)).toBeGreaterThan(a);
  });

  it("returns a whole count within 1..count", () => {
    expect(bokehLightCount(12.6, 20, 0, 1920)).toBe(12);
    expect(bokehLightCount(5, 1e6, 1, 1920)).toBe(1);
    expect(bokehLightCount(500, 20, 0, 1920)).toBe(200);
  });
});
