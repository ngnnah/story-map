// Role silhouettes for character pins.
//
// Pure data: a name -> SVG path string, drawn in a square box `ICON_BOX` wide
// and centred on (ICON_BOX/2, ICON_BOX/2) so a caller can place one by
// translating to the pin and scaling by `size / ICON_BOX` — no offsets to
// remember, no DOM, no globals.
//
// They are silhouettes, not line art: every subpath is closed and filled with
// the character's colour, because a filled shape survives being drawn 18px
// wide over an illustrated map and a hairline outline does not. Subpaths
// overlap on purpose — head, horns and body union into one figure under the
// default nonzero fill rule — which keeps each path short and editable.
//
// The silhouette says *role*; the fill still says *who*. The caller keeps the
// dark keyline (`stroke: var(--keyline)`), which a figure needs more than a
// disc does: its edge is longer and thinner.

/** The box every path is drawn in. Exported so no caller hardcodes 24. */
export const ICON_BOX = 24;

/**
 * The shortest figure's height as a fraction of `ICON_BOX` — every icon fills
 * at least this much of its box vertically (they run 0.70 to 0.79; the rest is
 * margin). A caller that has decided how wide to draw the box can multiply by
 * this to get the smallest the drawing will actually come out, which is the
 * number that decides whether a silhouette is still legible.
 */
export const ICON_FILL = 0.70;

/**
 * The icon used when a name is not in the table: a generic standing figure.
 * A typo in a book's data should still put a person on the map rather than
 * silently dropping back to a featureless dot.
 */
export const FALLBACK_ICON = 'man';

export const ICONS = Object.freeze({
  // hooded robe, peaked cowl, staff on the right
  druid: 'M10.8 2.8c-2.6 0-4.2 2.2-3.7 4.8L4.4 20.8h12.8L14.3 7.6c.5-2.6-1.1-4.8-3.5-4.8ZM18 2.6h1.5v18.2H18Z',
  // slim figure, two long ears swept out sideways (not up: up reads as horns)
  elf: 'M9.1 7.2a2.9 2.9 0 1 0 5.8 0 2.9 2.9 0 1 0-5.8 0ZM9.6 5.6 5.6 4 9.8 8.6ZM14.4 5.6 18.4 4 14.2 8.6ZM12 10.2c-2.5 0-4.2 1.8-4.2 4.6v6h8.4v-6c0-2.8-1.7-4.6-4.2-4.6Z',
  // squat and broad; the beard is wider than the head and clears the
  // shoulders, since same-colour subpaths only show where they overhang
  dwarf: 'M12 3a3.6 3.6 0 0 0-3.6 3.6c0 1.2-1.4 1.6-1.4 3.4 0 2.6 2.2 4.6 5 4.6s5-2 5-4.6c0-1.8-1.4-2.2-1.4-3.4A3.6 3.6 0 0 0 12 3ZM12 13c-4 0-6.8 2-6.8 4.6V21h13.6v-3.4c0-2.6-2.8-4.6-6.8-4.6Z',
  // plain standing figure: round head, square shoulders
  man: 'M8.7 6.6a3.3 3.3 0 1 0 6.6 0 3.3 3.3 0 1 0-6.6 0ZM12 10.4c-3.6 0-6.1 2.5-6.1 5.9v4.4h12.2v-4.4c0-3.4-2.5-5.9-6.1-5.9Z',
  // round head over a skirt flaring to the hem
  woman: 'M8.8 6.4a3.2 3.2 0 1 0 6.4 0 3.2 3.2 0 1 0-6.4 0ZM12 10c-2.2 0-3.7 1.5-4.2 3.6L5.4 20.8h13.2l-2.4-7.2C15.7 11.5 14.2 10 12 10Z',
  // hulking shoulders, small head, two horns
  troll: 'M9.2 7a2.8 2.8 0 1 0 5.6 0 2.8 2.8 0 1 0-5.6 0ZM9.8 4.8 6.8 1.8 8.2 5.8ZM14.2 4.8 17.2 1.8 15.8 5.8ZM12 9.4c-4.8 0-8 2.7-8 6.3v5.1h16v-5.1c0-3.6-3.2-6.3-8-6.3Z',
  // small body under a pointed hat with a flared brim — the brim is what
  // stops the hat reading as an arrowhead welded to a torso
  gnome: 'M12 2 7.6 9H5.4l1.6 1.8h10l1.6-1.8H16.4ZM9.6 13a2.4 2.4 0 1 0 4.8 0 2.4 2.4 0 1 0-4.8 0ZM12 15c-2.5 0-4 1.5-4 3.6v2.2h8v-2.2c0-2.1-1.5-3.6-4-3.6Z',
});

/** Every name this module knows, in declaration order. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/** Whether `name` is one of ours — for validation, not for drawing. */
export const hasIcon = (name) => typeof name === 'string' && name in ICONS;

/**
 * The path data for `name`. An unknown or missing name returns the
 * `FALLBACK_ICON` path, so this never returns undefined and a caller can draw
 * whatever comes back. Deciding that a character has no icon at all is the
 * caller's job — ask before you ask for a path.
 */
export const iconPath = (name) => (hasIcon(name) ? ICONS[name] : ICONS[FALLBACK_ICON]);
