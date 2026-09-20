import test from 'node:test';
import assert from 'node:assert/strict';
import { ICONS, ICON_NAMES, ICON_BOX, ICON_FILL, FALLBACK_ICON, hasIcon, iconPath } from '../js/icons.js';

const EXPECTED = ['druid', 'elf', 'dwarf', 'man', 'woman', 'troll', 'gnome'];

// Only the commands a silhouette needs, plus numbers. Anything else is a typo
// that a browser would swallow by ignoring the rest of the path.
const PATH_CHARS = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;

test('the seven starting roles are all there', () => {
  for (const name of EXPECTED) assert.ok(hasIcon(name), `missing icon "${name}"`);
  assert.deepEqual([...ICON_NAMES].sort(), [...EXPECTED].sort());
});

test('every icon is a non-empty path starting with a move', () => {
  for (const name of ICON_NAMES) {
    const d = ICONS[name];
    assert.equal(typeof d, 'string', `${name} is not a string`);
    assert.ok(d.length > 0, `${name} is empty`);
    assert.match(d, /^[Mm]/, `${name} does not start with a move command`);
    assert.match(d, PATH_CHARS, `${name} has a character no path command uses`);
    assert.doesNotMatch(d, /NaN|undefined/, `${name} has a bad number in it`);
  }
});

test('every icon is closed, because a silhouette is filled not stroked', () => {
  for (const name of ICON_NAMES) {
    assert.match(ICONS[name], /[Zz]\s*$/, `${name} does not close its last subpath`);
    // as many closes as moves: no subpath left open in the middle
    const moves = (ICONS[name].match(/[Mm]/g) || []).length;
    const closes = (ICONS[name].match(/[Zz]/g) || []).length;
    assert.equal(closes, moves, `${name} has ${moves} subpaths but ${closes} closes`);
  }
});

test('the lookup helper falls back rather than returning nothing', () => {
  assert.equal(iconPath('elf'), ICONS.elf);
  assert.ok(hasIcon(FALLBACK_ICON), 'the documented fallback is not itself an icon');
  for (const bad of ['wizard', '', 'ELF', undefined, null, 7, {}]) {
    assert.equal(iconPath(bad), ICONS[FALLBACK_ICON], `iconPath(${String(bad)}) did not fall back`);
  }
  assert.equal(hasIcon('wizard'), false);
  assert.equal(hasIcon(undefined), false);
});

test('the box size is exported, positive, and square', () => {
  assert.equal(typeof ICON_BOX, 'number');
  assert.ok(Number.isFinite(ICON_BOX) && ICON_BOX > 0, `ICON_BOX is ${ICON_BOX}`);
});

// Callers size the pin from this, so a nonsense value would silently decide
// that silhouettes are always — or never — legible.
test('the fill fraction is a fraction', () => {
  assert.equal(typeof ICON_FILL, 'number');
  assert.ok(ICON_FILL > 0 && ICON_FILL <= 1, `ICON_FILL is ${ICON_FILL}`);
});

test('the table is frozen: a book cannot scribble on the icon set', () => {
  assert.ok(Object.isFrozen(ICONS));
  assert.ok(Object.isFrozen(ICON_NAMES));
});

// Not a rendering test — that needs a browser — but every coordinate in the
// data must land inside the box the module promises, or callers that scale by
// size / ICON_BOX will clip.
test('every coordinate sits inside the box', () => {
  for (const name of ICON_NAMES) {
    for (const n of ICONS[name].match(/-?\d*\.?\d+/g) || []) {
      const v = Number(n);
      assert.ok(v >= -ICON_BOX && v <= ICON_BOX, `${name} has ${v}, outside the ${ICON_BOX} box`);
    }
  }
});
