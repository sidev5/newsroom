import { z } from "zod";
import { STORY_LIMITS as L } from "@/lib/config";
import { safeHttpUrl } from "@/lib/news/format";
import { cleanLine, stripControl } from "@/lib/submissions/text";
import { CODE_LANGUAGE_IDS, type CodeLanguage } from "./languages";
import { proseOf, readingMinutes } from "./reading";

export { readingMinutes };

// Stories written on the Write page are stored as versioned JSON: { v: 1, blocks: [ { id, type, ... } ] }.
// This file is the one definition of that shape. The server validates every submission with it (the browser's checks are a
// convenience), and the reader renders only what came out of it, as React elements: no HTML is ever interpreted.
// Pure: no database, no network.

export type ImageBlock = {
  id: string;
  type: "image";
  /** Object path in the private submission-images bucket while the story waits for review. */
  path?: string;
  /** Public URL (article-images bucket) once the story is published. */
  src?: string;
  alt: string;
  caption: string;
  width?: number;
  height?: number;
  /**
   * An AI-written story only (lib/pipeline/blog.ts): what to search a stock photo site for. A block with a query and no src is a
   * placeholder that the image stage fills (with src, credit and creditUrl, and the query removed) or drops.
   */
  query?: string;
  /** The photographer, and the link to their profile (with the utm parameters), for a stock photo. Shown as the photo credit. */
  credit?: string;
  creditUrl?: string;
};

export type Block =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; level: 2 | 3; text: string }
  | ImageBlock
  | { id: string; type: "code"; language: CodeLanguage; filename?: string; code: string }
  | { id: string; type: "quote"; text: string; cite?: string }
  | { id: string; type: "list"; ordered: boolean; items: string[] }
  | { id: string; type: "divider" }
  | { id: string; type: "link"; url: string; title: string; description?: string };

export type BlockType = Block["type"];
export const BLOCK_TYPES: readonly BlockType[] = ["paragraph", "heading", "image", "code", "quote", "list", "divider", "link"];

export type BlocksDoc = { v: 1; blocks: Block[] };

export type BlockIssue = {
  /** The block the problem is in; null for a problem with the story as a whole. */
  blockId: string | null;
  message: string;
};

// ---------------------------------------------------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------------------------------------------------

