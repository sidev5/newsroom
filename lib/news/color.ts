// Colour helpers for the globe. Pure.

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/**
 * Mixes `color` into `base`: t = 0 is the base, t = 1 the colour. Used to give a country with news a
 * light version of its department colour on top of the land colour. An unparseable input returns `base`.
 */
export function tint(color: string, base: string, t: number): string {
  const c = parseHex(color);
  const b = parseHex(base);
  if (!b) return base;
  if (!c) return `#${b.map(toHex).join("")}`;
  const k = Math.max(0, Math.min(1, t));
  return `#${c.map((v, i) => toHex(b[i] + (v - b[i]) * k)).join("")}`;
}
