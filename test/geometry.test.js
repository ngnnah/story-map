import test from 'node:test';
import assert from 'node:assert/strict';
import { segLengths, length, pointAt, clip, dodge, headingAt } from '../js/geometry.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);
const straight = [{ x: 0, y: 0 }, { x: 1, y: 0 }];

// A bent line whose two segments have very different lengths: the whole point
// of arc-length parameterisation is that t=0.5 lands past the corner, not on it.
const bent = [{ x: 0, y: 0 }, { x: 0.9, y: 0 }, { x: 0.9, y: 0.1 }];

test('length sums the segments', () => {
  near(length(straight), 1);
  near(length(bent), 1.0);
  near(length([{ x: 0, y: 0 }]), 0);
  assert.deepEqual(segLengths([{ x: 0, y: 0 }]), []);
});

test('pointAt interpolates the midpoint of a straight line', () => {
  const p = pointAt(straight, 0.5);
  near(p.x, 0.5);
  near(p.y, 0);
});

test('pointAt clamps outside 0..1 and survives NaN', () => {
  assert.deepEqual(pointAt(straight, -1), { x: 0, y: 0 });
  assert.deepEqual(pointAt(straight, 2), { x: 1, y: 0 });
  assert.deepEqual(pointAt(straight, NaN), { x: 0, y: 0 });
});

test('pointAt is parameterised by arc length, not by segment index', () => {
  // Total length 1.0: 0.9 along, then 0.1 up. At t=0.5 an index-based
  // parameterisation would sit at the corner (0.9, 0). Arc length puts us at
  // 0.5 of the way along the first segment.
  const p = pointAt(bent, 0.5);
  near(p.x, 0.5);
  near(p.y, 0);

  // At t=0.95 we are 0.05 up the short second segment.
  const q = pointAt(bent, 0.95);
  near(q.x, 0.9);
  near(q.y, 0.05);
});

test('pointAt handles degenerate lines', () => {
  const same = [{ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 }];
  assert.deepEqual(pointAt(same, 0.5), { x: 0.3, y: 0.3 });
  assert.deepEqual(pointAt([{ x: 0.2, y: 0.4 }], 0.7), { x: 0.2, y: 0.4 });
  assert.throws(() => pointAt([], 0.5), /empty polyline/);
});

test('clip ends exactly where pointAt says the pin is', () => {
  for (const t of [0.1, 0.25, 0.5, 0.73, 0.95]) {
    const tail = clip(bent, t).at(-1);
    const pin = pointAt(bent, t);
    near(tail.x, pin.x, 1e-12);
    near(tail.y, pin.y, 1e-12);
  }
});

test('clip keeps the corner once it is passed', () => {
  const c = clip(bent, 0.95);
  assert.equal(c.length, 3);          // start, corner, current
  near(c[1].x, 0.9);
  near(c[1].y, 0);
});

test('clip at the extremes', () => {
  assert.deepEqual(clip(bent, 0), [{ x: 0, y: 0 }]);
  assert.equal(clip(bent, 1).length, 3);
  assert.deepEqual(clip([], 0.5), []);
});

test('dodge leaves a lone pin with no offset', () => {
  const out = dodge([{ id: 'a', x: 0.5, y: 0.5 }]);
  assert.equal(out[0].off, null);
  assert.equal(out[0].crowd, 1);
  assert.deepEqual([out[0].x, out[0].y], [0.5, 0.5]);
});

test('dodge gives co-located pins distinct unit offsets and keeps input order', () => {
  const pins = [
    { id: 'a', x: 0.5, y: 0.5 },
    { id: 'b', x: 0.5, y: 0.5 },
    { id: 'c', x: 0.1, y: 0.9 },
  ];
  const out = dodge(pins);
  assert.deepEqual(out.map((p) => p.id), ['a', 'b', 'c']);
  assert.equal(out[0].crowd, 2);
  assert.equal(out[1].crowd, 2);
  assert.notDeepEqual(out[0].off, out[1].off);
  assert.equal(out[2].off, null);
});

test('dodge offsets are unit vectors, so the renderer sets the pixel spread', () => {
  const pins = [
    { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 },
  ];
  for (const p of dodge(pins)) near(Math.hypot(p.off.dx, p.off.dy), 1);
});

test('dodge never moves the underlying position', () => {
  const pins = [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }];
  for (const p of dodge(pins)) assert.deepEqual([p.x, p.y], [0.5, 0.5]);
});

test('dodge is deterministic', () => {
  const pins = [
    { id: 'a', x: 0.5, y: 0.5 },
    { id: 'b', x: 0.5, y: 0.5 },
    { id: 'c', x: 0.5, y: 0.5 },
  ];
  assert.deepEqual(dodge(pins), dodge(pins));
});

test('headingAt points along the current segment', () => {
  const h = headingAt(bent, 0.2);
  near(h.x, 1);
  near(h.y, 0);
  const v = headingAt(bent, 0.99);
  near(v.x, 0);
  near(v.y, 1);
  assert.equal(headingAt([{ x: 0, y: 0 }], 0.5), null);
  assert.equal(headingAt([{ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.2 }], 0.5), null);
});

// --- dodge: clustering by screen-space proximity ---------------------------
//
// The renderer works in pixels, dodge works in square map space, so the tests
// speak both: PX is one screen pixel expressed in map units at fit zoom on a
// 1440px-wide window (the map is one unit wide, letterboxed to the viewport).
// CLUSTER_R is the radius view.js would pass — about two pin diameters.
const PX = 1 / 1440;
const CLUSTER_R = 16 * PX;

const permutations = (arr) => {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
};
const crowdsById = (pins, r) =>
  Object.fromEntries(dodge(pins, r).map((p) => [p.id, p.crowd]));

