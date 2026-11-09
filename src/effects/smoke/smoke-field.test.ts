import { describe, expect, it } from "vitest";
import { createScope } from "../gl";
import { createFakeGl } from "../../test/fake-gl";
import { createSmokeField } from "./smoke-field";

describe("createSmokeField", () => {
  it("keeps the state one step back as `previous`, for drawing between steps", () => {
    const fake = createFakeGl();
    const scope = createScope();
    const field = createSmokeField(fake.gl, scope, "test");
    expect([field.texture, field.previous]).toEqual([null, null]);
    expect(field.resize(8, 4)).toBe(true);
    const a = field.texture;
    const b = field.previous;
    expect(a).not.toBeNull();
    expect(b).not.toBe(a);
    fake.gl.useProgram(field.program);
    field.advance(1);
    expect([field.texture, field.previous]).toEqual([b, a]);
    field.advance(2);
    expect([field.texture, field.previous]).toEqual([b, a]);
    scope.dispose();
    expect(fake.live()).toEqual([]);
    expect(fake.errors).toEqual([]);
  });
});
