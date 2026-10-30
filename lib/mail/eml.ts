import nodemailer from "nodemailer";
import type { MailMessage } from "./types";

/**
 * A complete RFC 822 message (multipart: plain text + HTML, with CID images) for "Download .eml".
 * `X-Unsent: 1` makes Outlook open it as an unsent draft, so the admin can add recipients and send it
 * from their own mailbox when SMTP AUTH is not available.
 */
export async function buildEml(message: MailMessage): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await transport.sendMail({
    from: message.from,
    to: message.to,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: { "X-Unsent": "1", ...message.headers },
    attachments: (message.inlineImages ?? []).map((i) => ({
      filename: i.filename,
      content: i.content,
      contentType: i.contentType,
      cid: i.cid,
      contentDisposition: "inline" as const,
    })),
    // A draft has no recipients yet; the envelope only needs something to build the message.
    envelope: { from: "draft@localhost.invalid", to: ["draft@localhost.invalid"] },
  });
  return (info as unknown as { message: Buffer }).message;
}
