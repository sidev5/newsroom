import { STORY_LIMITS as L } from "@/lib/config";
import { CODE_LANGUAGE_IDS, type CodeLanguage } from "./languages";
import type { Block, BlocksDoc, BlockType } from "./blocks";

// The state of the block editor on the Write page, and the pure functions that change it. No React and no browser here, so the
// rules (insert anywhere, move, delete, limits, what is kept in the draft) are tested in plain Node.

export type EditorBlock =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; level: 2 | 3; text: string }
  | { id: string; type: "image"; alt: string; caption: string; fileName: string }
  | { id: string; type: "code"; language: CodeLanguage; filename: string; code: string }
  | { id: string; type: "quote"; text: string; cite: string }
  | { id: string; type: "list"; ordered: boolean; itemsText: string }
  | { id: string; type: "divider" }
  | { id: string; type: "link"; url: string; title: string; description: string };

export const BLOCK_LABELS: Record<BlockType, string> = {
  paragraph: "Paragraph",
  heading: "Heading",
  image: "Image",
  code: "Code",
  quote: "Quote",
  list: "List",
  divider: "Divider",
  link: "Link",
};

/** The entries of the "+" menu: heading and list each come in two forms. */
export type MenuChoice = { key: string; label: string; make: (id: string) => EditorBlock };
export const MENU: MenuChoice[] = [
  { key: "paragraph", label: "Paragraph", make: (id) => ({ id, type: "paragraph", text: "" }) },
  { key: "h2", label: "Heading (H2)", make: (id) => ({ id, type: "heading", level: 2, text: "" }) },
  { key: "h3", label: "Heading (H3)", make: (id) => ({ id, type: "heading", level: 3, text: "" }) },
  { key: "image", label: "Image", make: (id) => ({ id, type: "image", alt: "", caption: "", fileName: "" }) },
  { key: "code", label: "Code", make: (id) => ({ id, type: "code", language: "js", filename: "", code: "" }) },
  { key: "quote", label: "Quote", make: (id) => ({ id, type: "quote", text: "", cite: "" }) },
  { key: "ul", label: "Bulleted list", make: (id) => ({ id, type: "list", ordered: false, itemsText: "" }) },
  { key: "ol", label: "Numbered list", make: (id) => ({ id, type: "list", ordered: true, itemsText: "" }) },
  { key: "divider", label: "Divider", make: (id) => ({ id, type: "divider" }) },
  { key: "link", label: "Link", make: (id) => ({ id, type: "link", url: "", title: "", description: "" }) },
];

/** A block id that is unique within the story (the schema allows letters, digits, "-" and "_"). */
export function newBlockId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    const id = `b${Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0")}`;
    if (!taken.has(id)) return id;
  }
}

export const imageCount = (blocks: readonly EditorBlock[]) => blocks.filter((b) => b.type === "image").length;

/** Why a block of this kind cannot be added now, or null. */
export function cannotAdd(blocks: readonly EditorBlock[], choice: MenuChoice): string | null {
  if (blocks.length >= L.MAX_BLOCKS) return `A story can have at most ${L.MAX_BLOCKS} blocks.`;
  if (choice.key === "image" && imageCount(blocks) >= L.MAX_IMAGES) return `A story can have at most ${L.MAX_IMAGES} images.`;
  return null;
}

/** Inserts `block` so that it ends up at `index` (0 is the very start). Out-of-range indexes are clamped. */
export function insertAt(blocks: readonly EditorBlock[], index: number, block: EditorBlock): EditorBlock[] {
  const at = Math.max(0, Math.min(blocks.length, index));
  return [...blocks.slice(0, at), block, ...blocks.slice(at)];
}

export function removeAt(blocks: readonly EditorBlock[], index: number): EditorBlock[] {
  return blocks.filter((_, i) => i !== index);
}

/** Moves the block at `index` up (-1) or down (+1). Moving past an end changes nothing. */
export function moveBlock(blocks: readonly EditorBlock[], index: number, direction: -1 | 1): EditorBlock[] {
  const to = index + direction;
  if (index < 0 || index >= blocks.length || to < 0 || to >= blocks.length) return [...blocks];
  const next = [...blocks];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export const replaceAt = (blocks: readonly EditorBlock[], index: number, block: EditorBlock): EditorBlock[] => blocks.map((b, i) => (i === index ? block : b));

/** What the browser sends as `blocks`: the editor state in the shape the server's schema reads. */
export function toSubmitDoc(blocks: readonly EditorBlock[]): { v: 1; blocks: unknown[] } {
  return {
    v: 1,
    blocks: blocks.map((b): unknown => {
      switch (b.type) {
        case "list":
          return { id: b.id, type: "list", ordered: b.ordered, items: b.itemsText.split("\n") };
        case "code":
          return { id: b.id, type: "code", language: b.language, filename: b.filename, code: b.code };
        case "image":
          return { id: b.id, type: "image", alt: b.alt, caption: b.caption };
        default: {
          const { fileName: _ignored, ...rest } = b as typeof b & { fileName?: string };
          void _ignored;
          return rest;
        }
      }
    }),
  };
}

/** The editor state as blocks to draw in the preview (the same component as the reader), with images given by `images`. */
export function toPreviewDoc(blocks: readonly EditorBlock[]): BlocksDoc {
  const out: Block[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "paragraph":
        if (b.text.trim()) out.push({ id: b.id, type: "paragraph", text: b.text.trim() });
        break;
      case "heading":
        if (b.text.trim()) out.push({ id: b.id, type: "heading", level: b.level, text: b.text.trim() });
        break;
      case "image":
        out.push({ id: b.id, type: "image", alt: b.alt.trim(), caption: b.caption.trim() });
        break;
      case "code":
        if (b.code.trim()) out.push({ id: b.id, type: "code", language: b.language, filename: b.filename.trim() || undefined, code: b.code });
        break;
      case "quote":
        if (b.text.trim()) out.push({ id: b.id, type: "quote", text: b.text.trim(), cite: b.cite.trim() || undefined });
        break;
      case "list": {
        const items = b.itemsText.split("\n").map((i) => i.trim()).filter(Boolean);
        if (items.length) out.push({ id: b.id, type: "list", ordered: b.ordered, items });
        break;
      }
      case "divider":
        out.push({ id: b.id, type: "divider" });
        break;
      case "link":
        if (b.url.trim() && b.title.trim()) out.push({ id: b.id, type: "link", url: b.url.trim(), title: b.title.trim(), description: b.description.trim() || undefined });
        break;
    }
  }
  return { v: 1, blocks: out };
}

