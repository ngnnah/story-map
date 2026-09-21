// Wiring: loads a book, drives the clock, draws the bottom bar, and routes
// input. The map itself lives in view.js; all the storytelling maths lives in
// the pure modules and is tested there.

import { parseBook, chapterAt } from './book.js';
import { positionsAt, presence, storyEvents, visitedBox } from './timeline.js';
import { Clock, clamp } from './clock.js';
import { View } from './view.js';
import { putImage, getImage, pref, setPref } from './store.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

const BOOKS = [
  { file: 'data/shannara.json', label: 'The Sword of Shannara' },
  { file: 'data/demo-island.json', label: 'The Salt Road (demo)' },
];
const SPEEDS = [0.25, 0.5, 1, 2, 4];

// A book is measured in pages or in chapters, and the difference shows up in
// every readout, every keyboard step and every threshold that was tuned when
// one unit meant one page. `book.axis` decides; nothing else guesses.
const onChapters = () => book?.axis === 'chapter';
/** One arrow-key step: a page, or a tenth of a chapter. */
const unitStep = () => (onChapters() ? 0.1 : 1);
/** How a position reads to the reader. */
const posLabel = (v) => (onChapters()
  ? `Ch. ${Math.floor(v)} · ${Math.round((v - Math.floor(v)) * 100)}%`
  : `p. ${Math.round(v)}`);
const LOUD = new Set(['meet', 'appear', 'exit']);

const view = new View($('world-svg'), $('chips'));
let book = null;
let clock = null;
let events = [];
let loudEvents = [];
let hidden = new Set();
let objectUrl = null;
let laneOn = pref('lanes', true);
let scrimStep = pref('scrim', 1);
let announceQueue = [];
let lastAnnounce = -1e9;
const firedThisPass = new Set();

// --------------------------------------------------------------- loading

async function loadBook(raw, { imageBlob } = {}) {
  const { book: parsed, problems } = parseBook(raw);
  if (!parsed) { showProblems(problems); return; }

  book = parsed;
  view.hidden = hidden = new Set(pref(`hidden:${book.id}`, []));
  view.setBook(book);
  events = storyEvents(book);
  loudEvents = events.filter((e) => LOUD.has(e.kind));

  clock?.pause();
  clock ??= new Clock({ min: book.pages[0], max: book.pages[1], onFrame: frame, axis: book.axis });
  clock.setRange(book.pages[0], book.pages[1], book.axis);
  clock.setLoudPages(loudEvents.map((e) => e.page));
  // A position saved on one axis means nothing on the other: a stored 340 read
  // as a chapter clamps to the end of the book, which for a read-along book is
  // the worst possible thing to open on.
  const saved = pref(`page:${book.id}`, null);
  clock.seek(saved && saved.axis === book.axis && isFinite(saved.at) ? saved.at : book.pages[0]);
  // Point the camera at the part of the map this story uses, now that we know
  // how far in the reader is.
  view.noteAction(visitedBox(book, clock.target));
  view.frameAction();

  showProblems(problems);
  buildRoster();
  buildChapters();
  buildLanes();
  buildGutter();
  $('page-of').textContent = onChapters() ? '' : `/ ${book.pages[1]}`;
  $('rail').setAttribute('aria-valuemin', book.pages[0]);
  $('rail').setAttribute('aria-valuemax', book.pages[1]);

  // A book may ship its own map; otherwise look for one this browser saved,
  // and fall back to the first-run card.
  if (imageBlob) await useImageBlob(imageBlob);
  else if (book.map.file) { view.setImageHref(book.map.file); $('card').hidden = true; }
  else {
    const saved = await getImage(book.id);
    if (saved) await useImageBlob(saved);
    else { view.setImageHref(null); $('card').hidden = false; }
  }
}

async function useImageBlob(blob) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  view.setImageHref(objectUrl);
  $('card').hidden = true;
  if (book) await putImage(book.id, blob).catch(() => {});

  // Warn rather than silently misplacing everyone: coordinates belong to the
  // scan they were picked on.
  const probe = new Image();
  probe.onload = () => {
    const got = probe.naturalHeight / probe.naturalWidth;
    if (Math.abs(got - book.map.aspect) / book.map.aspect > 0.02) {
      showProblems([
        `This image is ${got.toFixed(3)} tall for its width, but the book's `
        + `coordinates were picked on one that is ${book.map.aspect.toFixed(3)}. `
        + `Places will sit slightly wrong. Re-pick them with dev-coords.html.`,
      ], true);
    }
  };
  probe.src = objectUrl;
}

