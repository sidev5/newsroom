// A small in-memory stand-in for the Supabase client, for tests that run real code against "a database": it understands the
// calls the app makes (select with filters, order, limit, range, single, count; insert, upsert, update, delete) over plain arrays.
// It is not PostgREST: embedded selects (a(b)) return the plain rows, and only the filters listed below exist.

export type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
export type FakeError = { code: string; message: string };

export type FakeOptions = {
  /** Per table: true when inserting `row` would break a unique index (the fake then answers 23505, like Postgres). */
  uniques?: Record<string, (row: Row, rows: Row[]) => boolean>;
};

const cmp = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? "")));

export function createFakeSupabase(initial: Record<string, Row[]> = {}, options: FakeOptions = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  let seq = 0;
  const calls: { table: string; op: string }[] = [];

  function from(table: string) {
    const rows = (tables[table] ??= []);
    const filters: Filter[] = [];
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: Row[] = [];
    let patch: Row = {};
    let onConflict = "";
    let ignoreDuplicates = false;
    let returning = false;
    let single: "one" | "maybe" | null = null;
    let order: { col: string; asc: boolean } | null = null;
    let limit = Infinity;
    let offset = 0;
    let count = false;
    let head = false;

    const unique = (row: Row) => options.uniques?.[table]?.(row, rows) === true;
    const violation = (): { data: null; error: FakeError; count: null } => ({ data: null, error: { code: "23505", message: `duplicate key value violates a unique index on ${table}` }, count: null });

    function execute(): { data: unknown; error: FakeError | null; count: number | null } {
      calls.push({ table, op });
      if (op === "insert" || op === "upsert") {
        const done: Row[] = [];
        for (const input of payload) {
          const row: Row = { ...input };
          if (op === "upsert") {
            const hit = rows.find((r) => r[onConflict] === row[onConflict]);
            if (hit) {
              if (!ignoreDuplicates) {
                Object.assign(hit, row);
                done.push(hit);
              }
              continue;
            }
          }
          if (unique(row)) return violation();
          row.id ??= `${table}-${++seq}`;
          rows.push(row);
          done.push(row);
        }
        return result(done);
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, patch);
        return result(hit);
      }
      if (op === "delete") {
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return result(hit);
      }
      let list = [...hit];
      if (order) list.sort((a, b) => (order!.asc ? 1 : -1) * cmp(a[order!.col], b[order!.col]));
      const total = list.length;
      list = list.slice(offset, offset + limit);
      if (head) return { data: null, error: null, count: count ? total : null };
      return result(list, count ? total : null);
    }

    function result(list: Row[], total: number | null = null): { data: unknown; error: FakeError | null; count: number | null } {
      if (op !== "select" && !returning) return { data: null, error: null, count: null };
      if (single === "one") return list.length === 1 ? { data: list[0], error: null, count: total } : { data: null, error: { code: "PGRST116", message: "expected one row" }, count: null };
      if (single === "maybe") return list.length <= 1 ? { data: list[0] ?? null, error: null, count: total } : { data: null, error: { code: "PGRST116", message: "more than one row" }, count: null };
      return { data: list, error: null, count: total };
    }

    const b = {
      select(_columns?: string, opts?: { count?: string; head?: boolean }) {
        if (op === "select") {
          count = Boolean(opts?.count);
          head = Boolean(opts?.head);
        } else returning = true;
        return b;
      },
      insert(p: Row | Row[]) { op = "insert"; payload = Array.isArray(p) ? p : [p]; return b; },
      upsert(p: Row | Row[], o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
        op = "upsert";
        payload = Array.isArray(p) ? p : [p];
        onConflict = o.onConflict ?? "id";
        ignoreDuplicates = o.ignoreDuplicates === true;
        return b;
      },
      update(p: Row) { op = "update"; patch = p; return b; },
      delete() { op = "delete"; return b; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: null | boolean) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not(c: string, o: string, v: unknown) {
        if (o === "is") filters.push((r) => (r[c] ?? null) !== v);
        else if (o === "eq") filters.push((r) => r[c] !== v);
        return b;
      },
      lt(c: string, v: unknown) { filters.push((r) => cmp(r[c], v) < 0); return b; },
      lte(c: string, v: unknown) { filters.push((r) => cmp(r[c], v) <= 0); return b; },
      gt(c: string, v: unknown) { filters.push((r) => cmp(r[c], v) > 0); return b; },
      gte(c: string, v: unknown) { filters.push((r) => cmp(r[c], v) >= 0); return b; },
      order(col: string, o: { ascending?: boolean } = {}) { order = { col, asc: o.ascending !== false }; return b; },
      limit(n: number) { limit = n; return b; },
      range(from: number, to: number) { offset = from; limit = to - from + 1; return b; },
      single() { single = "one"; return b; },
      maybeSingle() { single = "maybe"; return b; },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        try {
          return Promise.resolve(execute()).then(resolve, reject);
        } catch (err) {
          return Promise.reject(err).then(resolve, reject);
        }
      },
    };
    return b;
  }

  return { client: { from }, tables, calls };
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;
