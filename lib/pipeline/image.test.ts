import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { defaultImageFor } from "@/lib/images";
import { ImageSearchError, type ImageProvider } from "@/lib/images/types";
import { createUnsplashProvider } from "@/lib/images/unsplash";
import { photoCreditLinks, withUtm } from "@/lib/images/utm";
import { runImage, type ImageArticle, type ImageUpdate } from "./image";

// ---------------------------------------------------------------------------
// Mocked fetch for the Unsplash module
// ---------------------------------------------------------------------------
const photo = {
  urls: { regular: "https://images.unsplash.com/photo-1?ixid=abc&w=1080" },
  links: { download_location: "https://api.unsplash.com/photos/p1/download?ixid=abc" },
  user: { name: "Ada Lovelace", links: { html: "https://unsplash.com/@ada" } },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("unsplash provider", () => {
  const provider = () => createUnsplashProvider("KEY");

  it("searches landscape, takes the top result, hotlinks the URL and adds UTM to the profile link", async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [photo] }));
    fetchMock.mockResolvedValueOnce(json({ url: "x" }));
    const result = await provider().searchImage("battery factory");

    const [searchUrl, init] = fetchMock.mock.calls[0];
    const u = new URL(searchUrl);
    expect(u.origin + u.pathname).toBe("https://api.unsplash.com/search/photos");
    expect(u.searchParams.get("query")).toBe("battery factory");
    expect(u.searchParams.get("orientation")).toBe("landscape");
    expect(u.searchParams.get("per_page")).toBe("1");
    expect(init.headers.Authorization).toBe("Client-ID KEY");

    expect(result).toEqual({
      url: "https://images.unsplash.com/photo-1?ixid=abc&w=1080",
      credit: "Ada Lovelace",
      creditUrl: "https://unsplash.com/@ada?utm_source=ai_newsroom&utm_medium=referral",
    });
  });

  it("triggers the photo's download_location when an image is chosen", async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [photo] }));
    fetchMock.mockResolvedValueOnce(json({}));
    await provider().searchImage("x");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(photo.links.download_location);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Client-ID KEY");
  });

  it("still returns the image if the download trigger fails", async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [photo] }));
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    expect(await provider().searchImage("x")).toMatchObject({ credit: "Ada Lovelace" });
  });

  it("returns null with no results and does not trigger a download", async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [] }));
    expect(await provider().searchImage("zzz")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws ImageSearchError on 429, other HTTP errors, network errors and bad payloads", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429));
    await expect(provider().searchImage("x")).rejects.toMatchObject({ status: 429, rateLimited: true });
    fetchMock.mockResolvedValueOnce(json({}, 500));
    await expect(provider().searchImage("x")).rejects.toMatchObject({ status: 500, rateLimited: false });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(provider().searchImage("x")).rejects.toBeInstanceOf(ImageSearchError);
    fetchMock.mockResolvedValueOnce(json({ unexpected: true }));
    await expect(provider().searchImage("x")).rejects.toBeInstanceOf(ImageSearchError);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
describe("attribution helpers", () => {
  it("adds UTM parameters, keeping existing ones", () => {
    expect(withUtm("https://unsplash.com/@ada?x=1")).toBe(
      "https://unsplash.com/@ada?x=1&utm_source=ai_newsroom&utm_medium=referral",
    );
  });

  it("builds credit links only for unsplash.com profiles", () => {
    const links = photoCreditLinks("Ada", "https://unsplash.com/@ada?utm_source=ai_newsroom&utm_medium=referral");
    expect(links).toEqual({
      name: "Ada",
      profileUrl: "https://unsplash.com/@ada?utm_source=ai_newsroom&utm_medium=referral",
      unsplashUrl: "https://unsplash.com/?utm_source=ai_newsroom&utm_medium=referral",
    });
    expect(photoCreditLinks(null, null)).toBeNull(); // fallback image: no credit shown
    expect(photoCreditLinks("Eve", "https://evil.example.com/@eve")).toBeNull();
    expect(photoCreditLinks("Eve", "javascript:alert(1)")).toBeNull();
  });

  it("picks the department default SVG, else the generic one", () => {
    expect(defaultImageFor("batteries")).toBe("/images/defaults/batteries.svg");
    expect(defaultImageFor("sales-marketing")).toBe("/images/defaults/sales-marketing.svg");
    expect(defaultImageFor("unknown")).toBe("/images/defaults/default.svg");
    expect(defaultImageFor(null)).toBe("/images/defaults/default.svg");
  });
});

// ---------------------------------------------------------------------------
// runImage fallback logic (real Unsplash module, mocked fetch)
// ---------------------------------------------------------------------------
describe("runImage", () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      CRON_SECRET: "test-secret-0123456789",
      BATCH_LIMIT: "3",
    });
    resetEnvCache();
  });

  const art = (id: string, query: string | null = "q", slug: string | null = "ev"): ImageArticle => ({
    id,
    image_query: query,
    department_slug: slug,
  });

  function harness(articles: ImageArticle[], failUpdateFor?: string) {
    const updates: Record<string, ImageUpdate> = {};
    const loadArticles = vi.fn(async (limit: number) => articles.slice(0, limit));
    const provider = vi.fn((): ImageProvider => createUnsplashProvider("KEY"));
    return {
      updates,
      loadArticles,
      provider,
      deps: {
        loadArticles,
        provider,
        updateArticle: async (id: string, u: ImageUpdate) => {
          if (id === failUpdateFor) throw new Error("db down");
          updates[id] = u;
        },
      },
    };
  }

  it("stores the photo with credit and profile link when found", async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [photo] }));
    fetchMock.mockResolvedValueOnce(json({}));
    const h = harness([art("a")]);
    expect(await runImage(h.deps)).toEqual({ processed: 1, found: 1, fallback: 0, failed: 0, deferred: 0, blockImages: { placed: 0, dropped: 0 } });
    expect(h.updates.a).toEqual({
      image_url: photo.urls.regular,
      image_credit: "Ada Lovelace",
      image_credit_url: "https://unsplash.com/@ada?utm_source=ai_newsroom&utm_medium=referral",
    });
  });

  it("uses the department default with null credit when nothing is found", async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [] }));
    const h = harness([art("a", "q", "defence")]);
    expect(await runImage(h.deps)).toEqual({ processed: 1, found: 0, fallback: 1, failed: 0, deferred: 0, blockImages: { placed: 0, dropped: 0 } });
    expect(h.updates.a).toEqual({ image_url: "/images/defaults/defence.svg", image_credit: null, image_credit_url: null });
  });

  it("falls back on an API error and keeps going", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));
    fetchMock.mockResolvedValueOnce(json({ results: [photo] }));
    fetchMock.mockResolvedValueOnce(json({}));
    const h = harness([art("a"), art("b")]);
    expect(await runImage(h.deps)).toEqual({ processed: 2, found: 1, fallback: 1, failed: 0, deferred: 0, blockImages: { placed: 0, dropped: 0 } });
    expect(h.updates.a.image_credit).toBeNull();
    expect(h.updates.b.image_credit).toBe("Ada Lovelace");
  });

  it("falls back on a network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const h = harness([art("a")]);
    expect(await runImage(h.deps)).toMatchObject({ found: 0, fallback: 1, failed: 0 });
  });

  it("on 429 falls back and stops calling the API for the rest of the run", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429));
    const h = harness([art("a", "q", "ev"), art("b", "q", "batteries"), art("c", "q", null)]);
    expect(await runImage(h.deps)).toEqual({ processed: 3, found: 0, fallback: 3, failed: 0, deferred: 0, blockImages: { placed: 0, dropped: 0 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.updates.b.image_url).toBe("/images/defaults/batteries.svg");
    expect(h.updates.c.image_url).toBe("/images/defaults/default.svg");
  });

  it("uses the default without calling the API when there is no image_query", async () => {
    const h = harness([art("a", null), art("b", "  ")]);
    expect(await runImage(h.deps)).toMatchObject({ processed: 2, fallback: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts a failed save as failed without stopping the run", async () => {
    fetchMock.mockResolvedValue(json({ results: [] }));
    const h = harness([art("a"), art("b")], "a");
    expect(await runImage(h.deps)).toEqual({ processed: 1, found: 0, fallback: 1, failed: 1, deferred: 0, blockImages: { placed: 0, dropped: 0 } });
    expect(h.updates).not.toHaveProperty("a");
    expect(h.updates).toHaveProperty("b");
  });

  it("respects BATCH_LIMIT and does nothing (no provider) when there is no work", async () => {
    fetchMock.mockResolvedValue(json({ results: [] }));
    const h = harness([art("a"), art("b"), art("c"), art("d")]);
    expect((await runImage(h.deps)).processed).toBe(3);
    expect(h.loadArticles).toHaveBeenCalledWith(3);

    const empty = harness([]);
    expect(await runImage(empty.deps)).toEqual({ processed: 0, found: 0, fallback: 0, failed: 0, deferred: 0, blockImages: { placed: 0, dropped: 0 } });
    expect(empty.provider).not.toHaveBeenCalled();
  });
});
