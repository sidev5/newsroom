import { z } from "zod";
import { SUBMISSION_AUTHOR_DEPARTMENTS, SUBMISSION_LIMITS as L } from "@/lib/config";
import { COUNTRIES } from "@/lib/geo/countries";
import { describeDomains, emailAllowed, normalizeEmail } from "./identity";
import { cleanLine, cleanParagraphs } from "./text";

// Server-side validation of the /submit form. The browser's checks are a convenience only: everything
// is validated again here, on text that has already been cleaned of control characters.

export type SubmissionSchemaOptions = {
  /** Allowed company email domains. Empty: any email passes (the submission is stored as unverified). */
  allowedDomains: readonly string[];
  /** Slugs of the departments a story can be filed under. */
  sectors: readonly string[];
  /** Company departments an author can belong to. */
  authorDepartments?: readonly string[];
};

/** Names of the fields the form posts, so a typo cannot silently drop one. */
export const FORM_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "authorDepartment",
  "sector",
  "title",
  "text",
  "country",
  "photoCredit",
  "ownWork",
  "noConfidential",
] as const;
export type FormField = (typeof FORM_FIELDS)[number] | "photo";

export type RawSubmission = Record<(typeof FORM_FIELDS)[number], string>;

/** Reads the known fields from a FormData as strings (a File in a text field counts as empty). Checkbox: "on" or "". */
export function readSubmission(form: FormData): RawSubmission {
  const out = {} as RawSubmission;
  for (const name of FORM_FIELDS) {
    const value = form.get(name);
    out[name] = typeof value === "string" ? value : "";
  }
  return out;
}

const issue = (ctx: z.RefinementCtx, message: string) => ctx.addIssue({ code: "custom", message });

const name = (label: string, tooLong: string) =>
  z
    .string()
    .transform(cleanLine)
    .superRefine((v, ctx) => {
      if (!v) issue(ctx, `Enter your ${label}.`);
      else if (v.length > L.NAME_MAX) issue(ctx, tooLong);
    });

export function submissionSchema(opts: SubmissionSchemaOptions) {
  const authorDepartments = opts.authorDepartments ?? SUBMISSION_AUTHOR_DEPARTMENTS;

  return z.object({
    firstName: name("first name", `The first name can be at most ${L.NAME_MAX} characters.`),
    lastName: name("last name", `The last name can be at most ${L.NAME_MAX} characters.`),

    email: z
      .string()
      .transform((v) => normalizeEmail(cleanLine(v)))
      .superRefine((v, ctx) => {
        if (!v) return issue(ctx, "Enter your company email address.");
        if (v.length > L.EMAIL_MAX || !z.email().safeParse(v).success) return issue(ctx, "That does not look like an email address.");
        if (!emailAllowed(v, opts.allowedDomains)) {
          issue(ctx, `Use your company email address (it must end with ${describeDomains(opts.allowedDomains)}).`);
        }
      }),

    authorDepartment: z
      .string()
      .transform(cleanLine)
      .superRefine((v, ctx) => {
        if (!v) issue(ctx, "Choose the department you work in.");
        else if (!authorDepartments.includes(v)) issue(ctx, "Choose your department from the list.");
      }),

    sector: z
      .string()
      .transform(cleanLine)
      .superRefine((v, ctx) => {
        if (!v) issue(ctx, "Choose the sector this story is for.");
        else if (!opts.sectors.includes(v)) issue(ctx, "Choose a sector from the list.");
      }),

    title: z
      .string()
      .transform(cleanLine)
      .superRefine((v, ctx) => {
        if (v.length < L.TITLE_MIN) issue(ctx, `Give your story a title of at least ${L.TITLE_MIN} characters.`);
        else if (v.length > L.TITLE_MAX) issue(ctx, `The title can be at most ${L.TITLE_MAX} characters (it has ${v.length}).`);
      }),

    text: z
      .string()
      .transform(cleanParagraphs)
      .superRefine((v, ctx) => {
        if (v.length < L.TEXT_MIN) issue(ctx, `The story needs at least ${L.TEXT_MIN} characters (it has ${v.length}).`);
        else if (v.length > L.TEXT_MAX) issue(ctx, `The story can be at most ${L.TEXT_MAX} characters (it has ${v.length}).`);
      }),

    // Optional. Empty means "no country" and keeps the story off the globe.
    country: z
      .string()
      .transform((v) => cleanLine(v).toUpperCase())
      .superRefine((v, ctx) => {
        if (v && !Object.hasOwn(COUNTRIES, v)) issue(ctx, "Choose a country from the list, or leave it empty.");
      })
      .transform((v) => v || null),

    photoCredit: z
      .string()
      .transform(cleanLine)
      .superRefine((v, ctx) => {
        if (v.length > L.CREDIT_MAX) issue(ctx, `The photo credit or caption can be at most ${L.CREDIT_MAX} characters.`);
      })
      .transform((v) => v || null),

    ownWork: z
      .string()
      .refine((v) => v === "on", "Please confirm that this is your own work and that you are allowed to share it.")
      .transform(() => true as const),

    noConfidential: z
      .string()
      .refine((v) => v === "on", "Please confirm that the story contains no confidential or customer information.")
      .transform(() => true as const),
  });
}

export type ValidSubmission = z.output<ReturnType<typeof submissionSchema>>;

/** The first message per field, keyed by form field name. */
export function fieldErrors(error: z.ZodError): Partial<Record<FormField, string>> {
  const out: Partial<Record<FormField, string>> = {};
  for (const i of error.issues) {
    const key = String(i.path[0] ?? "");
    if (key && !(key in out)) out[key as FormField] = i.message;
  }
  return out;
}
