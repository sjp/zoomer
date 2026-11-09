/**
 * Runs each registered effect through `create`, `resize`, a few `frame`s and
 * `dispose` on the recording fake context, checking the WebGL rules every effect
 * must follow: uniforms written only to the bound program,
 * every object deleted on dispose, the default framebuffer and FUNC_ADD left at
 * the end of each frame, and nothing leaked when `create` throws part-way.
 *
 * The effects are split by category across test files
 * (`src/effects/lifecycle-<category>.test.ts`), each calling `describeLifecycle`,
 * so Vitest runs them on separate workers instead of one file running every
 * effect in turn. `registry.test.ts` checks every category has its file.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeGl, type FakeGl, type FakeGlOptions } from "./fake-gl";
import { FakeOffscreenCanvas } from "./offscreen-canvas";
import { paramSets } from "./param-sets";
import { effects } from "../effects/registry";
import type {
  AnyParamValues,
  EFFECT_CATEGORIES,
  EffectDefinition,
  Viewport,
} from "../effects/types";

const viewport = (width: number, height: number): Viewport => ({
  width,
  height,
  scale: height / 1080,
});

/** Messages for anything the frame left that the next effect would trip over. */
function frameEndProblems(fake: FakeGl): string[] {
  const s = fake.state;
  const out: string[] = [];
  if (s.drawFramebuffer !== null) {
    out.push(`draw framebuffer ${String(s.drawFramebuffer.id)} left bound`);
  }
  if (s.readFramebuffer !== null) {
    out.push(`read framebuffer ${String(s.readFramebuffer.id)} left bound`);
  }
  if (s.blendEquationRgb !== "FUNC_ADD" || s.blendEquationAlpha !== "FUNC_ADD") {
    out.push(`blend equation left as ${s.blendEquationRgb}/${s.blendEquationAlpha}`);
  }
  return out;
}

function run(effect: EffectDefinition, options: FakeGlOptions = {}) {
  const fake = createFakeGl(options);
  const instance = effect.create(fake.gl);
  const problems: string[] = [];
  const frames = (n: number, params: AnyParamValues, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      instance.frame(dt, params);
      problems.push(...frameEndProblems(fake));
    }
  };
  const sets = paramSets(effect.params);
  instance.resize(viewport(640, 360));
  frames(3, sets[0], 0);
  frames(3, sets[0]);
  for (const params of sets) {
    frames(2, params);
  }
  // A resize mid-run, a long hitch, then a tiny canvas and back.
  instance.resize(viewport(1280, 720));
  frames(2, sets[0], 0.1);
  instance.resize(viewport(16, 9));
  frames(2, sets[1]);
  // Extreme aspects: a tall, narrow sidebar or OBS source, a thin strip, and 1x1.
  for (const [w, h] of [
    [60, 1080],
    [1920, 60],
    [1, 1],
  ]) {
    instance.resize(viewport(w, h));
    frames(2, sets[0]);
    frames(2, sets[1]);
    frames(2, sets[2]);
  }
  instance.resize(viewport(640, 360));
  frames(2, sets[0]);
  const draws = fake.draws();
  instance.dispose?.();
  return { fake, problems, draws };
}

/**
 * These run each effect's real create and frame code, including CPU texture builds
 * (planet rebuilds its surface for every world and seed the param sets reach), so a
 * heavy effect takes seconds once the full suite shares the CPUs.
 */
const EFFECT_TIMEOUT = 60_000;

type Category = (typeof EFFECT_CATEGORIES)[number];

/** The file-name form of a category: "Sky & weather" runs in `lifecycle-sky-weather.test.ts`. */
export function categorySlug(category: string): string {
  return category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Registers the lifecycle tests for the effects in `category`, loading only those.
 * Each category has its own test file, so Vitest runs them on separate workers.
 */
export async function describeLifecycle(category: Category): Promise<void> {
  beforeAll(() => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const loaded = await Promise.all(
    effects.filter((e) => e.category === category).map((e) => e.load()),
  );
  const cases = loaded.map((e) => [e.id, e] as const);

  describe.each(cases)("%s", { timeout: EFFECT_TIMEOUT }, (_, effect) => {
    it.each([
      ["without", []],
      ["with", ["EXT_color_buffer_float"]],
    ])("follows the GL rules %s float render targets", (_floats, extensions) => {
      const { fake, problems, draws } = run(effect, { extensions });
      expect(fake.errors).toEqual([]);
      expect([...new Set(problems)]).toEqual([]);
      expect(draws).toBeGreaterThan(0);
      expect(fake.live().map((o) => `${o.kind} ${String(o.id)}`)).toEqual([]);
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
        const message =
          error === undefined
            ? "failed to compile"
            : error instanceof Error
              ? error.message
              : "not an Error";
        expect(message).toMatch(/failed to compile/);
        expect(fake.errors).toEqual([]);
        expect(fake.live().map((o) => `${o.kind} ${String(o.id)}`)).toEqual([]);
        if (error === undefined) {
          break;
        }
      }
    });
  });
}
