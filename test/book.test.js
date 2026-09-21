import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBook, polylineFor, chapterAt } from '../js/book.js';

const demoRaw = JSON.parse(
  readFileSync(new URL('../data/demo-island.json', import.meta.url), 'utf8'),
);
const ASPECT = demoRaw.map.aspect;
const clone = () => JSON.parse(JSON.stringify(demoRaw));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

test('the demo fixture parses with no problems', () => {
  const { book, problems } = parseBook(demoRaw);
  assert.deepEqual(problems, []);
  assert.equal(book.title, 'The Salt Road');
  assert.equal(book.characters.length, 3);
  assert.equal(Object.keys(book.places).length, 5);
  assert.deepEqual(book.pages, [1, 96]);
});

test('coordinates come out in square space, with the original kept', () => {
  const { book } = parseBook(demoRaw);
  const p = book.places['harbor-town'];
  assert.equal(p.x, 0.20);                 // x is already a fraction of width
  near(p.y, 0.72 * ASPECT);                // y scaled so both axes measure width
  assert.equal(p.yFrac, 0.72);
});

test('route bends are converted to square space too', () => {
  const { book } = parseBook(demoRaw);
  near(book.routes[0].via[0].y, 0.36 * ASPECT);
  assert.equal(book.routes[0].via[0].yFrac, 0.36);
});

test('an array in "who" expands to one waypoint per character', () => {
  const { book } = parseBook(demoRaw);
  // Mira and Tam leave Harbor Town together on p.1, 20 and 32.
  for (const page of [1, 20, 32]) {
    assert.ok(book.byCharacter.mira.some((w) => w.page === page && w.place === 'harbor-town' || w.page === page));
    assert.ok(book.byCharacter.tam.some((w) => w.page === page));
  }
  const shared = book.byCharacter.mira.find((w) => w.page === 1);
  assert.deepEqual(shared.party, ['mira', 'tam']);
});

test('a solo waypoint has no party', () => {
  const { book } = parseBook(demoRaw);
  assert.equal(book.byCharacter.mira.find((w) => w.page === 60).party, null);
});

test('waypoints are indexed per character and sorted by page', () => {
  const { book } = parseBook(demoRaw);
  for (const id of ['mira', 'corin', 'tam']) {
    const pages = book.byCharacter[id].map((w) => w.page);
    assert.deepEqual(pages, [...pages].sort((a, b) => a - b));
  }
  assert.equal(book.byCharacter.corin[0].page, 20);
});

test('a null place is kept as an exit from the map', () => {
  const { book } = parseBook(demoRaw);
  const last = book.byCharacter.tam.at(-1);
  assert.equal(last.place, null);
  assert.equal(last.page, 66);
  assert.match(last.note, /not seen again/);
});

test('a waypoint naming an unknown place is reported, not swallowed', () => {
  const raw = clone();
  raw.waypoints[3].place = 'atlantis';           // mira, p.45
  const { book, problems } = parseBook(raw);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown place "atlantis"/);
  assert.match(problems[0], /p\.45/);
  assert.ok(book.waypoints.length > 10);          // the rest still load
});

test('an unknown character is reported', () => {
  const raw = clone();
  raw.waypoints.push({ who: 'allanon', page: 40, place: 'old-mill' });
  const { problems } = parseBook(raw);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown character "allanon"/);
});

test('one bad name in a party does not lose the rest of the party', () => {
  const raw = clone();
  raw.waypoints.push({ who: ['mira', 'allanon'], page: 50, place: 'old-mill' });
  const { book, problems } = parseBook(raw);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown character "allanon"/);
  assert.ok(book.byCharacter.mira.some((w) => w.page === 50));
});

test('a page outside the book is reported', () => {
  const raw = clone();
  raw.waypoints.push({ who: 'mira', page: 400, place: 'old-mill' });
  const { problems } = parseBook(raw);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /p\.400, outside the book's pages 1–96/);
});

test('a character in two places on one page is reported and the duplicate dropped', () => {
  const raw = clone();
  raw.waypoints.push({ who: 'mira', page: 45, place: 'salt-marsh' });
  const { book, problems } = parseBook(raw);
  assert.ok(problems.some((p) => /mira is in two places on p\.45/.test(p)), problems.join('; '));
  assert.equal(book.byCharacter.mira.filter((w) => w.page === 45).length, 1);
});

