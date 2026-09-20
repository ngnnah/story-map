# Story Map as a reading companion — design

**Date:** 2026-09-21
**Status:** revised after review. Pass 0 landed; §12 landed; §9 and §10 in flight.
**Goal:** use Story Map beside *The Elfstones of Shannara* while reading it for
the first time, updating it chapter by chapter over several weeks.

---

## 1. Why this is a redesign and not a feature list

The app was built to scrub a finished dataset. Two assumptions follow from that,
and reading an unread book inverts both.

**It shows the whole story at once.** Open it at chapter 12 and the roster names
characters you have not met, the chapter strip spells out titles you have not
read, the event gutter ticks a meeting 300 pages ahead, and the lane strip draws
the shape of the entire plot. For a book you have finished this is the product.
For a book you are reading it is a spoiler machine.

**It assumes the data already exists.** CLAUDE.md says "the dataset is the
project", and the authoring loop is: alt-tab to an editor, hand-merge coordinates
out of `dev-coords.html`, type waypoints, save, reload, read the problems panel.
Seven steps, three windows, once per chapter, sixty times. That is fine for a
weekend and hostile as a nightly habit.

Everything below follows from fixing those two things. The visual work (icons,
contrast) is real but secondary; it is listed last on purpose.

---

## 2. Pass 0 — already landed

Not part of this proposal; recorded so the plan below starts from a known state.
Every fix verified in headless Chrome over CDP. Test count at time of writing was 98; it is 106 now that §12 has landed.

| Fix | Was |
|---|---|
| `body { grid-template-columns: minmax(0, 1fr) }`, `.chap { flex: 0 1 auto }`, container query hiding titles under 62px | An `auto` grid column sized to max-content: 60 chapters of nowrap titles widened the page to 14142px and centred the map at x≈7071. **0 map pixels, 0 pins on screen.** |
| `trailUpTo` anchors every leg at its own start; leading `null` no longer forfeits the trail; `gap: true` on the first point after a gap; `pathOf` emits `M` there | A character who left the map and came back had the excursion silently deleted and the trail head detached from the pin. Bands triple-counted (0.87 vs 0.30). |
| `done` is `page > last.page` | The pin faded on the one page the book actually asserts. |
| The page a waypoint names reads as `at` | An unbracketed arrival spent its own page `moving` with a null place, so the town never lit up. |
| Roster built once per book, mutated per frame; declaration order | `replaceChildren` 60×/sec meant mousedown and mouseup hit different nodes and Chrome fired **no click at all**. Roster picking and README's documented ⌥-click-to-hide had never worked. |
| Pointer capture taken lazily past 3px; `onPin` read from the pointerdown target | Capturing on pointerdown retargeted the click to `#viewport`, so every pin click ran the *clear focus* branch. |
| `live.add(key)` in `drawPuck` | 5 co-located characters rendered **nothing** — the puck was pruned the same frame it was built, after the pins were already deleted. |
| `if (clock)` guards at module tail and in keydown | A 404 book left `clock` null and threw at top level, skipping every listener below it. |
| `pointercancel` ends a pan; `+`/`−` anchor on the map centre; malformed JSON reports | Stranded pans; camera drifted 68 world units south per four zoom presses; a bad dropped file vanished into an unhandled rejection. |

---

## 3. The axis becomes chapters

### Problem
Page numbers are edition-specific. A reader knows they are in chapter 12; they do
not know they are on page 138 of someone else's printing. Authoring a dataset
against page numbers means either owning the exact edition or inventing numbers.

### Design
Do not replace the page axis. Make the *unit* a property of the book, and keep
one continuous float as the internal currency so `timeline.js`, `geometry.js` and
all existing tests are untouched.

Schema addition:

```json
"chapters":  [{ "n": 1, "title": "Wil Ohmsford" }],
"waypoints": [{ "who": ["wil","amberle"], "ch": 1, "at": 0.0, "place": "storlock" },
              { "who": "wil",             "ch": 3, "at": 0.6, "place": "arborlon" }]
```

