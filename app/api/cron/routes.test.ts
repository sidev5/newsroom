import { readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every cron route is protected by CRON_SECRET: without the bearer token it answers 401 and does nothing; with it, it works.
// The routes' own work is replaced by stubs, so what is tested is the gate. The list is checked for completeness: a new route
// that is not in the table below fails the last test.

const stub = vi.hoisted(() => ({
  runStage: vi.fn(async (stage: string) => ({ stage, processed: 1, remaining: 0 })),
  createDraft: vi.fn(async () => ({ kind: "created", digest: { id: "d1", week_start: "2026-10-19", status: "draft", article_ids: ["a1"] } })),
  runScheduledSend: vi.fn(async () => ({ action: "none" })),
  runCleanup: vi.fn(async (o: { apply?: boolean }) => ({ apply: o.apply === true, full_text_cleared: 0 })),
  runPurgeSample: vi.fn(async (o: { apply?: boolean }) => ({ apply: o.apply === true, articles: [], sources: [], raw_items: 0 })),
  checkSchema: vi.fn(async () => ({ ok: true, failed: false, counts: {}, missingTables: [], missingColumns: [], bucketProblems: [], missingRows: [], grantProblems: [] })),
  serviceRole: vi.fn(),
}));

vi.mock("@/lib/pipeline/stages", () => ({ runStage: stub.runStage }));
vi.mock("@/lib/digest/runtime", () => ({ digestDeps: () => ({}), reminderDeps: () => ({}) }));
vi.mock("@/lib/digest/service", () => ({ createDraft: stub.createDraft, runScheduledSend: stub.runScheduledSend }));
vi.mock("@/lib/digest/store", () => ({ DigestSchemaError: class DigestSchemaError extends Error {} }));
vi.mock("@/lib/maintenance/cleanup", () => ({ runCleanup: stub.runCleanup }));
vi.mock("@/lib/maintenance/purge-sample", () => ({ runPurgeSample: stub.runPurgeSample }));
vi.mock("@/lib/maintenance/purge-store", () => ({ supabasePurgeStore: () => ({}) }));
vi.mock("@/lib/admin/schema-check", () => ({ checkSchema: stub.checkSchema }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => (stub.serviceRole(), {}) }));

const SECRET = "test-secret-0123456789abcdefghij";

type Route = { name: string; load: () => Promise<{ GET: (request: Request) => Promise<Response> }>; worked: () => unknown; expectBody?: (body: Record<string, unknown>) => void };

const ROUTES: Route[] = [
  { name: "ingest", load: () => import("./ingest/route"), worked: () => stub.runStage },
  { name: "classify", load: () => import("./classify/route"), worked: () => stub.runStage },
  { name: "write", load: () => import("./write/route"), worked: () => stub.runStage },
  { name: "image", load: () => import("./image/route"), worked: () => stub.runStage },
  { name: "factcheck", load: () => import("./factcheck/route"), worked: () => stub.runStage },
  { name: "digest-draft", load: () => import("./digest-draft/route"), worked: () => stub.createDraft, expectBody: (b) => expect(b).toMatchObject({ result: "created", id: "d1" }) },
  { name: "digest-send", load: () => import("./digest-send/route"), worked: () => stub.runScheduledSend, expectBody: (b) => expect(b).toEqual({ action: "none" }) },
  { name: "cleanup", load: () => import("./cleanup/route"), worked: () => stub.runCleanup },
  { name: "purge-sample", load: () => import("./purge-sample/route"), worked: () => stub.runPurgeSample },
  { name: "health", load: () => import("./health/route"), worked: () => stub.checkSchema, expectBody: (b) => expect(b.ok).toBe(true) },
];

const call = async (route: Route, headers: Record<string, string> = {}) =>
  (await route.load()).GET(new Request(`https://news.example.com/api/cron/${route.name}`, { headers }));

