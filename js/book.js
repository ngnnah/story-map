// Parse, validate and normalise a book.json.
//
// Pure: takes the raw parsed JSON, returns {book, problems}. Problems are
// readable sentences meant to be shown to whoever is authoring the file, not
// thrown — a book with one bad waypoint should still render the other 149.
//
// Coordinates go in as 0..1 fractions of the image's width and height, which
// is what a human picking points off a map wants to write. They come out in
// square space (y multiplied by aspect, so y runs 0..aspect and both axes
// measure fractions of the width), which is what honest distance maths wants.
// `yFrac` keeps the original for anything that needs to round-trip.

// Eight hues roughly 45° apart at similar lightness. Map-ink tones look
// handsomer in a palette swatch but die at 6px over an illustrated map, and
// two of them were indistinguishable. Every coloured mark gets a dark keyline
// in the renderer, which is what makes high chroma safe over an unknown image.
const DEFAULT_COLORS = [
  '#5B9DFF', '#35D9D0', '#4FD173', '#B9DE4A',
  '#FFB847', '#FF7A57', '#FF5F9E', '#B98CFF',
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function parseBook(raw) {
  const problems = [];
  const fail = (m) => problems.push(m);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { book: null, problems: ['book.json is not a JSON object'] };
  }

  const title = typeof raw.title === 'string' && raw.title ? raw.title : '(untitled)';
  if (typeof raw.title !== 'string') fail('missing "title"');

  // --- map ---------------------------------------------------------------
  const rawMap = raw.map && typeof raw.map === 'object' ? raw.map : {};
  let aspect = Number(rawMap.aspect);
  if (!(aspect > 0)) {
    fail('"map.aspect" must be a positive number (image height divided by width)');
    aspect = 1;
  }
  const map = {
    name: typeof rawMap.name === 'string' ? rawMap.name : '',
    aspect,
    hint: typeof rawMap.hint === 'string' ? rawMap.hint : '',
    // A book may ship its own map image. When it does the app loads it
    // straight away; when it does not, the reader brings their own scan.
    file: typeof rawMap.file === 'string' ? rawMap.file : '',
  };

  // --- places ------------------------------------------------------------
  const places = {};
  const rawPlaces = raw.places && typeof raw.places === 'object' ? raw.places : {};
  if (!Object.keys(rawPlaces).length) fail('"places" is empty — nowhere to put anyone');
  for (const [id, p] of Object.entries(rawPlaces)) {
    if (!p || typeof p !== 'object') { fail(`place "${id}" is not an object`); continue; }
    if (!isNum(p.x) || !isNum(p.y)) {
      fail(`place "${id}" needs numeric x and y (fractions of the map, 0 to 1)`);
      continue;
    }
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) {
      fail(`place "${id}" is off the map at (${p.x}, ${p.y}) — x and y are fractions, 0 to 1`);
    }
    places[id] = {
      id,
      name: typeof p.name === 'string' && p.name ? p.name : id,
      x: p.x,
      y: p.y * aspect,          // into square space
      yFrac: p.y,
    };
  }

  // --- routes ------------------------------------------------------------
  const routes = [];
  for (const [i, r] of (Array.isArray(raw.routes) ? raw.routes : []).entries()) {
    if (!r || typeof r !== 'object') { fail(`routes[${i}] is not an object`); continue; }
    if (!places[r.from]) { fail(`routes[${i}] starts at unknown place "${r.from}"`); continue; }
    if (!places[r.to]) { fail(`routes[${i}] ends at unknown place "${r.to}"`); continue; }
    const via = [];
    for (const pt of Array.isArray(r.via) ? r.via : []) {
      const xy = Array.isArray(pt) && isNum(pt[0]) && isNum(pt[1]) ? { x: pt[0], y: pt[1] }
        : pt && isNum(pt.x) && isNum(pt.y) ? { x: pt.x, y: pt.y }
        : null;
      if (!xy) { fail(`routes[${i}] has a bend that is not [x, y]`); continue; }
      via.push({ x: xy.x, y: xy.y * aspect, yFrac: xy.y });
    }
    routes.push({ from: r.from, to: r.to, via });
  }

  // --- characters --------------------------------------------------------
  const characters = [];
  const seenChar = new Set();
  for (const [i, c] of (Array.isArray(raw.characters) ? raw.characters : []).entries()) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id) {
      fail(`characters[${i}] needs a string "id"`);
      continue;
    }
    if (seenChar.has(c.id)) { fail(`duplicate character id "${c.id}"`); continue; }
    seenChar.add(c.id);
    const name = typeof c.name === 'string' && c.name ? c.name : c.id;
    characters.push({
      id: c.id,
      name,
      // "Shea Ohmsford and Flick Ohmsford and Menion Leah" does not fit on a
      // chip over a map. First names do.
      short: typeof c.short === 'string' && c.short ? c.short : name.split(/\s+/)[0],
      color: typeof c.color === 'string' && c.color ? c.color : DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      role: typeof c.role === 'string' ? c.role : '',
      // A named silhouette from js/icons.js. Absent, the pin stays a disc, so
      // a book that names nothing still renders.
      icon: typeof c.icon === 'string' ? c.icon : '',
    });
  }
  if (!characters.length) fail('"characters" is empty — nobody to follow');

  // --- chapters ----------------------------------------------------------
  const chapters = [];
  for (const [i, c] of (Array.isArray(raw.chapters) ? raw.chapters : []).entries()) {
    if (!c || typeof c !== 'object' || !isNum(c.startPage)) {
      fail(`chapters[${i}] needs a numeric "startPage"`);
      continue;
    }
    chapters.push({
      n: isNum(c.n) ? c.n : i + 1,
      startPage: c.startPage,
      title: typeof c.title === 'string' ? c.title : '',
    });
  }
  chapters.sort((a, b) => a.startPage - b.startPage);

  // --- waypoints ---------------------------------------------------------
  // A waypoint asserts: `who` is at `place` on `page`.
  //
  // `place: null` means they have left the map — died, sailed off, or the book
  // simply stops saying where they are — and they are not drawn again until
  // their next waypoint with a place. Without it the model would confidently
  // march a dead character across the map for the rest of the book.
  //
  // `who` may be an array. A quest novel moves most of its cast as one party,
  // and writing eight near-identical lines per stop is how a dataset stops
  // being worth finishing.
  const waypoints = [];
  for (const [i, w] of (Array.isArray(raw.waypoints) ? raw.waypoints : []).entries()) {
    if (!w || typeof w !== 'object') { fail(`waypoints[${i}] is not an object`); continue; }
    if (!isNum(w.page)) { fail(`waypoints[${i}] needs a numeric "page"`); continue; }

    const offMap = w.place === null || w.place === undefined;
    if (!offMap && !places[w.place]) {
      fail(`waypoints[${i}] (p.${w.page}) is at unknown place "${w.place}"`);
      continue;
    }

    const whos = Array.isArray(w.who) ? w.who : [w.who];
    if (!whos.length) { fail(`waypoints[${i}] (p.${w.page}) has nobody in "who"`); continue; }
    for (const who of whos) {
      if (!seenChar.has(who)) {
        fail(`waypoints[${i}] (p.${w.page}) is for unknown character "${who}"`);
        continue;
      }
      waypoints.push({
        who,
        page: w.page,
        place: offMap ? null : w.place,
        note: typeof w.note === 'string' ? w.note : '',
        party: whos.length > 1 ? whos.filter((o) => seenChar.has(o)) : null,
      });
    }
  }
  if (!waypoints.length) fail('"waypoints" is empty — nothing happens');

  // --- page range --------------------------------------------------------
  let pages = Array.isArray(raw.pages) ? raw.pages.map(Number) : null;
  if (!pages || pages.length !== 2 || !isNum(pages[0]) || !isNum(pages[1]) || !(pages[0] < pages[1])) {
    if (raw.pages !== undefined) fail('"pages" must be [firstPage, lastPage] with first < last');
    const all = waypoints.map((w) => w.page);
    pages = all.length ? [Math.min(...all), Math.max(...all)] : [1, 2];
    if (pages[0] === pages[1]) pages = [pages[0], pages[0] + 1];
  }
  for (const w of waypoints) {
    if (w.page < pages[0] || w.page > pages[1]) {
      fail(`${w.who} has a waypoint on p.${w.page}, outside the book's pages ${pages[0]}–${pages[1]}`);
    }
  }

  // --- per-character index, sorted by page -------------------------------
  const byCharacter = {};
  for (const c of characters) byCharacter[c.id] = [];
  for (const w of waypoints) byCharacter[w.who].push(w);
  // Two waypoints for one character on one page make the bracketing lookup
  // ambiguous and, if the places differ, meaningless. Drop the duplicate and
  // say so rather than letting it produce a pin at NaN.
  for (const [who, list] of Object.entries(byCharacter)) {
    list.sort((a, b) => a.page - b.page);
    for (let i = list.length - 1; i > 0; i--) {
      if (list[i].page !== list[i - 1].page) continue;
      if (list[i].place !== list[i - 1].place) {
        fail(`${who} is in two places on p.${list[i].page} ("${list[i - 1].place}" and "${list[i].place}")`);
      } else {
        fail(`${who} has a duplicate waypoint on p.${list[i].page}`);
      }
      list.splice(i, 1);
    }
  }

  // The flat list is rebuilt from the per-character index so both agree after
  // any duplicates were dropped.
  const kept = Object.values(byCharacter).flat().sort((a, b) => a.page - b.page);

  const book = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : slug(title),
    title,
    author: typeof raw.author === 'string' ? raw.author : '',
    map,
    pages,
    places,
    routes,
    characters,
    chapters,
    waypoints: kept,
    byCharacter,
    charIndex: Object.fromEntries(characters.map((c, i) => [c.id, i])),
    bow: isNum(raw.bow) ? raw.bow : 0.06,
  };
  return { book, problems };
}

