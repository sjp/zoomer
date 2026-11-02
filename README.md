# Zoomer

Animated backgrounds for video calls, drawn live with WebGL 2. Pick an effect, tune it, then
share the screen or window, go fullscreen, or record a clip to use as a virtual background.
Every effect aims for 120 fps at 4K while using as little GPU and CPU as possible, and keeps
its motion slow so video codecs don't smear it.

**Try it: <https://sjp.github.io/zoomer/>**

Effects: Warp Speed, Hyperspace, Digital Rain, Synthwave Grid, Bokeh Lights, Wormhole Tunnel,
Lava Lamp, Snowfall, Flow Field, Gradient Blobs, Aurora, Topographic Contours, Underwater
Caustics, Rain on a Window, Fireflies, Constellation Network, Fireplace and Time-lapse Clouds.

## Running it

Use Node 26 (the version is in `.nvmrc`; the devcontainer already has it).

```sh
npm install
npm run dev      # dev server with hot reload
npm run build    # type-check and build to dist/
npm run preview  # serve the built dist/
npm run check    # oxlint, oxfmt --check and tsc
npm run fmt      # format with oxfmt
npm test         # vitest
```

## Using it

The control panel sits in the corner and fades out, with the cursor, after a few seconds
without input. It has:

- the effect picker and a short description of the effect;
- the effect's own parameters (sliders, colours, toggles and lists), and **Reset** to restore
  their defaults;
- **Resolution**: fit the window (capped at 1080p), or a fixed 720p, 1080p or 4K canvas;
- **Frame rate**: match the display, or cap at 60 or 30 fps, with a live fps and frame-time
  meter;
- **Record clip**: records 10–60 s of the canvas and downloads it as MP4 (H.264): through
  MediaRecorder where it supports MP4, otherwise through WebCodecs (e.g. Firefox), and as
  WebM only if neither can encode H.264. Keep the tab visible while recording; the effect and
  resolution are locked until it finishes;
- **Fullscreen** and **Hide**.

The current effect and its parameters are kept in the URL hash, so a link reopens the same
setup. Editing or pasting a hash applies it without a reload.

### Keyboard shortcuts

| Key | Action                         |
| --- | ------------------------------ |
| `H` | Hide or show the control panel |
| `F` | Toggle fullscreen              |
| `→` | Next effect                    |
| `←` | Previous effect                |

Shortcuts are ignored while a form field has focus. On touch devices, tap the corner button
to bring a hidden panel back.

## Adding an effect

1. Create `src/effects/<id>.ts` and export the effect with `defineEffect` from
   `src/effects/types.ts`: an `id`, `name`, `description`, a `params` schema and
   `create(gl)`, which returns `{ resize, frame, dispose }`.
2. Add it to the list in `src/effects/registry.ts`. The control panel builds its controls from
   the params schema, and the URL hash picks them up too.
3. Reuse the shared helpers in `src/effects/` (`gl.ts`, `sprites.ts`, `streaks.ts`,
   `noise.ts`, `math.ts`, `color.ts`), and add unit tests for any pure logic.

Start from an existing effect of a similar shape: `tunnel.ts` or `lavalamp.ts` for full-screen
shaders, `bokeh.ts` or `snow.ts` for sprites, `warp.ts` for streaks and `flowfield.ts` for
framebuffers. The full conventions (WebGL state, resource cleanup, per-frame allocation,
resolution scaling and dithering) are under "Shared conventions" in `issues/README.md`.

## Deploying

Pushing to `main` deploys the site to GitHub Pages: `.github/workflows/deploy.yml` runs
`npm run check`, `npm test` and `npm run build`, then publishes `dist/`. The build uses a
relative base path, so it works from a project subpath. `.github/workflows/ci.yml` runs the
same checks on every push and pull request, and Dependabot keeps npm packages and action
versions up to date.

The built `index.html` carries a Content-Security-Policy `<meta>` tag, since Pages can't send
headers. It is added at build time only (see `vite.config.ts`), because the dev server needs
an inline script and a websocket that the policy forbids.

## Data

`public/land-mask.png`, the land mask for the Daylight World Map, is built from
[Natural Earth](https://www.naturalearthdata.com/)'s 1:50m land polygons, which are in the
public domain. `scripts/build-land-mask.mjs` regenerates it from `ne_50m_land.geojson`.
