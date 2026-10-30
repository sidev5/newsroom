import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PIPELINE_DEFAULTS } from "@/lib/config";
import { schema } from "@/lib/env-schema";

// DEP-01: the two ways to run the scheduled jobs, the README's deployment guide, and the review page's maxDuration.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const vercel = JSON.parse(read("vercel.json")) as { crons?: { path: string; schedule: string }[] };
const readme = read("README.md");

const WORKFLOW_DIR = new URL("../.github/workflows/", import.meta.url);
const workflowFiles = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
const pipeline = read(".github/workflows/pipeline.yml");
const digest = read(".github/workflows/digest.yml");

/** schedule -> route, read from a workflow's `case "$SCHEDULE"` lines. */
function scheduleRoutes(workflow: string): Map<string, string> {
  const schedules = [...workflow.matchAll(/^\s*- cron: "([^"]+)"/gm)].map((m) => m[1]);
  const out = new Map<string, string>();
  for (const s of schedules) {
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const route = new RegExp(`"${escaped}"\\)\\s+ROUTE="([^"]+)" ;;`).exec(workflow)?.[1];
    out.set(s, route ?? "(none)");
  }
  return out;
}

/** How many times a day a cron line fires (minute and hour fields as lists or *; other fields ignored). */
function runsPerDay(cron: string): number {
  const [minute, hour] = cron.split(" ");
  const count = (field: string, all: number) => (field === "*" ? all : field.split(",").length);
  return count(minute, 60) * count(hour, 24);
}

describe("vercel.json on the Hobby plan", () => {
  it("has no cron that runs more than once a day (Hobby refuses those at deploy); it has none at all", () => {
    for (const c of vercel.crons ?? []) expect(runsPerDay(c.schedule), c.path).toBeLessThanOrEqual(1);
    expect(vercel.crons ?? []).toEqual([]); // the schedules live in GitHub Actions; both would run every job twice
  });
});

