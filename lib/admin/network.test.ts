import { describe, expect, it } from "vitest";
import { adminPolicy, trustedHeaders } from "../../scripts/self-host-server.mjs";
import { adminAllowed, adminNetwork, CLIENT_HEADER, insecureLanRequest, isLoopback, socketAddress } from "./network";

const TOKEN = "a".repeat(64);
const selfHost = (admin?: string) => ({ NEWSROOM_SELF_HOST_TOKEN: TOKEN, ...(admin ? { NEWSROOM_SELF_HOST_ADMIN: admin } : {}) });
const from = (address: string, token = TOKEN) => new Headers({ [CLIENT_HEADER]: `${token} ${address}` });

describe("adminNetwork", () => {
  it("is 'any' without the self-host server, whatever else is set (Vercel and next start are unchanged)", () => {
    expect(adminNetwork({})).toBe("any");
    expect(adminNetwork({ NEWSROOM_SELF_HOST_ADMIN: "localhost" })).toBe("any");
  });

  it("defaults to localhost under the server and opens the LAN only for the exact opt-in value", () => {
    expect(adminNetwork(selfHost())).toBe("localhost");
    expect(adminNetwork(selfHost("lan"))).toBe("localhost");
    expect(adminNetwork(selfHost("lan-insecure-http"))).toBe("lan-insecure-http");
  });
});

describe("socketAddress / isLoopback", () => {
  it("believes the address only with the server's token", () => {
    expect(socketAddress(from("10.0.0.5"), selfHost())).toBe("10.0.0.5");
    expect(socketAddress(from("127.0.0.1", "b".repeat(64)), selfHost())).toBeNull();
    expect(socketAddress(new Headers({ [CLIENT_HEADER]: "127.0.0.1" }), selfHost())).toBeNull();
    expect(socketAddress(from("127.0.0.1"), {})).toBeNull();
  });

  it("knows the loopback addresses", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a)).toBe(true);
    for (const a of ["10.0.0.5", "192.168.1.20", "::ffff:10.0.0.5", "fe80::1", "", "127.0.0.1.evil"]) expect(isLoopback(a)).toBe(false);
  });
});

describe("adminAllowed", () => {
  it("lets everyone through without the self-host server", () => {
    expect(adminAllowed(new Headers({ "x-forwarded-for": "10.0.0.5" }), {})).toBe(true);
  });

  it("under localhost: this PC only, and fails closed without a vouched address", () => {
    expect(adminAllowed(from("127.0.0.1"), selfHost())).toBe(true);
    expect(adminAllowed(from("::1"), selfHost())).toBe(true);
    expect(adminAllowed(from("10.0.0.5"), selfHost())).toBe(false);
    expect(adminAllowed(new Headers({ "x-forwarded-for": "127.0.0.1" }), selfHost())).toBe(false);
    expect(adminAllowed(from("127.0.0.1", "forged"), selfHost())).toBe(false);
  });

  it("under lan-insecure-http: everyone, with the warning for other machines only", () => {
    const env = selfHost("lan-insecure-http");
    expect(adminAllowed(from("10.0.0.5"), env)).toBe(true);
    expect(insecureLanRequest(from("10.0.0.5"), env)).toBe(true);
    expect(insecureLanRequest(from("127.0.0.1"), env)).toBe(false);
    expect(insecureLanRequest(from("10.0.0.5"), selfHost())).toBe(false);
  });
});

describe("self-host server: trustedHeaders", () => {
  it("replaces forged proxy headers with what the socket says", () => {
    const h = trustedHeaders(
      { host: "newsroom-pc:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https", "x-real-ip": "1.2.3.4", forwarded: "for=127.0.0.1", [CLIENT_HEADER]: "x 127.0.0.1" },
      { remoteAddress: "10.0.0.5", port: 3000, token: TOKEN },
    );
    expect(h).toEqual({
      host: "newsroom-pc:3000",
      "x-forwarded-for": "10.0.0.5",
      "x-forwarded-proto": "http",
      "x-forwarded-port": "3000",
      "x-forwarded-host": "newsroom-pc:3000",
      [CLIENT_HEADER]: `${TOKEN} 10.0.0.5`,
    });
  });

  it("unwraps IPv4-mapped addresses so each LAN machine keeps its own rate limit", () => {
    expect(trustedHeaders({}, { remoteAddress: "::ffff:10.0.0.5", port: 3000, token: TOKEN })["x-forwarded-for"]).toBe("10.0.0.5");
    expect(trustedHeaders({}, { remoteAddress: "::1", port: 3000, token: TOKEN })["x-forwarded-for"]).toBe("::1");
  });

  it("adminPolicy: only the exact opt-in value opens the LAN", () => {
    expect(adminPolicy(undefined)).toBe("localhost");
    expect(adminPolicy(" lan-insecure-http ")).toBe("lan-insecure-http");
    expect(adminPolicy("LAN-INSECURE-HTTP")).toBe("localhost");
  });
});