function showProblems(list, append = false) {
  const box = $('problems');
  const ul = $('problem-list');
  if (!append) ul.replaceChildren();
  for (const p of list) {
    const li = document.createElement('li');
    li.textContent = p;
    ul.append(li);
  }
  const n = ul.childElementCount;
  box.hidden = n === 0;
  $('problem-count').textContent = `⚠ ${n} note${n === 1 ? '' : 's'} about this book`;
}

// ------------------------------------------------------------- the frame

function frame(page, prev, dt) {
  // Widen the remembered region as the reader goes. This does not move the
  // camera — frameAction does, and only on an explicit trigger.
  view.noteAction(visitedBox(book, page));
  const pins = view.render(page, dt);
  drawRail(page);
  drawRoster(page, pins);
  announce(page, prev);
  drainAnnounce();
}

// ------------------------------------------------------------- the readout

// The roster is built once per book and mutated per frame. It used to be
// rebuilt with replaceChildren() on every frame, which meant mousedown and
// mouseup landed on different node instances and the browser never fired a
// click at all — so neither picking a character nor alt-clicking to hide one
// had ever worked. Rows also stay in declaration order: re-sorting by state on
// every frame made the list reshuffle under the cursor while scrubbing.
let rosterNodes = new Map();

function buildRoster() {
  rosterNodes = new Map();
  const frag = document.createDocumentFragment();
  for (const c of book.characters) {
    const row = document.createElement('div');
    row.className = 'who';
    row.style.color = c.color;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = c.color;

    const name = document.createElement('span');
    name.className = 'name';
    name.style.color = 'var(--text)';
    name.textContent = c.name;

    const where = document.createElement('span');
    where.className = 'where';
    const whereText = document.createTextNode('');
    const bar = document.createElement('span');
    bar.className = 'bar';
    const barFill = document.createElement('i');
    bar.append(barFill);
    where.append(whereText, bar);

    const note = document.createElement('span');
    note.className = 'note';

    row.append(sw, name, where, note);
    row.addEventListener('pointerenter', () => { view.hover = c.id; });
    row.addEventListener('pointerleave', () => { if (view.hover === c.id) view.hover = null; });
    const pick = (e) => { if (e.altKey) toggleHidden(c.id); else pickCharacter(c.id); };
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      // The window handler maps Space to play/pause and only bails for form
      // fields, so without this Space would both focus the character and
      // start playback.
      e.stopPropagation();
      pick(e);
    });
    frag.append(row);
    rosterNodes.set(c.id, { row, name, whereText, bar, barFill, note });
  }
  $('roster').replaceChildren(frag);
}

function drawRoster(page, pins) {
  const chapter = chapterAt(book, page);
  $('page-label').textContent = onChapters()
    ? posLabel(page)
    : `p. ${Math.round(page)} / ${book.pages[1]}`;
  $('page-now').textContent = onChapters() ? posLabel(page) : Math.round(page);
  $('chapter-label').textContent = chapter
    ? `Ch. ${chapter.n}${chapter.title ? ` \u00b7 ${chapter.title}` : ''}` : '';

  const byWho = new Map(pins.map((p) => [p.who, p]));
  for (const c of book.characters) {
    const n = rosterNodes.get(c.id);
    if (!n) continue;
    const p = byWho.get(c.id);
    n.row.classList.toggle('focused', view.focus === c.id);
    n.row.classList.toggle('gone', !p);
    n.name.style.opacity = hidden.has(c.id) ? 0.4 : '';

    if (!p) {
      n.whereText.nodeValue = pastTense(c.id, page);
      n.bar.style.display = 'none';
    } else if (p.state === 'moving') {
      n.whereText.nodeValue = `\u2192 ${book.places[p.to].name}`;
      n.bar.style.display = '';
      n.barFill.style.width = `${Math.round(p.progress * 100)}%`;
    } else {
      const stay = presence(book, c.id).find((s) => s.place === p.place && s.from <= page && page <= s.to);
      n.whereText.nodeValue = `@ ${book.places[p.place].name}${stay ? `  p.${stay.from}\u2013` : ''}`;
      n.bar.style.display = 'none';
    }

    n.note.textContent = p?.note || '';
    n.note.style.display = p?.note ? '' : 'none';
  }
}

