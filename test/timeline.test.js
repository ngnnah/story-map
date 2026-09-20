import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBook, polylineFor } from '../js/book.js';
import { positionsAt, trailUpTo, presence, storyEvents, legEase, bandTrails } from '../js/timeline.js';
import { length, pointAt } from '../js/geometry.js';

const demoRaw = JSON.parse(
  readFileSync(new URL('../data/demo-island.json', import.meta.url), 'utf8'),
);
const { book } = parseBook(demoRaw);
const ASPECT = demoRaw.map.aspect;

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);
const find = (pins, who) => pins.find((p) => p.who === who);
const at = (page) => positionsAt(book, page);

/**
 * A minimal two-place book with bowing off. Tests about collisions, meetings
 * and exact interpolation build their own rather than bending the demo fixture
 * into shapes it was not written for.
 */
function makeBook(waypoints, characters = [
  { id: 'a', name: 'A', color: '#111111' },
  { id: 'b', name: 'B', color: '#222222' },
], extra = {}) {
  const { book: made, problems } = parseBook({
    title: 'mini',
    map: { aspect: 1 },
    pages: [1, 100],
    bow: 0,
    places: {
      north: { name: 'North', x: 0.5, y: 0.2 },
      south: { name: 'South', x: 0.5, y: 0.8 },
      east: { name: 'East', x: 0.9, y: 0.5 },
    },
    characters,
    chapters: [{ n: 1, startPage: 1 }],
    waypoints,
    ...extra,
  });
  assert.deepEqual(problems, [], problems.join('; '));
  return made;
}

// --- presence and absence --------------------------------------------------

test('a character is absent before their first waypoint', () => {
  assert.equal(find(at(1), 'corin'), undefined);
  assert.equal(find(at(19), 'corin'), undefined);
  assert.ok(find(at(20), 'corin'));
});

test('a character holds position after their last waypoint', () => {
  const pins = at(96);
  const corin = find(pins, 'corin');       // last waypoint is p.80
  assert.equal(corin.place, 'old-mill');
  assert.equal(corin.state, 'at');
  assert.equal(corin.done, true);
});

test('a page before the book starts leaves the map empty', () => {
  assert.deepEqual(at(-50), []);
});

test('a page past the end holds everyone still on the map', () => {
  const pins = at(9999);
  assert.equal(pins.length, 2);            // tam left at p.66
  assert.ok(pins.every((p) => p.state === 'at'));
});

test('a null place takes a character off the map and keeps them off', () => {
  assert.ok(find(at(60), 'tam'), 'present before the exit');
  assert.equal(find(at(66), 'tam'), undefined);
  assert.equal(find(at(96), 'tam'), undefined);
});

test('waiting to vanish does not drag the pin toward nowhere', () => {
  // Tam reaches salt-marsh on p.58; his next waypoint is the null at p.66.
  const pin = find(at(62), 'tam');
  assert.equal(pin.state, 'at');
  assert.equal(pin.place, 'salt-marsh');
});

// --- movement --------------------------------------------------------------

test('two waypoints at the same place mean the pin does not drift', () => {
  const a = find(at(5), 'mira');
  const b = find(at(15), 'mira');
  assert.equal(a.state, 'at');
  assert.equal(a.place, 'harbor-town');
  assert.deepEqual([a.x, a.y], [b.x, b.y]);
  assert.deepEqual([a.x, a.y], [0.20, 0.72 * ASPECT]);
});

test('a pin in transit sits at the eased midpoint between two places', () => {
  const b2 = makeBook([
    { who: 'a', page: 10, place: 'north' },
    { who: 'a', page: 30, place: 'south' },
  ]);
  const mid = find(positionsAt(b2, 20), 'a');
  assert.equal(mid.state, 'moving');
  assert.equal(mid.from, 'north');
  assert.equal(mid.to, 'south');
  near(mid.progress, 0.5);                 // legEase(0.5) === 0.5
  near(mid.x, 0.5);
  near(mid.y, 0.5);
});

