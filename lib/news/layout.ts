// Sizes of the globe and the reader panel inside the map area. Pure, so the maths can be tested.

export const GLOBE_MAX_PX = 640;
export const GLOBE_HEIGHT_SHARE = 0.78;
export const GLOBE_WIDTH_SHARE = 0.92;
export const READER_MAX_PX = 540;
export const READER_WIDTH_SHARE = 0.7;
/** Largest the globe gets while the reader is open (the reader covers part of the map). */
export const OPEN_SCALE_MAX = 0.8;
export const OPEN_SCALE_MIN = 0.3;

/** Diameter of the globe: min(640px, 78% of the area's height, 92% of its width). */
export function globeDiameter(width: number, height: number): number {
  return Math.max(0, Math.min(GLOBE_MAX_PX, height * GLOBE_HEIGHT_SHARE, width * GLOBE_WIDTH_SHARE));
}

/** Width of the reader panel in a map area of this width. Matches `min(540px, 70%)` in the CSS. */
export function readerWidth(width: number): number {
  return Math.min(READER_MAX_PX, width * READER_WIDTH_SHARE);
}

/**
 * Scale for the globe while the reader is open: it shrinks to fit the free strip beside the reader
 * (with a little margin), but never above 0.8 or below 0.3.
 */
export function openScale(width: number, height: number): number {
  const d = globeDiameter(width, height);
  if (d <= 0) return OPEN_SCALE_MAX;
  const free = Math.max(0, width - readerWidth(width));
  return Math.max(OPEN_SCALE_MIN, Math.min(OPEN_SCALE_MAX, (free * 0.92) / d));
}
