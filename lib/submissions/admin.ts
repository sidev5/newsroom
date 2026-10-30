import "server-only";
import { randomUUID } from "node:crypto";
import { allowedImageUrl } from "@/lib/news/format";
import { SIGNED_URL_SECONDS, STORAGE_BUCKETS } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isMissingColumn } from "@/lib/supabase/errors";
import { parseStoredDoc, type Block, type BlocksDoc } from "@/lib/stories/blocks";
import type { SubmitterView } from "./types";

// Admin-side reads and writes for employee submissions. Every function uses the service role, so the
// caller must have passed the admin check first (the review page and lib/admin/review.ts do).

/** Columns to write on an article: text, null, or a JSON document. */
export type PatchColumns = Record<string, string | null | object>;

type SubmitterRow = {
  article_id: string;
  email: string;
  email_verified: boolean;
  submitted_at: string;
  image_path: string | null;
  first_name?: string | null;
  last_name?: string | null;
  name_public?: boolean | null;
  author_department?: string | null;
};

const BASE_COLUMNS = "article_id, email, email_verified, submitted_at, image_path";
// 2026-10-22_story_blocks.sql adds the author's real name (the public byline may be anonymous) and whether it is shown.
const NAME_COLUMNS = `${BASE_COLUMNS}, first_name, last_name, name_public, author_department`;

export async function loadSubmitters(articleIds: string[]): Promise<Map<string, SubmitterView>> {
  const out = new Map<string, SubmitterView>();
  if (articleIds.length === 0) return out;
  const db = supabaseAdmin();
  let rows: unknown[] | null;
  let failure: { code?: string; message: string } | null;
  ({ data: rows, error: failure } = await db.from("article_submitters").select(NAME_COLUMNS).in("article_id", articleIds));
  if (failure && isMissingColumn(failure)) ({ data: rows, error: failure } = await db.from("article_submitters").select(BASE_COLUMNS).in("article_id", articleIds));
  if (failure) throw new Error(failure.message);

  await Promise.all(
    ((rows ?? []) as SubmitterRow[]).map(async (r) => {
      let photoUrl: string | null = null;
      if (r.image_path) {
        const signed = await db.storage.from(STORAGE_BUCKETS.submissions).createSignedUrl(r.image_path, SIGNED_URL_SECONDS);
        photoUrl = signed.data?.signedUrl ?? null;
      }
      const name = [r.first_name, r.last_name].filter(Boolean).join(" ");
      out.set(r.article_id, {
        email: r.email,
        emailVerified: r.email_verified,
        submittedAt: r.submitted_at,
        photoUrl,
        authorName: name || null,
        authorDepartment: r.author_department ?? null,
        namePublic: r.name_public !== false,
      });
    }),
  );
  return out;
}

/** True when the article was written on the Write page. False for anything else, and when the column does not exist yet. */
export async function isBlocksArticle(id: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin().from("articles").select("body_format").eq("id", id).maybeSingle();
    return !error && (data as { body_format?: string } | null)?.body_format === "blocks";
  } catch {
    return false;
  }
}

/**
 * Short-lived links to the images of a story that is still pending (they are in the private bucket), by block id, for the admin
 * preview. Blocks that are already public need none. An image that cannot be signed is left out and shows as unavailable.
 */
export async function blockImageUrls(doc: BlocksDoc): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const db = supabaseAdmin();
  await Promise.all(
    doc.blocks.map(async (b) => {
      if (b.type !== "image" || !b.path) return;
      const signed = await db.storage.from(STORAGE_BUCKETS.submissions).createSignedUrl(b.path, SIGNED_URL_SECONDS);
      if (signed.data?.signedUrl) out[b.id] = signed.data.signedUrl;
    }),
  );
  return out;
}
/** Which of these articles are employee submissions. */
export async function employeeIdsAmong(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await supabaseAdmin().from("articles").select("id").in("id", ids).eq("origin", "employee");
  if (error) throw new Error(error.message);
  return new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
}

/**
 * Extra columns to write when an employee story is published: the photo is copied from the private
 * bucket to the public one and its public URL becomes image_url. Nothing to do for an AI article, a story
 * without a photo (it already has the department default image), or one that was published before.
 * Throws if the copy fails, so the article stays in review instead of going live without its photo.
 */