test('legs are eased, so departures and arrivals are slower than the middle', () => {
  assert.equal(legEase(0), 0);
  assert.equal(legEase(1), 1);
  near(legEase(0.5), 0.5);
  assert.ok(legEase(0.25) < 0.25, 'slow off the mark');
  assert.ok(legEase(0.75) > 0.75, 'slow into the destination');
  assert.equal(legEase(-5), 0);
  assert.equal(legEase(99), 1);
});

test('a pin in transit follows a bent route rather than cutting the corner', () => {
  const half = find(at(52.5), 'mira');     // old-mill p.45 -> north-keep p.60
  assert.equal(half.state, 'moving');
  assert.equal(half.inferred, false);
  const straightX = (0.35 + 0.48) / 2;
  const straightY = (0.50 + 0.18) / 2 * ASPECT;
  assert.ok(
    Math.hypot(half.x - straightX, half.y - straightY) > 0.02,
    'a routed leg should diverge from the straight line',
  );
});

test('an inferred leg is flagged so the renderer can dot it', () => {
  assert.equal(find(at(26), 'mira').inferred, true);   // harbor-town -> old-mill
});

test('positions carry a heading and a speed while moving, neither while resting', () => {
  const moving = find(at(26), 'mira');
  assert.ok(moving.heading);
  assert.ok(moving.speed > 0);
  assert.equal(find(at(5), 'mira').heading, null);
});

test('characters travelling as a party carry the party list', () => {
  const pin = find(at(10), 'mira');
  assert.deepEqual(pin.party, ['mira', 'tam']);
});

// --- crowding --------------------------------------------------------------

test('two characters at one place get distinct unit offsets', () => {
  const b2 = makeBook([
    { who: 'a', page: 10, place: 'north' },
    { who: 'a', page: 50, place: 'north' },
    { who: 'b', page: 20, place: 'north' },
    { who: 'b', page: 60, place: 'north' },
  ]);
  const pins = positionsAt(b2, 30);
  const a = find(pins, 'a');
  const b = find(pins, 'b');
  assert.equal(a.crowd, 2);
  assert.equal(b.crowd, 2);
  assert.notDeepEqual(a.off, b.off);
  // The underlying position is still the true place — the renderer applies the
  // offset in pixels, so the fan is the same size at every zoom level.
  assert.deepEqual([a.x, a.y], [0.5, 0.2]);
  assert.deepEqual([b.x, b.y], [0.5, 0.2]);
});

test('a lone pin has no offset', () => {
  const pin = find(at(5), 'corin') || find(at(30), 'corin');
  assert.equal(pin.crowd, 1);
  assert.equal(pin.off, null);
});

// --- trails ----------------------------------------------------------------

test('a trail ends exactly where the pin is, for every character and page', () => {
  for (const who of ['mira', 'corin', 'tam']) {
    for (let page = 1; page <= 96; page += 1) {
      const pin = find(at(page), who);
      const trail = trailUpTo(book, who, page);
      if (!pin) continue;
      assert.ok(trail.length, `${who} p.${page}: pin but no trail`);
      const tail = trail.at(-1);
      near(tail.x, pin.x, 1e-9);
      near(tail.y, pin.y, 1e-9);
    }
  }
});

test('a trail grows monotonically as pages advance', () => {
  for (const who of ['mira', 'corin']) {
    let prev = -1;
    for (let page = 1; page <= 96; page += 1) {
      const len = length(trailUpTo(book, who, page));
      assert.ok(len >= prev - 1e-9, `${who} trail shrank at p.${page}`);
      prev = len;
    }
  }
});

test('a trail is empty before the character appears', () => {
  assert.deepEqual(trailUpTo(book, 'corin', 5), []);
});

