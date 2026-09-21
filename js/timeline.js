// Turning a book plus a page number into things to draw.
//
// Pure: no DOM, no clock, no randomness. `positionsAt` is called on every
// frame during playback, so it stays allocation-light and does no sorting —
// parseBook already sorted the waypoints.

import { pointAt, clip, dodge, headingAt } from './geometry.js';
import { polylineFor } from './book.js';

/**
 * Eases the fraction of a journey that has elapsed. A traveller leaves a town
 * slowly and arrives slowly; constant velocity between two points reads as a
 * conveyor belt. Both `positionsAt` and `trailUpTo` must apply this or the
 * trail head detaches from the pin it belongs to.
 */
export const legEase = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(Math.max(t, 0), 1));

/**
 * Where everyone is on `page`, in square map space.
 *
 * A character is absent before their first waypoint and after a waypoint with
 * a null place (they left the map). After their last waypoint they hold
 * position — the book ended, they did not.
 *
 * Crowded pins come back with a unit-circle `off` and a `crowd` count; the
 * renderer decides how far apart to draw them in pixels.
 *
 * `dodgeR` is how close two pins must be, in square map space, before they are
 * treated as crowding each other. It belongs to the caller because "too close
 * to read" is a number of pixels, and only the renderer knows what a pixel is
 * worth at the current zoom. Omitted, only pins on the same spot fan out.
 */
export function positionsAt(book, page, dodgeR) {
  const pins = [];

  for (const ch of book.characters) {
    const wps = book.byCharacter[ch.id];
    if (!wps || !wps.length) continue;
    if (page < wps[0].page) continue;                       // not on stage yet

    const last = wps[wps.length - 1];
    if (page >= last.page) {
      if (!last.place) continue;                            // left the map for good
      const p = book.places[last.place];
      // `done` fades the pin, because holding someone in place is the app's
      // rule rather than something the book said. On the last waypoint's own
      // page the book *does* say it, so that page is not faded.
      pins.push(rest(ch, p, last, page > last.page));
      continue;
    }

    let i = 0;
    while (i < wps.length - 1 && wps[i + 1].page <= page) i++;
    const a = wps[i];
    const b = wps[i + 1];

    if (!a.place) continue;                                 // off the map for this stretch

    // The page a waypoint names is a fact about where they are, so it reads as
    // 'at' even when the next waypoint moves them on. Without this an
    // unbracketed arrival spends its own page in state 'moving' with a null
    // place, and the renderer never marks the town as occupied.
    if (page === a.page) { pins.push(rest(ch, book.places[a.place], a, false)); continue; }

    // Sitting still: either bracketed by two waypoints at the same place, or
    // waiting at `a` until the page they vanish.
    if (!b.place || a.place === b.place) {
      const p = book.places[a.place];
      pins.push(rest(ch, p, a, false));
      continue;
    }

    const span = b.page - a.page;
    const t = legEase(span > 0 ? (page - a.page) / span : 1);
    const line = polylineFor(book, a.place, b.place, ch.id);
    const pt = pointAt(line, t);
    const dir = headingAt(line, t);
    pins.push({
      who: ch.id,
      name: ch.name,
      short: ch.short,
      color: ch.color,
      x: pt.x,
      y: pt.y,
      state: 'moving',
      place: null,
      from: a.place,
      to: b.place,
      progress: t,
      inferred: line.inferred,
      speed: span > 0 ? distance(line) / span : 0,
      heading: dir,
      note: '',
      party: null,
      done: false,
    });
  }

  return dodge(pins, dodgeR);
}

function rest(ch, p, wp, done) {
  return {
    who: ch.id,
    name: ch.name,
    short: ch.short,
    color: ch.color,
    x: p.x,
    y: p.y,
    state: 'at',
    place: wp.place,
    from: wp.place,
    to: wp.place,
    progress: 1,
    heading: null,
    note: wp.note || '',
    party: wp.party,
    done,                    // past their last waypoint: the book left them here
  };
}

