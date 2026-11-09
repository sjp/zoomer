/**
 * A stand-in for `OffscreenCanvas`, which Node lacks: effects that draw glyph or
 * sprite atlases on one get a 2D context whose every method does nothing.
 */
export class FakeOffscreenCanvas {
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
