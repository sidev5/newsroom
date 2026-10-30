"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useRef } from "react";
import { PhotoCredit } from "@/components/PhotoCredit";
import { byline, isEmployeeStory, originTag } from "@/lib/news/byline";
import { allowedImageUrl, isoDate, paragraphs, safeHttpUrl, sourceName } from "@/lib/news/format";
import { defaultImagePath } from "@/lib/news/departments";
import type { ReaderStatus, ReaderStory } from "@/lib/news/types";
import { readingMinutes } from "@/lib/stories/reading";
import { DeptChip } from "./DeptChip";
import { BookIcon, CloseIcon, PinIcon } from "./icons";

// Stories written with Write are drawn by their own chunk, fetched only when one is opened: the homepage never carries it.
const BlocksReader = dynamic(() => import("@/components/story/BlocksReader").then((m) => m.BlocksReader), {
  loading: () => (
    <p role="status" className="mt-6 text-[14px] text-secondary">
      Loading the story…
    </p>
  ),
});

type Props = {
  /** The last selected story. Stays rendered while the panel slides out. Null while a story that is not in the feed loads. */
  story: ReaderStory | null;
  status: ReaderStatus;
  open: boolean;
  onClose: () => void;
};

export function ReaderPanel({ story, status, open, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    scrollRef.current?.scrollTo({ top: 0 });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, story?.slug, onClose]);

  const image = allowedImageUrl(story?.image_url);
  const employee = story ? isEmployeeStory(story) : false;
  const by = story ? byline(story) : null;
  const sourceUrl = safeHttpUrl(story?.source_urls[0]);
  const published = isoDate(story?.published_at);
  const sourceDate = isoDate(story?.source_published_at);
  // A Write story (body_format "blocks"): Medium-style content in place of the photo and the paragraphs. The frame around it is unchanged.
  const blocks = story?.body_format === "blocks" ? (story.body_blocks ?? null) : null;

  return (
    <aside
      aria-hidden={!open}
      inert={!open}
      aria-label="Story reader"
      style={{
        transform: open ? "translateX(0)" : "translateX(100%)",
        visibility: open ? "visible" : "hidden",
        transition: "transform 0.5s cubic-bezier(0.22, 0.8, 0.26, 1), visibility 0.5s",
      }}
      className="z-20 flex flex-col bg-paper shadow-[-8px_0_32px_rgba(44,53,47,0.18)] max-[1099px]:fixed max-[1099px]:inset-0 max-[1099px]:w-full min-[1100px]:absolute min-[1100px]:inset-y-0 min-[1100px]:right-0 min-[1100px]:w-[min(540px,70%)]"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-paper px-5 py-2">
        <div className="flex items-center gap-2 text-meta">
          <BookIcon />
          <span className="font-mono text-[11px] font-medium uppercase tracking-wide">Reader</span>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close reader"
          className="grid size-11 place-items-center rounded-lg text-ink hover:bg-mint"
        >
          <CloseIcon />
        </button>
      </div>

      {!story && (
        <p role={status === "loading" ? "status" : "alert"} className="px-6 pt-6 text-[15px] text-secondary">
          {status === "missing"
            ? "This story is no longer available."
            : status === "error"
              ? "The story could not be loaded. Close the reader and try again."
              : "Loading the story…"}
        </p>
      )}

      {story && (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-5">
          <div className="flex flex-wrap items-center gap-2">
            <DeptChip department={story.department} />
            {published && <span className="font-mono text-[11px] font-medium text-meta">{published}</span>}
            <span className="rounded-full bg-peach px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide text-ink">{originTag(story)}</span>
            {blocks && <span className="font-mono text-[11px] font-medium text-meta">{readingMinutes(blocks)} min read</span>}
          </div>

          <h2 className="mt-3 font-headline text-[36px] font-bold leading-[1.15] text-ink">{story.headline}</h2>
          {by && <p className="mt-2 text-[15px] font-medium text-secondary">{by}</p>}

          {story.place && (
            <p className="mt-3 flex items-center gap-1.5 text-[14px] text-secondary">
              <PinIcon />
              {story.place}
            </p>
          )}

          {/* The cover photo. A story written by an employee has its pictures inside its blocks and no cover; an AI-written one has both. */}
          {!(blocks && employee) && (
            <figure className="mt-5">
              <Image
                src={image ?? defaultImagePath(story.department?.slug)}
                alt={story.image_alt ?? story.headline}
                width={1080}
                height={608}
                sizes="(min-width: 1024px) 492px, 100vw"
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
            <div className="mt-6">
              <BlocksReader doc={blocks} slug={story.slug} engagement={employee} />
            </div>
          ) : (
            <div className="mt-6 flex flex-col gap-4 font-headline text-[19px] leading-[1.65] text-body">
              {/* Until the body arrives the card summary, which is the start of it, fills the space. */}
              {(story.body === undefined ? [story.summary] : paragraphs(story.body)).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
              {story.body === undefined && status === "error" && (
                <p role="alert" className="font-sans text-[14px] text-secondary">
                  The rest of the story could not be loaded. Close the reader and try again.
                </p>
              )}
              {story.body === undefined && status !== "error" && (
                <p role="status" className="font-sans text-[14px] text-secondary">
                  Loading the full story…
                </p>
              )}
            </div>
          )}
          {story.body !== undefined && (
            <div className="mt-8 rounded-[10px] bg-peach p-4 text-[14px] leading-relaxed text-ink">
              {employee ? (
                <p>Contributed by a colleague and approved by a human editor. It was not written or checked by AI.</p>
              ) : (
                <>
                  <p>Based on a source published {sourceDate ?? "(date unknown)"}</p>
                  {sourceUrl && <p>Source: {sourceName(sourceUrl)}</p>}
                  <p className="mt-2">Written by AI from the source and approved by a human editor. Check the source for later updates.</p>
                </>
              )}
            </div>
          )}

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
        </div>
      )}
    </aside>
  );
}
