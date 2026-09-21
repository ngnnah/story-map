# story-map — notes for the next session

Live: https://ngnnah.github.io/story-map/ · Repo: github.com/ngnnah/story-map (public)

Watch a story's characters move across its own map, page by page. Zero
dependencies, no build step. `npm test` (144 cases) and `npm run serve`.

**It needs an HTTP origin.** `file://` breaks ES module imports, `fetch` of the
book JSON, and IndexedDB. Use `npm run serve`.

## The one rule that governs the data

A waypoint says **who is where on which page**. Everything else is derived, and
each of these was a deliberate decision — don't undo one without reading why:

| | |
|---|---|
| two waypoints at the **same place** | bracket a stay; the pin does not drift |
| a waypoint after a `null` | a **break** in the trail, not a journey — the pen lifts |
| `"place": null` | off the map (dead, sailed off, no longer mentioned); leaves a crosshatch |
| `"who": [...]` | a party moves in one line instead of eight |
| no authored route | straight line, drawn **dotted**, bowed into a per-character lane |
| past the last waypoint | held in place, but drawn **faded** — that's a rule, not something the book said |

## The axis is per-book

`book.axis` is `'page'` or `'chapter'`, decided by whether every chapter
carries a `startPage`. A waypoint says when as either `page` or `ch` + `at`
(0..1 through that chapter); both resolve to one float, which is why
`timeline.js` and `geometry.js` never had to learn about it. On the chapter
axis a position of 12.4 *is* chapter 12, 40% through, the range is
`[1, nChapters + 1]`, and no page number is shown because none exists.

`clock.js` has per-axis feel constants (`UNITS`). They are not decoration: the
page-axis clamps would run a 60-chapter book in thirty seconds and hold it
permanently inside a ritard window.

## Three things that will bite you

**1. Coordinates are in square space internally.** `book.js` multiplies every
`y` by `map.aspect` on load, so both axes measure fractions of the *width*
(`yFrac` keeps the original). In raw 0–1 fractions, `hypot(dx, dy)`
over-measures vertical legs by 43% on a 0.74 map, and arc-length interpolation
makes pins crawl north–south and race east–west. If you add anything that
consumes coordinates, it's already square — don't re-correct for aspect.

**2. Never set `font-size` or `stroke-width` for SVG text in `css/app.css`.**
A stylesheet rule outranks the presentation attribute, which pegs text to *map*
units and blows labels up to banner size as you zoom. `view.js` sets them
inline per frame from the current zoom. There's a comment on `.label` saying so.

**3. `positionsAt` and `trailUpTo` must agree.** Both apply `legEase` to the
within-leg fraction; if they diverge the trail head detaches from its pin.
There's a test that sweeps every character across every page asserting
`trailUpTo(...).at(-1) === positionsAt(...)`. Keep it.

## Layout

```
js/book.js      parse + validate, square-space conversion, polylineFor   )
js/geometry.js  arc-length interpolation, clip, dodge (unit offsets)     ) pure
js/timeline.js  page -> positions, trails, bands, presence, storyEvents  ) tested
js/clock.js     the page clock: one float, exponential chase, no spring
js/view.js      camera (moves the viewBox, not a transform) + SVG scene
js/app.js       wiring, bottom bar, keyboard, event announcements
dev-coords.html pick x/y off a map image, emits JSON
```

Pure modules take plain data and return plain data — no DOM, no fetch, no
globals. That's what makes `node --test` work with zero deps. Keep new logic
there and new pixels in `view.js`/`app.js`.

Two feel decisions worth preserving: the clock is **exponential, not a spring**
(overshoot means pages running backwards, which reads as a bug), and the
breathing pulse is **phase-offset per character** (`--phase`) — in lockstep it
looks like a UI, out of phase it looks alive.

## Where the work actually is

**`data/shannara.json` covers only the first six chapters (to ~p.96) of 726,
and `data/elfstones.json` is a scaffold with no waypoints at all.** The code is
essentially done; the dataset is the project. Expect this to be the long part.

Elfstones ships 44 places, the opening cast, and 60 numbered chapters on the
chapter axis. Its chapter count is a guess — check it against a copy. Only
characters the first chapters introduce are declared, because the roster lists
everyone a file declares and that is a spoiler for a book being read.

**Picking coordinates without dev-coords.html.** Crop the region out of
`data/maps/four-lands.webp` with `sips`, read the engraved label, and divide by
2288 (x) and 1697 (y). That is how the Elfstones places were picked and how
four bad Sword coordinates were found. Coordinates belong to the scan they were
picked on: another edition's map can confirm topology but must never be used to
pick numbers.

To extend it: open `dev-coords.html`, load `data/maps/four-lands.webp`, click
places you need, copy the JSON into `places`. Then add waypoints as you read.
Most places for the whole book are already in there — Paranor, Culhaven,
Storlock, the Hall of Kings, Skull Kingdom and the rest — so mostly you're
adding `waypoints` and the occasional bent `route`.

Do not trust a coordinate because it parses. `black-oaks` sat west of Shady
Vale for the life of the file, so the company's chapter 6 leg drew them walking
back past the village they had just fled. Neither the endpaper nor the
Elfstones edition labels that forest; only the colour edition does.

Characters already declared with no waypoints yet (Balinor, Hendel, Durin,
Dayel) render as "not yet" and break nothing. That's the intended way to work.

## The reading wall

`readTo` is one integer per book: the last chapter the reader finished, or
`null` for no wall. It is set by a second handle on the rail — hollow, versus
the solid playhead — which snaps to chapter boundaries. The two ride the same
track and mean different things (how far you have read, versus where you are
looking), which is why they are drawn differently and why the wall handle
stops its pointerdown from reaching the rail's own scrub handler. A book with `"readAlong": true` defaults to 0 — nothing
revealed — rather than to the whole novel.

`ceiling()` is the first position NOT read; `readEnd()` is a hair below it and
is what every "have I seen this" test compares against. That distinction is
load-bearing: with an inclusive test against the ceiling, "read to chapter 0"
revealed chapter 1's opening line, and an unguarded `chapters.find(c => c.n === 0)`
fell through to the end of the book — the worst possible default for the one
kind of book the feature exists for.

`applyCeiling()` is the single entry point. It re-runs the four
once-per-book builders, re-derives `loudEvents`, sets the clock ceiling and
tells the view which places and characters exist. It is NOT called per frame —
the roster is built once per book on purpose, and rebuilding it every frame is
what broke clicking.

Nothing is filtered out of the data. The file is whole; the wall only decides
what gets drawn.

## Known limits (documented in the README, not bugs)

- **The axis is page order, not story time.** Two POV threads narrated one
  after the other make the second character freeze, then jump. Fixing it means
  a second time axis; `page` stays required so a `storyDay` field could be
  added later without invalidating typed data.
- Coordinates belong to the scan they were picked on; a different crop means
  re-picking. The app warns on an aspect mismatch.
- IndexedDB is per-origin, so a map picked at `localhost` isn't visible at
  `ngnnah.github.io`.

## Deliberately not built

Crossings (paths that intersect without a meeting), a calibration mode for
books whose places have no coords yet, a `/` jump box, ebook parsing, armies
and fronts, two books side by side. The first three are genuinely good ideas
that were cut for scope, not rejected.

`data/maps/four-lands.webp` is the publisher's endpaper artwork, committed
knowingly for a personal project. The `.gitignore` blocks map images everywhere
except `data/maps/`.