test('dodge fans out pins a few pixels apart, which exact-equality never did', () => {
  // The Elfstones case: two places three screen pixels apart. Keyed on
  // coordinate equality these overlap and one pin is invisible.
  const pins = [
    { id: 'a', x: 0.20, y: 0.30 },
    { id: 'b', x: 0.20 + 3 * PX, y: 0.30 + 1 * PX },
  ];
  const out = dodge(pins, CLUSTER_R);
  assert.deepEqual(out.map((p) => p.crowd), [2, 2]);
  assert.notDeepEqual(out[0].off, out[1].off);
  for (const p of out) near(Math.hypot(p.off.dx, p.off.dy), 1);
  // and the offsets stay offsets: the position itself is untouched
  assert.deepEqual([out[0].x, out[0].y], [0.20, 0.30]);
});

test('dodge leaves pins outside the radius alone', () => {
  const out = dodge([
    { id: 'a', x: 0.20, y: 0.30 },
    { id: 'b', x: 0.20 + 40 * PX, y: 0.30 },
  ], CLUSTER_R);
  assert.deepEqual(out.map((p) => p.crowd), [1, 1]);
  assert.deepEqual(out.map((p) => p.off), [null, null]);
});

test('dodge with a radius still leaves a lone pin, and an empty list, alone', () => {
  const out = dodge([{ id: 'a', x: 0.2, y: 0.3 }], CLUSTER_R);
  assert.equal(out[0].off, null);
  assert.equal(out[0].crowd, 1);
  assert.deepEqual(dodge([], CLUSTER_R), []);
  assert.deepEqual(dodge([]), []);
});

test('dodge groups the same set of pins the same way whatever order they arrive in', () => {
  // A first-wins sweep would make c join a-or-b depending on who it met first.
  const pins = [
    { id: 'a', x: 0.20, y: 0.30 },
    { id: 'b', x: 0.20 + 4 * PX, y: 0.30 },
    { id: 'c', x: 0.20 + 2 * PX, y: 0.30 + 5 * PX },
    { id: 'd', x: 0.50, y: 0.70 },
  ];
  const want = { a: 3, b: 3, c: 3, d: 1 };
  for (const perm of permutations(pins)) {
    assert.deepEqual(crowdsById(perm, CLUSTER_R), want, `order ${perm.map((p) => p.id)}`);
  }
});

test('dodge chains: A-B and B-C close, A-C not, is one group of three', () => {
  // DECIDED: single-linkage. A pin overlapping its neighbour is a drawing
  // problem whether or not the far end of the chain overlaps it, and the
  // alternative (a partition that depends on which pair you cut) is not
  // order-independent. The cost is over-spreading, never a lost pin.
  const chain = [
    { id: 'a', x: 0.20, y: 0.30 },
    { id: 'b', x: 0.20 + 12 * PX, y: 0.30 },
    { id: 'c', x: 0.20 + 24 * PX, y: 0.30 },
  ];
  assert.deepEqual(dodge(chain, CLUSTER_R).map((p) => p.crowd), [3, 3, 3]);
  for (const perm of permutations(chain)) {
    assert.deepEqual(crowdsById(perm, CLUSTER_R), { a: 3, b: 3, c: 3 });
  }
  // One more link out and the far pin is its own group again.
  const broken = [...chain, { id: 'd', x: 0.20 + 60 * PX, y: 0.30 }];
  assert.deepEqual(crowdsById(broken, CLUSTER_R), { a: 3, b: 3, c: 3, d: 1 });
});

test('dodge is deterministic with a radius: same input, identical output', () => {
  const pins = [
    { id: 'a', x: 0.20, y: 0.30 },
    { id: 'b', x: 0.20 + 3 * PX, y: 0.30 },
    { id: 'c', x: 0.20 + 6 * PX, y: 0.30 },
  ];
  assert.deepEqual(dodge(pins, CLUSTER_R), dodge(pins, CLUSTER_R));
  assert.deepEqual(dodge(pins, CLUSTER_R), dodge(pins.map((p) => ({ ...p })), CLUSTER_R));
});

test('dodge without a radius still means coincidence, as it always has', () => {
  const pins = [
    { id: 'a', x: 0.5, y: 0.5 },
    { id: 'b', x: 0.5, y: 0.5 },
    { id: 'c', x: 0.5 + 3 * PX, y: 0.5 },
  ];
  const out = dodge(pins);
  assert.deepEqual(out.map((p) => p.crowd), [2, 2, 1]);
  assert.equal(out[2].off, null);
  assert.deepEqual(out.map((p) => p.id), ['a', 'b', 'c']);
});

test('dodge names each cluster so the renderer can group by it', () => {
  const pins = [
    { who: 'a', x: 0.10, y: 0.10 },
    { who: 'b', x: 0.101, y: 0.10 },   // with a
    { who: 'c', x: 0.80, y: 0.80 },
    { who: 'd', x: 0.801, y: 0.80 },   // with c
    { who: 'e', x: 0.50, y: 0.50 },    // alone
  ];
  const out = dodge(pins, 0.01);
  const id = (w) => out.find((p) => p.who === w).cluster;
  assert.equal(id('a'), id('b'));
  assert.equal(id('c'), id('d'));
  assert.notEqual(id('a'), id('c'), 'two separate pairs must not share a cluster');
  assert.notEqual(id('a'), id('e'));
  // Two groups of two: `crowd` alone cannot tell them apart, which is the point.
  assert.equal(out.find((p) => p.who === 'a').crowd, 2);
  assert.equal(out.find((p) => p.who === 'c').crowd, 2);
});