`ch` is the chapter number; `at` is 0..1 through it, defaulting to 0.
`book.js` resolves the pair into the float `w.page` that everything downstream
already consumes. `page` stays accepted so `demo-island.json` does not move.

`chapters[].startPage` becomes optional, and that choice sets the unit:

| chapters carry `startPage` | `book.axis` | range | readout | ← → step |
|---|---|---|---|---|
| all of them | `'page'` | `[1, 726]` | `p. 138 · Ch 12` | 1 page |
| none | `'chapter'` | `[1, nChapters + 1]` | `Ch 12 · 40%` | 0.1 chapter |

On the chapter axis, position 12.4 *is* "chapter 12, 40% through". No page number
is synthesised and none is displayed. Paste a real chapter→page table in later and
the same authored waypoints re-resolve to accurate pages with nothing retyped.

**Mixed** (some chapters have `startPage`, some do not) resolves as `'chapter'`
and reports a problem naming the chapters that are missing one.

### `chapters[].start` — the thing that actually has to change

`parseBook` currently **rejects** a chapter with no numeric `startPage`
(`book.js:116`), so a chapter-axis book as described above parses to **zero
chapters and two problems**. Verified by running it. Nothing else in §3 works
until that is fixed.

`parseBook` emits `chapters[].start` in **axis units** — `startPage` on the page
axis, `n` on the chapter axis — and every consumer reads `.start`. `startPage`
survives only as page-axis display data. The consumers are eight, not the three
originally listed: `book.js:126` (sort key), `book.js:291` (`chapterAt`),
`app.js:230` and `:235` (cell width, tooltip), `app.js:242`
(`jumpTo(c.startPage)`), `app.js:380-383` (`--pct` within-chapter progress),
`app.js:706` (`hopChapter`).

### `clock.js` is touched, and this is the part that bites

Four constants are derived from `max - min` with clamps tuned for a 726-page
book. On a 61-chapter axis they hit their floors:

| | page axis [1, 726] | chapter axis [1, 61] |
|---|---|---|
| `basePps` (`clock.js:28`) | 4.83 pages/s | **2 chapters/s** (clamp floor) |
| whole-book playtime | 150 s | **30 s** |
| `ritardWidth` (`clock.js:30`) | 11.6 pages | **4 chapters** (clamp floor) |

At the floor, playback runs the whole novel in half a minute and is permanently
inside a ritard window. Two more: `settle()` does `Math.round(this.target)`
(`clock.js:96`), so releasing a rail drag snaps to a whole chapter and the 0.1
step is unreachable by dragging; `jumpTo` teleports without a glide when `d < 1`
(`clock.js:62`), which on a chapter axis is most jumps.

**Clock gains `unitsPerSecond`, `snapStep` and `glideThreshold`, set from
`book.axis`.** `settle()` also gains the clamp it has never had — today it
assigns `this.target` with no bound at all, not even `min`/`max`.

### Integer assumptions outside the listed sites

- `app.js:398` — `const jumped = page - prev > 8`. Eight *chapters* never
  happens, so on the chapter axis no jump is ever detected and scrubbing
  machine-guns an announcement for everything it flew past.
- `app.js:709`, `:718`, `:730` — `here ± 0.5`.
- `app.js:818` — `Math.round(clock.shown)` before persisting.

### What it touches
`book.js`, `clock.js`, `app.js`. Not `timeline.js`, not `geometry.js`.

### Migration
A saved `page:<bookId>` pref from the page axis is meaningless under the chapter
axis: a stored `340` becomes chapter 340, which `seek` clamps to `max` — the end
of the book, i.e. the worst possible opening position for a read-along book —
and `app.js:818` writes it straight back 400ms later. **Store the pref as
`{axis, value}` and discard on mismatch.**

## 4. Read-along mode

### Problem
See §1. A complete dataset spoils a book you are reading.

### Design
A per-book mode. Sword opens in free-scrub (you have read it); Elfstones opens in
read-along.

