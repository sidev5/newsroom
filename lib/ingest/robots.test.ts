import { describe, expect, it } from "vitest";
import { isAllowedByRobots, robotsToken } from "./robots";

const UA = "AINewsroomBot/1.0 (+mailto:newsroom@example.com)";

describe("robotsToken", () => {
  it("uses the product token", () => {
    expect(robotsToken(UA)).toBe("ainewsroombot");
  });
});

describe("isAllowedByRobots", () => {
  it("allows everything for an empty robots.txt", () => {
    expect(isAllowedByRobots("", UA, "/news/1")).toBe(true);
  });

  it("applies the * group", () => {
    const txt = "User-agent: *\nDisallow: /private/";
    expect(isAllowedByRobots(txt, UA, "/private/x")).toBe(false);
    expect(isAllowedByRobots(txt, UA, "/news/x")).toBe(true);
  });

  it("prefers a group naming our bot over *", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: AINewsroomBot\nAllow: /";
    expect(isAllowedByRobots(txt, UA, "/news/1")).toBe(true);
  });

  it("blocks our bot when its own group disallows", () => {
    const txt = "User-agent: *\nAllow: /\n\nUser-agent: ainewsroombot\nDisallow: /";
    expect(isAllowedByRobots(txt, UA, "/anything")).toBe(false);
  });

  it("uses the longest match, with Allow winning ties", () => {
    const txt = "User-agent: *\nDisallow: /news/\nAllow: /news/public/";
    expect(isAllowedByRobots(txt, UA, "/news/public/1")).toBe(true);
    expect(isAllowedByRobots(txt, UA, "/news/other")).toBe(false);
    expect(isAllowedByRobots("User-agent: *\nDisallow: /a\nAllow: /a", UA, "/a")).toBe(true);
  });

  it("supports * and $ wildcards", () => {
    const txt = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?print=";
    expect(isAllowedByRobots(txt, UA, "/docs/file.pdf")).toBe(false);
    expect(isAllowedByRobots(txt, UA, "/docs/file.pdf.html")).toBe(true);
    expect(isAllowedByRobots(txt, UA, "/story?print=1")).toBe(false);
  });

  it("treats an empty Disallow as allow-all and ignores comments", () => {
    expect(isAllowedByRobots("User-agent: * # all\nDisallow:", UA, "/x")).toBe(true);
  });

  it("groups consecutive user-agent lines", () => {
    const txt = "User-agent: otherbot\nUser-agent: AINewsroomBot\nDisallow: /blocked";
    expect(isAllowedByRobots(txt, UA, "/blocked/1")).toBe(false);
  });
});