describe("the GitHub Actions workflows", () => {
  const pipelineRoutes = scheduleRoutes(pipeline);
  const digestRoutes = scheduleRoutes(digest);

  it("are the only workflows that call the cron routes (no older one runs the jobs a second time)", () => {
    const calling = workflowFiles.filter((f) => read(`.github/workflows/${f}`).includes("/api/cron/"));
    expect(calling.sort()).toEqual(["digest.yml", "pipeline.yml"]);
  });

  it("pipeline.yml: ingest and classify twice a day, write, image and factcheck every 4 hours, cleanup weekly (applied)", () => {
    const byRoute = Object.fromEntries([...pipelineRoutes].map(([s, r]) => [r, s]));
    expect(Object.keys(byRoute).sort()).toEqual(["classify", "cleanup?apply=true", "factcheck", "image", "ingest", "write"]);
    expect(runsPerDay(byRoute.ingest)).toBe(2);
    expect(runsPerDay(byRoute.classify)).toBe(2);
    for (const r of ["write", "image", "factcheck"]) {
      expect(runsPerDay(byRoute[r]), r).toBe(6);
      const hours = byRoute[r].split(" ")[1].split(",").map(Number);
      expect(hours.slice(1).map((h, i) => h - hours[i]), r).toEqual([4, 4, 4, 4, 4]);
    }
    const [, , dayOfMonth, month, dayOfWeek] = byRoute["cleanup?apply=true"].split(" ");
    expect([dayOfMonth, month, dayOfWeek]).toEqual(["*", "*", "0"]);
  });

  it("keeps the stages in order within each slot: ingest before classify, write before image before factcheck", () => {
    const at = (route: string) => [...pipelineRoutes].find(([, r]) => r === route)![0].split(" ");
    const [im, ih] = at("ingest");
    const [cm, ch] = at("classify");
    expect(ih).toBe(ch);
    expect(Number(cm)).toBeGreaterThan(Number(im));
    const minutes = (route: string) => at(route)[1].split(",").map((h) => Number(h) * 60 + Number(at(route)[0]));
    const [w, i, f] = [minutes("write"), minutes("image"), minutes("factcheck")];
    w.forEach((t, k) => {
      expect(i[k]).toBeGreaterThan(t);
      expect(f[k]).toBeGreaterThan(i[k]);
    });
  });

  it("digest.yml: the draft on Monday, the send on Monday later", () => {
    const byRoute = Object.fromEntries([...digestRoutes].map(([s, r]) => [r, s]));
    expect(Object.keys(byRoute).sort()).toEqual(["digest-draft", "digest-send"]);
    const [dm, dh, , , dd] = byRoute["digest-draft"].split(" ");
    const [sm, sh, , , sd] = byRoute["digest-send"].split(" ");
    expect([dd, sd]).toEqual(["1", "1"]);
    expect(Number(sh) * 60 + Number(sm)).toBeGreaterThan(Number(dh) * 60 + Number(dm));
  });

  it.each([
    ["pipeline.yml", pipeline],
    ["digest.yml", digest],
  ])("%s: every scheduled route exists", (_name, workflow) => {
    for (const route of scheduleRoutes(workflow).values()) {
      expect(() => read(`app/api/cron/${route.split("?")[0]}/route.ts`), route).not.toThrow();
    }
  });

  it("can also be started by hand, for any of the jobs", () => {
    expect(pipeline).toMatch(/workflow_dispatch:/);
    expect(digest).toMatch(/workflow_dispatch:/);
    expect(pipeline).toContain("options: [ingest, classify, write, image, factcheck, cleanup-dry-run, cleanup]");
    expect(digest).toContain("options: [digest-draft, digest-send]");
  });

  it.each([
    ["pipeline.yml", pipeline],
    ["digest.yml", digest],
  ])("%s: sends the bearer secret in a header, never in the URL, and never prints it", (_name, workflow) => {
    expect(workflow).toContain('--header "Authorization: Bearer ${CRON_SECRET}"');
    expect(workflow).not.toMatch(/\$\{\{ secrets\.[A-Z_]+ \}\}[^\n]*\/api\/cron/); // not in the address
    // the secret's value is never echoed (its name appears in the "add the secret" message, which is fine), and the shell does not trace
    expect(workflow).not.toMatch(/echo[^\n]*\$\{?CRON_SECRET/);
    expect(workflow).not.toMatch(/set -x|set -o xtrace|printenv|\benv\s*\|/);
    // secrets reach the script through env, not by being pasted into the script text
    const run = workflow.slice(workflow.indexOf("run: |"));
    expect(run).not.toContain("${{ secrets");
    expect(workflow).toMatch(/CRON_SECRET: \$\{\{ secrets\.CRON_SECRET \}\}/);
    expect(workflow).toMatch(/SITE_URL: \$\{\{ secrets\.SITE_URL \}\}/);
    expect(workflow).toContain('"${SITE_URL%/}/api/cron/${ROUTE}"');
  });

  it.each([
    ["pipeline.yml", pipeline],
    ["digest.yml", digest],
  ])("%s: refuses a SITE_URL that is not https, stops when a secret is missing, prints the status and fails on anything but 2xx", (_name, workflow) => {
    expect(workflow).toMatch(/https:\/\/\*\) ;;/);
    expect(workflow).toMatch(/SITE_URL must start with https:\/\//);
    expect(workflow).toMatch(/Add the repository secrets SITE_URL and CRON_SECRET/);
    expect(workflow).toContain('echo "HTTP status: $STATUS"');
    const outcomes = workflow.slice(workflow.indexOf('case "$STATUS" in'));
    expect(outcomes).toMatch(/^\s+2\?\?\) echo "OK" ;;\n\s+\*\) echo "Failed: HTTP \$STATUS[^"]*" >&2; exit 1 ;;\n\s+esac/m);
  });

  it.each([
    ["pipeline.yml", pipeline],
    ["digest.yml", digest],
  ])("%s: needs no access to the repository, has a timeout, and never runs two calls of one kind at once", (_name, workflow) => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toMatch(/timeout-minutes: \d+/);
    expect(workflow).toMatch(/concurrency:\n\s+group: (pipeline|digest)-/);
    expect(workflow).toMatch(/cancel-in-progress: false/);
  });

  it("says in its header that it replaces the Vercel crons, and what GitHub's limits are", () => {
    expect(pipeline).toMatch(/Never add the same jobs to vercel\.json as well/);
    expect(pipeline).toMatch(/60 days/);
    expect(pipeline).toMatch(/in UTC/);
  });

  it("does not schedule the sample-data purge: that one is run by hand", () => {
    expect(pipeline + digest).not.toContain("purge-sample");
  });
});

