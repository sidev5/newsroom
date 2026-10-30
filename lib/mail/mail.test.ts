import { describe, expect, it, vi } from "vitest";
import { article, digestRow } from "@/lib/digest/memory-store";
import { fetchInlineImage, LEAD_CID, makeMailBuilder } from "@/lib/digest/prepare";
import { bareAddress, emailProvider, graphConfig, senderAddress, smtpConfig } from "./config";
import { buildEml } from "./eml";
import { createGraphProvider } from "./graph";
import { buildEml as emlFromIndex, createNoneProvider, getMailProvider } from "./index";
import { createSmtpProvider, mapSmtpError } from "./smtp";
import { MAIL_DISABLED_MESSAGE, MailError, redactAddresses, SMTP_AUTH_DISABLED_MESSAGE, type MailMessage } from "./types";

const message: MailMessage = {
  from: "Company Newsroom <newsroom@example.com>",
  to: ["newsroom@example.com"],
  bcc: ["reader1@readers.test", "reader2@readers.test"],
  subject: "Company Newsroom weekly: Headline",
  text: "plain text body",
  html: '<p>html body <img src="cid:lead-image@company-newsroom"></p>',
  inlineImages: [{ cid: "lead-image@company-newsroom", filename: "lead.jpg", contentType: "image/jpeg", content: Buffer.from("fake-jpeg-bytes") }],
};

/** The error a promise rejects with; fails the test if it resolves. */
async function failure(promise: Promise<unknown>): Promise<MailError> {
  try {
    await promise;
  } catch (e) {
    return e as MailError;
  }
  throw new Error("expected the promise to reject");
}

const SMTP_ENV = {
  EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "smtp.office365.com",
  SMTP_PORT: "587",
  SMTP_USER: "newsroom@example.com",
  SMTP_PASS: "S3cr3t-Password!",
  MAIL_FROM: "Company Newsroom <newsroom@example.com>",
};

// ---------------------------------------------------------------------------
// none
// ---------------------------------------------------------------------------
describe("EMAIL_PROVIDER=none", () => {
  it("is the default, and needs no settings at all", () => {
    expect(emailProvider({})).toBe("none");
    expect(emailProvider({ EMAIL_PROVIDER: "" })).toBe("none");
    expect(getMailProvider({}).name).toBe("none");
  });

  it("never sends: send() refuses with a message pointing to Download .eml", async () => {
    const p = createNoneProvider();
    await expect(p.send(message)).rejects.toMatchObject({ kind: "disabled", message: MAIL_DISABLED_MESSAGE });
    expect(MAIL_DISABLED_MESSAGE).toContain("Download .eml");
  });

  it("still lets the .eml be built", async () => {
    const eml = (await emlFromIndex(message)).toString();
    expect(eml).toContain("Subject: Company Newsroom weekly: Headline");
  });
});

