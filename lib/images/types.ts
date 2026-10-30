export type ImageResult = {
  /** Image URL exactly as the provider returned it (hotlinked, never re-hosted). */
  url: string;
  /** Photographer's name. */
  credit: string;
  /** Link to the photographer's page, with any attribution parameters the provider requires. */
  creditUrl: string;
};

/**
 * One small module per provider. Return null when nothing matches; throw
 * ImageSearchError on API failures. The pipeline treats both as "use the default image".
 */
export interface ImageProvider {
  readonly name: "unsplash";
  searchImage(query: string): Promise<ImageResult | null>;
}

export class ImageSearchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ImageSearchError";
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}