**State.** `readingPosition` — the last chapter you finished. One integer,
persisted as `pref('upTo:<bookId>')`. The book file carries `"readAlong": true`
as the default for a fresh install; the pref wins once set.

**The ceiling** is the end of that chapter, in axis units. Everything clamps to it:

| Surface | Behaviour past the ceiling | Site |
|---|---|---|
| Rail | thumb cannot pass it; the region is drawn inert | `app.js` drawRail; `clock.js` gains a `ceiling` the seek/jump clamps respect |
| Chapter strip | cells show the **number only**, no title, not clickable | `app.js` buildChapters |
| Roster | characters whose first waypoint is past it are not listed at all | `app.js` buildRoster |
| Event gutter | ticks past it are not drawn | `app.js` buildGutter |
| Lane strip | every lane clipped at it; bridges past it dropped | `app.js` buildLanes |
| Rail popover | events past it filtered out | `app.js` showPopover |
| Places | a place nobody has reached yet gets no dot and no label | `view.js` drawPlaces |
| Playback | `Home`/`End`, play, and next-event jumps clamp to it | `app.js` keydown, `clock.js` |

Chapter *count* is not a spoiler and is useful, so the strip keeps its full width
and fills in as you go. Chapter *titles* are the densest spoiler in a novel, so
they ship in the JSON and simply are not rendered until unlocked.

**The ritual.** A `Next chapter →` button in the transport row. One click:
advances `readingPosition` by one, glides the clock through the newly revealed
chapter, and announces the events in it as they pass. Finish a chapter in the
book, click, watch the week's movement happen.

**Three consequences, handled.**

1. *Advancing is not reversible in the way that matters* — you cannot un-see a
   chapter. `Next` must be hard to hit by accident: it is a button, not a key,
   and it is not bound to Space or Enter on the body.
2. *Reading three chapters on a Sunday should not need three clicks.* A separate
   "I'm here" control sets the position to a chapter you pick.
3. *Re-reads need an escape.* A "show the whole book" toggle lifts the wall
   without destroying `readingPosition`.

**On a scaffolded Elfstones, `Next` reveals nothing** — there are no waypoints
yet. That is why §5 ships with this and not after it.

### The ceiling and `clock.js`

The obvious implementation — `setRange(min, ceiling)` — is wrong. `setRange`
resets `target = shown = prev = min` (`clock.js:42`), so every advance would snap
the clock back to chapter 1 *and* recompute `basePps`/`ritardWidth` for a
one-chapter range.

Clock gets `setCeiling(v)`, which leaves `shown` alone. `Math.min(max, ceiling)`
is then applied in `seek`, `jumpTo`, `settle`, `_tick` and `play`. `_tick`
pauses at `this.max` (`clock.js:136-137`) and `play()` restarts from `min` at
`shown >= max - 0.01` (`clock.js:73`) — both need the ceiling or playback never
stops at the wall.

### The ritard leaks the spoiler through motion

This is the subtlest hole and it is not a pixel filter. `_ritard`
(`clock.js:118-126`) decelerates playback as it approaches the nearest loud page.
With `setLoudPages` fed the unfiltered event list, **playback visibly slows down
on approach to a meeting you have not read yet** — the presence and rough
position of a reveal leak through the motion itself, with nothing drawn.

**`setLoudPages` receives only events at or below the ceiling**, recomputed on
every advance. Same for `settle`'s snap: `_nearestLoud` must not offer a target
past the wall, or releasing a rail drag near it snaps the thumb *onto* an unread
event.

### One entry point

The roster, chapter strip, lane strip and gutter are each built **once per book**
(`app.js:134`, `:224`, `:253`, `:325`) — and `app.js:126-131` records that
rebuilding the roster per frame is exactly what broke clicks in pass 0. So
advancing is not a render-time filter.

A single `applyCeiling()` runs on load and on every advance, and re-runs
`buildRoster`, `buildChapters`, `buildLanes`, `buildGutter`, re-derives
`loudEvents`, and calls `clock.setCeiling`. Nothing else re-runs.