function pastTense(who, page) {
  const wps = book.byCharacter[who] || [];
  if (!wps.length || page < wps[0].page) return 'not yet';
  const exit = wps.find((w) => !w.place && w.page <= page);
  return exit ? `left, p.${exit.page}` : '—';
}

// -------------------------------------------------------------- the bar

function buildChapters() {
  const host = $('chapters');
  host.replaceChildren();
  const span = book.pages[1] - book.pages[0];
  book.chapters.forEach((c, i) => {
    const next = book.chapters[i + 1];
    const w = ((next ? next.start : book.pages[1]) - c.start) / span;
    const d = document.createElement('div');
    d.className = 'chap';
    d.style.flexBasis = `${w * 100}%`;
    d.dataset.n = c.n;
    const at = c.startPage === null ? '' : ` (p.${c.startPage})`;
    d.title = c.title ? `Ch. ${c.n} · ${c.title}${at}` : `Ch. ${c.n}${at}`;
    // Chapter cells were click-only. The window keydown handler maps Space to
    // play/pause, so activating one has to stop the event travelling.
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.setAttribute('aria-label', c.title ? `Chapter ${c.n}, ${c.title}` : `Chapter ${c.n}`);
    d.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      clock.jumpTo(c.start);
    });
    const num = document.createElement('span');
    num.textContent = c.n;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = c.title;
    d.append(num, t);
    d.addEventListener('click', () => clock.jumpTo(c.start));
    host.append(d);
  });
}

/**
 * One 3px row per character across the whole book: solid where they are
 * somewhere, thin where they are travelling, nothing before they appear.
 * Convergences show up as visual knots, so the shape of the story is legible
 * as one 40px graphic before you touch the slider.
 */
