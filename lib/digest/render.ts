// Renders the weekly digest. Pure: articles in, {subject, html, text} out.
//
// The HTML is built for Outlook desktop (the Word engine), Outlook web and phones: nested tables, every
// style inline, bgcolor attributes next to the CSS backgrounds, width/height attributes on images, a
// bulletproof button made from a table cell, no flex/grid, no web fonts, no JavaScript, no <style> block.
import { departmentStyle } from "@/lib/news/departments";
import { byline, EMPLOYEE_TAG, isEmployeeStory } from "@/lib/news/byline";
import { sourceName } from "@/lib/news/format";
import { oneLiner, hasPhoto, summarySentences } from "./select";
import type { DigestArticle } from "./types";
import { formatLongDate } from "./week";

export type RenderInput = {
  subject: string;
  intro: string;
  /** Monday of the week, YYYY-MM-DD. */
  weekStart: string;
  /** Public URL of the dashboard, no trailing slash needed. */
  siteUrl: string;
  /** The stories in order; the first is the lead. */
  articles: DigestArticle[];
  /** When set, the lead image is referenced as cid:<this> (the caller attaches it) instead of by URL. */
  leadImageCid?: string | null;
  /** Address in the footer; without one the footer says to reply to the email. */
  contact?: string | null;
};

export type RenderOutput = { subject: string; html: string; text: string };

// Palette (see globals.css).
const IVORY = "#FAF7F0";
const INK = "#2C352F";
const BODY = "#3B463E";
const SAGE = "#657166";
const LINE = "#E1E6DA";
const WHITE = "#FFFFFF";
const PEACH = "#FDE8D3";
const HEAD = "Georgia, 'Times New Roman', Times, serif";
const SANS = "Arial, Helvetica, sans-serif";

export const LEAD_IMAGE = { width: 600, height: 338 } as const;
export const THUMB_IMAGE = { width: 96, height: 64 } as const;

/** Escapes text for HTML content and attribute values. */
export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Only web links go into the email. Returns the normalised URL or null. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** One line, so a headline can never inject a header or break the subject. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim(); // \s also covers CR, LF and the Unicode line separators

/**
 * Unsplash serves resized crops through its image URL parameters, so the picture arrives at the size the
 * email asks for (2x for sharp screens) instead of a 1080px original squeezed into 600px. Other hosts are untouched.
 */
export function sizedImageUrl(url: string, width: number, height: number): string {
  try {
    const u = new URL(url);
    if (u.hostname !== "images.unsplash.com") return url;
    u.searchParams.set("w", String(width * 2));
    u.searchParams.set("h", String(height * 2));
    u.searchParams.set("fit", "crop");
    return u.toString();
  } catch {
    return url;
  }
}

