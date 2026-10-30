import "server-only";
import type { InlineImage } from "@/lib/mail/types";
import { LEAD_IMAGE, renderDigest, sizedImageUrl } from "./render";
import { hasPhoto } from "./select";
import type { MailBuilder } from "./service";

export const LEAD_CID = "lead-image@company-newsroom";
const MAX_IMAGE_BYTES = 3_000_000;
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

/**
 * Downloads the lead image so it can travel inside the message (CID), which shows without "Download
 * pictures" in Outlook. Null on any problem: the email then hotlinks the image instead.
 */
export async function fetchInlineImage(url: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<InlineImage | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!ext) return null;
    const content = Buffer.from(await res.arrayBuffer());
    if (content.length === 0 || content.length > MAX_IMAGE_BYTES) return null;
    if (type === "image/webp") {
      // Employee photos are stored as WebP, which Outlook for Windows cannot display: send a JPEG copy.
      const { default: sharp } = await import("sharp");
      const jpeg = await sharp(content).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
      return { cid: LEAD_CID, filename: "lead.jpg", contentType: "image/jpeg", content: jpeg };
    }
    return { cid: LEAD_CID, filename: `lead.${ext}`, contentType: type, content };
  } catch {
    return null;
  }
}

/** Builds subject, HTML and text for a stored digest, embedding the lead image when asked and possible. */
export function makeMailBuilder(opts: { siteUrl: string; contact: string | null; fetchImpl?: typeof fetch }): MailBuilder {
  return async (digest, articles, { inlineImages }) => {
    const [lead] = articles;
    const image =
      inlineImages && lead && hasPhoto(lead) && lead.image_url
        ? await fetchInlineImage(sizedImageUrl(lead.image_url, LEAD_IMAGE.width, LEAD_IMAGE.height), opts.fetchImpl)
        : null;
    const { subject, html, text } = renderDigest({
      subject: digest.subject,
      intro: digest.intro,
      weekStart: digest.week_start,
      siteUrl: opts.siteUrl,
      articles,
      leadImageCid: image ? image.cid : null,
      contact: opts.contact,
    });
    return { subject, html, text, inlineImages: image ? [image] : undefined };
  };
}
