import type { Block, BlocksDoc } from "./blocks";

// Small helpers that the homepage's reader needs. They live apart from blocks.ts (which builds the zod schemas) so that
// importing them does not pull the validation library into the homepage's JavaScript.

/** The reading text of a block (code and images excluded). */
export function proseOf(b: Block): string[] {
  switch (b.type) {
    case "paragraph":
    case "heading":
    case "quote":
      return [b.text];
    case "list":
      return b.items;
    default:
      return [];
  }
}

/** Minutes to read the story at 200 words a minute (code and images not counted); at least 1. */
export function readingMinutes(doc: BlocksDoc): number {
  const words = doc.blocks.flatMap(proseOf).join(" ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}