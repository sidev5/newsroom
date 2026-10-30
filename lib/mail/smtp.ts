import nodemailer from "nodemailer";
import type { SmtpConfig } from "./config";
import { cleanMessageId, MailError, redactAddresses, SMTP_AUTH_DISABLED_MESSAGE, type MailMessage, type MailProvider } from "./types";

type Transport = { sendMail(options: Record<string, unknown>): Promise<unknown> };
type CreateTransport = (options: Record<string, unknown>) => Transport;

/** Maps an nodemailer error to a MailError. Auth failures get the actionable message; nothing else leaks details. */
export function mapSmtpError(err: unknown): MailError {
  const e = err as { code?: string; responseCode?: number; message?: string } | null;
  const text = String(e?.message ?? "");
  // 535 5.7.139 is "SMTP AUTH is disabled" for the tenant or mailbox; any login refusal gets the same advice.
  if (e?.code === "EAUTH" || e?.responseCode === 535 || /\b535\b|5\.7\.139|5\.7\.3\b/.test(text)) {
    return new MailError(SMTP_AUTH_DISABLED_MESSAGE, "auth");
  }
  const code = e?.code ? ` (${e.code})` : "";
  return new MailError(`The mail server did not accept the message${code}: ${redactAddresses(text).slice(0, 200)}`, "send");
}

/** SMTP with STARTTLS on port 587 (Microsoft 365: smtp.office365.com). Port 465 uses implicit TLS. */
export function createSmtpProvider(
  cfg: SmtpConfig,
  createTransport: CreateTransport = (o) => nodemailer.createTransport(o as never) as unknown as Transport,
): MailProvider {
  const transport = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    requireTLS: cfg.port !== 465,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 45_000,
  });

  return {
    name: "smtp",
    supportsInlineImages: true,
    async send(message: MailMessage) {
      try {
        const info = await transport.sendMail({
          from: message.from ?? cfg.from,
          to: message.to,
          bcc: message.bcc,
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: message.headers,
          attachments: (message.inlineImages ?? []).map((i) => ({
            filename: i.filename,
            content: i.content,
            contentType: i.contentType,
            cid: i.cid,
            contentDisposition: "inline",
          })),
        });
        const messageId = cleanMessageId((info as { messageId?: string } | null | undefined)?.messageId);
        return messageId ? { messageId } : {};
      } catch (err) {
        throw mapSmtpError(err);
      }
    },
  };
}
