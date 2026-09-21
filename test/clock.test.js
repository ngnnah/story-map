// The clock is the one module with a feel rather than an output, so these
// tests pin the two properties the design rests on — it never overshoots, and
// it always arrives — plus the axis units and the reading wall.
//
// It touches three browser globals in its constructor. Stubbing them is the
// whole reason there was no test file; it costs four lines.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.matchMedia ??= () => ({ matches: false });
globalThis.performance ??= { now: () => 0 };
globalThis.requestAnimationFrame ??= () => 0;

const { Clock } = await import('../js/clock.js');

/** A clock that never schedules itself; frames are delivered by hand. */
function makeClock(opts = {}) {
  const frames = [];
  const c = new Clock({ min: 1, max: 726, onFrame: (p) => frames.push(p), ...opts });
  c.frames = frames;
  return c;
}
const run = (c, n = 400, dt = 16) => {
  let t = 0;
  for (let i = 0; i < n; i++) { t += dt; c._last = t - dt; c._tick(t); }
};

test('a page-axis book plays in about two and a half minutes', () => {
  const c = makeClock();
  assert.ok(c.basePps > 4 && c.basePps < 6, `basePps was ${c.basePps}`);
});

test('a chapter-axis book does not play the whole novel in thirty seconds', () => {
  const c = makeClock({ min: 1, max: 61, axis: 'chapter' });
  const seconds = (c.max - c.min) / c.basePps;
  assert.ok(seconds > 60, `whole book played in ${seconds.toFixed(0)}s`);
});

test('the ritard window is a fraction of the book, not most of it', () => {
  const c = makeClock({ min: 1, max: 61, axis: 'chapter' });
  assert.ok(c.ritardWidth / (c.max - c.min) < 0.1,
    `ritard covered ${(100 * c.ritardWidth / (c.max - c.min)).toFixed(0)}% of the book`);
});

test('settle snaps to a whole page, or a tenth of a chapter', () => {
  const p = makeClock();
  p.target = 45.4; p.settle({ snapToEvents: false });
  assert.equal(p.target, 45);

  const ch = makeClock({ min: 1, max: 61, axis: 'chapter' });
  ch.target = 12.44; ch.settle({ snapToEvents: false });
  assert.ok(Math.abs(ch.target - 12.4) < 1e-9, `snapped to ${ch.target}`);
});

test('settle never lands outside the book', () => {
  const c = makeClock();
  c.target = 9999; c.settle({ snapToEvents: false });
  assert.equal(c.target, 726);
  c.target = -50; c.settle({ snapToEvents: false });
  assert.equal(c.target, 1);
});

test('the chase never overshoots, at any frame length', () => {
  for (const dt of [1, 16, 50, 5000]) {
    for (const mode of ['drag', 'key', 'keyRepeat', 'play', 'idle']) {
      const c = makeClock();
      c.seek(400, mode);
      let t = 0;
      for (let i = 0; i < 200; i++) {
        t += dt; c._last = t - dt; c._tick(t);
        assert.ok(c.shown <= 400 + 1e-9, `${mode} dt=${dt} overshot to ${c.shown}`);
      }
    }
  }
});

test('the chase arrives exactly, rather than asymptotically', () => {
  const c = makeClock();
  c.seek(400, 'key');
  run(c, 600);
  assert.equal(c.shown, 400);
});

test('setRange clears an in-flight jump', () => {
  const c = makeClock();
  c.jumpTo(700);
  assert.ok(c.jump, 'expected a jump in flight');
  c.setRange(1, 96);
  assert.equal(c.jump, null);
  assert.ok(c.shown <= 96, `shown was ${c.shown}, outside the new range`);
});

// --- the reading wall ------------------------------------------------------

test('a ceiling stops seek, jump and playback', () => {
  const c = makeClock();
  c.setCeiling(100);
  c.seek(500);
  assert.equal(c.target, 100);
  c.jumpTo(700);
  assert.equal(c.target, 100);
  c.seek(99); c.play();
  run(c, 2000);
  assert.ok(c.shown <= 100 + 1e-9, `playback ran to ${c.shown}`);
  assert.equal(c.playing, false, 'playback should stop at the wall');
});

test('a ceiling leaves shown alone, unlike setRange', () => {
  const c = makeClock();
  c.seek(50); run(c, 400);
  assert.equal(c.shown, 50);
  c.setCeiling(300);
  assert.equal(c.shown, 50, 'setting the wall must not rewind the reader');
});

test('settle cannot snap past the ceiling onto an unread event', () => {
  const c = makeClock();
  c.setLoudPages([120]);
  c.setCeiling(100);
  c.target = 118;
  c.settle();
  assert.ok(c.target <= 100, `snapped to ${c.target}, past the wall`);
});

test('no ceiling means the book itself is the bound', () => {
  const c = makeClock();
  assert.equal(c.top(), 726);
  c.setCeiling(null);
  assert.equal(c.top(), 726);
});
