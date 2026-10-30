import { STORY_LIMITS } from "@/lib/config";
import { TURNSTILE_FIELD } from "@/lib/submissions/turnstile";
import { readStoryFields } from "./fields";
import type { StoryImageFile, StoryInput } from "./submit";

// Reading a Write submission out of the multipart request the form sends: the plain fields, a JSON field `blocks`, and one
// file field per image block, named `image:<block id>`. Nothing is trusted here; submitBlocksStory validates it all.

const IMAGE_FIELD = /^image:([A-Za-z0-9_-]{1,40})$/;

export type ParsedRequest = { ok: true; input: StoryInput } | { ok: false; error: string };

export function readStoryRequest(form: FormData, ip: string | null): ParsedRequest {
  const raw = form.get("blocks");
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "The story is empty. Reload the page and try again." };
  if (raw.length > STORY_LIMITS.PAYLOAD_MAX_BYTES) return { ok: false, error: "The story is too large." };
  let blocks: unknown;
  try {
    blocks = JSON.parse(raw);
  } catch {
    return { ok: false, error: "The story could not be read. Reload the page and try again." };
  }

  const images = new Map<string, StoryImageFile>();
  for (const [name, value] of form.entries()) {
    const match = IMAGE_FIELD.exec(name);
    if (match && typeof value !== "string" && value.size > 0 && !images.has(match[1])) {
      images.set(match[1], { size: value.size, bytes: async () => new Uint8Array(await value.arrayBuffer()) });
    }
  }

  const honeypot = form.get("website");
  const token = form.get(TURNSTILE_FIELD);
  return {
    ok: true,
    input: {
      fields: readStoryFields(form),
      blocks,
      honeypot: typeof honeypot === "string" ? honeypot : "",
      captchaToken: typeof token === "string" ? token : null,
      images,
      ip,
    },
  };
}