export async function publishPhotoPatch(articleId: string): Promise<PatchColumns> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("articles").select("origin, image_url").eq("id", articleId).maybeSingle();
  // Before the submissions migration there is no origin column and every article is AI-written: nothing to copy.
  if (error && isMissingColumn(error)) return {};
  if (error) throw new Error(error.message);
  const article = data as { origin: string; image_url: string | null } | null;
  if (!article) return {};
  // An AI-written blocks story has nothing to copy, but any picture the image stage could not place is dropped here.
  if (article.origin !== "employee") return (await publishBlocksPatch(articleId, article.image_url, false)) ?? {};
  const blocks = await publishBlocksPatch(articleId, article.image_url, true);
  if (blocks) return blocks;
  if (article.image_url && /^https:\/\//i.test(article.image_url)) return {}; // published before and then unpublished

  const sub = await db.from("article_submitters").select("image_path").eq("article_id", articleId).maybeSingle();
  if (sub.error) throw new Error(sub.error.message);
  const path = (sub.data as { image_path: string | null } | null)?.image_path;
  if (!path) return {};

  const file = await db.storage.from(STORAGE_BUCKETS.submissions).download(path);
  if (file.error || !file.data) throw new Error(`reading the photo failed: ${file.error?.message ?? "no data"}`);
  const publicPath = `${randomUUID()}.webp`;
  const up = await db.storage
    .from(STORAGE_BUCKETS.published)
    .upload(publicPath, Buffer.from(await file.data.arrayBuffer()), { contentType: "image/webp", upsert: false });
  if (up.error) throw new Error(`copying the photo failed: ${up.error.message}`);
  return { image_url: db.storage.from(STORAGE_BUCKETS.published).getPublicUrl(publicPath).data.publicUrl };
}

/**
 * A Write story's images: each one still in the private bucket is copied to the public bucket and its block is rewritten to
 * the public address (the private `path` is dropped), then the first image becomes the card's picture if the story only has the
 * department's default. Returns null for any other story. Throws if a copy fails, so the story stays pending instead of going
 * live with a broken image; the files already copied are removed again.
 */
async function publishBlocksPatch(articleId: string, currentImage: string | null, employee: boolean): Promise<PatchColumns | null> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("articles").select("body_format, body_blocks").eq("id", articleId).maybeSingle();
  if (error) {
    if (isMissingColumn(error)) return null; // the 2026-10-22 migration has not been run: nothing is written in blocks yet
    throw new Error(error.message);
  }
  const row = data as { body_format?: string; body_blocks?: unknown } | null;
  if (!row || row.body_format !== "blocks") return null;
  const doc = parseStoredDoc(row.body_blocks);
  if (!doc) throw new Error("the story's blocks could not be read");

  const copied: string[] = [];
  const blocks: Block[] = [];
  try {
    for (const b of doc.blocks) {
      // A picture with no address and no file (an AI story's placeholder that was never filled) is not published.
      if (b.type === "image" && !b.src && !b.path) continue;
      if (b.type !== "image" || b.src || !b.path) {
        blocks.push(b);
        continue;
      }
      const file = await db.storage.from(STORAGE_BUCKETS.submissions).download(b.path);
      if (file.error || !file.data) throw new Error(`reading an image failed: ${file.error?.message ?? "no data"}`);
      const publicPath = `${randomUUID()}.webp`;
      const up = await db.storage.from(STORAGE_BUCKETS.published).upload(publicPath, Buffer.from(await file.data.arrayBuffer()), { contentType: "image/webp", upsert: false });
      if (up.error) throw new Error(`copying an image failed: ${up.error.message}`);
      copied.push(publicPath);
      const { path: _private, ...rest } = b;
      void _private;
      blocks.push({ ...rest, src: db.storage.from(STORAGE_BUCKETS.published).getPublicUrl(publicPath).data.publicUrl });
    }
  } catch (err) {
    if (copied.length > 0) await db.storage.from(STORAGE_BUCKETS.published).remove(copied).catch(() => {});
    throw err;
  }

  const patch: PatchColumns = { body_blocks: { v: 1, blocks }, body_format: "blocks" };
  const first = blocks.find((b): b is Extract<Block, { type: "image" }> => b.type === "image" && Boolean(allowedImageUrl(b.src)));
  // (Only for a story written by an employee: an AI story's card picture and its credit come from the image stage.)
  if (employee && first && (!currentImage || currentImage.startsWith("/"))) {
    patch.image_url = first.src ?? null;
    patch.image_alt = first.alt || null;
  }
  return patch;
}