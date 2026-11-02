/**
 * Runs every registered effect through `create`, `resize`, a few `frame`s and
 * `dispose` on the recording fake context, checking the WebGL rules every effect
 * must follow (see issues/README.md): uniforms written only to the bound program,
 * every object deleted on dispose, the default framebuffer and FUNC_ADD left at
 * the end of each frame, and nothing leaked when `create` throws part-way.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeGl, type FakeGl, type FakeGlOptions } from "../test/fake-gl";
import { defaults } from "./params";
import { effects } from "./registry";
import type { AnyParamValues, EffectWebGL2, ParamSchema, Viewport } from "./types";

/** Digital rain draws its glyph atlas on an OffscreenCanvas, which Node lacks. */
class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return new Proxy({}, { get: (_, key) => (key === "then" ? undefined : () => undefined) });
  }
}

beforeAll(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const webgl = effects.filter((e): e is EffectWebGL2 => e.context === "webgl2");

const viewport = (width: number, height: number): Viewport => ({
  width,
  height,
  scale: height / 1080,
});

/** Param sets that reach the ends of every slider and every select option. */
function paramSets(schema: ParamSchema): AnyParamValues[] {
  const base = defaults(schema);
  const atMin: AnyParamValues = { ...base };
  const atMax: AnyParamValues = { ...base };
  const sets = [base, atMax, atMin];
  for (const [key, def] of Object.entries(schema)) {
    if (def.kind === "number") {
      atMin[key] = def.min;
      atMax[key] = def.max;
    } else if (def.kind === "boolean") {
      atMin[key] = !def.default;
      atMax[key] = !def.default;
    } else if (def.kind === "color") {
      atMin[key] = "#000000";
      atMax[key] = "#ffffff";
    } else {
      for (const o of def.options) sets.push({ ...base, [key]: o.value });
    }
  }
  sets.push(base);
  return sets;
}

/** Messages for anything the frame left that the next effect would trip over. */
function frameEndProblems(fake: FakeGl): string[] {
  const s = fake.state;
  const out: string[] = [];
  if (s.drawFramebuffer !== null) out.push(`draw framebuffer ${s.drawFramebuffer.id} left bound`);
  if (s.readFramebuffer !== null) out.push(`read framebuffer ${s.readFramebuffer.id} left bound`);
  if (s.blendEquationRgb !== "FUNC_ADD" || s.blendEquationAlpha !== "FUNC_ADD") {
    out.push(`blend equation left as ${s.blendEquationRgb}/${s.blendEquationAlpha}`);
  }
  return out;
}

function run(effect: EffectWebGL2, options: FakeGlOptions = {}) {
  const fake = createFakeGl(options);
  const instance = effect.create(fake.gl);
  const problems: string[] = [];
  const frames = (n: number, params: AnyParamValues, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      instance.frame(dt, params as never);
      problems.push(...frameEndProblems(fake));
    }
  };
  const sets = paramSets(effect.params);
  instance.resize(viewport(640, 360));
  frames(3, sets[0], 0);
  frames(3, sets[0]);
  for (const params of sets) frames(2, params);
  // A resize mid-run, a long hitch, then a tiny canvas and back.
  instance.resize(viewport(1280, 720));
  frames(2, sets[0], 0.1);
  instance.resize(viewport(16, 9));
  frames(2, sets[1]);
  instance.resize(viewport(640, 360));
  frames(2, sets[0]);
  const draws = fake.draws();
  instance.dispose?.();
  return { fake, problems, draws };
}

describe.each(webgl.map((e) => [e.id, e] as const))("%s", (_, effect) => {
  it.each([
    ["without", []],
    ["with", ["EXT_color_buffer_float"]],
  ])("follows the GL rules %s float render targets", (_, extensions) => {
    const { fake, problems, draws } = run(effect, { extensions });
    expect(fake.errors).toEqual([]);
    expect([...new Set(problems)]).toEqual([]);
    expect(draws).toBeGreaterThan(0);
    expect(fake.live().map((o) => `${o.kind} ${o.id}`)).toEqual([]);
  });

  it("frees everything when a shader fails to compile part-way through create", () => {
    // Fail each compile in turn, until create gets past every one of them.
    for (let failAt = 0; ; failAt++) {
      const fake = createFakeGl({ failCompileAt: failAt });
      let error: unknown;
      try {
        effect.create(fake.gl).dispose?.();
      } catch (err) {
        error = err;
      }
      expect(String(error ?? "failed to compile")).toMatch(/failed to compile/);
      expect(fake.errors).toEqual([]);
      expect(fake.live().map((o) => `${o.kind} ${o.id}`)).toEqual([]);
      if (error === undefined) break;
    }
  });
});