test('a trail includes the corner of a bent route once passed', () => {
  const trail = trailUpTo(book, 'mira', 96);
  const hasCorner = trail.some(
    (p) => Math.abs(p.x - 0.33) < 1e-9 && Math.abs(p.y - 0.36 * ASPECT) < 1e-9,
  );
  assert.ok(hasCorner);
});

test('a trail marks which legs were inferred', () => {
  const trail = trailUpTo(book, 'mira', 96);
  assert.ok(trail.some((p) => p.inferred === true), 'harbor-town -> old-mill is a guess');
  assert.ok(trail.some((p) => p.inferred === false), 'old-mill -> north-keep is authored');
});

test('a dead character keeps the trail they earned', () => {
  const before = length(trailUpTo(book, 'tam', 65));
  const after = length(trailUpTo(book, 'tam', 96));
  assert.ok(before > 0);
  near(after, before, 1e-9);
});

test('the trail and the pin agree on the eased position mid-leg', () => {
  const b2 = makeBook([
    { who: 'a', page: 10, place: 'north' },
    { who: 'a', page: 30, place: 'south' },
  ]);
  const page = 16;
  const line = polylineFor(b2, 'north', 'south', 'a');
  const expected = pointAt(line, legEase((page - 10) / 20));
  const pin = find(positionsAt(b2, page), 'a');
  near(pin.x, expected.x);
  near(pin.y, expected.y);
  near(trailUpTo(b2, 'a', page).at(-1).y, expected.y);
});

// --- presence and events ---------------------------------------------------

test('presence collapses a run of waypoints at one place into one stay', () => {
  assert.deepEqual(presence(book, 'mira').map((s) => [s.place, s.from, s.to]), [
    ['harbor-town', 1, 20],
    ['old-mill', 32, 45],
    ['north-keep', 60, 75],
    ['old-mill', 88, 96],
  ]);
});

test('presence extends the final stay to the end of the book, as positionsAt does', () => {
  // Corin's last waypoint is p.80, but his pin sits at Old Mill to p.96.
  assert.deepEqual(presence(book, 'corin').at(-1), {
    place: 'old-mill', from: 80, to: 96, note: '',
  });
});

test('a stay runs up to the page the character vanishes, not past it', () => {
  // Tam reaches the salt marsh on p.58 and walks off the map on p.66. He is
  // standing there for those eight pages, which is why Corin meets him.
  assert.deepEqual(presence(book, 'tam').at(-1), {
    place: 'salt-marsh', from: 58, to: 66, note: '',
  });
});

test('storyEvents marks first appearances in page order', () => {
  const appears = storyEvents(book).filter((e) => e.kind === 'appear');
  assert.deepEqual(appears.map((e) => [e.who[0], e.page]), [
    ['mira', 1], ['tam', 1], ['corin', 20],
  ]);
});

test('storyEvents marks arrivals and exits', () => {
  const events = storyEvents(book);
  assert.ok(events.some((e) => e.kind === 'arrive' && e.who[0] === 'mira' && e.place === 'old-mill' && e.page === 32));
  assert.ok(events.some((e) => e.kind === 'exit' && e.who[0] === 'tam' && e.page === 66));
  assert.deepEqual(events.map((e) => e.page), [...events.map((e) => e.page)].sort((a, b) => a - b));
});

test('storyEvents finds the meetings the demo actually contains', () => {
  const meets = storyEvents(book).filter((e) => e.kind === 'meet');
  const summary = meets.map((e) => [e.place, e.page, [...e.who].sort().join('+')]);
  assert.deepEqual(summary, [
    ['harbor-town', 1, 'mira+tam'],    // they start together
    ['old-mill', 32, 'mira+tam'],      // and walk up together
    ['salt-marsh', 62, 'corin+tam'],   // corin comes back before tam vanishes
    ['old-mill', 88, 'corin+mira'],    // mira comes back down to where corin is
  ]);
});

