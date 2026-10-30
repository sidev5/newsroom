import { DEFAULT_IMAGE_SLUGS } from "@/lib/config";
import { env, requireEnv } from "@/lib/env";
import type { ImageProvider } from "./types";
import { createUnsplashProvider } from "./unsplash";

export type { ImageProvider, ImageResult } from "./types";

/** Provider for IMAGE_PROVIDER. Add a module in this folder and a case here for another one. */
export function getImageProvider(): ImageProvider {
  switch (env().IMAGE_PROVIDER) {
    case "unsplash":
      return createUnsplashProvider(requireEnv("UNSPLASH_ACCESS_KEY"));
  }
}

/** Department default SVG (public/images/defaults/), or the generic one. */
export function defaultImageFor(departmentSlug: string | null | undefined): string {
  const known = (DEFAULT_IMAGE_SLUGS as readonly string[]).includes(departmentSlug ?? "");
  return `/images/defaults/${known ? departmentSlug : "default"}.svg`;
}
