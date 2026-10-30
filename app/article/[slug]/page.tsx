import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BlocksView } from "@/components/story/BlocksView";
import { Engagement } from "@/components/story/Engagement";
import { DeptChip } from "@/components/dashboard/DeptChip";
import { PinIcon } from "@/components/dashboard/icons";
import { PhotoCredit } from "@/components/PhotoCredit";
import { byline, isEmployeeStory, originTag } from "@/lib/news/byline";
import { defaultImagePath } from "@/lib/news/departments";
import { allowedImageUrl, isoDate, paragraphs, safeHttpUrl, sourceName, summarize } from "@/lib/news/format";
import { getStoryBySlug } from "@/lib/news/queries";
import { readingMinutes } from "@/lib/stories/blocks";

// Cached for 60 s; approving, unpublishing, restoring or editing a story drops the cache at once (lib/news/revalidate.ts).
export const revalidate = 60;

// Without this a dynamic route is rendered on every request. Nothing is prerendered at build time (so the build needs
// no database); each article is generated on its first visit and then served from the cache.
export function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: PageProps<"/article/[slug]">): Promise<Metadata> {
  const story = await getStoryBySlug((await params).slug).catch(() => null);
  if (!story) return { title: "Story not found" };
  return { title: `${story.headline} | Company Newsroom`, description: summarize(story.body, 160) };
}

export default async function ArticlePage({ params }: PageProps<"/article/[slug]">) {
  const story = await getStoryBySlug((await params).slug);
  if (!story) notFound();

  const image = allowedImageUrl(story.image_url);
  const sourceUrl = safeHttpUrl(story.source_urls[0]);
  const employee = isEmployeeStory(story);
  const by = byline(story);
  // A Write story: Medium-style blocks instead of the photo and paragraphs. The likes and comments load in the browser, so the page stays cached.
  const blocks = story.body_format === "blocks" ? (story.body_blocks ?? null) : null;

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-2xl flex-1 px-5 py-8">
      <Link href="/" className="inline-flex min-h-11 items-center text-[14px] font-medium text-deep-sage underline">
        ← All stories
      </Link>

      <article className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <DeptChip department={story.department} />
          {story.published_at && <span className="font-mono text-[11px] font-medium text-meta">{isoDate(story.published_at)}</span>}
          <span className="rounded-full bg-peach px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide text-ink">{originTag(story)}</span>
          {blocks && <span className="font-mono text-[11px] font-medium text-meta">{readingMinutes(blocks)} min read</span>}
        </div>

        <h1 className="mt-3 font-headline text-[36px] font-bold leading-[1.15] text-ink">{story.headline}</h1>
        {by && <p className="mt-2 text-[15px] font-medium text-secondary">{by}</p>}
        {story.place && (
          <p className="mt-3 flex items-center gap-1.5 text-[14px] text-secondary">
            <PinIcon />
            {story.place}
          </p>
        )}

        {/* The cover photo. An employee's Write story has its pictures inside its blocks and no cover; an AI-written one has both. */}
        {!(blocks && employee) && (
          <figure className="mt-5">
            <Image
              src={image ?? defaultImagePath(story.department?.slug)}
              alt={story.image_alt ?? story.headline}
              width={1080}
              height={608}
              priority
              unoptimized={!image}
              className="aspect-video w-full rounded-lg object-cover"
            />
            {image && (
              <figcaption className="mt-1.5">
                {employee ? (
                  story.image_credit && <p className="text-xs text-zinc-500">Photo: {story.image_credit}</p>
                ) : (
                  <PhotoCredit credit={story.image_credit} creditUrl={story.image_credit_url} />
                )}
              </figcaption>
            )}
          </figure>
        )}

        {blocks ? (
          <div className="mt-8">
            <BlocksView doc={blocks} />
            {employee && <Engagement slug={story.slug} />}
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-4 font-headline text-[19px] leading-[1.65] text-body">
            {paragraphs(story.body).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        )}
        <div className="mt-8 rounded-[10px] bg-peach p-4 text-[14px] leading-relaxed text-ink">
          {employee ? (
            <p>Contributed by a colleague and approved by a human editor. It was not written or checked by AI.</p>
          ) : (
            <>
              <p>Based on a source published {isoDate(story.source_published_at) ?? "(date unknown)"}</p>
              {sourceUrl && <p>Source: {sourceName(sourceUrl)}</p>}
              <p className="mt-2">Written by AI from the source and approved by a human editor. Check the source for later updates.</p>
            </>
          )}
        </div>

        {!blocks && sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex h-12 items-center rounded-lg bg-deep-sage px-5 text-[15px] font-semibold text-white hover:bg-deep-sage-dark"
          >
            Read the original source
          </a>
        )}
      </article>
    </main>
  );
}