### `readingPosition` is a chapter number

If the author inserts a chapter, the stored integer silently shifts the wall.
It is a chapter *number*; if it exceeds `chapters.length` it clamps and the
problems panel says so.

## 5. Authoring while reading

### Problem
Seven steps, three windows, sixty times. `dev-coords.html`'s "Copy JSON" emits the
*whole* `{places, routes}` object, so every new place is a hand-merge against the
33 already in the file.

### Design — patch panel plus always-visible export

**The rule, non-negotiable: the JSON file on disk is canonical. The app holds a
patch, never the only copy.**

- A panel takes a pasted `{"places": {...}, "waypoints": [...]}`, merges it into
  the in-memory raw book, re-runs `parseBook` (which already validates and reports
  without throwing), and redraws.
- Two buttons, always visible, never behind a menu: **Copy whole book.json** and
  **Copy what I added**.
- New waypoints are stamped with the current `readingPosition` by default — the
  chapter you just read is the chapter you are describing.
- The working book is mirrored to IndexedDB on every edit (`store.js` gains
  `putBook`/`getBook` beside `putImage`/`getImage`).
- If the in-browser patch is non-empty at load, the readout says so: *"12
  waypoints added in the browser and not yet in your file."*

IndexedDB is per-origin, so `localhost:8080` and `ngnnah.github.io` hold separate,
silently diverging copies. That is another reason the file stays canonical.

### The export must read the RAW object, not the parsed one

`parseBook` normalises destructively. Measured on `data/shannara.json`:

| | authored | after parseBook |
|---|---|---|
| waypoints | 12 | **21** (party arrays expanded per character) |
| characters with an explicit `color` | 0 | **8** (defaults materialised) |
| `_comment` | present | **dropped** |

It also drops waypoints naming an unknown place or character (`book.js:145-155`).
So "Copy whole book.json" built from `book.*` would expand every party line,
bake today's `DEFAULT_COLORS` into the file permanently, lose the comments, and
**silently delete the very line the problems panel is complaining about**.

**The panel keeps the raw object beside the parsed one and exports from raw.**
"Copy what I added" emits raw fragments, never re-serialised `book.*`.

### Undo

One bad paste must not cost the evening. The panel keeps a stack of applied
patches and can pop the last one.

**Deferred:** click-to-author (select a character, click a place dot, get a
waypoint; click empty map, name it, get a place). It would replace
`dev-coords.html` outright and `view.toWorld` already does the screen→map
conversion. Noted as a risk rather than a clean cut: the Elfstones scaffold needs
15-20 new Westland coordinates, and without click-to-author each one is still an
alt-tab to `dev-coords.html` and a hand-merge.

## 6. Remember the book you loaded

### Problem
Verified: load a 730-page book through the file picker, scrub to p.340, reload —
you get *The Sword of Shannara* at page 1. `setPref('lastBook', …)` only runs in
`openBookFile`, which only ever runs for the two hard-coded entries in `BOOKS`.
The page pref for the lost book is still in localStorage, pointing at a book the
app has forgotten how to open. `?book=elfstones` silently loads Sword.

For a nightly companion this is the single worst behaviour in the app: you
re-drag your file every session, forever.

