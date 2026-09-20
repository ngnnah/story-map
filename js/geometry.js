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

/**
 * Work out how to fan out pins that share a position.
 *
 * Returns each pin with `off` — a *unit-circle* offset — and `crowd`, how many
 * pins share its spot. The offset is deliberately unitless: the renderer
 * multiplies it by a pixel radius, so a fanned-out group stays the same size
 * on screen at every zoom level. Returning map-space offsets instead would
 * mean two pins overlapping at 1× and half a screen apart at 8×.
 *
 * Input order is preserved and the angles are deterministic, so a pin does not
 * jump between renders. A lone pin gets `off: null`.
 */
export function dodge(pins) {
  const groups = new Map();
  pins.forEach((p, i) => {
    const key = `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });

  const out = pins.map((p) => ({ ...p, off: null, crowd: 1 }));
  for (const idxs of groups.values()) {
    const n = idxs.length;
    if (n < 2) continue;
    idxs.forEach((idx, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      out[idx].off = { dx: Math.cos(angle), dy: Math.sin(angle) };
      out[idx].crowd = n;
    });
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