function buildLanes() {
  const svg = $('lanes');
  svg.replaceChildren();
  svg.style.display = laneOn ? '' : 'none';
  if (!laneOn) return;

  const n = book.characters.length;
  const rowH = 5;
  const H = n * rowH;
  svg.setAttribute('viewBox', `0 0 1000 ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.height = `${Math.min(H * 1.4, 44)}px`;

  const span = book.pages[1] - book.pages[0];
  const X = (p) => ((p - book.pages[0]) / span) * 1000;

  book.characters.forEach((c, i) => {
    const y = i * rowH + rowH / 2;
    const wps = book.byCharacter[c.id] || [];
    if (!wps.length) return;

    // Travelling: the thin line between first and last waypoint.
    svg.append(el('line', {
      class: 'lane-move', x1: X(wps[0].page), x2: X(wps.at(-1).page), y1: y, y2: y,
      stroke: c.color, 'stroke-width': 1,
    }));

    for (const s of presence(book, c.id)) {
      // Anything past the last authored waypoint is the "holds position" rule
      // extrapolating, not something the book said. Draw it faint so a
      // half-written dataset does not masquerade as a finished one.
      const solidTo = Math.min(s.to, wps.at(-1).page);
      if (solidTo > s.from) {
        svg.append(el('line', {
          class: 'lane-stay', x1: X(s.from), x2: X(solidTo), y1: y, y2: y,
          stroke: c.color, 'stroke-width': 3, opacity: 0.9,
        }));
      }
      if (s.to > solidTo) {
        svg.append(el('line', {
          class: 'lane-stay', x1: X(solidTo), x2: X(s.to), y1: y, y2: y,
          stroke: c.color, 'stroke-width': 3, opacity: 0.18,
        }));
      }
    }
  });

  // Co-presence bridges, taken straight from the meetings the model already
  // found — one hairline per meeting rather than one per sampled page.
  for (const e of events) {
    if (e.kind !== 'meet') continue;
    const lanes = e.who.map((w) => book.charIndex[w]).filter((n) => n !== undefined).sort((a, b) => a - b);
    if (lanes.length < 2) continue;
    svg.append(el('line', {
      class: 'bridge', x1: X(e.page), x2: X(e.page),
      y1: lanes[0] * rowH + rowH / 2, y2: lanes.at(-1) * rowH + rowH / 2,
    }));
  }

  const head = el('line', { class: 'playhead', y1: 0, y2: H });
  head.id = 'lane-head';
  svg.append(head);

  book.characters.forEach((c, i) => {
    const hit = el('rect', { class: 'lane-row', x: 0, y: i * rowH, width: 1000, height: rowH });
    hit.addEventListener('pointerenter', () => { view.hover = c.id; });
    hit.addEventListener('pointerleave', () => { if (view.hover === c.id) view.hover = null; });
    hit.addEventListener('click', () => pickCharacter(c.id));
    svg.append(hit);
  });
}

function buildGutter() {
  const svg = $('gutter');
  svg.replaceChildren();
  svg.setAttribute('viewBox', '0 0 1000 14');
  svg.setAttribute('preserveAspectRatio', 'none');
  const span = book.pages[1] - book.pages[0];
  const X = (p) => ((p - book.pages[0]) / span) * 1000;

  // Bucket into 3px bins: a bin with more than one event draws a single tick
  // with a cap above it, rather than a jittering pile.
  const bins = new Map();
  for (const e of events) {
    const b = Math.round(X(e.page) / 3);
    (bins.get(b) ?? bins.set(b, []).get(b)).push(e);
  }
  view.tickNodes = new Map();
  for (const [b, list] of bins) {
    const loud = list.filter((e) => LOUD.has(e.kind));
    const lead = loud[0] ?? list[0];
    const h = lead.kind === 'meet' ? 7 : LOUD.has(lead.kind) ? 5 : 3;
    const color = lead.kind === 'meet' ? '#E7ECF3'
      : (book.characters.find((c) => c.id === lead.who[0])?.color ?? '#E7ECF3');
    const op = lead.kind === 'meet' ? 0.75 : LOUD.has(lead.kind) ? 0.80 : 0.22;
    const x = b * 3;
    const t = el('line', {
      class: 'tick', x1: x, x2: x, y1: 14, y2: 14 - h, stroke: color, opacity: op,
    });
    svg.append(t);
    if (list.length > 1) {
      svg.append(el('line', {
        class: 'cluster-cap', x1: x - 1.5, x2: x + 1.5,
        y1: 14 - h - 2, y2: 14 - h - 2, stroke: color, opacity: op,
      }));
    }
    for (const e of list) view.tickNodes.set(e, t);
  }
}

function drawRail(page) {
  const span = book.pages[1] - book.pages[0];
  const pct = ((page - book.pages[0]) / span) * 100;
  $('rail').querySelector('.fill').style.width = `${pct}%`;
  $('rail').querySelector('.thumb').style.left = `${pct}%`;
  $('rail').setAttribute('aria-valuenow', Math.round(page));
  const ch = chapterAt(book, page);
  $('rail').setAttribute('aria-valuetext',
    `page ${Math.round(page)}${ch ? `, chapter ${ch.n}${ch.title ? `, ${ch.title}` : ''}` : ''}`);

  const head = $('lane-head');
  if (head) { head.setAttribute('x1', pct * 10); head.setAttribute('x2', pct * 10); }

  for (const d of $('chapters').children) {
    const on = ch && +d.dataset.n === ch.n;
    d.classList.toggle('current', !!on);
    if (on) {
      const i = book.chapters.findIndex((c) => c.n === ch.n);
      const next = book.chapters[i + 1];
      const end = next ? next.start : book.pages[1];
      d.style.setProperty('--pct', `${((page - ch.start) / (end - ch.start)) * 100}%`);
    }
  }
}

// ------------------------------------------------------- announcing events

/**
 * The whole problem with events is noise. Four rules keep them from
 * machine-gunning: nothing fires scrubbing backwards, nothing fires on a
 * jump, one at a time 900ms apart, and at high speed the map shows rings
 * without labels nobody could read anyway.
 */
function announce(page, prev) {
  if (page <= prev) { firedThisPass.clear(); return; }
  // Far enough that the reader scrubbed rather than read. Eight pages, or
  // a third of a chapter — without the unit this never fired on the chapter
  // axis and every scrub machine-gunned announcements for all it flew past.
  const jumped = page - prev > (onChapters() ? 0.33 : 8);
  for (const e of events) {
    if (e.page <= prev || e.page > page) continue;
    pulseTick(e);
    if (jumped || !LOUD.has(e.kind)) continue;
    if (clock.speed >= 4 && e.kind !== 'meet') continue;
    announceQueue.push({ e, at: performance.now() });
  }
}

function pulseTick(e) {
  const t = view.tickNodes?.get(e);
  if (!t) return;
  t.classList.remove('pulsing');
  void t.getBBox();
  t.classList.add('pulsing');
  setTimeout(() => t.classList.remove('pulsing'), 600);
}

function drainAnnounce() {
  const now = performance.now();
  while (announceQueue.length && now - announceQueue[0].at > 2500) announceQueue.shift();
  if (!announceQueue.length || now - lastAnnounce < 900) return;
  const { e } = announceQueue.shift();
  lastAnnounce = now;

  const colors = e.who.map((w) => book.characters.find((c) => c.id === w)?.color ?? '#fff');
  const place = e.place ? book.places[e.place] : null;
  const loud = clock.speed < 4;

  if (e.kind === 'exit') {
    // The crosshatch is drawn from the data in view.render; this is only the
    // chip that says it as it happens.
    const last = (view.lastPins || []).find((p) => p.who === e.who[0]) ?? lastKnown(e.who[0]);
    if (last && loud) view.chip(last.x, last.y, `${shortOf(e.who[0])} leaves`, colors, 1200);
    say(`${nameOf(e.who[0])} leaves the map`);
    return;
  }

  if (!place) return;
  view.ring(place.x, place.y, e.kind === 'meet' ? '#E7ECF3' : colors[0]);
  for (const w of e.who) view.nudge(w);
  if (!loud) return;

  const text = e.kind === 'meet'
    ? `${listOf(e.who)} at ${place.name}`
    : `${shortOf(e.who[0])} — ${place.name}`;
  view.chip(place.x, place.y, text, colors, clamp(1400 / clock.speed, 500, 1400));
  say(e.kind === 'meet'
    ? `${listOf(e.who.map(nameOf))} meet at ${place.name}`
    : `${nameOf(e.who[0])} reaches ${place.name}`);
}

/**
 * The same sentence the chip shows, for a screen reader. The chips are drawn
 * over the map and the readout rebuilds constantly, so neither can carry this.
 */
function say(text) {
  const n = $('announcer');
  if (n) n.textContent = text;
}

const charOf = (id) => book.characters.find((c) => c.id === id);
const nameOf = (id) => charOf(id)?.name ?? id;
const shortOf = (id) => charOf(id)?.short ?? id;

function listOf(ids) {
  const names = ids.map((x) => (charOf(x) ? shortOf(x) : x));
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function lastKnown(who) {
  const wps = book.byCharacter[who] || [];
  for (let i = wps.length - 1; i >= 0; i--) {
    if (wps[i].place) {
      const p = book.places[wps[i].place];
      const c = book.characters.find((x) => x.id === who);
      return { x: p.x, y: p.y, heading: null, color: c?.color };
    }
  }
  return null;
}

// -------------------------------------------------------------- selection

function pickCharacter(id) {
  view.focus = view.focus === id ? null : id;
  if (!view.focus) view.following = null;
}

function toggleHidden(id) {
  hidden.has(id) ? hidden.delete(id) : hidden.add(id);
  view.hidden = hidden;
  setPref(`hidden:${book.id}`, [...hidden]);
}

// ------------------------------------------------------------------ input

function railPage(clientX) {
  const r = $('rail').getBoundingClientRect();
  const f = clamp((clientX - r.left) / r.width, 0, 1);
  return book.pages[0] + f * (book.pages[1] - book.pages[0]);
}

const rail = $('rail');
let railDrag = false;
rail.addEventListener('pointerdown', (e) => {
  railDrag = true;
  rail.classList.add('dragging');
  rail.setPointerCapture(e.pointerId);
  clock.pause();
  clock.seek(railPage(e.clientX), 'drag');
});
rail.addEventListener('pointermove', (e) => {
  if (railDrag) clock.seek(railPage(e.clientX), 'drag');
  else showPopover(e.clientX);
});
rail.addEventListener('pointerleave', hidePopover);
addEventListener('pointerup', (e) => {
  if (!railDrag) return;
  railDrag = false;
  rail.classList.remove('dragging');
  clock.settle({ snapToEvents: !e.altKey });
});

// map: drag to pan, wheel to zoom at the cursor
const viewport = $('viewport');
let pan = null;
viewport.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#readout, #card, #pop')) return;
  // `onPin` is read from the pointerdown target. Once the pointer is captured
  // the pointerup target is #viewport, so asking there always said "empty map"
  // and every click on a pin cleared the focus instead of setting it.
  pan = { x: e.clientX, y: e.clientY, moved: false, onPin: !!e.target.closest('.pin') };
  viewport.classList.add('grabbing');
});
viewport.addEventListener('pointermove', (e) => {
  if (!pan) return;
  view.panBy(e.clientX - pan.x, e.clientY - pan.y);
  if (Math.hypot(e.clientX - pan.x, e.clientY - pan.y) > 3) {
    // Capture only once this is a drag. Taking it on pointerdown would
    // retarget the click that a plain tap still needs to deliver.
    if (!pan.moved) { pan.moved = true; try { viewport.setPointerCapture(e.pointerId); } catch { /* not ours */ } }
  }
  pan.x = e.clientX;
  pan.y = e.clientY;
});
const endPan = (e) => {
  viewport.classList.remove('grabbing');
  if (pan && !pan.moved && !pan.onPin) { view.focus = null; view.following = null; }
  if (pan?.moved) { try { viewport.releasePointerCapture(e.pointerId); } catch { /* already gone */ } }
  pan = null;
};
viewport.addEventListener('pointerup', endPan);
// A cancelled gesture used to leave `pan` truthy, so the map kept panning with
// no button held.
viewport.addEventListener('pointercancel', endPan);
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  view.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
}, { passive: false });
viewport.addEventListener('dblclick', () => view.toggleFrame());
view.onPickCharacter = pickCharacter;

addEventListener('resize', () => view.applyCamera());

// --------------------------------------------------------------- popover

function showPopover(clientX) {
  const page = railPage(clientX);
  const pop = $('pop');
  const span = book.pages[1] - book.pages[0];
  const near = events
    .filter((e) => Math.abs(e.page - page) <= 0.008 * span)
    .sort((a, b) => (LOUD.has(b.kind) ? 1 : 0) - (LOUD.has(a.kind) ? 1 : 0))
    .slice(0, 4);

  const ch = chapterAt(book, page);
  const pins = positionsAt(book, page);
  const at = new Map();
  for (const p of pins) {
    const key = p.state === 'at' ? book.places[p.place].name : 'travelling';
    (at.get(key) ?? at.set(key, []).get(key)).push(p);
  }
  const roster = [...at.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v.map(() => '●').join('')}`)
    .join('  ·  ');

  pop.replaceChildren();
  const h = document.createElement('div');
  h.className = 'ph';
  h.textContent = `${ch ? `Ch. ${ch.n}${ch.title ? ` · ${ch.title}` : ''} · ` : ''}p. ${Math.round(page)}`;
  pop.append(h);

  for (const e of near) {
    const row = document.createElement('div');
    row.className = 'ev';
    const dots = document.createElement('span');
    dots.className = 'dots';
    for (const w of e.who) {
      const d = document.createElement('span');
      d.className = 'dot';
      d.style.background = book.characters.find((c) => c.id === w)?.color ?? '#fff';
      dots.append(d);
    }
    const txt = document.createElement('span');
    txt.textContent = describe(e);
    const pg = document.createElement('span');
    pg.className = 'p';
    pg.textContent = `p.${e.page}`;
    row.append(dots, txt, pg);
    pop.append(row);
  }

  if (roster) {
    const r = document.createElement('div');
    r.className = 'roster';
    r.textContent = roster;
    pop.append(r);
  }

  const box = viewport.getBoundingClientRect();
  pop.hidden = false;
  pop.classList.add('show');
  pop.style.left = `${clamp(clientX - box.left - 132, 8, box.width - 272)}px`;
  pop.style.top = `${box.height - 8 - pop.offsetHeight - $('bar').offsetHeight + $('bar').offsetHeight}px`;
  pop.style.bottom = 'auto';
  pop.style.top = `${box.height - pop.offsetHeight - 8}px`;
}

