import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTERNAL_ARTICLE_COLUMNS, PUBLIC_ARTICLE_GRANTED_COLUMNS } from "@/lib/news/public-columns";
import { formatRls, PRIVATE_TABLES, runRlsCheck, type ProbeResult, type RlsProbe } from "./rls-check";

// SEC-04: `npm run check-rls`. A fake database stands behind the probe.

const denied: ProbeResult = { rows: [], error: { code: "42501", message: "permission denied for table x" } };
const rows = (n: number, over: Record<string, unknown> = {}): ProbeResult => ({ rows: Array.from({ length: n }, (_, i) => ({ id: i, ...over })), error: null });
const GRANTED = PUBLIC_ARTICLE_GRANTED_COLUMNS.join(",");

/** A correctly protected project: private tables are denied, articles have column grants and only published rows. */
function secure(over: Partial<Record<string, (columns: string) => ProbeResult>> = {}, counts: Record<string, number> = {}): RlsProbe {
  return {
    async select(table, columns) {
      const custom = over[table];
      if (custom) return custom(columns);
      if (table === "departments") return { rows: [{ name: "EV", slug: "ev", kind: "company" }], error: null };
      if (table === "articles") {
        if (columns === "*") return denied;
        if (columns === GRANTED) return rows(3, { status: "published" });
        return denied; // an internal column
      }
      return denied;
    },
    async serviceCount(table) {
      return counts[table] ?? 0;
    },
  };
}

const byTable = (results: { table: string; status: string; message: string }[]) => Object.fromEntries(results.map((r) => [r.table, r]));

describe("runRlsCheck", () => {
  it("passes a protected project: nothing is readable except published articles' granted columns and departments", async () => {
    const { results, ok } = await runRlsCheck(secure());
    expect(ok).toBe(true);
    const t = byTable(results);
    expect(t["departments"].status).toBe("ok");
    expect(t["articles"]).toMatchObject({ status: "ok", message: expect.stringContaining("select=* is refused") });
    expect(t["articles (public columns)"]).toMatchObject({ status: "ok", message: "3 rows, all published" });
    expect(t["articles (internal columns)"].status).toBe("ok");
    for (const table of PRIVATE_TABLES) expect(t[table].status, table).not.toBe("fail");
  });

  it("covers every private table of the app, including the newest", () => {
    for (const table of ["sources", "raw_items", "agent_runs", "review_log", "pipeline_runs", "digests", "digest_recipients", "digest_log", "article_submitters", "budget_overrides", "privacy_log"]) {
      expect(PRIVATE_TABLES).toContain(table);
    }
    expect(PRIVATE_TABLES).not.toContain("articles");
    expect(PRIVATE_TABLES).not.toContain("departments");
  });

  it("fails when the public key can read rows of a private table, and names the columns (not the values)", async () => {
    const { results, ok } = await runRlsCheck(secure({ digest_recipients: () => ({ rows: [{ id: 1, email: "ada@adorpower.com", active: true }], error: null }) }));
    expect(ok).toBe(false);
    const r = byTable(results)["digest_recipients"];
    expect(r.status).toBe("fail");
    expect(r.message).toContain("CAN READ ROWS");
    expect(r.message).toContain("id, email, active");
    expect(r.message).not.toContain("ada@adorpower.com"); // never prints a value
  });

  it("fails when article_submitters is readable", async () => {
    const { ok, results } = await runRlsCheck(secure({ article_submitters: () => rows(1, { email: "x" }) }));
    expect(ok).toBe(false);
    expect(byTable(results)["article_submitters"].status).toBe("fail");
  });

  it("an empty private table cannot prove anything, unless the service role shows rows are there", async () => {
    const empty = await runRlsCheck(secure({ sources: () => ({ rows: [], error: null }) }, { sources: 0 }));
    expect(byTable(empty.results)["sources"].status).toBe("warn");
    expect(byTable(empty.results)["sources"].message).toMatch(/does not prove/);
    expect(empty.ok).toBe(true); // a warning is not a failure

    const proven = await runRlsCheck(secure({ sources: () => ({ rows: [], error: null }) }, { sources: 16 }));
    expect(byTable(proven.results)["sources"]).toMatchObject({ status: "ok", message: expect.stringContaining("the service role sees 16") });
  });

  it("works without a service-role count", async () => {
    const probe = secure({ sources: () => ({ rows: [], error: null }) });
    delete probe.serviceCount;
    const { results } = await runRlsCheck(probe);
    expect(byTable(results)["sources"].status).toBe("warn");
  });

  it("warns, not fails, about a table that is not in the API schema yet", async () => {
    const { results, ok } = await runRlsCheck(secure({ privacy_log: () => ({ rows: [], error: { code: "PGRST205", message: "Could not find the table" } }) }));
    expect(byTable(results)["privacy_log"]).toMatchObject({ status: "warn", message: expect.stringContaining("migration") });
    expect(ok).toBe(true);
  });

  describe("articles", () => {
    it("fails when select=* works: the column grants are missing", async () => {
      const { results, ok } = await runRlsCheck(secure({ articles: (c) => (c === "*" ? rows(2, { status: "published", fact_check_notes: "x" }) : denied) }));
      expect(ok).toBe(false);
      expect(byTable(results)["articles"]).toMatchObject({ status: "fail", message: expect.stringContaining("select=* WORKS") });
    });

    it("fails when drafts are visible", async () => {
      const { results, ok } = await runRlsCheck(
        secure({ articles: (c) => (c === "*" ? denied : c === GRANTED ? { rows: [{ status: "published" }, { status: "pending_review" }, { status: "draft" }], error: null } : denied) }),
      );
      expect(ok).toBe(false);
      expect(byTable(results)["articles (public columns)"]).toMatchObject({ status: "fail", message: "2 of 3 rows are NOT published: drafts are visible to the public key" });
    });

    it("fails when the public pages cannot read their own columns (the site would be empty)", async () => {
      const { results, ok } = await runRlsCheck(secure({ articles: (c) => (c === GRANTED ? { rows: [], error: { code: "42703", message: "column articles.summary does not exist" } } : denied) }));
      expect(ok).toBe(false);
      expect(byTable(results)["articles (public columns)"].message).toContain("could not read their columns");
    });

    it("fails for each internal column the public key can read, and checks every one of them", async () => {
      const asked: string[] = [];
      const { results, ok } = await runRlsCheck(
        secure({
          articles: (c) => {
            asked.push(c);
            if (c === "review_note" || c === "fact_check_notes") return rows(1);
            return c === "*" ? denied : c === GRANTED ? rows(1, { status: "published" }) : denied;
          },
        }),
      );
      expect(ok).toBe(false);
      expect(byTable(results)["articles (internal columns)"].message).toBe("THE PUBLIC KEY CAN READ: fact_check_notes, review_note");
      for (const c of INTERNAL_ARTICLE_COLUMNS) expect(asked).toContain(c);
    });

    it("a column that no longer exists is nothing to protect", async () => {
      const { results } = await runRlsCheck(
        secure({ articles: (c) => (c === "reviewed_by" ? { rows: [], error: { code: "42703", message: "column does not exist" } } : c === GRANTED ? rows(1, { status: "published" }) : denied) }),
      );
      expect(byTable(results)["articles (internal columns)"].status).toBe("ok");
    });
  });

  it("fails when the department names are not readable: the public pages would break", async () => {
    const { ok, results } = await runRlsCheck(secure({ departments: () => denied }));
    expect(ok).toBe(false);
    expect(byTable(results)["departments"].status).toBe("fail");
  });
});

