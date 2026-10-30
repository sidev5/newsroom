import "server-only";
import { defaultImageFor, getImageProvider, type ImageProvider } from "@/lib/images";
import { ImageSearchError } from "@/lib/images/types";
import { processInChunks, resolveChunkSettings, type StageOptions } from "./chunks";
import { imageBlocks, parseStoredDoc, validateStoredDoc, type Block, type BlocksDoc, type ImageBlock } from "@/lib/stories/blocks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isMissingColumn } from "@/lib/supabase/errors";

export type ImageArticle = {
  id: string;
  image_query: string | null;
  department_slug: string | null;
  /** An AI-written blocks story: its blocks, with image placeholders (an image block with a search query and no address). */
  blocks?: BlocksDoc | null;
};

export type ImageUpdate = {
  image_url: string;
  image_credit: string | null;
  image_credit_url: string | null;
  /** Blocks story only: the blocks with every placeholder filled in or dropped. */
  body_blocks?: BlocksDoc;
};

export type ImageCounts = {
  processed: number;
  /** Got a photo from the provider. */
  found: number;
  /** Used the department default SVG (nothing found, API error, 429, or no query). */
  fallback: number;
  /** Saving the result failed; the article keeps no image and is retried next run. */
  failed: number;
  /** A blocks story left for the next run because Unsplash rate-limited the search for its pictures. */
  deferred: number;
  /** Pictures of blocks stories: placed from a search, and dropped because nothing was found (or it repeated another). */
  blockImages: { placed: number; dropped: number };
};

export type ImageDeps = {
  loadArticles: (limit: number) => Promise<ImageArticle[]>;
  /** Only updates rows that still have no image_url. */
  updateArticle: (id: string, update: ImageUpdate) => Promise<void>;
  /** Called once per run, and only when there is something to search for. */
  provider: () => ImageProvider;
};

const supabaseDeps: ImageDeps = {
  async loadArticles(limit) {
    const ask = (columns: string) =>
      supabaseAdmin().from("articles").select(columns).eq("status", "draft").is("image_url", null).order("created_at", { ascending: true }).limit(limit);
    // body_format / body_blocks exist after 2026-10-22_story_blocks.sql; until then only plain articles exist.
    let { data, error } = await ask("id, image_query, body_format, body_blocks, departments(slug)");
    if (error && isMissingColumn(error)) ({ data, error } = await ask("id, image_query, departments(slug)"));
    if (error) throw new Error(`Loading articles failed: ${error.message}`);
    type Row = { id: string; image_query: string | null; body_format?: string; body_blocks?: unknown; departments?: { slug: string } | { slug: string }[] | null };
    return ((data ?? []) as unknown as Row[]).map((row) => {
      const dept = row.departments;
      return {
        id: row.id,
        image_query: row.image_query ?? null,
        department_slug: (Array.isArray(dept) ? dept[0]?.slug : dept?.slug) ?? null,
        blocks: row.body_format === "blocks" ? parseStoredDoc(row.body_blocks) : null,
      };
    });
  },

  async updateArticle(id, update) {
    const { error } = await supabaseAdmin().from("articles").update(update).eq("id", id).is("image_url", null);
    if (error) throw new Error(error.message);
  },
  provider: getImageProvider,
};

const isPlaceholder = (b: Block): b is ImageBlock & { query: string } => b.type === "image" && !b.src && !b.path && Boolean(b.query);

export type FillResult = {
  doc: BlocksDoc;
  placed: number;
  dropped: number;
  /** Unsplash answered 429: the story is left for the next run rather than losing pictures that could be found later. */
  rateLimited: boolean;
};

/**
 * Fills the image placeholders of an AI-written story from the stock photo search, one search per placeholder, with the credit
 * stored on the block as it is stored for a cover photo. A placeholder with no result (or one that finds a photo already used in
 * the story) is dropped. The result goes through the story schema again; if it does not pass, every picture is dropped rather
 * than storing something unvalidated.
 */