function describe(e) {
  const who = e.who.map(nameOf);
  const place = e.place ? book.places[e.place].name : null;
  if (e.kind === 'meet') return `${listOf(e.who)} meet at ${place}`;
  if (e.kind === 'appear') return `${who[0]} appears at ${place}`;
  if (e.kind === 'exit') return `${who[0]} leaves the map`;
  return `${who[0]} reaches ${place}`;
}

function hidePopover() {
  $('pop').classList.remove('show');
  setTimeout(() => { $('pop').hidden = true; }, 180);
}

// ------------------------------------------------------------- transport

$('play').addEventListener('click', () => clock.toggle());
$('speed').addEventListener('click', () => setSpeed(SPEEDS[(SPEEDS.indexOf(clock.speed) + 1) % SPEEDS.length]));
$('fit-btn').addEventListener('click', () => view.toggleFrame());
$('scrim-btn').addEventListener('click', cycleScrim);
$('help-btn').addEventListener('click', () => { $('help').hidden = !$('help').hidden; });
$('help').addEventListener('click', () => { $('help').hidden = true; });

function setSpeed(s) {
  clock.speed = s;
  $('speed').textContent = `${s}×`;
  setPref('speed', s);
}

function cycleScrim() {
  scrimStep = (scrimStep + 1) % 3;
  document.documentElement.style.setProperty('--scrim', [0, 0.25, 0.5][scrimStep]);
  $('scrim-btn').classList.toggle('on', scrimStep > 0);
  setPref('scrim', scrimStep);
}

