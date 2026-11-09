# Zoomer

Animated backgrounds for video calls, drawn live with WebGL 2. Pick an effect, tune it, then
share the screen or window, go fullscreen, or record a clip to use as a virtual background.
Every effect aims for 120 fps at 4K while using as little GPU and CPU as possible, and keeps
its motion slow so video codecs don't smear it.

**Try it: <https://sjp.github.io/zoomer/>**

There are over 120 effects, grouped by category: Space, Sky & weather, Water, Nature, Cosy,
Abstract, Science, Retro and Scenes (recreations of well-known kinds of set or place, such as a
starship bridge). The list can be searched, starred and sorted.

## Running it

Use Node 26 (the version is in `.nvmrc`; the devcontainer already has it).

```sh
npm install
npm run dev      # dev server with hot reload
npm run build    # type-check and build to dist/
npm run preview  # serve the built dist/
npm run check    # type-aware oxlint (with type-checking), oxfmt --check and unused exports
npm run fmt      # format with oxfmt
npm test         # vitest
npm run test:perf     # frame-timing tests (*.perf.test.ts), one file at a time
npm run test:browser  # compile and draw every effect in headless Chromium (Playwright)
```

`npm run test:browser` needs Playwright's Chromium once: `npx playwright install chromium`.
It runs every effect on SwiftShader's software WebGL2 and fails on shader compile or link
errors, GL errors, uniform names no program uses, and frames that come out as one flat
colour.

To check that a refactor leaves effects looking the same, capture every effect's pixels
before and after (randomness and clocks are pinned, so captures repeat exactly) and compare:

```sh
CAPTURE_DIR=/tmp/before npx playwright test capture
# ...change the code...
CAPTURE_DIR=/tmp/after npx playwright test capture
node scripts/compare-captures.mjs /tmp/before /tmp/after
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
- **Fullscreen**, **Copy link** and **Hide**.

The current effect and its parameters are kept in the URL hash, so a link reopens the same
setup. Editing or pasting a hash applies it without a reload. Hiding the panel adds
`panel=hidden`, and a page opened with it starts with the panel and cursor hidden.

**Copy link** copies a link that spells out every parameter, defaults included, plus
`panel=hidden`. Paste it into an OBS (or similar) browser source and it shows the effect
straight away, with no controls, and keeps its look even if a default changes later.

### Keyboard shortcuts

| Key | Action                             |
| --- | ---------------------------------- |
| `/` | Open the effect list and search it |
| `S` | Star or unstar the current effect  |
| `H` | Hide or show the control panel     |
| `F` | Toggle fullscreen                  |
| `→` | Next effect in the list            |
| `←` | Previous effect in the list        |

Shortcuts are ignored while a form field has focus. On touch devices, tap the corner button
to bring a hidden panel back.

## Adding an effect

1. Create a folder `src/effects/<id>/` holding everything that belongs to the effect:
   - `<id>.meta.ts`, via `defineEffectMeta`: its `id`, `name`, `description`, `params`
     schema, and the list metadata:
     - `category`: one of `EFFECT_CATEGORIES` in `src/effects/types.ts`;
     - `tags`: a few lowercase search words that aren't already in the name or description
       (synonyms, moods, places);
     - `cost`: `"very low"`, `"low"` or `"medium"`, the rough GPU cost at 4K, for the
       "Lightest first" sort.

     The entry chunk imports every meta file, so it may import only `../types`,
     `../param-options` and other `.meta` modules at runtime (`meta.test.ts` checks this).

   - `<id>.ts`, the effect, via `defineEffect` from `src/effects/types.ts`, whose
     `create(gl)` returns `{ resize, frame, dispose }`.
   - any `<id>-sim.ts` simulation code, with its tests.
2. Add it to the list in `src/effects/registry.ts` with a `load: () => import(...)`, never a
   static import, so its code loads on demand. The registry's order is the "Featured" sort.
   The control panel builds its controls from the params schema, and the URL hash picks them
   up too.
3. Reuse the shared helpers that sit directly in `src/effects/` (`gl.ts`, `sprites.ts`,
   `streaks.ts`, `noise.ts`, `math.ts`, `color.ts` and others), and add unit tests for any
   pure logic. No effect imports another effect's `<id>.ts` (`scene-imports.test.ts` checks
   this); move shared code into `src/effects/` instead.

A Scene recreates a well-known kind of set or place. Keep the feel of the source, but never
its names, logos, insignia or traced artwork, and name it by what it shows ("Starship
Bridge"). The video call draws the speaker over the middle of the frame, so build the scene
around them (a headrest behind their head, a desk edge along the bottom) and put nothing in
front of them. Bright events ramp over at least a second and never flash the whole frame.

Start from an existing effect of a similar shape: `tunnel/` or `lavalamp/` for full-screen
shaders, `bokeh/` or `snow/` for sprites, `warp/` for streaks and `flowfield/` for
framebuffers. `src/effects/lifecycle.test.ts` checks the WebGL rules every effect must follow:
uniforms written only to the bound program, every object deleted on dispose, and the default
framebuffer and `FUNC_ADD` left at the end of each frame.

## Deploying

Pushing to `main` deploys the site to GitHub Pages: `.github/workflows/deploy.yml` runs
`npm run check`, `npm test`, `npm run test:perf`, `npm run build` and `npm run test:browser`, then
publishes `dist/`. The build uses a
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