/**
 * The polyline a character follows between two places: the straight segment
 * unless a route says otherwise. Routes match in either direction and are
 * reversed when travelled backwards. A straight line is just a 2-point
 * polyline, so callers have a single code path.
 *
 * `who` bows an *inferred* leg — one with no authored route — very slightly to
 * one side. Without it, everyone who has ever walked from Shady Vale to Leah
 * draws the same line and all but the last of them is invisible. Each
 * character gets their own lane, spread evenly across the cast, so two
 * characters never land on the same curve. Authored routes are never bowed:
 * those are what the book actually says. `book.bow` sets the spread; 0 off.
 *
 * `inferred` on the result tells the renderer to dot the line, so a reader can
 * tell "the book says they went this way" from "we drew a straight guess".
 */
export function polylineFor(book, fromId, toId, who = '') {
  const a = book.places[fromId];
  const z = book.places[toId];
  if (!a || !z) return null;

  const route = book.routes.find(
    (r) => (r.from === fromId && r.to === toId) || (r.from === toId && r.to === fromId),
  );

  if (route) {
    // Reversing the bends matters: a route declared one way and walked the
    // other would otherwise zigzag from the destination back through the
    // bends in their original order.
    const via = route.from === fromId ? route.via : [...route.via].reverse();
    const line = [{ x: a.x, y: a.y }, ...via.map((p) => ({ x: p.x, y: p.y })), { x: z.x, y: z.y }];
    line.inferred = false;
    return line;
  }

  const line = [{ x: a.x, y: a.y }];
  const lane = who ? laneOf(book, who) : 0;
  if (lane && book.bow) {
    // The perpendicular is taken along a canonical ordering of the two places,
    // not along the direction of travel. Otherwise an out-and-back retrace
    // bows the opposite way and draws two near-identical lines instead of
    // retracing the one the character already walked.
    const [p, q] = fromId < toId ? [a, z] : [z, a];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    // Square space, so the perpendicular is just a rotation — no aspect fudge.
    line.push({
      x: (a.x + z.x) / 2 - lane * book.bow * dy,
      y: (a.y + z.y) / 2 + lane * book.bow * dx,
    });
  }
  line.push({ x: z.x, y: z.y });
  line.inferred = true;
  return line;
}

/** A character's lane, spread evenly over -1..1 across the cast. */
function laneOf(book, who) {
  const i = book.charIndex[who];
  if (i === undefined) return 0;
  const n = book.characters.length;
  if (n < 2) return 0;
  return (i - (n - 1) / 2) / ((n - 1) / 2);
}

/** The chapter containing `page`, or the first chapter if page precedes it. */
export function chapterAt(book, page) {
  let found = book.chapters[0] || null;
  for (const c of book.chapters) {
    if (c.startPage <= page) found = c;
    else break;
  }
  return found;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'book';
}
