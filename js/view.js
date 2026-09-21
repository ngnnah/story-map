// The map view: camera, SVG scene, and everything drawn over the image.
//
// The camera works by moving the viewBox rather than by transforming a group.
// Everything inside the SVG then stays in square map units, strokes can use
// `vector-effect: non-scaling-stroke` and stay a constant screen width for
// free, and there is no second coordinate system to keep in sync.

import { positionsAt, bandTrails } from './timeline.js';
import { ICON_BOX, ICON_FILL, iconPath } from './icons.js';

const NS = 'http://www.w3.org/2000/svg';
const MAP_W = 1000;

// Framing the part of the map the story uses. A continent-wide endpaper with
// the action in one corner is unreadable at whole-map zoom — but a box drawn
// tight round two villages is worse, because it tells you nothing about where
// those villages ARE, which is the whole point of a story map.
const ACTION_PAD = 1.15;
const ACTION_MIN_SPAN = 0.30;   // never frame less than this fraction of the width
const ACTION_MAX_K = 3;

const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
// `gap` marks a point the character reached without walking there — they were
// off the map in between. Emitting M rather than L lifts the pen, so the
// trail shows two journeys instead of inventing a road between them.
const pathOf = (pts) => pts
  .map((p, i) => `${i && !p.gap ? 'L' : 'M'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`)
  .join(' ');

export class View {
  constructor(svg, chipLayer) {
    this.svg = svg;
    this.chips = chipLayer;
    this.book = null;
    this.mapH = MAP_W;
    this.cam = { cx: MAP_W / 2, cy: MAP_W / 2, k: 1 };
    this.hover = null;
    this.focus = null;
    this.following = null;
    this.dodgeOffsets = new Map();     // who -> {x, y} in screen px, chased
    this.seen = new Set();             // characters that have had their debut
    this.exited = new Map();           // who -> {x, y, heading} for terminal ticks
    this.labelSlots = new Map();
    // The widest region the story has used so far. It only ever grows: a
    // camera that crept inward whenever everyone happened to be in one town
    // would move in both directions and never settle.
    this.actionBox = null;
    this.autoFramed = false;
    // Place ids the reader has reached, or null for "no wall". A place name is
    // a spoiler all by itself — "Safehold" tells you something before you have
    // earned it — so an unreached place is not drawn at all.
    this.revealed = null;
    // Characters the reader has met. `positionsAt` works from the data and
    // knows nothing about how far they have read, so the wall is applied here.
    this.revealedWho = null;
    this.onPickCharacter = () => {};

    this.defs = el('defs');
    this.gImage = el('g');
    this.gTrails = el('g');
    this.gPlaces = el('g');
    this.gPins = el('g');
    this.gFx = el('g');
    this.image = el('image', { x: 0, y: 0, preserveAspectRatio: 'none' });
    this.scrim = el('rect', { id: 'scrim-rect', x: 0, y: 0 });
    this.gImage.append(this.image, this.scrim);
    svg.append(this.defs, this.gImage, this.gTrails, this.gPlaces, this.gPins, this.gFx);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }

  // --- setup ---------------------------------------------------------------

  setBook(book) {
    this.book = book;
    this.mapH = MAP_W * book.map.aspect;
    this.image.setAttribute('width', MAP_W);
    this.image.setAttribute('height', this.mapH);
    this.scrim.setAttribute('width', MAP_W);
    this.scrim.setAttribute('height', this.mapH);
    this.dodgeOffsets.clear();
    this.actionBox = null;
    this.seen.clear();
    this.exited.clear();
    this.labelSlots.clear();
    this.gTrails.replaceChildren();
    this.gPins.replaceChildren();
    this.gFx.replaceChildren();
    this.drawPlaces();
    this.fit();          // the caller re-frames once it knows the position
  }

  setRevealed(placeIds, whoIds = null) {
    this.revealed = placeIds;
    this.revealedWho = whoIds;
    if (this.book) this.drawPlaces();
  }

  setImageHref(href) {
    if (href) this.image.setAttribute('href', href);
    else this.image.removeAttribute('href');
  }

