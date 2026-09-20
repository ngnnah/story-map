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
