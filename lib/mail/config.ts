import { z } from "zod";
import { MailError } from "./types";

// Mail settings are validated only when that provider is used, so an install that never sends email
// needs none of them. Error messages list setting names and rules, never values.

type Source = Record<string, string | undefined>;

export const PROVIDERS = ["smtp", "graph", "none"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** EMAIL_PROVIDER: smtp | graph | none (default none; unset or empty means none). */
export function emailProvider(source: Source = process.env): ProviderName {
  const raw = source.EMAIL_PROVIDER?.trim().toLowerCase();
  if (!raw) return "none";
  if ((PROVIDERS as readonly string[]).includes(raw)) return raw as ProviderName;
  throw new MailError(`EMAIL_PROVIDER must be one of ${PROVIDERS.join(", ")}.`, "config");
}

/** "addr@example.com" or "Name <addr@example.com>". */
const mailbox = z
  .string()
  .trim()
  .refine((v) => z.email().safeParse(/<([^<>]+)>\s*$/.exec(v)?.[1] ?? v).success, "must be an address like newsroom@example.com or Name <newsroom@example.com>");

const smtpSchema = z.object({
  SMTP_HOST: z.string().trim().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().trim().min(1),
  SMTP_PASS: z.string().min(1),
  MAIL_FROM: mailbox,
});

const graphSchema = z.object({
  MS_TENANT_ID: z.string().trim().min(1),
  MS_CLIENT_ID: z.string().trim().min(1),
  MS_CLIENT_SECRET: z.string().min(1),
  MAIL_FROM: mailbox,
});

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
};

export type GraphConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  from: string;
};

function problems(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

export function smtpConfig(source: Source = process.env): SmtpConfig {
  const parsed = smtpSchema.safeParse(source);
  if (!parsed.success) throw new MailError(`Invalid SMTP settings. ${problems(parsed.error)}`, "config");
  const v = parsed.data;
  return { host: v.SMTP_HOST, port: v.SMTP_PORT, user: v.SMTP_USER, pass: v.SMTP_PASS, from: v.MAIL_FROM };
}

export function graphConfig(source: Source = process.env): GraphConfig {
  const parsed = graphSchema.safeParse(source);
  if (!parsed.success) throw new MailError(`Invalid Microsoft Graph settings. ${problems(parsed.error)}`, "config");
  const v = parsed.data;
  return { tenantId: v.MS_TENANT_ID, clientId: v.MS_CLIENT_ID, clientSecret: v.MS_CLIENT_SECRET, from: v.MAIL_FROM };
}

/** MAIL_FROM if it is set and valid, else undefined. For an .eml draft, which needs no mail server. */
export function senderAddress(source: Source = process.env): string | undefined {
  const parsed = mailbox.safeParse(source.MAIL_FROM ?? "");
  return parsed.success ? parsed.data : undefined;
}

/** The bare address of "Name <addr>" or "addr". */
export function bareAddress(from: string): string {
  return /<([^<>]+)>\s*$/.exec(from)?.[1]?.trim() ?? from.trim();
}