test('a meeting is dated to the later of the two arrivals', () => {
  const b2 = makeBook([
    { who: 'a', page: 10, place: 'north' },
    { who: 'a', page: 50, place: 'north' },
    { who: 'b', page: 30, place: 'north' },
    { who: 'b', page: 60, place: 'north' },
  ]);
  const meets = storyEvents(b2).filter((e) => e.kind === 'meet');
  assert.equal(meets.length, 1);
  assert.equal(meets[0].page, 30);
});

test('stays at one place that do not overlap in time are not a meeting', () => {
  const b2 = makeBook([
    { who: 'a', page: 10, place: 'north' },
    { who: 'a', page: 20, place: 'north' },
    { who: 'a', page: 30, place: 'south' },
    { who: 'a', page: 40, place: 'south' },
    { who: 'b', page: 50, place: 'north' },
    { who: 'b', page: 60, place: 'east' },
  ]);
  assert.equal(storyEvents(b2).filter((e) => e.kind === 'meet').length, 0);
});

test('three characters in one place is one meeting, not three pairs', () => {
  const b3 = makeBook(
    [
      { who: ['a', 'b', 'c'], page: 20, place: 'north' },
      { who: ['a', 'b', 'c'], page: 50, place: 'north' },
    ],
    [
      { id: 'a', name: 'A', color: '#111111' },
      { id: 'b', name: 'B', color: '#222222' },
      { id: 'c', name: 'C', color: '#333333' },
    ],
  );
  const meets = storyEvents(b3).filter((e) => e.kind === 'meet');
  assert.equal(meets.length, 1);
  assert.equal(meets[0].who.length, 3);
});

test('a character with no waypoints yet does not crash anything', () => {
  const b2 = makeBook(
    [{ who: 'a', page: 10, place: 'north' }, { who: 'a', page: 50, place: 'south' }],
    [
      { id: 'a', name: 'A', color: '#111111' },
      { id: 'b', name: 'B (not written yet)', color: '#222222' },
    ],
  );
  assert.equal(find(positionsAt(b2, 30), 'b'), undefined);
  assert.deepEqual(trailUpTo(b2, 'b', 30), []);
  assert.deepEqual(presence(b2, 'b'), []);
  assert.ok(storyEvents(b2).length);
});

test('a character with a single waypoint stands there for the whole book', () => {
  const b2 = makeBook([{ who: 'a', page: 10, place: 'north' }], [
    { id: 'a', name: 'A', color: '#111111' },
  ]);
  assert.equal(find(positionsAt(b2, 5), 'a'), undefined);
  assert.equal(find(positionsAt(b2, 90), 'a').place, 'north');
  assert.deepEqual(presence(b2, 'a'), [{ place: 'north', from: 10, to: 100, note: '' }]);
});

// --- trail age banding -----------------------------------------------------

test('trail points are stamped with the page they were reached', () => {
  const b2 = makeBook([
    { who: 'a', page: 10, place: 'north' },
    { who: 'a', page: 30, place: 'south' },
  ]);
  const trail = trailUpTo(b2, 'a', 30);
  assert.equal(trail[0].page, 10);
  near(trail.at(-1).page, 30, 1e-6);
  for (let i = 1; i < trail.length; i++) {
    assert.ok(trail[i].page >= trail[i - 1].page - 1e-9, 'pages must not go backwards');
  }
});

test('bands cover the whole trail and butt together exactly', () => {
  const b2 = makeBook([
    { who: 'a', page: 0, place: 'north' },
    { who: 'a', page: 50, place: 'east' },
    { who: 'a', page: 100, place: 'south' },
  ], undefined, { pages: [0, 100] });

  const full = trailUpTo(b2, 'a', 100);
  const { cold, warm, hot } = bandTrails(b2, 'a', 100, 10, 40);

  near(cold[0].x, full[0].x);
  near(cold[0].y, full[0].y);
  near(cold.at(-1).x, warm[0].x, 1e-12);
  near(cold.at(-1).y, warm[0].y, 1e-12);
  near(warm.at(-1).x, hot[0].x, 1e-12);
  near(warm.at(-1).y, hot[0].y, 1e-12);
  near(hot.at(-1).x, full.at(-1).x, 1e-12);
  near(hot.at(-1).y, full.at(-1).y, 1e-12);

  const total = length(cold) + length(warm) + length(hot);
  near(total, length(full), 1e-9);
});