  drawPlaces() {
    this.gPlaces.replaceChildren();
    this.placeNodes = new Map();
    for (const p of Object.values(this.book.places)) {
      if (this.revealed && !this.revealed.has(p.id)) continue;
      const g = el('g');
      const dot = el('circle', { class: 'place-dot', cx: p.x * MAP_W, cy: p.y * MAP_W });
      const label = el('text', { class: 'label place', x: p.x * MAP_W, y: p.y * MAP_W });
      label.textContent = p.name;
      g.append(dot, label);
      this.gPlaces.append(g);
      this.placeNodes.set(p.id, { dot, label, p });
    }
  }

  // --- camera --------------------------------------------------------------

  /** World units per screen pixel, and the letterbox offsets. */
  metrics() {
    const r = this.svg.getBoundingClientRect();
    const vw = MAP_W / this.cam.k;
    const vh = this.mapH / this.cam.k;
    const s = Math.min(r.width / vw, r.height / vh);   // preserveAspectRatio: meet
    return { r, vw, vh, s, u: 1 / s, ox: (r.width - s * vw) / 2, oy: (r.height - s * vh) / 2 };
  }

  applyCamera() {
    const { vw, vh } = this.metrics();
    const half = this.cam.k <= 1;
    // Once zoomed in, keep the window inside the map; at fit, stay centred.
    this.cam.cx = half ? MAP_W / 2 : clamp(this.cam.cx, vw / 2, MAP_W - vw / 2);
    this.cam.cy = half ? this.mapH / 2 : clamp(this.cam.cy, vh / 2, this.mapH - vh / 2);
    this.svg.setAttribute(
      'viewBox',
      `${this.cam.cx - vw / 2} ${this.cam.cy - vh / 2} ${vw} ${vh}`,
    );
  }

  fit() {
    this.cam = { cx: MAP_W / 2, cy: this.mapH / 2, k: 1 };
    this.following = null;
    this.autoFramed = false;
    this.applyCamera();
  }

  /**
   * Widen the remembered action box to include `box`. Never narrows — see the
   * note on `actionBox`.
   */
  /** Forget the remembered region. The reader changed how much book exists. */
  resetAction() {
    this.actionBox = null;
  }

