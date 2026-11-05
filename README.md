# john.grimes.id.au

Source for [john.grimes.id.au](https://john.grimes.id.au/), a single-page CV.

The page is hand-written HTML and CSS, plus a small set of browser modules for
the scene background, with no build step. GitHub Pages serves the repository
root from `master`; `.nojekyll` stops Pages from running Jekyll over it. The
old `/cv` address redirects to `/`.

| File            | Purpose                                                   |
| --------------- | --------------------------------------------------------- |
| `index.html`    | The CV                                                    |
| `style.css`     | Screen, dark mode and A4 print styles                     |
| `fonts/`        | Subset WOFF2 fonts and their licences                     |
| `background/`   | The 3D scene behind the page: loader, variants and assets |
| `scene/`        | Sources for the generated background assets               |
| `cv/index.html` | Redirect from the old CV address                          |
| `tests/`        | Browser tests and the local preview server                |

## Working on it

Requires [Bun](https://bun.sh/), and [uv](https://docs.astral.sh/uv/) for
linting the Python scene script with ruff.

```sh
bun install
bun run serve        # preview at http://localhost:4173/
bun run lint         # Prettier, html-validate, stylelint and ruff
bunx playwright install chromium
bun run test         # browser tests
```

Both the preview server and the tests use the port in `PORT` (default 4173).

The tests check the agreed content decisions, accessibility (axe) in light and
dark modes, layout at 320px, and that printing produces at most two A4 pages.
Content that pushes the print layout onto a third page fails the build, so
trim before adding. The background tests are described below.

## Scene background

Behind the page is a faint 3D scene of an overgrown laboratory under a ribbed
glass dome. When the pointer moves, near and far parts of the scene shift
against each other around a focal plane on the benches. On touch screens,
scrolling moves the viewpoint instead. With reduced motion requested, the
scene stays still, and it is left out of print.

There are three implementations of the same scene, chosen with the `bg` query
parameter:

| Value              | How it works                                                                      |
| ------------------ | --------------------------------------------------------------------------------- |
| `layers` (default) | Five pre-rendered depth slices as transparent images, moved with CSS transforms   |
| `depth`            | One pre-rendered image and a disparity map, displaced per pixel by a WebGL shader |
| `gltf`             | The model rendered live with three.js, with a fixed-focus depth of field pass     |

`background/background.js` waits for the page to finish loading, then loads
only the chosen variant and the assets for the current colour scheme. The
`depth` and `gltf` variants show a still image if WebGL is unavailable, and
`background/noscript.css` shows the same still image when JavaScript is off.

The scene is grey. Each pixel's shade and distance are mapped onto a line from
the paper colour towards a darker (light mode) or lighter (dark mode) tint,
and the line stops where muted text would fall below a contrast of 4.75:1.
Fog fades distant parts of the scene into the paper. The tests check that
muted text keeps WCAG AA contrast (4.5:1) against every pixel of each variant
in both schemes. They also cover variant selection, which assets load and
when, motion and its suppression, the WebGL and no-JavaScript fallbacks, and
print.

### Regenerating the assets

`scene/build.py` builds the scene procedurally in Blender. It renders the full
frame and the depth slices with Cycles, maps them onto both palettes, and
writes everything in `background/assets/`, including the manifest
`scene.json` that the variants read. It needs Blender 5.2 and `cwebp` from
[libwebp](https://developers.google.com/speed/webp):

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scene/build.py
```

A full build takes about two minutes on an Apple M4 Max. Intermediate renders
go to `scene/out/`, and `-- --post-only` reuses them when only the palette has
changed.

`background/three.js` is a single-file build of the parts of
[three.js](https://threejs.org/) that the `gltf` variant uses, under the MIT
licence (see `background/three.LICENSE.txt`). To rebuild it after changing
`scene/three.js` or the `three` version:

```sh
bun run vendor:three
```

## Fonts

[Source Serif 4](https://github.com/adobe-fonts/source-serif) and
[Source Sans 3](https://github.com/adobe-fonts/source-sans), both under the SIL
Open Font License (see `fonts/OFL-*.txt`). The WOFF2 files are subset to Latin
and general punctuation, with the weight axis limited to 400-600 and all
OpenType features kept. To regenerate them from the variable TTFs in
[google/fonts](https://github.com/google/fonts):

```sh
U='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2212,U+2215'
R='uv run --with fonttools --with brotli'
$R fonttools varLib.instancer SourceSerif4.ttf wght=400:600 -o s.ttf
$R fonttools varLib.instancer SourceSerif4-Italic.ttf wght=400 -o si.ttf
$R fonttools varLib.instancer SourceSans3.ttf wght=400:600 -o ss.ttf
$R pyftsubset s.ttf --unicodes="$U" --layout-features='*' --flavor=woff2 --output-file=fonts/SourceSerif4.woff2
$R pyftsubset si.ttf --unicodes="$U" --layout-features='*' --flavor=woff2 --output-file=fonts/SourceSerif4-Italic.woff2
$R pyftsubset ss.ttf --unicodes="$U" --layout-features='*' --flavor=woff2 --output-file=fonts/SourceSans3.woff2
```

## Author

John Grimes
