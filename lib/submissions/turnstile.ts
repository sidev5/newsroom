// Optional Cloudflare Turnstile on /submit. Off unless TURNSTILE_SITE_KEY and TURNSTILE_SECRET are both set.
// The browser widget puts a one-time token in the form (field cf-turnstile-response); the server checks it with Cloudflare.
// It fails closed: with the check on, a missing token, a refusal or an unreachable Cloudflare all mean "not verified".

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_FIELD = "cf-turnstile-response";
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";
export const CAPTCHA_ERROR = "Please complete the check that confirms you are a person, then send your story again.";

type Source = Record<string, string | undefined>;

/** Both keys set: the settings. Neither: null (off). One of the two: null too, and validateEnv reports the mistake. */
export function turnstileConfig(source: Source = process.env): { siteKey: string; secret: string } | null {
  const siteKey = source.TURNSTILE_SITE_KEY?.trim();
  const secret = source.TURNSTILE_SECRET?.trim();
  return siteKey && secret ? { siteKey, secret } : null;
}

export async function verifyTurnstile(args: {
  secret: string;
  token: string | null | undefined;
  ip: string | null;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const token = args.token?.trim();
  if (!token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: args.secret, response: token });
  if (args.ip) body.set("remoteip", args.ip);
  try {
    const res = await (args.fetchImpl ?? fetch)(TURNSTILE_VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}