test('an exact duplicate waypoint is reported and dropped', () => {
  const raw = clone();
  raw.waypoints.push({ who: 'mira', page: 45, place: 'old-mill' });
  const { book, problems } = parseBook(raw);
  assert.ok(problems.some((p) => /duplicate waypoint on p\.45/.test(p)), problems.join('; '));
  assert.equal(book.byCharacter.mira.filter((w) => w.page === 45).length, 1);
});

test('coordinates outside 0..1 are reported as fractions, not pixels', () => {
  const raw = clone();
  raw.places['old-mill'].x = 612;
  const { problems } = parseBook(raw);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /off the map/);
  assert.match(problems[0], /fractions/);
});

test('a missing aspect is reported and falls back to square', () => {
  const raw = clone();
  delete raw.map.aspect;
  const { book, problems } = parseBook(raw);
  assert.match(problems[0], /map\.aspect/);
  assert.equal(book.map.aspect, 1);
  assert.equal(book.places['harbor-town'].y, 0.72);
});

test('pages fall back to the waypoint range when absent', () => {
  const raw = clone();
  delete raw.pages;
  const { book, problems } = parseBook(raw);
  assert.deepEqual(problems, []);
  assert.deepEqual(book.pages, [1, 96]);
});

test('duplicate character ids are reported', () => {
  const raw = clone();
  raw.characters.push({ id: 'mira', name: 'Mira again' });
  const { book, problems } = parseBook(raw);
  assert.ok(problems.some((p) => /duplicate character id "mira"/.test(p)));
  assert.equal(book.characters.length, 3);
});