describe("maxDuration (DEP-01)", () => {
  const page = read("app/admin/(protected)/review/page.tsx");
  const seconds = Number(/export const maxDuration = (\d+);/.exec(page)?.[1]);

  it("the review page keeps 300 s, the most every plan allows (Hobby max 300, Pro max 800), and says why", () => {
    expect(seconds).toBe(300);
    expect(page).toMatch(/maxDuration = 300 is deliberate/);
    expect(page).toMatch(/Hobby: default\s+\/\/ 300 s, maximum 300 s|Hobby: default 300 s, maximum 300 s/);
  });

  it("is enough for one 'Run next batch' call: a chunk of items, each with an LLM call that can take the full timeout", () => {
    const worstCase = (PIPELINE_DEFAULTS.STAGE_CHUNK_SIZE * PIPELINE_DEFAULTS.LLM_TIMEOUT_MS) / 1000;
    expect(worstCase).toBe(225);
    expect(worstCase).toBeLessThanOrEqual(seconds);
    // and it really would not fit in a cron route's 60 s: that is the reason for the higher value
    expect(worstCase).toBeGreaterThan(60);
  });

  it("the cron routes stay at 60 s because the stages end themselves before that", () => {
    for (const route of [...scheduleRoutes(pipeline).values(), ...scheduleRoutes(digest).values()]) {
      const file = read(`app/api/cron/${route.split("?")[0]}/route.ts`);
      expect(Number(/export const maxDuration = (\d+);/.exec(file)?.[1]), route).toBe(60);
    }
    expect(PIPELINE_DEFAULTS.STAGE_TIME_BUDGET_MS).toBeLessThan(60_000);
  });
});