export function storyUrl(siteUrl: string, slug: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/?story=${encodeURIComponent(slug)}`;
}

const tint = (a: DigestArticle) => departmentStyle(a.department?.slug).chip;

function tag(a: DigestArticle): string {
  const name = a.department?.name ?? "General";
  const cell = (bg: string, label: string) =>
    `<td bgcolor="${bg}" style="background-color:${bg};padding:3px 10px;font-family:${SANS};font-size:11px;line-height:14px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${INK};">${esc(label)}</td>`;
  // An employee story carries a second tag in place of the AI wording the other stories have in the footer.
  const employee = isEmployeeStory(a) ? `<td width="6" style="width:6px;font-size:0;line-height:0;">&nbsp;</td>${cell(PEACH, EMPLOYEE_TAG)}` : "";
  return `<table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr>${cell(tint(a), name)}${employee}</tr></table>`;
}

/** "By Ada Lovelace &middot; Software Development" for an employee story, as an HTML row cell body; empty otherwise. */
function bylineHtml(a: DigestArticle, padding: string, size = 14): string {
  const by = byline(a);
  return by ? `<div style="font-family:${SANS};font-size:${size}px;line-height:${size + 6}px;font-weight:bold;color:${SAGE};padding:${padding};">${esc(by)}</div>` : "";
}

/** The footer sentence: AI wording only for AI stories. */
export function footerNote(articles: DigestArticle[]): string {
  const employee = articles.filter(isEmployeeStory).length;
  if (employee === 0) return "AI-generated summaries, reviewed by an editor before circulation.";
  if (employee === articles.length) return "Employee contributions, reviewed by an editor before circulation.";
  return "AI-generated summaries and employee contributions, reviewed by an editor before circulation.";
}

/** A button that survives Outlook: the colour and padding sit on the table cell, not on the link. */
function button(href: string, label: string): string {
  return `<table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr><td align="center" bgcolor="${SAGE}" style="background-color:${SAGE};padding:12px 26px;border-radius:6px;"><a href="${esc(href)}" target="_blank" style="font-family:${SANS};font-size:15px;line-height:20px;font-weight:bold;color:#FFFFFF;text-decoration:none;display:inline-block;"><span style="color:#FFFFFF;">${esc(label)}</span></a></td></tr></table>`;
}

function sourceLine(a: DigestArticle): string {
  const url = safeUrl(a.source_urls[0]);
  const name = url ? sourceName(url) : "";
  const date = formatLongDate(a.source_published_at);
  const parts: string[] = [];
  if (name && url) parts.push(`Source: <a href="${esc(url)}" target="_blank" style="color:${SAGE};text-decoration:underline;">${esc(name)}</a>`);
  parts.push(date ? `Source published ${esc(date)}` : "Source date unknown");
  return parts.join(" &middot; ");
}

function creditLine(a: DigestArticle): string {
  if (!a.image_credit) return "";
  const url = safeUrl(a.image_credit_url);
  const who = url ? `<a href="${esc(url)}" target="_blank" style="color:${SAGE};text-decoration:underline;">${esc(a.image_credit)}</a>` : esc(a.image_credit);
  return `<tr><td style="padding:6px 0 0 0;font-family:${SANS};font-size:12px;line-height:18px;color:${SAGE};">Photo: ${who}</td></tr>`;
}

function altText(a: DigestArticle): string {
  return oneLine(a.image_alt?.trim() || a.headline);
}

function imageStyle(width: number): string {
  // The alt text stays readable in Outlook, which blocks pictures until the reader allows them.
  return `display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none;font-family:${SANS};font-size:14px;line-height:20px;color:${INK};background-color:#DAEBE3;`;
}

function leadBlock(a: DigestArticle, siteUrl: string, cid: string | null): string {
  const link = storyUrl(siteUrl, a.slug);
  const photo = hasPhoto(a) && safeUrl(a.image_url);
  const src = cid ? `cid:${cid}` : photo ? sizedImageUrl(photo, LEAD_IMAGE.width, LEAD_IMAGE.height) : null;
  const image = src
    ? `<tr><td bgcolor="#DAEBE3" style="background-color:#DAEBE3;font-size:0;line-height:0;"><a href="${esc(link)}" target="_blank" style="text-decoration:none;"><img src="${esc(src)}" alt="${esc(altText(a))}" width="${LEAD_IMAGE.width}" height="${LEAD_IMAGE.height}" border="0" style="${imageStyle(LEAD_IMAGE.width)}"></a></td></tr>`
    : "";
  return `${image}
<tr><td bgcolor="${WHITE}" style="background-color:${WHITE};padding:24px 28px 28px 28px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
<tr><td style="padding:0 0 12px 0;">${tag(a)}</td></tr>
<tr><td style="padding:0 0 ${isEmployeeStory(a) ? "6px" : "12px"} 0;font-family:${HEAD};font-size:28px;line-height:34px;font-weight:bold;color:${INK};"><a href="${esc(link)}" target="_blank" style="color:${INK};text-decoration:none;">${esc(oneLine(a.headline))}</a></td></tr>${isEmployeeStory(a) ? `\n<tr><td style="padding:0 0 12px 0;">${bylineHtml(a, "0", 15)}</td></tr>` : ""}
<tr><td style="padding:0 0 20px 0;font-family:${SANS};font-size:16px;line-height:24px;color:${BODY};">${esc(summarySentences(a.body))}</td></tr>
<tr><td style="padding:0 0 18px 0;">${button(link, "Read more")}</td></tr>
${isEmployeeStory(a) ? "" : `<tr><td style="font-family:${SANS};font-size:13px;line-height:19px;color:${SAGE};">${sourceLine(a)}</td></tr>`}
${creditLine(a)}
</table>
</td></tr>`;
}

