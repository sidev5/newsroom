import { parseHTML } from "linkedom";

export const MAX_FULL_TEXT_CHARS = 20_000;
export const MAX_SUMMARY_CHARS = 5_000;

const BLOCK_END = /<\/(p|div|li|h[1-6]|blockquote|section|article|tr|pre)>|<br\s*\/?>/gi;

/** Strip tags, scripts and styles; decode entities; keep paragraph breaks. */
export function htmlToText(html: string): string {
  if (!html) return "";
  // Mark block boundaries before parsing, since textContent drops them.
  const marked = html.replace(BLOCK_END, (m) => `${m}\n`);
  const { document } = parseHTML(`<!doctype html><html><body>${marked}</body></html>`);
  document.querySelectorAll("script, style, noscript, iframe, svg").forEach((el) => el.remove());
  const text = document.body.textContent ?? "";
  return text
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Truncate to `max` chars, preferring a word boundary. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.9 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