/**
 * Everywhere `who` has been up to `page`, as a polyline. Never runs ahead of
 * the page: the final point is exactly where their pin is.
 */
export function trailUpTo(book, who, page) {
  const wps = book.byCharacter[who];
  if (!wps || !wps.length || page < wps[0].page) return [];

  const out = [];
  // A character who drops out of the narration and comes back has walked no
  // line between the two. The next point is flagged so the renderer lifts the
  // pen there instead of drawing a journey the book never described.
  let gapPending = false;
  const push = (p, pg, inferred = false) => {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - p.x) <= 1e-9 && Math.abs(prev.y - p.y) <= 1e-9) {
      gapPending = false;              // came back to where they left: nothing to break
      return;
    }
    const pt = { x: p.x, y: p.y, page: pg, inferred };
    if (gapPending) pt.gap = true;
    out.push(pt);
    gapPending = false;
  };

  for (let i = 0; i < wps.length; i++) {
    const a = wps[i];
    if (page < a.page) break;
    if (!a.place) { if (out.length) gapPending = true; continue; }

    // Anchor every leg at its own start. Relying on the previous leg to have
    // ended here is what lost the re-entry vertex across a gap.
    push(book.places[a.place], a.page);

    const b = wps[i + 1];
    if (!b || page <= a.page) break;
    if (!b.place || a.place === b.place) continue;

    const line = polylineFor(book, a.place, b.place, who);
    const span = b.page - a.page;
    const part = page >= b.page ? line : clip(line, legEase(span > 0 ? (page - a.page) / span : 1));

    // Stamp each point with the page it was reached, so the renderer can fade
    // the trail by age. Arc fraction maps back to a page through the inverse
    // of legEase, which is what put the point there in the first place.
    const whole = arcLength(line);
    let acc = 0;
    for (let k = 1; k < part.length; k++) {
      acc += Math.hypot(part[k].x - part[k - 1].x, part[k].y - part[k - 1].y);
      const f = whole > 0 ? acc / whole : 1;
      push(part[k], a.page + span * unease(f), line.inferred);
    }
    if (page < b.page) break;
  }
  return out;
}

const unease = (f) => Math.acos(1 - 2 * Math.min(Math.max(f, 0), 1)) / Math.PI;

function arcLength(line) {
  let d = 0;
  for (let i = 1; i < line.length; i++) {
    d += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
  }
  return d;
}

/**
 * A trail split into three age bands, so the renderer can draw where someone
 * has just been more brightly than where they were two hundred pages ago.
 *
 * The split is exact rather than interpolated. A trail at an earlier page is a
 * prefix of the trail at a later one — same vertices, different final point —
 * so asking for the trail at each boundary page and taking the difference
 * gives bands that butt together on the pixel, easing and bent routes
 * included. Slicing by page stamps instead would ignore the leg easing and put
 * the boundaries in visibly the wrong place.
 */
export function bandTrails(book, who, page, hotPages, warmPages) {
  const full = trailUpTo(book, who, page);
  if (full.length < 2) return { cold: [], warm: [], hot: full.length ? full : [] };

  const cold = trailUpTo(book, who, page - warmPages);
  const warmFull = trailUpTo(book, who, page - hotPages);

  const warm = warmFull.length > 1 && cold.length > 1
    ? [cold.at(-1), ...warmFull.slice(cold.length - 1)]
    : warmFull;
  const hot = warmFull.length > 1
    ? [warmFull.at(-1), ...full.slice(warmFull.length - 1)]
    : full;

  return {
    cold: cold.length > 1 ? cold : [],
    warm: warm.length > 1 ? warm : [],
    hot: hot.length > 1 ? hot : [],
  };
}

/**
 * The stretches during which a character is sitting at a named place, as
 * [{place, from, to}] in page order. A maximal run of waypoints at the same
 * place is one stretch; `from` is the page they arrive, `to` the page they
 * leave. Used for meeting detection and for the "who was here" popover.
 */
