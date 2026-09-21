# Story Map

Watch a story's characters move across its own map, page by page.

**Live demo**: https://ngnnah.github.io/story-map/

Drag the slider through *The Sword of Shannara* and Shea, Flick and Menion
leave Shady Vale, run for Leah and spread out across the Four Lands. Chapters
are labelled cells above the slider; meetings, first appearances and exits are
ticks below it. Every pin leaves a trail of where it has been.

No build step, no dependencies, no server. One `index.html`, some ES modules,
and a JSON file per book.

## Running it

```sh
npm run serve      # or: python3 -m http.server 8080
open http://localhost:8080
```

It needs an HTTP origin. Opening `index.html` over `file://` will not work —
ES module imports, `fetch` of the book JSON, and IndexedDB are all blocked
there. GitHub Pages is fine.

```sh
npm test           # 144 tests, no dependencies
```

## Keys

| | |
|---|---|
| `Space` | play / pause |
| `←` `→` | one page (`⇧` ten, `⌥` next waypoint) |
| `[` `]` | previous / next chapter (`⇧` for next event) |
| `1`…`8` / `0` | focus a character / clear |
| `F` | follow the focused character |
| `M` | darken the map behind the pins |
| `L` | show / hide the lane strip |
| `R`, `+`, `−` | fit, zoom |
| `?` | the rest |

Drag the map to pan, scroll to zoom, `⌥`-click a character in the roster to
hide them.

## Reading along

Press **Spoiler-free** in the bottom bar and a second, hollow handle appears on
the slider: drag it to the last chapter you finished. Everything to its right is
withheld — the playhead cannot go past it, later chapters go blank, the event
ticks and the lane strip clip, characters you have not met are not listed, and
a place nobody has reached yet is not drawn, because a place name is a spoiler
on its own.

The hollow handle is how far you have read; the solid one is where you are
looking. They move independently, except that pulling the wall back past the
playhead brings the playhead with it. Arrow keys nudge a focused handle by a
chapter, `Home`/`End` send it to either end, and the **✕** lifts the wall for a
re-read. The position is remembered per book.

Turning it on mid-book starts the wall at the chapter you are looking at, so
nothing you can already see disappears. A book whose JSON sets `"readAlong":
true` opens walled at chapter 0 instead — that is a fresh read, and there the
empty map is the honest picture.

Everything the app knows stays in the file. The wall is a filter on what is
drawn, not on what is loaded, so nothing is lost by setting it.

## Writing a book

One JSON file per book. The whole schema:

```json
{
  "title": "The Sword of Shannara",
  "map": { "file": "data/maps/four-lands.webp", "aspect": 0.7417 },
  "pages": [1, 726],

  "places":     { "leah": { "name": "Leah", "x": 0.556, "y": 0.674 } },
  "routes":     [{ "from": "shady-vale", "to": "leah", "via": [[0.515, 0.690]] }],
  "characters": [{ "id": "shea", "name": "Shea Ohmsford", "color": "#5B9DFF" }],
  "chapters":   [{ "n": 1, "startPage": 1, "title": "Flick on the Vale road" }],

  "waypoints": [
    { "who": ["shea", "flick"], "page": 1,  "place": "shady-vale" },
    { "who": "shea",            "page": 60, "place": "leah", "note": "they run for Leah" }
  ]
}
```

### Pages, or chapters

Page numbers belong to one printing. A reader knows they are in chapter 12,
not on page 138 of your edition, so a book may drop `startPage` from its
chapters entirely and say *when* as a chapter and how far through it:

```json
"chapters":  [{ "n": 1 }, { "n": 2 }],
"waypoints": [{ "who": "wil", "ch": 2, "at": 0.5, "place": "arborlon" }]
```

Then a position of 12.4 *is* chapter 12, 40% of the way through, and no page
number is shown because none exists. Give every chapter a `startPage` and you
get the page axis back, with `ch` + `at` interpolating inside each chapter.
Mixing the two resolves as chapters and says so in the readout.

A waypoint says **who is where, when**. Everything else follows:

