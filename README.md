# Zoomer

Animated backgrounds for video calls, drawn live with WebGL. Pick an effect, tune it, then
share the screen or window, go fullscreen, or record a clip to use as a virtual background.
Every effect runs at your display's full refresh rate and resolution on as little GPU and CPU
as possible, and keeps its motion gentle so video codecs don't smear it.

**Try it: <https://sjp.github.io/zoomer/>**

There are over 100 effects, give some a try!

## Running it

Use Node 26 (the version is in `.nvmrc`; the devcontainer already has it).

```sh
npm install
npm run dev      # dev server with hot reload
npm run build    # type-check and build to dist/
npm run check    # linting
npm test         # vitest
```

## Using it

The control panel sits in the corner and fades out, with the cursor, after a few seconds
without input. It has:

- the effect picker, whose list you can search, sort, narrow by category (Space, Calm,
  Retro, Work and more; an effect can be in several) and star favourites in, and a short
  description of the effect;
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
