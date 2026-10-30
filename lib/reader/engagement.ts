import { READER_LIMITS } from "@/lib/config";
import { cleanText } from "@/lib/stories/blocks";
import type { ReaderSession } from "./identity";

// Likes and comments on a published Write story, with every outside effect injected. Who is acting comes from the signed
// session (lib/reader/identity.ts): there are no anonymous likes or comments. The rules are here and tested; the routes only
// read the cookie and pass the answer on.

export type PublicComment = { id: string; name: string; body: string; createdAt: string };

export interface EngagementStore {
  /** The published article with this slug, or null (missing, not published). */
  article(slug: string): Promise<{ id: string; format: "plain" | "blocks" } | null>;
  likeCount(articleId: string): Promise<number>;
  hasLiked(articleId: string, userKey: string): Promise<boolean>;
  addLike(articleId: string, userKey: string): Promise<void>;
  removeLike(articleId: string, userKey: string): Promise<void>;
  /** Toggles by this person since `sinceIso`, and the log of one more. */
  likeToggles(userKey: string, sinceIso: string): Promise<number>;
  logLikeToggle(userKey: string): Promise<void>;
  /** Visible comments, newest first. */
  comments(articleId: string, limit: number): Promise<PublicComment[]>;
  /** Comments by this person since `sinceIso` (any status: a hidden comment still counts towards the limit). */
  commentCount(userKey: string, sinceIso: string): Promise<number>;
  /** The texts of this person's recent comments, to refuse a repeat. */
  recentCommentBodies(userKey: string, sinceIso: string): Promise<string[]>;
  addComment(row: { articleId: string; userKey: string; displayName: string; body: string }): Promise<PublicComment>;
}

export type EngagementDeps = { store: EngagementStore; now: () => Date };

export type Engagement = { likes: number; liked: boolean; comments: PublicComment[] };

export const NOT_FOUND = "This story is not available.";
export const SIGN_IN_REQUIRED = "Sign in with your company email first.";
export const LIKE_LIMIT = "You are liking and unliking too fast. Please wait a while.";
export const COMMENT_HOUR_LIMIT = `You can write ${READER_LIMITS.COMMENTS_PER_HOUR} comments an hour. Please try again later.`;
export const COMMENT_DAY_LIMIT = `You can write ${READER_LIMITS.COMMENTS_PER_DAY} comments a day. Please try again tomorrow.`;
export const COMMENT_DUPLICATE = "You already posted this comment.";
export const COMMENT_EMPTY = `Write a comment of at least ${READER_LIMITS.COMMENT_MIN} characters.`;
export const COMMENT_TOO_LONG = `A comment can have at most ${READER_LIMITS.COMMENT_MAX} characters.`;

export type Failure = { ok: false; error: string; kind: "not_found" | "auth" | "invalid" | "limited" | "server" };
const fail = (kind: Failure["kind"], error: string): Failure => ({ ok: false, kind, error });

const HOUR = 3_600_000;
const since = (now: Date, ms: number) => new Date(now.getTime() - ms).toISOString();

/** Only published stories written with Write have likes and comments. */
async function target(deps: EngagementDeps, slug: string) {
  const a = await deps.store.article(slug);
  return a && a.format === "blocks" ? a : null;
}

/** The counts and comments everyone sees, and whether this reader (if signed in) has liked it. */
export async function getEngagement(deps: EngagementDeps, input: { slug: string; session: ReaderSession | null }): Promise<({ ok: true } & Engagement) | Failure> {
  try {
    const a = await target(deps, input.slug);
    if (!a) return fail("not_found", NOT_FOUND);
    const [likes, liked, comments] = await Promise.all([
      deps.store.likeCount(a.id),
      input.session ? deps.store.hasLiked(a.id, input.session.k) : Promise.resolve(false),
      deps.store.comments(a.id, READER_LIMITS.COMMENTS_SHOWN),
    ]);
    // Copied field by field: whatever else a store row holds (the user key) can never reach the browser.
    return { ok: true, likes, liked, comments: comments.map((c) => ({ id: c.id, name: c.name, body: c.body, createdAt: c.createdAt })) };
  } catch {
    return fail("server", "Likes and comments could not be loaded.");
  }
}

/** Likes the story, or takes the like back. Counted for the rate limit either way. */
export async function toggleLike(deps: EngagementDeps, input: { slug: string; session: ReaderSession | null }): Promise<({ ok: true; liked: boolean; likes: number }) | Failure> {
  if (!input.session) return fail("auth", SIGN_IN_REQUIRED);
  const { k } = input.session;
  try {
    const a = await target(deps, input.slug);
    if (!a) return fail("not_found", NOT_FOUND);
    const now = deps.now();
    const [hour, day] = await Promise.all([deps.store.likeToggles(k, since(now, HOUR)), deps.store.likeToggles(k, since(now, 24 * HOUR))]);
    if (hour >= READER_LIMITS.LIKE_TOGGLES_PER_HOUR || day >= READER_LIMITS.LIKE_TOGGLES_PER_DAY) return fail("limited", LIKE_LIMIT);
    await deps.store.logLikeToggle(k);
    const liked = await deps.store.hasLiked(a.id, k);
    if (liked) await deps.store.removeLike(a.id, k);
    else await deps.store.addLike(a.id, k);
    return { ok: true, liked: !liked, likes: await deps.store.likeCount(a.id) };
  } catch {
    return fail("server", "Your like could not be saved. Please try again.");
  }
}

/** Two comments are the same when they match ignoring case, spacing and line breaks. */
export const commentKey = (body: string) => body.toLowerCase().replace(/\s+/g, " ").trim();

export async function addComment(deps: EngagementDeps, input: { slug: string; session: ReaderSession | null; body: string }): Promise<({ ok: true; comment: PublicComment }) | Failure> {
  if (!input.session) return fail("auth", SIGN_IN_REQUIRED);
  const { k, n } = input.session;
  // The text is cleaned of control characters (and hidden direction marks) before anything is measured or stored.
  const body = cleanText(input.body);
  if (body.length < READER_LIMITS.COMMENT_MIN) return fail("invalid", COMMENT_EMPTY);
  if (body.length > READER_LIMITS.COMMENT_MAX) return fail("invalid", COMMENT_TOO_LONG);

  try {
    const a = await target(deps, input.slug);
    if (!a) return fail("not_found", NOT_FOUND);
    const now = deps.now();
    const [hour, day, recent] = await Promise.all([
      deps.store.commentCount(k, since(now, HOUR)),
      deps.store.commentCount(k, since(now, 24 * HOUR)),
      deps.store.recentCommentBodies(k, since(now, 24 * HOUR)),
    ]);
    if (hour >= READER_LIMITS.COMMENTS_PER_HOUR) return fail("limited", COMMENT_HOUR_LIMIT);
    if (day >= READER_LIMITS.COMMENTS_PER_DAY) return fail("limited", COMMENT_DAY_LIMIT);
    if (recent.some((r) => commentKey(r) === commentKey(body))) return fail("invalid", COMMENT_DUPLICATE);
    const comment = await deps.store.addComment({ articleId: a.id, userKey: k, displayName: n, body });
    return { ok: true, comment };
  } catch {
    return fail("server", "Your comment could not be saved. Please try again.");
  }
}