describe("the README's deployment guide", () => {
  const deploying = readme.slice(readme.indexOf("## Deploying"), readme.indexOf("## AI & Technology department"));

  it("has a Deploying section with the four parts", () => {
    expect(deploying.length).toBeGreaterThan(2000);
    for (const part of ["### 1. The database", "### 2. Running the scheduled jobs: GitHub Actions (Hobby)", "### 3. The production environment", "### 4. Launch checklist"]) {
      expect(deploying).toContain(part);
    }
  });

  it("states the Vercel and GitHub limits that were read in the documentation", () => {
    expect(deploying).toMatch(/Hobby \| 100 \| once per day \| per hour/);
    expect(deploying).toMatch(/Pro \| 100 \| once per minute \| per minute/);
    expect(deploying).toMatch(/Hobby: default 300 s, maximum 300 s\. Pro and Enterprise: default 300 s, maximum 800 s/);
    expect(deploying).toMatch(/fail during deployment/);
    expect(deploying).toMatch(/every 5 minutes/);
    expect(deploying).toMatch(/60 days/);
    expect(deploying).toMatch(/updated 2026-07-15/);
    expect(deploying).toMatch(/updated 2026-08-24/);
  });

  it("corrects the audit's outdated claim that Hobby caps functions at 60 s", () => {
    expect(deploying).toMatch(/out of date/);
  });

  it("explains the GitHub Actions setup: the two workflows, the two secrets, no crons in vercel.json, and the guide", () => {
    expect(deploying).toContain(".github/workflows/pipeline.yml");
    expect(deploying).toContain(".github/workflows/digest.yml");
    expect(deploying).toContain("docs/DEPLOY_VERCEL.md");
    expect(deploying).toMatch(/`SITE_URL`/);
    expect(deploying).toMatch(/`CRON_SECRET`/);
    expect(deploying).toMatch(/`vercel\.json` has \*\*no crons\*\*/);
    expect(deploying).toMatch(/Never schedule the same jobs in `vercel\.json` as well/);
  });

  it("lists every migration file, once, in order, and every listed file exists", () => {
    const listed = [...deploying.matchAll(/^\d+\. `(\d{4}-\d{2}-\d{2}[^`]*\.sql)`$/gm)].map((m) => m[1]);
    const onDisk = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql"));
    expect([...listed].sort()).toEqual([...onDisk].sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.at(-1)).toBe("2026-10-22_story_blocks.sql");
    expect(listed.indexOf("2026-10-19_reliability.sql")).toBeLessThan(listed.indexOf("2026-10-20_privacy_and_hardening.sql"));
    expect(listed.indexOf("2026-10-15_recover_rejected_skipped.sql")).toBeLessThan(listed.indexOf("2026-10-22_review_log_repair.sql"));
    expect(listed.indexOf("2026-10-20_privacy_and_hardening.sql")).toBeLessThan(listed.indexOf("2026-10-22_story_blocks.sql"));
    expect(listed.indexOf("2026-10-18_article_summary.sql")).toBeLessThan(listed.indexOf("2026-10-19_reliability.sql"));
  });

  it("has the production environment checklist with the new settings", () => {
    for (const name of ["PRIVACY_CONTACT", "CSP_MODE", "TURNSTILE_SITE_KEY", "DAILY_BUDGET_USD", "LLM_TIMEOUT_MS", "SUBMITTER_IP_RETENTION_DAYS", "SUBMITTER_EMAIL_RETENTION_DAYS", "CRON_SECRET", "ADMIN_EMAILS", "ALLOWED_EMAIL_DOMAINS", "SITE_URL", "SMTP_PASS", "PEXELS_API_KEY", "APP_URL"]) {
      expect(deploying, name).toContain(`\`${name}\``);
    }
    expect(deploying).toContain("npm run check-env -- --production");
    expect(deploying).toMatch(/at least \*\*32\*\* random characters/);
  });

  it("the launch checklist covers RLS, purge-sample, backups, cleanup and switching the CSP to enforce", () => {
    for (const part of ["npm run check-rls", "npm run stage -- purge-sample", "docs/BACKUP.md", "npm run backup:check", "npm run stage -- cleanup", "CSP_MODE=enforce"]) {
      expect(deploying, part).toContain(part);
    }
  });
});

describe(".gitignore", () => {
  const rules = read(".gitignore").split("\n").map((l) => l.trim());

  it("keeps secrets, build output, dependencies and local logs out of git, but not .env.example", () => {
    for (const rule of [".env*", "!.env.example", "/.next/", "/node_modules", "*.log", "/logs/", ".vercel", "/backups/"]) {
      expect(rules, rule).toContain(rule);
    }
  });
});

describe(".env.example", () => {
  const example = read(".env.example");

  it("documents the new settings", () => {
    for (const name of ["PRIVACY_CONTACT", "SUBMITTER_IP_RETENTION_DAYS", "SUBMITTER_EMAIL_RETENTION_DAYS", "CSP_MODE", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET", "DAILY_BUDGET_USD", "LLM_TIMEOUT_MS"]) {
      expect(example, name).toMatch(new RegExp(`^${name}=`, "m"));
    }
  });

  it("every variable it lists that the schema knows has a value the schema accepts", () => {
    const values = Object.fromEntries(
      example
        .split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    const base = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s", CRON_SECRET: "0123456789abcdef" };
    for (const name of ["PRIVACY_CONTACT", "SUBMITTER_IP_RETENTION_DAYS", "SUBMITTER_EMAIL_RETENTION_DAYS", "CSP_MODE", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET", "DAILY_BUDGET_USD", "LLM_TIMEOUT_MS"]) {
      expect(schema.safeParse({ ...base, [name]: values[name] }).success, name).toBe(true);
    }
  });
});