function listItem(a: DigestArticle, siteUrl: string, last: boolean): string {
  const link = storyUrl(siteUrl, a.slug);
  const photo = hasPhoto(a) && safeUrl(a.image_url);
  const thumb = photo
    ? `<a href="${esc(link)}" target="_blank" style="text-decoration:none;"><img src="${esc(sizedImageUrl(photo, THUMB_IMAGE.width, THUMB_IMAGE.height))}" alt="${esc(altText(a))}" width="${THUMB_IMAGE.width}" height="${THUMB_IMAGE.height}" border="0" style="display:block;width:${THUMB_IMAGE.width}px;height:${THUMB_IMAGE.height}px;border:0;outline:none;text-decoration:none;font-family:${SANS};font-size:11px;line-height:14px;color:${INK};background-color:${tint(a)};"></a>`
    : `&nbsp;`;
  const border = last ? "" : `border-bottom:1px solid ${LINE};`;
  return `<tr><td style="padding:14px 0;${border}">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr>
<td width="${THUMB_IMAGE.width}" valign="top" style="width:${THUMB_IMAGE.width}px;font-size:0;line-height:0;">${thumb}</td>
<td width="14" style="width:14px;font-size:0;line-height:0;">&nbsp;</td>
<td valign="top" style="font-family:${SANS};">
<div style="font-family:${SANS};font-size:11px;line-height:14px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${SAGE};padding:0 0 4px 0;">${esc(a.department?.name ?? "General")}${isEmployeeStory(a) ? ` &middot; ${esc(EMPLOYEE_TAG)}` : ""}</div>
<div style="font-family:${HEAD};font-size:18px;line-height:23px;font-weight:bold;padding:0 0 4px 0;"><a href="${esc(link)}" target="_blank" style="color:${INK};text-decoration:none;">${esc(oneLine(a.headline))}</a></div>${bylineHtml(a, "0 0 4px 0", 13)}
<div style="font-family:${SANS};font-size:14px;line-height:20px;color:${BODY};padding:0 0 4px 0;">${esc(oneLiner(a.body))}</div>
<div style="font-family:${SANS};font-size:13px;line-height:18px;"><a href="${esc(link)}" target="_blank" style="color:${SAGE};font-weight:bold;text-decoration:underline;">Read more</a></div>
</td></tr></table>
</td></tr>`;
}

