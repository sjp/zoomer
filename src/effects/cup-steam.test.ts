import { describe, expect, it } from "vitest";
import { STEAM_LIFE, STEAM_WISP, steamEmitter, steamFlow } from "./cup-steam";
import type { Flow } from "./smoke/smoke-sim";

describe("steamEmitter", () => {
  it("maps any steam value to bounded emitter values", () => {
    const e = { strength: 0, life: 0, wisp: 0 };
    let ok = true;
    for (const s of [-1, 0, 0.25, 0.5, 1, 2, Number.NaN, Infinity]) {
      steamEmitter(s, e);
      ok &&= e.strength >= 0 && e.strength <= 1;
      ok &&= e.life >= STEAM_LIFE[0] && e.life <= STEAM_LIFE[1];
      ok &&= e.wisp >= STEAM_WISP[1] && e.wisp <= STEAM_WISP[0];
    }
    expect(ok).toBe(true);
  });

  it("emits nothing at 0 and grows with the param", () => {
    const a = steamEmitter(0, { strength: 0, life: 0, wisp: 0 });
    expect(a.strength).toBe(0);
    const b = steamEmitter(0.4, { strength: 0, life: 0, wisp: 0 });
    const c = steamEmitter(0.9, { strength: 0, life: 0, wisp: 0 });
    expect(c.strength).toBeGreaterThan(b.strength);
    expect(c.life).toBeGreaterThan(b.life);
  });

  it("fills a flow whose curl onset is a proper band", () => {
    const f: Flow = steamFlow({ rise: 0, draft: 0, curl: 0, onset0: 0, onset1: 0 });
    expect(f.rise).toBeGreaterThan(0);
    expect(f.curl).toBeGreaterThan(0);
    expect(f.onset1).toBeGreaterThan(f.onset0);
  });
});
