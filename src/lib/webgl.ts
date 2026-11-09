/**
 * WebGL2 context settings. Without `preserveDrawingBuffer` the buffer is cleared
 * after each composite; `captureStream` still records, since it samples on composite.
 * No depth or stencil buffer: at 4K one costs about 33 MB, and an effect that
 * needs depth gives its own render target one.
 */
export const WEBGL_OPTIONS: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
};
