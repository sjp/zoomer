/**
 * The shared land mask: a 1024x512 equirectangular signed distance field built
 * from Natural Earth's 1:50m land polygons (public domain, naturalearthdata.com)
 * by scripts/build-land-mask.mjs. Texel value 128 + 8 * d, where d is the
 * distance to the coast in texels (positive on land), clamped to +-4. Row 0 is
 * the north edge and u = lon / 360 + 0.5.
 *
 * The image loads in the background; effects draw without it (all sea) until
 * `take` hands it over, then upload it with `uploadLandMask`.
 */
import { resetUnpackState, type Scope } from "./gl";

const LAND_MASK_URL = `${import.meta.env.BASE_URL}land-mask.png`;
export const LAND_MASK_WIDTH = 1024;
/** Decodes a mask sample to texels from the coast: r * GAIN - BIAS = (r * 255 - 128) / 8. */
export const LAND_MASK_GAIN = 255 / 8;
export const LAND_MASK_BIAS = 128 / 8;

interface LandMaskLoader {
  /** The loaded image, once, the first call after it arrives; undefined otherwise. */
  take: () => HTMLImageElement | undefined;
}

/**
 * Starts loading the mask (outside a browser, it never arrives). `effectName`
 * labels the warning logged if it fails. The listeners are removed when `scope`
 * is disposed.
 */
export function loadLandMask(scope: Scope, effectName: string): LandMaskLoader {
  let pending: HTMLImageElement | undefined;
  if (typeof Image !== "undefined") {
    const img = new Image();
    img.decoding = "async";
    const onLoad = () => {
      pending = img;
    };
    const onError = () => {
      console.warn(`${effectName}: couldn't load ${LAND_MASK_URL}`);
    };
    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);
    img.src = LAND_MASK_URL;
    scope.defer(() => {
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
      pending = undefined;
    });
  }
  return {
    take() {
      const img = pending;
      pending = undefined;
      return img;
    },
  };
}

/**
 * Uploads the mask image as R8 into the texture bound to the active unit. The
 * mask is data, not a colour image, so it skips colour-space conversion.
 */
export function uploadLandMask(gl: WebGL2RenderingContext, image: HTMLImageElement): void {
  resetUnpackState(gl);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, image);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
}