  noteAction(box) {
    if (!box) return;
    const a = this.actionBox;
    this.actionBox = a
      ? {
        x0: Math.min(a.x0, box.x0), y0: Math.min(a.y0, box.y0),
        x1: Math.max(a.x1, box.x1), y1: Math.max(a.y1, box.y1),
      }
      : { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
  }

  /**
   * Point the camera at the action box. Called when the revealed region
   * changes — on load, and when the reader unlocks a chapter — never per
   * frame and never mid-scrub: a camera that re-frames while you drag the
   * rail is exactly the motion `followStep`'s dead zone exists to avoid.
   */
  frameAction() {
    const b = this.actionBox;
    if (!b) { this.fit(); return; }
    const w = Math.max((b.x1 - b.x0) * ACTION_PAD, ACTION_MIN_SPAN);
    const h = Math.max((b.y1 - b.y0) * ACTION_PAD, ACTION_MIN_SPAN * this.book.map.aspect);
    const k = clamp(Math.min(1 / w, this.mapH / MAP_W / h), 1, ACTION_MAX_K);
    this.cam = { cx: ((b.x0 + b.x1) / 2) * MAP_W, cy: ((b.y0 + b.y1) / 2) * MAP_W, k };
    this.following = null;
    this.autoFramed = k > 1;
    this.applyCamera();
  }

  /** `R`: the action, then the whole map, then the action again. */
  toggleFrame() {
    if (this.autoFramed) this.fit();
    else this.frameAction();
  }

  zoomAt(factor, clientX, clientY) {
    this.autoFramed = false;
    const before = this.toWorld(clientX, clientY);
    this.cam.k = clamp(this.cam.k * factor, 1, 8);
    this.applyCamera();
    const after = this.toWorld(clientX, clientY);
    this.cam.cx += before.x - after.x;
    this.cam.cy += before.y - after.y;
    this.applyCamera();
  }

  panBy(dxPx, dyPx) {
    this.autoFramed = false;
    const { u } = this.metrics();
    this.cam.cx -= dxPx * u;
    this.cam.cy -= dyPx * u;
    this.applyCamera();
  }

  toWorld(clientX, clientY) {
    const { r, s, ox, oy, vw, vh } = this.metrics();
    return {
      x: this.cam.cx - vw / 2 + (clientX - r.left - ox) / s,
      y: this.cam.cy - vh / 2 + (clientY - r.top - oy) / s,
    };
  }

  toScreen(x, y) {
    const { r, s, ox, oy, vw, vh } = this.metrics();
    return {
      x: r.left + ox + (x - (this.cam.cx - vw / 2)) * s,
      y: r.top + oy + (y - (this.cam.cy - vh / 2)) * s,
    };
  }

  /**
   * Follow keeps a character on screen without gluing the camera to them.
   * A camera locked to a moving pin micro-pans constantly and is nauseating;
   * a dead zone means it sits still while they wander the middle of the
   * screen, then glides when they break out.
   */
  followStep(pin) {
    if (!pin) return;
    const { r } = this.metrics();
    const s = this.toScreen(pin.x, pin.y);
    const dz = 0.46;
    const outX = Math.abs(s.x - (r.left + r.width / 2)) > (r.width * dz) / 2;
    const outY = Math.abs(s.y - (r.top + r.height / 2)) > (r.height * dz) / 2;
    if (!outX && !outY) return;
    this.cam.cx += (pin.x - this.cam.cx) * 0.08;
    this.cam.cy += (pin.y - this.cam.cy) * 0.08;
    this.applyCamera();
  }

  // --- the frame -----------------------------------------------------------

  render(page, dt) {
    if (!this.book) return;
    const book = this.book;
    const { u } = this.metrics();
    const k = this.cam.k;
    const span = book.pages[1] - book.pages[0];
    const HOT = 0.04 * span;
    const WARM = 0.20 * span;

    // What counts as crowded is a number of pixels, and positionsAt works in map
    // units, so the radius is computed here. Two pins overlap when their centres
    // are closer than one diameter — that is the honest threshold, and the
    // narrowest one, which matters because clustering is single-linkage and a
    // generous radius chains pins that do not actually collide.
    const pinRForDodge = k < 1.3 ? 9 : k < 2.2 ? 11 : 14;
    let pins = positionsAt(book, page, (2 * pinRForDodge) * u / MAP_W);
    if (this.revealedWho) pins = pins.filter((p) => this.revealedWho.has(p.who));
    const byWho = new Map(pins.map((p) => [p.who, p]));
    const raised = this.focus || this.hover;

    if (this.following) this.followStep(byWho.get(this.following));

    // --- zoom bands: what is worth drawing at this scale
    const pinR = pinRForDodge;
    const showAllPlaceLabels = k >= 2.2;
    const showMonograms = k >= 2.2;
    const clusterAt = k < 1.3 ? 4 : k < 2.2 ? 5 : 6;

    // --- trails
    const trailFrags = [];
    for (const ch of book.characters) {
      if (this.hidden?.has(ch.id)) continue;
      if (this.revealedWho && !this.revealedWho.has(ch.id)) continue;
      const dim = raised && raised !== ch.id;
      const bands = bandTrails(book, ch.id, page, HOT, WARM);
      const spec = [
        [bands.cold, 1.2, 0.20],
        [bands.warm, 1.7, 0.42],
        [bands.hot, 2.4, 1.00],
      ];
      for (const [pts, w, op] of spec) {
        if (pts.length < 2) continue;
        const d = pathOf(pts);
        const inferred = pts.some((p) => p.inferred);
        const o = dim ? op * 0.28 : op;
        trailFrags.push({ d, w: w + 2.6, stroke: null, op: 0.40 * (dim ? 0.28 : 1), inferred });
        trailFrags.push({ d, w: dim ? w : w + (raised === ch.id ? 0.6 : 0), stroke: ch.color, op: o, inferred });
      }
    }
    this.syncNodes(this.gTrails, trailFrags, 'path', (node, f) => {
      node.setAttribute('d', f.d);
      node.setAttribute('stroke-width', f.w);
      node.setAttribute('opacity', f.op);
      node.setAttribute('class', `trail${f.stroke ? '' : ' under'}${f.inferred ? ' inferred' : ''}`);
      if (f.stroke) node.setAttribute('stroke', f.stroke);
      else node.removeAttribute('stroke');
    });

    // --- places
    const occupied = new Set(pins.map((p) => p.place).filter(Boolean));
    for (const [id, n] of this.placeNodes) {
      n.dot.setAttribute('r', (k < 1.3 ? 2.2 : 2.8) * u);
      n.dot.classList.toggle('occupied', occupied.has(id));
      const show = showAllPlaceLabels || occupied.has(id);
      n.label.style.fontSize = `${11 * u}px`;
      n.label.style.strokeWidth = `${3 * u}px`;
      n.label.setAttribute('y', n.p.y * MAP_W + 14 * u);
      n.label.setAttribute('text-anchor', 'middle');
      n.label.classList.toggle('hidden', !show);
    }

    // --- exits
    // Derived from the waypoints every frame rather than set when an exit is
    // announced. Announcements deliberately stay silent when you jump, but a
    // crosshatch marking where someone stopped existing is state: it has to be
    // there however you arrived at this page.
    this.exited.clear();
    for (const ch of book.characters) {
      if (this.revealedWho && !this.revealedWho.has(ch.id)) continue;
      const wps = book.byCharacter[ch.id] || [];
      for (let i = 0; i < wps.length; i++) {
        if (wps[i].place || wps[i].page > page) continue;
        const prev = wps[i - 1];
        if (!prev?.place) break;
        const pl = book.places[prev.place];
        this.exited.set(ch.id, { x: pl.x, y: pl.y, heading: null, color: ch.color });
        break;
      }
    }

    // --- pins
    this.syncPins(pins, { u, pinR, showMonograms, clusterAt, raised, dt });
    this.lastPins = pins;
    return pins;
  }

  syncNodes(parent, items, tag, apply) {
    const kids = parent.childNodes;
    while (kids.length > items.length) parent.removeChild(parent.lastChild);
    while (kids.length < items.length) parent.appendChild(el(tag));
    items.forEach((it, i) => apply(kids[i], it));
  }

  syncPins(pins, opts) {
    const { u, pinR, showMonograms, clusterAt, raised, dt } = opts;
    this.pinNodes ??= new Map();

    // Group by the cluster `dodge` already worked out, not by exact coordinate
    // equality. Re-deriving it here from `toFixed(4)` meant pins at nearby but
    // different places were never counted as a crowd: they got a fan offset
    // from dodge and then a fan radius of zero from this, so they drew on top
    // of one another and never collapsed into a puck either.
    const crowds = new Map();
    for (const p of pins) {
      if (this.hidden?.has(p.who)) continue;
      const key = p.cluster ?? `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
      (crowds.get(key) ?? crowds.set(key, []).get(key)).push(p);
    }

    const livePins = new Set();
    const livePucks = new Set();
    for (const [, group] of crowds) {
      if (group.length >= clusterAt) this.drawPuck(group, opts, livePucks);
      else for (const p of group) this.drawPin(p, group.length, opts, livePins);
    }

    for (const [who, n] of this.pinNodes) {
      if (!livePins.has(who)) { n.g.remove(); this.pinNodes.delete(who); this.dodgeOffsets.delete(who); }
    }
    for (const [key, n] of this.puckNodes ?? []) {
      if (!livePucks.has(key)) { n.g.remove(); this.puckNodes.delete(key); }
    }

    // Terminal ticks stay for the rest of the book: scrubbing across a map and
    // seeing where people stopped existing is worth more than any animation.
    this.drawTerminals(u);
  }

  drawPin(p, crowd, { u, pinR, showMonograms, raised, dt }, live) {
    live.add(p.who);
    let n = this.pinNodes.get(p.who);
    if (!n) {
      const g = el('g', { class: 'pin' });
      const wake = [el('circle', { class: 'wake' }), el('circle', { class: 'wake' }), el('circle', { class: 'wake' })];
      const pulse = el('circle', { class: 'pulse' });
      const body = el('circle', { class: 'body' });
      // The silhouette sits in its own <g>: the group carries the placement
      // transform while the path inside it is free to take a CSS transform
      // (debut, nudge). A CSS transform on the path would replace the
      // placement outright and fling the figure to the corner of the map.
      const iconWrap = el('g', { class: 'icon-wrap' });
      const icon = el('path', { class: 'icon' });
      iconWrap.append(icon);
      const mono = el('text', { class: 'mono' });
      const label = el('text', { class: 'label' });
      const spoke = el('line', { class: 'spoke' });
      g.append(spoke, ...wake, pulse, body, iconWrap, mono, label);
      g.addEventListener('pointerenter', () => { this.hover = p.who; });
      g.addEventListener('pointerleave', () => { if (this.hover === p.who) this.hover = null; });
      g.addEventListener('click', (e) => { e.stopPropagation(); this.onPickCharacter(p.who); });
      this.gPins.append(g);
      n = { g, wake, pulse, body, iconWrap, icon, mono, label, spoke };
      this.pinNodes.set(p.who, n);
      const i = this.book.charIndex[p.who] ?? 0;
      g.style.setProperty('--phase', `${i * -370}ms`);
      if (this.seen.has(p.who)) g.classList.remove('debut');
      else { g.classList.add('debut'); this.seen.add(p.who); setTimeout(() => g.classList.remove('debut'), 450); }
    }

    // Dodge offsets are chased in screen pixels, not jumped to. This is the
    // only per-object position tween in the app, and it earns the exception
    // because where a pin sits in a fan is a layout decision, not a fact
    // about the story.
    const want = p.off ? { x: p.off.dx, y: p.off.dy } : { x: 0, y: 0 };
    const R = crowd > 1 ? 9 + 2.2 * (crowd - 2) : 0;
    const cur = this.dodgeOffsets.get(p.who) ?? { x: 0, y: 0 };
    const rate = 1 - 2 ** (-(dt || 16) / 55);
    cur.x += (want.x * R - cur.x) * rate;
    cur.y += (want.y * R - cur.y) * rate;
    this.dodgeOffsets.set(p.who, cur);

    const cx = p.x * MAP_W + cur.x * u;
    const cy = p.y * MAP_W + cur.y * u;
    const dim = raised && raised !== p.who;

    n.g.setAttribute('data-state', p.state);
    n.g.style.color = p.color;
    n.g.classList.toggle('dimmed', !!dim);
    // Past their last waypoint the model holds them in place. That is a rule,
    // not something the book said, so it should not look like data.
    n.g.classList.toggle('stale', !!p.done);
    n.g.style.setProperty('--period', `${1800 + Math.min(stayLength(this.book, p), 60) * 22}ms`);

    n.body.setAttribute('cx', cx);
    n.body.setAttribute('cy', cy);
    n.body.setAttribute('r', pinR * u);
    n.body.setAttribute('fill', p.color);
    n.pulse.setAttribute('cx', cx);
    n.pulse.setAttribute('cy', cy);
    n.pulse.style.display = p.state === 'at' ? '' : 'none';

    // A wake behind a traveller: where they were a page and a half, three and
    // four and a half pages ago. It reads as direction and speed at a glance.
    n.wake.forEach((w, i) => {
      if (p.state !== 'moving' || !p.heading) { w.setAttribute('r', 0); return; }
      const back = (1.5 + i * 1.5) * (p.speed || 0);
      w.setAttribute('cx', cx - p.heading.x * back * MAP_W);
      w.setAttribute('cy', cy - p.heading.y * back * MAP_W);
      w.setAttribute('r', [4.5, 3.5, 2.5][i] * u);
      w.setAttribute('fill', p.color);
      w.setAttribute('opacity', [0.30, 0.18, 0.10][i]);
    });

    // A role silhouette in place of the disc, gated on how big this pin
    // actually comes out in CSS pixels. `pinR` already *is* screen pixels —
    // the body is drawn at `pinR * u` world units — so the gate needs no
    // camera maths. It is deliberately not the zoom band `k`: the bands
    // answer a different question (what is worth drawing at all), and a
    // silhouette below about 15px goes to mud whatever the zoom says.
    const ICON_MIN_PX = 15;   // under this a figure goes to mud; a disc still reads
    const ch = this.book.characters[this.book.charIndex[p.who] ?? -1];
    // The silhouette takes over the disc's whole footprint, so swapping one in
    // never makes a character's mark smaller. `ICON_FILL` is how much of that
    // box the shortest figure actually covers — gate on the ink, not the box.
    const iconBoxPx = 2 * pinR;
    const useIcon = !!ch?.icon && iconBoxPx * ICON_FILL >= ICON_MIN_PX;
    n.body.style.display = useIcon ? 'none' : '';
    n.iconWrap.style.display = useIcon ? '' : 'none';
    if (useIcon) {
      // world units per icon-box unit: the box is iconBoxPx CSS px across.
      const scale = (iconBoxPx * u) / ICON_BOX;
      n.icon.setAttribute('d', iconPath(ch.icon));
      n.icon.setAttribute('fill', p.color);
      n.iconWrap.setAttribute(
        'transform',
        `translate(${cx} ${cy}) scale(${scale}) translate(${-ICON_BOX / 2} ${-ICON_BOX / 2})`,
      );
    }

    // The silhouette has already said who this is at a glance; an initial
    // stamped over it just fights the shape.
    const showMono = (showMonograms || raised === p.who) && !useIcon;
    n.mono.textContent = showMono ? (p.short ?? p.name).slice(0, 1) : '';
    n.mono.setAttribute('x', cx);
    n.mono.setAttribute('y', cy);
    n.mono.style.fontSize = `${9 * u}px`;

    // Hovering is the one moment you have asked about this pin in
    // particular, so it is the one moment the full name is worth the width.
    const hovered = this.hover === p.who;
    n.label.textContent = hovered ? p.name : (p.short ?? p.name);
    n.label.setAttribute('x', cx);
    n.label.setAttribute('y', cy - (pinR + 7) * u);
    n.label.style.fontSize = `${11 * u}px`;
    n.label.style.strokeWidth = `${3 * u}px`;
    n.label.setAttribute('text-anchor', 'middle');
    n.label.classList.toggle('hidden', !(hovered || raised === p.who || crowd === 1 || p.state === 'moving'));

    const spoked = Math.hypot(cur.x, cur.y) > 1;
    n.spoke.setAttribute('x1', p.x * MAP_W);
    n.spoke.setAttribute('y1', p.y * MAP_W);
    n.spoke.setAttribute('x2', cx);
    n.spoke.setAttribute('y2', cy);
    n.spoke.setAttribute('stroke-width', spoked ? 1 : 0);
  }

  /** Five pins fanned round one town is a flower, not information. */
  drawPuck(group, { u }, live) {
    this.puckNodes ??= new Map();
    const key = group.map((p) => p.who).sort().join('|');
    // The pruner below looks this set up by group key, not by character id.
    live.add(key);
    for (const p of group) {
      const n = this.pinNodes.get(p.who);
      if (n) { n.g.remove(); this.pinNodes.delete(p.who); }
    }
    let n = this.puckNodes.get(key);
    if (!n) {
      const g = el('g', { class: 'puck' });
      const rect = el('rect', { rx: 5 });
      const text = el('text');
      g.append(rect, text);
      this.gPins.append(g);
      n = { g, rect, text, dots: [] };
      this.puckNodes.set(key, n);
    }
    const p0 = group[0];
    const w = (26 + group.length * 7) * u;
    const h = 10 * u;
    n.rect.setAttribute('x', p0.x * MAP_W - w / 2);
    n.rect.setAttribute('y', p0.y * MAP_W - h / 2);
    n.rect.setAttribute('width', w);
    n.rect.setAttribute('height', h);
    n.text.textContent = `${group.length}`;
    n.text.setAttribute('x', p0.x * MAP_W - w / 2 + 5 * u);
    n.text.setAttribute('y', p0.y * MAP_W);
    n.text.style.fontSize = `${9 * u}px`;
    while (n.dots.length < group.length) { const d = el('circle'); n.g.append(d); n.dots.push(d); }
    while (n.dots.length > group.length) n.dots.pop().remove();
    group.forEach((p, i) => {
      n.dots[i].setAttribute('cx', p0.x * MAP_W - w / 2 + (16 + i * 7) * u);
      n.dots[i].setAttribute('cy', p0.y * MAP_W);
      n.dots[i].setAttribute('r', 2 * u);
      n.dots[i].setAttribute('fill', p.color);
    });
    n.live = key;
  }

  pruneNode(map, live) {
    if (!map) return;
    for (const [key, n] of map) {
      const members = key.split('|');
      if (!members.every((m) => live.has(m)) || !this.lastCrowdKeys?.has(key)) {
        if (!members.some((m) => live.has(m))) { n.g.remove(); map.delete(key); }
      }
    }
  }

  drawTerminals(u) {
    this.termNodes ??= new Map();
    for (const [who, n] of this.termNodes) {
      if (!this.exited.has(who)) { n.remove(); this.termNodes.delete(who); }
    }
    for (const [who, e] of this.exited) {
      let n = this.termNodes.get(who);
      if (!n) { n = el('line', { class: 'terminal' }); this.gFx.append(n); this.termNodes.set(who, n); }
      const a = e.heading ?? { x: 1, y: 0 };
      const len = 3.5 * u;
      n.setAttribute('x1', e.x * MAP_W - a.y * len);
      n.setAttribute('y1', e.y * MAP_W + a.x * len);
      n.setAttribute('x2', e.x * MAP_W + a.y * len);
      n.setAttribute('y2', e.y * MAP_W - a.x * len);
      n.setAttribute('stroke', e.color);
      n.setAttribute('stroke-width', 2);
      n.setAttribute('opacity', 0.55);
    }
  }

  // --- announcements -------------------------------------------------------

  ring(x, y, color) {
    const r = el('circle', { class: 'ring', cx: x * MAP_W, cy: y * MAP_W, stroke: color || '#E7ECF3' });
    this.gFx.append(r);
    setTimeout(() => r.remove(), 700);
  }

  nudge(who) {
    const n = this.pinNodes?.get(who);
    if (!n) return;
    n.g.classList.remove('nudge');
    void n.g.offsetWidth;
    n.g.classList.add('nudge');
    setTimeout(() => n.g.classList.remove('nudge'), 300);
  }

  chip(x, y, text, colors, holdMs) {
    const s = this.toScreen(x * MAP_W, y * MAP_W);
    const box = this.svg.getBoundingClientRect();
    const c = document.createElement('div');
    c.className = 'chip';
    c.style.left = `${s.x - box.left}px`;
    c.style.top = `${s.y - box.top - 18}px`;
    c.append(document.createTextNode(text));
    for (const col of colors) {
      const d = document.createElement('span');
      d.className = 'dot';
      d.style.background = col;
      c.append(d);
    }
    this.chips.append(c);
    setTimeout(() => { c.classList.add('out'); setTimeout(() => c.remove(), 260); }, holdMs);
  }
}

function stayLength(book, pin) {
  if (pin.state !== 'at' || !pin.place) return 0;
  const wps = book.byCharacter[pin.who] || [];
  let from = null;
  let to = null;
  for (const w of wps) {
    if (w.place === pin.place && from === null) from = w.page;
    if (from !== null && w.place !== pin.place) { to = w.page; break; }
  }
  return to === null ? book.pages[1] - (from ?? 0) : to - from;
}

export { MAP_W };
