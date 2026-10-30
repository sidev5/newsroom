export type InlineImage = {
  /** Referenced in the HTML as src="cid:<cid>". */
  cid: string;
  filename: string;
  contentType: string;
  content: Buffer;
};

export type MailMessage = {
  /** "addr@example.com" or "Name <addr@example.com>". Optional only for an .eml draft. */
  from?: string;
  to: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html: string;
  inlineImages?: InlineImage[];
  headers?: Record<string, string>;
};

/** disabled: EMAIL_PROVIDER=none. auth: the mail server refused the login. config: settings missing or invalid. send: anything else. */
export type MailErrorKind = "disabled" | "auth" | "config" | "send";

/** `message` is safe to show to an admin and to log: it never holds a secret or an address. */
export class MailError extends Error {
  constructor(
    message: string,
    readonly kind: MailErrorKind,
  ) {
    super(message);
    this.name = "MailError";
  }
}

/** What the provider says about an accepted message. `messageId` is the provider's own id, for tracing it in the mail logs. */
export type MailReceipt = { messageId?: string };

export interface MailProvider {
  readonly name: "smtp" | "graph" | "none";
  /** Whether sent mail can carry CID inline images. */
  readonly supportsInlineImages: boolean;
  /** Resolves when the provider has accepted the message. A receipt is returned when the provider gives an id. */
  send(message: MailMessage): Promise<MailReceipt | void>;
}

/** The id as it is logged: without the angle brackets of an RFC 5322 Message-ID, and short. */
export function cleanMessageId(id: string | undefined | null): string | null {
  const text = (id ?? "").trim().replace(/^<|>$/g, "").slice(0, 200);
  return text || null;
}

export const SMTP_AUTH_DISABLED_MESSAGE = "SMTP AUTH is disabled for this mailbox; ask IT to enable it, or use Download .eml";
export const MAIL_DISABLED_MESSAGE = "Email sending is switched off (EMAIL_PROVIDER=none). Use Download .eml, or set EMAIL_PROVIDER to smtp or graph.";

/** Removes anything that looks like an email address from text that may be shown or logged. */
export function redactAddresses(text: string): string {
  return text.replace(/[^\s<>"',;()]+@[^\s<>"',;()]+/g, "[address]");
}