- **Travelling.** Between two waypoints at different places, the pin
  interpolates along the route, easing out of one town and into the next.
- **Staying put.** Two waypoints at the *same* place bracket a stay. `shea@120
  culhaven`, `shea@150 culhaven`, `shea@160 paranor` means he sits in Culhaven
  for thirty pages and then travels.
- **Leaving.** `"place": null` takes a character off the map — dead, sailed
  off, or simply no longer mentioned — and leaves a small crosshatch where
  they stopped. Without it the model would march a corpse across the map for
  the rest of the book.
- **Travelling together.** `"who"` takes an array. A quest novel moves most of
  its cast as one party, and writing eight near-identical lines per stop is
  how a dataset stops being worth finishing.
- **Routes are optional.** With no route the app draws a straight line and
  **dots it**, so you can tell what the book said from what the app guessed.
  Each character bows their inferred legs into their own lane, so two people
  who walked the same road don't draw one line.

`x` and `y` are fractions of the map image, 0 to 1. Use `dev-coords.html` to
pick them: load your image, click a spot, type a name, copy the JSON out.
Shift-click a sequence to build a bent route.

Nothing throws. A bad place id or an out-of-range page is reported in the
readout panel and everything else still draws.

## Bring your own map

A book can ship a map (`map.file`), or leave it out — then the app asks you to
pick an image from your disk on first run. That image is stored in IndexedDB
on your machine and never uploaded.

Two things worth knowing:

- **Coordinates belong to the scan they were picked on.** The app compares
  your image's aspect ratio against the book's and warns if they disagree, but
  a differently-cropped edition means re-picking the places.
- **IndexedDB is per-origin.** A map you picked at `localhost:8080` is not
  visible at `ngnnah.github.io`, and vice versa.

## What it can't say

The timeline is **page order, not story time**. When two POV threads run
simultaneously but are narrated one after the other, the character in the
second thread freezes while you read the first, then jumps. A flashback works
best bracketed by `"place": null` so the pin blinks out rather than flying
across the map. Fixing this properly means a second time axis; `page` stays
required so a `storyDay` field could be added later without invalidating a
dataset you already typed.

Also out of scope: parsing an ebook to generate waypoints, armies and fronts,
and two books side by side.

## Layout

```
index.html          shell
css/app.css
js/book.js          parse + validate a book.json, resolve routes    ) pure,
js/geometry.js      arc-length interpolation, trail clipping, dodge ) tested
js/timeline.js      page -> positions, trails, presence, events     ) by node
js/clock.js         the page clock
js/view.js          camera and the SVG scene
js/app.js           wiring, the bottom bar, keyboard
dev-coords.html     pick coordinates off a map image
```

`book.js`, `geometry.js` and `timeline.js` take plain data and return plain
data — no DOM, no fetch, no globals. That is what makes `node --test` work
with zero dependencies, and it is where every rule above is pinned down.

Coordinates are converted to **square space** on load: `y` is multiplied by the
map's aspect ratio so both axes measure fractions of the *width*. In raw
fractions, `hypot(dx, dy)` over-measures vertical legs — by 43% on a 0.74
map — and arc-length interpolation would make pins crawl north–south and race
east–west.

## The two Shannara books

`data/shannara.json` is the whole of *The Sword of Shannara* — 60 chapters, 15
characters, from the stranger on the Duln road to Shea coming home. Its chapter
numbers are a reconstruction; the order of the journey is the reliable part.

`data/elfstones.json` is a scaffold: 44 places measured off the map, the
opening cast, 60 numbered chapters, and no waypoints at all. It opens with the
reading wall at chapter 0, so it shows you nothing until you tell it how far
you have read.

Past a character's last waypoint the app holds them in place, which is a rule
rather than something the book said — so those pins are drawn faded, and the
lane strip draws the held tail faint. A half-written dataset should look
half-written.

## Map credit

`data/maps/four-lands.webp` is a scan of the Four Lands endpaper map from the
published Shannara books. It is the publisher's artwork, not mine, and it is
here for personal, non-commercial use only. Swap in your own scan at any time
with the file picker, or delete it — the app works without a bundled map.
