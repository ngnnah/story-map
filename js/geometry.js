// Pure geometry for the map overlay.
//
// A point is {x, y} in *square map space*: both are fractions of the map
// image's WIDTH, so y runs 0..aspect rather than 0..1. book.js converts the
// 0..1 fractions in book.json into this space once, on load.
//
// That conversion is what makes the maths here honest. In raw fractions, one
// unit of y is `aspect` times the physical distance of one unit of x, so
// `hypot(dx, dy)` over-measures vertical legs — on a 0.7-aspect map by 43% —
// and arc-length parameterisation then gives them too much t. Pins would crawl
// north-south and race east-west. In square space, hypot is just distance.
//
// Nothing in here touches the DOM, fetches, or reads globals.

const EPS = 1e-9;

/** Length of each segment of a polyline. Returns [] for a 0- or 1-point line. */
export function segLengths(line) {
  const out = [];
  for (let i = 1; i < line.length; i++) {
    out.push(Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y));
  }
  return out;
}

/** Total arc length of a polyline. */
export function length(line) {
  let total = 0;
  for (const seg of segLengths(line)) total += seg;
  return total;
}

/**
 * Point at fraction `t` (0..1) of the polyline's *arc length*.
 *
 * Parameterising by arc length rather than by segment index is what keeps a
 * traveller moving at an even speed along a bent route: a route whose first
 * segment is ten times longer than its second should not spend half the
 * journey on each.
 */
export function pointAt(line, t) {
  if (!line.length) throw new Error('pointAt: empty polyline');
  if (line.length === 1) return { ...line[0] };
  if (!(t > 0)) return { ...line[0] };                 // also catches NaN
  if (t >= 1) return { ...line[line.length - 1] };

  const segs = segLengths(line);
  let total = 0;
  for (const seg of segs) total += seg;
  if (total < EPS) return { ...line[0] };              // degenerate: all points equal

  let want = t * total;
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const f = segs[i] < EPS ? 0 : want / segs[i];
      return {
        x: line[i].x + (line[i + 1].x - line[i].x) * f,
        y: line[i].y + (line[i + 1].y - line[i].y) * f,
      };
    }
    want -= segs[i];
  }
  /* istanbul ignore next */
  return { ...line[line.length - 1] };
}

/**
 * The prefix of a polyline up to `t`, ending exactly at pointAt(line, t).
 * Used for trails, which must never run ahead of the current page.
 */
export function clip(line, t) {
  if (!line.length) return [];
  if (line.length === 1) return [{ ...line[0] }];
  if (!(t > 0)) return [{ ...line[0] }];
  if (t >= 1) return line.map((p) => ({ ...p }));

  const segs = segLengths(line);
  let total = 0;
  for (const seg of segs) total += seg;
  if (total < EPS) return [{ ...line[0] }];

  const out = [{ ...line[0] }];
  let want = t * total;
  for (let i = 0; i < segs.length; i++) {
    if (want >= segs[i] - EPS) {
      out.push({ ...line[i + 1] });
      want -= segs[i];
      continue;
    }
    const f = segs[i] < EPS ? 0 : want / segs[i];
    out.push({
      x: line[i].x + (line[i + 1].x - line[i].x) * f,
      y: line[i].y + (line[i + 1].y - line[i].y) * f,
    });
    return out;
  }
  return out;
}

/** The radius that means "standing on the same spot": a tenth of a thousandth
 *  of the map's width, which is a fifth of a pixel on a 2288px scan. It is the
 *  float-noise floor the old `toFixed(4)` group key was really expressing. */
export const COINCIDENT = 1e-4;

/**
 * Work out how to fan out pins that crowd each other on screen.
 *
 * Returns each pin with `off` — a *unit-circle* offset — and `crowd`, how many
 * pins share its cluster. The offset is deliberately unitless: the renderer
 * multiplies it by a pixel radius, so a fanned-out group stays the same size
 * on screen at every zoom level. Returning map-space offsets instead would
 * mean two pins overlapping at 1× and half a screen apart at 8×.
 *
 * Input order is preserved and the angles are deterministic, so a pin does not
 * jump between renders. A lone pin gets `off: null`.
 *
 * `radius` is in SQUARE MAP SPACE like every other coordinate here, and it is a
 * parameter rather than something derived in this file: "too close to read" is
 * a number of *pixels*, and only the renderer knows what a pixel is worth in
 * map units at the current zoom — `pixels * metrics().u / MAP_W`. Omitted, it
 * falls back to COINCIDENT, so a caller that has not been taught about zoom
 * gets exactly the old behaviour: only pins on the same spot fan out.
 *
 * Grouping is single-linkage — pins are joined when they are within `radius` of
 * each other, and a group is a connected component of that relation. Connected
 * components are a property of the *set*, which a "first pin claims its
 * neighbours" sweep is not: the pin list is rebuilt every frame and its order
 * follows who is currently on stage, so an order-dependent grouping would make
 * pins swap fans when an unrelated character appears. The accepted cost is
 * chaining — a line of pins each just inside the radius becomes one group even
 * though its ends are far apart. That over-spreads (a wider fan than the real
 * overlap needs); it never hides a pin, which is the failure being fixed here.
 * With a cast of eight inside 6% of the map, that is the right way round.
 */
export function dodge(pins, radius = COINCIDENT) {
  const n = pins.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { ...pins[i], off: null, crowd: 1 };
  if (n < 2) return out;

  // O(n²) over the cast — eight pins is twenty-eight pairs — with no strings,
  // no Map and no per-group arrays, so this is lighter than the key-building it
  // replaces. A grid index would cost more to build than it saves and would put
  // a seam through any cluster that straddles a cell boundary.
  const r2 = radius > 0 ? radius * radius : 0;        // NaN / negative -> exact only
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const root = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = pins[i].x - pins[j].x;
      const dy = pins[i].y - pins[j].y;
      if (!(dx * dx + dy * dy <= r2)) continue;       // negated, so NaN never joins
      const a = root(i);
      const b = root(j);
      if (a !== b) parent[a] = b;
    }
  }

  // Size every group, then deal out the angles. A pin's slot is its position
  // among its own group in input order, which is what keeps the picture stable
  // frame to frame: positionsAt walks book.characters, so that order is fixed.
  const size = new Int32Array(n);
  for (let i = 0; i < n; i++) size[root(i)]++;
  const slot = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = root(i);
    const crowd = size[r];
    if (crowd < 2) continue;
    const angle = -Math.PI / 2 + (slot[r]++ * 2 * Math.PI) / crowd;
    out[i].off = { dx: Math.cos(angle), dy: Math.sin(angle) };
    out[i].crowd = crowd;
  }
  return out;
}

/**
 * Unit direction of travel at `t`, for pointing a pin the way it is heading.
 * Returns null when the line has no length.
 */
export function headingAt(line, t) {
  if (line.length < 2) return null;
  const segs = segLengths(line);
  let total = 0;
  for (const seg of segs) total += seg;
  if (total < EPS) return null;

  let want = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      if (segs[i] < EPS) continue;
      return {
        x: (line[i + 1].x - line[i].x) / segs[i],
        y: (line[i + 1].y - line[i].y) / segs[i],
      };
    }
    want -= segs[i];
  }
  return null;
}
