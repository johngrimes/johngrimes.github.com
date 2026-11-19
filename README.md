# john.grimes.id.au

Source for [john.grimes.id.au](https://john.grimes.id.au/), a single-page CV.

The page is hand-written HTML, CSS and one small script, with no build step.
GitHub Pages serves the repository root from `master`; `.nojekyll` stops Pages
from running Jekyll over it. The old `/cv` address redirects to `/`.

| File            | Purpose                                    |
| --------------- | ------------------------------------------ |
| `index.html`    | The CV                                     |
| `style.css`     | Screen, dark mode and A4 print styles      |
| `spin.js`       | Spins the headline mark on hover           |
| `fonts/`        | Subset WOFF2 fonts and their licences      |
| `cv/index.html` | Redirect from the old CV address           |
| `tests/`        | Browser tests and the local preview server |

## Working on it

Requires [Bun](https://bun.sh/).

```sh
bun install
bun run serve        # preview at http://localhost:4173/
bun run lint         # Prettier, html-validate and stylelint
bunx playwright install chromium
bun run test         # browser tests
```

The tests check the agreed content decisions, accessibility (axe) in light and
dark modes, layout at 320px, that the first selected-work outcome and 44px
contact links appear on a 390px phone screen, and the print output: at most two
A4 pages, 10pt body text, and every page after the first starting at a heading.
Print entries are never split across pages, so an entry that does not fit at
the foot of a page moves whole to the next. Content that pushes the layout onto
a third page fails the build, so trim before adding.

## Fonts

[IBM Plex Serif](https://github.com/IBM/plex) and IBM Plex Sans, both under the
SIL Open Font License (see `fonts/OFL-*.txt`). The WOFF2 files are subset to
Latin and general punctuation, with all OpenType features kept. The serif comes
as static regular, medium, semibold and italic files, and the sans as static
regular and semibold files. The sans is not a variable font because Chromium
embeds a variable font in a PDF as Type 3 glyph shapes, not as a font. To
regenerate them from the TTFs in [google/fonts](https://github.com/google/fonts):

```sh
U='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2212,U+2215'
R='uv run --with fonttools --with brotli'
for f in Regular Medium SemiBold Italic; do
  $R pyftsubset IBMPlexSerif-$f.ttf --unicodes="$U" --layout-features='*' --flavor=woff2 --output-file=fonts/IBMPlexSerif-$f.woff2
done
for w in Regular:400 SemiBold:600; do
  $R fonttools varLib.instancer 'IBMPlexSans[wdth,wght].ttf' wght=${w#*:} wdth=100 --update-name-table -o ss.ttf
  $R pyftsubset ss.ttf --unicodes="$U" --layout-features='*' --flavor=woff2 --output-file=fonts/IBMPlexSans-${w%:*}.woff2
done
```

## Author

John Grimes