### Design
- Store the raw JSON in IndexedDB under `book.id` on every load.
- At boot, restore the last book by id rather than by path.
- Make `?book=` resolve against stored books as well as `BOOKS`.
- Sync the picker (or replace it with the book's actual title) after a file or
  drop load, and set `document.title`.
- Persist `View.cam` and restore it instead of calling `fit()`, and seed
  `clock.shown` to the restored position instead of sweeping from page 1 — the
  launch currently fast-forwards the whole book in ~400ms, which on a full
  dataset is a nightly spoiler flash.

---

## 7. Say when a thread is not being narrated

### Problem
Elfstones runs four threads in alternating blocks for hundreds of pages — Wil and
Amberle; Arborlon under siege; Ander's defence; Eretria and the Rovers. Under a
sequential axis, whichever thread is not being narrated freezes, and the UI
states something false: the roster reads `@ Arborlon p.100–`, i.e. "he has been
sitting in Arborlon for 240 pages", when the truth is "the book was elsewhere".

The complaint is verified. `rest()` (`timeline.js:102-120`) builds identical pin
objects in both cases, and the roster string is `app.js:206`.

### The original mechanism does not work

The first draft said "the data already knows — it is the gap between consecutive
waypoints". **That is false, and it was verified false by running it.** The
app's only representation of a stay is two waypoints at the same place
(README:73-75, CLAUDE.md:18, `timeline.js:67-71`). A character the book parks in
Arborlon for 240 pages and one the book stops narrating for 240 pages produce
byte-identical `byCharacter` entries and byte-identical pins. No derived number
can separate them.

Worse, the failure is not symmetric. **The Arborlon siege is hundreds of pages
where the cast genuinely does stay put and is narrated continuously.** A
gap-threshold fade would assert "not being narrated" about the one thread in the
book that is narrated without interruption.

### The mechanism

Only the author knows. A waypoint gains an optional marker:

```json
{ "who": "eventine", "ch": 22, "place": "arborlon", "offstage": true }
```

`offstage: true` means "this is where they were when the book last said, and the
narration has moved elsewhere" — as distinct from `place: null`, which means
they have left the map, and from a plain repeated waypoint, which means they
really are sitting there.

`rest()` carries `offstage` through. The renderer applies the existing faded
treatment and the roster reads `Arborlon · last seen ch. 14`. Three states, three
looks:

| authored | means | drawn |
|---|---|---|
| two waypoints, same place | they stayed there | solid, breathing |
| `offstage: true` | the book stopped watching | faded, "last seen" |
| `place: null` | off the map — dead, sailed, gone | crosshatch, no pin |

`place: null` is not an acceptable substitute for `offstage`: the crosshatch is
the app's death mark, and in this book the defenders actually die. It also
manufactures a spurious `arrive` event on every re-entry.

### Interaction with §4 — do not conflate two different freezes

Under read-along the clock cannot pass the ceiling. A purely time-derived fade
would therefore grow on **every** pin as you sit at the wall, and the whole cast
would drift to "last seen" — exactly backwards, since the ceiling is the freshest
information the reader has.

`offstage` is authored, not derived, so it does not have this problem. The rule
that keeps it true: **`offstage` is a fact about the narration, never about the
reader's position.** Nothing in the read-along layer may set or clear it.

### `done`

`done` (past a character's last waypoint) stays as it is. It is a different
statement — "the data ran out" rather than "the book looked away" — and it is
read in three places: `view.js` (`.stale`), the lane strip's `solidTo` clamp
(`app.js:284`), and the roster. Unifying it with `offstage` was considered and
rejected: they are authored and derived respectively, and collapsing them would
put the reader's position back into a field that must not depend on it.

## 8. Cast tiering

A full Elfstones cast is 15–20, not 8. `DEFAULT_COLORS[i % 8]` silently reuses
colours past the eighth character, and keys `1`–`8` leave the rest unreachable.

`characters[].tier: "core" | "supporting"`, defaulting to `core`.

- **Core** — keys `1`–`8`, the bright palette, always in the roster (subject to
  the read-along filter).
- **Supporting** — desaturated palette, no key, roster row only while on stage.

More than eight `core` characters is reported as a problem rather than silently
colliding.

**The number keys need a stable array of their own.** `app.js:693-697` maps
`1`-`8` to `book.characters[+key - 1]`, an index into the declaration array. §4
hides characters past the ceiling and §8 gives keys only to `core`, so with a raw
index `3` would change meaning as you read. The key map is
`characters.filter(c => c.tier !== 'supporting')`, computed once per book, so a
key always means the same person. The roster gets `max-height` and `overflow-y: auto`; at ~22 rows it
currently runs off the bottom of the map area.

---

## 9. Role silhouettes

New `js/icons.js` — pure, no DOM: a map of name → SVG path data in a 24×24 box.
`characters[].icon` selects one; absent, the pin falls back to the initial
medallion, so any other book still works.

- `druid`, `elf`, `dwarf`, `man`, `woman`, `troll`, `gnome` to start.
- **Gated on rendered pixel size, not zoom band.** Below ~15px the pin is a plain
  coloured disc; above it, the silhouette. Silhouettes go muddy small, and the
  existing zoom-band gating would show them at the wrong times.
- `pinR` 5/6/7 → 9/11/14.
- Hover shows the full name and `role` in a card, replacing today's behaviour
  where the label appears only above 2.2× or on focus.

Every coloured mark keeps its dark keyline — that is what makes high chroma safe
over an unknown illustrated map.

---

## 10. Chrome contrast

`css/app.css` only, no logic.

- Transport buttons: 11.5px → 13px, `--dim` text → `--text`, `--bg-3` fill → a
  lighter `--bg-4`, padding 4px → 7px.
- Readout: 0.82 → 0.92 opacity, 13px body, and moved off the Westland (it is
  `top: 12px; left: 12px` and was measured 431px tall with a 14-name cast —
  parked exactly over where Elfstones happens).
- Rail: 6px track → 8px, 14px thumb → 16px.
- Chapter cells: brighter, `.current` more distinct.
- `--mute #5F6B7D` on `--bg-3` is **3.16:1** at 11px — under 4.5. Lighten it.
- Drop `maximum-scale=1` from the viewport meta (blocks pinch-zoom, WCAG 1.4.4).
- `role="slider"` on `#rail` has no accessible name — add `aria-label="Page"`.
- One `role="status"` sr-only node for the announcements, which today reach no
  screen reader.
- `<h2>` elements are direct children of `<dl>` in the help panel — invalid.

**The rule in CLAUDE.md holds:** no `font-size` or `stroke-width` on any
SVG-text selector. `view.js` sets them inline per frame from the current zoom.
One caveat worth guarding: if `getBoundingClientRect()` is 0×0 then `u` is
`Infinity`, `style.fontSize = "Infinitypx"` is dropped as invalid, and `.label`
inherits body's 13px *in map units* — the exact banner-size failure the rule
exists to prevent. Bail out of `render` when the rect is empty.

---

## 11. `book.js` correctness

Folded in because §3 rewrites the same code paths. All four reproduced by running
code.

| Bug | Effect |
|---|---|
| `places`/`byCharacter`/`charIndex` are `{}`, and existence is a truthiness test | `place: "constructor"` validates with **zero problems**, then throws `TypeError` in `dodge`. A `__proto__` character id silently loses all its waypoints from `book.waypoints`. Fix: `Object.create(null)`. (Correction: the duplicate *character id* check is NOT skipped — `seenChar` is a `Set` and reports correctly. What is skipped is the per-character duplicate *waypoint* loop at `book.js:189-200`, which iterates `Object.entries(byCharacter)`.) |
| `!(aspect > 0)` is false for `Infinity` | Every coordinate becomes `Infinity`; a `y` of 0 becomes `NaN`. Nothing reported. Fix: `isNum`. |
| Implicit chapter `n` assigned before the sort | Chapters listed out of page order get numbers that do not match reading order. Fix: assign after. |
| Route `via` bends get no 0..1 range check | A decimal typo flows straight to the drawn pin (`x: 3.013` on a 0..1 map). |

Also: a rejected route bend currently leaves the route drawn **solid**, i.e.
"this is what the book says". If any bend is rejected, drop the whole route so it
falls back to the honest dotted inferred line.

---

## 12. Data

**`data/shannara.json` — finished.** You have read it, so completing it from the
novel spoils nothing and gives you a reference dataset. Corrections needed
regardless: four places belong to *later* Shannara books, not *Sword* —
`southwatch`, `hearthstone`, `bakrabru`, `pass-of-jade`. Verify against the text
before deleting; if the endpaper art shows them, keep them as scenery but do not
route through them.

**`data/elfstones.json` — scaffolded.** Places, cast, chapter list, `readAlong:
true`, **zero waypoints**. You fill it in as you read.

The scaffold needs ~15–20 new Westland coordinates. The map covers them: the
endpaper scan (2288×1697, aspect 0.7417, matching `map.aspect`) carries Emberen,
Valley of Rhenn, Drey Wood, Sarandanon, Baen Draw, Kensrowe, Rill Song, Matted
Brakes, Pykon, Whistle Ridge, Grimpen Ward and the Wilderun. Two caveats:

1. **The title cartouche sits on the battlefield** — the scroll and sword occupy
   roughly x 0.32–0.45, y 0.02–0.44, immediately north-east of Arborlon and over
   the approach the Demon army comes down. Coloured pins over that engraving are
   the worst legibility case on the sheet. Default the scrim on for this book.
2. **The whole novel fits in ~6% of the image** — everything from Arborlon to
   Safehold lives in x 0.16–0.34, y 0.22–0.55. At fit zoom on a 1440×900 window
   that is a 170×240px box while the entire Eastland and Northland are dead
   pixels. Measured 8 pin pairs under 26px apart, five under 5px. Which leads to:

**`dodge` clusters by screen-space proximity, not exact coordinate equality.**
**LANDED.** It keyed on `p.x.toFixed(4)`, so pins at nearby but different places
never fanned at all — they just overlapped.

Correction to the first draft: this is not a `geometry.js`-only change. `dodge`
is called from `positionsAt` (`timeline.js:99`), which is pure and receives no
zoom, so the radius threads through `positionsAt(book, page, dodgeR)`. Both are
done. **The radius is still inert in the app** — `view.js:186` must pass
`clusterPx * u / MAP_W`, and that line waits on §9's new `pinR` values, which it
derives from. `app.js:565` (`showPopover`) is a second call site that wants no
dodging at all and should keep the default.

Two open problems the implementation raised:

1. **Single-link chaining is the common case here, not a corner case.** With the
   novel confined to x 0.16-0.34 / y 0.22-0.55 and five pin pairs under 5px
   apart, a six-pin chain fans to an ~18px radius (`9 + 2.2 * (crowd - 2)`,
   `view.js:331`) centred on a point belonging to none of them. Needs a cluster
   size cap, or a fallback to the puck above some size.
2. **§9 and §12 pull opposite ways.** §9 raises `pinR` 5/6/7 → 9/11/14, nearly
   doubling pin area, while §12's whole argument is that the map is already a
   smudge at 5px. Bigger pins make the crowding worse. The proximity radius is
   derived from `pinR` so it scales with it — but the puck threshold
   (`clusterAt`) should probably drop as pins grow. Unreconciled; decide when §9
   lands.

---

## 13. Sequencing

Revised after review. Each step lands green before the next starts.

1. **Chapter axis** (§3) — riskiest. Includes the `chapters[].start` change that
   makes a chapter-axis book parse at all, and the `clock.js` unit constants.
2. **`book.js` correctness** (§11) — same file, same pass.
3. **Remember the book** (§6) — *moved up from 4th.* §4 persists `upTo:<bookId>`
   and §5 mirrors per `book.id`, and neither helps until the app can reopen a
   book outside the hardcoded `BOOKS`. It is also the difference between
   re-dragging your file every night and opening a tab.
4. **Read-along mode** (§4) + **authoring** (§5) — one loop, shipped together.
5. **Offstage marker** (§7).
6. **Wire the proximity radius** (§12) — one line in `view.js`, after §9.
7. **Cast tiering** (§8).
8. **Silhouettes** (§9) — *in flight, out of order*, file-disjoint from
   everything above, which is why it was safe to start early.
9. **Chrome contrast** (§10) — *in flight, out of order*, same reason.
10. **Data** (§12) — Sword finished; Elfstones scaffolded. The scaffold can come
    earlier if you want to start reading before the visual work lands.

If only three get built: **1, 3, 4.**

### Also missing, found in review

- **`data/elfstones.json` needs a `BOOKS` entry** (`app.js:19-22`) — or §6 makes
  that unnecessary. Decide which; do not do both.
- **IndexedDB migration.** `store.js` is `DB_VERSION = 1` with a single store
  `maps` keyed by `bookId` (`store.js:9-21`, `:43-44`). §5/§6's `putBook`/
  `getBook` needs a version bump and an `onupgradeneeded` branch, or it throws
  `NotFoundError` on every existing install. And storing raw JSON "under
  `book.id`" in the `maps` store would **overwrite that book's map image**. It
  needs its own store.

---

## 14. Test plan

Pure modules keep the `node --test`, zero-dependency arrangement.

- **Chapter axis** — `ch`/`at` resolution against both unit modes; the mixed case
  reports; `page` still works; `demo-island.json` output is byte-identical before
  and after.
- **Read-along** — the ceiling clamps seek, jump and playback; every listed
  surface is empty past it; advancing is monotonic; the escape toggle restores.
- **`book.js`** — `Object.create(null)` for the four prototype keys; `Infinity`
  aspect reported; chapter `n` after an out-of-order sort; bend range; a route
  with a rejected bend comes back `inferred`.
- **`heldFor`** — a character bracketed by same-place waypoints 240 units apart
  reads as held, not as standing still.
- **`dodge`** — proximity clustering: pins 3px apart fan; pins 300px apart do not;
  order and angles stay deterministic.
- **`geometry.js` gaps found in review** — `headingAt` on a trailing zero-length
  segment returns the previous segment's direction rather than `null`;
  `headingAt(line, NaN)` matches `pointAt`'s clamp-to-start.
- **`clock.js`** — no test file exists; one is cheap (stub `matchMedia`,
  `performance.now`, `requestAnimationFrame`, drive `_tick` by hand). Assert the
  no-overshoot invariant the module's design rests on, exact settling, dt
  clamping, and that `setRange` clears an in-flight jump.
- **Browser** — the CDP harness used for pass 0 covers roster and pin clicks,
  puck rendering, the 404 path, and layout at 60 chapters. Extend it to the
  read-along surfaces rather than adding a browser-test dependency.

---

## 15. Open questions

Resolved by review, recorded so they are not reopened:

- ~~Unify `done` into `heldFor`~~ — **no.** `heldFor` does not work at all (§7);
  `done` stays and `offstage` is authored.
- ~~Locked chapter cells: number or blank~~ — **number.** The count is not a
  spoiler and tells you how much book is left.

Still open:

1. **Places past the ceiling** — hide entirely (proposed) or show the dot without
   a label? Hiding is honest but leaves an almost empty map in week one, which
   may read as broken rather than as careful.
2. **Supporting-tier palette** — desaturating the same eight hues risks muddying
   them over an illustrated map. May need a separate low-chroma ramp, or a
   different distinguishing channel entirely (outline weight, shape).
3. **Cluster size cap** (§12) — at what size does a proximity cluster become a
   puck instead of a wider fan?
4. **§9 vs §12** — bigger pins versus a map that is already crowded. Decide when
   §9 lands and its real pixel footprint can be measured.
5. **`data/maps/four-lands.webp` crop.** A Westland-only crop would make the
   Elfstones geography far more legible, but coordinates belong to the scan they
   were picked on, so it means a second map file and a second coordinate set.
6. **`storyEvents` keys meetings on `` `${place}@${page}` ``** — a float on the
   chapter axis. Not reproducible with plain `ch + at` arithmetic (`1 + 0.6` and
   `1.5 + 0.1` both give exactly `1.6`), so it is a latent risk rather than a
   demonstrated bug. It becomes real on §3's "paste a real chapter→page table"
   interpolation path, where positions stop being exact binary fractions.
