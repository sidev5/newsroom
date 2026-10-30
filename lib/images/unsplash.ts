import { z } from "zod";
import { ImageSearchError, type ImageProvider, type ImageResult } from "./types";
import { withUtm } from "./utm";

const API = "https://api.unsplash.com";

const searchResponse = z.object({
  results: z.array(
    z.object({
      urls: z.object({ regular: z.url() }),
      links: z.object({ download_location: z.url() }),
      user: z.object({ name: z.string().min(1), links: z.object({ html: z.url() }) }),
    }),
  ),
});

export function createUnsplashProvider(
  accessKey: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  timeoutMs = 10_000,
): ImageProvider {
  const headers = { Authorization: `Client-ID ${accessKey}`, "Accept-Version": "v1" };

  async function get(url: string): Promise<Response> {
    try {
      return await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new ImageSearchError(`Unsplash request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    name: "unsplash",

    async searchImage(query: string): Promise<ImageResult | null> {
      const params = new URLSearchParams({ query, orientation: "landscape", per_page: "1" });
      const res = await get(`${API}/search/photos?${params}`);
      if (!res.ok) throw new ImageSearchError(`Unsplash search returned HTTP ${res.status}`, res.status);

      const parsed = searchResponse.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new ImageSearchError("Unsplash search returned an unexpected response");

      const photo = parsed.data.results[0];
      if (!photo) return null;

      // Unsplash requires a call to download_location when a photo is used. It's a usage
      // signal, so a failure here must not lose a good image.
      await get(photo.links.download_location).catch(() => undefined);

      return {
        url: photo.urls.regular, // hotlinked as returned; the API's ixid parameters stay intact
        credit: photo.user.name,
        creditUrl: withUtm(photo.user.links.html),
      };
    },
  };
}
