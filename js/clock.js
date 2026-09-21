// The page clock: one float, one loop, one source of truth.
//
// Every pin position in the app is a pure function of `shown`. Nothing is ever
// tweened per-pin toward a position — do that and a single slider drag turns
// into eight pins arriving at eight different times, which reads as gelatin.
//
// The chase is exponential, not a spring. A spring overshoots; on a timeline
// overshoot means pages running backwards and trails retracting, which reads
// as a bug every time.

const HALF_LIFE = { drag: 25, key: 45, keyRepeat: 28, play: 30, idle: 45 };

// How the clock's feel constants scale, per axis. A page is a small step and a
// chapter is a large one, so every threshold tuned for a 726-page novel is
// wrong by two orders of magnitude on a 60-chapter one: the playback-speed
// clamp alone would run a whole book in thirty seconds and hold it permanently
// inside a ritard window.
const UNITS = {
  page:    { pps: [2, 8],     ritard: [4, 20],    snap: 1,   glide: 1 },
  chapter: { pps: [0.2, 1.5], ritard: [0.3, 1.5], snap: 0.1, glide: 0.1 },
};

export class Clock {
  constructor({ min, max, onFrame, axis = 'page' }) {
    this.min = min;
    this.max = max;
    this.onFrame = onFrame;
    this.target = min;
    this.shown = min;
    this.prev = min;
    this.mode = 'idle';
    this.playing = false;
    this.speed = 1;
    this.jump = null;
    this.ceiling = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.ritardAt = [];
    // Book-relative, so a 96-page fixture and a 726-page novel both play in
    // roughly two and a half minutes.
    this._setUnits(axis, min, max);
    this.slowNearEvents = true;
    this._last = performance.now();
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  _setUnits(axis, min, max) {
    const u = UNITS[axis] || UNITS.page;
    this.axis = axis;
    this.basePps = clamp((max - min) / 150, u.pps[0], u.pps[1]);
    this.ritardWidth = clamp(0.016 * (max - min), u.ritard[0], u.ritard[1]);
    this.snapStep = u.snap;
    this.glideThreshold = u.glide;
  }

  setRange(min, max, axis = this.axis) {
    this.min = min;
    this.max = max;
    this._setUnits(axis, min, max);
    // An in-flight jump still holds a destination in the old range and would
    // keep driving `shown` there for the rest of its duration.
    this.jump = null;
    this.target = this.shown = this.prev = min;
  }

  /**
   * The furthest position the reader has unlocked. Read-along sets this so the
   * clock cannot run past what they have read; it leaves `shown` alone, which
   * is why it is not just `setRange(min, ceiling)`.
   */
  setCeiling(v) {
    this.ceiling = Number.isFinite(v) ? v : null;
    if (this.target > this.top()) this.seek(this.top());
  }

  /** The effective upper bound: the book's end, or the reading wall. */
  top() {
    return this.ceiling === null || this.ceiling === undefined
      ? this.max
      : Math.min(this.max, this.ceiling);
  }

  /** Sorted pages of the events playback should linger on. */
  setLoudPages(pages) {
    this.ritardAt = [...pages].sort((a, b) => a - b);
  }

  /** Chase a page with the feel appropriate to how the user asked for it. */
  seek(page, mode = 'idle') {
    this.jump = null;
    this.target = clamp(page, this.min, this.top());
    this.mode = mode;
    if (this.reduced) this.shown = this.target;
  }

  /** A deliberate leap: chapter click, event hop, Home/End. */
  jumpTo(page) {
    const to = clamp(page, this.min, this.top());
    const d = Math.abs(to - this.shown);
    if (this.reduced || d < this.glideThreshold) { this.seek(to); this.shown = to; return; }
    this.jump = {
      from: this.shown,
      to,
      t0: performance.now(),
      dur: clamp(280 + 30 * Math.sqrt(d), 280, 700),
    };
    this.target = to;
  }

  play() {
    if (this.shown >= this.top() - 0.01) this.seek(this.min);
    this.playing = true;
    this.mode = 'play';
  }

  pause() {
    this.playing = false;
    this.mode = 'idle';
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  /**
   * Settle onto a whole page, with faint gravity toward a nearby event. The
   * window is 0.8% of the book, it only applies on release, and Alt disables
   * it — so it helps you land on the interesting page without ever fighting
   * you for the one you actually wanted.
   */
  settle({ snapToEvents = true } = {}) {
    const span = this.max - this.min;
    const nearest = this._nearestLoud(this.target);
    const snapped = snapToEvents && nearest !== null && Math.abs(nearest - this.target) <= 0.008 * span
      ? nearest
      // A whole page on the page axis, a tenth of a chapter on the chapter
      // axis — rounding to whole chapters would make 12.4 unreachable by drag.
      : Math.round(this.target / this.snapStep) * this.snapStep;
    // This has never been clamped, not even to the book. A loud page past the
    // reading wall would otherwise snap the thumb onto an unread event.
    this.target = clamp(snapped, this.min, this.top());
    this.mode = 'idle';
  }

  _nearestLoud(page) {
    if (!this.ritardAt.length) return null;
    let best = null;
    let bestD = Infinity;
    for (const p of this.ritardAt) {
      const d = Math.abs(p - page);
      if (d < bestD) { bestD = d; best = p; }
      else if (p > page) break;
    }
    return best;
  }

  /**
   * Playback slows to 0.45x approaching a meeting and recovers over about
   * fifteen pages. It is the difference between a progress bar and a camera,
   * and it never surprises because it always slows at something that is also
   * marked on the rail.
   */
  _ritard(page) {
    if (!this.slowNearEvents || !this.ritardAt.length) return 1;
    const near = this._nearestLoud(page);
    if (near === null) return 1;
    const d = Math.abs(near - page);
    if (d >= this.ritardWidth) return 1;
    const u = d / this.ritardWidth;
    return 0.45 + 0.55 * (u * u * (3 - 2 * u));
  }

  _tick(now) {
    const dt = Math.min(now - this._last, 50);      // tab-switch guard
    this._last = now;
    this.prev = this.shown;

    if (this.playing) {
      const rate = (this.basePps * this.speed) / 1000;
      this.target = clamp(this.target + rate * this._ritard(this.shown) * dt, this.min, this.top());
      if (this.target >= this.top()) this.pause();
    }

    if (this.jump) {
      const u = clamp((now - this.jump.t0) / this.jump.dur, 0, 1);
      const eased = 1 - (1 - u) ** 5;               // easeOutQuint
      this.shown = this.jump.from + (this.jump.to - this.jump.from) * eased;
      if (u >= 1) { this.shown = this.target = this.jump.to; this.jump = null; }
    } else if (this.reduced) {
      this.shown = this.target;
    } else {
      const hl = HALF_LIFE[this.mode] ?? HALF_LIFE.idle;
      this.shown += (this.target - this.shown) * (1 - 2 ** (-dt / hl));
      if (Math.abs(this.target - this.shown) < 0.02) this.shown = this.target;
    }

    this.onFrame(this.shown, this.prev, dt);
    requestAnimationFrame(this._tick);
  }
}

export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
