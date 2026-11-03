import { describe, expect, it } from "vitest";
import { glslFloat, TO_CLIP_GLSL } from "./gl";
import { PAD_MARGIN } from "./snow-sim";
import { flakeVertex } from "./snowflakes";

/** The flake vertex shader as it was before the fade mask, which Snow and Snowy Window keep. */
const ORIGINAL = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec2 aLook;
uniform vec2 uResolution;
out vec2 vLocal;
flat out float vAlpha;
flat out float vSoftness;
${TO_CLIP_GLSL}
void main() {
  // Grow the quad by a pixel so the anti-aliased edge of tiny flakes is never clipped.
  vec2 ext = aRect.zw + 1.0;
  vec2 px = aRect.xy + aCorner * ext;
  // spritePad(softness), as in TS.
  float pad = 1.0 + aLook.y + ${glslFloat(PAD_MARGIN)};
  vLocal = aCorner * pad * ext / aRect.zw;
  vAlpha = aLook.x;
  vSoftness = aLook.y;
  gl_Position = pxToClip(px, uResolution);
}
`;

describe("flakeVertex", () => {
  it("is unchanged without the fade mask", () => {
    expect(flakeVertex(false)).toBe(ORIGINAL);
  });

  it("scales opacity by the mask at the flake's centre when opted in", () => {
    const vs = flakeVertex(true);
    expect(vs).toContain("uniform sampler2D uMask;");
    expect(vs).toContain("vAlpha = aLook.x * textureLod(uMask, aRect.xy / uResolution, 0.0).r;");
  });
});
