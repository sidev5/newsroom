import { bareAddress, type GraphConfig } from "./config";
import { cleanMessageId, MailError, redactAddresses, type MailMessage, type MailProvider } from "./types";

type FetchLike = typeof fetch;

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Microsoft Graph sendMail with client credentials (application permission Mail.Send). */
export function createGraphProvider(cfg: GraphConfig, fetchImpl: FetchLike = (...a) => fetch(...a)): MailProvider {
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new MailError("Could not reach Microsoft to get an access token.", "send");
    });
    if (!res.ok) {
      throw new MailError("Microsoft refused the app credentials (check MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET).", "auth");
    }
    const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!json?.access_token) throw new MailError("Microsoft returned no access token.", "auth");
    token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3000) * 1000 };
    return token.value;
  }

  const recipients = (list: string[] | undefined) => (list ?? []).map((address) => ({ emailAddress: { address } }));

  return {
    name: "graph",
    supportsInlineImages: true,
    async send(message: MailMessage) {
      const auth = await accessToken();
      // Graph takes one body, so the HTML goes out; the plain-text part is for SMTP and .eml.
      const res = await fetchImpl(`${GRAPH}/users/${encodeURIComponent(bareAddress(message.from ?? cfg.from))}/sendMail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: message.subject,
            body: { contentType: "HTML", content: message.html },
            toRecipients: recipients(message.to),
            bccRecipients: recipients(message.bcc),
            attachments: (message.inlineImages ?? []).map((i) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: i.filename,
              contentType: i.contentType,
              contentBytes: i.content.toString("base64"),
              contentId: i.cid,
              isInline: true,
            })),
          },
          saveToSentItems: true,
        }),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => {
        throw new MailError("Could not reach Microsoft Graph.", "send");
      });

      if (res.status === 202 || res.ok) {
        // sendMail answers 202 with no body: the request id Microsoft assigns is what its logs can be searched by.
        const id = cleanMessageId(res.headers?.get("request-id") ?? res.headers?.get("client-request-id"));
        return id ? { messageId: id } : {};
      }
      if (res.status === 401 || res.status === 403) {
        throw new MailError("Microsoft Graph refused to send: the app needs the Mail.Send permission, and the sender mailbox must be allowed.", "auth");
      }
      const detail = redactAddresses(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "").slice(0, 200);
      throw new MailError(`Microsoft Graph returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`, "send");
    },
  };
}