// -------------------------------------------------------------- keyboard

addEventListener('keydown', (e) => {
  // e.target is the window when nothing is focused, and windows have no
  // .matches — guard rather than assume an element.
  if (e.target?.matches?.('input, select, textarea')) return;
  if (!book || !clock) return;              // a book that failed to load
  // Ten steps on shift. A step is a page, or a tenth of a chapter.
  const step = (e.shiftKey ? 10 : 1) * unitStep();
  const mode = e.repeat ? 'keyRepeat' : 'key';
  const K = {
    ' ': () => clock.toggle(),
    ArrowLeft: () => (e.altKey ? hopWaypoint(-1) : clock.seek(clock.target - step, mode)),
    ArrowRight: () => (e.altKey ? hopWaypoint(1) : clock.seek(clock.target + step, mode)),
    Home: () => clock.jumpTo(book.pages[0]),
    End: () => clock.jumpTo(book.pages[1]),
    '[': () => (e.shiftKey ? hopEvent(-1) : hopChapter(-1)),
    ']': () => (e.shiftKey ? hopEvent(1) : hopChapter(1)),
    '{': () => hopEvent(-1),
    '}': () => hopEvent(1),
    f: () => { view.following = view.following ? null : view.focus; },
    l: () => { laneOn = !laneOn; setPref('lanes', laneOn); buildLanes(); },
    m: cycleScrim,
    r: () => view.toggleFrame(),
    '0': () => { view.focus = null; view.following = null; },
    '+': () => zoomCentre(1.25),
    '=': () => zoomCentre(1.25),
    '-': () => zoomCentre(0.8),
    '?': () => { $('help').hidden = !$('help').hidden; },
    '<': () => setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(clock.speed) - 1)]),
    '>': () => setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(clock.speed) + 1)]),
    ',': () => setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(clock.speed) - 1)]),
    '.': () => setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(clock.speed) + 1)]),
    Escape: () => {
      if (view.following) view.following = null;
      else if (!$('help').hidden) $('help').hidden = true;
      else view.focus = null;
    },
  };
  if (/^[1-8]$/.test(e.key)) {
    const c = book.characters[+e.key - 1];
    if (c) pickCharacter(c.id);
    e.preventDefault();
    return;
  }
  const fn = K[e.key];
  if (!fn) return;
  e.preventDefault();
  fn();
});

