import { MAX_FETCH_REDIRECTS } from "@/lib/config";
import { isAllowedByRobots } from "./robots";
import { assertSafeUrl, type Resolver } from "./ssrf";

export type FetchOptions = { userAgent: string; timeoutMs: number; accept?: string };

/** Injected in tests. */
export type FetchDeps = { fetch?: typeof fetch; resolve?: Resolver };

const MAX_BYTES = 3 * 1024 * 1024;

export class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GET a URL as text with a timeout, identifiable User-Agent and a size cap.
 * SEC-07: every URL, the first and each redirect target, is checked by assertSafeUrl before it is requested.
 * Redirects are followed by hand, at most MAX_FETCH_REDIRECTS of them, inside one overall timeout.
 */
export async function fetchText(url: string, opts: FetchOptions, deps: FetchDeps = {}): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs);

  let current = url;
  for (let hop = 0; ; hop++) {
    await assertSafeUrl(current, deps.resolve);
    const res = await doFetch(current, {
      headers: { "User-Agent": opts.userAgent, Accept: opts.accept ?? "*/*" },
      signal,
      redirect: "manual",
    });

    if (REDIRECTS.has(res.status)) {
      await res.body?.cancel();
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect without a Location header for ${current}`);
      if (hop >= MAX_FETCH_REDIRECTS) throw new Error(`More than ${MAX_FETCH_REDIRECTS} redirects for ${url}`);
      current = new URL(location, current).toString(); // relative targets are resolved against the page that sent them
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpError(res.status, current);
    }
    if (!res.body) return "";

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error(`Response over ${MAX_BYTES} bytes for ${current}`);
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
}

/**
 * Per-run robots.txt checker with a per-origin cache.
 * Missing robots.txt (4xx) means allowed; a 5xx or network error means
 * disallowed, so an unreachable site is never crawled by accident.
 */
export function createRobotsChecker(opts: FetchOptions, deps: FetchDeps = {}) {
  const cache = new Map<string, Promise<string | null>>();

  function robotsFor(origin: string): Promise<string | null> {
    let entry = cache.get(origin);
    if (!entry) {
      entry = fetchText(`${origin}/robots.txt`, { ...opts, accept: "text/plain" }, deps).catch((err) => {
        if (err instanceof HttpError && err.status >= 400 && err.status < 500) return "";
        return null;
      });
      cache.set(origin, entry);
    }
    return entry;
  }

  return async function isAllowed(pageUrl: string): Promise<boolean> {
    const url = new URL(pageUrl);
    const robots = await robotsFor(url.origin);
    if (robots === null) return false;
    return isAllowedByRobots(robots, opts.userAgent, url.pathname + url.search);
  };
}
