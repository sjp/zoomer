/**
 * Web fonts loaded once per page. Every effect instance that wants a face shares
 * one load, and the face joins `document.fonts` once, however often the effect is
 * created (each reopen, each context restore). A failed load is forgotten, so a
 * later create tries again.
 */

interface FontLoad {
  promise: Promise<boolean>;
  loaded: boolean;
}

const loads = new Map<string, FontLoad>();

const keyOf = (family: string, url: string) => `${family}\n${url}`;

/**
 * Starts loading `url` as `family` (unless it is loading or loaded already) and
 * resolves true once the face is in `document.fonts`, false if it couldn't load or
 * there is no `FontFace` here. `effectName` labels the warning logged on failure.
 */
export function loadWebFont(
  effectName: string,
  family: string,
  url: string,
  descriptors?: FontFaceDescriptors,
): Promise<boolean> {
  if (typeof FontFace === "undefined" || typeof document === "undefined") {
    return Promise.resolve(false);
  }
  const key = keyOf(family, url);
  const known = loads.get(key);
  if (known) {
    return known.promise;
  }
  const load: FontLoad = { promise: Promise.resolve(false), loaded: false };
  load.promise = new FontFace(family, `url(${url})`, descriptors).load().then(
    (face) => {
      document.fonts.add(face);
      load.loaded = true;
      return true;
    },
    () => {
      loads.delete(key);
      console.warn(`${effectName}: couldn't load ${url}`);
      return false;
    },
  );
  loads.set(key, load);
  return load.promise;
}

/** Whether `url` has finished loading as `family`, so text drawn now already uses it. */
export function webFontLoaded(family: string, url: string): boolean {
  return loads.get(keyOf(family, url))?.loaded ?? false;
}
