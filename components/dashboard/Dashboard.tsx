"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { normalizeCountryCode } from "@/lib/geo/countries";
import { departmentStyle } from "@/lib/news/departments";
import { appendUnique, mergeFeed, resolveReader, type ReaderFailure } from "@/lib/news/feed";
import { feedChips, filterStories } from "@/lib/news/filter";
import { openScale } from "@/lib/news/layout";
import { groupByCountry } from "@/lib/news/markers";
import type { FeedPage, FeedStory, ReaderStory, Story } from "@/lib/news/types";
import { CountryList } from "./CountryList";
import { FeedPanel } from "./FeedPanel";
import { GlobePlaceholder } from "./GlobePlaceholder";
import { Header } from "./Header";
import { ReaderPanel } from "./ReaderPanel";
import { Ticker } from "./Ticker";

// Current time, ticking every minute. null on the server and during hydration, so relative times
// are only ever computed on the client after mount.
const minute = () => Math.floor(Date.now() / 60_000) * 60_000;
function subscribeMinute(callback: () => void) {
  const id = setInterval(callback, 60_000);
  return () => clearInterval(id);
}

// The globe (d3-geo, topojson and the canvas code) is its own chunk, fetched after the header and the feed have rendered.
const Globe = dynamic(() => import("./Globe").then((m) => m.Globe), { ssr: false, loading: () => <GlobePlaceholder /> });

/** True once the first paint is done and the browser has a quiet moment (at most about a second later). */
function useAfterFirstPaint(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const go = () => setReady(true);
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(go, { timeout: 1000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(go, 200);
    return () => window.clearTimeout(timer);
  }, []);
  return ready;
}

/**
 * Reads /?story=<slug> and reports it. It is the only user of useSearchParams, and sits in its own Suspense
 * boundary: that keeps the feed and the header in the cached, server-rendered HTML instead of waiting for the
 * browser to render them.
 */
function StoryParam({ onChange }: { onChange: (slug: string | null) => void }) {
  const slug = useSearchParams().get("story");
  useEffect(() => onChange(slug), [slug, onChange]);
  return null;
}

const LEGEND = [
  { slug: "ev", name: "EV" },
  { slug: "batteries", name: "Batteries" },
  { slug: "defence", name: "Defence" },
  { slug: "software", name: "Software Development" },
  { slug: "sales-marketing", name: "Sales & Marketing" },
  { slug: "ai-technology", name: "AI & Technology" },
  { slug: "world", name: "World" },
];