beforeEach(() => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    CRON_SECRET: SECRET,
  });
  for (const fn of Object.values(stub)) fn.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe.each(ROUTES)("/api/cron/$name", (route) => {
  it("answers 401 without an Authorization header, and does nothing", async () => {
    const res = await call(route);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(route.worked()).not.toHaveBeenCalled();
    expect(stub.serviceRole).not.toHaveBeenCalled();
  });

  it.each([
    ["the wrong secret", { authorization: "Bearer not-the-secret-0123456789abcdefgh" }],
    ["the secret without 'Bearer'", { authorization: SECRET }],
    ["another scheme", { authorization: `Basic ${SECRET}` }],
    ["'Bearer undefined'", { authorization: "Bearer undefined" }],
    ["an empty bearer", { authorization: "Bearer " }],
    ["the secret plus a character", { authorization: `Bearer ${SECRET}x` }],
    ["the secret in the query string", {}],
  ])("answers 401 with %s", async (_name, headers) => {
    const res = await (await route.load()).GET(new Request(`https://news.example.com/api/cron/${route.name}?secret=${SECRET}&token=${SECRET}`, { headers }));
    expect(res.status).toBe(401);
    expect(route.worked()).not.toHaveBeenCalled();
  });

  it("answers 401 for everybody when CRON_SECRET is missing or too short, even with a matching header", async () => {
    for (const weak of ["", "short", "a".repeat(15)]) {
      process.env.CRON_SECRET = weak;
      const res = await call(route, { authorization: `Bearer ${weak}` });
      expect(res.status, `secret ${JSON.stringify(weak)}`).toBe(401);
    }
    expect(route.worked()).not.toHaveBeenCalled();
  });

  it("works with the right bearer secret", async () => {
    const res = await call(route, { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(route.worked()).toHaveBeenCalledTimes(1);
    route.expectBody?.((await res.json()) as Record<string, unknown>);
  });
});

describe("the stage routes run their own stage, as the cron user", () => {
  it.each(["ingest", "classify", "write", "image", "factcheck"])("%s", async (stage) => {
    const route = ROUTES.find((r) => r.name === stage)!;
    await call(route, { authorization: `Bearer ${SECRET}` });
    expect(stub.runStage).toHaveBeenCalledWith(stage, "cron");
  });

  it("a busy stage is a 409, not a 500", async () => {
    const { StageBusyError } = await import("@/lib/pipeline/run-log");
    stub.runStage.mockRejectedValueOnce(new StageBusyError("write", "2026-10-16T05:00:00Z", "cron"));
    const res = await call(ROUTES.find((r) => r.name === "write")!, { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ busy: true });
  });
});

describe("the destructive routes are a dry run unless asked", () => {
  it("cleanup and purge-sample apply only with ?apply=true (or 1)", async () => {
    for (const [name, fn] of [["cleanup", stub.runCleanup], ["purge-sample", stub.runPurgeSample]] as const) {
      const route = ROUTES.find((r) => r.name === name)!;
      const headers = { authorization: `Bearer ${SECRET}` };
      await (await route.load()).GET(new Request(`https://news.example.com/api/cron/${name}`, { headers }));
      expect(fn.mock.calls.at(-1)?.[0], name).toMatchObject({ apply: false });
      await (await route.load()).GET(new Request(`https://news.example.com/api/cron/${name}?apply=true`, { headers }));
      expect(fn.mock.calls.at(-1)?.[0], name).toMatchObject({ apply: true });
      await (await route.load()).GET(new Request(`https://news.example.com/api/cron/${name}?apply=maybe`, { headers }));
      expect(fn.mock.calls.at(-1)?.[0], name).toMatchObject({ apply: false });
    }
  });
});

describe("completeness", () => {
  it("every route folder under app/api/cron is in the table above", () => {
    const folders = readdirSync(new URL(".", import.meta.url), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(folders, "a cron route was added or removed: add it to ROUTES").toEqual(ROUTES.map((r) => r.name).sort());
  });

  it("every route file calls rejectUnlessCron or the shared handler that does", async () => {
    const { readFileSync } = await import("node:fs");
    for (const route of ROUTES) {
      const source = readFileSync(new URL(`./${route.name}/route.ts`, import.meta.url), "utf8");
      expect(source, route.name).toMatch(/rejectUnlessCron\(request\)|handleStageRequest\(/);
    }
  });
});
