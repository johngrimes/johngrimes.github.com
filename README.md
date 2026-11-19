# john.grimes.id.au

Source for [john.grimes.id.au](https://john.grimes.id.au/), a single-page CV.

The page is hand-written HTML, CSS and one small script, with no build step.
GitHub Pages serves the repository root from `master`; `.nojekyll` stops Pages
from running Jekyll over it. The old `/cv` address redirects to `/`.

| File                 | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `index.html`         | The CV                                              |
| `style.css`          | Screen, dark mode and A4 print styles               |
| `spin.js`            | Spins the headline mark on hover                    |
| `john-grimes-cv.pdf` | The CV as a PDF, built from `index.html`            |
| `fonts/`             | Subset WOFF2 fonts and their licences               |
| `cv/index.html`      | Redirect from the old CV address                    |
| `tests/`             | Browser tests, the PDF build and the preview server |

## Working on it

Requires [Bun](https://bun.sh/).

```sh
bun install
bun run serve        # preview at http://localhost:4173/
bun run lint         # Prettier, html-validate and stylelint
bunx playwright install chromium
bun run test         # browser tests
bun run pdf          # rebuild john-grimes-cv.pdf
```

The tests check the agreed content decisions, accessibility (axe) in light and
dark modes, layout at 320px, that the first selected-work outcome and 44px
contact links appear on a 390px phone screen, and the print output: at most
three A4 pages, 10pt body text, evenly spaced lines, a name and page number at
the foot of every page, and every page after the first starting at a heading.
Print entries are never split across pages, so an entry that does not fit at
the foot of a page moves whole to the next. Sections other than Experience are
kept whole in the same way. Content that pushes the layout onto a fourth page
fails the build, so trim before adding.

## PDF

`john-grimes-cv.pdf` is the page as Chromium prints it, using the print styles
in `style.css`, so the page is the only source for both. `bun run pdf` rebuilds
it. The author and subject in its document properties come from the `author`
and `description` meta elements of the page.

The tests compare the PDF with a fresh print of the page, and fail if the text
or its position differs. For example, after changing a job title in
`index.html` or a margin in `style.css`, `bun run test` fails with
"john-grimes-cv.pdf is out of date" until `bun run pdf` has been run. The
tests also check that the PDF holds its text in reading order, embeds its
fonts, is tagged for assistive technology and has a working link for each link
on the page.

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