export function Dashboard({ page }: { page: FeedPage }) {
  const [department, setDepartment] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cardCountry, setCardCountry] = useState<string | null>(null);
  const [listCode, setListCode] = useState<string | null>(null);
  const [dragged, setDragged] = useState(false);
  const [scaleOpen, setScaleOpen] = useState(0.8);
  const stage = useRef<HTMLDivElement>(null);
  const now = useSyncExternalStore(subscribeMinute, minute, () => null);

  // The first page comes from the server; "Load more" appends older stories.
  const [extra, setExtra] = useState<FeedStory[]>([]);
  const [fetched, setFetched] = useState(0); // rows received so far, duplicates included: the next offset
  const [moreFlag, setMoreFlag] = useState<boolean | null>(null); // null: use the first page's own flag
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [seenPage, setSeenPage] = useState(page);
  if (seenPage !== page) {
    // The server sent a fresher first page (after a revalidation): start from it.
    setSeenPage(page);
    setExtra([]);
    setFetched(0);
    setMoreFlag(null);
  }
  const stories = useMemo(() => mergeFeed(page.stories, extra), [page, extra]);
  const hasMore = moreFlag ?? page.hasMore;
  const consumed = page.stories.length + fetched; // a multiple of 60 while there is more: the API accepts only those

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const res = await fetch(`/api/stories?offset=${consumed}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as FeedPage;
      setExtra((prev) => appendUnique(prev, next.stories));
      setFetched((n) => n + next.stories.length);
      setMoreFlag(next.hasMore);
    } catch {
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [consumed, loadingMore]);

  // The URL is the source of truth for the selection: /?story=<slug> (back closes the reader). The slug is held in
  // state, set by StoryParam (deep links, back and forward) and by select/close (clicks, at once).
  const [slug, setSlug] = useState<string | null>(null);

  // The reader needs the full body: the list carries only summaries. It is fetched when a story is opened
  // (also for a deep link to a story that is not in the loaded list) and kept for the rest of the visit.
  const [bodies, setBodies] = useState<Record<string, Story>>({});
  const [failure, setFailure] = useState<ReaderFailure>(null);
  useEffect(() => {
    if (!slug || bodies[slug]) return;
    const controller = new AbortController();
    fetch(`/api/story/${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then(async (res) => {
        if (res.status === 404) return setFailure({ slug, kind: "missing" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const story = (await res.json()) as Story;
        setBodies((prev) => ({ ...prev, [slug]: story }));
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) setFailure({ slug, kind: "error" });
      });
    return () => controller.abort();
  }, [slug, bodies]);

  const inFeed = useMemo(() => (slug ? (stories.find((s) => s.slug === slug) ?? null) : null), [stories, slug]);
  const { story: selected, status } = resolveReader({ slug, inFeed, full: slug ? bodies[slug] : undefined, failure });

  // Keep the last selection so its content stays rendered while the reader slides out.
  const [shown, setShown] = useState<ReaderStory | null>(selected);
  if (selected && selected !== shown) setShown(selected);

  const select = useCallback((next: string) => {
    setListCode(null);
    setSlug(next);
    window.history.pushState(null, "", `/?story=${encodeURIComponent(next)}`);
  }, []);
  const close = useCallback(() => {
    setSlug(null);
    setFailure(null);
    window.history.pushState(null, "", "/");
  }, []);
  const closeList = useCallback(() => setListCode(null), []);
  const firstDrag = useCallback(() => setDragged(true), []);

  // With the reader open the globe shrinks to fit the strip beside it.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setScaleOpen(openScale(el.clientWidth, el.clientHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One feed: every published story, newest first; a chip (World is one) and the search narrow it.
  const { all, chips } = useMemo(() => feedChips(stories, query), [stories, query]);
  const filtered = useMemo(() => filterStories(stories, { department, query }), [stories, department, query]);

  // The globe shows what the feed shows.
  const groups = useMemo(() => groupByCountry(filtered), [filtered]);
  const listGroup = groups.find((g) => g.code === listCode) ?? null;
  const selectedCode = normalizeCountryCode(selected?.country_code);

  const openCountry = useCallback(
    (code: string) => {
      const group = groups.find((g) => g.code === code);
      if (!group) return;
      if (group.count === 1) select(group.stories[0].slug);
      else setListCode(code);
    },
    [groups, select],
  );

  const open = slug !== null;
  const globeReady = useAfterFirstPaint();

  return (
    <div className="flex min-h-screen flex-col min-[1100px]:h-dvh min-[1100px]:min-h-0">
      <Header />
      {/* useSearchParams needs a Suspense boundary; this one holds nothing else. */}
      <Suspense fallback={null}>
        <StoryParam onChange={setSlug} />
      </Suspense>

      <div className="flex min-h-0 flex-1 flex-col min-[1100px]:flex-row">
        <FeedPanel
          stories={filtered}
          totalPublished={stories.length}
          hasMore={hasMore}
          loadingMore={loadingMore}
          loadMoreFailed={loadMoreFailed}
          onLoadMore={loadMore}
          allCount={all}
          chips={chips}
          department={department}
          onDepartment={setDepartment}
          query={query}
          onQuery={setQuery}
          selectedSlug={slug}
          now={now}
          onSelect={select}
          onHoverCountry={setCardCountry}
        />

        {/* Below 1100px the globe sits above the feed, smaller. */}
        <section
          aria-label="Map"
          className="relative order-first min-h-0 min-w-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_50%_45%,#FDE8D3_0%,#FFFFFF_75%)] max-[1099px]:h-[min(88vw,420px)] max-[1099px]:flex-none min-[1100px]:order-none"
        >
          <ul className="absolute left-4 top-4 z-10 flex flex-col gap-1" aria-label="Legend">
            {LEGEND.map((d) => (
              <li key={d.slug} className="flex items-center gap-2 text-[12px] text-secondary">
                <span className="size-2.5 rounded-full border border-white" style={{ backgroundColor: departmentStyle(d.slug).dot }} aria-hidden="true" />
                {d.name}
              </li>
            ))}
          </ul>

          <div className="pointer-events-none absolute bottom-4 left-4 z-10 max-w-[min(26rem,60%)]">
            <p className="font-mono text-[11px] font-medium uppercase tracking-wider text-meta">
              Live map: {groups.length} {groups.length === 1 ? "country" : "countries"} with stories
            </p>
            <p className={`mt-1 text-[12px] text-secondary transition-opacity duration-700 ${dragged ? "opacity-0" : "opacity-100"}`} aria-hidden={dragged}>
              Drag to rotate
            </p>
          </div>

          {/* The stage measures the map area: the globe is min(640px, 78% of its height, 92% of its width). */}
          <div
            ref={stage}
            style={{ "--reader-w": "min(540px, 70cqw)", "--open-scale": scaleOpen } as CSSProperties}
            className="absolute inset-0 grid place-items-center [container-type:size]"
          >
            <div data-open={open} className="globe-shift globe-box">
              {globeReady ? (
                <Globe
                  groups={groups}
                  selectedCode={selectedCode}
                  cardHoverCode={cardCountry}
                  onOpenCountry={openCountry}
                  onFirstDrag={firstDrag}
                  animate={stories.length > 0}
                />
              ) : (
                <GlobePlaceholder />
              )}
            </div>
          </div>

          {listGroup && <CountryList group={listGroup} now={now} onSelect={select} onClose={closeList} />}
          <ReaderPanel story={open && !selected ? null : shown} status={status} open={open} onClose={close} />
        </section>
      </div>

      <Ticker stories={stories} onSelect={select} />
    </div>
  );
}
