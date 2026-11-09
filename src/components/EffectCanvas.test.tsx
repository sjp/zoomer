// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EffectDefinition } from "../effects/types";
import type { RenderLoop, RenderLoopOptions } from "../lib/renderLoop";
import { EffectCanvas } from "./EffectCanvas";

// The loop itself is tested in renderLoop.test.ts; this checks how the component drives it.
const loops = vi.hoisted(() => [] as { options: RenderLoopOptions; loop: RenderLoop }[]);
vi.mock("../lib/renderLoop", () => ({
  createRenderLoop: (options: RenderLoopOptions) => {
    const loop = {
      setSizeLocked: vi.fn<(locked: boolean) => void>(),
      setResolution: vi.fn<RenderLoop["setResolution"]>(),
      dispose: vi.fn<() => void>(),
    };
    loops.push({ options, loop });
    return loop;
  },
}));

const effect = (id: string) =>
  ({
    id,
    name: id,
    description: "",
    category: "Abstract",
    tags: [],
    context: "webgl2",
    params: {},
    create: () => ({ resize: () => undefined, frame: () => undefined }),
  }) satisfies EffectDefinition;
const A = effect("a");
const B = effect("b");

afterEach(() => {
  cleanup();
  loops.length = 0;
});

describe("EffectCanvas", () => {
  it("changes resolution on the running loop without re-creating the effect", () => {
    const view = render(
      <EffectCanvas effect={A} params={{}} resolution="window" frameRate="display" />,
    );
    expect(loops).toHaveLength(1);
    view.rerender(<EffectCanvas effect={A} params={{}} resolution="1080p" frameRate="display" />);
    expect(loops).toHaveLength(1);
    expect(loops[0].loop.setResolution).toHaveBeenLastCalledWith("1080p");
    expect(loops[0].loop.dispose).not.toHaveBeenCalled();
  });

  it("starts a new effect at the current resolution", () => {
    const view = render(
      <EffectCanvas effect={A} params={{}} resolution="window" frameRate="display" />,
    );
    view.rerender(<EffectCanvas effect={A} params={{}} resolution="720p" frameRate="display" />);
    view.rerender(<EffectCanvas effect={B} params={{}} resolution="720p" frameRate="display" />);
    expect(loops).toHaveLength(2);
    expect(loops[0].loop.dispose).toHaveBeenCalledTimes(1);
    expect(loops[1].options.resolution).toBe("720p");
    expect(loops[1].options.effect).toBe(B);
  });

  it("passes the recording size lock to the loop", () => {
    const view = render(
      <EffectCanvas effect={A} params={{}} resolution="window" frameRate="display" />,
    );
    view.rerender(
      <EffectCanvas effect={A} params={{}} resolution="window" frameRate="display" sizeLocked />,
    );
    expect(loops[0].loop.setSizeLocked).toHaveBeenLastCalledWith(true);
  });
});
