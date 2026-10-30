"use client";

import type { BlocksDoc } from "@/lib/stories/blocks";
import { BlocksView } from "./BlocksView";
import { Engagement } from "./Engagement";

/**
 * The content of a Write story inside the reader panel: the blocks, then the like button and the comments. It is its own
 * chunk (the reader loads it with next/dynamic the first time a Write story is opened), so the homepage does not carry it.
 */
export function BlocksReader({ doc, slug, engagement = true }: { doc: BlocksDoc; slug: string; /** Likes and comments: only on stories written by employees. */ engagement?: boolean }) {
  return (
    <>
      <BlocksView doc={doc} headingOffset={1} />
      {engagement && <Engagement key={slug} slug={slug} />}
    </>
  );
}