test('band boundaries land where the character actually was', () => {
  const b2 = makeBook([
    { who: 'a', page: 0, place: 'north' },
    { who: 'a', page: 100, place: 'south' },
  ], undefined, { pages: [0, 100] });
  const { hot } = bandTrails(b2, 'a', 100, 40, 70);
  // The hot band starts at the eased position for p.60, not the linear one.
  const wasThere = positionsAt(b2, 60).find((p) => p.who === 'a');
  near(hot[0].x, wasThere.x, 1e-9);
  near(hot[0].y, wasThere.y, 1e-9);
});

test('bands degrade gracefully for a short or empty trail', () => {
  const b2 = makeBook([{ who: 'a', page: 10, place: 'north' }], [
    { id: 'a', name: 'A', color: '#111111' },
  ]);
  const bands = bandTrails(b2, 'a', 20, 5, 15);
  assert.deepEqual(bands.cold, []);
  assert.deepEqual(bands.warm, []);
  assert.deepEqual(bandTrails(b2, 'a', 5, 5, 15).hot, []);
});

// --- leaving the map and coming back ---------------------------------------
//
// The demo fixture has no null gap and no unbracketed stop, which is why the
// sweep above went green over two real bugs. These fixtures cover the shapes a
// real dataset hits constantly: a character drops out of the narration, then
// reappears somewhere else.

const GAPPY = [
  ['A leaves and comes back', [
    { who: 'a', page: 10, place: 'north' },
    { who: 'a', page: 20, place: null },
    { who: 'a', page: 30, place: 'south' },
    { who: 'a', page: 40, place: 'north' },
  ]],
  ['A is off the map before ever appearing', [
    { who: 'a', page: 10, place: null },
    { who: 'a', page: 20, place: 'north' },
    { who: 'a', page: 40, place: 'south' },
  ]],
  ['A vanishes mid-journey and returns to the same place', [
    { who: 'a', page: 10, place: 'north' },
    { who: 'a', page: 20, place: null },
    { who: 'a', page: 30, place: 'north' },
    { who: 'a', page: 50, place: 'east' },
  ]],
  ['two gaps in a row', [
    { who: 'a', page: 10, place: 'north' },
    { who: 'a', page: 15, place: null },
    { who: 'a', page: 25, place: 'east' },
    { who: 'a', page: 30, place: null },
    { who: 'a', page: 45, place: 'south' },
  ]],
];

for (const [name, wps] of GAPPY) {
  test(`trail ends where the pin is, every page: ${name}`, () => {
    const b = makeBook(wps);
    for (let page = 1; page <= 100; page += 1) {
      const pin = find(positionsAt(b, page), 'a');
      if (!pin) continue;
      const trail = trailUpTo(b, 'a', page);
      assert.ok(trail.length, `p.${page}: pin but no trail`);
      near(trail.at(-1).x, pin.x, 1e-9);
      near(trail.at(-1).y, pin.y, 1e-9);
    }
  });

  test(`trail never shrinks: ${name}`, () => {
    const b = makeBook(wps);
    let prev = -1;
    for (let page = 1; page <= 100; page += 1) {
      const len = length(trailUpTo(b, 'a', page));
      assert.ok(len >= prev - 1e-9, `trail shrank at p.${page}: ${len} < ${prev}`);
      prev = len;
    }
  });

  test(`bands cover the trail exactly, every page: ${name}`, () => {
    const b = makeBook(wps);
    for (let page = 1; page <= 100; page += 1) {
      const full = length(trailUpTo(b, 'a', page));
      const bands = bandTrails(b, 'a', page, 4, 20);
      const sum = length(bands.cold) + length(bands.warm) + length(bands.hot);
      near(sum, full, 1e-9);
    }
  });
}