// ---------------------------------------------------------------------------
// Validation only when the provider is used
// ---------------------------------------------------------------------------
describe("settings are validated only when the provider is used", () => {
  it("rejects an unknown provider name", () => {
    expect(() => emailProvider({ EMAIL_PROVIDER: "carrier-pigeon" })).toThrow(/smtp, graph, none/);
  });

  it("smtp: parses valid settings, defaulting the port to 587", () => {
    expect(smtpConfig({ ...SMTP_ENV, SMTP_PORT: undefined })).toMatchObject({ host: "smtp.office365.com", port: 587, user: "newsroom@example.com", from: "Company Newsroom <newsroom@example.com>" });
    expect(bareAddress("Company Newsroom <newsroom@example.com>")).toBe("newsroom@example.com");
  });

  it("smtp: names the missing settings, and never echoes a value", () => {
    let error: unknown;
    try {
      smtpConfig({ EMAIL_PROVIDER: "smtp", SMTP_PASS: "S3cr3t-Password!", MAIL_FROM: "not an address" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MailError);
    const text = (error as MailError).message;
    expect(text).toContain("SMTP_HOST");
    expect(text).toContain("SMTP_USER");
    expect(text).toContain("MAIL_FROM");
    expect(text).not.toContain("S3cr3t");
    expect((error as MailError).kind).toBe("config");
  });

  it("getMailProvider(smtp) fails with a clear message when the settings are missing", () => {
    expect(() => getMailProvider({ EMAIL_PROVIDER: "smtp" })).toThrow(/Invalid SMTP settings/);
    expect(() => getMailProvider({ EMAIL_PROVIDER: "graph" })).toThrow(/Invalid Microsoft Graph settings/);
  });

  it("graph: needs tenant, client, secret and sender", () => {
    expect(() => graphConfig({ MS_TENANT_ID: "t" })).toThrow(/MS_CLIENT_ID/);
    expect(graphConfig({ MS_TENANT_ID: "t", MS_CLIENT_ID: "c", MS_CLIENT_SECRET: "s", MAIL_FROM: "a@example.com" })).toMatchObject({ tenantId: "t", from: "a@example.com" });
  });

  it("senderAddress is optional", () => {
    expect(senderAddress({})).toBeUndefined();
    expect(senderAddress({ MAIL_FROM: "junk" })).toBeUndefined();
    expect(senderAddress({ MAIL_FROM: "a@example.com" })).toBe("a@example.com");
  });
});

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------
describe("smtp provider", () => {
  function transportSpy(fail?: unknown) {
    const sendMail = vi.fn(async () => {
      if (fail) throw fail;
    });
    const createTransport = vi.fn(() => ({ sendMail }));
    return { sendMail, createTransport };
  }
  const cfg = smtpConfig(SMTP_ENV);

  it("connects with STARTTLS on port 587", () => {
    const t = transportSpy();
    createSmtpProvider(cfg, t.createTransport);
    expect(t.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.office365.com", port: 587, secure: false, requireTLS: true, auth: { user: "newsroom@example.com", pass: "S3cr3t-Password!" } }),
    );
  });

  it("sends with BCC and the lead image as an inline CID attachment", async () => {
    const t = transportSpy();
    const p = createSmtpProvider(cfg, t.createTransport);
    expect(p.supportsInlineImages).toBe(true);
    await p.send(message);
    expect(t.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: message.from,
        to: message.to,
        bcc: message.bcc,
        subject: message.subject,
        text: "plain text body",
        attachments: [expect.objectContaining({ cid: "lead-image@company-newsroom", contentDisposition: "inline", contentType: "image/jpeg" })],
      }),
    );
  });

  it.each([
    ["535 5.7.139 by response code", { responseCode: 535, message: "Invalid login: 535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant." }],
    ["EAUTH", { code: "EAUTH", message: "Invalid login" }],
    ["5.7.139 by text only", { message: "Error: 5.7.139 SmtpClientAuthentication is disabled" }],
  ])("explains an auth failure (%s) in plain words", async (_n, err) => {
    const p = createSmtpProvider(cfg, transportSpy(err).createTransport);
    await expect(p.send(message)).rejects.toMatchObject({ kind: "auth", message: SMTP_AUTH_DISABLED_MESSAGE });
    expect(SMTP_AUTH_DISABLED_MESSAGE).toBe("SMTP AUTH is disabled for this mailbox; ask IT to enable it, or use Download .eml");
  });

  it("reports other failures without addresses or the password", async () => {
    const p = createSmtpProvider(cfg, transportSpy({ code: "EENVELOPE", message: "Can't send mail - all recipients were rejected: reader1@readers.test S3cr3t-Password!" }).createTransport);
    const err = await failure(p.send(message));
    expect(err).toBeInstanceOf(MailError);
    expect(err.kind).toBe("send");
    expect(err.message).toContain("EENVELOPE");
    expect(err.message).not.toContain("readers.test");
    // The password is never part of what we add; a server echoing it is outside our control, but we never do.
    expect(mapSmtpError({ code: "ETIMEDOUT", message: "timeout" }).message).not.toContain("S3cr3t");
  });

  it("redacts addresses", () => {
    expect(redactAddresses("failed for a@b.co, c@d.co and <e@f.co>")).toBe("failed for [address], [address] and <[address]>");
  });
});

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------
describe("graph provider", () => {
  const cfg = graphConfig({ MS_TENANT_ID: "tenant-1", MS_CLIENT_ID: "client-1", MS_CLIENT_SECRET: "graph-secret", MAIL_FROM: "Company Newsroom <newsroom@example.com>" });

  function fetchStub(sendStatus = 202) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      return new Response(sendStatus === 202 ? null : JSON.stringify({ error: { message: "bad for x@y.co" } }), { status: sendStatus });
    });
    return { fn: fn as unknown as typeof fetch, calls };
  }

  it("gets a token with client credentials, then calls sendMail with BCC and an inline attachment", async () => {
    const f = fetchStub();
    await createGraphProvider(cfg, f.fn).send(message);
    expect(f.calls[0].url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    expect(String(f.calls[0].init.body)).toContain("grant_type=client_credentials");
    expect(f.calls[1].url).toBe("https://graph.microsoft.com/v1.0/users/newsroom%40example.com/sendMail");
    expect((f.calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(String(f.calls[1].init.body));
    expect(body.message.subject).toBe(message.subject);
    expect(body.message.body).toEqual({ contentType: "HTML", content: message.html });
    expect(body.message.bccRecipients).toEqual([{ emailAddress: { address: "reader1@readers.test" } }, { emailAddress: { address: "reader2@readers.test" } }]);
    expect(body.message.attachments[0]).toMatchObject({ isInline: true, contentId: "lead-image@company-newsroom", contentBytes: Buffer.from("fake-jpeg-bytes").toString("base64") });
  });

  it("reuses the token for a second send", async () => {
    const f = fetchStub();
    const p = createGraphProvider(cfg, f.fn);
    await p.send(message);
    await p.send(message);
    expect(f.calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
  });

  it("explains a refusal without echoing addresses", async () => {
    await expect(createGraphProvider(cfg, fetchStub(403).fn).send(message)).rejects.toMatchObject({ kind: "auth", message: expect.stringContaining("Mail.Send") });
    const err = await failure(createGraphProvider(cfg, fetchStub(400).fn).send(message));
    expect(err.message).toContain("HTTP 400");
    expect(err.message).not.toContain("x@y.co");
  });

  it("explains bad app credentials without the secret", async () => {
    const fn = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const err = await failure(createGraphProvider(cfg, fn).send(message));
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain("graph-secret");
  });
});

// ---------------------------------------------------------------------------
// .eml
// ---------------------------------------------------------------------------
describe("buildEml", () => {
  it("makes an unsent-draft message with text, HTML and the inline image", async () => {
    const eml = (await buildEml({ ...message, to: [], bcc: [] })).toString();
    expect(eml).toContain("X-Unsent: 1");
    expect(eml).toContain("Subject: Company Newsroom weekly: Headline");
    expect(eml).toMatch(/Content-Type: multipart\/(alternative|related|mixed)/);
    expect(eml).toContain("Content-Type: text/plain");
    expect(eml).toContain("Content-Type: text/html");
    expect(eml).toContain("Content-ID: <lead-image@company-newsroom>");
    expect(eml).toContain("Content-Type: image/jpeg");
    expect(eml).toContain("From: Company Newsroom <newsroom@example.com>");
  });

  it("works with no sender and no recipients", async () => {
    const eml = (await buildEml({ ...message, from: undefined, to: [], bcc: [], inlineImages: undefined })).toString();
    expect(eml).toContain("Subject:");
    expect(eml).not.toContain("Content-ID");
  });
});

// ---------------------------------------------------------------------------
// The mail builder and the inline image
// ---------------------------------------------------------------------------
describe("makeMailBuilder", () => {
  const digest = digestRow({ week_start: "2026-10-19", subject: "Company Newsroom weekly: Headline a1", intro: "Intro" });
  const articles = [article("a1"), article("b2", { image_url: null })];
  const jpeg = () => new Response(Buffer.from("jpegbytes"), { status: 200, headers: { "content-type": "image/jpeg" } });

  it("embeds the lead image as a CID when asked and downloadable", async () => {
    const fetchImpl = vi.fn(async () => jpeg()) as unknown as typeof fetch;
    const out = await makeMailBuilder({ siteUrl: "https://s.example.com", contact: null, fetchImpl })(digest, articles, { inlineImages: true });
    expect(out.inlineImages).toHaveLength(1);
    expect(out.inlineImages![0]).toMatchObject({ cid: LEAD_CID, contentType: "image/jpeg", filename: "lead.jpg" });
    expect(out.html).toContain(`<img src="cid:${LEAD_CID}"`);
    expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("fit=crop");
  });

  it("hotlinks the image when inline images are not wanted", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const out = await makeMailBuilder({ siteUrl: "https://s.example.com", contact: null, fetchImpl })(digest, articles, { inlineImages: false });
    expect(out.inlineImages).toBeUndefined();
    expect(out.html).toContain("https://images.unsplash.com/photo-a1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to the hotlink when the download fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const out = await makeMailBuilder({ siteUrl: "https://s.example.com", contact: null, fetchImpl })(digest, articles, { inlineImages: true });
    expect(out.inlineImages).toBeUndefined();
    expect(out.html).toContain("https://images.unsplash.com/photo-a1");
    expect(out.html).not.toContain("cid:");
  });

  it("refuses something that is not an image, or is too big", async () => {
    const html = vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect(await fetchInlineImage("https://x.test/a", html)).toBeNull();
    const big = vi.fn(async () => new Response(Buffer.alloc(3_000_001), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    expect(await fetchInlineImage("https://x.test/a", big)).toBeNull();
    const svg = vi.fn(async () => new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } })) as unknown as typeof fetch;
    expect(await fetchInlineImage("https://x.test/a", svg)).toBeNull();
    const boom = vi.fn(async () => Promise.reject(new Error("network"))) as unknown as typeof fetch;
    expect(await fetchInlineImage("https://x.test/a", boom)).toBeNull();
  });

  it("uses the stored subject and intro, and the story order", async () => {
    const out = await makeMailBuilder({ siteUrl: "https://s.example.com", contact: "c@example.com", fetchImpl: vi.fn(async () => jpeg()) as unknown as typeof fetch })(digest, articles, { inlineImages: false });
    expect(out.subject).toBe("Company Newsroom weekly: Headline a1");
    expect(out.html).toContain("Intro");
    expect(out.html.indexOf("Headline a1")).toBeLessThan(out.html.indexOf("Headline b2"));
    expect(out.text).toContain("Contact: c@example.com");
  });
});