/** Reading text: control characters removed, lines trimmed, runs of blank lines reduced to one. */
export function cleanText(value: string): string {
  return stripControl(value)
    .split("\n")
    .map((line) => line.replace(/[  ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Code: tabs and spaces are kept exactly, line endings become "\n", and the characters that hide or reorder code (bidi
 * overrides, zero-width marks, other control characters) are removed. Trailing blank lines are dropped.
 */
export function cleanCode(value: string): string {
  return stripControl(value, { keepTabs: true }).replace(/\s+$/, "");
}

// ---------------------------------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------------------------------

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "A block has an invalid id.");

const text = (max: number, label: string) =>
  z
    .string()
    .transform(cleanText)
    .superRefine((v, ctx) => {
      if (!v) ctx.addIssue({ code: "custom", message: `Write something in the ${label}, or delete it.` });
      else if (v.length > max) ctx.addIssue({ code: "custom", message: `The ${label} is too long (${v.length} of ${max} characters).` });
    });

const optionalLine = (max: number, label: string) =>
  z
    .string()
    .optional()
    .transform((v) => cleanLine(v ?? ""))
    .superRefine((v, ctx) => {
      if (v.length > max) ctx.addIssue({ code: "custom", message: `The ${label} is too long (${v.length} of ${max} characters).` });
    });

const requiredLine = (max: number, label: string) =>
  z
    .string()
    .transform(cleanLine)
    .superRefine((v, ctx) => {
      if (!v) ctx.addIssue({ code: "custom", message: `Fill in the ${label}.` });
      else if (v.length > max) ctx.addIssue({ code: "custom", message: `The ${label} is too long (${v.length} of ${max} characters).` });
    });

/** http(s) only, no credentials in the address, normalised. javascript:, data:, file: and the rest are refused. */
const url = z
  .string()
  .transform((v) => v.trim())
  .superRefine((v, ctx) => {
    if (!v) return ctx.addIssue({ code: "custom", message: "Enter the link address." });
    if (v.length > L.URL_MAX) return ctx.addIssue({ code: "custom", message: "The link address is too long." });
    const safe = safeHttpUrl(v);
    if (!safe || /\/\/[^/?#]*@/.test(safe)) ctx.addIssue({ code: "custom", message: "The link must start with http:// or https:// and must not contain a password." });
  })
  .transform((v) => safeHttpUrl(v) ?? v);

const paragraph = z.object({ id, type: z.literal("paragraph"), text: text(L.PARAGRAPH_MAX, "paragraph") });
const heading = z.object({ id, type: z.literal("heading"), level: z.union([z.literal(2), z.literal(3)]), text: text(L.HEADING_MAX, "heading") });
const quote = z.object({ id, type: z.literal("quote"), text: text(L.QUOTE_MAX, "quote"), cite: optionalLine(L.CITE_MAX, "source of the quote") });
const divider = z.object({ id, type: z.literal("divider") });
const link = z.object({ id, type: z.literal("link"), url, title: requiredLine(L.LINK_TITLE_MAX, "link title"), description: optionalLine(L.LINK_DESCRIPTION_MAX, "link description") });
const list = z.object({
  id,
  type: z.literal("list"),
  ordered: z.boolean(),
  items: z
    .array(z.string().transform(cleanLine))
    .transform((items) => items.filter(Boolean))
    .superRefine((items, ctx) => {
      if (items.length === 0) ctx.addIssue({ code: "custom", message: "Add at least one item to the list, or delete it." });
      if (items.length > L.LIST_ITEMS_MAX) ctx.addIssue({ code: "custom", message: `A list can have at most ${L.LIST_ITEMS_MAX} items.` });
      if (items.some((i) => i.length > L.LIST_ITEM_MAX)) ctx.addIssue({ code: "custom", message: `A list item can have at most ${L.LIST_ITEM_MAX} characters.` });
    }),
});
const code = z.object({
  id,
  type: z.literal("code"),
  language: z.enum(CODE_LANGUAGE_IDS, { error: "Choose a language for the code block." }),
  filename: optionalLine(L.FILENAME_MAX, "file name").transform((v) => v || undefined),
  code: z
    .string()
    .transform(cleanCode)
    .superRefine((v, ctx) => {
      if (!v.trim()) ctx.addIssue({ code: "custom", message: "The code block is empty. Paste some code, or delete it." });
      else if (v.length > L.CODE_MAX) ctx.addIssue({ code: "custom", message: `The code is too long (${v.length} of ${L.CODE_MAX} characters).` });
    }),
});

const dimension = z.number().int().min(1).max(10_000);

/** What the browser sends: an image block has its words and a file under the field "image:<id>" (the server fills in the rest). */
const submittedImage = z.object({
  id,
  type: z.literal("image"),
  alt: requiredLine(L.ALT_MAX, "image description (alt text)"),
  caption: optionalLine(L.CAPTION_MAX, "caption").transform((v) => v),
});

/**
 * What is stored: an image is in the private bucket (path), published (src), or, in an AI story that the image stage has not
 * reached yet, a placeholder with a search query. Never anything else.
 */
const storedImage = z
  .object({
    id,
    type: z.literal("image"),
    // <folder>/<name>.webp: no dots except the extension, so a path can never climb out of its folder.
    path: z.string().max(200).regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.webp$/).optional(),
    src: z.string().max(L.URL_MAX).refine((v) => safeHttpUrl(v) !== null && v.startsWith("https://")).optional(),
    alt: z.string().transform(cleanLine).pipe(z.string().max(L.ALT_MAX)),
    caption: z.string().transform(cleanLine).pipe(z.string().max(L.CAPTION_MAX)),
    width: dimension.optional(),
    height: dimension.optional(),
    query: z.string().transform(cleanLine).pipe(z.string().min(2).max(100)).optional(),
    credit: z.string().transform(cleanLine).pipe(z.string().min(1).max(200)).optional(),
    creditUrl: z.string().max(L.URL_MAX).refine((v) => safeHttpUrl(v) !== null && v.startsWith("https://")).optional(),
  })
  .refine((b) => Boolean(b.path || b.src || b.query), "An image block has no image.");
const docOf = (image: z.ZodType) =>
  z.object({
    v: z.literal(1, { error: "This story was made with a newer editor. Reload the page." }),
    blocks: z.array(z.discriminatedUnion("type", [paragraph, heading, image as typeof submittedImage, code, quote, list, divider, link])).min(1, "Add something to your story.").max(L.MAX_BLOCKS, `A story can have at most ${L.MAX_BLOCKS} blocks.`),
  });

const submittedDoc = docOf(submittedImage);
const storedDoc = docOf(storedImage);

// ---------------------------------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------------------------------

function allTextOf(b: Block): string[] {
  switch (b.type) {
    case "code":
      return [b.code, b.filename ?? ""];
    case "image":
      return [b.alt, b.caption];
    case "link":
      return [b.title, b.description ?? "", b.url];
    case "quote":
      return [b.text, b.cite ?? ""];
    default:
      return proseOf(b);
  }
}

export const proseLength = (doc: BlocksDoc): number => doc.blocks.flatMap(proseOf).reduce((n, t) => n + t.length, 0);
export const totalTextLength = (doc: BlocksDoc): number => doc.blocks.flatMap(allTextOf).reduce((n, t) => n + t.length, 0);
export const imageBlocks = (doc: BlocksDoc): ImageBlock[] => doc.blocks.filter((b): b is ImageBlock => b.type === "image");

// ---------------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------------

export type ParseResult = { ok: true; doc: BlocksDoc } | { ok: false; issues: BlockIssue[] };

function issuesOf(input: unknown, error: z.ZodError): BlockIssue[] {
  const raw = (input as { blocks?: unknown } | null)?.blocks;
  const blocks = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: BlockIssue[] = [];
  for (const issue of error.issues) {
    let blockId: string | null = null;
    if (issue.path[0] === "blocks" && typeof issue.path[1] === "number") {
      const candidate = (blocks[issue.path[1]] as { id?: unknown } | undefined)?.id;
      blockId = typeof candidate === "string" ? candidate : null;
    }
    let message = issue.message;
    // The union reports an unknown type as "Invalid input": say what is wrong.
    if (issue.code === "invalid_union" || /Invalid input/i.test(message)) message = "This block has a type the editor does not know. Delete it and add it again.";
    const key = `${blockId}:${message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ blockId, message });
    }
  }
  return out;
}

function checkDoc(doc: BlocksDoc, maxImages: number, requireProse: boolean): BlockIssue[] {
  const issues: BlockIssue[] = [];
  const ids = new Set<string>();
  for (const b of doc.blocks) {
    if (ids.has(b.id)) issues.push({ blockId: b.id, message: "Two blocks have the same id. Reload the page." });
    ids.add(b.id);
  }
  if (imageBlocks(doc).length > maxImages) issues.push({ blockId: null, message: `A story can have at most ${maxImages} images.` });
  if (totalTextLength(doc) > L.TOTAL_TEXT_MAX) issues.push({ blockId: null, message: `The story is too long (more than ${L.TOTAL_TEXT_MAX.toLocaleString("en")} characters in all).` });
  if (requireProse && proseLength(doc) < L.PROSE_MIN) {
    issues.push({ blockId: null, message: `Write at least ${L.PROSE_MIN} characters of text (paragraphs, headings, quotes or lists) so there is a story to read. You have ${proseLength(doc)}.` });
  }
  return issues;
}

/** The blocks a visitor of /submit sends. Unknown fields are dropped, unknown block types are refused. */
export function parseSubmittedDoc(input: unknown): ParseResult {
  const parsed = submittedDoc.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesOf(input, parsed.error) };
  const doc = parsed.data as BlocksDoc;
  const issues = checkDoc(doc, L.MAX_IMAGES, true);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, doc };
}

/**
 * Blocks read back from the database, or written by the AI. Same rules, but images carry `path`, `src` or (AI stories) a
 * `query`, and there is no minimum length. Says what is wrong, block by block.
 */
export function validateStoredDoc(input: unknown): ParseResult {
  const parsed = storedDoc.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesOf(input, parsed.error) };
  const doc = parsed.data as BlocksDoc;
  const issues = checkDoc(doc, L.MAX_IMAGES, false);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, doc };
}

/** The same, for code that only needs the document (or null). */
export function parseStoredDoc(input: unknown): BlocksDoc | null {
  const r = validateStoredDoc(input);
  return r.ok ? r.doc : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------------------------------------------------

const BODY_MAX = 20_000;

/**
 * The plain-text form of a story, stored in `articles.body` so everything that predates blocks (the digest, the card summary,
 * the page description, search) keeps working. Code and images are left out; paragraphs are separated by a blank line.
 */
export function blocksToPlainText(doc: BlocksDoc): string {
  const parts: string[] = [];
  for (const b of doc.blocks) {
    if (b.type === "paragraph" || b.type === "heading") parts.push(b.text);
    else if (b.type === "quote") parts.push(b.cite ? `"${b.text}" (${b.cite})` : `"${b.text}"`);
    else if (b.type === "list") parts.push(b.items.map((item, i) => (b.ordered ? `${i + 1}. ${item}` : `- ${item}`)).join("\n"));
    else if (b.type === "link") parts.push(b.title);
  }
  return parts.join("\n\n").slice(0, BODY_MAX);
}

/** The first paragraph's start, for a story that has no summary of its own. */
export function firstParagraph(doc: BlocksDoc): string {
  return doc.blocks.find((b): b is Extract<Block, { type: "paragraph" }> => b.type === "paragraph")?.text ?? "";
}
