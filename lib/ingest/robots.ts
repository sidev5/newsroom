type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[] };

function parseGroups(robotsTxt: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (key === "user-agent") {
      // Consecutive user-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ allow: key === "allow", pattern: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

/** The product token robots.txt matches on: "AINewsroomBot/1.0 (+mailto:...)" -> "ainewsroombot". */
export function robotsToken(userAgent: string): string {
  return userAgent.split(/[/\s]/)[0].toLowerCase();
}

/**
 * RFC 9309 matching: use the group(s) naming our token, else `*`.
 * Longest matching pattern wins; on a tie, Allow wins. No match means allowed.
 */
export function isAllowedByRobots(robotsTxt: string, userAgent: string, path: string): boolean {
  const token = robotsToken(userAgent);
  const groups = parseGroups(robotsTxt);
  let matched = groups.filter((g) => g.agents.includes(token));
  if (matched.length === 0) matched = groups.filter((g) => g.agents.includes("*"));

  let best: Rule | null = null;
  for (const rule of matched.flatMap((g) => g.rules)) {
    if (rule.pattern === "") continue; // "Disallow:" with no value allows everything
    if (!patternMatches(rule.pattern, path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}
