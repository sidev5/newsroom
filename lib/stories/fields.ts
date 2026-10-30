import { z } from "zod";
import { STORY_LIMITS as L } from "@/lib/config";
import { submissionSchema, type SubmissionSchemaOptions } from "@/lib/submissions/schema";
import { cleanLine } from "@/lib/submissions/text";

// The form fields around the blocks of a Write story. Most are the same rules as the old /submit form (same name, email,
// department, sector and country checks), so they come from the same schema; the title and the summary have their own limits.

export const STORY_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "authorDepartment",
  "sector",
  "title",
  "summary",
  "country",
  "showName",
  "ownWork",
  "noConfidential",
] as const;

export type StoryField = (typeof STORY_FIELDS)[number];
export type RawStoryFields = Record<StoryField, string>;

const issue = (ctx: z.RefinementCtx, message: string) => ctx.addIssue({ code: "custom", message });

export function storyFieldsSchema(opts: SubmissionSchemaOptions) {
  return submissionSchema(opts)
    .omit({ text: true, photoCredit: true, title: true })
    .extend({
      title: z
        .string()
        .transform(cleanLine)
        .superRefine((v, ctx) => {
          if (v.length < L.TITLE_MIN) issue(ctx, `Give your story a title of at least ${L.TITLE_MIN} characters.`);
          else if (v.length > L.TITLE_MAX) issue(ctx, `The title can be at most ${L.TITLE_MAX} characters (it has ${v.length}).`);
        }),
      // Optional: the line under the title on the feed card. Empty means the start of the story is used.
      summary: z
        .string()
        .transform(cleanLine)
        .superRefine((v, ctx) => {
          if (v.length > L.SUMMARY_MAX) issue(ctx, `The summary can be at most ${L.SUMMARY_MAX} characters (it has ${v.length}).`);
        })
        .transform((v) => v || null),
      // Consent to show the author's name on the published story. Not ticked: "Newsroom contributor".
      showName: z.string().transform((v) => v === "on"),
    });
}

export type ValidStoryFields = z.output<ReturnType<typeof storyFieldsSchema>>;

/** The first message per field. */
export function storyFieldErrors(error: z.ZodError): Partial<Record<StoryField, string>> {
  const out: Partial<Record<StoryField, string>> = {};
  for (const i of error.issues) {
    const key = String(i.path[0] ?? "");
    if (key && !(key in out)) out[key as StoryField] = i.message;
  }
  return out;
}

/** The fields of a form as strings; a checkbox is "on" or "". */
export function readStoryFields(form: FormData): RawStoryFields {
  const out = {} as RawStoryFields;
  for (const name of STORY_FIELDS) {
    const value = form.get(name);
    out[name] = typeof value === "string" ? value : "";
  }
  return out;
}
