import { SUBMISSION_LIMITS } from "@/lib/config";
import { fitWithin } from "@/lib/stories/editor";

// Choosing an image in the editor: it is scaled down in the browser before it is sent (most photos are several MB and the
// request carries up to eight), shown as a data: address in the editor and the preview, and sent as a file. The browser's work is
// a convenience: the server checks the real bytes, strips the metadata and re-encodes the image again.

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const LIGHT_ENOUGH = 1.5 * 1024 * 1024;

export type PreparedImage = { file: File; dataUrl: string } | { error: string };

async function downscale(file: File): Promise<File> {
  try {
    if (typeof createImageBitmap !== "function") return file;
    const bitmap = await createImageBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, SUBMISSION_LIMITS.PHOTO_MAX_WIDTH);
    const resized = width !== bitmap.width;
    if (!resized && file.size <= LIGHT_ENOUGH) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return file;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
    if (!blob || blob.type !== "image/webp" || (!resized && blob.size >= file.size)) return file;
    return new File([blob], `${file.name.replace(/\.[^.]*$/, "") || "image"}.webp`, { type: "image/webp" });
  } catch {
    return file;
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!TYPES.includes(file.type)) return { error: "The image must be a JPEG, PNG or WebP file." };
  const small = await downscale(file);
  if (small.size > SUBMISSION_LIMITS.PHOTO_MAX_BYTES) return { error: `The image is too large. The limit is ${SUBMISSION_LIMITS.PHOTO_MAX_BYTES / (1024 * 1024)} MB.` };
  try {
    return { file: small, dataUrl: await readAsDataUrl(small) };
  } catch {
    return { error: "The image could not be read. Please try another file." };
  }
}