// ---------------------------------------------------------------------------------------------------------------------
// The draft kept in the browser (localStorage)
// ---------------------------------------------------------------------------------------------------------------------

export const DRAFT_KEY = "newsroom-write-draft-v1";

export type Draft = { savedAt: string; title: string; summary: string; sector: string; blocks: EditorBlock[] };

/**
 * The draft as stored. Only the story is kept: not the name, the email or the images' files (a file has to be chosen again;
 * the description and caption stay). A shared computer therefore keeps no personal data.
 */
export function serializeDraft(input: { title: string; summary: string; sector: string; blocks: readonly EditorBlock[] }, now: Date): string {
  // A file name can hold a person's name: it is not kept.
  const blocks = input.blocks.map((b) => (b.type === "image" ? { ...b, fileName: "" } : b));
  return JSON.stringify({ savedAt: now.toISOString(), title: input.title, summary: input.summary, sector: input.sector, blocks } satisfies Omit<Draft, "blocks"> & { blocks: readonly EditorBlock[] });
}

const str = (v: unknown, max = 200_000): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Reads a stored draft defensively: anything unexpected is dropped, and a draft that is not usable gives null. */
export function parseDraft(raw: string | null | undefined): Draft | null {
  if (!raw || raw.length > 2_000_000) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.blocks)) return null;
  const blocks: EditorBlock[] = [];
  const seen = new Set<string>();
  for (const item of d.blocks.slice(0, L.MAX_BLOCKS)) {
    const b = item as Record<string, unknown> | null;
    if (!b || typeof b !== "object") continue;
    const id = typeof b.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(b.id) && !seen.has(b.id) ? b.id : null;
    if (!id) continue;
    seen.add(id);
    switch (b.type) {
      case "paragraph":
        blocks.push({ id, type: "paragraph", text: str(b.text, L.PARAGRAPH_MAX * 2) });
        break;
      case "heading":
        blocks.push({ id, type: "heading", level: b.level === 3 ? 3 : 2, text: str(b.text, L.HEADING_MAX * 2) });
        break;
      case "image":
        blocks.push({ id, type: "image", alt: str(b.alt, L.ALT_MAX * 2), caption: str(b.caption, L.CAPTION_MAX * 2), fileName: "" });
        break;
      case "code":
        blocks.push({ id, type: "code", language: (CODE_LANGUAGE_IDS as readonly string[]).includes(b.language as string) ? (b.language as CodeLanguage) : "plain", filename: str(b.filename, L.FILENAME_MAX * 2), code: str(b.code, L.CODE_MAX * 2) });
        break;
      case "quote":
        blocks.push({ id, type: "quote", text: str(b.text, L.QUOTE_MAX * 2), cite: str(b.cite, L.CITE_MAX * 2) });
        break;
      case "list":
        blocks.push({ id, type: "list", ordered: b.ordered === true, itemsText: str(b.itemsText, L.LIST_ITEM_MAX * L.LIST_ITEMS_MAX) });
        break;
      case "divider":
        blocks.push({ id, type: "divider" });
        break;
      case "link":
        blocks.push({ id, type: "link", url: str(b.url, L.URL_MAX * 2), title: str(b.title, L.LINK_TITLE_MAX * 2), description: str(b.description, L.LINK_DESCRIPTION_MAX * 2) });
        break;
    }
  }
  return { savedAt: str(d.savedAt, 40), title: str(d.title, L.TITLE_MAX * 2), summary: str(d.summary, L.SUMMARY_MAX * 2), sector: str(d.sector, 80), blocks };
}

/** True when a draft holds nothing worth offering back. */
export const isEmptyDraft = (d: Pick<Draft, "title" | "summary" | "blocks">): boolean =>
  !d.title.trim() && !d.summary.trim() && d.blocks.every(isBlank);

function isBlank(b: EditorBlock): boolean {
  switch (b.type) {
    case "paragraph":
    case "heading":
    case "quote":
      return !b.text.trim();
    case "list":
      return !b.itemsText.trim();
    case "code":
      return !b.code.trim();
    case "link":
      return !b.url.trim() && !b.title.trim();
    case "image":
      return !b.alt.trim() && !b.caption.trim();
    case "divider":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------------------------------

/** The size an image is scaled to so that its longest side is at most `max` (never enlarged). */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest <= 0) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The types the editor offers in the file picker (the server checks the real bytes again). */
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";
