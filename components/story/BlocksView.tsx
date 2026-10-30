import { PhotoCredit } from "@/components/PhotoCredit";
import { allowedImageUrl, safeHttpUrl, sourceName } from "@/lib/news/format";
import type { Block, BlocksDoc } from "@/lib/stories/blocks";
import { CodeBlock } from "./CodeBlock";

// Draws the blocks of a Write story. Every block becomes React elements from the validated JSON: there is no
// dangerouslySetInnerHTML, no markdown, no HTML anywhere, so text such as "<script>" or "<img onerror=...>" is shown as text.
// Links open in a new tab with rel="noopener noreferrer nofollow", and only http(s) addresses become links at all.
// Used by the reader, the article page and the admin preview, so all three look the same.

type Props = {
  doc: BlocksDoc;
  /**
   * The level of the story's own heading: the article page has the title as <h1> so a block heading level 2 is <h2>
   * (offset 0); the reader's title is <h2>, so the same heading is <h3> (offset 1).
   */
  headingOffset?: 0 | 1;
  /** Image address by block id, for images that are not public yet (the admin preview, with signed links). */
  images?: Readonly<Record<string, string>>;
};

const TEXT = "whitespace-pre-line break-words";

function StoryImage({ block, src }: { block: Extract<Block, { type: "image" }>; src: string | null }) {
  // An AI story's picture that was never found (it only has a search query): nothing to show.
  if (!src && block.query && !block.path) return null;
  if (!src) {
    return (
      <p role="img" aria-label={block.alt} className="my-8 rounded-lg bg-mint px-4 py-10 text-center text-[14px] text-secondary">
        Image not available
      </p>
    );
  }
  return (
    <figure className="my-8">
      {/* eslint-disable-next-line @next/next/no-img-element -- already resized and re-encoded by the server; the address is checked above */}
      <img src={src} alt={block.alt} width={block.width} height={block.height} loading="lazy" decoding="async" className="h-auto w-full rounded-lg" />
      {block.caption && <figcaption className="mt-2 text-center font-sans text-[14px] leading-snug text-secondary">{block.caption}</figcaption>}
      {/* A stock photo carries its credit, as a cover photo does. */}
      {block.credit && (
        <div className="mt-1 text-center">
          <PhotoCredit credit={block.credit} creditUrl={block.creditUrl ?? null} />
        </div>
      )}
    </figure>
  );
}

function Piece({ block, offset, images }: { block: Block; offset: 0 | 1; images?: Props["images"] }) {
  switch (block.type) {
    case "paragraph":
      return <p className={`my-5 ${TEXT}`}>{block.text}</p>;
    case "heading": {
      const Tag = (`h${block.level + offset}` as "h2" | "h3" | "h4");
      return <Tag className={`font-headline font-bold text-ink ${block.level === 2 ? "mb-3 mt-10 text-[28px] leading-[1.25]" : "mb-2 mt-8 text-[22px] leading-[1.3]"} ${TEXT}`}>{block.text}</Tag>;
    }
    case "image":
      return <StoryImage block={block} src={images?.[block.id] ?? allowedImageUrl(block.src)} />;
    case "code":
      return <CodeBlock code={block.code} language={block.language} filename={block.filename} />;
    case "quote":
      return (
        <blockquote className="my-7 border-l-[3px] border-deep-sage pl-5 italic text-ink">
          <p className={TEXT}>{block.text}</p>
          {block.cite && <footer className="mt-2 font-sans text-[14px] not-italic text-secondary">{block.cite}</footer>}
        </blockquote>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className={`my-5 flex flex-col gap-2 pl-7 ${block.ordered ? "list-decimal" : "list-disc"}`}>
          {block.items.map((item, i) => (
            <li key={i} className={`pl-1 ${TEXT}`}>
              {item}
            </li>
          ))}
        </Tag>
      );
    }
    case "divider":
      return <hr className="my-10 border-0 text-center text-[22px] leading-none tracking-[0.6em] text-secondary before:content-['•••']" />;
    case "link": {
      const href = safeHttpUrl(block.url);
      if (!href) return <p className={`my-5 ${TEXT}`}>{block.title}</p>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="my-6 block rounded-lg border border-line bg-feed px-4 py-3 font-sans no-underline hover:bg-mint">
          <span className="block text-[16px] font-semibold text-ink underline decoration-sage underline-offset-2">{block.title}</span>
          {block.description && <span className="mt-0.5 block text-[14px] leading-snug text-secondary">{block.description}</span>}
          <span className="mt-1 block font-mono text-[11px] text-meta">{sourceName(href)}</span>
        </a>
      );
    }
  }
}

export function BlocksView({ doc, headingOffset = 0, images }: Props) {
  return (
    <div className="mx-auto w-full max-w-[680px] font-headline text-[20px] leading-[1.7] text-body">
      {doc.blocks.map((block) => (
        <Piece key={block.id} block={block} offset={headingOffset} images={images} />
      ))}
    </div>
  );
}