test('a trail keeps the excursion a character made before vanishing', () => {
  const b = makeBook(GAPPY[0][1]);
  // south is the far side of the map; they walked there between p.30 and p.40.
  const trail = trailUpTo(b, 'a', 40);
  assert.ok(trail.some((p) => Math.abs(p.y - 0.8) < 1e-9), 'the visit to south vanished');
});

test('the first point after a gap is marked, so the renderer can break the line', () => {
  const b = makeBook(GAPPY[0][1]);
  const trail = trailUpTo(b, 'a', 40);
  const gaps = trail.filter((p) => p.gap);
  assert.equal(gaps.length, 1, 'expected exactly one break');
  near(gaps[0].y, 0.8, 1e-9);            // they reappeared at south
  assert.ok(!trail[0].gap, 'the first point of a trail is not a break');
});

test('returning to the place you left draws no break', () => {
  const b = makeBook(GAPPY[2][1]);       // north -> null -> north -> east
  const trail = trailUpTo(b, 'a', 50);
  assert.deepEqual(trail.filter((p) => p.gap), [], 'no discontinuity to draw');
});

test('a character who starts off the map still earns a trail once they appear', () => {
  const b = makeBook(GAPPY[1][1]);
  assert.ok(trailUpTo(b, 'a', 40).length >= 2, 'no trail after they appeared');
});

// --- the held-in-place rule ------------------------------------------------

test('a pin is not stale on the page its last waypoint asserts', () => {
  const b = makeBook([
    { who: 'a', page: 10, place: 'north' },
    { who: 'a', page: 60, place: 'south' },
  ]);
  assert.equal(find(positionsAt(b, 59), 'a').done, false);
  assert.equal(find(positionsAt(b, 60), 'a').done, false, 'p.60 is what the book says');
  assert.equal(find(positionsAt(b, 61), 'a').done, true, 'p.61 is the app holding them');
});

test('an unbracketed arrival reads as being at the place, not mid-journey', () => {
  const b = makeBook([
    { who: 'a', page: 10, place: 'north' },
    { who: 'a', page: 30, place: 'south' },
    { who: 'a', page: 50, place: 'east' },
  ]);
  const pin = find(positionsAt(b, 30), 'a');
  assert.equal(pin.state, 'at');
  assert.equal(pin.place, 'south');
});

test('a leading null waypoint is not announced as an exit', () => {
  const b = makeBook(GAPPY[1][1]);
  const exits = storyEvents(b).filter((e) => e.kind === 'exit');
  assert.deepEqual(exits, [], 'they were never on the map to leave it');
});

test('positionsAt passes a crowding radius through to dodge', () => {
  // Two places a hair apart: pins that would overlap on screen but are not on
  // the same spot. Without a radius they must not fan; with one they must.
  const b = parseBook({
    title: 'near', map: { aspect: 1 }, pages: [1, 100], bow: 0,
    places: {
      here:  { name: 'Here',  x: 0.500, y: 0.500 },
      there: { name: 'There', x: 0.502, y: 0.500 },
    },
    characters: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    chapters: [{ n: 1, startPage: 1 }],
    waypoints: [
      { who: 'a', page: 1, place: 'here' },  { who: 'a', page: 90, place: 'here' },
      { who: 'b', page: 1, place: 'there' }, { who: 'b', page: 90, place: 'there' },
    ],
  }).book;

  assert.deepEqual(positionsAt(b, 50).map((p) => p.crowd), [1, 1]);
  assert.deepEqual(positionsAt(b, 50, 0.01).map((p) => p.crowd), [2, 2]);
  assert.ok(positionsAt(b, 50, 0.01).every((p) => p.off), 'both should get an offset');
});