function hopChapter(dir) {
  const starts = book.chapters.map((c) => c.start);
  const here = clock.shown;
  const next = dir > 0
    ? starts.find((p) => p > here + unitStep() / 2)
    : [...starts].reverse().find((p) => p < here - unitStep() / 2);
  clock.jumpTo(next ?? (dir > 0 ? book.pages[1] : book.pages[0]));
}

function hopEvent(dir) {
  const pages = [...new Set(loudEvents.map((e) => e.page))].sort((a, b) => a - b);
  const here = clock.shown;
  const next = dir > 0
    ? pages.find((p) => p > here + unitStep() / 2)
    : [...pages].reverse().find((p) => p < here - unitStep() / 2);
  if (next !== undefined) clock.jumpTo(next);
}

function hopWaypoint(dir) {
  const who = view.focus;
  const pages = who
    ? (book.byCharacter[who] || []).map((w) => w.page)
    : [...new Set(book.waypoints.map((w) => w.page))].sort((a, b) => a - b);
  const here = clock.shown;
  const next = dir > 0
    ? pages.find((p) => p > here + unitStep() / 2)
    : [...pages].reverse().find((p) => p < here - unitStep() / 2);
  if (next !== undefined) clock.jumpTo(next);
}

// ---------------------------------------------------------- file loading

