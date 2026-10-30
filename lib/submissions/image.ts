import { SUBMISSION_LIMITS } from "@/lib/config";

// Photo checks and processing for employee submissions.
// The type is read from the file's first bytes, never from its name or the browser's MIME type.

export type ImageKind = "jpeg" | "png" | "webp";

/** A refusal with a message that is safe to show the employee as it is. */
export class ImageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejected";
  }
}

export const PHOTO_TYPE_MESSAGE = "The photo must be a JPEG, PNG or WebP image. Other file types are not accepted.";
export const PHOTO_SIZE_MESSAGE = `The photo is too large. The limit is ${SUBMISSION_LIMITS.PHOTO_MAX_BYTES / (1024 * 1024)} MB.`;
export const PHOTO_UNREADABLE_MESSAGE = "That photo could not be read. Try saving it again as a JPEG or PNG and upload it again.";

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) => signature.every((b, i) => bytes[offset + i] === b);

/** JPEG (FF D8 FF), PNG (89 "PNG" CR LF 1A LF) or WebP ("RIFF" size "WEBP"), judged by magic bytes; null for anything else. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (bytes.length >= 8 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (bytes.length >= 12 && startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

/** Cheap checks that run before anything expensive: size, then the real type. Throws ImageRejected. */
export function checkPhoto(bytes: Uint8Array): ImageKind {
  if (bytes.length > SUBMISSION_LIMITS.PHOTO_MAX_BYTES) throw new ImageRejected(PHOTO_SIZE_MESSAGE);
  const kind = sniffImage(bytes);
  if (!kind) throw new ImageRejected(PHOTO_TYPE_MESSAGE);
  return kind;
}

export type ProcessedPhoto = { data: Buffer; width: number; height: number; contentType: "image/webp" };

/**
 * Re-encodes the photo: rotated upright from its EXIF orientation, then every piece of metadata
 * (EXIF, GPS, XMP, ICC) is dropped, scaled down to at most 1600px wide, saved as WebP. Re-encoding also
 * means nothing but pixels survives from the uploaded file. Throws ImageRejected for a corrupt or huge image.
 */
export async function processPhoto(bytes: Uint8Array): Promise<ProcessedPhoto> {
  checkPhoto(bytes);
  const { default: sharp } = await import("sharp");
  try {
    const { data, info } = await sharp(bytes, { failOn: "error", limitInputPixels: SUBMISSION_LIMITS.PHOTO_MAX_PIXELS })
      .rotate()
      .resize({ width: SUBMISSION_LIMITS.PHOTO_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, contentType: "image/webp" };
  } catch (err) {
    if (err instanceof ImageRejected) throw err;
    if (/pixel limit/i.test(err instanceof Error ? err.message : "")) {
      throw new ImageRejected("The photo has too many pixels. Please resize it and upload it again.");
    }
    throw new ImageRejected(PHOTO_UNREADABLE_MESSAGE);
  }
}
