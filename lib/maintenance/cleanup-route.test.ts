import { beforeEach, describe, expect, it, vi } from "vitest";

// DB-03: the cron route of the retention cleanup. runCleanup is replaced; the route's own rules are what is tested.
// ---------------------------------------------------------------------------
// The cron route
// ---------------------------------------------------------------------------
const route = vi.hoisted(() => ({ runCleanup: vi.fn() }));
vi.mock("@/lib/maintenance/cleanup", () => ({ runCleanup: route.runCleanup }));

describe("GET /api/cron/cleanup", () => {
  const SECRET = "test-secret-0123456789abc";
  const call = async (query = "", headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) => {
    const { GET } = await import("../../app/api/cron/cleanup/route");
    return GET(new Request(`https://news.example.com/api/cron/cleanup${query}`, { headers }));
  };

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    route.runCleanup.mockReset();
    route.runCleanup.mockImplementation(async (o: { apply?: boolean }) => ({ apply: o.apply === true, full_text_cleared: 1, raw_items_deleted: 2, agent_runs_deleted: 3, pipeline_runs_deleted: 4 }));
  });

  it("is protected by CRON_SECRET", async () => {
    expect((await call("", {})).status).toBe(401);
    expect((await call("?apply=true", { authorization: "Bearer wrong-secret-0123456789" })).status).toBe(401);
    expect(route.runCleanup).not.toHaveBeenCalled();
  });

  it("is a dry run by default", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(route.runCleanup).toHaveBeenCalledWith({ apply: false });
    expect((await res.json()).apply).toBe(false);
  });

  it.each(["?apply=true", "?apply=1"])("applies with %s", async (q) => {
    await call(q);
    expect(route.runCleanup).toHaveBeenCalledWith({ apply: true });
  });

  it.each(["?apply=false", "?apply=0", "?apply=yes", "?apply=", "?apply=TRUE", "?dry=1"])("stays a dry run for %s", async (q) => {
    await call(q);
    expect(route.runCleanup).toHaveBeenCalledWith({ apply: false });
  });

  it("answers 500 with the message when the cleanup fails", async () => {
    route.runCleanup.mockRejectedValueOnce(new Error("The retention function is missing."));
    const res = await call("?apply=true");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "The retention function is missing." });
  });
});