/** The map's centre in client coords — not the window's, which sits under the bar. */
function zoomCentre(factor) {
  const r = $('world-svg').getBoundingClientRect();
  view.zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
}

/** Loading a book the reader chose. A bad file is a note, never a silent nothing. */
async function loadBookFile(f) {
  let raw;
  try {
    raw = JSON.parse(await f.text());
  } catch (err) {
    showProblems([`${f.name} is not valid JSON: ${err.message}`]);
    return;
  }
  await loadBook(raw);
}

function wireFiles() {
  $('pick-image').addEventListener('change', (e) => {
    if (e.target.files[0]) useImageBlob(e.target.files[0]);
  });
  $('pick-book').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await loadBookFile(f);
  });
  $('dismiss-card').addEventListener('click', () => { $('card').hidden = true; });

  let depth = 0;
  addEventListener('dragenter', (e) => { e.preventDefault(); if (++depth === 1) document.body.classList.add('dragging-file'); });
  addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging-file'); } });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging-file');
    for (const f of e.dataTransfer.files) {
      if (f.type.startsWith('image/')) await useImageBlob(f);
      else if (/\.json$/i.test(f.name)) await loadBookFile(f);
    }
  });
}

// ------------------------------------------------------------------ boot

const picker = $('book-pick');
for (const b of BOOKS) {
  const o = document.createElement('option');
  o.value = b.file;
  o.textContent = b.label;
  picker.append(o);
}
picker.addEventListener('change', () => openBookFile(picker.value));

async function openBookFile(file) {
  const res = await fetch(file);
  if (!res.ok) { showProblems([`Could not load ${file} (${res.status})`]); return; }
  await loadBook(await res.json());
  setPref('lastBook', file);
}

wireFiles();
document.documentElement.style.setProperty('--scrim', [0, 0.25, 0.5][scrimStep]);
$('scrim-btn').classList.toggle('on', scrimStep > 0);

const params = new URLSearchParams(location.search);
const start = params.get('book')
  ? `data/${params.get('book')}.json`
  : pref('lastBook', BOOKS[0].file);
picker.value = BOOKS.some((b) => b.file === start) ? start : BOOKS[0].file;

await openBookFile(picker.value);
// A book that failed to load leaves `clock` null. This is a top-level-await
// module, so throwing here would silently skip every listener below it.
if (clock) setSpeed(pref('speed', 1));
$('play').addEventListener('click', () => {
  if (clock) $('play').textContent = clock.playing ? '❚❚ Pause' : '▶︎ Play';
});
setInterval(() => {
  if (!clock) return;
  $('play').textContent = clock.playing ? '❚❚ Pause' : '▶︎ Play';
  if (book) setPref(`page:${book.id}`, { axis: book.axis, at: +clock.shown.toFixed(2) });
}, 400);