export async function fillImagePlaceholders(doc: BlocksDoc, provider: ImageProvider, alreadyUsed: readonly string[] = [], log: (m: string) => void = console.error): Promise<FillResult> {
  const used = new Set(alreadyUsed);
  const blocks: Block[] = [];
  let placed = 0;
  let dropped = 0;
  for (const b of doc.blocks) {
    if (!isPlaceholder(b)) {
      blocks.push(b);
      continue;
    }
    try {
      const image = await provider.searchImage(b.query);
      if (image && !used.has(image.url)) {
        used.add(image.url);
        const { query: _query, ...rest } = b;
        void _query;
        blocks.push({ ...rest, src: image.url, ...(image.credit ? { credit: image.credit.slice(0, 200) } : {}), ...(image.creditUrl ? { creditUrl: image.creditUrl } : {}) });
        placed++;
      } else dropped++;
    } catch (err) {
      if (err instanceof ImageSearchError && err.rateLimited) return { doc, placed: 0, dropped: 0, rateLimited: true };
      log(`image search for a block failed: ${err instanceof Error ? err.message : String(err)}`);
      dropped++;
    }
  }
  const checked = validateStoredDoc({ v: 1, blocks });
  if (checked.ok) return { doc: checked.doc, placed, dropped, rateLimited: false };
  log(`filled story did not pass the block schema, pictures dropped: ${checked.issues.map((i) => i.message).join("; ").slice(0, 200)}`);
  const text = validateStoredDoc({ v: 1, blocks: doc.blocks.filter((b) => b.type !== "image") });
  return { doc: text.ok ? text.doc : doc, placed: 0, dropped: imageBlocks(doc).length, rateLimited: false };
}

/**
 * Unlike the LLM stages, an Unsplash 429 does not leave the chunk's remaining articles waiting: they
 * take their department's default image so they can move on (none is marked failed). It does end the
 * run, so later chunks stay queued, and it is reported through `report.rateLimited`.
 * The exception is an AI-written blocks story whose pictures could not be searched because of the 429: it stays queued for
 * the next run, since its pictures can still be found then.
 */
export async function runImage(
  overrides: Partial<ImageDeps> = {},
  opts: StageOptions = {},
  report: { rateLimited: boolean } = { rateLimited: false },
): Promise<ImageCounts> {
  const deps = { ...supabaseDeps, ...overrides };
  const counts: ImageCounts = { processed: 0, found: 0, fallback: 0, failed: 0, deferred: 0, blockImages: { placed: 0, dropped: 0 } };
  let provider: ImageProvider | null = null;

  await processInChunks(deps.loadArticles, resolveChunkSettings(opts), async (articles, ctx) => {
    // Created once per run, and only when there is something to search for.
    provider ??= deps.provider();
    // After a 429, stop calling the API for the rest of the chunk; the rest take the default.
    let rateLimited = false;

    for (const article of articles) {
      if (ctx.timeUp()) return "stop";
      let update: ImageUpdate | null = null;
      const query = article.image_query?.trim();
      const waiting = article.blocks ? article.blocks.blocks.filter(isPlaceholder).length : 0;

      // A blocks story with pictures to find: wait for the next run if the search is rate-limited.
      if (waiting > 0 && rateLimited) {
        counts.deferred++;
        continue;
      }

      if (query && !rateLimited) {
        try {
          const image = await provider.searchImage(query);
          if (image) update = { image_url: image.url, image_credit: image.credit, image_credit_url: image.creditUrl };
        } catch (err) {
          if (err instanceof ImageSearchError && err.rateLimited) rateLimited = true;
          console.error(`image search failed for article ${article.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      let blocksPatch: { body_blocks: BlocksDoc } | null = null;
      let placed = 0;
      let dropped = 0;
      if (article.blocks && waiting > 0) {
        if (rateLimited) {
          counts.deferred++;
          continue;
        }
        const filled = await fillImagePlaceholders(article.blocks, provider, update ? [update.image_url] : []);
        if (filled.rateLimited) {
          rateLimited = true;
          counts.deferred++;
          continue;
        }
        blocksPatch = { body_blocks: filled.doc };
        placed = filled.placed;
        dropped = filled.dropped;
      }

      const found = update !== null;
      update ??= { image_url: defaultImageFor(article.department_slug), image_credit: null, image_credit_url: null };

      try {
        await deps.updateArticle(article.id, { ...update, ...blocksPatch });
        counts.processed++;
        counts.blockImages.placed += placed;
        counts.blockImages.dropped += dropped;
        if (found) counts.found++;
        else counts.fallback++;
      } catch (err) {
        counts.failed++;
        console.error(`saving image for article ${article.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (rateLimited) report.rateLimited = true;
    return rateLimited ? "stop" : "continue";
  });
  return counts;
}