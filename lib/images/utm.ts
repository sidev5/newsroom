import { IMAGE_UTM } from "@/lib/config";

/** Adds Unsplash's required utm_source / utm_medium to a link. */
export function withUtm(url: string): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", IMAGE_UTM.source);
  u.searchParams.set("utm_medium", IMAGE_UTM.medium);
  return u.toString();
}

export const UNSPLASH_HOME = "https://unsplash.com/";

export type PhotoCreditLinks = { name: string; profileUrl: string; unsplashUrl: string };

/**
 * Links for "Photo by <name> on Unsplash". Null for fallback images (no credit) and
 * for stored URLs that aren't on unsplash.com, so a bad row can't render an arbitrary link.
 */
export function photoCreditLinks(
  credit: string | null | undefined,
  creditUrl: string | null | undefined,
): PhotoCreditLinks | null {
  if (!credit || !creditUrl) return null;
  try {
    const u = new URL(creditUrl);
    if (u.protocol !== "https:" || (u.hostname !== "unsplash.com" && u.hostname !== "www.unsplash.com")) return null;
  } catch {
    return null;
  }
  return { name: credit, profileUrl: creditUrl, unsplashUrl: withUtm(UNSPLASH_HOME) };
}
