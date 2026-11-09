/**
 * WebGL2 context settings. Without `preserveDrawingBuffer` the buffer is cleared
 * after each composite; `captureStream` still records, since it samples on composite.
 */
export const WEBGL_OPTIONS: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
};