describe("formatRls", () => {
  it("prints one line per check and a verdict", async () => {
    const good = formatRls((await runRlsCheck(secure({}, { sources: 3 }))).results);
    expect(good).toMatch(/^OK +departments/m);
    expect(good).toMatch(/reads nothing it should not/);
    const bad = formatRls((await runRlsCheck(secure({ raw_items: () => rows(1) }))).results);
    expect(bad).toMatch(/^FAIL +raw_items/m);
    expect(bad).toMatch(/1 problem: the public key can read more than it should\./);
  });
});

describe("the script", () => {
  it("uses the public key and only reads", () => {
    const script = readFileSync(new URL("../../scripts/check-rls.ts", import.meta.url), "utf8");
    expect(script).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(script).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
});

describe("the Write tables (2026-10-22)", () => {
  const COMMENT_COLUMNS = "id, article_id, display_name, body, status, created_at";
  /** Comments protected as the migration does it: user_key and select * are refused, the granted columns return visible rows. */
  const protectedComments = (visible = 2) => (columns: string): ProbeResult => (columns === COMMENT_COLUMNS ? rows(visible, { status: "visible" }) : denied);

  it("checks the private ones like the other private tables", () => {
    for (const table of ["article_likes", "reader_login_codes", "reader_events", "comment_log"]) expect(PRIVATE_TABLES).toContain(table);
    expect(PRIVATE_TABLES).not.toContain("article_comments"); // its visible comments are public by design
  });

  it("passes protected comments and a view that shows counts only", async () => {
    const { results, ok } = await runRlsCheck(secure({ article_comments: protectedComments(), article_like_counts: () => ({ rows: [{ article_id: "a", likes: 2 }], error: null }) }));
    expect(ok).toBe(true);
    const t = byTable(results);
    expect(t["article_comments (user_key)"].status).toBe("ok");
    expect(t["article_comments (public columns)"]).toMatchObject({ status: "ok", message: "2 rows, all visible" });
    expect(t["article_like_counts"].status).toBe("ok");
  });

  it("fails when the public key can read the user key of a comment", async () => {
    const { results, ok } = await runRlsCheck(secure({ article_comments: (c) => (c === "user_key" ? rows(1) : protectedComments()(c)) }));
    expect(ok).toBe(false);
    expect(byTable(results)["article_comments (user_key)"]).toMatchObject({ status: "fail", message: expect.stringContaining("user_key") });
  });

  it("fails when select * works on comments, or when a hidden comment is readable", async () => {
    const star = await runRlsCheck(secure({ article_comments: (c) => (c === "*" ? rows(1) : protectedComments()(c)) }));
    expect(star.ok).toBe(false);
    const hidden = await runRlsCheck(secure({ article_comments: (c) => (c === COMMENT_COLUMNS ? { rows: [{ id: 1, status: "visible" }, { id: 2, status: "hidden" }], error: null } : denied) }));
    expect(hidden.ok).toBe(false);
    expect(byTable(hidden.results)["article_comments (public columns)"].message).toContain("1 of 2 comments are NOT visible");
  });

  it("fails when the like view shows who liked, and warns (not fails) while the migration has not been run", async () => {
    const leaky = await runRlsCheck(secure({ article_like_counts: () => ({ rows: [{ article_id: "a", likes: 1, user_key: "k" }], error: null }) }));
    expect(leaky.ok).toBe(false);
    const missing = { rows: [], error: { code: "PGRST205", message: "table not found" } };
    const before = await runRlsCheck(secure({ article_comments: () => missing, article_like_counts: () => missing }));
    expect(before.ok).toBe(true);
    expect(byTable(before.results)["article_comments"].status).toBe("warn");
    expect(byTable(before.results)["article_like_counts"].status).toBe("warn");
  });
});