export function presence(book, who) {
  const wps = book.byCharacter[who] || [];
  const out = [];
  let i = 0;
  while (i < wps.length) {
    if (!wps[i].place) { i++; continue; }
    let j = i;
    while (j + 1 < wps.length && wps[j + 1].place === wps[i].place) j++;

    // When they stop being there has to match what positionsAt draws, or
    // someone who stood in the same room for fifty pages never counts as
    // having met anyone.
    const next = wps[j + 1];
    let to = wps[j].page;
    if (!next) to = Math.max(to, book.pages[1]);   // held there to the last page
    else if (!next.place) to = next.page;          // sits here until they vanish

    out.push({ place: wps[i].place, from: wps[i].page, to, note: wps[i].note });
    i = j + 1;
  }
  return out;
}

/**
 * Moments worth noticing, in page order:
 *   appear  — a character's first time on the map
 *   arrive  — a character reaches a place they were not at
 *   exit    — a character leaves the map
 *   meet    — two or more characters are at the same place at the same time
 *
 * Computed once per book, not per frame.
 */
export function storyEvents(book) {
  const events = [];
  const stays = {};

  for (const ch of book.characters) {
    const list = presence(book, ch.id);
    stays[ch.id] = list;
    list.forEach((s, idx) => {
      events.push({
        kind: idx === 0 ? 'appear' : 'arrive',
        page: s.from,
        who: [ch.id],
        place: s.place,
      });
    });
    let onStage = false;
    for (const w of book.byCharacter[ch.id] || []) {
      if (w.place) { onStage = true; continue; }
      // A null before their first place is padding in the data, not an exit —
      // you cannot leave a map you were never on.
      if (onStage) events.push({ kind: 'exit', page: w.page, who: [ch.id], place: null, note: w.note });
      onStage = false;
    }
  }

  // Meetings: overlapping stays at the same place, keyed so that three people
  // in one room is one event rather than three pairs.
  const meets = new Map();
  const ids = book.characters.map((c) => c.id);
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      for (const sa of stays[ids[a]]) {
        for (const sb of stays[ids[b]]) {
          if (sa.place !== sb.place) continue;
          if (sa.from > sb.to || sb.from > sa.to) continue;
          const page = Math.max(sa.from, sb.from);
          const key = `${sa.place}@${page}`;
          const set = meets.get(key) || { kind: 'meet', page, place: sa.place, who: new Set() };
          set.who.add(ids[a]);
          set.who.add(ids[b]);
          meets.set(key, set);
        }
      }
    }
  }
  for (const m of meets.values()) {
    events.push({ kind: 'meet', page: m.page, place: m.place, who: [...m.who] });
  }

  const rank = { appear: 0, arrive: 1, meet: 2, exit: 3 };
  events.sort((x, y) => x.page - y.page || rank[x.kind] - rank[y.kind]);
  return events;
}

/**
 * The bounding box, in square map space, of every place anyone has actually
 * been at or before `upTo`. This is the part of the map the story is using —
 * for a book whose action sits in one corner of a continent-wide map, it is a
 * small fraction of the image, and framing it is the difference between a
 * legible map and a smudge.
 *
 * Only visited places count. The file may list somewhere nobody reaches for
 * three hundred pages, and drawing the camera out to include it would frame
 * emptiness — and, for a reader part-way through, would quietly reveal how far
 * the story is going to travel.
 */
export function visitedBox(book, upTo = Infinity) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  let n = 0;
  for (const w of book.waypoints) {
    if (!w.place || w.page > upTo) continue;
    const p = book.places[w.place];
    if (!p) continue;
    n++;
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return n ? { x0, y0, x1, y1, n } : null;
}

function distance(line) {
  let d = 0;
  for (let i = 1; i < line.length; i++) {
    d += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
  }
  return d;
}
