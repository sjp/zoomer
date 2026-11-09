import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWebFont, webFontLoaded } from "./web-font";

let constructed = 0;
let fail = false;
const added: unknown[] = [];

class StubFontFace {
  readonly family: string;
  constructor(family: string) {
    this.family = family;
    constructed++;
  }
  load(): Promise<this> {
    return fail ? Promise.reject(new Error("offline")) : Promise.resolve(this);
  }
}

beforeEach(() => {
  constructed = 0;
  fail = false;
  added.length = 0;
  vi.stubGlobal("FontFace", StubFontFace);
  vi.stubGlobal("document", { fonts: { add: (f: unknown) => added.push(f) } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadWebFont", () => {
  it("loads and registers a face once, however often it is asked for", async () => {
    expect(webFontLoaded("Once", "/once.woff2")).toBe(false);
    const first = loadWebFont("Test", "Once", "/once.woff2");
    const second = loadWebFont("Test", "Once", "/once.woff2");
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(webFontLoaded("Once", "/once.woff2")).toBe(true);
    expect(await loadWebFont("Test", "Once", "/once.woff2")).toBe(true);
    expect(constructed).toBe(1);
    expect(added).toHaveLength(1);
  });

  it("forgets a failed load, so a later call retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fail = true;
    expect(await loadWebFont("Test", "Flaky", "/flaky.woff2")).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(webFontLoaded("Flaky", "/flaky.woff2")).toBe(false);
    fail = false;
    expect(await loadWebFont("Test", "Flaky", "/flaky.woff2")).toBe(true);
    expect(constructed).toBe(2);
    expect(added).toHaveLength(1);
  });

  it("resolves false where there is no FontFace", async () => {
    vi.stubGlobal("FontFace", undefined);
    expect(await loadWebFont("Test", "None", "/none.woff2")).toBe(false);
    expect(webFontLoaded("None", "/none.woff2")).toBe(false);
  });
});