test('characters without a colour get distinct ones', () => {
  const raw = clone();
  for (const c of raw.characters) delete c.color;
  const { book } = parseBook(raw);
  const colors = book.characters.map((c) => c.color);
  assert.equal(new Set(colors).size, colors.length);
  for (const c of colors) assert.match(c, /^#[0-9a-f]{6}$/i);
});

test('garbage input does not throw', () => {
  assert.deepEqual(parseBook(null).problems, ['book.json is not a JSON object']);
  assert.deepEqual(parseBook([]).problems, ['book.json is not a JSON object']);
  const { book, problems } = parseBook({});
  assert.ok(problems.length >= 4);
  assert.ok(book);
});

test('polylineFor is a straight 2-point line when no route and no bowing', () => {
  const { book } = parseBook(demoRaw);
  const line = polylineFor(book, 'harbor-town', 'old-mill');
  assert.equal(line.length, 2);
  assert.equal(line.inferred, true);
  assert.deepEqual(line[0], { x: 0.20, y: 0.72 * ASPECT });
});

test('each character bows an inferred leg into their own lane', () => {
  const { book } = parseBook(demoRaw);      // mira, corin, tam -> lanes -1, 0, 1
  const lines = ['mira', 'corin', 'tam'].map(
    (who) => polylineFor(book, 'harbor-town', 'old-mill', who),
  );
  // Same endpoints for everyone: the book says where they started and ended.
  for (const l of lines) {
    assert.deepEqual(l[0], lines[0][0]);
    assert.deepEqual(l.at(-1), lines[0].at(-1));
  }
  // The middle lane is straight; the outer two bow to opposite sides.
  assert.equal(lines[1].length, 2);
  assert.equal(lines[0].length, 3);
  assert.equal(lines[2].length, 3);
  const mid = { x: (0.20 + 0.35) / 2, y: (0.72 + 0.50) / 2 * ASPECT };
  assert.ok(Math.sign(lines[0][1].x - mid.x) === -Math.sign(lines[2][1].x - mid.x));
  // and it is deterministic
  assert.deepEqual(lines[0], polylineFor(book, 'harbor-town', 'old-mill', 'mira'));
});

test('no two characters share a bowed lane', () => {
  const { book } = parseBook(demoRaw);
  const mids = ['mira', 'corin', 'tam']
    .map((who) => polylineFor(book, 'harbor-town', 'old-mill', who))
    .map((l) => (l.length === 3 ? `${l[1].x.toFixed(6)},${l[1].y.toFixed(6)}` : 'straight'));
  assert.equal(new Set(mids).size, mids.length);
});

test('bowing is symmetric, so a retrace lies on the same curve', () => {
  const { book } = parseBook(demoRaw);
  const there = polylineFor(book, 'harbor-town', 'old-mill', 'mira');
  const back = polylineFor(book, 'old-mill', 'harbor-town', 'mira');
  near(there[1].x, back[1].x);
  near(there[1].y, back[1].y);
});

test('bow: 0 in the book disables bowing', () => {
  const raw = clone();
  raw.bow = 0;
  const { book } = parseBook(raw);
  assert.equal(polylineFor(book, 'harbor-town', 'old-mill', 'mira').length, 2);
});

test('an authored route is never bowed and is not marked inferred', () => {
  const { book } = parseBook(demoRaw);
  const line = polylineFor(book, 'old-mill', 'north-keep', 'mira');
  assert.equal(line.length, 4);
  assert.equal(line.inferred, false);
  near(line[1].x, 0.33);
  near(line[1].y, 0.36 * ASPECT);
});

test('polylineFor reverses a route travelled backwards', () => {
  const { book } = parseBook(demoRaw);
  const there = polylineFor(book, 'old-mill', 'north-keep', 'mira');
  const back = polylineFor(book, 'north-keep', 'old-mill', 'mira');
  assert.deepEqual(back.map((p) => [p.x, p.y]), there.map((p) => [p.x, p.y]).reverse());
});

test('polylineFor returns null for an unknown place', () => {
  const { book } = parseBook(demoRaw);
  assert.equal(polylineFor(book, 'old-mill', 'nowhere'), null);
});

test('chapterAt finds the containing chapter', () => {
  const { book } = parseBook(demoRaw);
  assert.equal(chapterAt(book, 1).n, 1);
  assert.equal(chapterAt(book, 19).n, 1);
  assert.equal(chapterAt(book, 20).n, 2);
  assert.equal(chapterAt(book, 44).n, 2);
  assert.equal(chapterAt(book, 96).n, 4);
});

// --- the chapter axis ------------------------------------------------------
//
// Page numbers are edition-specific. A reader knows they are in chapter 12,
// not on page 138 of someone else's printing. A book may therefore author
// waypoints as `ch` + `at` and omit startPage entirely, and the unit becomes a
// property of the book rather than of the app.

const chapterBook = (over = {}) => parseBook({
  title: 'Elfstones',
  map: { aspect: 1 },
  places: { arborlon: { name: 'Arborlon', x: 0.3, y: 0.35 }, rhenn: { name: 'Rhenn', x: 0.34, y: 0.38 } },
  characters: [{ id: 'wil', name: 'Wil Ohmsford' }, { id: 'amberle', name: 'Amberle' }],
  chapters: [{ n: 1, title: 'One' }, { n: 2, title: 'Two' }, { n: 3, title: 'Three' }],
  waypoints: [
    { who: ['wil', 'amberle'], ch: 1, place: 'arborlon' },
    { who: 'wil', ch: 2, at: 0.5, place: 'rhenn' },
  ],
  ...over,
});

test('a book whose chapters have no startPage still parses', () => {
  const { book, problems } = chapterBook();
  assert.deepEqual(problems, [], problems.join('; '));
  assert.equal(book.chapters.length, 3);
  assert.equal(book.axis, 'chapter');
});

test('on the chapter axis a chapter starts at its own number', () => {
  const { book } = chapterBook();
  assert.deepEqual(book.chapters.map((c) => c.start), [1, 2, 3]);
  assert.deepEqual(book.pages, [1, 4]);        // chapter 3 runs up to 4
});

test('ch + at resolves to a position inside that chapter', () => {
  const { book } = chapterBook();
  const wil = book.byCharacter.wil;
  assert.equal(wil[0].page, 1);                // ch 1, at defaults to 0
  assert.equal(wil[1].page, 2.5);              // ch 2, half way
});

test('a startPage on every chapter keeps the page axis', () => {
  const { book, problems } = parseBook({
    title: 'Sword', map: { aspect: 1 }, pages: [1, 726],
    places: { a: { name: 'A', x: 0.5, y: 0.5 } },
    characters: [{ id: 'shea', name: 'Shea' }],
    chapters: [{ n: 1, startPage: 1 }, { n: 2, startPage: 14 }],
    waypoints: [{ who: 'shea', page: 1, place: 'a' }],
  });
  assert.deepEqual(problems, []);
  assert.equal(book.axis, 'page');
  assert.deepEqual(book.chapters.map((c) => c.start), [1, 14]);
});

test('ch + at interpolates within a chapter on the page axis', () => {
  const { book } = parseBook({
    title: 'Sword', map: { aspect: 1 }, pages: [1, 100],
    places: { a: { name: 'A', x: 0.5, y: 0.5 } },
    characters: [{ id: 'shea', name: 'Shea' }],
    chapters: [{ n: 1, startPage: 1 }, { n: 2, startPage: 21 }, { n: 3, startPage: 41 }],
    waypoints: [{ who: 'shea', ch: 2, at: 0.5, place: 'a' }],
  });
  assert.equal(book.byCharacter.shea[0].page, 31);   // half way through 21..41
});

test('chapters with some startPage and some not are reported', () => {
  const { book, problems } = chapterBook({
    chapters: [{ n: 1, startPage: 1 }, { n: 2 }, { n: 3 }],
  });
  assert.equal(book.axis, 'chapter');
  assert.ok(problems.some((p) => /startPage/.test(p)), problems.join('; '));
});

test('a waypoint naming a chapter that does not exist is reported, not drawn', () => {
  const { book, problems } = chapterBook({
    waypoints: [
      { who: 'wil', ch: 1, place: 'arborlon' },
      { who: 'wil', ch: 99, place: 'rhenn' },
    ],
  });
  assert.ok(problems.some((p) => /99/.test(p)), problems.join('; '));
  assert.equal(book.byCharacter.wil.length, 1);
});

test('chapterAt reads the resolved start, whichever axis', () => {
  const { book } = chapterBook();
  assert.equal(chapterAt(book, 1).n, 1);
  assert.equal(chapterAt(book, 2.5).n, 2);
  assert.equal(chapterAt(book, 3.9).n, 3);
});

// --- validation hardening (§11) -------------------------------------------

test('a prototype key is not a place', () => {
  const { book, problems } = parseBook({
    title: 't', map: { aspect: 1 }, pages: [1, 100],
    places: { real: { name: 'Real', x: 0.5, y: 0.5 } },
    characters: [{ id: 'a', name: 'A' }],
    chapters: [{ n: 1, startPage: 1 }],
    waypoints: [{ who: 'a', page: 1, place: 'real' }, { who: 'a', page: 50, place: 'constructor' }],
  });
  assert.ok(problems.some((p) => /constructor/.test(p)), problems.join('; '));
  assert.equal(book.byCharacter.a.length, 1);
});

test('a __proto__ character keeps its waypoints', () => {
  const { book } = parseBook({
    title: 't', map: { aspect: 1 }, pages: [1, 100],
    places: { a: { name: 'A', x: 0.5, y: 0.5 } },
    characters: [{ id: '__proto__', name: 'Odd' }],
    chapters: [{ n: 1, startPage: 1 }],
    waypoints: [{ who: '__proto__', page: 1, place: 'a' }],
  });
  assert.equal(book.byCharacter['__proto__'].length, 1);
  assert.equal(book.waypoints.length, 1);
});

test('a non-finite aspect is reported, not propagated', () => {
  const { book, problems } = parseBook({
    title: 't', map: { aspect: 1e400 }, pages: [1, 100],
    places: { a: { name: 'A', x: 0.5, y: 0.4 } },
    characters: [{ id: 'a', name: 'A' }],
    chapters: [{ n: 1, startPage: 1 }],
    waypoints: [{ who: 'a', page: 1, place: 'a' }],
  });
  assert.ok(problems.some((p) => /aspect/.test(p)), problems.join('; '));
  assert.ok(Number.isFinite(book.places.a.y), `y was ${book.places.a.y}`);
});

test('implicit chapter numbers follow reading order, not array order', () => {
  const { book } = parseBook({
    title: 't', map: { aspect: 1 }, pages: [1, 100],
    places: { a: { name: 'A', x: 0.5, y: 0.5 } },
    characters: [{ id: 'a', name: 'A' }],
    chapters: [{ startPage: 45 }, { startPage: 1 }, { startPage: 20 }],
    waypoints: [{ who: 'a', page: 1, place: 'a' }],
  });
  assert.deepEqual(book.chapters.map((c) => [c.n, c.start]), [[1, 1], [2, 20], [3, 45]]);
});

test('a route bend outside the map is reported and the route is not trusted', () => {
  const { book, problems } = parseBook({
    title: 't', map: { aspect: 1 }, pages: [1, 100],
    places: { a: { name: 'A', x: 0.2, y: 0.2 }, b: { name: 'B', x: 0.8, y: 0.8 } },
    routes: [{ from: 'a', to: 'b', via: [[3.3, 0.36]] }],
    characters: [{ id: 'x', name: 'X' }],
    chapters: [{ n: 1, startPage: 1 }],
    waypoints: [{ who: 'x', page: 1, place: 'a' }, { who: 'x', page: 50, place: 'b' }],
  });
  assert.ok(problems.some((p) => /bend/.test(p)), problems.join('; '));
  const line = polylineFor(book, 'a', 'b', 'x');
  assert.equal(line.inferred, true, 'a route with a bad bend must not be drawn as authored');
});