export function renderDigest(input: RenderInput): RenderOutput {
  const subject = oneLine(input.subject);
  const siteUrl = input.siteUrl.replace(/\/+$/, "");
  const [lead, ...others] = input.articles;
  const week = formatLongDate(input.weekStart) ?? input.weekStart;
  const intro = input.intro.trim();
  const contact = input.contact ? oneLine(input.contact) : null;
  const dashboard = safeUrl(siteUrl) ?? siteUrl;

  const introRow = intro
    ? `<tr><td bgcolor="${WHITE}" style="background-color:${WHITE};padding:20px 28px 22px 28px;font-family:${SANS};font-size:16px;line-height:24px;color:${BODY};">${esc(intro)}</td></tr>`
    : "";

  const alsoRow =
    others.length > 0
      ? `<tr><td bgcolor="${WHITE}" style="background-color:${WHITE};padding:0 28px 12px 28px;border-top:1px solid ${LINE};">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
<tr><td style="padding:20px 0 4px 0;font-family:${HEAD};font-size:22px;line-height:28px;font-weight:bold;color:${INK};">Also this week</td></tr>
${others.map((a, i) => listItem(a, siteUrl, i === others.length - 1)).join("\n")}
</table></td></tr>`
      : "";

  const footerContact = contact
    ? `Questions or corrections? Contact <a href="mailto:${esc(contact)}" style="color:${SAGE};text-decoration:underline;">${esc(contact)}</a>.`
    : "Questions or corrections? Reply to this email to reach the editors.";

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${IVORY};" bgcolor="${IVORY}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${IVORY};">${esc(intro.slice(0, 110))}</div>
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${IVORY}" style="background-color:${IVORY};"><tr><td align="center" style="padding:24px 8px;">
<!--[if mso]><table role="presentation" width="600" align="center" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;">
<tr><td bgcolor="${WHITE}" style="background-color:${WHITE};padding:24px 28px 18px 28px;border-bottom:3px solid ${SAGE};">
<div style="font-family:${HEAD};font-size:26px;line-height:32px;font-weight:bold;color:${INK};">Company Newsroom</div>
<div style="font-family:${SANS};font-size:13px;line-height:19px;color:${SAGE};padding:4px 0 0 0;">Weekly digest &middot; Week of ${esc(week)}</div>
</td></tr>
${introRow}
${lead ? leadBlock(lead, siteUrl, input.leadImageCid ?? null) : ""}
${alsoRow}
<tr><td style="padding:20px 28px 8px 28px;font-family:${SANS};font-size:12px;line-height:18px;color:${SAGE};" align="left">
${esc(footerNote(input.articles))}<br>
<a href="${esc(dashboard)}" target="_blank" style="color:${SAGE};text-decoration:underline;">Open the Company Newsroom dashboard</a><br>
${footerContact}
</td></tr>
</table>
</td></tr></table>
</body>
</html>
`;

  const lines: string[] = [`COMPANY NEWSROOM - Weekly digest`, `Week of ${week}`, ""];
  if (intro) lines.push(intro, "");
  const sourceText = (a: DigestArticle) => {
    const url = safeUrl(a.source_urls[0]);
    const date = formatLongDate(a.source_published_at);
    return `Source: ${url ? `${sourceName(url)} (${url})` : "unknown"} - ${date ? `published ${date}` : "date unknown"}`;
  };
  if (lead) {
    lines.push(
      oneLine(lead.headline).toUpperCase(),
      `[${lead.department?.name ?? "General"}${isEmployeeStory(lead) ? ` | ${EMPLOYEE_TAG}` : ""}]`,
      ...(byline(lead) ? [byline(lead)!] : []),
      "",
      summarySentences(lead.body),
      "",
      `Read more: ${storyUrl(siteUrl, lead.slug)}`,
      ...(isEmployeeStory(lead) ? [] : [sourceText(lead)]),
    );
    if (lead.image_credit) lines.push(`Photo: ${oneLine(lead.image_credit)}`);
    lines.push("");
  }
  if (others.length > 0) {
    lines.push("ALSO THIS WEEK", "");
    others.forEach((a, i) => {
      lines.push(
        `${i + 1}. ${oneLine(a.headline)} [${a.department?.name ?? "General"}${isEmployeeStory(a) ? ` | ${EMPLOYEE_TAG}` : ""}]`,
        ...(byline(a) ? [`   ${byline(a)}`] : []),
        `   ${oneLiner(a.body)}`,
        `   ${storyUrl(siteUrl, a.slug)}`,
        "",
      );
    });
  }
  lines.push("--", footerNote(input.articles), `Dashboard: ${dashboard}`, contact ? `Contact: ${contact}` : "Questions or corrections? Reply to this email.");

  return { subject, html, text: `${lines.join("\n")}\n` };
}
