import { describe, expect, it, vi } from "vitest";
import { MAX_FETCH_REDIRECTS } from "@/lib/config";
import { createRobotsChecker, fetchText, HttpError, type FetchOptions } from "./fetch";
import { assertSafeUrl, BlockedUrlError, isBlockedAddress, type Resolver } from "./ssrf";

// SEC-07: nothing from an RSS item may make the server connect to an internal address.

const OPTS: FetchOptions = { userAgent: "TestBot/1.0", timeoutMs: 5000 };

/** A resolver with a fixed table; a name that is not in it does not resolve. */
const dns = (table: Record<string, string[]>): Resolver => async (host) => {
  if (!(host in table)) throw new Error("ENOTFOUND");
  return table[host];
};
const PUBLIC_DNS = dns({ "news.example.com": ["93.184.216.34"], "cdn.example.org": ["2606:2800:220:1:248:1893:25c8:1946"] });

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "192.0.0.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:169.254.169.254",
    "::ffff:7f00:1", "64:ff9b::a00:1", "2001:db8::1", "2002:7f00:1::", "::127.0.0.1", "not-an-ip", "",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "11.0.0.1", "169.253.1.1", "2606:2800:220:1:248:1893:25c8:1946", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8"])(
    "allows the public address %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

describe("assertSafeUrl", () => {
  const blocked = async (url: string, resolve: Resolver = PUBLIC_DNS) => {
    await expect(assertSafeUrl(url, resolve), url).rejects.toBeInstanceOf(BlockedUrlError);
  };

  it("accepts an ordinary https and http URL on a public host", async () => {
    await expect(assertSafeUrl("https://news.example.com/feed.xml", PUBLIC_DNS)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl("http://news.example.com/a?b=1", PUBLIC_DNS)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl("https://news.example.com:443/", PUBLIC_DNS)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl("http://news.example.com:80/", PUBLIC_DNS)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl("https://cdn.example.org/", PUBLIC_DNS)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl("http://93.184.216.34/", PUBLIC_DNS)).resolves.toBeInstanceOf(URL);
  });

  it("refuses loopback, private, link-local and metadata addresses written as IPs", async () => {
    for (const url of [
      "http://127.0.0.1/", "http://127.0.0.1:80/admin", "https://10.0.0.5/feed", "http://10.1.2.3/", "http://172.16.0.9/", "http://192.168.0.1/",
      "http://169.254.169.254/latest/meta-data/", "http://169.254.169.254/computeMetadata/v1/", "http://0.0.0.0/", "http://100.64.0.1/",
      "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fe80::1]/", "http://[fd00:ec2::254]/latest/meta-data/",
    ]) await blocked(url);
  });

  it("refuses the tricks that write 127.0.0.1 differently", async () => {
    for (const url of ["http://2130706433/", "http://0x7f.0.0.1/", "http://0177.0.0.1/", "http://127.1/", "http://017700000001/", "http://0x7f000001/"]) await blocked(url);
  });

  it("refuses internal host names without asking DNS", async () => {
    const resolve = vi.fn<Resolver>(async () => ["93.184.216.34"]);
    for (const url of ["http://localhost/", "http://LOCALHOST./", "http://foo.localhost/", "http://intranet/", "http://printer.local/", "http://db.internal/", "http://nas.lan/"]) {
      await blocked(url, resolve);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a public-looking name that resolves to a private address", async () => {
    await blocked("https://evil.example.net/feed", dns({ "evil.example.net": ["10.0.0.7"] }));
    await blocked("https://evil.example.net/feed", dns({ "evil.example.net": ["127.0.0.1"] }));
    await blocked("https://evil.example.net/feed", dns({ "evil.example.net": ["169.254.169.254"] }));
    await blocked("https://evil.example.net/feed", dns({ "evil.example.net": ["::1"] }));
  });

  it("refuses a name when ANY of its addresses is private (one public answer is not enough)", async () => {
    await blocked("https://mixed.example.net/", dns({ "mixed.example.net": ["93.184.216.34", "192.168.1.10"] }));
  });

  it("refuses a name that does not resolve", async () => {
    await blocked("https://nope.example.net/", dns({}));
    await blocked("https://empty.example.net/", dns({ "empty.example.net": [] }));
  });

  it("allows only http and https", async () => {
    for (const url of ["file:///etc/passwd", "ftp://news.example.com/", "gopher://news.example.com/", "javascript:alert(1)", "data:text/plain,hi", "ws://news.example.com/"]) await blocked(url);
  });

  it("allows only ports 80 and 443", async () => {
    for (const url of ["http://news.example.com:8080/", "https://news.example.com:8443/", "http://news.example.com:22/", "http://news.example.com:6379/", "https://news.example.com:9200/"]) await blocked(url);
  });

  it("refuses credentials in the URL and malformed input", async () => {
    await blocked("https://user:pass@news.example.com/");
    await blocked("https://user@news.example.com/");
    await blocked("not a url");
    await blocked("");
    await blocked("//news.example.com/");
  });
});

// ---------------------------------------------------------------------------
// fetchText: the check runs before every request and after every redirect
// ---------------------------------------------------------------------------

const ok = (body = "<rss/>") => new Response(body, { status: 200 });
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

function scripted(...responses: Response[]) {
  const queue = [...responses];
  return vi.fn(async (...args: [string | URL | Request, RequestInit?]) => {
    void args; // recorded in mock.calls
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  });
}

describe("fetchText and SSRF", () => {
  it("fetches a public URL once, without letting fetch follow redirects by itself", async () => {
    const fetchImpl = scripted(ok("hello"));
    expect(await fetchText("https://news.example.com/feed", OPTS, { fetch: fetchImpl as never, resolve: PUBLIC_DNS })).toBe("hello");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("manual");
  });

  it.each([
    "http://127.0.0.1/feed", "http://10.0.0.5/feed", "http://169.254.169.254/latest/meta-data/", "http://localhost/", "http://[::1]/", "http://2130706433/",
    "http://news.example.com:8080/feed", "file:///etc/passwd",
  ])("never sends a request for %s", async (url) => {
    const fetchImpl = scripted(ok());
    await expect(fetchText(url, OPTS, { fetch: fetchImpl as never, resolve: PUBLIC_DNS })).rejects.toBeInstanceOf(BlockedUrlError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never sends a request for a hostname that resolves to a private address", async () => {
    const fetchImpl = scripted(ok());
    await expect(
      fetchText("https://feeds.attacker.example/rss", OPTS, { fetch: fetchImpl as never, resolve: dns({ "feeds.attacker.example": ["192.168.0.20"] }) }),
    ).rejects.toThrow(/resolves to a private or reserved address/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follows a redirect to another public URL", async () => {
    const fetchImpl = scripted(redirect("https://cdn.example.org/feed.xml", 301), ok("moved"));
    expect(await fetchText("https://news.example.com/feed", OPTS, { fetch: fetchImpl as never, resolve: PUBLIC_DNS })).toBe("moved");
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual(["https://news.example.com/feed", "https://cdn.example.org/feed.xml"]);
  });

  it("resolves a relative redirect against the page that sent it", async () => {
    const fetchImpl = scripted(redirect("/elsewhere/feed.xml", 308), ok("rel"));
    await fetchText("https://news.example.com/a/b", OPTS, { fetch: fetchImpl as never, resolve: PUBLIC_DNS });
    expect(String(fetchImpl.mock.calls[1][0])).toBe("https://news.example.com/elsewhere/feed.xml");
  });

  it.each(["http://localhost/admin", "http://127.0.0.1:80/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://[::1]/", "ftp://news.example.com/x", "http://news.example.com:8080/"])(
    "refuses a redirect to %s after one request",
    async (target) => {
      const fetchImpl = scripted(redirect(target), ok("secret internal data"));
      await expect(fetchText("https://news.example.com/feed", OPTS, { fetch: fetchImpl as never, resolve: PUBLIC_DNS })).rejects.toBeInstanceOf(BlockedUrlError);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // the internal URL was never requested
    },
  );

  it("refuses a redirect to a name that resolves to a private address", async () => {
    const fetchImpl = scripted(redirect("https://sneaky.example.net/x"), ok("secret"));
    const resolve = dns({ "news.example.com": ["93.184.216.34"], "sneaky.example.net": ["10.9.9.9"] });
    await expect(fetchText("https://news.example.com/feed", OPTS, { fetch: fetchImpl as never, resolve })).rejects.toBeInstanceOf(BlockedUrlError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it(`follows at most ${MAX_FETCH_REDIRECTS} redirects`, async () => {
    const hops = Array.from({ length: MAX_FETCH_REDIRECTS }, (_, i) => redirect(`https://news.example.com/hop${i + 1}`));
    const allowed = scripted(...hops, ok("finally"));
    expect(await fetchText("https://news.example.com/start", OPTS, { fetch: allowed as never, resolve: PUBLIC_DNS })).toBe("finally");
    expect(allowed).toHaveBeenCalledTimes(MAX_FETCH_REDIRECTS + 1);

    const tooMany = scripted(...hops, redirect("https://news.example.com/one-too-many"), ok("never"));
    await expect(fetchText("https://news.example.com/start", OPTS, { fetch: tooMany as never, resolve: PUBLIC_DNS })).rejects.toThrow(/More than 3 redirects/);
    expect(tooMany).toHaveBeenCalledTimes(MAX_FETCH_REDIRECTS + 1);
  });

  it("a redirect loop ends at the hop limit", async () => {
    const fetchImpl = vi.fn(async () => redirect("https://news.example.com/loop"));
    await expect(fetchText("https://news.example.com/loop", OPTS, { fetch: fetchImpl as never, resolve: PUBLIC_DNS })).rejects.toThrow(/redirects/);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_FETCH_REDIRECTS + 1);
  });

  it("a redirect without a Location is an error", async () => {
    const fetchImpl = scripted(new Response(null, { status: 302 }));
    await expect(fetchText("https://news.example.com/x", OPTS, { fetch: fetchImpl as never, resolve: PUBLIC_DNS })).rejects.toThrow(/Location/);
  });

  it("still reports HTTP errors with their status", async () => {
    const fetchImpl = scripted(new Response("no", { status: 404 }));
    const err = await fetchText("https://news.example.com/x", OPTS, { fetch: fetchImpl as never, resolve: PUBLIC_DNS }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
  });

  it("still enforces the size cap", async () => {
    const big = "x".repeat(3 * 1024 * 1024 + 10);
    const fetchImpl = scripted(ok(big));
    await expect(fetchText("https://news.example.com/big", OPTS, { fetch: fetchImpl as never, resolve: PUBLIC_DNS })).rejects.toThrow(/over/);
  });
});

describe("the robots.txt check goes through the same guard", () => {
  it("treats a robots.txt that redirects to an internal host as 'not allowed' and never requests that host", async () => {
    const fetchImpl = scripted(redirect("http://169.254.169.254/latest/meta-data/"));
    const allowed = createRobotsChecker(OPTS, { fetch: fetchImpl as never, resolve: PUBLIC_DNS });
    expect(await allowed("https://news.example.com/story")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an item URL on an internal address is not even asked about robots.txt", async () => {
    const fetchImpl = scripted(ok("User-agent: *\nAllow: /"));
    const allowed = createRobotsChecker(OPTS, { fetch: fetchImpl as never, resolve: PUBLIC_DNS });
    expect(await allowed("http://127.0.0.1/story")).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
