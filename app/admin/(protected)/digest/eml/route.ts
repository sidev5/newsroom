import { currentAdminEmail } from "@/lib/admin/session";
import { digestDeps, siteUrl } from "@/lib/digest/runtime";
import { makeMailBuilder } from "@/lib/digest/prepare";
import { DigestSchemaError } from "@/lib/digest/store";
import { env } from "@/lib/env";
import { buildEml, senderAddress } from "@/lib/mail";

export const dynamic = "force-dynamic";

/** Download the digest as an .eml draft (works with EMAIL_PROVIDER=none). Admin only. */
export async function GET(request: Request) {
  // The admin check comes before anything touches the database.
  const admin = await currentAdminEmail();
  if (!admin) return new Response("Not authorised.", { status: 403 });

  const id = new URL(request.url).searchParams.get("id") ?? "";
  try {
    const deps = digestDeps();
    const digest = id ? await deps.store.getById(id) : null;
    if (!digest) return new Response("Digest not found.", { status: 404 });
    const articles = await deps.store.articles(digest.article_ids);
    if (articles.length === 0) return new Response("The digest has no published stories.", { status: 409 });

    // The .eml embeds the lead image, so it shows without "Download pictures".
    const mail = await makeMailBuilder({ siteUrl: siteUrl(), contact: env().DIGEST_CONTACT ?? null })(digest, articles, { inlineImages: true });
    const eml = await buildEml({ from: senderAddress(), to: [], ...mail });
    await deps.store.log(digest.id, "eml_downloaded", admin);

    return new Response(new Uint8Array(eml), {
      headers: {
        "Content-Type": "message/rfc822",
        "Content-Disposition": `attachment; filename="company-newsroom-weekly-${digest.week_start}.eml"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof DigestSchemaError) return new Response(err.message, { status: 503 });
    return new Response(err instanceof Error ? err.message.slice(0, 300) : "Could not build the .eml.", { status: 500 });
  }
}
